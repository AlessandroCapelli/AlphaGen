import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { CountryMeta, HistoryPoint, Params, Preset, Scenario, Snapshot } from './models';

/** Base URL of the backend REST API. */
const API_BASE = 'http://localhost:8000';

/** WebSocket endpoint used for the real-time simulation stream. */
const WS_URL = 'ws://localhost:8000/ws';

/** Maximum number of history points kept in memory for the chart. */
const HISTORY_LIMIT = 10_000;

/** Default number of initial infectious individuals when seeding an outbreak. */
const DEFAULT_SEED_COUNT = 100;

/** Parameters used before the first snapshot arrives from the backend. */
const DEFAULT_PARAMS: Params = {
  r0: 2.5,
  incubation_days: 5,
  infectious_days: 7,
  fatality_rate: 0.01,
  vaccination_rate: 0,
  intervention: 0,
  mobility: 1,
};

/**
 * Single source of truth for the simulation.
 *
 * Holds the WebSocket connection, the latest snapshot, the accumulated history
 * (for charts) and the locally edited parameters. Parameters are kept separate
 * from incoming snapshots so the sliders stay responsive and are never fought
 * by the stream. All reactive state is exposed as Angular signals.
 */
@Injectable({ providedIn: 'root' })
export class SimulationService {
  private readonly http = inject(HttpClient);
  private socket?: WebSocket;

  /** Whether the WebSocket is currently open. */
  readonly connected = signal(false);
  /** The most recent frame received from the backend. */
  readonly snapshot = signal<Snapshot | null>(null);
  /** Time series of worldwide totals, capped at {@link HISTORY_LIMIT}. */
  readonly history = signal<HistoryPoint[]>([]);
  /** Locally edited parameters (the slider model). */
  readonly params = signal<Params>({ ...DEFAULT_PARAMS });
  /** Number of infectious individuals injected when a country is clicked. */
  readonly seedCount = signal(DEFAULT_SEED_COUNT);

  /** Current simulated day (0 when no snapshot yet). */
  readonly day = computed(() => this.snapshot()?.day ?? 0);
  /** Whether the simulation is auto-advancing. */
  readonly running = computed(() => this.snapshot()?.running ?? false);
  /** Latest worldwide totals, or null before the first snapshot. */
  readonly totals = computed(() => this.snapshot()?.totals ?? null);

  /** Open the WebSocket connection. Idempotent: a no-op if already connected. */
  connect(): void {
    if (this.socket) return;
    const ws = new WebSocket(WS_URL);
    this.socket = ws;
    ws.onopen = () => this.connected.set(true);
    ws.onclose = () => {
      this.connected.set(false);
      this.socket = undefined;
    };
    ws.onmessage = (ev) => this.onMessage(ev);
  }

  /** Parse an incoming frame, update the snapshot and append to history. */
  private onMessage(ev: MessageEvent): void {
    const data = JSON.parse(ev.data) as Snapshot;
    if (data.type !== 'snapshot') return;
    this.snapshot.set(data);
    if (data.day === 0) {
      // Day 0 means a fresh start/reset: restart the time series.
      this.history.set([{ day: 0, totals: data.totals }]);
    } else {
      const next = [...this.history(), { day: data.day, totals: data.totals }];
      if (next.length > HISTORY_LIMIT) next.shift();
      this.history.set(next);
    }
  }

  /** Send a JSON command over the WebSocket (dropped if not connected). */
  private send(msg: Record<string, unknown>): void {
    this.socket?.send(JSON.stringify(msg));
  }

  // -- commands --------------------------------------------------------

  /** Start auto-advancing the simulation. */
  play(): void {
    this.send({ type: 'play' });
  }

  /** Pause auto-advancing. */
  pause(): void {
    this.send({ type: 'pause' });
  }

  /** Advance the simulation by exactly one day. */
  stepOnce(): void {
    this.send({ type: 'step' });
  }

  /** Reset to day 0 with an empty world and clear the local history. */
  reset(): void {
    this.history.set([]);
    this.send({ type: 'reset' });
  }

  /**
   * Seed an outbreak in a country.
   *
   * @param iso ISO 3166-1 alpha-3 country code.
   * @param count Number of initial infectious individuals.
   */
  seed(iso: string, count: number): void {
    this.send({ type: 'seed', iso, count });
  }

  /**
   * Set the auto-advance speed.
   *
   * @param speed Steps (days) per second.
   */
  setSpeed(speed: number): void {
    this.send({ type: 'setSpeed', speed });
  }

  /**
   * Update a single parameter and push the full set to the backend.
   *
   * @param key Parameter to change.
   * @param value New value.
   */
  updateParam<K extends keyof Params>(key: K, value: Params[K]): void {
    const next = { ...this.params(), [key]: value };
    this.params.set(next);
    this.send({ type: 'setParams', params: next });
  }

  /**
   * Replace all parameters at once (e.g. when applying a preset).
   *
   * @param params Full parameter set to apply.
   */
  applyParams(params: Params): void {
    this.params.set({ ...params });
    this.send({ type: 'setParams', params });
  }

  // -- REST ------------------------------------------------------------

  /** Fetch the available disease presets. */
  getPresets(): Promise<Preset[]> {
    return firstValueFrom(this.http.get<Preset[]>(`${API_BASE}/api/presets`));
  }

  /** Fetch country metadata (ISO, name, population, coordinates). */
  getCountries(): Promise<CountryMeta[]> {
    return firstValueFrom(this.http.get<CountryMeta[]>(`${API_BASE}/api/countries`));
  }

  /** Fetch the world borders GeoJSON used by the map. */
  getGeoJson(): Promise<unknown> {
    return firstValueFrom(this.http.get(`${API_BASE}/api/geojson`));
  }

  /**
   * Export the current full state (day, params, speed, per-country compartments).
   *
   * @param name Label to store in the scenario.
   */
  exportScenario(name: string): Promise<Scenario> {
    return firstValueFrom(
      this.http.get<Scenario>(`${API_BASE}/api/scenario`, { params: { name } }),
    );
  }

  /**
   * Import a scenario: the backend restores the state and broadcasts it. The
   * local history and slider model are synced first so the incoming snapshot
   * lands cleanly.
   *
   * @param data Scenario to load.
   */
  async importScenario(data: Scenario): Promise<void> {
    this.history.set([]);
    if (data.params) this.params.set({ ...data.params });
    await firstValueFrom(this.http.post(`${API_BASE}/api/scenario`, data));
  }
}
