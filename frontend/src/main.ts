import { provideHttpClient } from '@angular/common/http';
import {
  ApplicationConfig,
  Component,
  OnInit,
  inject,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';

import { ControlPanel, EpiChart, WorldMap } from './app/components';
import { SimulationService } from './app/simulation.service';

/**
 * Root component and dashboard layout.
 *
 * Hosts the world map, the chart and the control panel, and opens the
 * WebSocket connection once on startup.
 */
@Component({
  selector: 'app-root',
  imports: [WorldMap, EpiChart, ControlPanel],
  template: `
    <div class="app">
      <header>
        <h1><img class="logo" src="favicon.svg" alt="" /> AlphaGen</h1>
        <span class="status" [class.on]="sim.connected()">
          {{ sim.connected() ? '● connesso' : '○ disconnesso' }}
        </span>
      </header>

      <main>
        <div class="left">
          <div class="card map-card">
            <app-world-map />
          </div>
          <div class="card chart-card">
            <app-epi-chart />
          </div>
        </div>
        <aside class="right">
          <app-control-panel />
        </aside>
      </main>
    </div>
  `,
})
export class App implements OnInit {
  protected readonly sim = inject(SimulationService);

  /** Open the simulation WebSocket when the app loads. */
  ngOnInit(): void {
    this.sim.connect();
  }
}

/** Application-wide providers. */
const appConfig: ApplicationConfig = {
  providers: [provideBrowserGlobalErrorListeners(), provideHttpClient()],
};

bootstrapApplication(App, appConfig).catch((err) => console.error(err));
