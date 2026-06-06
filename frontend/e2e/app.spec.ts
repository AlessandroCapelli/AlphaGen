import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

const WS = 'ws://localhost:8000/ws';
const API = 'http://localhost:8000';

let PARAM_DEFAULTS: Record<string, number> = {};

function params(over: Record<string, number> = {}): Record<string, number> {
  return { ...PARAM_DEFAULTS, ...over };
}

async function control(cmds: Record<string, unknown>[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(WS);
    const timer = setTimeout(() => {
      try { ws.close(); } catch { }
      reject(new Error('control WS timeout'));
    }, 5000);
    ws.addEventListener('open', () => {
      for (const c of cmds) ws.send(JSON.stringify(c));
      setTimeout(() => { clearTimeout(timer); ws.close(); resolve(); }, 350);
    });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('control WS error')); });
  });
}

async function fetchPresets(): Promise<any[]> {
  return (await fetch(`${API}/api/presets`)).json();
}

async function getJson(path: string): Promise<any> {
  return (await fetch(`${API}${path}`)).json();
}

async function postScenario(body: Record<string, unknown>): Promise<any> {
  const r = await fetch(`${API}/api/scenario`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

async function chipSum(page: Page): Promise<number> {
  const texts = await page.locator('.world-totals .chip b').allTextContents();
  return texts.reduce((acc, t) => acc + (Number(t.replace(/\./g, '').replace('−', '-')) || 0), 0);
}

async function readDownload(page: Page, trigger: () => Promise<void>): Promise<any> {
  const [download] = await Promise.all([page.waitForEvent('download'), trigger()]);
  const path = await download.path();
  return JSON.parse(readFileSync(path!).toString());
}

async function setRange(locator: Locator, value: number): Promise<void> {
  await locator.evaluate((el, v) => {
    (el as HTMLInputElement).value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

async function intOf(locator: Locator): Promise<number> {
  return Number(((await locator.textContent()) ?? '').replace(/[^\d-]/g, '')) || 0;
}

async function waitForReady(page: Page): Promise<void> {
  await page.locator('vite-error-overlay').waitFor({ state: 'detached', timeout: 60_000 })
    .catch(() => undefined);
  await expect(page.locator('.status')).toHaveClass(/on/);
  await page.waitForTimeout(1500);
}

async function open(page: Page): Promise<void> {
  await page.goto('/');
  await waitForReady(page);
}

async function openCard(page: Page): Promise<{ x: number; y: number }> {
  const map = page.locator('.map');
  const box = await map.boundingBox();
  if (!box) throw new Error('map has no bounding box');
  const fracs: [number, number][] = [
    [0.5, 0.5], [0.52, 0.45], [0.46, 0.55], [0.55, 0.52],
    [0.42, 0.48], [0.6, 0.58], [0.48, 0.42], [0.38, 0.6],
  ];
  for (const [fx, fy] of fracs) {
    const pos = { x: box.width * fx, y: box.height * fy };
    await map.click({ position: pos });
    if (await page.locator('.country-card').isVisible()) return pos;
  }
  throw new Error('could not open a country card via canvas clicks');
}

const dayCell = (p: Page) => p.locator('.day b');
const infChip = (p: Page) => p.locator('.chip.i b');
const paramSlider = (p: Page, label: string) =>
  p.locator('.slider', { hasText: label }).locator('input[type=range]');
const paramVal = (p: Page, label: string) =>
  p.locator('.slider', { hasText: label }).locator('.val');
const ccRow = (p: Page, label: string) =>
  p.locator('.cc-row', { hasText: label }).locator('.cc-val');
const tlSlider = (p: Page) => p.locator('.ph-line').nth(0).locator('input[type=range]');
const speedLine = (p: Page) => p.locator('.ph-line').nth(1);
const speedSlider = (p: Page) => speedLine(p).locator('input[type=range]');
const speedBadge = (p: Page) => speedLine(p).locator('.ph-badge');
const liveBadge = (p: Page) => p.locator('.ph-badge.live');

async function waitForDay(page: Page, min: number, timeout = 12_000): Promise<void> {
  await expect(async () => {
    expect(Number(await dayCell(page).textContent())).toBeGreaterThan(min);
  }).toPass({ timeout });
}

async function runSomeDays(page: Page, min = 20): Promise<void> {
  await control([{ type: 'reset' }, { type: 'setSpeed', speed: 30 }, { type: 'play' }]);
  await waitForDay(page, min);
}

async function importFile(page: Page, content: string, name = 'import.json'): Promise<void> {
  await page.locator('input[type=file]').setInputFiles({
    name, mimeType: 'application/json', buffer: Buffer.from(content),
  });
}

function captureDialogs(page: Page): { messages: string[]; last(): string } {
  const messages: string[] = [];
  page.on('dialog', (d) => { messages.push(d.message()); void d.accept(); });
  return { messages, last: () => messages[messages.length - 1] ?? '' };
}

async function pauseAndReadDay(page: Page, wait = 700): Promise<string> {
  await page.getByRole('button', { name: /Pausa/ }).click();
  await page.waitForTimeout(wait);
  return (await dayCell(page).textContent())!;
}

test.beforeAll(async () => {
  const cfg = await getJson('/api/config');
  PARAM_DEFAULTS = Object.fromEntries(cfg.params.map((p: any) => [p.key, p.default]));
});

test.beforeEach(async () => {
  await control([{ type: 'reset' }]);
});

test.describe('transport', () => {
  test('connection is established', async ({ page }) => {
    await open(page);
    await expect(page.locator('.status')).toHaveText(/connesso/);
  });

  test('Play advances the day, Pause stops it', async ({ page }) => {
    await open(page);
    await expect(dayCell(page)).toHaveText('0');
    await page.getByRole('button', { name: /Avvia/ }).click();
    await waitForDay(page, 2, 10_000);
    const v1 = Number(await pauseAndReadDay(page));
    await page.waitForTimeout(900);
    expect(Number(await dayCell(page).textContent())).toBe(v1);
  });

  test('Step is disabled while running and advances one day while paused', async ({ page }) => {
    await open(page);
    const step = page.getByRole('button', { name: /Step/ });
    await expect(step).toBeEnabled();
    await page.getByRole('button', { name: /Avvia/ }).click();
    await expect(step).toBeDisabled();
    await page.getByRole('button', { name: /Pausa/ }).click();
    await expect(step).toBeEnabled();
    await page.getByRole('button', { name: /Reset/ }).click();
    await expect(dayCell(page)).toHaveText('0');
    await step.click();
    await expect(dayCell(page)).toHaveText('1');
  });

  test('Reset returns to day 0', async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: /Step/ }).click();
    await expect(dayCell(page)).toHaveText('1');
    await page.getByRole('button', { name: /Reset/ }).click();
    await expect(dayCell(page)).toHaveText('0');
  });
});

test.describe('parameters', () => {
  test('the R0 slider updates its value', async ({ page }) => {
    await open(page);
    await setRange(paramSlider(page, 'R₀'), 7);
    await expect(paramVal(page, 'R₀')).toHaveText('7');
  });

  test('the model extremes are reachable', async ({ page }) => {
    await open(page);
    await setRange(paramSlider(page, 'Letalità'), 1);
    await expect(paramVal(page, 'Letalità')).toHaveText('100.00%');
    await setRange(paramSlider(page, 'R₀'), 20);
    await expect(paramVal(page, 'R₀')).toHaveText('20');
  });

  test('applying a preset updates the sliders', async ({ page }) => {
    await open(page);
    const p0 = (await fetchPresets())[0];
    await page.locator('select').selectOption(p0.id);
    await expect(paramVal(page, 'R₀')).toHaveText(String(p0.params.r0));
  });

  test('the speed slider updates the live value', async ({ page }) => {
    await open(page);
    await setRange(speedSlider(page), 15);
    await expect(speedBadge(page)).toHaveText(/15/);
  });

  test('initial infected count does not drop below 1', async ({ page }) => {
    await open(page);
    const seed = page.locator('input[type=number]');
    await seed.fill('0');
    await seed.dispatchEvent('input');
    await expect(seed).toHaveValue('1');
  });

  test('changing every parameter during a run breaks nothing', async ({ page }) => {
    await open(page);
    await control([{ type: 'seed', iso: 'USA', count: 100_000 }, { type: 'setSpeed', speed: 30 }, { type: 'play' }]);
    await waitForDay(page, 10, 10_000);
    for (const label of ['R₀', 'Interventi', 'Vaccinazione', 'Letalità', 'Incubazione', 'Durata infettiva', 'Mobilità']) {
      const slider = paramSlider(page, label);
      await setRange(slider, Number(await slider.getAttribute('max')));
    }
    const before = Number(await dayCell(page).textContent());
    await waitForDay(page, before + 3, 10_000);
  });
});

test.describe('timeline', () => {
  test('scrubbing pauses playback and reaches the extremes', async ({ page }) => {
    await open(page);
    await runSomeDays(page);
    await setRange(tlSlider(page), 0);
    const live = page.getByRole('button', { name: /Live/ });
    await expect(live).toBeVisible();
    await expect(dayCell(page)).toHaveText('0');
    const a = Number(await dayCell(page).textContent());
    await page.waitForTimeout(900);
    expect(Number(await dayCell(page).textContent())).toBe(a);
    await live.click();
    await expect(liveBadge(page)).toBeVisible();
  });

  test('controls are disabled while scrubbing', async ({ page }) => {
    await open(page);
    await runSomeDays(page);
    await setRange(tlSlider(page), 0);
    await expect(page.getByRole('button', { name: /Live/ })).toBeVisible();
    await expect(paramSlider(page, 'R₀')).toBeDisabled();
    await expect(speedSlider(page)).toBeDisabled();
    await expect(page.locator('select')).toBeDisabled();
  });
});

test.describe('outbreak', () => {
  test('an outbreak grows the infected count and the curves', async ({ page }) => {
    await open(page);
    await control([
      { type: 'seed', iso: 'USA', count: 100_000 },
      { type: 'setParams', params: params({ r0: 5 }) },
      { type: 'setSpeed', speed: 30 }, { type: 'play' },
    ]);
    await expect(async () => {
      expect(await intOf(infChip(page))).toBeGreaterThan(100_000);
    }).toPass({ timeout: 12_000 });
    expect(Number(await dayCell(page).textContent())).toBeGreaterThan(1);
  });

  test('global lockdown plus zero mobility halts the growth', async ({ page }) => {
    await open(page);
    await control([
      { type: 'seed', iso: 'USA', count: 100_000 },
      { type: 'setParams', params: params({ r0: 5, intervention: 1, mobility: 0 }) },
      { type: 'setSpeed', speed: 30 }, { type: 'play' },
    ]);
    await page.waitForTimeout(2500);
    expect(await intOf(infChip(page))).toBeLessThan(200_000);
  });
});

test.describe('country card (canvas)', () => {
  test('the card opens, shows SEIRD+V and closes', async ({ page }) => {
    await open(page);
    await openCard(page);
    const card = page.locator('.country-card');
    await expect(card).toBeVisible();
    await expect(card.locator('h4')).not.toBeEmpty();
    await expect(page.locator('.cc-row')).toHaveCount(6);
    for (const label of ['Suscettibili', 'Esposti', 'Infetti', 'Guariti', 'Deceduti', 'Vaccinati']) {
      await expect(page.locator('.cc-row', { hasText: label })).toBeVisible();
    }
    await page.locator('.cc-close').click();
    await expect(card).toBeHidden();
  });

  test('sub-header shows "casi attivi" and seeding from the card works', async ({ page }) => {
    await open(page);
    await openCard(page);
    await expect(page.locator('.cc-sub')).toContainText('casi attivi');
    await page.locator('.cc-seed').click();
    await expect.poll(async () => intOf(ccRow(page, 'Infetti'))).toBeGreaterThan(0);
  });

  test('the metric tooltip (Esp.+Inf.) equals Esposti+Infetti from the card', async ({ page }) => {
    await open(page);
    const pos = await openCard(page);
    await page.locator('.cc-seed').click();
    await expect.poll(async () => intOf(ccRow(page, 'Infetti'))).toBeGreaterThan(0);
    const esposti = await intOf(ccRow(page, 'Esposti'));
    const infetti = await intOf(ccRow(page, 'Infetti'));
    await page.locator('.map').hover({ position: pos });
    const tip = page.locator('.leaflet-tooltip');
    await expect(tip).toContainText('Esp.+Inf.');
    const tipActive = Number(((await tip.textContent()) ?? '').replace(/\D/g, '')) || 0;
    expect(Math.abs(tipActive - (esposti + infetti))).toBeLessThanOrEqual(1);
  });

  test('the card lockdown is disabled while scrubbing', async ({ page }) => {
    await open(page);
    await openCard(page);
    await page.locator('.cc-seed').click();
    await control([{ type: 'setSpeed', speed: 30 }, { type: 'play' }]);
    await page.waitForTimeout(1500);
    await setRange(tlSlider(page), 0);
    await expect(page.getByRole('button', { name: /Live/ })).toBeVisible();
    await expect(page.locator('.cc-lock input[type=range]')).toBeDisabled();
    await expect(page.locator('.cc-seed')).toBeDisabled();
  });
});

test.describe('import / export / continuation', () => {
  test('export then import restores the state', async ({ page }) => {
    await open(page);
    await control([
      { type: 'seed', iso: 'USA', count: 50_000 },
      { type: 'setParams', params: params({ r0: 4 }) },
      { type: 'setSpeed', speed: 30 }, { type: 'play' },
    ]);
    await waitForDay(page, 15);
    const savedDay = await pauseAndReadDay(page);

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: /Esporta/ }).click(),
    ]);
    const file = await download.path();

    await page.getByRole('button', { name: /Reset/ }).click();
    await expect(dayCell(page)).toHaveText('0');
    await page.locator('input[type=file]').setInputFiles(file);
    await expect(dayCell(page)).toHaveText(savedDay);
    expect(await intOf(infChip(page))).toBeGreaterThan(0);

    await page.getByRole('button', { name: /Avvia/ }).click();
    await waitForDay(page, Number(savedDay));
  });

  test('importing an invalid file shows an alert', async ({ page }) => {
    await open(page);
    const dialogs = captureDialogs(page);
    await importFile(page, '{"version":1,"frames":[]}', 'bad.json');
    await expect.poll(() => dialogs.last()).toContain('non valido');
  });
});

test.describe('world totals', () => {
  test('the strip above the map shows the 6 compartments', async ({ page }) => {
    await open(page);
    await expect(page.locator('.world-totals .chip')).toHaveCount(6);
    await control([{ type: 'seed', iso: 'USA', count: 100_000 }, { type: 'step' }]);
    await expect.poll(async () => intOf(infChip(page))).toBeGreaterThan(0);
  });

  test('totals stay non-negative and plausible at high speed', async ({ page }) => {
    await open(page);
    await control([
      { type: 'seed', iso: 'USA', count: 500_000 },
      { type: 'setParams', params: params({ r0: 3 }) },
      { type: 'setSpeed', speed: 50 }, { type: 'play' },
    ]);
    const WORLD = 8.1e9;
    for (let k = 0; k < 25; k++) {
      const texts = await page.locator('.world-totals .chip b').allTextContents();
      for (const t of texts) {
        const n = Number(t.replace(/\./g, '').replace('−', '-'));
        expect(n).toBeGreaterThanOrEqual(0);
        expect(n).toBeLessThanOrEqual(WORLD);
      }
      await page.waitForTimeout(80);
    }
    await control([{ type: 'pause' }]);
  });

  test('the chips filter the states shown on the map', async ({ page }) => {
    await open(page);
    const infChipBtn = page.locator('.world-totals .chip.i');
    await expect(infChipBtn).toHaveAttribute('aria-pressed', 'true');

    await infChipBtn.click();
    await expect(infChipBtn).toHaveClass(/off/);
    await expect(infChipBtn).toHaveAttribute('aria-pressed', 'false');

    await infChipBtn.click();
    await expect(infChipBtn).not.toHaveClass(/off/);
    await expect(infChipBtn).toHaveAttribute('aria-pressed', 'true');
  });
});

test.describe('leaderboard', () => {
  test('shows countries, switches metric and opens the card on click', async ({ page }) => {
    await open(page);
    await control([
      { type: 'seed', iso: 'USA', count: 200_000 },
      { type: 'seed', iso: 'CHN', count: 150_000 },
      { type: 'setSpeed', speed: 30 }, { type: 'play' },
    ]);
    await expect.poll(async () => page.locator('.lb-row').count()).toBeGreaterThan(1);
    const deaths = page.locator('.lb-tab', { hasText: 'Decessi' });
    await deaths.click();
    await expect(deaths).toHaveClass(/on/);
    await page.locator('.lb-row').first().click();
    await expect(page.locator('.country-card')).toBeVisible();
  });
});

test.describe('replay on reconnection', () => {
  test('a reconnecting client rebuilds the timeline back to day 0', async ({ page }) => {
    await open(page);
    await control([
      { type: 'seed', iso: 'USA', count: 100_000 },
      { type: 'setSpeed', speed: 30 }, { type: 'play' },
    ]);
    await waitForDay(page, 20);
    const day = Number(await pauseAndReadDay(page));

    await page.reload();
    await waitForReady(page);
    await expect(async () => {
      expect(Number(await dayCell(page).textContent())).toBe(day);
    }).toPass({ timeout: 8_000 });

    await setRange(tlSlider(page), 0);
    await expect(dayCell(page)).toHaveText('0');
    expect(await intOf(infChip(page))).toBeGreaterThan(0);
  });
});

test.describe('automatic backup', () => {
  test('GET /api/backup reflects the run and is importable from the UI', async ({ page }) => {
    await open(page);
    await control([
      { type: 'seed', iso: 'USA', count: 80_000 },
      { type: 'setSpeed', speed: 30 }, { type: 'play' },
    ]);
    await waitForDay(page, 10);
    await control([{ type: 'pause' }]);
    await page.waitForTimeout(500);
    const savedDay = await dayCell(page).textContent();

    const { saveVersion } = await getJson('/api/config');
    const state = await getJson('/api/backup');
    expect(state.version).toBe(saveVersion);
    expect(state.frames.length).toBeGreaterThan(5);
    const lastDay = state.frames[state.frames.length - 1].day;
    expect(String(lastDay)).toBe(savedDay);

    await page.getByRole('button', { name: /Reset/ }).click();
    await expect(dayCell(page)).toHaveText('0');
    await importFile(page, JSON.stringify(state), 'backup.json');
    await expect(dayCell(page)).toHaveText(String(lastDay));
    expect(await intOf(infChip(page))).toBeGreaterThan(0);
  });
});

test.describe('save format compatibility', () => {
  test('an unsupported (older) save version is rejected even with valid frames', async ({
    page,
  }) => {
    const dialogs = captureDialogs(page);
    await open(page);
    await control([
      { type: 'seed', iso: 'USA', count: 40_000 },
      { type: 'setSpeed', speed: 30 },
      { type: 'play' },
    ]);
    await waitForDay(page, 8);
    await page.getByRole('button', { name: /Pausa/ }).click();
    await page.waitForTimeout(700);

    const { saveVersion } = await getJson('/api/config');
    const exported = await readDownload(page, () =>
      page.getByRole('button', { name: /Esporta/ }).click(),
    );
    const unsupported = JSON.stringify({ version: saveVersion - 1, frames: exported.frames });

    await page.getByRole('button', { name: /Reset/ }).click();
    await expect(dayCell(page)).toHaveText('0');
    await importFile(page, unsupported, 'unsupported.json');
    await expect.poll(() => dialogs.last()).toContain('non valido');
    await expect(dayCell(page)).toHaveText('0');
  });

  test('malformed imports (non-JSON and wrong shape) show an alert', async ({ page }) => {
    await open(page);
    const dialogs = captureDialogs(page);

    await importFile(page, 'definitely not json', 'a.json');
    await expect.poll(() => dialogs.messages.length).toBeGreaterThan(0);

    await importFile(page, '{"hello":"world"}', 'b.json');
    await expect.poll(() => dialogs.messages.length).toBeGreaterThan(1);
    expect(dialogs.messages.every((m) => /non valido/i.test(m))).toBe(true);
    await expect(dayCell(page)).toHaveText('0');
  });
});

test.describe('data consistency', () => {
  test('the world population is conserved (sum of the 6 chips stays ~constant)', async ({ page }) => {
    await open(page);
    await page.waitForTimeout(1300);
    const base = await chipSum(page);
    expect(base).toBeGreaterThan(7e9);

    await control([
      { type: 'seed', iso: 'USA', count: 500_000 },
      { type: 'setParams', params: params({ r0: 4, fatality_rate: 0.05 }) },
      { type: 'setSpeed', speed: 40 }, { type: 'play' },
    ]);
    await waitForDay(page, 25, 14_000);
    await control([{ type: 'pause' }]);
    await page.waitForTimeout(1400);

    await expect.poll(async () => Math.abs((await chipSum(page)) - base) / base, {
      timeout: 6_000,
    }).toBeLessThan(0.005);
  });

  test('after an import the whole timeline can be scrubbed back to day 0', async ({ page }) => {
    await open(page);
    await control([
      { type: 'seed', iso: 'BRA', count: 60_000 },
      { type: 'setSpeed', speed: 30 }, { type: 'play' },
    ]);
    await waitForDay(page, 18);
    const day = await pauseAndReadDay(page, 500);
    const v = await readDownload(page, () =>
      page.getByRole('button', { name: /Esporta/ }).click());
    await page.getByRole('button', { name: /Reset/ }).click();
    await expect(dayCell(page)).toHaveText('0');
    await importFile(page, JSON.stringify(v), 'state.json');
    await expect(dayCell(page)).toHaveText(day);
    await setRange(tlSlider(page), 0);
    await expect(dayCell(page)).toHaveText('0');
    await page.getByRole('button', { name: /Live/ }).click();
    await expect(dayCell(page)).toHaveText(day!);
  });
});

test.describe('resync on backward jump', () => {
  test('the client realigns consistently when the engine jumps back to an earlier day', async ({
    page,
  }) => {
    await open(page);
    await runSomeDays(page, 22);
    const localDay = Number(await pauseAndReadDay(page, 500));
    expect(localDay).toBeGreaterThan(20);

    await postScenario({
      name: 'rewind', day: 5, speed: 30, params: params(),
      countries: [
        { iso: 'USA', s: 300_000_000, e: 0, i: 50_000, r: 0, d: 0, v: 0, intervention: 0 },
      ],
    });
    await control([{ type: 'play' }]);
    await expect.poll(async () => Number(await dayCell(page).textContent()), {
      timeout: 10_000,
    }).toBeLessThan(localDay - 5);
    const low = Number(await dayCell(page).textContent());
    await expect.poll(async () => Number(await dayCell(page).textContent()), {
      timeout: 10_000,
    }).toBeGreaterThan(low);
    await control([{ type: 'pause' }]);
    expect(await intOf(infChip(page))).toBeGreaterThan(0);
  });
});

test.describe('shared multi-client state', () => {
  test('two connected clients see the same day', async ({ page, context }) => {
    await open(page);
    const p2 = await context.newPage();
    await open(p2);
    await control([
      { type: 'seed', iso: 'USA', count: 100_000 },
      { type: 'setSpeed', speed: 25 }, { type: 'play' },
    ]);
    await waitForDay(page, 10);
    const d1 = Number(await dayCell(page).textContent());
    const d2 = Number(await dayCell(p2).textContent());
    expect(Math.abs(d1 - d2)).toBeLessThanOrEqual(3);
    await control([{ type: 'pause' }]);
    await p2.close();
  });
});

test.describe('leaderboard and charts (detail)', () => {
  test('leaderboard: medal, sparkline and metric switch re-sorts', async ({ page }) => {
    await open(page);
    await control([
      { type: 'seed', iso: 'USA', count: 300_000 },
      { type: 'seed', iso: 'CHN', count: 200_000 },
      { type: 'seed', iso: 'IND', count: 150_000 },
      { type: 'setParams', params: params({ r0: 4, fatality_rate: 0.05 }) },
      { type: 'setSpeed', speed: 40 }, { type: 'play' },
    ]);
    await expect.poll(async () => page.locator('.lb-row').count()).toBeGreaterThan(2);
    await expect(page.locator('.lb-row').first().locator('.lb-rank')).toHaveText('🥇');
    await expect(page.locator('.lb-spark').first()).toBeVisible();

    const pct = page.locator('.lb-tab', { hasText: '% colpita' });
    await pct.click();
    await expect(pct).toHaveClass(/on/);
    await control([{ type: 'pause' }]);
  });

  test('the curve chart fills in during the run', async ({ page }) => {
    await open(page);
    await expect(page.locator('.chart canvas').first()).toBeVisible();
    await control([
      { type: 'seed', iso: 'USA', count: 200_000 },
      { type: 'setSpeed', speed: 40 }, { type: 'play' },
    ]);
    await page.waitForTimeout(2000);
    const box = await page.locator('.chart canvas').first().boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(0);
    expect(box?.height ?? 0).toBeGreaterThan(0);
    await control([{ type: 'pause' }]);
  });

  test('the card opened from the leaderboard shows the active-cases sparkline', async ({ page }) => {
    await open(page);
    await control([
      { type: 'seed', iso: 'USA', count: 250_000 },
      { type: 'setSpeed', speed: 30 }, { type: 'play' },
    ]);
    await waitForDay(page, 12);
    await control([{ type: 'pause' }]);
    await page.locator('.lb-row').first().click();
    await expect(page.locator('.country-card')).toBeVisible();
    await expect(page.locator('.cc-spark')).toBeVisible();
  });
});

test.describe('map filters (detail)', () => {
  test('not all filters can be turned off: at least one stays active', async ({ page }) => {
    await open(page);
    const eChip = page.locator('.world-totals .chip.e');
    const iChip = page.locator('.world-totals .chip.i');
    await expect(eChip).toHaveAttribute('aria-pressed', 'true');
    await expect(iChip).toHaveAttribute('aria-pressed', 'true');
    await eChip.click();
    await expect(eChip).toHaveClass(/off/);
    await iChip.click();
    await expect(iChip).not.toHaveClass(/off/);
    await expect(iChip).toHaveAttribute('aria-pressed', 'true');
  });

  test('the active filter changes the map tooltip metric', async ({ page }) => {
    await open(page);
    const pos = await openCard(page);
    await page.locator('.cc-seed').click();
    await expect.poll(async () => intOf(ccRow(page, 'Infetti'))).toBeGreaterThan(0);

    await page.locator('.world-totals .chip.d').click();
    await page.locator('.world-totals .chip.e').click();
    await page.locator('.world-totals .chip.i').click();
    await page.locator('.map').hover({ position: pos });
    await expect(page.locator('.leaflet-tooltip')).toContainText('Dec.');
  });
});
