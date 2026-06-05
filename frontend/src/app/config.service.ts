import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { API_BASE } from './config';
import { AppConfig, Params, ParamSpec } from './models';

/** Merged slider descriptor: numeric spec (backend) + UI copy (frontend). */
export interface ParamControl {
  key: keyof Params;
  label: string;
  help: string;
  min: number;
  max: number;
  step: number;
  pct: boolean;
}

/**
 * Loads and caches the backend's single config source (`GET /api/config`).
 *
 * It is fetched once before the app bootstraps (see `main.ts`
 * `provideAppInitializer`), so the rest of the app — {@link SimulationService}
 * and the control panel — can read defaults, bounds, limits and the save version
 * synchronously, with those values living in exactly one place.
 */
@Injectable({ providedIn: 'root' })
export class ConfigService {
  private readonly http = inject(HttpClient);
  private cfg?: AppConfig;

  /** Fetch the config, retrying while the backend is still coming up. */
  async load(attempts = 8, delayMs = 1000): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      try {
        this.cfg = await firstValueFrom(this.http.get<AppConfig>(`${API_BASE}/api/config`));
        return;
      } catch (err) {
        if (i === attempts - 1) throw err;
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  /** The loaded config (throws if accessed before {@link load}). */
  get config(): AppConfig {
    if (!this.cfg) throw new Error('App config not loaded');
    return this.cfg;
  }

  /** Retention cap shared by chart history and the timeline frame buffer. */
  get dataLimit(): number {
    return this.config.dataLimit;
  }

  /** Only supported import/export format version. */
  get saveVersion(): number {
    return this.config.saveVersion;
  }

  /** Default outbreak seed size. */
  get seedDefault(): number {
    return this.config.seed.default;
  }

  /** Minimum allowed outbreak seed size. */
  get seedMin(): number {
    return this.config.seed.min;
  }

  /** Auto-advance speed spec (engine clamp + slider bounds). */
  get speed(): AppConfig['speed'] {
    return this.config.speed;
  }

  /** Per-country lockdown slider spec. */
  get lockdown(): AppConfig['lockdown'] {
    return this.config.lockdown;
  }

  /** Raw parameter specs (numeric), in canonical order. */
  get params(): ParamSpec[] {
    return this.config.params;
  }

  /** Default parameter set, built from the config defaults. */
  get defaultParams(): Params {
    const out = {} as Record<string, number>;
    for (const p of this.config.params) out[p.key] = p.default;
    return out as unknown as Params;
  }

  /** Compartments composing the default map heat metric. */
  mapDefaultStates<K extends string>(): Record<K, boolean> {
    return { ...this.config.mapDefaultStates } as Record<K, boolean>;
  }

  /**
   * Slider descriptors for the control panel: the frontend `ui` order/copy
   * merged with each parameter's numeric spec from the backend config.
   *
   * @param ui Per-key label/help in the desired display order.
   */
  paramControls(ui: readonly { key: keyof Params; label: string; help: string }[]): ParamControl[] {
    const byKey = new Map(this.config.params.map((p) => [p.key, p]));
    return ui
      .filter((u) => byKey.has(u.key))
      .map((u) => {
        const spec = byKey.get(u.key)!;
        return {
          key: u.key,
          label: u.label,
          help: u.help,
          min: spec.min,
          max: spec.max,
          step: spec.step,
          pct: spec.percent,
        };
      });
  }
}
