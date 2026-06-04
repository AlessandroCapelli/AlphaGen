# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

AlphaGen is an interactive epidemic-spread simulator: a SEIRD+V metapopulation model
(one SEIR per country) runs on a FastAPI backend and is streamed live over a WebSocket
to an Angular 21 dashboard (Leaflet map + ECharts). The `README.md` documents the
domain model, the math, the API and the data sources in depth — read it for those.
This file covers commands and the cross-file architecture.

## Commands

Two processes, run from their own directories. There is no root-level orchestrator.

**Backend** (`backend/`, Python 3.13, managed with [uv](https://docs.astral.sh/uv/)):

```bash
uv run uvicorn app.main:app --reload --port 8000   # dev server (creates venv on first run)
uv run pytest                                       # full test suite
uv run pytest -m unit                               # fast in-process tests only (no server)
uv run pytest -m integration                        # tests against a real spawned instance
```

**Frontend** (`frontend/`, Node 20+):

```bash
npm install
npm start          # ng serve on http://localhost:4200
npm run build      # production build (also the only TypeScript typecheck — there is no separate lint)
npm run e2e        # Playwright E2E (one-time setup: npx playwright install chromium)
```

There is **no configured linter** for either side; the frontend's only static gate is
`npm run build` (TS strict typecheck). Prettier config lives in `frontend/package.json`
(`printWidth: 100`, `singleQuote`) but is not wired to a script.

### Tests

Real-instance approach — nothing is tested in-process against a fake server.

- **Backend** (`backend/app/test.py`): a single self-contained module. It holds the
  fixtures (a session-scoped `server` fixture spawns a real `uvicorn` subprocess on a
  free port), the WebSocket helper, the snapshot invariants and every test, grouped in
  classes by marker — `unit` (in-process model/validation/long-run/fuzz),
  `data` (datasets), `integration` (REST + WebSocket against the spawned server). There
  is no `conftest.py`, so the file inserts `backend/` on `sys.path` itself before
  importing `app`. The `_reset_engine` autouse fixture resets the shared engine only for
  integration tests.
- **Frontend** (`frontend/e2e/app.spec.ts`): Playwright + Chromium against a real
  backend (port 8000) and real frontend (port 4200), both started or reused via
  `playwright.config.ts` `webServer`. Tests drive the backend through a control
  WebSocket and assert the live UI. The Leaflet map uses `preferCanvas`, so country
  cards are opened by clicking the canvas; only the animated flight arcs are left to
  manual verification.

## Architecture

### Backend — one shared, in-memory simulation

The entire server state is a **single `SimulationEngine` instance** plus one
`ConnectionManager`, both created in the FastAPI `lifespan` and shared across all clients
(`backend/app/main.py`). There is **no database** — resetting the process loses all state.

- `app/simulation.py` is the model layer: `load_countries` / `build_coupling` read the
  static datasets and build the `(n, n)` inter-country travel matrix `W`; `SeirModel` holds
  the compartments as NumPy arrays and advances one day per `step()` (vectorised forward
  Euler); `SimulationEngine` wraps the model with day counter, params, speed, seeding and
  scenario (de)serialisation.
- `sim_loop` is a background `asyncio` task that, while `engine.running` **and** at least
  one client is connected, steps the engine and broadcasts a snapshot at `engine.speed`
  steps/second. Pausing or zero clients makes it idle.
- `_handle_command` maps each WebSocket command to an engine call. Every command except
  `play` broadcasts immediately so the effect is visible at once; `play` just flips a flag
  and lets `sim_loop` stream.
- The two `/api/scenario` endpoints are deliberately `async` (not threadpool) so their
  reads/writes of the live compartment arrays run on the event loop, atomically w.r.t. an
  in-flight `step()`.

### Frontend — signals, zoneless, one service as source of truth

The whole app is **four files** under `frontend/src/`:

- `main.ts` — root `App` component + bootstrap; opens the WebSocket once on init.
- `app/components.ts` — three standalone components: `WorldMap` (Leaflet choropleth +
  animated flight arcs), `EpiChart` (ECharts curves), `ControlPanel` (sliders, presets,
  country card, timeline, save/load).
- `app/simulation.service.ts` — `SimulationService`, the **single source of truth**. Owns
  the WebSocket, the latest snapshot, and all derived signal state.
- `app/models.ts` — TypeScript wire types.

The app is **zoneless and signal-based** (no Zone.js, no `BehaviorSubject` for state). Key
state-design decisions in `SimulationService`:

- **Two buffers, different purposes.** `history` (cap `HISTORY_LIMIT = 10_000`) is the
  totals time series for the chart; `frames` (ring buffer, cap `FRAME_LIMIT = 600`) holds
  full per-country snapshots for the timeline scrubber. When the ring buffer overflows,
  `viewIndex` is shifted to keep pointing at the same frame.
- **Local params are intentionally separate from the snapshot stream** (`params` signal vs
  `snapshot` signal) so sliders stay responsive and are never overwritten by incoming
  frames. `displayed()` resolves the scrubbed frame or the live latest.
- **Save/load exports the entire frame buffer** (`SavedState`, `version: 3`); chart history
  and the displayed frame are re-derived from it on import. Import then POSTs the _last_
  frame to `/api/scenario` so a subsequent play/step continues from the restored state.
- The socket **auto-reconnects** (1.5 s) after a backend reload.

### The wire contract is duplicated and must stay in sync

`backend/app/models.py` (Pydantic) and `frontend/src/app/models.ts` (TS) define the **same**
WebSocket/REST schemas independently. Any change to a snapshot/params/scenario field must be
mirrored in both, and `_handle_command` (backend) ↔ the command senders in
`SimulationService` (frontend) must agree on the `type` strings.

### Data

All datasets are bundled and versioned in `backend/app/data/`: `countries.json`
(population + coordinates, ordered by descending population — this order _is_ the model's
array index order), `world.geo.json` (borders), `flights.json` (`routes` with weights +
`base_coupling`/`baseline_epsilon` knobs for `build_coupling`), `presets.json` (diseases).

## Conventions

- Backend code, docstrings and comments are in **English**. The README and user-facing UI
  strings are in **Italian**.
- CORS allows only `localhost:4200` / `127.0.0.1:4200`; the backend base URL is hardcoded in
  `frontend/src/app/simulation.service.ts` (`API_BASE` / `WS_URL`). Update both for any
  non-dev deployment.
