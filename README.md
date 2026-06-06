# 🦠 AlphaGen — Epidemic-spread simulator

An interactive platform for simulating the worldwide spread of viruses and
diseases. A **SEIRD+V** metapopulation model (one SEIR dynamic per country) runs
on the backend and is streamed to the interface in real time, where you can
**change parameters while the simulation is running** and immediately watch the
effect on a **world map** and on **time-series charts**.

![License](https://img.shields.io/badge/license-MIT-blue)
![Backend](https://img.shields.io/badge/backend-FastAPI-009688)
![Frontend](https://img.shields.io/badge/frontend-Angular%2021-dd0031)

![AlphaGen dashboard](docs/dashboard.png)

## Features

- **SEIRD+V epidemiological model** (Susceptible, Exposed, Infectious, Recovered,
  Deceased, Vaccinated) for 245 countries, using real population data.
- **Inter-country spread** via a real flight network (OpenFlights dataset) plus a
  baseline connectivity that guarantees global reachability.
- **Real-time control**: play/pause, manual stepping, adjustable speed and live
  editing of every parameter over WebSocket.
- **World map** (Leaflet, dark tiles): an intensity choropleth plus **animated
  flight arcs** when the contagion crosses a border.
- **Map state filters**: the worldwide-totals chips are clickable and select
  **which compartments** (S/E/I/R/D/V) make up the intensity shown on the map
  (default: Exposed + Infectious); the country tooltip reflects the active metric.
- **Country card**: click a country → live SEIRD+V detail, an active-cases
  **sparkline**, a **per-country lockdown** control and a "seed here" button.
- **Time-series charts** (ECharts) with gradient areas for Exposed, Infectious,
  Recovered, Deceased and Vaccinated.
- **Timeline / scrubber**: rewind and review the evolution day by day (the map,
  the curves and the country card all show the selected day).
- **Ready-to-use disease presets** (18, from COVID-19 to Ebola), fully editable.
- **Save/Load as a JSON file** — export the **complete state** (the entire
  timeline buffer: chart series, map replay, parameters, compartments and
  per-country lockdowns) and restore it exactly. No database.
- **Automatic incremental backup** — every simulated day is appended to an
  on-disk log (`backend/backups/`): if the server crashes, on restart it
  **resumes the whole** pre-crash timeline and a reconnecting client sees
  everything again. The backup is downloadable from `GET /api/backup` in the same
  `SavedState` format as the _Save_ feature, so it can be loaded back from the UI.

## Architecture

```
┌───────────────────────────────────────────────────────────────────────┐
│ Browser — Angular 21 · zoneless · signal-based                        │
│ WorldMap (Leaflet) · EpiChart (ECharts) · Leaderboard ·               │
│ WorldTotals · ControlPanel                                            │
│ SimulationService (WebSocket + signal state) · ConfigService (REST)   │
└────────┬───────────────────────────────────────────┬──────────────────┘
         │  WebSocket /ws                            │  REST /api
         │   commands ──▶                            │   ──▶ /config · /countries ·
         │   ◀── snapshot  (broadcast to clients)    │       /geojson · /flights · /presets
         │   ◀── history   (chart + scrubber)        │   ◀─▶ /scenario   ──▶ /backup
         ▼                                           ▼
┌────────┴───────────────────────────────────────────┴──────────────────┐
│ Backend — FastAPI / Uvicorn                                           │
│ ConnectionManager (N clients) · sim_loop (auto-advance, 1 step/day)   │
│                                                                       │
│ SEIRD+V engine — NumPy metapopulation, 245 countries + flight W       │
│        │ append one line per simulated day         ▲ restore on       │
│        ▼                                           │ startup          │
│ backups/backup.ndjson — incremental, append-only crash recovery       │
└────────┬──────────────────────────────────────────────────────────────┘
         ▲ datasets loaded once at startup
  data/  countries.json · world.geo.json · flights.json · presets.json
```

The backend holds a **single shared simulation** in memory, auto-advances it
(one step = one day) and **broadcasts** a snapshot to every connected client on
each step; a client that connects mid-run asks for `history` and rebuilds the
whole chart and the timeline scrubber. Every simulated day is also appended to an
on-disk log, so a crashed server **restores the entire pre-crash timeline** on
restart. The domain datasets (countries, borders, flight network, presets) are
loaded once at startup and served over REST. The client sends commands and
updates the interface reactively through signals.

## Tech stack

| Layer     | Technology                                                |
| --------- | --------------------------------------------------------- |
| Backend   | Python 3.13, FastAPI, Uvicorn, NumPy, managed with **uv** |
| Real-time | WebSocket                                                 |
| Frontend  | Angular 21 (standalone, zoneless, signal-based)           |
| Map       | Leaflet                                                   |
| Charts    | Apache ECharts                                            |

## Prerequisites

- [**uv**](https://docs.astral.sh/uv/) (automatically manages Python 3.13)
- **Node.js** 20+ and **npm**

## Quick start

You need two terminals.

### 1) Backend — port 8000

```bash
cd backend
uv run uvicorn app.main:app --reload --port 8000
```

`uv` creates the virtual environment and installs the dependencies on first run.
The required datasets (`countries.json`, `world.geo.json`, `flights.json`,
`presets.json`) are already bundled in the repository.

### 2) Frontend — port 4200

```bash
cd frontend
npm install
npm start
```

Open **http://localhost:4200**, pick a preset, **click a country** on the map to
open its card and press **🦠 Semina focolaio qui** (seed outbreak here), then
**▶ Play** and adjust the
sliders while the simulation runs. From the card you can also impose a
**lockdown** on a single country; with the **timeline** you can rewind and review
the epidemic.

## The simulation model

For each country _i_ the compartments S, E, I, R, D, V evolve with a daily update
(explicit Euler, `dt = 1 day`):

```
beta_eff  = (R₀ / infectious_days) · (1 − intervention)
open_i    = 1 − lockdown_i
sigma     = 1 / incubation_days
gamma     = 1 / infectious_days

prev_i    = open_i · I_i / N_i
lambda_i  = beta_eff · prev_i  +  mobility · open_i · Σ_j W[i,j] · prev_j
newE      = min(lambda_i · S_i, S_i)
newI      = min(sigma · E_i, E_i)
out       = min(gamma · I_i, I_i)
newD      = fatality_rate · out
newR      = out − newD
newV      = max(min(vaccination_rate · S_i, S_i − newE), 0)
```

where `W[i,j]` is the travel weight (flight network) from country _j_ to country
_i_ (the term with `W` is the infectious pressure imported from abroad) and
`lockdown_i` is the **per-country** intervention, which dampens both local
transmission and that country's import and export. The `min`/`max` guards keep
every transition within the population available in its source compartment, so no
compartment goes negative and the model conserves population.

## Interactive parameters

All parameters can be changed **while** the simulation is running.

| Parameter               | Effect                                                           |
| ----------------------- | ---------------------------------------------------------------- |
| **R₀**                  | Base transmissibility (β = R₀ / infectious days)                 |
| **Intervention**        | Contact reduction (lockdown/distancing): lowers β                |
| **Vaccination / day**   | Fraction of susceptibles vaccinated each day                     |
| **Fatality rate**       | Fraction of infectious individuals who die instead of recovering |
| **Incubation**          | Duration of the Exposed phase (E → I), in days                   |
| **Infectious duration** | Duration of the Infectious phase (I → R/D), in days              |
| **Global mobility**     | Multiplier on the exchange between countries                     |

## API

Base URL: `http://localhost:8000`

### REST

| Method | Path                  | Description                                     |
| ------ | --------------------- | ----------------------------------------------- |
| `GET`  | `/api/health`         | Healthcheck                                     |
| `GET`  | `/api/config`         | Single config source (defaults/bounds/limits)   |
| `GET`  | `/api/countries`      | Country metadata (ISO, population, coordinates) |
| `GET`  | `/api/geojson`        | World borders (GeoJSON) for the map             |
| `GET`  | `/api/flights`        | Flight network (country pairs) for the arcs     |
| `GET`  | `/api/presets`        | Disease presets                                 |
| `GET`  | `/api/scenario?name=` | Current full live state as a scenario           |
| `POST` | `/api/scenario`       | Sync the engine to a scenario (no broadcast)    |
| `GET`  | `/api/backup`         | Crash backup as a downloadable `SavedState`     |

### WebSocket `/ws`

**Client → server** (commands):

```jsonc
{ "type": "play" }
{ "type": "pause" }
{ "type": "reset" }
{ "type": "step" }
{ "type": "seed", "iso": "USA", "count": 100 }
{ "type": "setParams", "params": { } }
{ "type": "setSpeed", "speed": 10 }
{ "type": "setCountryIntervention", "iso": "ITA", "value": 0.6 }
{ "type": "getHistory" }
```

**Server → client** (on every step):

```jsonc
{
	"type": "snapshot",
	"day": 42,
	"running": true,
	"speed": 10,
	"params": {},
	"totals": { "s": 0, "e": 0, "i": 0, "r": 0, "d": 0, "v": 0 },
	"countries": [
		{
			"iso": "ITA",
			"name": "Italy",
			"population": 0,
			"s": 0,
			"e": 0,
			"i": 0,
			"r": 0,
			"d": 0,
			"v": 0,
			"intervention": 0,
		},
	],
}
```

In reply to **`getHistory`** (which the client sends on connect) the server
returns both the per-day totals time series (`points`, for the chart) and the
**full timeline** in a compact columnar form (`frames`: country metadata once +
the compartments per day). This lets a client that connects to an
already-running simulation rebuild the entire chart **and** scrub the timeline
back to day 0 (the state is shared and persistent):

```jsonc
{
	"type": "history",
	"points": [
		{
			"day": 0,
			"totals": { "s": 0, "e": 0, "i": 0, "r": 0, "d": 0, "v": 0 },
		},
	],
	"frames": {
		"iso": ["USA", "..."],
		"name": ["United States", "..."],
		"population": [0, 0],
		"frame": [
			{
				"day": 0,
				"speed": 5,
				"params": {},
				"s": [0],
				"e": [0],
				"i": [0],
				"r": [0],
				"d": [0],
				"v": [0],
				"c": [0],
			},
		],
	},
}
```

## Configuration

All domain and behaviour values (parameter defaults and bounds, limits, the
save-format version, speed, outbreak size, per-country lockdown bounds, map
defaults, port and CORS origins) live in **a single source**:
`backend/app/config.json` (see
`backend/app/config.py`). They are never hardcoded in the individual modules: the
Pydantic model derives its defaults and bounds from it, the engine reads its
limits and clamps from it, and the frontend downloads them at runtime from
`GET /api/config` to build sliders, validation and defaults — so no value is
duplicated between backend and frontend.

- **Parameters / limits / version / speed / seed / per-country lockdown / CORS**:
  edit them in `backend/app/config.json`; they propagate automatically to backend
  and frontend.
- **Frontend-only settings** (which cannot be derived from the backend): the
  URLs the frontend connects to (`API_BASE` / `WS_URL`) plus a few client-side
  timing and presentation tunables (reconnect/retry delays, config-fetch retries,
  sparkline resolution) live in `frontend/src/app/config.ts`; the backend port and
  CORS origins are in `config.json` (`server.port`, `server.corsOrigins`). For a
  non-dev deployment, update both.

## Data

All datasets are bundled and versioned under `backend/app/data/`:
`countries.json` (population and coordinates), `world.geo.json` (borders for the
map), `flights.json` (the inter-country flight network) and `presets.json`
(diseases).

### Automatic backup and recovery

State lives in memory (no database), but to avoid losing a simulation on a crash
the backend writes an **incremental log** to `backend/backups/backup.ndjson`
(Git-ignored): one header line with the country metadata, then **one line per
simulated day** (append-only, constant cost). On restart the server reads the log
and **restores the whole** pre-crash timeline via `restore`, so a reconnecting
client sees the complete chart and scrubber again. The same log can be rebuilt
into the two standard importable formats: `SavedState` (downloadable from
`GET /api/backup`, loadable from the UI) and `Scenario` (the last day, for
`POST /api/scenario`). Reconstruction is _last-writer-wins_ per day and is capped
to the most recent `DATA_LIMIT` days, matching the app's retention.

### Country order and coverage

The model's 245 countries are sorted by descending population: **this order is
the index of the model's arrays**. The map colours a country by matching the
ISO-3 `id` of the GeoJSON feature to the country code; **235/245** countries have
a border. The 10 missing ones (French overseas departments, merged into France by
the dataset, plus a few small islands) are not coloured but are still simulated,
thanks to the baseline coupling (`baseline_epsilon`).

## Data sources

- Country population and coordinates: [REST Countries](https://restcountries.com/).
- Country borders (GeoJSON): [Natural Earth 1:10m Admin 0 – Countries](https://www.naturalearthdata.com/)
  ([`nvkelso/natural-earth-vector`](https://github.com/nvkelso/natural-earth-vector)).
  Each feature has its `id` remapped to ISO-3, its properties reduced to just
  `name` and its geometries simplified (Douglas-Peucker + rounding) to keep the
  file small while preserving micro-states.
- Inter-country flight network: [OpenFlights](https://openflights.org/data.html).
  The weight of each country pair is the (normalised) number of air routes
  between them, used as a real connectivity proxy; the ISO mapping uses REST
  Countries.

## Tests

### Backend (pytest)

```bash
cd backend
uv run pytest
uv run pytest -m unit
uv run pytest -m integration
```

Markers: `unit` (in-process model/validation), `data` (dataset integrity) and
`integration` (against a real running uvicorn instance).

### Frontend (Playwright)

```bash
cd frontend
npx playwright install chromium
npm run e2e
```

The Playwright config starts (or reuses) both the backend on port 8000 and the
frontend on port 4200 automatically.

## License

Released under the **MIT** license. See the [`LICENSE`](LICENSE) file.
