"""Incremental on-disk backup of the live simulation (crash recovery).

The server keeps the whole run in memory, so a process crash would lose it. This
module persists every simulated day to disk **incrementally**: an append-only
NDJSON log (one JSON object per line). The first line is a header carrying the
country metadata once; every later line is a single day's compartments in the
same compact columnar shape as :meth:`SimulationEngine.frames_payload`. Appending
one line per day keeps the write cost constant and the file recoverable even if
the process dies mid-run.

The log reconstructs into the two standard, importable formats:

* :func:`load_saved_state` -> a frontend ``SavedState`` (with
  ``frames`` + ``history``), served by ``GET /api/backup``, loadable straight
  from the UI's *Carica* button, and replayed on startup to resume the whole
  pre-crash timeline;
* :func:`load_scenario` -> the last recorded day as a single-frame ``Scenario``,
  postable to ``POST /api/scenario`` to resume the engine from that day.

Reconstruction is **last-writer-wins per day**: re-recording a day (e.g. a seed
or intervention applied without stepping refreshes that day's line) simply
supersedes the earlier entry, so the rebuilt timeline stays correct.

All writes are best-effort and swallow :class:`OSError`: a backup failure must
never take down the running simulation.
"""

from __future__ import annotations

import json
from pathlib import Path

from app.config import DATA_LIMIT, SAVE_VERSION

BACKUP_VERSION = SAVE_VERSION
MAX_RECOVERY_DAYS = DATA_LIMIT


class BackupWriter:
    """Append-only NDJSON writer for the live run.

    A fresh segment is started with :meth:`reset` (truncate + header line); each
    day is then persisted with :meth:`append_day`. Both are no-ops on IO error.
    """

    def __init__(self, path: str | Path) -> None:
        """Bind the writer to ``path`` (created lazily on the first :meth:`reset`)."""
        self.path = Path(path)
        self._ready = False

    def reset(self, header: dict) -> None:
        """Start a new backup segment: truncate the file and write the header.

        Args:
            header: Country metadata (``iso``/``name``/``population`` lists, in
                model order) written once at the top of the segment.
        """
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("w", encoding="utf-8") as f:
                f.write(
                    json.dumps({"kind": "header", "version": BACKUP_VERSION, **header})
                    + "\n"
                )
            self._ready = True
        except OSError:
            self._ready = False

    def append_day(self, frame: dict) -> None:
        """Append one day's columnar frame as a single NDJSON line.

        A no-op until :meth:`reset` has written a header. Last-writer-wins per
        day: recording the same day twice leaves two lines, the later of which
        wins on load (see module docstring).

        Args:
            frame: One element of :meth:`SimulationEngine.frames_payload`'s
                ``frame`` list (``day``/``speed``/``params`` + ``s..v`` + ``c``).
        """
        if not self._ready:
            return
        try:
            with self.path.open("a", encoding="utf-8") as f:
                f.write(json.dumps({"kind": "frame", **frame}) + "\n")
        except OSError:
            pass


def _read(path: str | Path) -> tuple[dict | None, list[dict]]:
    """Parse a backup file into its header and per-day frames (last-wins by day).

    Malformed or partial lines (e.g. a line half-written when the process died)
    are skipped, so a truncated tail never breaks recovery.

    Returns:
        ``(header, frames)`` where ``frames`` is sorted by ``day``; ``(None, [])``
        if the file is missing or unreadable.
    """
    path = Path(path)
    if not path.exists():
        return None, []
    header: dict | None = None
    by_day: dict[int, dict] = {}
    try:
        with path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                kind = rec.get("kind")
                if kind == "header":
                    header = rec
                elif kind == "frame":
                    try:
                        by_day[int(rec["day"])] = rec
                    except (KeyError, TypeError, ValueError):
                        continue
    except OSError:
        return None, []
    if header is not None and not _header_well_formed(header):
        header = None
    frames = [by_day[d] for d in sorted(by_day)]
    if header is not None:
        n = len(header["iso"])
        frames = [fr for fr in frames if _frame_well_formed(fr, n)]
    return header, frames


def _header_well_formed(header: dict) -> bool:
    """Whether a header carries the three equal-length metadata columns.

    A partial header line (e.g. half-written when the process died, or an older
    truncated segment) that still parses as JSON but lacks ``name``/``population``
    would otherwise crash reconstruction with ``KeyError``/``IndexError``; treat
    such a header as absent so recovery falls back to *no backup* instead.
    """
    cols = [header.get(k) for k in ("iso", "name", "population")]
    if not all(isinstance(col, list) for col in cols):
        return False
    return len({len(col) for col in cols}) == 1


def _frame_well_formed(frame: dict, n: int) -> bool:
    """Whether a columnar frame carries all expected keys and ``n``-length columns.

    Guards reconstruction against a structurally-valid line whose compartment
    columns are shorter than the header's country list, which would otherwise
    raise ``IndexError`` when the per-country dicts are rebuilt.
    """
    if not all(key in frame for key in ("day", "speed", "params")):
        return False
    return all(
        isinstance(frame.get(col), list) and len(frame[col]) == n
        for col in ("s", "e", "i", "r", "d", "v", "c")
    )


def _totals(frame: dict) -> dict:
    """Worldwide totals for one columnar frame (sum across countries)."""
    return {k: float(sum(frame[k])) for k in ("s", "e", "i", "r", "d", "v")}


def _compartments(frame: dict, k: int) -> dict:
    """Per-country compartments and intervention for index ``k`` of a frame.

    Maps the columnar frame's ``c`` (intervention) column back to the
    ``intervention`` key used by the reconstructed country dicts.
    """
    return {
        "s": frame["s"][k],
        "e": frame["e"][k],
        "i": frame["i"][k],
        "r": frame["r"][k],
        "d": frame["d"][k],
        "v": frame["v"][k],
        "intervention": frame["c"][k],
    }


def load_saved_state(path: str | Path) -> dict | None:
    """Rebuild a frontend ``SavedState`` from the backup, or ``None`` if empty.

    The returned dict is the exact shape produced by the frontend ``exportState``,
    so ``GET /api/backup`` can be downloaded and loaded straight from the UI.
    """
    header, frames = _read(path)
    if not header or not frames:
        return None
    frames = frames[-MAX_RECOVERY_DAYS:]
    iso, name, pop = header["iso"], header["name"], header["population"]
    out_frames: list[dict] = []
    history: list[dict] = []
    for fr in frames:
        countries = [
            {
                "iso": iso[k],
                "name": name[k],
                "population": pop[k],
                **_compartments(fr, k),
            }
            for k in range(len(iso))
        ]
        totals = _totals(fr)
        out_frames.append(
            {
                "type": "snapshot",
                "day": fr["day"],
                "running": False,
                "speed": fr["speed"],
                "params": fr["params"],
                "totals": totals,
                "countries": countries,
            }
        )
        history.append({"day": fr["day"], "totals": totals})
    return {"version": BACKUP_VERSION, "frames": out_frames, "history": history}


def load_scenario(path: str | Path, name: str = "backup") -> dict | None:
    """Rebuild the **last** recorded day as a ``Scenario``, or ``None`` if empty.

    Postable to ``POST /api/scenario`` to resume the engine from a single frame.
    The server's own startup recovery instead replays the full timeline via
    :func:`load_saved_state` + ``SimulationEngine.restore``.
    """
    header, frames = _read(path)
    if not header or not frames:
        return None
    iso = header["iso"]
    fr = frames[-1]
    countries = [{"iso": iso[k], **_compartments(fr, k)} for k in range(len(iso))]
    return {
        "name": name,
        "day": fr["day"],
        "params": fr["params"],
        "speed": fr["speed"],
        "countries": countries,
    }
