"""AlphaGen test suite — units, dataset, integration (real instance), long-run,
parameter matrix, fuzz, edge cases and export/import/continuation.

Everything lives in this single module: the snapshot invariants, the fixtures
(a session-scoped real ``uvicorn`` subprocess), the WebSocket helper and all the
tests. The integration suite talks to an actual running server over TCP (not the
in-process TestClient), matching production wiring: the lifespan creates the
shared engine and the background ``sim_loop`` really runs.

Markers: `unit` (in-process), `data` (datasets), `integration` (real uvicorn).
Run: `uv run pytest`  /  `uv run pytest -m unit`  /  `uv run pytest -m integration`.
"""

from __future__ import annotations

import contextlib
import json
import random
import socket
import subprocess
import sys
import time
from collections.abc import Iterator
from pathlib import Path

import httpx
import numpy as np
import pytest
import websockets
from pydantic import ValidationError

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app import backup as backup_mod  # noqa: E402
from app import config as app_config  # noqa: E402
from app.backup import BackupWriter  # noqa: E402
from app.models import CountryMeta, Params, Preset, Snapshot  # noqa: E402
from app.simulation import (  # noqa: E402
    SeirModel,
    SimulationEngine,
    build_coupling,
    load_countries,
)

DATA = BACKEND_DIR / "app" / "data"
N_COUNTRIES = len(load_countries())
SAVE_VERSION = app_config.SAVE_VERSION
COMPARTMENTS = "seirdv"


def check_snapshot(s: dict, tol: float = 50.0) -> float:
    """Assert conservation, totals==sum, no negatives, shape and N_COUNTRIES unique isos.
    Returns the worst per-country conservation drift seen."""
    for key in ("day", "running", "speed", "params", "totals", "countries"):
        assert key in s, f"snapshot missing '{key}'"
    assert isinstance(s["day"], int)
    assert isinstance(s["running"], bool)

    countries = s["countries"]
    isos = [c["iso"] for c in countries]
    assert len(isos) == N_COUNTRIES, (
        f"expected {N_COUNTRIES} countries, got {len(isos)}"
    )
    assert len(set(isos)) == len(isos), "duplicate iso codes"

    sum_comp = {k: 0.0 for k in COMPARTMENTS}
    worst = 0.0
    for c in countries:
        total = sum(c[k] for k in COMPARTMENTS)
        worst = max(worst, abs(total - c["population"]))
        assert abs(total - c["population"]) <= tol, (
            f"day {s['day']} {c['iso']}: S+E+I+R+D+V={total:.3f} != pop {c['population']:.3f}"
        )
        for k in COMPARTMENTS:
            assert c[k] >= -1e-6, f"day {s['day']} {c['iso']}: negative {k}={c[k]}"
            sum_comp[k] += c[k]

    t = s["totals"]
    for k in COMPARTMENTS:
        assert abs(sum_comp[k] - t[k]) <= tol, (
            f"day {s['day']} totals.{k}={t[k]:.3f} != sum_countries={sum_comp[k]:.3f}"
        )
    return worst


def assert_monotonic_cumulative(prev: dict, totals: dict, tol: float = 1.0) -> None:
    """R, D, V never decrease while params are fixed."""
    for k in "rdv":
        assert totals[k] + tol >= prev[k], (
            f"totals.{k} decreased {prev[k]:.3f}->{totals[k]:.3f}"
        )


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="session")
def server() -> Iterator[dict]:
    """Start a real uvicorn process for the whole session and tear it down."""
    port = _free_port()
    base = f"http://127.0.0.1:{port}"
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.main:app", "--port", str(port)],
        cwd=str(BACKEND_DIR),
    )
    deadline = time.time() + 40
    last_err: Exception | None = None
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"uvicorn exited early with code {proc.returncode}")
        try:
            if httpx.get(f"{base}/api/health", timeout=1.0).status_code == 200:
                break
        except Exception as e:
            last_err = e
        time.sleep(0.3)
    else:
        proc.terminate()
        raise RuntimeError(f"server did not become ready: {last_err!r}")

    try:
        yield {"base": base, "ws": f"ws://127.0.0.1:{port}/ws", "port": port}
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


@pytest.fixture
def base_url(server: dict) -> str:
    return server["base"]


@pytest.fixture
def ws_url(server: dict) -> str:
    return server["ws"]


@pytest.fixture
def client(base_url: str) -> Iterator[httpx.Client]:
    with httpx.Client(base_url=base_url, timeout=10.0) as c:
        yield c


@pytest.fixture(autouse=True)
def _reset_engine(request: pytest.FixtureRequest) -> None:
    """Reset the shared engine before each *integration* test (clean, paused,
    day 0). Unit/data tests don't touch the server, so they skip this."""
    if "integration" in request.keywords:
        srv = request.getfixturevalue("server")
        with contextlib.suppress(Exception):
            httpx.post(f"{srv['base']}/api/scenario", json={}, timeout=5.0)


class WSClient:
    """Thin async wrapper: send a command dict, receive the next snapshot."""

    def __init__(self, conn) -> None:
        self._conn = conn

    async def recv(self, timeout: float = 10.0) -> dict:
        import asyncio

        return json.loads(await asyncio.wait_for(self._conn.recv(), timeout))

    async def send(self, cmd: dict) -> None:
        await self._conn.send(json.dumps(cmd))

    async def send_raw(self, text: str) -> None:
        await self._conn.send(text)

    async def command(self, cmd: dict, timeout: float = 10.0) -> dict:
        """Send an *immediate* command and return the resulting snapshot."""
        await self.send(cmd)
        return await self.recv(timeout)


def ws_connect(ws_url: str):
    """Async context manager yielding a :class:`WSClient`."""

    @contextlib.asynccontextmanager
    async def _cm():
        async with websockets.connect(ws_url) as conn:
            yield WSClient(conn)

    return _cm()


PARAM_SPECS = {p["key"]: p for p in app_config.PARAMS}
PARAM_GRID = {k: (p["min"], p["default"], p["max"]) for k, p in PARAM_SPECS.items()}
VALIDATION_BOUNDS = {
    k: (p["min"], p["max"], p["min"] - 0.1, p["max"] + 0.1)
    for k, p in PARAM_SPECS.items()
}


def full_params(**over) -> dict:
    base = {k: p["default"] for k, p in PARAM_SPECS.items()}
    base.update(over)
    return base


def rand_params(rng: random.Random) -> Params:
    ranges = {k: (lo, hi) for k, (lo, _d, hi) in PARAM_GRID.items()}
    return Params(**{k: rng.uniform(lo, hi) for k, (lo, hi) in ranges.items()})


def drift(engine: SimulationEngine) -> float:
    m = engine.model
    return float(np.max(np.abs((m.S + m.E + m.I + m.R + m.D + m.V) - m.N)))


def engine_ok(engine: SimulationEngine, tol: float = 5.0) -> bool:
    m = engine.model
    finite_nonneg = all(
        np.isfinite(a).all() and (a >= -1e-6).all()
        for a in (m.S, m.E, m.I, m.R, m.D, m.V)
    )
    return finite_nonneg and drift(engine) < tol


async def recv_until(ws, pred, limit: int = 50):
    for _ in range(limit):
        s = await ws.recv()
        if pred(s):
            return s
    raise AssertionError("predicate never satisfied")


@pytest.fixture
def engine() -> SimulationEngine:
    return SimulationEngine()


@pytest.fixture
def small_model() -> SeirModel:
    pops = np.array([1_000_000.0, 500_000.0, 0.0])
    coupling = np.array([[0, 0.1, 0.1], [0.1, 0, 0.1], [0.1, 0.1, 0]], dtype=float)
    return SeirModel(pops, coupling)


@pytest.fixture(scope="module")
def real_countries():
    return load_countries()


@pytest.fixture(scope="module")
def coupling(real_countries):
    return build_coupling(real_countries)


@pytest.mark.unit
class TestEngine:
    def test_load_countries_order(self):
        countries = load_countries()
        assert len(countries) == N_COUNTRIES
        pops = [c.population for c in countries]
        assert pops == sorted(pops, reverse=True)

    def test_load_countries_missing_file(self, monkeypatch):
        import app.simulation as sim

        monkeypatch.setattr(sim, "COUNTRIES_FILE", sim.DATA_DIR / "nope.json")
        with pytest.raises(FileNotFoundError):
            sim.load_countries()

    def test_country_field_types(self):
        for c in load_countries():
            assert isinstance(c.iso, str) and len(c.iso) == 3
            assert c.population >= 0
            assert -90 <= c.lat <= 90 and -180 <= c.lon <= 180

    def test_coupling_shape_diag_baseline(self, coupling, real_countries):
        n = len(real_countries)
        assert coupling.shape == (n, n) and coupling.dtype == float
        assert np.allclose(np.diag(coupling), 0.0)
        off = coupling + np.eye(n)
        assert (off > 0).all()

    def test_coupling_unknown_iso_ignored(self, monkeypatch, real_countries):
        import app.simulation as sim

        spec = {
            "base_coupling": 0.03,
            "baseline_epsilon": 1e-7,
            "routes": [{"a": "ZZZ", "b": "ITA", "w": 1.0}],
        }
        monkeypatch.setattr(sim.json, "loads", lambda *_: spec)
        monkeypatch.setattr(sim.Path, "read_text", lambda *_a, **_k: "{}")
        w = sim.build_coupling(real_countries)
        assert w.shape == (len(real_countries), len(real_countries))

    def test_seirmodel_init_seed_cap(self, small_model):
        m = small_model
        assert np.allclose(m.S, m.N)
        m.seed(0, 100)
        assert m.I[0] == 100 and m.S[0] == 1_000_000.0 - 100
        m.seed(1, 9_999_999)
        assert m.I[1] == 500_000.0 and m.S[1] == 0.0

    def test_seirmodel_seed_negative_clamped(self, small_model):
        """Regression: negative seed must not create negative compartments."""
        m = small_model
        m.seed(0, -500)
        assert m.I[0] == 0.0 and m.S[0] == m.N[0]

    def test_step_conserves_and_reset(self, small_model):
        m = small_model
        m.seed(0, 1000)
        before = (m.S + m.E + m.I + m.R + m.D + m.V).sum()
        m.step(Params())
        after = (m.S + m.E + m.I + m.R + m.D + m.V).sum()
        assert abs(after - before) < 1e-3
        m.reset()
        assert np.allclose(m.S, m.N)
        assert np.allclose(m.E + m.I + m.R + m.D + m.V, 0.0)

    @pytest.mark.parametrize(
        "params",
        [
            Params(infectious_days=0.1),
            Params(incubation_days=0.1),
            Params(r0=20, infectious_days=0.1),
            Params(fatality_rate=1.0),
            Params(vaccination_rate=0.2),
            Params(mobility=0.0),
            Params(intervention=1.0),
        ],
    )
    def test_extreme_params_conservative(self, small_model, params):
        small_model.seed(0, 100_000)
        before = (
            small_model.S
            + small_model.E
            + small_model.I
            + small_model.R
            + small_model.D
            + small_model.V
        ).sum()
        for _ in range(15):
            small_model.step(params)
            for arr in (small_model.S, small_model.E, small_model.I):
                assert (arr >= -1e-6).all()
        after = (
            small_model.S
            + small_model.E
            + small_model.I
            + small_model.R
            + small_model.D
            + small_model.V
        ).sum()
        assert abs(after - before) < 1e-2

    def test_country_lockdown_dampens(self):
        m = SeirModel(np.array([1e6, 1e6]), np.zeros((2, 2)))
        m.seed(0, 10_000)
        m.seed(1, 10_000)
        m.C[1] = 1.0
        e0 = m.E.copy()
        m.step(Params(intervention=0.0))
        assert m.E[0] - e0[0] > 0
        assert m.E[1] - e0[1] == pytest.approx(0.0, abs=1e-6)

    def test_engine_seed_intervention_speed(self, engine):
        engine.seed("USA", 100)
        assert engine.model.I[engine.index["USA"]] == 100
        engine.seed("ZZZ", 100)
        engine.set_country_intervention("ITA", 0.6)
        assert engine.model.C[engine.index["ITA"]] == pytest.approx(0.6)

    @pytest.mark.parametrize("v,exp", [(1.5, 1.0), (-1.0, 0.0), (0.3, 0.3)])
    def test_intervention_clamp(self, engine, v, exp):
        engine.set_country_intervention("ITA", v)
        assert engine.model.C[engine.index["ITA"]] == pytest.approx(exp)

    @pytest.mark.parametrize(
        "speed,exp",
        [
            (app_config.SPEED_MIN - 1, app_config.SPEED_MIN),
            (app_config.SPEED_MAX + 999, app_config.SPEED_MAX),
            (10.0, 10.0),
        ],
    )
    def test_speed_clamp(self, engine, speed, exp):
        engine.set_speed(speed)
        assert engine.speed == pytest.approx(exp)

    def test_step_and_snapshot(self, engine):
        assert engine.day == 0
        engine.step()
        assert engine.day == 1
        engine.seed("USA", 500)
        snap = engine.snapshot().model_dump()
        assert len(snap["countries"]) == N_COUNTRIES
        assert snap["totals"]["s"] == pytest.approx(
            sum(c["s"] for c in snap["countries"]), rel=1e-9
        )

    def test_to_scenario_full_coverage(self, engine):
        idx = engine.index["FRA"]
        engine.model.E[idx] = 0.2
        engine.model.S[idx] -= 0.2
        engine.seed("USA", 1000)
        scen = engine.to_scenario()
        isos = {c["iso"] for c in scen["countries"]}
        assert len(scen["countries"]) == len(engine.countries) == N_COUNTRIES
        assert {"FRA", "USA", "JPN"} <= isos

    def test_apply_scenario_variants(self, engine):
        engine.apply_scenario({"countries": [{"iso": "ZZZ", "i": 5}]})
        engine.apply_scenario({"countries": [{"iso": "ITA", "intervention": 5.0}]})
        assert engine.model.C[engine.index["ITA"]] == pytest.approx(1.0)
        engine.apply_scenario({"params": {"r0": 9.0}})
        assert engine.params.r0 == 9.0
        assert engine.params.infectious_days == Params().infectious_days
        engine.seed("USA", 1000)
        engine.step()
        engine.apply_scenario({})
        assert engine.day == 0 and np.allclose(engine.model.S, engine.model.N)

    def test_to_scenario_empty_world(self, engine):
        scen = engine.to_scenario()
        assert len(scen["countries"]) == N_COUNTRIES
        assert all(
            c["e"] == c["i"] == c["r"] == c["d"] == c["v"] == 0.0
            for c in scen["countries"]
        )

    def test_reset_clears_lockdown(self, engine):
        engine.set_country_intervention("ITA", 0.9)
        engine.reset()
        assert engine.model.C[engine.index["ITA"]] == pytest.approx(0.0)

    def test_replay_history_and_frames(self, engine):
        engine.seed("USA", 1000)
        for _ in range(5):
            engine.step()
        assert [p["day"] for p in engine.history_points()] == [0, 1, 2, 3, 4, 5]
        fb = engine.frames_payload()
        assert len(fb["iso"]) == len(fb["name"]) == len(fb["population"]) == N_COUNTRIES
        assert [f["day"] for f in fb["frame"]] == [0, 1, 2, 3, 4, 5]
        for f in fb["frame"]:
            assert len(f["s"]) == len(f["i"]) == len(f["c"]) == N_COUNTRIES
        engine.reset()
        assert [p["day"] for p in engine.history_points()] == [0]
        assert [f["day"] for f in engine.frames_payload()["frame"]] == [0]

    def test_replay_frame_updates_in_place_on_seed(self, engine):
        engine.seed("USA", 5000)
        fb = engine.frames_payload()
        assert len(fb["frame"]) == 1 and fb["frame"][0]["day"] == 0
        assert fb["frame"][0]["i"][engine.index["USA"]] >= 4999

    def test_replay_metadata_matches_countries(self, engine):
        fb = engine.frames_payload()
        assert fb["iso"] == [c.iso for c in engine.countries]
        assert fb["name"] == [c.name for c in engine.countries]
        assert fb["population"] == [
            float(engine.model.N[i]) for i in range(engine.model.n)
        ]

    def test_replay_frames_match_live_state(self, engine):
        engine.seed("USA", 100_000)
        engine.seed("BRA", 20_000)
        engine.set_params(Params(r0=4.0, fatality_rate=0.05))
        for _ in range(30):
            engine.step()
        fb = engine.frames_payload()
        ref = SimulationEngine()
        ref.seed("USA", 100_000)
        ref.seed("BRA", 20_000)
        ref.set_params(Params(r0=4.0, fatality_rate=0.05))
        for day in range(31):
            frame = fb["frame"][day]
            assert frame["day"] == day
            for comp, arr in (
                ("s", ref.model.S),
                ("i", ref.model.I),
                ("r", ref.model.R),
            ):
                assert frame[comp] == [int(round(x)) for x in arr.tolist()], (
                    f"{comp} day {day}"
                )
            if day < 30:
                ref.step()

    def test_replay_history_totals_match_frames(self, engine):
        engine.seed("USA", 200_000)
        for _ in range(15):
            engine.step()
        pts = engine.history_points()
        fb = engine.frames_payload()
        assert [p["day"] for p in pts] == [f["day"] for f in fb["frame"]]
        for p, f in zip(pts, fb["frame"]):
            assert p["totals"]["i"] == pytest.approx(sum(f["i"]), abs=len(f["i"]))
            assert p["totals"]["s"] == pytest.approx(sum(f["s"]), abs=len(f["s"]))

    def test_replay_buffers_aligned_and_capped(self, monkeypatch):
        import app.simulation as sim

        monkeypatch.setattr(sim, "DATA_LIMIT", 5)
        e = SimulationEngine()
        e.seed("USA", 10_000)
        for _ in range(20):
            e.step()
        h_days = [p["day"] for p in e.history_points()]
        f_days = [f["day"] for f in e.frames_payload()["frame"]]
        assert h_days == f_days == [16, 17, 18, 19, 20]

    def test_replay_buffers_aligned_through_mixed_commands(self, engine):
        for k in range(8):
            engine.step()
            if k % 3 == 0:
                engine.seed("USA", 1000)
            if k % 4 == 0:
                engine.set_country_intervention("ITA", 0.5)
        h_days = [p["day"] for p in engine.history_points()]
        f_days = [f["day"] for f in engine.frames_payload()["frame"]]
        assert h_days == f_days == list(range(9))

    def test_set_params_and_speed(self, engine):
        engine.set_params(Params(r0=9.0, mobility=3.0))
        assert engine.params.r0 == 9.0 and engine.params.mobility == 3.0
        engine.set_speed(12.0)
        assert engine.speed == 12.0

    def test_replay_frames_carry_intervention(self, engine):
        engine.set_country_intervention("ITA", 0.7)
        engine.set_country_intervention("FRA", 1.0)
        engine.step()
        fb = engine.frames_payload()
        last = fb["frame"][-1]
        assert last["c"][fb["iso"].index("ITA")] == pytest.approx(0.7)
        assert last["c"][fb["iso"].index("FRA")] == pytest.approx(1.0)
        assert last["params"]["r0"] == pytest.approx(engine.params.r0)

    def test_apply_scenario_restores_speed_day_and_buffers(self):
        src = SimulationEngine()
        src.seed("USA", 100_000)
        src.set_speed(17.0)
        src.set_params(Params(r0=4.0))
        for _ in range(12):
            src.step()
        dst = SimulationEngine()
        dst.apply_scenario(src.to_scenario())
        assert dst.day == src.day == 12
        assert dst.speed == pytest.approx(17.0)
        assert dst.params.r0 == pytest.approx(4.0)
        assert [p["day"] for p in dst.history_points()] == [12]
        assert [f["day"] for f in dst.frames_payload()["frame"]] == [12]

    def test_coupling_includes_added_routes(self, coupling, real_countries):
        idx = {c.iso: i for i, c in enumerate(real_countries)}
        pairs = [
            ("COD", "BEL"),
            ("MMR", "THA"),
            ("SYR", "ARE"),
            ("KGZ", "RUS"),
            ("BRN", "SGP"),
            ("UNK", "TUR"),
            ("MAC", "CHN"),
            ("SWZ", "ZAF"),
        ]
        for a, b in pairs:
            assert coupling[idx[a], idx[b]] > 1e-5, f"{a}->{b} not coupled"
            assert coupling[idx[b], idx[a]] > 1e-5, f"{b}->{a} not coupled"

    def test_every_preset_runs_stable(self):
        presets = json.loads((DATA / "presets.json").read_text(encoding="utf-8"))
        for p in presets:
            e = SimulationEngine()
            e.set_params(Params(**p["params"]))
            e.seed("USA", 100_000)
            for _ in range(40):
                e.step()
            assert engine_ok(e), p["id"]


@pytest.mark.unit
class TestConnectionManager:
    async def test_broadcast_tolerates_concurrent_active_mutation(self, engine):
        """A client connecting mid-broadcast mutates the active set during the
        send await; broadcast must not raise 'set changed size during iteration'."""
        from app.main import ConnectionManager

        mgr = ConnectionManager()
        added = {"done": False}

        class FakeWS:
            async def send_json(self, payload):
                if not added["done"]:
                    added["done"] = True
                    mgr.active.add(FakeWS())

        mgr.active.add(FakeWS())
        mgr.active.add(FakeWS())
        await mgr.broadcast_snapshot(engine)

    async def test_broadcast_drops_dead_sockets(self, engine):
        from app.main import ConnectionManager

        mgr = ConnectionManager()

        class GoodWS:
            async def send_json(self, payload):
                pass

        class DeadWS:
            async def send_json(self, payload):
                raise RuntimeError("boom")

        good, dead = GoodWS(), DeadWS()
        mgr.active.update({good, dead})
        await mgr.broadcast_snapshot(engine)
        assert good in mgr.active and dead not in mgr.active


@pytest.mark.unit
class TestValidation:
    @pytest.mark.parametrize("field,bounds", VALIDATION_BOUNDS.items())
    def test_bounds(self, field, bounds):
        min_ok, max_ok, below, above = bounds
        Params(**{field: min_ok})
        Params(**{field: max_ok})
        with pytest.raises(ValidationError):
            Params(**{field: below})
        with pytest.raises(ValidationError):
            Params(**{field: above})

    def test_defaults_match_config(self):
        p = Params().model_dump()
        for key, spec in PARAM_SPECS.items():
            assert p[key] == pytest.approx(spec["default"]), key
        with pytest.raises(ValidationError):
            Params(r0="x")

    def test_missing_required(self):
        for ctor in (
            lambda: CountryMeta(iso="ITA"),
            lambda: Preset(id="x"),
            lambda: Snapshot(day=0),
        ):
            with pytest.raises(ValidationError):
                ctor()


@pytest.mark.unit
class TestStability:
    @pytest.mark.parametrize(
        "params",
        [
            Params(r0=3.0, fatality_rate=0.02),
            Params(r0=8.0, fatality_rate=0.3, vaccination_rate=0.01),
            Params(r0=1.2, infectious_days=20, incubation_days=10),
            Params(r0=20, infectious_days=0.1, incubation_days=0.1, fatality_rate=1.0),
        ],
    )
    def test_10k_days_stable(self, params):
        e = SimulationEngine()
        e.seed("USA", 5000)
        e.seed("CHN", 5000)
        prev = {k: -1.0 for k in "rdv"}
        tol = e.model.N.sum() * 1e-9 + 1.0
        for day in range(10_000):
            e.model.step(params)
            if day % 250 == 0 or day == 9_999:
                assert engine_ok(e, tol=tol), f"broke at day {day}"
                m = e.model
                tot = {
                    "r": float(m.R.sum()),
                    "d": float(m.D.sum()),
                    "v": float(m.V.sum()),
                }
                for k in "rdv":
                    assert tot[k] + 1.0 >= prev[k]
                    prev[k] = tot[k]
        active = float((e.model.E + e.model.I).sum())
        assert active < e.model.N.sum() * 1e-3

    def test_idle_10k_no_outbreak(self):
        e = SimulationEngine()
        n = e.model.N.sum()
        for _ in range(10_000):
            e.model.step(Params(r0=5.0))
        assert e.model.S.sum() == pytest.approx(n)

    @pytest.mark.parametrize(
        "field,value", [(f, v) for f, vals in PARAM_GRID.items() for v in vals]
    )
    def test_param_before(self, field, value):
        e = SimulationEngine()
        e.set_params(Params(**{field: value}))
        e.seed("USA", 100_000)
        for _ in range(60):
            e.step()
            assert engine_ok(e), f"{field}={value} (before)"

    @pytest.mark.parametrize(
        "field,value", [(f, v) for f, vals in PARAM_GRID.items() for v in vals]
    )
    def test_param_during(self, field, value):
        e = SimulationEngine()
        e.seed("USA", 100_000)
        for _ in range(20):
            e.step()
        e.set_params(Params(**{field: value}))
        assert getattr(e.params, field) == pytest.approx(value)
        for _ in range(40):
            e.step()
            assert engine_ok(e), f"{field}={value} (during)"

    def test_all_params_swept_one_run(self):
        e = SimulationEngine()
        e.seed("USA", 50_000)
        for change in [
            {"r0": 6.0},
            {"intervention": 0.8},
            {"vaccination_rate": 0.05},
            {"fatality_rate": 0.5},
            {"incubation_days": 1.0},
            {"infectious_days": 30.0},
            {"mobility": 5.0},
            {"r0": 0.0},
        ]:
            cur = e.params.model_dump()
            cur.update(change)
            e.set_params(Params(**cur))
            for _ in range(15):
                e.step()
                assert engine_ok(e), f"after {change}"

    @pytest.mark.parametrize("seed", range(25))
    def test_fuzz_command_sequences(self, seed):
        rng = random.Random(seed)
        e = SimulationEngine()
        isos = [c.iso for c in e.countries] + ["ZZZ", "", "xx"]
        for n in range(250):
            action = rng.choices(
                ["step", "seed", "params", "intervention", "reset"],
                weights=[55, 15, 15, 12, 3],
            )[0]
            if action == "step":
                e.step()
            elif action == "seed":
                e.seed(rng.choice(isos), rng.uniform(-1000, 2_000_000))
            elif action == "params":
                e.set_params(rand_params(rng))
            elif action == "intervention":
                e.set_country_intervention(rng.choice(isos), rng.uniform(-0.5, 1.5))
            else:
                e.reset()
            assert engine_ok(e), f"seed={seed} step={n} action={action}"

    @pytest.mark.parametrize("seed", range(10))
    def test_fuzz_params_each_step(self, seed):
        rng = random.Random(1000 + seed)
        e = SimulationEngine()
        e.seed("USA", 1_000_000)
        for n in range(300):
            e.set_params(rand_params(rng))
            e.step()
            if rng.random() < 0.1:
                e.seed(
                    rng.choice([c.iso for c in e.countries]), rng.uniform(0, 500_000)
                )
            assert engine_ok(e), f"seed={seed} step={n}"


@pytest.mark.unit
class TestEdge:
    def test_seed_every_country_conserves(self, engine):
        for c in engine.countries:
            engine.seed(c.iso, 10_000)
        for _ in range(30):
            engine.step()
        assert engine_ok(engine)

    def test_zero_mobility_no_spread(self, engine):
        engine.seed("USA", 100_000)
        engine.set_params(Params(r0=6.0, mobility=0.0))
        for _ in range(80):
            engine.step()
        assert int(((engine.model.E + engine.model.I) >= 1).sum()) == 1

    def test_global_lockdown_stops_spread(self, engine):
        engine.seed("USA", 100_000)
        engine.model.C[:] = 1.0
        engine.set_params(Params(r0=10.0, mobility=5.0))
        before = int(((engine.model.E + engine.model.I) >= 1).sum())
        for _ in range(60):
            engine.step()
        assert int(((engine.model.E + engine.model.I) >= 1).sum()) <= before


@pytest.mark.unit
class TestScenarioUnit:
    def test_round_trip_identical_continuation(self):
        a = SimulationEngine()
        a.seed("USA", 100_000)
        a.seed("BRA", 20_000)
        a.set_params(Params(r0=4.0, fatality_rate=0.05))
        for _ in range(80):
            a.step()
        b = SimulationEngine()
        b.apply_scenario(a.to_scenario())
        for _ in range(50):
            a.step()
            b.step()
        for arr in "SEIRDV":
            assert np.allclose(getattr(a.model, arr), getattr(b.model, arr), atol=1e-6)
        assert a.day == b.day

    def test_double_round_trip_stable(self):
        e = SimulationEngine()
        e.seed("IND", 50_000)
        e.set_country_intervention("IND", 0.4)
        for _ in range(40):
            e.step()
        s1 = e.to_scenario()
        e2 = SimulationEngine()
        e2.apply_scenario(s1)
        s2 = e2.to_scenario()
        a = {c["iso"]: c for c in s1["countries"]}
        b = {c["iso"]: c for c in s2["countries"]}
        assert a.keys() == b.keys()
        for iso in a:
            for k in "seirdv":
                assert a[iso][k] == pytest.approx(b[iso][k], abs=1e-6)

    def test_round_trip_preserves_lockdown(self):
        e = SimulationEngine()
        e.seed("USA", 1000)
        e.set_country_intervention("ITA", 0.7)
        e.set_country_intervention("FRA", 1.0)
        e2 = SimulationEngine()
        e2.apply_scenario(e.to_scenario())
        assert e2.model.C[e2.index["ITA"]] == pytest.approx(0.7)
        assert e2.model.C[e2.index["FRA"]] == pytest.approx(1.0)

    def test_to_scenario_top_level_keys(self):
        e = SimulationEngine()
        e.set_speed(22.0)
        e.set_params(Params(r0=3.3))
        e.seed("USA", 1000)
        e.step()
        scen = e.to_scenario("my-run")
        assert scen["name"] == "my-run"
        assert scen["day"] == 1
        assert scen["speed"] == pytest.approx(22.0)
        assert scen["params"]["r0"] == pytest.approx(3.3)
        assert all(
            {"iso", "s", "e", "i", "r", "d", "v", "intervention"} <= c.keys()
            for c in scen["countries"]
        )


@pytest.mark.unit
class TestBackup:
    @staticmethod
    def _engine(path) -> SimulationEngine:
        return SimulationEngine(backup=BackupWriter(path))

    @staticmethod
    def _lines(path) -> list[str]:
        return path.read_text(encoding="utf-8").strip().splitlines()

    def test_default_engine_has_no_backup(self):
        """The in-process default engine never touches disk (backup is opt-in)."""
        e = SimulationEngine()
        assert e._backup is None
        e.seed("USA", 1000)
        e.step()

    def test_starts_with_header_and_day0(self, tmp_path):
        path = tmp_path / "b.ndjson"
        self._engine(path)
        lines = self._lines(path)
        assert len(lines) == 2
        assert json.loads(lines[0])["kind"] == "header"
        assert json.loads(lines[0])["version"] == SAVE_VERSION
        frame0 = json.loads(lines[1])
        assert frame0["kind"] == "frame" and frame0["day"] == 0

    def test_append_only_one_line_per_record(self, tmp_path):
        """Each recorded day appends exactly one line — the backup is incremental,
        never a full rewrite."""
        path = tmp_path / "b.ndjson"
        e = self._engine(path)
        n = len(self._lines(path))
        e.seed("USA", 1000)
        assert len(self._lines(path)) == n + 1
        for _ in range(8):
            before = len(self._lines(path))
            e.step()
            assert len(self._lines(path)) == before + 1

    def test_reconstructs_saved_state(self, tmp_path):
        path = tmp_path / "b.ndjson"
        e = self._engine(path)
        e.seed("USA", 100_000)
        e.set_params(Params(r0=4.0, fatality_rate=0.05))
        for _ in range(20):
            e.step()
        state = backup_mod.load_saved_state(path)
        assert state["version"] == SAVE_VERSION
        days = [f["day"] for f in state["frames"]]
        assert days == list(range(21))
        for f in state["frames"]:
            assert f["type"] == "snapshot" and f["running"] is False
            assert len(f["countries"]) == N_COUNTRIES
        live = e.frames_payload()
        usa = live["iso"].index("USA")
        for comp in ("s", "i", "r", "d"):
            assert (
                state["frames"][-1]["countries"][usa][comp]
                == live["frame"][-1][comp][usa]
            )

    def test_saved_state_totals_and_history_aligned(self, tmp_path):
        path = tmp_path / "b.ndjson"
        e = self._engine(path)
        e.seed("USA", 50_000)
        for _ in range(12):
            e.step()
        state = backup_mod.load_saved_state(path)
        for f in state["frames"]:
            for k in "seirdv":
                assert f["totals"][k] == pytest.approx(
                    sum(c[k] for c in f["countries"])
                )
        assert [h["day"] for h in state["history"]] == [
            f["day"] for f in state["frames"]
        ]

    def test_scenario_round_trips_through_apply(self, tmp_path):
        """The last-day scenario rebuilt from the backup imports cleanly and
        resumes (the standard POST /api/scenario format)."""
        path = tmp_path / "b.ndjson"
        e = self._engine(path)
        e.seed("USA", 200_000)
        e.seed("BRA", 50_000)
        e.set_params(Params(r0=5.0, fatality_rate=0.03))
        e.set_speed(13.0)
        for _ in range(25):
            e.step()
        scen = backup_mod.load_scenario(path)
        assert scen["day"] == 25 and scen["speed"] == pytest.approx(13.0)
        assert scen["params"]["r0"] == pytest.approx(5.0)
        dst = SimulationEngine()
        dst.apply_scenario(scen)
        assert dst.day == 25
        for iso in ("USA", "BRA"):
            want = next(c["i"] for c in scen["countries"] if c["iso"] == iso)
            assert dst.model.I[dst.index[iso]] == pytest.approx(want)
        assert dst.model.I.sum() > 0
        dst.step()
        assert dst.day == 26

    def test_crash_recovery_resumes_from_last_day(self, tmp_path):
        """Simulate a process restart: read recovery BEFORE the new engine
        truncates the file (as the server's lifespan does), then resume."""
        path = tmp_path / "b.ndjson"
        a = self._engine(path)
        a.seed("USA", 100_000)
        a.set_params(Params(r0=4.0))
        for _ in range(30):
            a.step()
        recovered = backup_mod.load_scenario(path)
        b = self._engine(path)
        b.apply_scenario(recovered)
        assert b.day == 30
        usa_i = next(c["i"] for c in recovered["countries"] if c["iso"] == "USA")
        assert usa_i > 0
        assert b.model.I[b.index["USA"]] == pytest.approx(usa_i)
        assert [f["day"] for f in backup_mod.load_saved_state(path)["frames"]] == [30]
        b.step()
        assert [f["day"] for f in backup_mod.load_saved_state(path)["frames"]] == [
            30,
            31,
        ]

    def test_reset_starts_new_segment(self, tmp_path):
        path = tmp_path / "b.ndjson"
        e = self._engine(path)
        for _ in range(5):
            e.step()
        e.reset()
        assert [f["day"] for f in backup_mod.load_saved_state(path)["frames"]] == [0]

    def test_torn_final_line_is_skipped(self, tmp_path):
        """A half-written final line (crash mid-append) must not break recovery."""
        path = tmp_path / "b.ndjson"
        e = self._engine(path)
        for _ in range(3):
            e.step()
        with path.open("a", encoding="utf-8") as f:
            f.write('{"kind": "frame", "day": 4, "s": [1, 2, 3')
        state = backup_mod.load_saved_state(path)
        assert [f["day"] for f in state["frames"]] == [0, 1, 2, 3]

    def test_missing_file_is_none(self, tmp_path):
        missing = tmp_path / "nope.ndjson"
        assert backup_mod.load_scenario(missing) is None
        assert backup_mod.load_saved_state(missing) is None

    def test_last_wins_per_day_on_same_day_records(self, tmp_path):
        """Multiple records for the same day (seed without stepping) collapse to
        the latest state on load."""
        path = tmp_path / "b.ndjson"
        e = self._engine(path)
        e.seed("USA", 1000)
        e.seed("USA", 4000)
        state = backup_mod.load_saved_state(path)
        assert [f["day"] for f in state["frames"]] == [0]
        usa = next(c for c in state["frames"][0]["countries"] if c["iso"] == "USA")
        assert usa["i"] == 5000

    def test_load_saved_state_caps_to_retention(self, tmp_path, monkeypatch):
        """The reconstructed timeline never exceeds the retention window, even if
        the append-only log on disk is longer (it is never trimmed on disk)."""
        monkeypatch.setattr(backup_mod, "MAX_RECOVERY_DAYS", 5)
        path = tmp_path / "b.ndjson"
        e = self._engine(path)
        e.seed("USA", 10_000)
        for _ in range(20):
            e.step()
        state = backup_mod.load_saved_state(path)
        days = [f["day"] for f in state["frames"]]
        assert days == [16, 17, 18, 19, 20]
        assert [h["day"] for h in state["history"]] == days

    def test_restore_replays_full_timeline(self, tmp_path):
        """Full-timeline recovery: a brand-new engine rebuilt from the backup
        replays the ENTIRE pre-crash run (every day, both buffers), byte-identical
        to the source's columnar replay — so a reconnecting client loses nothing."""
        path = tmp_path / "b.ndjson"
        a = self._engine(path)
        a.seed("USA", 100_000)
        a.seed("IND", 30_000)
        a.set_params(Params(r0=3.8, fatality_rate=0.04))
        a.set_country_intervention("ITA", 0.5)
        for _ in range(50):
            a.step()
        state = backup_mod.load_saved_state(path)

        b = SimulationEngine()
        b.restore(state)
        assert b.day == 50
        assert b.params.r0 == pytest.approx(3.8)
        a_fb, b_fb = a.frames_payload(), b.frames_payload()
        assert [f["day"] for f in b_fb["frame"]] == list(range(51))
        assert [p["day"] for p in b.history_points()] == list(range(51))
        assert b_fb["iso"] == a_fb["iso"]
        assert b_fb["frame"] == a_fb["frame"]
        assert b_fb["frame"][-1]["c"][b_fb["iso"].index("ITA")] == pytest.approx(0.5)

    def test_restore_then_resume_keeps_appending(self, tmp_path):
        """After a full restore the backup is rewritten as one continuous segment
        (day 0..N) and keeps appending as the resumed run advances."""
        path = tmp_path / "b.ndjson"
        a = self._engine(path)
        a.seed("USA", 50_000)
        for _ in range(10):
            a.step()
        state = backup_mod.load_saved_state(path)

        path2 = tmp_path / "b2.ndjson"
        b = SimulationEngine(backup=BackupWriter(path2))
        b.restore(state)
        assert [f["day"] for f in backup_mod.load_saved_state(path2)["frames"]] == list(
            range(11)
        )
        b.step()
        assert [f["day"] for f in backup_mod.load_saved_state(path2)["frames"]] == list(
            range(12)
        )

    def test_restore_empty_is_noop(self):
        e = SimulationEngine()
        e.seed("USA", 1000)
        e.step()
        e.restore({"frames": []})
        assert e.day == 1
        e.restore({})
        assert e.day == 1


@pytest.mark.data
class TestData:
    @staticmethod
    def _load(name):
        return json.loads((DATA / name).read_text(encoding="utf-8"))

    def test_countries(self):
        countries = self._load("countries.json")
        assert len(countries) == N_COUNTRIES
        isos = [c["iso"] for c in countries]
        assert len(set(isos)) == len(isos)
        for c in countries:
            assert (
                isinstance(c["iso"], str) and len(c["iso"]) == 3 and c["iso"].isalpha()
            )
            assert c["population"] > 0
            assert -90 <= c["lat"] <= 90 and -180 <= c["lon"] <= 180

    def test_flights(self):
        flights = self._load("flights.json")
        countries = {c["iso"] for c in self._load("countries.json")}
        seen = set()
        for r in flights["routes"]:
            assert r["a"] != r["b"]
            assert r["a"] in countries and r["b"] in countries
            assert 0 < r["w"] <= 1
            key = tuple(sorted((r["a"], r["b"])))
            assert key not in seen
            seen.add(key)
        assert flights["base_coupling"] > 0 and flights["baseline_epsilon"] > 0

    def test_presets_within_bounds(self):
        presets = self._load("presets.json")
        assert len(presets) >= 1
        for p in presets:
            assert isinstance(Preset(**p).params, Params)

    def test_geojson_known_mismatches(self):
        geo = self._load("world.geo.json")
        countries = {c["iso"] for c in self._load("countries.json")}
        ids = [f.get("id") for f in geo["features"]]
        geo_iso = {i for i in ids if isinstance(i, str) and len(i) == 3 and i.isalpha()}
        non_iso = [i for i in ids if i not in geo_iso]
        assert len(non_iso) == 0
        assert len(countries - geo_iso) <= 10
        assert not (geo_iso - countries)

    @pytest.mark.parametrize(
        "name", ["countries.json", "flights.json", "presets.json", "world.geo.json"]
    )
    def test_valid_json(self, name):
        self._load(name)


@pytest.mark.integration
class TestRest:
    def test_health(self, client):
        assert client.get("/api/health").json() == {"status": "ok"}

    def test_config_is_single_source(self, client):
        cfg = client.get("/api/config").json()
        assert cfg["saveVersion"] == app_config.SAVE_VERSION == SAVE_VERSION
        assert cfg["dataLimit"] == app_config.DATA_LIMIT
        assert {"default", "min", "max"} <= set(cfg["speed"])
        assert isinstance(cfg["mapDefaultStates"], dict)
        keys = {p["key"] for p in cfg["params"]}
        assert keys == set(Params().model_dump())
        for p in cfg["params"]:
            assert {"key", "default", "min", "max", "step"} <= set(p)
            assert Params(**{p["key"]: p["max"]})
            with pytest.raises(ValidationError):
                Params(**{p["key"]: p["max"] + 1})

    def test_countries(self, client):
        data = client.get("/api/countries").json()
        assert len(data) == N_COUNTRIES
        assert {"iso", "name", "population", "lat", "lon"} <= data[0].keys()

    def test_geojson(self, client):
        geo = client.get("/api/geojson").json()
        assert geo["type"] == "FeatureCollection" and len(geo["features"]) > 0

    def test_presets(self, client):
        presets = client.get("/api/presets").json()
        assert len(presets) >= 1
        assert {"id", "name", "description", "params"} <= presets[0].keys()

    def test_flights(self, client):
        data = client.get("/api/flights").json()
        assert "routes" in data and "base_coupling" in data

    def test_scenario_export(self, client):
        assert "countries" in client.get("/api/scenario").json()
        assert client.get("/api/scenario", params={"name": "x"}).json()["name"] == "x"

    def test_scenario_import_and_empty(self, client):
        body = {
            "name": "t",
            "day": 5,
            "speed": 10.0,
            "params": full_params(r0=3.0),
            "countries": [
                {
                    "iso": "USA",
                    "s": 100,
                    "e": 0,
                    "i": 50,
                    "r": 0,
                    "d": 0,
                    "v": 0,
                    "intervention": 0.0,
                }
            ],
        }
        r = client.post("/api/scenario", json=body)
        assert r.json() == {"ok": True, "day": 5}
        assert client.post("/api/scenario", json={}).json()["day"] == 0

    def test_scenario_malformed(self, client):
        r = client.post(
            "/api/scenario",
            content=b"{not json",
            headers={"content-type": "application/json"},
        )
        assert r.status_code != 500
        assert client.get("/api/health").status_code == 200

    def test_cors(self, client):
        origin = app_config.CORS_ORIGINS[0]
        r = client.get("/api/health", headers={"Origin": origin})
        assert r.headers.get("access-control-allow-origin") == origin
        r2 = client.get("/api/health", headers={"Origin": "http://evil.example"})
        assert "access-control-allow-origin" not in {k.lower() for k in r2.headers}

    def test_round_trip_stable(self, client):
        client.post("/api/scenario", json={})
        exported = client.get("/api/scenario").json()
        client.post("/api/scenario", json=exported)
        again = client.get("/api/scenario").json()
        assert again["day"] == exported["day"] and again["params"] == exported["params"]


@pytest.mark.integration
class TestWebSocket:
    async def test_initial_snapshot(self, ws_url):
        async with ws_connect(ws_url) as ws:
            s = await ws.recv()
            assert s["type"] == "snapshot"
            check_snapshot(s)

    async def test_get_history_replay(self, ws_url):
        async with ws_connect(ws_url) as ws:
            await ws.recv()
            await ws.command({"type": "seed", "iso": "USA", "count": 1000})
            for _ in range(4):
                await ws.command({"type": "step"})
            await ws.send({"type": "getHistory"})
            h = await recv_until(ws, lambda m: m.get("type") == "history")
            assert [p["day"] for p in h["points"]] == [0, 1, 2, 3, 4]
            fb = h["frames"]
            assert len(fb["iso"]) == N_COUNTRIES
            assert [f["day"] for f in fb["frame"]] == [0, 1, 2, 3, 4]
            assert fb["frame"][-1]["i"][fb["iso"].index("USA")] >= 1

    async def test_broadcast_to_all_clients(self, ws_url):
        import asyncio

        async with ws_connect(ws_url) as a, ws_connect(ws_url) as b:
            await asyncio.sleep(0.2)
            await a.send({"type": "seed", "iso": "USA", "count": 1234})
            pred = lambda s: any(
                c["iso"] == "USA" and c["i"] >= 1234 for c in s["countries"]
            )
            sa = await recv_until(a, pred)
            sb = await recv_until(b, pred)
            assert sa["day"] == sb["day"]

    async def test_play_streams_and_pause(self, ws_url):
        async with ws_connect(ws_url) as ws:
            await ws.recv()
            await ws.command({"type": "setSpeed", "speed": 30})
            await ws.send({"type": "play"})
            s1 = await recv_until(ws, lambda s: s["day"] >= 1)
            s2 = await recv_until(ws, lambda s: s["day"] > s1["day"])
            check_snapshot(s2)
            p = await ws.command({"type": "pause"})
            assert p["running"] is False

    async def test_step_and_reset(self, ws_url):
        async with ws_connect(ws_url) as ws:
            await ws.recv()
            s = await ws.command({"type": "step"})
            assert s["day"] == 1
            await ws.command({"type": "seed", "iso": "USA", "count": 1000})
            r = await ws.command({"type": "reset"})
            assert r["day"] == 0 and r["totals"]["i"] == pytest.approx(0.0, abs=1e-6)

    async def test_step_200_days_invariants(self, ws_url):
        async with ws_connect(ws_url) as ws:
            await ws.recv()
            await ws.command({"type": "seed", "iso": "USA", "count": 1000})
            await ws.command({"type": "setParams", "params": full_params(r0=3.0)})
            prev = {k: 0.0 for k in "rdv"}
            worst = 0.0
            for _ in range(200):
                s = await ws.command({"type": "step"})
                worst = max(worst, check_snapshot(s))
                assert_monotonic_cumulative(prev, s["totals"])
                prev = s["totals"]
            assert worst < 1.0

    async def test_seed_variants(self, ws_url):
        async with ws_connect(ws_url) as ws:
            await ws.recv()
            s = await ws.command({"type": "seed", "iso": "USA", "count": 1000})
            assert next(c for c in s["countries"] if c["iso"] == "USA")[
                "i"
            ] == pytest.approx(1000)
            s = await ws.command({"type": "seed", "iso": "USA"})
            assert next(c for c in s["countries"] if c["iso"] == "USA")[
                "i"
            ] == pytest.approx(1100)
            s = await ws.command({"type": "seed", "iso": "ZZZ", "count": 100})
            check_snapshot(s)

    async def test_seed_negative_and_non_numeric(self, ws_url):
        async with ws_connect(ws_url) as ws:
            await ws.recv()
            s = await ws.command({"type": "seed", "iso": "USA", "count": -500})
            check_snapshot(s)
            usa = next(c for c in s["countries"] if c["iso"] == "USA")
            assert usa["i"] >= 0 and usa["s"] <= usa["population"]
            await ws.send({"type": "seed", "iso": "USA", "count": "abc"})
            check_snapshot(await ws.command({"type": "step"}))

    async def test_setparams_full_and_partial_merge(self, ws_url):
        async with ws_connect(ws_url) as ws:
            await ws.recv()
            s = await ws.command(
                {"type": "setParams", "params": full_params(r0=4.2, mobility=2.0)}
            )
            assert s["params"]["r0"] == 4.2 and s["params"]["mobility"] == 2.0
            await ws.command(
                {
                    "type": "setParams",
                    "params": full_params(infectious_days=9, fatality_rate=0.03),
                }
            )
            s = await ws.command({"type": "setParams", "params": {"r0": 7.5}})
            assert s["params"]["r0"] == 7.5
            assert (
                s["params"]["infectious_days"] == 9
                and s["params"]["fatality_rate"] == 0.03
            )

    async def test_setparams_out_of_range_ignored(self, ws_url):
        async with ws_connect(ws_url) as ws:
            await ws.recv()
            before = await ws.command({"type": "step"})
            await ws.send({"type": "setParams", "params": {"r0": 999}})
            s = await ws.command({"type": "step"})
            assert s["params"]["r0"] == before["params"]["r0"]

    @pytest.mark.parametrize(
        "speed,exp",
        [
            (10, 10.0),
            (0, app_config.SPEED_MIN),
            (app_config.SPEED_MAX + 1000, app_config.SPEED_MAX),
        ],
    )
    async def test_setspeed_clamp(self, ws_url, speed, exp):
        async with ws_connect(ws_url) as ws:
            await ws.recv()
            assert (await ws.command({"type": "setSpeed", "speed": speed}))[
                "speed"
            ] == pytest.approx(exp)

    @pytest.mark.parametrize("value,exp", [(0.6, 0.6), (1.5, 1.0), (-1.0, 0.0)])
    async def test_country_intervention(self, ws_url, value, exp):
        async with ws_connect(ws_url) as ws:
            await ws.recv()
            s = await ws.command(
                {"type": "setCountryIntervention", "iso": "ITA", "value": value}
            )
            assert next(c for c in s["countries"] if c["iso"] == "ITA")[
                "intervention"
            ] == pytest.approx(exp)

    async def test_robustness(self, ws_url):
        async with ws_connect(ws_url) as ws:
            await ws.recv()
            await ws.send_raw("not-json")
            assert (await ws.command({"type": "step"}))["day"] == 1
            await ws.send({"type": "totally-unknown"})
            await ws.send({"params": {"r0": 3}})
            s = await ws.command({"type": "step", "garbage": 1, "extra": [1, 2]})
            assert s["day"] == 2

    async def test_reset_during_play_and_reconnect(self, ws_url):
        async with ws_connect(ws_url) as ws:
            await ws.recv()
            await ws.command({"type": "seed", "iso": "USA", "count": 50_000})
            await ws.command({"type": "setSpeed", "speed": 30})
            await ws.send({"type": "play"})
            for _ in range(5):
                await ws.recv()
            s = await ws.command({"type": "reset"})
            assert s["day"] == 0
        for _ in range(5):
            async with ws_connect(ws_url) as ws:
                check_snapshot(await ws.recv())

    async def test_pipelined_commands(self, ws_url):
        async with ws_connect(ws_url) as ws:
            await ws.recv()
            for _ in range(10):
                await ws.send({"type": "step"})
            last = None
            for _ in range(10):
                last = await ws.recv()
            check_snapshot(last)
            assert last["day"] >= 1

    async def test_scenario_read_during_run(self, ws_url, base_url):
        async with ws_connect(ws_url) as ws:
            await ws.recv()
            await ws.command({"type": "seed", "iso": "USA", "count": 1000})
            await ws.command({"type": "setSpeed", "speed": 30})
            await ws.send({"type": "play"})
            await recv_until(ws, lambda s: s["day"] >= 2)
            with httpx.Client(base_url=base_url, timeout=5.0) as c:
                assert "countries" in c.get("/api/scenario").json()
            await ws.command({"type": "pause"})


@pytest.mark.integration
class TestScenarioIntegration:
    async def test_import_then_continue_over_ws(self, base_url, ws_url):
        gen = SimulationEngine()
        gen.seed("USA", 200_000)
        gen.set_params(Params(r0=5.0, fatality_rate=0.03))
        for _ in range(30):
            gen.step()
        scenario = gen.to_scenario("mid")
        with httpx.Client(base_url=base_url, timeout=10.0) as c:
            assert c.post("/api/scenario", json=scenario).json()["day"] == 30
        async with ws_connect(ws_url) as ws:
            first = await ws.recv()
            check_snapshot(first)
            assert first["day"] == 30 and first["totals"]["i"] > 0
            assert (await ws.command({"type": "step"}))["day"] == 31
            check_snapshot(await ws.command({"type": "step"}))

    async def test_import_empty_then_play(self, base_url, ws_url):
        with httpx.Client(base_url=base_url, timeout=10.0) as c:
            c.post("/api/scenario", json={})
        async with ws_connect(ws_url) as ws:
            first = await ws.recv()
            assert first["day"] == 0 and first["totals"]["i"] == pytest.approx(
                0.0, abs=1e-6
            )
            assert (await ws.command({"type": "step"}))["day"] == 1


@pytest.mark.integration
class TestReplayCompleteness:
    async def test_midrun_client_gets_complete_timeline(self, ws_url):
        """A second client connecting mid-run must receive the COMPLETE per-day
        totals series AND the full per-country timeline (every country, day 0..N)."""
        n = 40
        async with ws_connect(ws_url) as a:
            await a.recv()
            await a.command({"type": "seed", "iso": "USA", "count": 10_000})
            await a.command({"type": "setParams", "params": full_params(r0=3.5)})
            for _ in range(n):
                await a.command({"type": "step"})
            async with ws_connect(ws_url) as b:
                await b.recv()
                await b.send({"type": "getHistory"})
                h = await recv_until(b, lambda m: m.get("type") == "history")
        points, fb = h["points"], h["frames"]
        assert [p["day"] for p in points] == list(range(n + 1))
        assert [f["day"] for f in fb["frame"]] == list(range(n + 1))
        assert len(fb["iso"]) == len(fb["name"]) == len(fb["population"]) == N_COUNTRIES
        for f in fb["frame"]:
            assert len(f["s"]) == len(f["i"]) == len(f["c"]) == N_COUNTRIES
        last = fb["frame"][-1]
        assert points[-1]["totals"]["i"] == pytest.approx(
            sum(last["i"]), abs=N_COUNTRIES
        )
        assert last["i"][fb["iso"].index("USA")] >= 1

    async def test_disconnect_reconnect_preserves_state(self, ws_url):
        """Full disconnect then reconnect ('reload'): the shared engine keeps the
        run, and re-requesting data ('reload data') replays the whole history."""
        async with ws_connect(ws_url) as a:
            await a.recv()
            await a.command({"type": "seed", "iso": "USA", "count": 5000})
            for _ in range(10):
                await a.command({"type": "step"})
        async with ws_connect(ws_url) as b:
            first = await b.recv()
            assert first["day"] == 10
            await b.send({"type": "getHistory"})
            h = await recv_until(b, lambda m: m.get("type") == "history")
            assert [p["day"] for p in h["points"]] == list(range(11))
            assert [f["day"] for f in h["frames"]["frame"]] == list(range(11))


@pytest.mark.integration
class TestBackupRest:
    async def test_backup_endpoint_reflects_run(self, base_url, ws_url):
        """The server auto-exports every day; GET /api/backup returns the run as
        an importable SavedState covering day 0..N with all countries."""
        async with ws_connect(ws_url) as ws:
            await ws.recv()
            await ws.command({"type": "seed", "iso": "USA", "count": 5000})
            for _ in range(6):
                await ws.command({"type": "step"})
            with httpx.Client(base_url=base_url, timeout=5.0) as c:
                state = c.get("/api/backup").json()
        assert state["version"] == SAVE_VERSION
        days = [f["day"] for f in state["frames"]]
        assert days[0] == 0 and days[-1] == 6
        assert all(len(f["countries"]) == N_COUNTRIES for f in state["frames"])
        usa = next(c for c in state["frames"][-1]["countries"] if c["iso"] == "USA")
        assert usa["i"] >= 1

    def test_backup_reimportable_as_scenario(self, client):
        """The backup-derived SavedState's last frame round-trips back through
        POST /api/scenario — the auto-export follows the importable standard."""
        state = client.get("/api/backup").json()
        last = state["frames"][-1]
        scenario = {
            "name": "from-backup",
            "day": last["day"],
            "params": last["params"],
            "speed": last["speed"],
            "countries": [
                {k: c[k] for k in ("iso", "s", "e", "i", "r", "d", "v", "intervention")}
                for c in last["countries"]
            ],
        }
        r = client.post("/api/scenario", json=scenario)
        assert r.json() == {"ok": True, "day": last["day"]}
