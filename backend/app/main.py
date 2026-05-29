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

Client -> server WebSocket commands (JSON):
    {"type": "play"}                              # start auto-advancing
    {"type": "pause"}                             # stop auto-advancing
    {"type": "reset"}                             # back to day 0, empty world
    {"type": "step"}                              # advance exactly one day
    {"type": "seed", "iso": "USA", "count": 100}  # start an outbreak
    {"type": "setParams", "params": { ... }}      # live parameter tuning
    {"type": "setSpeed", "speed": 10}             # steps per second

Server -> client: {"type": "snapshot", ...Snapshot} (one frame of world state).
"""

from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager
from pathlib import Path

from app.models import CountryMeta, Params, Preset
from app.simulation import SimulationEngine
from fastapi import FastAPI, HTTPException, Query, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

DATA_DIR = Path(__file__).resolve().parent / "data"
GEOJSON_FILE = DATA_DIR / "world.geo.json"
PRESETS_FILE = DATA_DIR / "presets.json"


# ============================================================
# Real-time layer
# ============================================================
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
        for ws in self.active:
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
            engine.step()
            await manager.broadcast_snapshot(engine)
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
        engine.seed(msg.get("iso", ""), float(msg.get("count", 100)))
    elif cmd == "setParams":
        engine.set_params(Params(**msg.get("params", {})))
    elif cmd == "setSpeed":
        engine.set_speed(float(msg.get("speed", 5)))
    else:
        return

    if immediate:
        await manager.broadcast_snapshot(engine)


# ============================================================
# Shared singletons (created in the lifespan)
# ============================================================
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
    """Create the shared singletons and run the background simulation loop."""
    global engine, manager
    engine = SimulationEngine()
    manager = ConnectionManager()
    task = asyncio.create_task(sim_loop(engine, manager))
    try:
        yield
    finally:
        task.cancel()


# ============================================================
# Application
# ============================================================
app = FastAPI(title="AlphaGen Epidemic Simulator", lifespan=lifespan)

# Allow the Angular dev server to call the API and open the WebSocket.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:4200", "http://127.0.0.1:4200"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# -- REST --------------------------------------------------------------
@app.get("/api/health", tags=["meta"])
def health() -> dict:
    """Liveness probe used by the frontend and for smoke tests."""
    return {"status": "ok"}


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


@app.get("/api/scenario", tags=["scenarios"])
def export_scenario(name: str = Query("scenario")) -> dict:
    """Return the current setup (params + speed + seeds) as a JSON scenario."""
    return get_engine().to_scenario(name)


@app.post("/api/scenario", tags=["scenarios"])
async def import_scenario(data: dict) -> dict:
    """Load a scenario and broadcast the resulting state to all clients."""
    eng = get_engine()
    eng.apply_scenario(data)
    await get_manager().broadcast_snapshot(eng)
    return {"ok": True, "day": eng.day}


# -- real-time stream --------------------------------------------------
@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket) -> None:
    """Real-time channel: streams snapshots and accepts control commands."""
    eng, mgr = get_engine(), get_manager()
    await mgr.connect(ws)
    await mgr.broadcast_snapshot(eng)
    try:
        while True:
            msg = await ws.receive_json()
            await _handle_command(msg, eng, mgr)
    except Exception:
        mgr.disconnect(ws)
