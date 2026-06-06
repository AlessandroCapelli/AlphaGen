"""Single source of truth for all tunable domain/behaviour configuration.

Every parameter default, validation bound, limit, version, speed/seed setting and
map default lives in ``config.json`` — never hardcoded in the individual modules.
This module loads it once and exposes typed accessors; :func:`public_config`
is served verbatim at ``GET /api/config`` so the frontend derives its sliders,
validation and defaults from the *same* values (no cross-language duplication).

Anything that needs a value (``models.Params`` bounds, ``simulation`` limits and
speed clamp, ``backup`` save version, ``main`` CORS) imports it from here.
"""

from __future__ import annotations

import json
from pathlib import Path

CONFIG_FILE = Path(__file__).parent / "config.json"

_CFG: dict = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))

# Single supported import/export format version (no backward compatibility).
SAVE_VERSION: int = int(_CFG["saveVersion"])
# Retention cap shared by the chart history, the timeline frames and the backup.
DATA_LIMIT: int = int(_CFG["dataLimit"])

# Default number of individuals introduced into a country when seeding.
SEED_DEFAULT: float = float(_CFG["seed"]["default"])
# Minimum seed count accepted from the client.
SEED_MIN: float = float(_CFG["seed"]["min"])

SPEED_DEFAULT: float = float(_CFG["speed"]["default"])
# Lower clamp applied to any requested speed.
SPEED_MIN: float = float(_CFG["speed"]["min"])
# Upper clamp applied to any requested speed.
SPEED_MAX: float = float(_CFG["speed"]["max"])

# Default per-country intervention/lockdown level when a command omits it.
LOCKDOWN_DEFAULT: float = float(_CFG["lockdown"]["default"])
# Lower clamp for a per-country intervention/lockdown level.
LOCKDOWN_MIN: float = float(_CFG["lockdown"]["min"])
# Upper clamp for a per-country intervention/lockdown level.
LOCKDOWN_MAX: float = float(_CFG["lockdown"]["max"])

# List of ``{key, default, min, max, step, percent, description}`` dicts, in
# canonical order; drives both the Pydantic model and the frontend sliders.
PARAMS: list[dict] = list(_CFG["params"])

# Per-compartment flags marking which states the map highlights by default.
MAP_DEFAULT_STATES: dict = dict(_CFG["mapDefaultStates"])

# Origins allowed by the CORS middleware.
CORS_ORIGINS: list[str] = list(_CFG["server"]["corsOrigins"])
# TCP port the API server binds to.
PORT: int = int(_CFG["server"]["port"])


def public_config() -> dict:
    """Return the full config payload served at ``GET /api/config``.

    The frontend derives its sliders, validation bounds and defaults from this
    same object, so backend and client never duplicate domain values.
    """
    return _CFG
