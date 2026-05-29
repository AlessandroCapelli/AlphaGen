import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import {
  CountryMeta,
  HistoryPoint,
  Params,
  Preset,
  SavedState,
  Scenario,
  Snapshot,
} from './models';

/** Base URL of the backend REST API. */
const API_BASE = 'http://localhost:8000';

/** WebSocket endpoint used for the real-time simulation stream. */
const WS_URL = 'ws://localhost:8000/ws';

/** Maximum number of history points kept in memory for the chart. */
const HISTORY_LIMIT = 10_000;

/** Maximum number of full snapshots buffered for the timeline scrubber. */
const FRAME_LIMIT = 600;

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
  /** Ring buffer of full snapshots, used by the timeline scrubber. */
  private frames: Snapshot[] = [];
  /** Number of buffered frames (drives the scrubber range). */
  readonly frameCount = signal(0);
  /** Bumped on every received frame so derived series stay reactive even when
   *  the buffer is full and `frameCount` stops changing. */
  private readonly frameTick = signal(0);
  /** Frame index being viewed, or null to follow the live latest frame. */
  readonly viewIndex = signal<number | null>(null);

  /** Whether the user is scrubbing a past frame (not following live). */
  readonly viewing = computed(() => this.viewIndex() !== null);
  /** The snapshot currently shown: the scrubbed frame, or the live latest. */
  readonly displayed = computed<Snapshot | null>(() => {
    const i = this.viewIndex();
    if (i === null) return this.snapshot();
    return this.frames[i] ?? this.snapshot();
  });

  /** Simulated day of the displayed frame. */
  readonly day = computed(() => this.displayed()?.day ?? 0);
  /** Whether the simulation is auto-advancing (always the live state). */
  readonly running = computed(() => this.snapshot()?.running ?? false);
  /** Worldwide totals of the displayed frame, or null before the first frame. */
  readonly totals = computed(() => this.displayed()?.totals ?? null);

  /** Open the WebSocket connection. Idempotent: a no-op if already connected. */
  connect(): void {
    if (this.socket) return;
    const ws = new WebSocket(WS_URL);
    this.socket = ws;
    ws.onopen = () => this.connected.set(true);
    ws.onclose = () => {
      this.connected.set(false);
      this.socket = undefined;
      // Auto-reconnect (e.g. after a backend reload) until the socket is back.
      setTimeout(() => this.connect(), 1500);
    };
    ws.onerror = () => ws.close();
    ws.onmessage = (ev) => this.onMessage(ev);
  }

  /** Parse an incoming frame, update the snapshot and append to history. */
  private onMessage(ev: MessageEvent): void {
    const data = JSON.parse(ev.data) as Snapshot;
    if (data.type !== 'snapshot') return;
    this.snapshot.set(data);
    if (data.day === 0) {
      // Day 0 means a fresh start/reset: restart the series and the buffer.
      this.history.set([{ day: 0, totals: data.totals }]);
      this.frames = [data];
      this.viewIndex.set(null);
    } else {
      const next = [...this.history(), { day: data.day, totals: data.totals }];
      if (next.length > HISTORY_LIMIT) next.shift();
      this.history.set(next);
      this.frames.push(data);
      if (this.frames.length > FRAME_LIMIT) {
        this.frames.shift();
        const vi = this.viewIndex();
        if (vi !== null) this.viewIndex.set(Math.max(0, vi - 1));
      }
    }
    this.frameCount.set(this.frames.length);
    this.frameTick.set(this.frameTick() + 1);
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

  /** Reset to day 0 with an empty world and clear the local history/buffer. */
  reset(): void {
    this.history.set([]);
    this.frames = [];
    this.frameCount.set(0);
    this.viewIndex.set(null);
    this.send({ type: 'reset' });
  }

  /** Scrub to a buffered frame; the last index (or null) returns to live. */
  setViewIndex(i: number | null): void {
    if (i === null || i >= this.frames.length - 1) this.viewIndex.set(null);
    else this.viewIndex.set(Math.max(0, i));
  }

  /** Stop scrubbing and follow the live latest frame. */
  goLive(): void {
    this.viewIndex.set(null);
  }

  /** Active cases (E + I) per buffered frame for one country (for sparklines). */
  seriesFor(iso: string): number[] {
    this.frameTick(); // re-run on every new frame (even when the buffer is full)
    return this.frames.map((f) => {
      const c = f.countries.find((x) => x.iso === iso);
      return c ? c.e + c.i : 0;
    });
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
   * Set the intervention level (lockdown / border closure) for one country.
   *
   * @param iso ISO 3166-1 alpha-3 country code.
   * @param value Strength in [0, 1].
   */
  setCountryIntervention(iso: string, value: number): void {
    this.send({ type: 'setCountryIntervention', iso, value });
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

  /** Fetch the flight network (country-pair routes) used by the map arcs. */
  getFlights(): Promise<unknown> {
    return firstValueFrom(this.http.get(`${API_BASE}/api/flights`));
  }

  // -- save / restore (complete state) --------------------------------

  /**
   * Export the COMPLETE state: the whole frame buffer. The chart history, the
   * current live state and the map replay are all derivable from it.
   */
  exportState(): SavedState {
    return { version: 3, frames: this.frames };
  }

  /**
   * Restore a complete state produced by {@link exportState}: rebuild the frame
   * buffer, the chart history and the displayed snapshot locally, then sync the
   * backend engine to the last frame so play/step continue from there.
   *
   * @param data The saved state (frame buffer).
   */
  async importState(data: SavedState): Promise<void> {
    const frames = (Array.isArray(data?.frames) ? data.frames : []).slice(-FRAME_LIMIT);
    this.frames = frames;
    this.history.set(frames.map((f) => ({ day: f.day, totals: f.totals })));
    this.frameCount.set(frames.length);
    this.frameTick.set(this.frameTick() + 1);
    this.viewIndex.set(null);

    if (frames.length === 0) {
      this.snapshot.set(null);
      return;
    }

    const last = frames[frames.length - 1];
    // Show the restored frame paused.
    this.snapshot.set({ ...last, running: false });
    this.params.set({ ...last.params });

    // Sync the backend engine so a subsequent play/step continues from here.
    const scenario: Scenario = {
      name: 'import',
      day: last.day,
      params: last.params,
      speed: last.speed,
      countries: last.countries.map((c) => ({
        iso: c.iso,
        s: c.s,
        e: c.e,
        i: c.i,
        r: c.r,
        d: c.d,
        v: c.v,
        intervention: c.intervention,
      })),
    };
    await firstValueFrom(this.http.post(`${API_BASE}/api/scenario`, scenario));
  }
}
