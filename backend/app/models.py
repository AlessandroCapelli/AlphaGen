"""Pydantic schemas shared by the REST endpoints and the WebSocket protocol.

These models define the wire format between the FastAPI backend and the Angular
frontend. They are intentionally flat and JSON-friendly.
"""

from __future__ import annotations

from app.config import PARAMS as _PARAM_SPECS
from pydantic import BaseModel, Field, create_model

_param_fields = {
    spec["key"]: (
        float,
        Field(
            float(spec["default"]),
            ge=float(spec["min"]),
            le=float(spec["max"]),
            description=spec.get("description", ""),
        ),
    )
    for spec in _PARAM_SPECS
}

Params: type[BaseModel] = create_model("Params", **_param_fields)


class CountrySnapshot(BaseModel):
    """Compartment counts for a single country at one simulation step."""

    iso: str = Field(description="ISO 3166-1 alpha-3 country code")
    name: str = Field(description="Human-readable country name")
    population: float = Field(description="Total population (N) of the country")
    s: float = Field(description="Susceptible count")
    e: float = Field(description="Exposed count (infected, not yet infectious)")
    i: float = Field(description="Infectious count")
    r: float = Field(description="Recovered (immune) count")
    d: float = Field(description="Deceased count")
    v: float = Field(description="Vaccinated (immune) count")
    intervention: float = Field(
        0.0, description="Per-country intervention level in [0, 1]"
    )


class Totals(BaseModel):
    """Worldwide compartment totals, summed across all countries."""

    s: float = Field(description="Total susceptible")
    e: float = Field(description="Total exposed")
    i: float = Field(description="Total infectious")
    r: float = Field(description="Total recovered")
    d: float = Field(description="Total deceased")
    v: float = Field(description="Total vaccinated")


class Snapshot(BaseModel):
    """A single simulation frame streamed to the client on every step."""

    day: int = Field(description="Elapsed simulated days since the last reset")
    running: bool = Field(
        description="Whether the simulation is currently auto-advancing"
    )
    speed: float = Field(description="Auto-advance speed in steps (days) per second")
    params: Params = Field(description="Parameters in effect for this frame")
    totals: Totals = Field(description="Worldwide compartment totals")
    countries: list[CountrySnapshot] = Field(
        description="Per-country compartment counts"
    )


class CountryMeta(BaseModel):
    """Static metadata for a country, loaded once at startup."""

    iso: str = Field(description="ISO 3166-1 alpha-3 country code")
    name: str = Field(description="Human-readable country name")
    population: float = Field(description="Total population used as the SEIR pool size")
    lat: float = Field(description="Representative latitude (degrees)")
    lon: float = Field(description="Representative longitude (degrees)")


class Preset(BaseModel):
    """A named, ready-to-use disease configuration."""

    id: str = Field(description="Stable identifier (e.g. 'covid')")
    name: str = Field(description="Display name")
    description: str = Field(description="Short human-readable description")
    params: Params = Field(
        description="Parameter values applied when the preset is selected"
    )
