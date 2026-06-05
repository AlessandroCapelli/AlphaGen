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

# -- save / replay -----------------------------------------------------
#: Single supported import/export format version (no backward compatibility).
SAVE_VERSION: int = int(_CFG["saveVersion"])
#: Retention cap shared by the chart history, the timeline frames and the backup.
DATA_LIMIT: int = int(_CFG["dataLimit"])

# -- seeding -----------------------------------------------------------
SEED_DEFAULT: float = float(_CFG["seed"]["default"])
SEED_MIN: float = float(_CFG["seed"]["min"])

# -- auto-advance speed ------------------------------------------------
SPEED_DEFAULT: float = float(_CFG["speed"]["default"])
SPEED_MIN: float = float(_CFG["speed"]["min"])
SPEED_MAX: float = float(_CFG["speed"]["max"])

# -- per-country lockdown ----------------------------------------------
LOCKDOWN_MIN: float = float(_CFG["lockdown"]["min"])
LOCKDOWN_MAX: float = float(_CFG["lockdown"]["max"])

# -- epidemiological parameters (defaults + bounds) --------------------
#: List of ``{key, default, min, max, step, percent, description}`` dicts, in
#: canonical order; drives both the Pydantic model and the frontend sliders.
PARAMS: list[dict] = list(_CFG["params"])

# -- map heat metric ---------------------------------------------------
MAP_DEFAULT_STATES: dict = dict(_CFG["mapDefaultStates"])

# -- server ------------------------------------------------------------
CORS_ORIGINS: list[str] = list(_CFG["server"]["corsOrigins"])
PORT: int = int(_CFG["server"]["port"])


def public_config() -> dict:
    """The full config payload served at ``GET /api/config`` (frontend source)."""
    return _CFG
