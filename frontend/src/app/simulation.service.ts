import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { API_BASE, RECONNECT_MS, WS_URL } from './config';
import { ConfigService } from './config.service';
import {
  CountryMeta,
  CountrySnapshot,
  HistoryPoint,
  Params,
  Preset,
  SavedState,
  Scenario,
  Snapshot,
  Totals,
} from './models';

/** Compartment keys (S/E/I/R/D/V); used by the map's state filters. */
export type CompartmentKey = 's' | 'e' | 'i' | 'r' | 'd' | 'v';

/** Human-readable short labels for the compartments, in display order. */
export const COMPARTMENT_LABELS: readonly { key: CompartmentKey; label: string }[] = [
  { key: 's', label: 'Susc.' },
  { key: 'e', label: 'Esp.' },
  { key: 'i', label: 'Inf.' },
  { key: 'r', label: 'Guar.' },
  { key: 'd', label: 'Dec.' },
  { key: 'v', label: 'Vacc.' },
];

/** Compact columnar timeline frames sent on connect (see backend `frames_payload`). */
interface ColumnarFrames {
  iso: string[];
  name: string[];
  population: number[];
  frame: {
    day: number;
    speed: number;
    params: Params;
    s: number[];
    e: number[];
    i: number[];
    r: number[];
    d: number[];
    v: number[];
    c: number[];
  }[];
}

/** Reconstruct full {@link Snapshot} frames from the compact columnar replay. */
function rebuildFrames(fb: ColumnarFrames): Snapshot[] {
  const { iso, name, population, frame } = fb;
  const n = iso.length;
  const out: Snapshot[] = [];
  for (const fr of frame) {
    let ts = 0;
    let te = 0;
    let ti = 0;
    let tr = 0;
    let td = 0;
    let tv = 0;
    const countries = new Array<Snapshot['countries'][number]>(n);
    for (let k = 0; k < n; k++) {
      const s = fr.s[k];
      const e = fr.e[k];
      const i = fr.i[k];
      const r = fr.r[k];
      const d = fr.d[k];
      const v = fr.v[k];
      ts += s;
      te += e;
      ti += i;
      tr += r;
      td += d;
      tv += v;
      countries[k] = {
        iso: iso[k],
        name: name[k],
        population: population[k],
        s,
        e,
        i,
        r,
        d,
        v,
        intervention: fr.c[k],
      };
    }
    out.push({
      type: 'snapshot',
      day: fr.day,
      running: false,
      speed: fr.speed,
      params: fr.params,
      totals: { s: ts, e: te, i: ti, r: tr, d: td, v: tv },
      countries,
    });
  }
  return out;
}

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
  private readonly cfg = inject(ConfigService);
  private socket?: WebSocket;
  private reconnectTimer?: ReturnType<typeof setTimeout>;

  /** Retention cap for both replay buffers (single config source). */
  private readonly dataLimit = this.cfg.dataLimit;

  /** Whether the WebSocket is currently open. */
  readonly connected = signal(false);
  /** The most recent frame received from the backend. */
  readonly snapshot = signal<Snapshot | null>(null);
  /** Time series of worldwide totals, capped at {@link dataLimit}. */
  readonly history = signal<HistoryPoint[]>([]);
  /** Locally edited parameters (the slider model), seeded from the config defaults. */
  readonly params = signal<Params>(this.cfg.defaultParams);
  /** Number of infectious individuals injected when a country is clicked. */
  readonly seedCount = signal(this.cfg.seedDefault);
  /** Ring buffer of full snapshots, used by the timeline scrubber. */
  private frames: Snapshot[] = [];
  /** Number of buffered frames (drives the scrubber range). */
  readonly frameCount = signal(0);
  /** Bumped on every received frame so derived series stay reactive even when
   *  the buffer is full and `frameCount` stops changing. */
  private readonly frameTick = signal(0);
  /** Frame index being viewed, or null to follow the live latest frame. */
  readonly viewIndex = signal<number | null>(null);
  /** ISO3 of the country whose detail card is open, or null. Shared by the map
   *  and the leaderboard so either can open/highlight a country. */
  readonly selectedIso = signal<string | null>(null);
  /** Which compartments contribute to the map heat metric. Toggled from the
   *  totals chips so the user can recolour the map by any subset of states. */
  readonly mapStates = signal<Record<CompartmentKey, boolean>>(
    this.cfg.mapDefaultStates<CompartmentKey>(),
  );

  /** Short label of the active map metric (e.g. "Esp.+Inf."), for the legend. */
  readonly mapMetricLabel = computed(() => {
    const m = this.mapStates();
    const on = COMPARTMENT_LABELS.filter((c) => m[c.key]).map((c) => c.label);
    return on.length ? on.join('+') : '—';
  });

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
  /** Worldwide totals of the displayed frame, or null before the first frame.
   *  Compartment counts are physical population sizes, so they are clamped to
   *  ≥ 0 — a defensive guard against any rounding/transient producing a stray
   *  negative in the totals strip. */
  readonly totals = computed<Totals | null>(() => {
    const t = this.displayed()?.totals;
    if (!t) return null;
    return {
      s: Math.max(0, t.s),
      e: Math.max(0, t.e),
      i: Math.max(0, t.i),
      r: Math.max(0, t.r),
      d: Math.max(0, t.d),
      v: Math.max(0, t.v),
    };
  });

  /** Open the WebSocket connection. Idempotent: a no-op if already connected. */
  connect(): void {
    if (this.socket) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const ws = new WebSocket(WS_URL);
    this.socket = ws;
    ws.onopen = () => {
      this.connected.set(true);
      this.send({ type: 'getHistory' });
    };
    ws.onclose = () => {
      this.connected.set(false);
      this.socket = undefined;
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => this.connect(), RECONNECT_MS);
    };
    ws.onerror = () => ws.close();
    ws.onmessage = (ev) => this.onMessage(ev);
  }

  /** Parse an incoming frame, update the snapshot and append to history. */
  private onMessage(ev: MessageEvent): void {
    const msg = JSON.parse(ev.data) as { type?: string };
    if (msg.type === 'history') {
      const m = msg as { points?: HistoryPoint[]; frames?: ColumnarFrames };
      const points = m.points ?? [];
      if (points.length > this.history().length) this.history.set(points.slice(-this.dataLimit));
      const fb = m.frames;
      if (fb?.frame && fb.frame.length > this.frames.length) {
        this.frames = rebuildFrames(fb).slice(-this.dataLimit);
        this.frameCount.set(this.frames.length);
        this.frameTick.set(this.frameTick() + 1);
      }
      return;
    }
    if (msg.type !== 'snapshot') return;
    const data = msg as Snapshot;
    this.snapshot.set(data);
    if (data.day === 0) {
      this.history.set([{ day: 0, totals: data.totals }]);
      this.frames = [data];
      this.viewIndex.set(null);
    } else {
      const hist = this.history();
      const last = hist[hist.length - 1];
      const point = { day: data.day, totals: data.totals };
      if (last && data.day < last.day) {
        this.history.set([point]);
        this.frames = [data];
        this.viewIndex.set(null);
      } else if (last && last.day === data.day) {
        this.history.set([...hist.slice(0, -1), point]);
        if (this.frames.length > 0) this.frames[this.frames.length - 1] = data;
        else this.frames.push(data);
      } else {
        const next = [...hist, point];
        if (next.length > this.dataLimit) next.shift();
        this.history.set(next);
        this.frames.push(data);
        if (this.frames.length > this.dataLimit) {
          this.frames.shift();
          const vi = this.viewIndex();
          if (vi !== null) this.viewIndex.set(Math.max(0, vi - 1));
        }
      }
    }
    this.frameCount.set(this.frames.length);
    this.frameTick.set(this.frameTick() + 1);
  }

  /** Send a JSON command over the WebSocket (dropped if not connected). */
  private send(msg: Record<string, unknown>): void {
    this.socket?.send(JSON.stringify(msg));
  }

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
    if (i === null || i >= this.frames.length - 1) {
      this.viewIndex.set(null);
    } else {
      if (this.running()) this.pause();
      this.viewIndex.set(Math.max(0, i));
    }
  }

  /** Stop scrubbing and follow the live latest frame. */
  goLive(): void {
    this.viewIndex.set(null);
  }

  /**
   * Toggle whether a compartment contributes to the map heat metric. The last
   * enabled state can't be turned off (an all-off map reads as "no data"), so
   * there is always at least one active compartment.
   *
   * @param key Compartment to toggle.
   */
  toggleMapState(key: CompartmentKey): void {
    const next = { ...this.mapStates(), [key]: !this.mapStates()[key] };
    if (Object.values(next).every((on) => !on)) return;
    this.mapStates.set(next);
  }

  /**
   * Sum of the currently-selected compartments for one country — the value the
   * map heat is computed from (defaults to active cases E + I).
   *
   * @param c A per-country snapshot.
   */
  mapMetric(c: CountrySnapshot): number {
    const m = this.mapStates();
    let v = 0;
    if (m.s) v += c.s;
    if (m.e) v += c.e;
    if (m.i) v += c.i;
    if (m.r) v += c.r;
    if (m.d) v += c.d;
    if (m.v) v += c.v;
    return v;
  }

  /**
   * Active cases (E + I) for one country over the most recent
   * {@link dataLimit} frames (for the detail-card sparkline).
   */
  seriesFor(iso: string): number[] {
    this.frameTick();
    const start = Math.max(0, this.frames.length - this.dataLimit);
    const out: number[] = [];
    for (let k = start; k < this.frames.length; k++) {
      const c = this.frames[k].countries.find((x) => x.iso === iso);
      out.push(c ? c.e + c.i : 0);
    }
    return out;
  }

  /**
   * Active-case (E + I) mini-series for several countries at once, sampled to at
   * most `points` values. One pass over a strided subset of the frame buffer, so
   * it stays cheap even with many leaderboard rows refreshing every frame.
   *
   * @param isos Countries to extract (typically the leaderboard's top N).
   * @param points Target number of sampled points per series.
   */
  activeSeries(isos: string[], points = 28): Map<string, number[]> {
    this.frameTick();
    const want = new Set(isos);
    const out = new Map<string, number[]>(isos.map((iso) => [iso, []]));
    const n = this.frames.length;
    if (n === 0) return out;
    const step = Math.max(1, Math.ceil(n / points));
    for (let k = (n - 1) % step; k < n; k += step) {
      for (const c of this.frames[k].countries) {
        if (want.has(c.iso)) out.get(c.iso)!.push(c.e + c.i);
      }
    }
    return out;
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

  /**
   * Export the COMPLETE state: the frame buffer (timeline) plus the chart
   * series. The series is stored explicitly so a client connected mid-run still round-trips its full chart history.
   */
  exportState(): SavedState {
    return { version: this.cfg.saveVersion, frames: this.frames, history: this.history() };
  }

  /**
   * Restore a complete state produced by {@link exportState}: rebuild the frame
   * buffer, the chart history and the displayed snapshot locally, then sync the
   * backend engine to the last frame so play/step continue from there.
   *
   * @param data The saved state.
   */
  async importState(data: SavedState): Promise<void> {
    if (!data || data.version !== this.cfg.saveVersion || !Array.isArray(data.frames)) {
      throw new Error('Formato di stato non riconosciuto.');
    }
    const frames = data.frames.slice(-this.dataLimit);
    this.frames = frames;
    const hist =
      Array.isArray(data.history) && data.history.length
        ? data.history.slice(-this.dataLimit)
        : frames.map((f) => ({ day: f.day, totals: f.totals }));
    this.history.set(hist);
    this.frameCount.set(frames.length);
    this.frameTick.set(this.frameTick() + 1);
    this.viewIndex.set(null);

    if (frames.length === 0) {
      this.snapshot.set(null);
      return;
    }

    const last = frames[frames.length - 1];
    this.snapshot.set({ ...last, running: false });
    this.params.set({ ...last.params });

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
