/**
 * Shared types mirroring the backend wire format
 * (see `backend/app/models.py`).
 */

/** Epidemiological parameters; all tunable live during the simulation. */
export interface Params {
  /** Basic reproduction number (R0). */
  r0: number;
  /** Mean latency of the Exposed phase (E -> I), in days. */
  incubation_days: number;
  /** Mean duration of the Infectious phase (I -> R/D), in days. */
  infectious_days: number;
  /** Fraction of infectious individuals who die instead of recovering. */
  fatality_rate: number;
  /** Daily fraction of susceptibles moved to the Vaccinated compartment. */
  vaccination_rate: number;
  /** Contact reduction (lockdown/distancing) that lowers the effective beta. */
  intervention: number;
  /** Global multiplier applied to inter-country travel coupling. */
  mobility: number;
}

/** Worldwide compartment totals, summed across all countries. */
export interface Totals {
  /** Susceptible. */
  s: number;
  /** Exposed. */
  e: number;
  /** Infectious. */
  i: number;
  /** Recovered. */
  r: number;
  /** Deceased. */
  d: number;
  /** Vaccinated. */
  v: number;
}

/** Compartment counts for a single country at one simulation step. */
export interface CountrySnapshot {
  /** ISO 3166-1 alpha-3 country code. */
  iso: string;
  /** Human-readable country name. */
  name: string;
  /** Total population (N). */
  population: number;
  /** Susceptible count. */
  s: number;
  /** Exposed count. */
  e: number;
  /** Infectious count. */
  i: number;
  /** Recovered count. */
  r: number;
  /** Deceased count. */
  d: number;
  /** Vaccinated count. */
  v: number;
}

/** A single simulation frame received over the WebSocket. */
export interface Snapshot {
  /** Message discriminator; always `"snapshot"` for state frames. */
  type?: string;
  /** Elapsed simulated days since the last reset. */
  day: number;
  /** Whether the simulation is currently auto-advancing. */
  running: boolean;
  /** Auto-advance speed in steps (days) per second. */
  speed: number;
  /** Parameters in effect for this frame. */
  params: Params;
  /** Worldwide compartment totals. */
  totals: Totals;
  /** Per-country compartment counts. */
  countries: CountrySnapshot[];
}

/** A named, ready-to-use disease configuration. */
export interface Preset {
  /** Stable identifier (e.g. `"covid"`). */
  id: string;
  /** Display name. */
  name: string;
  /** Short human-readable description. */
  description: string;
  /** Parameter values applied when the preset is selected. */
  params: Params;
}

/** Static metadata for a country. */
export interface CountryMeta {
  /** ISO 3166-1 alpha-3 country code. */
  iso: string;
  /** Human-readable country name. */
  name: string;
  /** Total population. */
  population: number;
  /** Representative latitude (degrees). */
  lat: number;
  /** Representative longitude (degrees). */
  lon: number;
}

/** One point in the time series fed to the chart. */
export interface HistoryPoint {
  /** Simulated day. */
  day: number;
  /** Worldwide totals at that day. */
  totals: Totals;
}

/** A saved scenario: enough state to reproduce a run from day 0. */
export interface Scenario {
  /** Scenario label. */
  name: string;
  /** Parameters to restore. */
  params: Params;
  /** Auto-advance speed to restore. */
  speed: number;
  /** Initial outbreaks to replay (country + count). */
  seeds: { iso: string; count: number }[];
}
