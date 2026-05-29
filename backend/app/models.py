"""Pydantic schemas shared by the REST endpoints and the WebSocket protocol.

These models define the wire format between the FastAPI backend and the Angular
frontend. They are intentionally flat and JSON-friendly.
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class Params(BaseModel):
    """Epidemiological parameters of the model.

    Every field can be changed live while the simulation is running; the engine
    picks up the new values on the next daily step.
    """

    r0: float = Field(2.5, ge=0, le=20, description="Basic reproduction number (R0)")
    incubation_days: float = Field(
        5.0,
        ge=0.1,
        le=30,
        description="Mean latency of the Exposed phase (E->I), in days",
    )
    infectious_days: float = Field(
        7.0,
        ge=0.1,
        le=60,
        description="Mean duration of the Infectious phase (I->R/D), in days",
    )
    fatality_rate: float = Field(
        0.01,
        ge=0,
        le=1,
        description="Fraction of infectious individuals who die instead of recovering",
    )
    vaccination_rate: float = Field(
        0.0,
        ge=0,
        le=0.2,
        description="Daily fraction of susceptibles moved to the Vaccinated compartment",
    )
    intervention: float = Field(
        0.0,
        ge=0,
        le=1,
        description="Contact reduction (lockdown/distancing) that lowers the effective beta",
    )
    mobility: float = Field(
        1.0,
        ge=0,
        le=5,
        description="Global multiplier applied to inter-country travel coupling",
    )


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
