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
from app.models import CountryMeta, CountrySnapshot, Params, Snapshot, Totals

DATA_DIR = Path(__file__).parent / "data"
COUNTRIES_FILE = DATA_DIR / "countries.json"
FLIGHTS_FILE = DATA_DIR / "flights.json"


# -- data loading ------------------------------------------------------
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
    base = float(spec.get("base_coupling", 0.03))
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


# -- numerical model ---------------------------------------------------
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

    Daily forward-Euler update (dt = 1 day):
        beta_eff = (r0 / infectious_days) * (1 - intervention)
        sigma    = 1 / incubation_days
        gamma    = 1 / infectious_days
        lambda_i = beta_eff * I_i / N_i
                 + mobility * sum_j W[i, j] * I_j / N_j   # imported pressure
        newE = lambda_i * S_i
        newI = sigma * E_i
        out  = gamma * I_i                # individuals leaving I this step
        newD = fatality_rate * out
        newR = (1 - fatality_rate) * out
        newV = vaccination_rate * S_i

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

        self.S = self.N.copy()
        self.E = np.zeros(self.n)
        self.I = np.zeros(self.n)
        self.R = np.zeros(self.n)
        self.D = np.zeros(self.n)
        self.V = np.zeros(self.n)
        self.C = np.zeros(self.n)

    def reset(self) -> None:
        """Return everyone to the susceptible compartment (S = N, rest = 0)."""
        self.S = self.N.copy()
        self.E[:] = 0
        self.I[:] = 0
        self.R[:] = 0
        self.D[:] = 0
        self.V[:] = 0
        self.C[:] = 0

    def seed(self, idx: int, count: float) -> None:
        """Introduce an initial outbreak.

        Moves ``count`` people (capped at the available susceptibles) from S to
        I in the country at position ``idx``.

        Args:
            idx: Index of the country in the population/compartment arrays.
            count: Number of individuals to move into the infectious compartment.
        """
        count = min(count, self.S[idx])
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

        # Active infectious prevalence per country (guard against empty pop).
        safe_N = np.where(self.N > 0, self.N, 1.0)
        prevalence = self.I / safe_N

        # Per-country intervention dampens both local spread and travel: a
        # locked-down country transmits/exports less, and imports less.
        open_frac = 1.0 - self.C
        eff_prev = prevalence * open_frac
        local_force = beta_eff * eff_prev
        imported_force = p.mobility * open_frac * (self.W @ eff_prev)
        lam = local_force + imported_force

        # Cap every transition to the people actually available in the source
        # compartment. This keeps the model conservative (no negative
        # compartments, no double-counting into R/D) even when a rate exceeds 1,
        # e.g. with very short incubation/infectious periods set via the API.
        new_e = np.minimum(lam * self.S, self.S)
        new_i = np.minimum(sigma * self.E, self.E)
        leaving_i = np.minimum(gamma * self.I, self.I)
        new_d = p.fatality_rate * leaving_i
        new_r = leaving_i - new_d
        # Vaccinate susceptibles, but never more than remain after new exposures.
        new_v = np.minimum(p.vaccination_rate * self.S, self.S - new_e)
        new_v = np.maximum(new_v, 0.0)

        self.S += -new_e - new_v
        self.E += new_e - new_i
        self.I += new_i - leaving_i
        self.R += new_r
        self.D += new_d
        self.V += new_v

        # Clamp the flow compartments against tiny negative rounding errors.
        np.clip(self.S, 0.0, None, out=self.S)
        np.clip(self.E, 0.0, None, out=self.E)
        np.clip(self.I, 0.0, None, out=self.I)


# -- stateful runner ---------------------------------------------------
class SimulationEngine:
    """Owns the model state and exposes high-level control + serialisation."""

    def __init__(self) -> None:
        """Load country data, build the coupling matrix and the SEIR model."""
        self.countries = load_countries()
        self.index = {c.iso: i for i, c in enumerate(self.countries)}
        populations = np.array([c.population for c in self.countries], dtype=float)
        coupling = build_coupling(self.countries)
        self.model = SeirModel(populations, coupling)

        self.params = Params()
        self.day = 0
        self.running = False
        self.speed = 5.0  # simulation steps per second when running

    # -- control ---------------------------------------------------------
    def reset(self) -> None:
        """Clear all compartments and the day counter (everyone susceptible)."""
        self.model.reset()
        self.day = 0
        self.running = False

    def seed(self, iso: str, count: float = 100.0) -> None:
        """Start an outbreak of ``count`` infectious people in country ``iso``.

        Unknown ISO codes are ignored.

        Args:
            iso: ISO 3166-1 alpha-3 country code.
            count: Number of initial infectious individuals.
        """
        idx = self.index.get(iso)
        if idx is not None:
            self.model.seed(idx, count)

    def set_country_intervention(self, iso: str, value: float) -> None:
        """Set the intervention level (0..1) for a single country.

        Unknown ISO codes are ignored.

        Args:
            iso: ISO 3166-1 alpha-3 country code.
            value: Lockdown/border-closure strength, clamped to [0, 1].
        """
        idx = self.index.get(iso)
        if idx is not None:
            self.model.C[idx] = max(0.0, min(1.0, value))

    # -- scenario save/restore (full live state) ------------------------
    def to_scenario(self, name: str = "scenario") -> dict:
        """Serialise the full live state so it can be restored exactly.

        Captures the day, parameters, speed and the compartment counts of every
        affected country. Fully-susceptible countries are omitted (they are
        rebuilt as S = N on restore), keeping the payload small.

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
            if (m.E[i] + m.I[i] + m.R[i] + m.D[i] + m.V[i]) > 0.5 or m.C[i] > 0
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
        self.set_speed(float(data.get("speed", 5.0)))
        self.day = int(data.get("day", 0))
        m = self.model
        for rec in data.get("countries", []):
            idx = self.index.get(rec.get("iso", ""))
            if idx is None:
                continue
            m.S[idx] = float(rec.get("s", m.N[idx]))
            m.E[idx] = float(rec.get("e", 0.0))
            m.I[idx] = float(rec.get("i", 0.0))
            m.R[idx] = float(rec.get("r", 0.0))
            m.D[idx] = float(rec.get("d", 0.0))
            m.V[idx] = float(rec.get("v", 0.0))
            m.C[idx] = max(0.0, min(1.0, float(rec.get("intervention", 0.0))))

    def set_params(self, params: Params) -> None:
        """Replace the active parameters (applied on the next step)."""
        self.params = params

    def set_speed(self, speed: float) -> None:
        """Set the auto-advance speed in steps/second, clamped to [0.1, 60]."""
        self.speed = max(0.1, min(60.0, speed))

    def step(self) -> None:
        """Advance the model by one day and increment the day counter."""
        self.model.step(self.params)
        self.day += 1

    # -- output ----------------------------------------------------------
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
        totals = Totals(
            s=float(m.S.sum()),
            e=float(m.E.sum()),
            i=float(m.I.sum()),
            r=float(m.R.sum()),
            d=float(m.D.sum()),
            v=float(m.V.sum()),
        )
        return Snapshot(
            day=self.day,
            running=self.running,
            speed=self.speed,
            params=self.params,
            totals=totals,
            countries=countries,
        )
