"""Web layer: FastAPI app, real-time WebSocket loop and all endpoints.

This single module owns everything server-side around the simulation:

* the shared :class:`~app.simulation.SimulationEngine` and the WebSocket
  :class:`ConnectionManager` (created at startup);
* :func:`sim_loop`, the background task that auto-advances the simulation and
  broadcasts a frame per step;
* every REST endpoint (under ``/api``) and the ``/ws`` stream.

The domain logic lives in :mod:`app.simulation` and the wire schemas in
:mod:`app.models`. Run with::

    uv run uvicorn app.main:app --reload --port 8000

Client -> server WebSocket commands, each a JSON message followed by its effect:
    {"type": "play"}                              start auto-advancing
    {"type": "pause"}                             stop auto-advancing
    {"type": "reset"}                             back to day 0, empty world
    {"type": "step"}                              advance exactly one day
    {"type": "seed", "iso": "USA", "count": 100}  start an outbreak
    {"type": "setParams", "params": { ... }}      live parameter tuning
    {"type": "setSpeed", "speed": 10}             steps per second
    {"type": "setCountryIntervention", "iso": "ITA", "value": 0.6}  per-country lockdown
    {"type": "getHistory"}                        request the per-day totals series

Every simulated day is also persisted incrementally to ``backups/backup.ndjson``
(see :mod:`app.backup`); the server recovers from it on startup and exposes it as
a downloadable ``SavedState`` at ``GET /api/backup``.

Server -> client: {"type": "snapshot", ...Snapshot} (one frame of world state),
or {"type": "history", "points": [...], "frames": {...}} in reply to a
``getHistory`` request (the per-day totals series plus the columnar timeline).
"""

from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager
from pathlib import Path

from app import backup, config
from app.backup import BackupWriter
from app.models import CountryMeta, Params, Preset
from app.simulation import SimulationEngine
from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

DATA_DIR = Path(__file__).resolve().parent / "data"
GEOJSON_FILE = DATA_DIR / "world.geo.json"
PRESETS_FILE = DATA_DIR / "presets.json"
FLIGHTS_FILE = DATA_DIR / "flights.json"

BACKUP_FILE = Path(__file__).resolve().parent.parent / "backups" / "backup.ndjson"


class ConnectionManager:
    """Tracks active WebSocket clients and broadcasts snapshots to them."""

    def __init__(self) -> None:
        self.active: set[WebSocket] = set()

    async def connect(self, ws: WebSocket) -> None:
        """Accept the handshake and register the socket as active."""
        await ws.accept()
        self.active.add(ws)

    def disconnect(self, ws: WebSocket) -> None:
        """Remove a socket from the active set (no-op if already gone)."""
        self.active.discard(ws)

    async def broadcast_snapshot(self, engine: SimulationEngine) -> None:
        """Send the engine's current snapshot to every connected client.

        Sockets that raise while sending are dropped from the active set.
        """
        if not self.active:
            return
        payload = {"type": "snapshot", **engine.snapshot().model_dump()}
        dead = []
        for ws in list(self.active):
            try:
                await ws.send_json(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)


async def sim_loop(engine: SimulationEngine, manager: ConnectionManager) -> None:
    """Background task that drives auto-advance.

    While the engine is running and at least one client is connected, it steps
    the simulation and broadcasts a snapshot at ``engine.speed`` steps/second.
    Otherwise it idles. Runs for the lifetime of the application.
    """
    while True:
        if engine.running and manager.active:
            try:
                engine.step()
                await manager.broadcast_snapshot(engine)
            except asyncio.CancelledError:
                raise
            except Exception:
                await asyncio.sleep(0.5)
            else:
                await asyncio.sleep(1.0 / engine.speed)
        else:
            await asyncio.sleep(0.1)


async def _handle_command(
    msg: dict, engine: SimulationEngine, manager: ConnectionManager
) -> None:
    """Apply a single client command to the engine.

    Commands that change the world immediately (everything except ``play``)
    trigger a snapshot broadcast so clients see the effect at once; ``play``
    relies on :func:`sim_loop` to start streaming. Unknown commands are ignored.
    """
    cmd = msg.get("type")
    immediate = True

    if cmd == "play":
        engine.running = True
        immediate = False
    elif cmd == "pause":
        engine.running = False
    elif cmd == "reset":
        engine.reset()
    elif cmd == "step":
        engine.step()
    elif cmd == "seed":
        engine.seed(msg.get("iso", ""), float(msg.get("count", config.SEED_DEFAULT)))
    elif cmd == "setParams":
        merged = engine.params.model_dump()
        merged.update(msg.get("params", {}))
        engine.set_params(Params(**merged))
    elif cmd == "setSpeed":
        engine.set_speed(float(msg.get("speed", config.SPEED_DEFAULT)))
    elif cmd == "setCountryIntervention":
        engine.set_country_intervention(
            msg.get("iso", ""), float(msg.get("value", config.LOCKDOWN_DEFAULT))
        )
    else:
        return

    if immediate:
        await manager.broadcast_snapshot(engine)


engine: SimulationEngine | None = None
manager: ConnectionManager | None = None


def get_engine() -> SimulationEngine:
    """Return the shared engine (raises if accessed before startup)."""
    if engine is None:
        raise RuntimeError("Engine not initialised")
    return engine


def get_manager() -> ConnectionManager:
    """Return the shared connection manager (raises if accessed before startup)."""
    if manager is None:
        raise RuntimeError("Manager not initialised")
    return manager


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Create the shared singletons, recover any backup and run the sim loop.

    The previous run's incremental backup (if any) is read **before** the engine
    is built — constructing the engine truncates the backup to start a fresh
    segment — and then replayed via ``restore`` so a crashed/restarted server
    resumes the **whole** pre-crash timeline (a reconnecting client replays the
    entire chart and scrubber, not just the final day).
    """
    global engine, manager
    recovered = backup.load_saved_state(BACKUP_FILE)
    engine = SimulationEngine(backup=BackupWriter(BACKUP_FILE))
    if recovered is not None:
        engine.restore(recovered)
    manager = ConnectionManager()
    task = asyncio.create_task(sim_loop(engine, manager))
    try:
        yield
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


app = FastAPI(title="AlphaGen Epidemic Simulator", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health", tags=["meta"])
def health() -> dict:
    """Liveness probe used by the frontend and for smoke tests."""
    return {"status": "ok"}


@app.get("/api/config", tags=["meta"])
def get_config() -> JSONResponse:
    """Return the single config source (``config.json``).

    The frontend fetches this at startup and derives its parameter sliders,
    validation bounds, defaults, limits and save version from it — so those
    domain values live in exactly one place (no cross-language duplication).
    """
    return JSONResponse(config.public_config())


@app.get("/api/countries", response_model=list[CountryMeta], tags=["meta"])
def get_countries() -> list[CountryMeta]:
    """Return metadata (ISO, name, population, coordinates) for every country."""
    return get_engine().countries


@app.get("/api/geojson", tags=["meta"])
def get_geojson() -> JSONResponse:
    """Return the world country borders as GeoJSON for the Leaflet choropleth."""
    if not GEOJSON_FILE.exists():
        raise HTTPException(status_code=404, detail="World GeoJSON not found")
    return JSONResponse(json.loads(GEOJSON_FILE.read_text(encoding="utf-8")))


@app.get("/api/presets", response_model=list[Preset], tags=["presets"])
def get_presets() -> list[Preset]:
    """Return the list of predefined disease configurations."""
    raw = json.loads(PRESETS_FILE.read_text(encoding="utf-8"))
    return [Preset(**p) for p in raw]


@app.get("/api/flights", tags=["meta"])
def get_flights() -> JSONResponse:
    """Return the flight network (country-pair routes) used by the map arcs."""
    return JSONResponse(json.loads(FLIGHTS_FILE.read_text(encoding="utf-8")))


@app.get("/api/scenario", tags=["scenarios"])
async def export_scenario(name: str = Query("scenario")) -> dict:
    """Return the current full state as a JSON scenario.

    Declared ``async`` on purpose: it reads the live compartment arrays, so it
    must run on the event loop (atomically w.r.t. the simulation loop) rather
    than in the threadpool, where it could race with an in-flight step.
    """
    return get_engine().to_scenario(name)


@app.get("/api/backup", tags=["scenarios"])
async def get_backup() -> JSONResponse:
    """Return the incremental crash-recovery backup as a ``SavedState``.

    Same shape as the frontend ``exportState``, so the downloaded file loads
    straight from the UI's *Carica* button. 404 when no backup exists yet.
    """
    state = backup.load_saved_state(BACKUP_FILE)
    if state is None:
        raise HTTPException(status_code=404, detail="No backup available")
    return JSONResponse(state)


@app.post("/api/scenario", tags=["scenarios"])
async def import_scenario(data: dict) -> dict:
    """Restore the engine state from a scenario (single live frame).

    Deliberately does not broadcast: the client restores its own view (chart
    history, timeline buffer, displayed frame) locally, and a later play/step
    continues from the restored state. Declared ``async`` so the array writes
    in ``apply_scenario`` run on the event loop, atomically w.r.t. the sim loop.
    """
    eng = get_engine()
    eng.apply_scenario(data)
    return {"ok": True, "day": eng.day}


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket) -> None:
    """Real-time channel: streams snapshots and accepts control commands."""
    eng, mgr = get_engine(), get_manager()
    await mgr.connect(ws)
    await mgr.broadcast_snapshot(eng)
    try:
        while True:
            try:
                msg = await ws.receive_json()
            except WebSocketDisconnect:
                break
            except json.JSONDecodeError:
                continue
            except Exception:
                break
            if isinstance(msg, dict) and msg.get("type") == "getHistory":
                try:
                    await ws.send_json(
                        {
                            "type": "history",
                            "points": eng.history_points(),
                            "frames": eng.frames_payload(),
                        }
                    )
                except Exception:
                    pass
                continue
            try:
                await _handle_command(msg, eng, mgr)
            except Exception:
                pass
    finally:
        mgr.disconnect(ws)
