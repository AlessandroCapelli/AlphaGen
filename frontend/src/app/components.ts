import {
  AfterViewInit,
  Component,
  DestroyRef,
  Directive,
  ElementRef,
  OnDestroy,
  OnInit,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild
} from '@angular/core';
import * as echarts from 'echarts';
import * as L from 'leaflet';

import { CountrySnapshot, Params, Preset, SavedState } from './models';
import { CompartmentKey, SimulationService } from './simulation.service';

/**
 * "Inferno"-style heat ramp (deep purple → magenta → orange → bright amber):
 * a perceptually pleasant gradient that glows against the dark base map.
 */
const HEAT_STOPS: readonly [number, readonly [number, number, number]][] = [
  [0.0, [40, 11, 84]],
  [0.25, [121, 28, 110]],
  [0.5, [190, 55, 82]],
  [0.75, [243, 113, 32]],
  [1.0, [250, 193, 39]],
];

/** Map an active-case fraction to [0,1] on a log scale (1e-7 .. ~1e-1). */
function heatT(ratio: number): number {
  return Math.max(0, Math.min(1, (Math.log10(ratio) + 7) / 6));
}

/**
 * Map an active-case fraction to a smooth heat colour by interpolating the
 * inferno ramp on a log scale.
 *
 * @param ratio Active cases (E + I) divided by population, in [0, 1].
 * @returns An `rgb(...)` colour string.
 */
function heatColor(ratio: number): string {
  if (ratio <= 0) return '#1b2733';
  const t = heatT(ratio);
  for (let k = 1; k < HEAT_STOPS.length; k++) {
    const [t1, c1] = HEAT_STOPS[k];
    if (t <= t1) {
      const [t0, c0] = HEAT_STOPS[k - 1];
      const f = (t - t0) / (t1 - t0 || 1);
      const r = Math.round(c0[0] + (c1[0] - c0[0]) * f);
      const g = Math.round(c0[1] + (c1[1] - c0[1]) * f);
      const b = Math.round(c0[2] + (c1[2] - c0[2]) * f);
      return `rgb(${r}, ${g}, ${b})`;
    }
  }
  const [, last] = HEAT_STOPS[HEAT_STOPS.length - 1];
  return `rgb(${last[0]}, ${last[1]}, ${last[2]})`;
}

/**
 * Fill opacity grows smoothly with the active-case fraction so hot zones glow
 * against the dark base map.
 *
 * @param ratio Active cases (E + I) divided by population, in [0, 1].
 */
function heatOpacity(ratio: number): number {
  if (ratio <= 0) return 0.05;
  return 0.25 + 0.7 * heatT(ratio);
}

/** One row of the country detail card. */
interface DetailRow {
  label: string;
  value: number;
  color: string;
}

/** Data shown in the country detail card, derived from the latest snapshot. */
interface CountryDetail {
  iso: string;
  name: string;
  population: number;
  activePct: string;
  intervention: number;
  spark: string;
  rows: DetailRow[];
}

/**
 * World map view.
 *
 * Renders a dark base map with a heat choropleth (infection intensity) and
 * animated flight arcs when contagion crosses a border. Clicking a country
 * opens a detail card with its live SEIRD+V breakdown, a lockdown control and a
 * button to seed an outbreak there.
 */
@Component({
  selector: 'app-world-map',
  template: `
    <div class="map-wrap">
      <div #mapEl class="map"></div>

      <div class="legend">
        <span class="title">Intensità contagio</span>
        <div class="legend-bar"></div>
        <div class="legend-scale"><span>basso</span><span>alto</span></div>
        <div class="legend-lock"><span class="lk"></span> Lockdown</div>
      </div>

      @if (detail(); as d) {
        <div class="country-card">
          <button class="cc-close" (click)="select(null)" aria-label="Chiudi">×</button>
          <h4>{{ d.name }}</h4>
          <div class="cc-sub">{{ d.activePct }} casi attivi · pop. {{ fmt(d.population) }}</div>
          @if (d.spark) {
            <svg class="cc-spark" viewBox="0 0 100 30" preserveAspectRatio="none">
              <path [attr.d]="d.spark" />
            </svg>
          }
          <div class="cc-rows">
            @for (r of d.rows; track r.label) {
              <div class="cc-row">
                <span class="cc-dot" [style.background]="r.color"></span>
                <span class="cc-label">{{ r.label }}</span>
                <span class="cc-val">{{ fmt(r.value) }}</span>
              </div>
            }
          </div>
          <div class="cc-lock">
            <label class="row">
              <span>🔒 Lockdown</span>
              <span class="val">{{ lockPct(d.intervention) }}</span>
            </label>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              [value]="d.intervention"
              [style.background]="lockFill(d.intervention)"
              [disabled]="viewing()"
              (input)="onLock(d.iso, $event)"
            />
          </div>
          <button class="btn primary cc-seed" [disabled]="viewing()" (click)="seedHere(d.iso)">
            🦠 Semina focolaio qui
          </button>
        </div>
      }
    </div>
  `,
})
export class WorldMap implements AfterViewInit, OnDestroy {
  private readonly sim = inject(SimulationService);
  private readonly mapEl = viewChild.required<ElementRef<HTMLDivElement>>('mapEl');

  /** The Leaflet map instance (created in {@link ngAfterViewInit}). */
  private map?: L.Map;
  /** The GeoJSON layer holding one path per country (faint choropleth). */
  private geoLayer?: L.GeoJSON;
  /** Country centroids (ISO3 -> [lat, lon]) used to place the flight arcs. */
  private readonly centroids = new Map<string, L.LatLngTuple>();
  /** Flight adjacency (ISO3 -> connected countries with weight). */
  private readonly neighbors = new Map<string, { iso: string; w: number }[]>();
  /** Countries infected in the previous snapshot (to detect new arrivals). */
  private prevInfected = new Set<string>();
  /** SVG renderer dedicated to the animated flight arcs. */
  private arcRenderer?: L.SVG;
  /** Re-fits the Leaflet map when its container changes size (resize/rotate). */
  private resizeObs?: ResizeObserver;
  /** Arcs currently animating (capped to avoid clutter). */
  private activeArcs = 0;
  /** ISO3 of the hovered country, whose border the snapshot effect leaves alone. */
  private hoveredIso: string | null = null;
  /** Flips true once the choropleth layer exists; the colouring effect tracks it
   *  so a snapshot that arrived before the (async) GeoJSON load still paints. */
  private readonly geoReady = signal(false);

  /** ISO3 of the selected country (shared via the service with the leaderboard). */
  protected readonly selectedIso = this.sim.selectedIso;
  /** Whether the timeline is being scrubbed (live actions are disabled then). */
  protected readonly viewing = this.sim.viewing;

  /** Detail card data for the selected country, recomputed on every snapshot. */
  protected readonly detail = computed<CountryDetail | null>(() => {
    const iso = this.selectedIso();
    const snap = this.sim.displayed();
    if (!iso || !snap) return null;
    const c = snap.countries.find((x) => x.iso === iso);
    if (!c) return null;
    const pct = c.population > 0 ? ((c.e + c.i) / c.population) * 100 : 0;
    return {
      iso: c.iso,
      name: c.name,
      population: c.population,
      activePct: pct >= 1 ? `${pct.toFixed(1)}%` : `${pct.toFixed(3)}%`,
      intervention: c.intervention,
      spark: this.sparkPath(this.sim.seriesFor(c.iso)),
      rows: [
        { label: 'Suscettibili', value: c.s, color: 'var(--c-s)' },
        { label: 'Esposti', value: c.e, color: 'var(--c-e)' },
        { label: 'Infetti', value: c.i, color: 'var(--c-i)' },
        { label: 'Guariti', value: c.r, color: 'var(--c-r)' },
        { label: 'Deceduti', value: c.d, color: 'var(--c-d)' },
        { label: 'Vaccinati', value: c.v, color: 'var(--c-v)' },
      ],
    };
  });

  constructor() {
    effect(() => {
      this.geoReady();
      const snap = this.sim.displayed();
      if (!snap) return;
      const sel = this.sim.selectedIso();
      const metricLabel = this.sim.mapMetricLabel();
      const byIso = new Map(snap.countries.map((c) => [c.iso, c]));

      this.geoLayer?.eachLayer((layer) => {
        const feat = (layer as L.GeoJSON & { feature?: GeoJSON.Feature }).feature;
        const id = typeof feat?.id === 'string' ? feat.id : '';
        const c = byIso.get(id);
        const value = c ? this.sim.mapMetric(c) : 0;
        const ratio = c && c.population > 0 ? value / c.population : 0;
        const style: L.PathOptions = {
          fillColor: heatColor(ratio),
          fillOpacity: heatOpacity(ratio),
        };
        if (id !== this.hoveredIso) {
          if (id === sel) {
            style.color = '#ffffff';
            style.weight = 2.4;
          } else {
            const locked = (c?.intervention ?? 0) > 0;
            style.color = locked ? '#7dd3fc' : 'rgba(255, 255, 255, 0.12)';
            style.weight = locked ? 1.6 : 0.4;
          }
        }
        (layer as L.Path).setStyle(style);
        if (id === sel) (layer as L.Path).bringToFront();
        const name = (feat?.properties as { name?: string })?.name ?? '';
        layer.setTooltipContent(
          `<b>${name}</b><br>${metricLabel}: ${Math.round(value).toLocaleString('it-IT')}<br><i>click = dettagli</i>`,
        );
      });

      if (this.sim.viewing()) return;
      const current = new Set<string>();
      for (const c of snap.countries) if (c.e + c.i >= 1) current.add(c.iso);
      if (snap.day === 0) {
        this.prevInfected = current;
        return;
      }
      const arrivals = [...current].filter((iso) => !this.prevInfected.has(iso));
      if (this.prevInfected.size > 0 && arrivals.length <= 20) {
        for (const dst of arrivals.slice(0, 6)) {
          if (this.activeArcs >= 24) break;
          const src = this.bestSource(dst, byIso);
          if (src) this.drawArc(src, dst);
        }
      }
      this.prevInfected = current;
    });

    effect(() => {
      const iso = this.sim.selectedIso();
      if (!iso || !this.map) return;
      const c = this.centroids.get(iso);
      if (c) this.map.panTo(c, { animate: true, duration: 0.6 });
    });
  }

  /** Create the map and the arc renderer, then load the backend data. */
  async ngAfterViewInit(): Promise<void> {
    const map = L.map(this.mapEl().nativeElement, {
      center: [25, 10],
      zoom: 2.4,
      minZoom: 2,
      maxZoom: 6,
      zoomSnap: 0.5,
      worldCopyJump: true,
      zoomControl: true,
      preferCanvas: true,
    });
    this.map = map;

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OpenStreetMap &copy; CARTO',
      subdomains: 'abcd',
      maxZoom: 8,
    }).addTo(map);

    this.arcRenderer = L.svg();
    this.arcRenderer.addTo(map);

    this.resizeObs = new ResizeObserver(() => map.invalidateSize());
    this.resizeObs.observe(this.mapEl().nativeElement);

    void this.loadData(map);
  }

  /**
   * Load the choropleth, centroids and flight adjacency from the backend.
   * Each step is idempotent and the whole thing retries if the backend is not
   * ready yet (e.g. the frontend started before the API).
   */
  private async loadData(map: L.Map): Promise<void> {
    try {
      if (!this.geoLayer) {
        const geojson = (await this.sim.getGeoJson()) as GeoJSON.GeoJsonObject;
        this.geoLayer = L.geoJSON(geojson, {
          style: () => ({
            weight: 0.4,
            color: 'rgba(255, 255, 255, 0.12)',
            fillColor: '#1b2733',
            fillOpacity: 0.05,
          }),
          onEachFeature: (feature, layer) => this.bindFeature(feature, layer),
        }).addTo(map);
        this.geoReady.set(true);
      }
      if (this.centroids.size === 0) {
        for (const c of await this.sim.getCountries()) {
          this.centroids.set(c.iso, [c.lat, c.lon]);
        }
      }
      if (this.neighbors.size === 0) {
        const flights = (await this.sim.getFlights()) as {
          routes?: { a: string; b: string; w: number }[];
        };
        for (const r of flights.routes ?? []) {
          this.addNeighbor(r.a, r.b, r.w);
          this.addNeighbor(r.b, r.a, r.w);
        }
      }
    } catch {
      setTimeout(() => this.loadData(map), 1500);
    }
  }

  /**
   * Wire up hover highlighting, the click-to-open-detail handler and the
   * tooltip for one country feature.
   *
   * @param feature The GeoJSON feature (its `id` is the ISO3 code).
   * @param layer The Leaflet layer rendering the feature.
   */
  private bindFeature(feature: GeoJSON.Feature, layer: L.Layer): void {
    const name = (feature.properties as { name?: string })?.name ?? '';
    const iso = typeof feature.id === 'string' ? feature.id : '';

    layer.on({
      mouseover: (e) => {
        this.hoveredIso = iso;
        const t = e.target as L.Path;
        t.setStyle({ weight: 1.8, color: '#ffffff' });
        t.bringToFront();
      },
      mouseout: (e) => {
        this.hoveredIso = null;
        const c = this.sim.displayed()?.countries.find((x) => x.iso === iso);
        const locked = (c?.intervention ?? 0) > 0;
        const reset: L.PathOptions =
          iso === this.sim.selectedIso()
            ? { weight: 2.4, color: '#ffffff' }
            : locked
              ? { weight: 1.6, color: '#7dd3fc' }
              : { weight: 0.4, color: 'rgba(255, 255, 255, 0.12)' };
        (e.target as L.Path).setStyle(reset);
      },
      click: () => {
        if (iso) this.select(iso);
      },
    });

    layer.bindTooltip(`<b>${name}</b><br><i>click = dettagli</i>`, { sticky: true });
  }

  /** Open (or close, with null) the detail card for a country. */
  protected select(iso: string | null): void {
    this.selectedIso.set(iso);
  }

  /** Seed an outbreak in the given country using the current seed size. */
  protected seedHere(iso: string): void {
    this.sim.seed(iso, this.sim.seedCount());
  }

  /** Format a count with thousands separators. */
  protected fmt(v: number): string {
    return Math.round(v).toLocaleString('it-IT');
  }

  /** Build an SVG path (in a 100×30 box) from a value series; '' if too short. */
  private sparkPath(values: number[]): string {
    if (values.length < 2) return '';
    const max = Math.max(...values, 1);
    const n = values.length;
    let d = '';
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 100;
      const y = 28 - (values[i] / max) * 26;
      d += `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)} `;
    }
    return d.trim();
  }

  /** Set the lockdown level for the selected country from the slider. */
  protected onLock(iso: string, event: Event): void {
    this.sim.setCountryIntervention(iso, parseFloat((event.target as HTMLInputElement).value));
  }

  /** Format an intervention level (0..1) as a percentage. */
  protected lockPct(v: number): string {
    return `${Math.round(v * 100)}%`;
  }

  protected lockFill(v: number): string {
    const p = Math.max(0, Math.min(100, v * 100));
    return `linear-gradient(90deg, var(--accent) ${p}%, var(--track) ${p}%)`;
  }

  /** Register a directed flight-adjacency entry. */
  private addNeighbor(from: string, to: string, w: number): void {
    const list = this.neighbors.get(from);
    if (list) list.push({ iso: to, w });
    else this.neighbors.set(from, [{ iso: to, w }]);
  }

  /**
   * Pick the most plausible source of a new outbreak: the previously-infected
   * neighbour with the strongest *open* flight link. A source's score is its
   * route weight times its open fraction `(1 - intervention)`, so a fully
   * locked-down country (which exports nothing in the model) is never shown as
   * the origin of an arc.
   */
  private bestSource(dst: string, byIso: Map<string, CountrySnapshot>): string | null {
    let best: string | null = null;
    let bestScore = 0;
    for (const n of this.neighbors.get(dst) ?? []) {
      if (!this.prevInfected.has(n.iso)) continue;
      const open = 1 - (byIso.get(n.iso)?.intervention ?? 0);
      const score = n.w * open;
      if (score > bestScore) {
        bestScore = score;
        best = n.iso;
      }
    }
    return best;
  }

  /** Draw a short-lived animated arc from one country centroid to another. */
  private drawArc(srcIso: string, dstIso: string): void {
    const a = this.centroids.get(srcIso);
    const b = this.centroids.get(dstIso);
    if (!a || !b || !this.map || !this.arcRenderer) return;
    const line = L.polyline(this.bezierArc(a, b), {
      renderer: this.arcRenderer,
      className: 'flight-arc',
      color: '#ff5d73',
      weight: 2,
      interactive: false,
    }).addTo(this.map);
    (line as unknown as { _path?: SVGPathElement })._path?.setAttribute('pathLength', '1');
    this.activeArcs++;
    setTimeout(() => {
      this.map?.removeLayer(line);
      this.activeArcs--;
    }, 1700);
  }

  /** Build a curved (quadratic-bezier) poly-line between two lat/lon points. */
  private bezierArc(a: L.LatLngTuple, b: L.LatLngTuple, segments = 24): L.LatLngTuple[] {
    const [lat1, lon1] = a;
    const [lat2, lon2] = b;
    const dx = lon2 - lon1;
    const dy = lat2 - lat1;
    const dist = Math.hypot(dx, dy) || 1;
    const lift = Math.min(dist * 0.2, 25);
    const cx = (lon1 + lon2) / 2 + (-dy / dist) * lift;
    const cy = (lat1 + lat2) / 2 + (dx / dist) * lift;
    const pts: L.LatLngTuple[] = [];
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const u = 1 - t;
      pts.push([
        u * u * lat1 + 2 * u * t * cy + t * t * lat2,
        u * u * lon1 + 2 * u * t * cx + t * t * lon2,
      ]);
    }
    return pts;
  }

  /** Tear down the Leaflet map to release DOM and event listeners. */
  ngOnDestroy(): void {
    this.resizeObs?.disconnect();
    this.map?.remove();
  }
}

/** Chart series: which `Totals` key to plot, its label and colour. */
const SERIES = [
  { key: 'e', name: 'Esposti', color: '#fbbf24' },
  { key: 'i', name: 'Infetti', color: '#f43f5e' },
  { key: 'r', name: 'Guariti', color: '#34d399' },
  { key: 'd', name: 'Deceduti', color: '#94a3b8' },
  { key: 'v', name: 'Vaccinati', color: '#a78bfa' },
] as const;

/** Convert a `#rrggbb` colour to an rgba string with the given alpha. */
function fade(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/**
 * Time-series chart of worldwide compartment totals.
 *
 * Initialises an ECharts line chart once and updates only its data on every
 * change of the history signal. Susceptibles are omitted as they dwarf the
 * other curves.
 */
@Component({
  selector: 'app-epi-chart',
  template: `<div #chartEl class="chart"></div>`,
})
export class EpiChart implements AfterViewInit, OnDestroy {
  private readonly sim = inject(SimulationService);
  private readonly chartEl = viewChild.required<ElementRef<HTMLDivElement>>('chartEl');

  /** The ECharts instance (created in {@link ngAfterViewInit}). */
  private chart?: echarts.ECharts;
  /** Resize handler kept as a field so it can be removed on destroy. */
  private readonly onResize = () => this.chart?.resize();

  constructor() {
    effect(() => {
      const history = this.sim.history();
      if (!this.chart) return;
      const days = history.map((p) => p.day);
      const cursor = this.sim.viewing() ? this.sim.day() : null;
      const interval = Math.max(0, Math.ceil(days.length / 8) - 1);
      this.chart.setOption({
        xAxis: { data: days, axisLabel: { interval } },
        series: SERIES.map((s, idx) => ({
          data: history.map((p) => Math.round(p.totals[s.key])),
          markLine: idx === 0 ? this.cursorMarkLine(cursor) : undefined,
        })),
      });
    });
  }

  /** ECharts markLine config for the timeline cursor (empty when following live). */
  private cursorMarkLine(day: number | null): echarts.MarkLineComponentOption {
    if (day === null) return { data: [] };
    return {
      silent: true,
      symbol: 'none',
      label: { show: false },
      lineStyle: { color: '#eef2f9', width: 1, opacity: 0.55 },
      data: [{ xAxis: day }],
    };
  }

  /** Build the chart skeleton (axes, legend, styling) once the view exists. */
  ngAfterViewInit(): void {
    const chart = echarts.init(this.chartEl().nativeElement, undefined, {
      renderer: 'canvas',
    });
    this.chart = chart;
    chart.setOption({
      media: [
        {
          query: { maxWidth: 560 },
          option: {
            grid: { top: 60, left: 50, right: 12 },
            legend: { itemGap: 10, itemWidth: 12, textStyle: { fontSize: 11 } },
          },
        },
      ],
      baseOption: {
        backgroundColor: 'transparent',
        grid: { left: 58, right: 18, top: 48, bottom: 30 },
        tooltip: {
          trigger: 'axis',
          backgroundColor: 'rgba(16, 22, 36, 0.95)',
          borderColor: 'rgba(120, 140, 175, 0.32)',
          borderWidth: 1,
          textStyle: { color: '#eef2f9', fontFamily: 'Inter' },
          axisPointer: {
            type: 'line',
            lineStyle: { color: 'rgba(150, 170, 205, 0.35)', type: 'dashed' },
          },
        },
        legend: {
          textStyle: { color: '#93a0b8', fontFamily: 'Inter', padding: [0, 0, 0, 4] },
          icon: 'roundRect',
          itemWidth: 14,
          itemHeight: 4,
          itemGap: 16,
          top: 8,
        },
        xAxis: {
          type: 'category',
          boundaryGap: false,
          name: 'giorni',
          nameTextStyle: { color: '#5f6c82' },
          axisLine: { lineStyle: { color: 'rgba(120, 140, 175, 0.2)' } },
          axisTick: { show: false },
          axisLabel: { color: '#8190a8', showMaxLabel: true, hideOverlap: true },
          data: [],
        },
        yAxis: {
          type: 'value',
          axisLine: { show: false },
          axisTick: { show: false },
          splitLine: { lineStyle: { color: 'rgba(120, 140, 175, 0.1)' } },
          axisLabel: {
            color: '#5f6c82',
            formatter: (v: number) => this.compact(v),
          },
        },
        animationDuration: 300,
        series: SERIES.map((s) => ({
          name: s.name,
          type: 'line',
          showSymbol: false,
          smooth: true,
          lineStyle: { width: 2.5, color: s.color },
          itemStyle: { color: s.color },
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: fade(s.color, 0.35) },
              { offset: 1, color: fade(s.color, 0) },
            ]),
          },
          data: [],
        })),
      },
    });
    window.addEventListener('resize', this.onResize);
  }

  /**
   * Format a large number compactly for axis labels (e.g. 1.2M, 340k).
   *
   * @param v The value to format.
   */
  private compact(v: number): string {
    if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B';
    if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(0) + 'k';
    return String(v);
  }

  /** Remove the resize listener and dispose the chart. */
  ngOnDestroy(): void {
    window.removeEventListener('resize', this.onResize);
    this.chart?.dispose();
  }
}

/**
 * Animates an element's text from its current value to a new number with an
 * eased, thousands-separated count-up. Re-targets smoothly if the value changes
 * mid-animation and renders an em dash while the value is undefined.
 */
@Directive({ selector: '[countUp]' })
export class CountUp {
  /** Target value (undefined before the first frame). */
  readonly countUp = input<number | undefined>(undefined);

  private readonly host = inject(ElementRef).nativeElement as HTMLElement;
  private raf = 0;
  private shown = 0;

  constructor() {
    effect(() => {
      const target = this.countUp();
      if (target === undefined) {
        cancelAnimationFrame(this.raf);
        this.host.textContent = '—';
        return;
      }
      this.animate(target);
    });
    inject(DestroyRef).onDestroy(() => cancelAnimationFrame(this.raf));
  }

  private animate(target: number): void {
    cancelAnimationFrame(this.raf);
    const from = this.shown;
    const diff = target - from;
    if (Math.abs(diff) < 1) {
      this.shown = target;
      this.host.textContent = Math.round(target).toLocaleString('it-IT');
      return;
    }
    const t0 = performance.now();
    const dur = 450;
    const tick = (t: number) => {
      const p = Math.max(0, Math.min(1, (t - t0) / dur));
      const eased = 1 - Math.pow(1 - p, 3);
      this.shown = from + diff * eased;
      this.host.textContent = Math.round(this.shown).toLocaleString('it-IT');
      if (p < 1) this.raf = requestAnimationFrame(tick);
      else this.shown = target;
    };
    this.raf = requestAnimationFrame(tick);
  }
}

/**
 * Paints the filled portion of a range slider with the accent colour up to the
 * current value, so the position reads at a glance. Min/max are read from the
 * element; pass the current value (a signal) as `[rangeFill]` so it stays in sync.
 */
@Directive({ selector: 'input[type=range][rangeFill]' })
export class RangeFill {
  /** Current slider value (drives the fill width). */
  readonly rangeFill = input.required<number>();

  private readonly el = inject(ElementRef).nativeElement as HTMLInputElement;

  constructor() {
    effect(() => {
      const v = this.rangeFill();
      const min = parseFloat(this.el.min || '0');
      const max = parseFloat(this.el.max || '100');
      const pct = max > min ? Math.max(0, Math.min(100, ((v - min) / (max - min)) * 100)) : 0;
      this.el.style.background = `linear-gradient(90deg, var(--accent) ${pct}%, var(--track) ${pct}%)`;
    });
  }
}

@Directive({ selector: '[infoTip]' })
export class InfoTip {
  /** Tooltip text. */
  readonly infoTip = input.required<string>();

  private readonly host = inject(ElementRef).nativeElement as HTMLElement;
  private bubble: HTMLDivElement | null = null;
  private pointer: string = 'mouse';
  private readonly onDocDown = (e: Event) => {
    if (!this.host.contains(e.target as Node)) this.hide();
  };

  constructor() {
    this.host.addEventListener('pointerenter', (e) => {
      this.pointer = (e as PointerEvent).pointerType;
      if (this.pointer === 'mouse') this.show();
    });
    this.host.addEventListener('pointerleave', (e) => {
      if ((e as PointerEvent).pointerType === 'mouse') this.hide();
    });
    this.host.addEventListener('click', (e) => {
      if (this.pointer === 'mouse') return;
      e.stopPropagation();
      this.bubble ? this.hide() : this.show();
    });
    inject(DestroyRef).onDestroy(() => this.hide());
  }

  private show(): void {
    if (this.bubble) return;
    const b = document.createElement('div');
    b.className = 'info-bubble';
    b.textContent = this.infoTip();
    document.body.appendChild(b);
    this.bubble = b;

    const r = this.host.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left + r.width / 2 - b.offsetWidth / 2, window.innerWidth - b.offsetWidth - 8));
    const above = r.top - b.offsetHeight - 8;
    b.style.left = `${left}px`;
    b.style.top = `${above >= 8 ? above : r.bottom + 8}px`;

    setTimeout(() => document.addEventListener('pointerdown', this.onDocDown), 0);
  }

  private hide(): void {
    if (!this.bubble) return;
    this.bubble.remove();
    this.bubble = null;
    document.removeEventListener('pointerdown', this.onDocDown);
  }
}

/** Metric the leaderboard ranks countries by. */
type LbMetric = 'active' | 'deaths' | 'pct';

/** One ranked row, derived from the displayed snapshot. */
interface LbRow {
  iso: string;
  name: string;
  rank: number;
  /** Pre-formatted metric value for display. */
  display: string;
  /** Bar fill fraction in [0, 1] (value / leader's value). */
  fill: number;
  /** Rank change vs the ~1 s baseline (positive = climbed). */
  delta: number;
  /** SVG path of the active-case sparkline (empty if too short). */
  spark: string;
}

const LB_TOP = 5;
const LB_ROW_H = 40;
const LB_TABS: readonly { key: LbMetric; label: string }[] = [
  { key: 'active', label: 'Attivi' },
  { key: 'deaths', label: 'Decessi' },
  { key: 'pct', label: '% colpita' },
];

/**
 * Live country leaderboard.
 *
 * Ranks countries by the selected metric from the displayed (live or scrubbed)
 * snapshot, re-sorting every frame. Rows are absolutely positioned by rank and
 * transition their transform, giving smooth FLIP-style reordering. Clicking a
 * row selects the country (opening its card and centring it on the map).
 */
@Component({
  selector: 'app-leaderboard',
  host: { class: 'block leaderboard' },
  template: `
    <div class="lb-head">
      <h3><span class="sec-ico">🏆</span> Classifica Paesi</h3>
      <div class="lb-tabs">
        @for (t of tabs; track t.key) {
          <button class="lb-tab" [class.on]="metric() === t.key" (click)="setMetric(t.key)">
            {{ t.label }}
          </button>
        }
      </div>
    </div>

    @if (rows().length) {
      <div class="lb-list" [style.height.px]="rows().length * rowH">
        @for (r of rows(); track r.iso) {
          <button
            class="lb-row"
            [class.sel]="r.iso === sim.selectedIso()"
            [class.medal]="r.rank <= 3"
            [style.transform]="'translateY(' + (r.rank - 1) * rowH + 'px)'"
            (click)="sim.selectedIso.set(r.iso)"
          >
            <span class="lb-bar" [style.width.%]="r.fill * 100"></span>
            <span class="lb-rank">{{ medal(r.rank) }}</span>
            <span class="lb-name">{{ r.name }}</span>
            @if (r.spark) {
              <svg class="lb-spark" viewBox="0 0 60 20" preserveAspectRatio="none">
                <path [attr.d]="r.spark" />
              </svg>
            }
            <span class="lb-val">{{ r.display }}</span>
            <span class="lb-delta" [class.up]="r.delta > 0" [class.down]="r.delta < 0">{{
              deltaLabel(r.delta)
            }}</span>
          </button>
        }
      </div>
    } @else {
      <p class="lb-empty">Nessun contagio attivo: semina un focolaio per popolare la classifica.</p>
    }
  `,
})
export class Leaderboard {
  protected readonly sim = inject(SimulationService);
  protected readonly tabs = LB_TABS;
  protected readonly rowH = LB_ROW_H;
  /** Selected ranking metric. */
  protected readonly metric = signal<LbMetric>('active');

  /** Rank of each country in the ~1 s baseline, for the climb arrows. */
  private baseline = new Map<string, number>();
  private baselineAt = 0;

  /** Ranked rows for the current metric, recomputed on every frame. */
  protected readonly rows = computed<LbRow[]>(() => {
    const snap = this.sim.displayed();
    if (!snap) return [];
    const metric = this.metric();
    const scored = snap.countries
      .map((c) => ({ iso: c.iso, name: c.name, value: this.metricValue(c, metric) }))
      .filter((e) => e.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, LB_TOP);
    if (!scored.length) return [];
    const lead = scored[0].value || 1;
    const series = this.sim.activeSeries(scored.map((e) => e.iso));
    return scored.map((e, i) => ({
      iso: e.iso,
      name: e.name,
      rank: i + 1,
      display: this.format(e.value, metric),
      fill: e.value / lead,
      delta: (this.baseline.get(e.iso) ?? i + 1) - (i + 1),
      spark: this.spark(series.get(e.iso) ?? []),
    }));
  });

  constructor() {
    effect(() => {
      const rows = this.rows();
      const now = performance.now();
      if (now - this.baselineAt > 1200) {
        this.baseline = new Map(rows.map((r) => [r.iso, r.rank]));
        this.baselineAt = now;
      }
    });
  }

  /** Switch metric and reset the baseline (ranks differ between metrics). */
  protected setMetric(m: LbMetric): void {
    if (m === this.metric()) return;
    this.metric.set(m);
    this.baseline.clear();
    this.baselineAt = 0;
  }

  private metricValue(c: CountrySnapshot, m: LbMetric): number {
    if (m === 'active') return c.e + c.i;
    if (m === 'deaths') return c.d;
    return c.population > 0 ? (c.e + c.i + c.r + c.d) / c.population : 0;
  }

  private format(v: number, m: LbMetric): string {
    if (m === 'pct') return `${v * 100 >= 1 ? (v * 100).toFixed(1) : (v * 100).toFixed(2)}%`;
    return Math.round(v).toLocaleString('it-IT');
  }

  protected medal(rank: number): string {
    return rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : String(rank);
  }

  protected deltaLabel(delta: number): string {
    if (delta > 0) return `▲${delta}`;
    if (delta < 0) return `▼${-delta}`;
    return '·';
  }

  /** Build a sparkline path inside a 60×20 box from an active-case series. */
  private spark(values: number[]): string {
    if (values.length < 2) return '';
    const max = Math.max(...values, 1);
    const n = values.length;
    let d = '';
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 60;
      const y = 18 - (values[i] / max) * 16;
      d += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)} `;
    }
    return d.trim();
  }
}

interface TotalsChip {
  key: CompartmentKey;
  label: string;
}

const TOTALS_CHIPS: readonly TotalsChip[] = [
  { key: 's', label: 'Suscettibili' },
  { key: 'e', label: 'Esposti' },
  { key: 'i', label: 'Infetti' },
  { key: 'r', label: 'Guariti' },
  { key: 'd', label: 'Deceduti' },
  { key: 'v', label: 'Vaccinati' },
];

/**
 * Worldwide compartment totals as a row of chips, shown directly above the map
 * for an at-a-glance read of the global state. Numbers count up via {@link CountUp}.
 *
 * Each chip is also a **map filter**: clicking it toggles whether that
 * compartment contributes to the map's heat metric (the count stays visible
 * either way), so the user can recolour the map by any subset of states.
 */
@Component({
  selector: 'app-world-totals',
  imports: [CountUp, InfoTip],
  host: { class: 'card world-totals' },
  template: `
    @for (chip of chips; track chip.key) {
      <button
        type="button"
        class="chip {{ chip.key }}"
        [class.off]="!states()[chip.key]"
        [attr.aria-pressed]="states()[chip.key]"
        [infoTip]="hint(chip)"
        (click)="toggle(chip.key)"
      >
        <span>{{ chip.label }}</span>
        <b [countUp]="value(chip.key)"></b>
      </button>
    }
  `,
})
export class WorldTotals {
  private readonly sim = inject(SimulationService);
  protected readonly chips = TOTALS_CHIPS;
  /** Worldwide totals of the displayed frame (live or scrubbed). */
  protected readonly totals = computed(() => this.sim.totals());
  /** Which compartments are currently shown on the map. */
  protected readonly states = this.sim.mapStates;

  protected value(key: CompartmentKey): number | undefined {
    return this.totals()?.[key];
  }

  protected toggle(key: CompartmentKey): void {
    this.sim.toggleMapState(key);
  }

  protected hint(chip: TotalsChip): string {
    return this.states()[chip.key]
      ? `${chip.label}: visibile sulla mappa — clic per nascondere`
      : `${chip.label}: nascosto dalla mappa — clic per mostrare`;
  }
}

/** Descriptor for one parameter slider in the panel. */
interface Ctrl {
  /** Parameter key driven by the slider. */
  key: keyof Params;
  /** Visible label. */
  label: string;
  /** Slider minimum. */
  min: number;
  /** Slider maximum. */
  max: number;
  /** Slider step. */
  step: number;
  /** Render the value as a percentage when true. */
  pct?: boolean;
  /** Short explanation shown in the info tooltip. */
  help: string;
}

/** Slider definitions, in display order. Ranges mirror the model's valid bounds in `backend/app/models.py`. */
const CONTROLS: Ctrl[] = [
  {
    key: 'r0',
    label: 'R₀ — trasmissibilità',
    min: 0,
    max: 20,
    step: 0.1,
    help: 'Numero medio di persone contagiate da un infetto in una popolazione tutta suscettibile.',
  },
  {
    key: 'intervention',
    label: 'Interventi (riduzione contatti)',
    min: 0,
    max: 1,
    step: 0.01,
    pct: true,
    help: 'Riduzione globale dei contatti per misure/lockdown: 0% nessuna, 100% blocco totale.',
  },
  {
    key: 'vaccination_rate',
    label: 'Vaccinazione / giorno',
    min: 0,
    max: 0.2,
    step: 0.001,
    pct: true,
    help: 'Quota di suscettibili vaccinati ogni giorno.',
  },
  {
    key: 'fatality_rate',
    label: 'Letalità',
    min: 0,
    max: 1,
    step: 0.005,
    pct: true,
    help: 'Probabilità che un infetto muoia anziché guarire.',
  },
  {
    key: 'incubation_days',
    label: 'Incubazione (giorni)',
    min: 0.1,
    max: 30,
    step: 0.1,
    help: 'Giorni medi tra il contagio e l’inizio della fase infettiva.',
  },
  {
    key: 'infectious_days',
    label: 'Durata infettiva (giorni)',
    min: 0.1,
    max: 60,
    step: 0.1,
    help: 'Giorni medi in cui un individuo resta contagioso.',
  },
  {
    key: 'mobility',
    label: 'Mobilità globale',
    min: 0,
    max: 5,
    step: 0.1,
    help: 'Moltiplicatore dell’intensità degli spostamenti internazionali (diffusione tra Paesi).',
  },
];

/**
 * Control panel: transport (play/pause/step/reset), speed, preset picker,
 * outbreak size, live parameter sliders, leaderboard and scenario import/export.
 *
 * It is a thin view over {@link SimulationService}: every interaction maps to a
 * service call, and all displayed values read from the service's signals.
 */
@Component({
  selector: 'app-control-panel',
  imports: [RangeFill, InfoTip],
  template: `
    <div class="panel">
      <section class="block panel-header">
        <div class="ph-top">
          <button class="btn primary sm" (click)="toggleRun()">
            {{ sim.running() ? '⏸ Pausa' : '▶ Avvia' }}
          </button>
          <button
            class="btn icon"
            (click)="sim.stepOnce()"
            [disabled]="sim.running()"
            title="Avanza di un giorno"
            aria-label="Step"
          >
            ⏭
          </button>
          <button class="btn icon danger" (click)="sim.reset()" title="Reset" aria-label="Reset">
            ⟲
          </button>
          <div class="day">Giorno <b>{{ sim.day() }}</b></div>
        </div>

        <div class="ph-line">
          <span class="ph-ico" title="Timeline">⏱</span>
          <input
            type="range"
            min="0"
            [max]="tlMax()"
            [disabled]="maxFrame() < 1"
            [value]="tlValue()"
            [rangeFill]="tlValue()"
            (input)="onScrub($event)"
          />
          @if (sim.viewing()) {
            <button class="ph-live" (click)="sim.goLive()" title="Torna al presente">● Live</button>
          } @else {
            <span class="ph-badge live">● LIVE</span>
          }
        </div>

        <div class="ph-line">
          <span class="ph-ico" title="Velocità">⚡</span>
          <input
            type="range"
            min="1"
            max="30"
            step="1"
            [value]="sim.snapshot()?.speed ?? 5"
            [rangeFill]="sim.snapshot()?.speed ?? 5"
            [disabled]="sim.viewing()"
            (input)="onSpeed($event)"
          />
          <span class="ph-badge">{{ sim.snapshot()?.speed ?? 5 }}×/s</span>
        </div>
      </section>

      <div class="panel-body">
        <section class="block setup">
        <label class="field">
          <span>Preset malattia</span>
          <select [disabled]="sim.viewing()" (change)="onPreset($event)">
            <option value="">— scegli —</option>
            @for (p of presets(); track p.id) {
              <option [value]="p.id">{{ p.name }}</option>
            }
          </select>
        </label>
        <label class="field seed">
          <span>Infetti iniziali del focolaio</span>
          <input type="number" min="1" [value]="sim.seedCount()" (input)="onSeedCount($event)" />
        </label>
      </section>

      <section class="block params">
        <h3><span class="sec-ico">⚙</span> Parametri <span class="sec-note">· tempo reale</span></h3>
        @for (c of controls; track c.key) {
          <div class="slider">
            <div class="srow">
              <span class="slabel"
                >{{ c.label }}<span class="hint" [infoTip]="c.help" tabindex="0">ⓘ</span></span
              >
              <span class="val">{{ display(c) }}</span>
            </div>
            <input
              type="range"
              [min]="c.min"
              [max]="c.max"
              [step]="c.step"
              [value]="sim.params()[c.key]"
              [rangeFill]="sim.params()[c.key]"
              [disabled]="sim.viewing()"
              (input)="onSlider(c.key, $event)"
            />
          </div>
        }
      </section>

        <section class="block io">
          <button class="btn" (click)="onExport()">⬇ Esporta scenario</button>
          <label class="btn file">
            ⬆ Importa scenario
            <input type="file" accept="application/json" (change)="onImport($event)" hidden />
          </label>
        </section>
      </div>
    </div>
  `,
})
export class ControlPanel implements OnInit {
  protected readonly sim = inject(SimulationService);
  /** Slider descriptors rendered by the template. */
  protected readonly controls = CONTROLS;
  /** Disease presets loaded from the backend. */
  protected readonly presets = signal<Preset[]>([]);
  /** Highest scrubbable frame index (0 when there is nothing to scrub yet). */
  protected readonly maxFrame = computed(() => Math.max(0, this.sim.frameCount() - 1));
  /** Slider max, never 0, so the thumb can sit at the right at LIVE even when
   *  only the current frame is buffered (e.g. a client connected mid-run). */
  protected readonly tlMax = computed(() => Math.max(1, this.maxFrame()));
  /** Slider value: the scrubbed index, or the right end (LIVE). */
  protected readonly tlValue = computed(() => this.sim.viewIndex() ?? this.tlMax());

  /** Load the presets; fall back to an empty list on failure. */
  async ngOnInit(): Promise<void> {
    try {
      this.presets.set(await this.sim.getPresets());
    } catch {
      this.presets.set([]);
    }
  }

  /**
   * Format a parameter value for display (percentage or raw number).
   *
   * @param c The control whose current value should be shown.
   */
  protected display(c: Ctrl): string {
    const v = this.sim.params()[c.key];
    return c.pct ? `${(v * 100).toFixed(2)}%` : `${v}`;
  }

  /**
   * Handle a parameter slider change.
   *
   * @param key Parameter being edited.
   * @param event The input event from the range element.
   */
  protected onSlider(key: keyof Params, event: Event): void {
    const v = parseFloat((event.target as HTMLInputElement).value);
    this.sim.updateParam(key, v);
  }

  /** Handle the speed slider change. */
  protected onSpeed(event: Event): void {
    this.sim.setSpeed(parseFloat((event.target as HTMLInputElement).value));
  }

  /** Scrub the timeline to a buffered frame (or back to live at the end). */
  protected onScrub(event: Event): void {
    this.sim.setViewIndex(parseInt((event.target as HTMLInputElement).value, 10));
  }

  /** Handle the outbreak-size input change. */
  protected onSeedCount(event: Event): void {
    const v = parseInt((event.target as HTMLInputElement).value, 10);
    this.sim.seedCount.set(Number.isFinite(v) && v > 0 ? v : 1);
  }

  /** Apply the parameters of the selected preset. */
  protected onPreset(event: Event): void {
    const id = (event.target as HTMLSelectElement).value;
    const preset = this.presets().find((p) => p.id === id);
    if (preset) this.sim.applyParams(preset.params);
  }

  /** Toggle between running and paused. */
  protected toggleRun(): void {
    if (this.sim.running()) this.sim.pause();
    else this.sim.play();
  }

  /** Export the complete state (timeline buffer) and trigger a JSON download. */
  protected onExport(): void {
    const blob = new Blob([JSON.stringify(this.sim.exportState())], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'alphagen-state.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  /** Read a selected JSON file and restore the complete state from it. */
  protected async onImport(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text()) as SavedState;
      await this.sim.importState(data);
    } catch {
      alert('File di stato non valido.');
    } finally {
      input.value = '';
    }
  }
}
