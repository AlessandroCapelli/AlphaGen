"""Simulation core: data loading, the SEIRD+V model and the stateful runner.

This module bundles the whole model layer:

* :func:`load_countries` / :func:`build_coupling` read the static datasets and
  build the inter-country travel matrix.
* :class:`SeirModel` holds the compartment arrays and advances them one day at
  a time (pure NumPy).
* :class:`SimulationEngine` wraps the model with the day counter, parameters,
  auto-advance speed, seeded outbreaks and snapshot serialisation. A single
  instance is shared across all WebSocket clients (see :mod:`app.main`).
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from app.backup import BackupWriter
from app.config import (
    DATA_LIMIT,
    LOCKDOWN_DEFAULT,
    LOCKDOWN_MAX,
    LOCKDOWN_MIN,
    SEED_DEFAULT,
    SPEED_DEFAULT,
    SPEED_MAX,
    SPEED_MIN,
)
from app.models import CountryMeta, CountrySnapshot, Params, Snapshot, Totals

DATA_DIR = Path(__file__).parent / "data"
COUNTRIES_FILE = DATA_DIR / "countries.json"
FLIGHTS_FILE = DATA_DIR / "flights.json"


def load_countries() -> list[CountryMeta]:
    """Read ``countries.json`` and parse it into :class:`CountryMeta` records.

    Returns:
        The list of countries, in the order stored on disk (descending
        population).

    Raises:
        FileNotFoundError: If the bundled ``countries.json`` is missing.
    """
    if not COUNTRIES_FILE.exists():
        raise FileNotFoundError(
            f"{COUNTRIES_FILE} not found; the bundled dataset is missing from the repository."
        )
    raw = json.loads(COUNTRIES_FILE.read_text(encoding="utf-8"))
    return [CountryMeta(**c) for c in raw]


def build_coupling(countries: list[CountryMeta]) -> np.ndarray:
    """Build the ``(n, n)`` inflow matrix ``W`` from the flight network.

    ``W[i, j]`` is the relative travel weight reaching destination ``i`` from
    source ``j``. Routes in ``flights.json`` are treated as bidirectional and
    scaled by ``base_coupling``; a tiny uniform baseline (``baseline_epsilon``)
    is added to every off-diagonal entry so any disease can eventually reach
    every country. The diagonal is forced to zero.

    Args:
        countries: Countries in the same order as the model's compartment
            arrays; used to map ISO codes to matrix indices.

    Returns:
        The coupling matrix as a float NumPy array of shape ``(n, n)``.
    """
    n = len(countries)
    index = {c.iso: i for i, c in enumerate(countries)}
    spec = json.loads(FLIGHTS_FILE.read_text(encoding="utf-8"))
    base = float(spec.get("base_coupling", 0.0526))
    eps = float(spec.get("baseline_epsilon", 1e-7))

    w = np.full((n, n), eps, dtype=float)
    for route in spec.get("routes", []):
        a, b = route["a"], route["b"]
        if a in index and b in index:
            ia, ib = index[a], index[b]
            weight = base * float(route["w"])
            w[ia, ib] += weight
            w[ib, ia] += weight
    np.fill_diagonal(w, 0.0)
    return w


class SeirModel:
    """Vectorised SEIRD+V metapopulation model.

    One SEIR(D)(V) compartment set per country. Countries are coupled by a
    simplified flight network: infectious pressure from country ``j`` reaches
    country ``i`` proportionally to the travel weight ``W[i, j]``.

    Compartments (counts of people per country):
        S  susceptible
        E  exposed (infected, not yet infectious)
        I  infectious
        R  recovered (immune)
        D  deceased
        V  vaccinated (immune)

    The model also holds a per-country intervention array ``C`` in ``[0, 1]``
    (local lockdown/border-closure strength). It is not a compartment: it scales
    both the local and imported infectious pressure via ``open_frac = 1 - C``.

    Daily forward-Euler update (dt = 1 day), applied per country ``i``:
        beta_eff   = (r0 / infectious_days) * (1 - intervention)
        sigma      = 1 / incubation_days
        gamma      = 1 / infectious_days
        open_i     = 1 - C_i
        prev_i     = open_i * I_i / N_i
        lambda_i   = beta_eff * prev_i
                   + mobility * open_i * sum_j W[i, j] * prev_j
        newE = min(lambda_i * S_i, S_i)
        newI = min(sigma * E_i, E_i)
        out  = min(gamma * I_i, I_i)
        newD = fatality_rate * out
        newR = out - newD
        newV = clip(min(vaccination_rate * S_i, S_i - newE), 0, +inf)

    Here ``intervention`` is the single global parameter folded into
    ``beta_eff``, while ``C_i`` is the per-country override. The ``min``/``clip``
    guards keep every transfer within the available stock so no compartment goes
    negative and the population is conserved.

    All compartments are stored as NumPy arrays of shape ``(n,)`` where ``n`` is
    the number of countries, so a step is a handful of vector operations.
    """

    def __init__(self, populations: np.ndarray, coupling: np.ndarray):
        """Initialise the model from population sizes and the coupling matrix.

        Args:
            populations: Array of shape ``(n,)`` with each country's population.
            coupling: Travel matrix of shape ``(n, n)`` with a zero diagonal;
                ``coupling[i, j]`` is the inflow weight to ``i`` from ``j``.
        """
        self.n = populations.shape[0]
        self.N = populations.astype(float)
        self.W = coupling.astype(float)

        self._clear()

    def _clear(self) -> None:
        """Reset every compartment to the all-susceptible state (S = N, rest = 0).

        ``S`` is a fresh **copy** of ``N`` (not a view) so later in-place updates
        never mutate the stored population array.
        """
        self.S = self.N.copy()
        self.E = np.zeros(self.n)
        self.I = np.zeros(self.n)
        self.R = np.zeros(self.n)
        self.D = np.zeros(self.n)
        self.V = np.zeros(self.n)
        self.C = np.zeros(self.n)

    def reset(self) -> None:
        """Return everyone to the susceptible compartment (S = N, rest = 0)."""
        self._clear()

    def seed(self, idx: int, count: float) -> None:
        """Introduce an initial outbreak.

        Moves ``count`` people (clamped to the available susceptibles, and never
        negative) from S to I in the country at position ``idx``.

        Args:
            idx: Index of the country in the population/compartment arrays.
            count: Number of individuals to move into the infectious compartment.
        """
        count = max(0.0, min(count, self.S[idx]))
        self.S[idx] -= count
        self.I[idx] += count

    def step(self, p: Params) -> None:
        """Advance every country by one day using the parameters ``p``.

        Args:
            p: Current epidemiological parameters (read, never mutated).
        """
        beta_eff = (p.r0 / p.infectious_days) * (1.0 - p.intervention)
        sigma = 1.0 / p.incubation_days
        gamma = 1.0 / p.infectious_days

        safe_N = np.where(self.N > 0, self.N, 1.0)
        prevalence = self.I / safe_N

        open_frac = 1.0 - self.C
        eff_prev = prevalence * open_frac
        local_force = beta_eff * eff_prev
        imported_force = p.mobility * open_frac * (self.W @ eff_prev)
        lam = local_force + imported_force

        new_e = np.minimum(lam * self.S, self.S)
        new_i = np.minimum(sigma * self.E, self.E)
        leaving_i = np.minimum(gamma * self.I, self.I)
        new_d = p.fatality_rate * leaving_i
        new_r = leaving_i - new_d
        new_v = np.minimum(p.vaccination_rate * self.S, self.S - new_e)
        new_v = np.maximum(new_v, 0.0)

        self.S += -new_e - new_v
        self.E += new_e - new_i
        self.I += new_i - leaving_i
        self.R += new_r
        self.D += new_d
        self.V += new_v

        np.clip(self.S, 0.0, None, out=self.S)
        np.clip(self.E, 0.0, None, out=self.E)
        np.clip(self.I, 0.0, None, out=self.I)


def _clamp(value: float, lo: float, hi: float) -> float:
    """Clamp ``value`` to the closed interval ``[lo, hi]``."""
    return max(lo, min(hi, value))


def _write_country_record(arrays: dict, idx: int, rec: dict, s_default: float) -> None:
    """Write one country's compartments from a scenario/snapshot record.

    Fills ``arrays`` (keyed by uppercase compartment letter) at position ``idx``
    from ``rec``: each compartment is floored at zero, the susceptible fallback
    is ``s_default``, and the intervention is clamped to the lockdown range.
    """
    arrays["S"][idx] = max(0.0, float(rec.get("s", s_default)))
    arrays["E"][idx] = max(0.0, float(rec.get("e", 0.0)))
    arrays["I"][idx] = max(0.0, float(rec.get("i", 0.0)))
    arrays["R"][idx] = max(0.0, float(rec.get("r", 0.0)))
    arrays["D"][idx] = max(0.0, float(rec.get("d", 0.0)))
    arrays["V"][idx] = max(0.0, float(rec.get("v", 0.0)))
    arrays["C"][idx] = _clamp(
        float(rec.get("intervention", LOCKDOWN_DEFAULT)), LOCKDOWN_MIN, LOCKDOWN_MAX
    )


def _totals(m: "SeirModel") -> dict:
    """Sum every compartment to whole-world totals in ``s,e,i,r,d,v`` order."""
    return {
        "s": float(m.S.sum()),
        "e": float(m.E.sum()),
        "i": float(m.I.sum()),
        "r": float(m.R.sum()),
        "d": float(m.D.sum()),
        "v": float(m.V.sum()),
    }


def _columnar_frame(f: dict) -> dict:
    """Serialise one ``frames_log`` entry to the compact columnar wire form.

    Compartment counts are rounded to whole people and per-country intervention
    to 3 decimals to keep the payload small. Shared by :meth:`frames_payload`
    (replay on connect) and the on-disk backup, so both stay byte-identical.
    """
    return {
        "day": f["day"],
        "speed": f["speed"],
        "params": f["params"],
        "s": np.rint(f["S"]).astype(int).tolist(),
        "e": np.rint(f["E"]).astype(int).tolist(),
        "i": np.rint(f["I"]).astype(int).tolist(),
        "r": np.rint(f["R"]).astype(int).tolist(),
        "d": np.rint(f["D"]).astype(int).tolist(),
        "v": np.rint(f["V"]).astype(int).tolist(),
        "c": [round(x, 3) for x in f["C"].tolist()],
    }


class SimulationEngine:
    """Owns the model state and exposes high-level control + serialisation."""

    def __init__(self, backup: BackupWriter | None = None) -> None:
        """Load country data, build the coupling matrix and the SEIR model.

        Args:
            backup: Optional :class:`~app.backup.BackupWriter`. When given, every
                recorded day is also appended to disk for crash recovery (the
                server wires one in; tests and in-process use leave it ``None``).
        """
        self.countries = load_countries()
        self.index = {c.iso: i for i, c in enumerate(self.countries)}
        populations = np.array([c.population for c in self.countries], dtype=float)
        coupling = build_coupling(self.countries)
        self.model = SeirModel(populations, coupling)

        self.params = Params()
        self.day = 0
        self.running = False
        self.speed = SPEED_DEFAULT
        self.history: list[dict] = []
        self.frames_log: list[dict] = []
        self._backup = backup
        if self._backup is not None:
            self._backup.reset(self._backup_header())
        self._record()

    def _backup_header(self) -> dict:
        """Country metadata (model order) written once at the top of a backup."""
        return {
            "iso": [c.iso for c in self.countries],
            "name": [c.name for c in self.countries],
            "population": [float(self.model.N[i]) for i in range(self.model.n)],
        }

    @staticmethod
    def _append_or_replace(buffer: list[dict], day: int, item: dict) -> None:
        """Append ``item`` for ``day`` to ``buffer``, replacing same-day tail.

        If the last entry already belongs to ``day`` it is overwritten in place;
        otherwise ``item`` is appended and the buffer is trimmed to
        :data:`DATA_LIMIT` from the front.
        """
        if buffer and buffer[-1]["day"] == day:
            buffer[-1] = item
        else:
            buffer.append(item)
            if len(buffer) > DATA_LIMIT:
                del buffer[0]

    def _record(self) -> None:
        """Record the current day in both replay buffers.

        Updates the entry for the current day in place if it already exists (so a
        seed/intervention applied without stepping refreshes that day), otherwise
        appends a new one and trims to the caps.
        """
        m = self.model
        totals = _totals(m)
        self._append_or_replace(
            self.history, self.day, {"day": self.day, "totals": totals}
        )

        frame = {
            "day": self.day,
            "speed": self.speed,
            "params": self.params.model_dump(),
            "S": m.S.copy(),
            "E": m.E.copy(),
            "I": m.I.copy(),
            "R": m.R.copy(),
            "D": m.D.copy(),
            "V": m.V.copy(),
            "C": m.C.copy(),
        }
        self._append_or_replace(self.frames_log, self.day, frame)

        if self._backup is not None:
            self._backup.append_day(_columnar_frame(frame))

    def history_points(self) -> list[dict]:
        """The recorded per-day totals series (for replay on connect)."""
        return self.history

    def frames_payload(self) -> dict:
        """Full timeline frames in a compact columnar form (for replay on connect).

        Country metadata (iso/name/population, in model order) is sent once; each
        frame carries only the per-country compartments. Compartment counts are
        rounded to whole people to keep the payload small.
        """
        return {
            **self._backup_header(),
            "frame": [_columnar_frame(f) for f in self.frames_log],
        }

    def reset(self) -> None:
        """Clear all compartments and the day counter (everyone susceptible)."""
        self.model.reset()
        self.day = 0
        self.running = False
        self.history.clear()
        self.frames_log.clear()
        if self._backup is not None:
            self._backup.reset(self._backup_header())
        self._record()

    def seed(self, iso: str, count: float = SEED_DEFAULT) -> None:
        """Start an outbreak of ``count`` infectious people in country ``iso``.

        Unknown ISO codes are ignored.

        Args:
            iso: ISO 3166-1 alpha-3 country code.
            count: Number of initial infectious individuals.
        """
        idx = self.index.get(iso)
        if idx is not None:
            self.model.seed(idx, count)
            self._record()

    def set_country_intervention(self, iso: str, value: float) -> None:
        """Set the intervention level (0..1) for a single country.

        Unknown ISO codes are ignored.

        Args:
            iso: ISO 3166-1 alpha-3 country code.
            value: Lockdown/border-closure strength, clamped to [0, 1].
        """
        idx = self.index.get(iso)
        if idx is not None:
            self.model.C[idx] = _clamp(value, LOCKDOWN_MIN, LOCKDOWN_MAX)
            self._record()

    def to_scenario(self, name: str = "scenario") -> dict:
        """Serialise the full live state so it can be restored exactly.

        Captures the day, parameters, speed and the compartment counts of **every**
        country, so the round-trip is complete and lossless (no country is rebuilt
        from defaults on restore).

        Args:
            name: Label stored alongside the scenario.

        Returns:
            A JSON-serialisable dict suitable for :meth:`apply_scenario`.
        """
        m = self.model
        countries = [
            {
                "iso": c.iso,
                "s": float(m.S[i]),
                "e": float(m.E[i]),
                "i": float(m.I[i]),
                "r": float(m.R[i]),
                "d": float(m.D[i]),
                "v": float(m.V[i]),
                "intervention": float(m.C[i]),
            }
            for i, c in enumerate(self.countries)
        ]
        return {
            "name": name,
            "day": self.day,
            "params": self.params.model_dump(),
            "speed": self.speed,
            "countries": countries,
        }

    def apply_scenario(self, data: dict) -> None:
        """Restore a state produced by :meth:`to_scenario`.

        Resets the world (everyone susceptible), restores day/params/speed, then
        overwrites the compartments of the listed countries. Unknown ISO codes
        are ignored; the simulation is left paused.

        Args:
            data: A scenario dict as produced by :meth:`to_scenario`. Missing
                keys fall back to sensible defaults.
        """
        self.reset()
        self.params = Params(**data.get("params", {}))
        self.set_speed(float(data.get("speed", SPEED_DEFAULT)))
        self.day = int(data.get("day", 0))
        m = self.model
        arrays = {"S": m.S, "E": m.E, "I": m.I, "R": m.R, "D": m.D, "V": m.V, "C": m.C}
        for rec in data.get("countries", []):
            idx = self.index.get(rec.get("iso", ""))
            if idx is None:
                continue
            _write_country_record(arrays, idx, rec, float(m.N[idx]))
        self.history.clear()
        self.frames_log.clear()
        if self._backup is not None:
            self._backup.reset(self._backup_header())
        self._record()

    def restore(self, state: dict) -> None:
        """Restore the **full** live state *and* replay timeline from a SavedState.

        Unlike :meth:`apply_scenario` (which restores only a single live frame),
        this rebuilds the entire ``history`` + ``frames_log`` so a client
        reconnecting after a crash replays the whole pre-crash run (chart and
        scrubber), not just the final day. Used by the startup recovery path.

        Args:
            state: A ``SavedState`` dict as produced by
                :func:`app.backup.load_saved_state` — ``frames`` is a list of
                snapshot-shaped dicts, oldest first. Empty/invalid input is a
                no-op. Frames are capped to the most recent :data:`DATA_LIMIT`.
        """
        frames = state.get("frames") if isinstance(state, dict) else None
        if not frames:
            return
        frames = frames[-DATA_LIMIT:]
        n = self.model.n
        rebuilt_frames: list[dict] = []
        rebuilt_history: list[dict] = []
        for fr in frames:
            arrays = {c: np.zeros(n) for c in "SEIRDVC"}
            for rec in fr.get("countries", []):
                idx = self.index.get(rec.get("iso", ""))
                if idx is None:
                    continue
                _write_country_record(arrays, idx, rec, 0.0)
            params = Params(**fr.get("params", {})).model_dump()
            speed = _clamp(float(fr.get("speed", SPEED_DEFAULT)), SPEED_MIN, SPEED_MAX)
            day = int(fr.get("day", 0))
            rebuilt_frames.append(
                {"day": day, "speed": speed, "params": params, **arrays}
            )
            rebuilt_history.append(
                {
                    "day": day,
                    "totals": {k.lower(): float(arrays[k].sum()) for k in "SEIRDV"},
                }
            )

        last = rebuilt_frames[-1]
        m = self.model
        m.S, m.E, m.I = last["S"].copy(), last["E"].copy(), last["I"].copy()
        m.R, m.D, m.V = last["R"].copy(), last["D"].copy(), last["V"].copy()
        m.C = last["C"].copy()
        self.day = last["day"]
        self.params = Params(**last["params"])
        self.speed = last["speed"]
        self.running = False
        self.history = rebuilt_history
        self.frames_log = rebuilt_frames
        if self._backup is not None:
            self._backup.reset(self._backup_header())
            for f in self.frames_log:
                self._backup.append_day(_columnar_frame(f))

    def set_params(self, params: Params) -> None:
        """Replace the active parameters (applied on the next step)."""
        self.params = params

    def set_speed(self, speed: float) -> None:
        """Set the auto-advance speed in steps/second, clamped to the config range."""
        self.speed = _clamp(speed, SPEED_MIN, SPEED_MAX)

    def step(self) -> None:
        """Advance the model by one day and increment the day counter."""
        self.model.step(self.params)
        self.day += 1
        self._record()

    def snapshot(self) -> Snapshot:
        """Build a :class:`~app.models.Snapshot` of the current world state."""
        m = self.model
        countries = [
            CountrySnapshot(
                iso=c.iso,
                name=c.name,
                population=float(m.N[i]),
                s=float(m.S[i]),
                e=float(m.E[i]),
                i=float(m.I[i]),
                r=float(m.R[i]),
                d=float(m.D[i]),
                v=float(m.V[i]),
                intervention=float(m.C[i]),
            )
            for i, c in enumerate(self.countries)
        ]
        totals = Totals(**_totals(m))
        return Snapshot(
            day=self.day,
            running=self.running,
            speed=self.speed,
            params=self.params,
            totals=totals,
            countries=countries,
        )
