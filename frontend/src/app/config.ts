/**
 * Frontend-only configuration: values the frontend needs *before* it can talk to
 * the backend (connection URLs) plus the per-parameter UI copy and display order.
 *
 * Every NUMERIC domain value (param defaults/bounds/step, limits, save version,
 * speed/seed settings, map defaults) is NOT here — it comes from the backend's
 * single config source via `GET /api/config` (see {@link ConfigService} and
 * `backend/app/config.json`), so it is never duplicated across the two sides.
 */

import { Params } from './models';

/** Base URL of the backend REST API (frontend bootstrap; cannot be fetched). */
export const API_BASE = 'http://localhost:8000';

/** WebSocket endpoint for the real-time simulation stream. */
export const WS_URL = 'ws://localhost:8000/ws';

/** Delay before the WebSocket auto-reconnect attempt (ms). */
export const RECONNECT_MS = 1500;

/**
 * Per-parameter UI copy (Italian label + help) in display order. The numeric
 * spec (min/max/step/default/percent) for each key comes from `GET /api/config`;
 * this only owns presentation and the order in which sliders are shown.
 */
export const PARAM_UI: readonly { key: keyof Params; label: string; help: string }[] = [
  {
    key: 'r0',
    label: 'R₀ — trasmissibilità',
    help: 'Numero medio di persone contagiate da un infetto in una popolazione tutta suscettibile.',
  },
  {
    key: 'intervention',
    label: 'Interventi (riduzione contatti)',
    help: 'Riduzione globale dei contatti per misure/lockdown: 0% nessuna, 100% blocco totale.',
  },
  {
    key: 'vaccination_rate',
    label: 'Vaccinazione / giorno',
    help: 'Quota di suscettibili vaccinati ogni giorno.',
  },
  {
    key: 'fatality_rate',
    label: 'Letalità',
    help: 'Probabilità che un infetto muoia anziché guarire.',
  },
  {
    key: 'incubation_days',
    label: 'Incubazione (giorni)',
    help: 'Giorni medi tra il contagio e l’inizio della fase infettiva.',
  },
  {
    key: 'infectious_days',
    label: 'Durata infettiva (giorni)',
    help: 'Giorni medi in cui un individuo resta contagioso.',
  },
  {
    key: 'mobility',
    label: 'Mobilità globale',
    help: 'Moltiplicatore dell’intensità degli spostamenti internazionali (diffusione tra Paesi).',
  },
];
