import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import * as echarts from 'echarts';
import * as L from 'leaflet';

import { Params, Preset, Scenario } from './models';
import { SimulationService } from './simulation.service';

/* ============================================================
   World map (app-world-map)
   ============================================================ */

/**
 * Map an active-case fraction to a choropleth colour (sequential reds).
 *
 * @param ratio Active cases (E + I) divided by population, in [0, 1].
 * @returns A hex colour string.
 */
function colorFor(ratio: number): string {
  if (ratio <= 0) return '#26323f';
  if (ratio < 1e-5) return '#fee0d2';
  if (ratio < 1e-4) return '#fcae91';
  if (ratio < 1e-3) return '#fb6a4a';
  if (ratio < 1e-2) return '#de2d26';
  return '#a50f15';
}

/**
 * World map view.
 *
 * Renders a Leaflet choropleth of the countries, recolouring each on every
 * snapshot by its active-case fraction, and lets the user click a country to
 * seed an outbreak there.
 */
@Component({
  selector: 'app-world-map',
  template: `
    <div class="map-wrap">
      <div #mapEl class="map"></div>
      <div class="legend">
        <span class="title">Casi attivi</span>
        <span><i style="background:#26323f"></i>0</span>
        <span><i style="background:#fee0d2"></i>&lt;0.001%</span>
        <span><i style="background:#fcae91"></i>&lt;0.01%</span>
        <span><i style="background:#fb6a4a"></i>&lt;0.1%</span>
        <span><i style="background:#de2d26"></i>&lt;1%</span>
        <span><i style="background:#a50f15"></i>≥1%</span>
      </div>
    </div>
  `,
})
export class WorldMap implements AfterViewInit, OnDestroy {
  private readonly sim = inject(SimulationService);
  private readonly mapEl = viewChild.required<ElementRef<HTMLDivElement>>('mapEl');

  /** The Leaflet map instance (created in {@link ngAfterViewInit}). */
  private map?: L.Map;
  /** The GeoJSON layer holding one path per country. */
  private geoLayer?: L.GeoJSON;

  constructor() {
    // Recolour and refresh tooltips whenever a new snapshot arrives.
    effect(() => {
      const snap = this.sim.snapshot();
      if (!snap || !this.geoLayer) return;
      const byIso = new Map(snap.countries.map((c) => [c.iso, c]));
      this.geoLayer.eachLayer((layer) => {
        const feat = (layer as L.GeoJSON & { feature?: GeoJSON.Feature }).feature;
        const id = typeof feat?.id === 'string' ? feat.id : '';
        const c = byIso.get(id);
        const ratio = c && c.population > 0 ? (c.e + c.i) / c.population : 0;
        (layer as L.Path).setStyle({ fillColor: colorFor(ratio) });

        const name = (feat?.properties as { name?: string })?.name ?? '';
        const infected = c ? Math.round(c.e + c.i) : 0;
        layer.setTooltipContent(
          `<b>${name}</b><br>Infetti: ${infected.toLocaleString('it-IT')}<br><i>click = focolaio</i>`,
        );
      });
    });
  }

  /** Create the map and load the world GeoJSON once the view exists. */
  async ngAfterViewInit(): Promise<void> {
    const map = L.map(this.mapEl().nativeElement, {
      center: [25, 10],
      zoom: 2,
      minZoom: 2,
      maxZoom: 6,
      worldCopyJump: true,
      attributionControl: false,
      zoomControl: true,
      preferCanvas: true,
    });
    this.map = map;

    const geojson = (await this.sim.getGeoJson()) as GeoJSON.GeoJsonObject;
    this.geoLayer = L.geoJSON(geojson, {
      style: () => ({
        weight: 0.6,
        color: '#0f1419',
        fillColor: '#26323f',
        fillOpacity: 0.9,
      }),
      onEachFeature: (feature, layer) => this.bindFeature(feature, layer),
    }).addTo(map);
  }

  /**
   * Wire up hover highlighting, the click-to-seed handler and the tooltip for
   * one country feature.
   *
   * @param feature The GeoJSON feature (its `id` is the ISO3 code).
   * @param layer The Leaflet layer rendering the feature.
   */
  private bindFeature(feature: GeoJSON.Feature, layer: L.Layer): void {
    const name = (feature.properties as { name?: string })?.name ?? '';
    const iso = typeof feature.id === 'string' ? feature.id : '';

    layer.on({
      mouseover: (e) => {
        (e.target as L.Path).setStyle({ weight: 2, color: '#4ea1ff' });
      },
      mouseout: (e) => {
        (e.target as L.Path).setStyle({ weight: 0.6, color: '#0f1419' });
      },
      click: () => {
        if (iso) this.sim.seed(iso, this.sim.seedCount());
      },
    });

    const snap = this.sim.snapshot();
    const country = snap?.countries.find((c) => c.iso === iso);
    const infected = country ? Math.round(country.e + country.i) : 0;
    layer.bindTooltip(
      `<b>${name}</b><br>Infetti: ${infected.toLocaleString('it-IT')}<br><i>click = focolaio</i>`,
      { sticky: true },
    );
  }

  /** Tear down the Leaflet map to release DOM and event listeners. */
  ngOnDestroy(): void {
    this.map?.remove();
  }
}

/* ============================================================
   Chart (app-epi-chart)
   ============================================================ */

/** Chart series: which `Totals` key to plot, its label and colour. */
const SERIES = [
  { key: 'e', name: 'Esposti', color: '#f0a020' },
  { key: 'i', name: 'Infetti', color: '#ef4444' },
  { key: 'r', name: 'Guariti', color: '#22c55e' },
  { key: 'd', name: 'Deceduti', color: '#9ca3af' },
  { key: 'v', name: 'Vaccinati', color: '#a855f7' },
] as const;

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
    // Push new data into the chart whenever the history grows or resets.
    effect(() => {
      const history = this.sim.history();
      if (!this.chart) return;
      const days = history.map((p) => p.day);
      this.chart.setOption({
        xAxis: { data: days },
        series: SERIES.map((s) => ({
          data: history.map((p) => Math.round(p.totals[s.key])),
        })),
      });
    });
  }

  /** Build the chart skeleton (axes, legend, styling) once the view exists. */
  ngAfterViewInit(): void {
    const chart = echarts.init(this.chartEl().nativeElement, undefined, {
      renderer: 'canvas',
    });
    this.chart = chart;
    chart.setOption({
      backgroundColor: 'transparent',
      grid: { left: 56, right: 16, top: 36, bottom: 28 },
      tooltip: {
        trigger: 'axis',
        backgroundColor: '#1a212b',
        borderColor: '#2e3a48',
        textStyle: { color: '#e6edf3' },
      },
      legend: {
        textStyle: { color: '#8b98a9' },
        top: 4,
      },
      xAxis: {
        type: 'category',
        name: 'giorni',
        nameTextStyle: { color: '#8b98a9' },
        axisLine: { lineStyle: { color: '#2e3a48' } },
        axisLabel: { color: '#8b98a9' },
        data: [],
      },
      yAxis: {
        type: 'value',
        axisLine: { lineStyle: { color: '#2e3a48' } },
        splitLine: { lineStyle: { color: '#1f2730' } },
        axisLabel: {
          color: '#8b98a9',
          formatter: (v: number) => this.compact(v),
        },
      },
      series: SERIES.map((s) => ({
        name: s.name,
        type: 'line',
        showSymbol: false,
        smooth: true,
        lineStyle: { width: 2, color: s.color },
        itemStyle: { color: s.color },
        data: [],
      })),
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

/* ============================================================
   Control panel (app-control-panel)
   ============================================================ */

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
}

/** Slider definitions, in display order. */
const CONTROLS: Ctrl[] = [
  { key: 'r0', label: 'R₀ — trasmissibilità', min: 0, max: 15, step: 0.1 },
  { key: 'intervention', label: 'Interventi (riduzione contatti)', min: 0, max: 1, step: 0.01, pct: true },
  { key: 'vaccination_rate', label: 'Vaccinazione / giorno', min: 0, max: 0.05, step: 0.001, pct: true },
  { key: 'fatality_rate', label: 'Letalità', min: 0, max: 0.2, step: 0.001, pct: true },
  { key: 'incubation_days', label: 'Incubazione (giorni)', min: 1, max: 21, step: 0.5 },
  { key: 'infectious_days', label: 'Durata infettiva (giorni)', min: 1, max: 30, step: 0.5 },
  { key: 'mobility', label: 'Mobilità globale', min: 0, max: 3, step: 0.1 },
];

/**
 * Control panel: transport (play/pause/step/reset), speed, preset picker,
 * outbreak size, live parameter sliders, world totals and scenario import/export.
 *
 * It is a thin view over {@link SimulationService}: every interaction maps to a
 * service call, and all displayed values read from the service's signals.
 */
@Component({
  selector: 'app-control-panel',
  template: `
    <div class="panel">
      <section class="block transport">
        <button class="btn primary" (click)="toggleRun()">
          {{ sim.running() ? '⏸ Pausa' : '▶ Avvia' }}
        </button>
        <button class="btn" (click)="sim.stepOnce()" [disabled]="sim.running()">⏭ Step</button>
        <button class="btn danger" (click)="sim.reset()">⟲ Reset</button>
        <div class="day">Giorno <b>{{ sim.day() }}</b></div>
      </section>

      <section class="block">
        <label class="row">
          <span>Velocità</span>
          <span class="val">{{ sim.snapshot()?.speed ?? 5 }}×/s</span>
        </label>
        <input
          type="range"
          min="1"
          max="30"
          step="1"
          [value]="sim.snapshot()?.speed ?? 5"
          (input)="onSpeed($event)"
        />
      </section>

      <section class="block">
        <label class="field">
          <span>Preset malattia</span>
          <select (change)="onPreset($event)">
            <option value="">— scegli —</option>
            @for (p of presets(); track p.id) {
              <option [value]="p.id">{{ p.name }}</option>
            }
          </select>
        </label>
        <label class="field">
          <span>Infetti iniziali (per click sulla mappa)</span>
          <input type="number" min="1" [value]="sim.seedCount()" (input)="onSeedCount($event)" />
        </label>
      </section>

      <section class="block params">
        <h3>Parametri (modificabili in tempo reale)</h3>
        @for (c of controls; track c.key) {
          <div class="slider">
            <label class="row">
              <span>{{ c.label }}</span>
              <span class="val">{{ display(c) }}</span>
            </label>
            <input
              type="range"
              [min]="c.min"
              [max]="c.max"
              [step]="c.step"
              [value]="sim.params()[c.key]"
              (input)="onSlider(c.key, $event)"
            />
          </div>
        }
      </section>

      <section class="block totals">
        <h3>Popolazione mondiale</h3>
        <div class="chips">
          <div class="chip s"><span>Suscettibili</span><b>{{ fmt(totals()?.s) }}</b></div>
          <div class="chip e"><span>Esposti</span><b>{{ fmt(totals()?.e) }}</b></div>
          <div class="chip i"><span>Infetti</span><b>{{ fmt(totals()?.i) }}</b></div>
          <div class="chip r"><span>Guariti</span><b>{{ fmt(totals()?.r) }}</b></div>
          <div class="chip d"><span>Deceduti</span><b>{{ fmt(totals()?.d) }}</b></div>
          <div class="chip v"><span>Vaccinati</span><b>{{ fmt(totals()?.v) }}</b></div>
        </div>
      </section>

      <section class="block io">
        <button class="btn" (click)="onExport()">⬇ Esporta scenario</button>
        <label class="btn file">
          ⬆ Importa scenario
          <input type="file" accept="application/json" (change)="onImport($event)" hidden />
        </label>
      </section>
    </div>
  `,
})
export class ControlPanel implements OnInit {
  protected readonly sim = inject(SimulationService);
  /** Slider descriptors rendered by the template. */
  protected readonly controls = CONTROLS;
  /** Disease presets loaded from the backend. */
  protected readonly presets = signal<Preset[]>([]);
  /** Convenience accessor for the latest worldwide totals. */
  protected readonly totals = computed(() => this.sim.totals());

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

  /** Handle the outbreak-size input change. */
  protected onSeedCount(event: Event): void {
    const v = parseInt((event.target as HTMLInputElement).value, 10);
    this.sim.seedCount.set(Number.isFinite(v) ? v : 0);
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

  /** Export the current scenario and trigger a JSON file download. */
  protected async onExport(): Promise<void> {
    const data = await this.sim.exportScenario('scenario');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${data.name || 'scenario'}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  /** Read a selected JSON file and import it as a scenario. */
  protected async onImport(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text()) as Scenario;
      await this.sim.importScenario(data);
    } catch {
      alert('File scenario non valido.');
    } finally {
      input.value = '';
    }
  }

  /**
   * Format a count for the totals chips (thousands separators, em dash if
   * undefined).
   *
   * @param v The value to format.
   */
  protected fmt(v: number | undefined): string {
    if (v === undefined) return '—';
    return Math.round(v).toLocaleString('it-IT');
  }
}
