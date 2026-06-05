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

async function open(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('vite-error-overlay').waitFor({ state: 'detached', timeout: 60_000 })
    .catch(() => undefined);
  await expect(page.locator('.status')).toHaveClass(/on/);
  await page.waitForTimeout(1500);
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

async function runSomeDays(page: Page, min = 20): Promise<void> {
  await control([{ type: 'reset' }, { type: 'setSpeed', speed: 30 }, { type: 'play' }]);
  await expect(async () => {
    expect(Number(await dayCell(page).textContent())).toBeGreaterThan(min);
  }).toPass({ timeout: 12_000 });
}

test.beforeAll(async () => {
  const cfg = await getJson('/api/config');
  PARAM_DEFAULTS = Object.fromEntries(cfg.params.map((p: any) => [p.key, p.default]));
});

test.beforeEach(async () => {
  await control([{ type: 'reset' }]);
});

test.describe('transport', () => {
  test('connessione stabilita', async ({ page }) => {
    await open(page);
    await expect(page.locator('.status')).toHaveText(/connesso/);
  });

  test('Avvia avanza il giorno, Pausa lo ferma', async ({ page }) => {
    await open(page);
    await expect(dayCell(page)).toHaveText('0');
    await page.getByRole('button', { name: /Avvia/ }).click();
    await expect(async () => {
      expect(Number(await dayCell(page).textContent())).toBeGreaterThan(2);
    }).toPass({ timeout: 10_000 });
    await page.getByRole('button', { name: /Pausa/ }).click();
    await page.waitForTimeout(700);
    const v1 = Number(await dayCell(page).textContent());
    await page.waitForTimeout(900);
    expect(Number(await dayCell(page).textContent())).toBe(v1);
  });

  test('Step disabilitato in run, +1 giorno in pausa', async ({ page }) => {
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

  test('Reset riporta al giorno 0', async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: /Step/ }).click();
    await expect(dayCell(page)).toHaveText('1');
    await page.getByRole('button', { name: /Reset/ }).click();
    await expect(dayCell(page)).toHaveText('0');
  });
});

test.describe('parametri', () => {
  test('slider R0 aggiorna il valore', async ({ page }) => {
    await open(page);
    await setRange(paramSlider(page, 'R₀'), 7);
    await expect(paramVal(page, 'R₀')).toHaveText('7');
  });

  test('gli estremi del modello sono raggiungibili', async ({ page }) => {
    await open(page);
    await setRange(paramSlider(page, 'Letalità'), 1);
    await expect(paramVal(page, 'Letalità')).toHaveText('100.00%');
    await setRange(paramSlider(page, 'R₀'), 20);
    await expect(paramVal(page, 'R₀')).toHaveText('20');
  });

  test('applicare un preset aggiorna gli slider', async ({ page }) => {
    await open(page);
    const p0 = (await fetchPresets())[0];
    await page.locator('select').selectOption(p0.id);
    await expect(paramVal(page, 'R₀')).toHaveText(String(p0.params.r0));
  });

  test('slider velocità aggiorna il valore live', async ({ page }) => {
    await open(page);
    await setRange(speedSlider(page), 15);
    await expect(speedBadge(page)).toHaveText(/15/);
  });

  test('infetti iniziali non scende sotto 1', async ({ page }) => {
    await open(page);
    const seed = page.locator('input[type=number]');
    await seed.fill('0');
    await seed.dispatchEvent('input');
    await expect(seed).toHaveValue('1');
  });

  test('cambiare tutti i parametri durante la run non rompe nulla', async ({ page }) => {
    await open(page);
    await control([{ type: 'seed', iso: 'USA', count: 100_000 }, { type: 'setSpeed', speed: 30 }, { type: 'play' }]);
    await expect(async () => {
      expect(Number(await dayCell(page).textContent())).toBeGreaterThan(10);
    }).toPass({ timeout: 10_000 });
    for (const label of ['R₀', 'Interventi', 'Vaccinazione', 'Letalità', 'Incubazione', 'Durata infettiva', 'Mobilità']) {
      const slider = paramSlider(page, label);
      await setRange(slider, Number(await slider.getAttribute('max')));
    }
    const before = Number(await dayCell(page).textContent());
    await expect(async () => {
      expect(Number(await dayCell(page).textContent())).toBeGreaterThan(before + 3);
    }).toPass({ timeout: 10_000 });
  });
});

test.describe('timeline', () => {
  test('scrubbing mette in pausa e raggiunge gli estremi', async ({ page }) => {
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

  test('controlli disabilitati durante lo scrubbing', async ({ page }) => {
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
  test('outbreak fa crescere infetti e curve', async ({ page }) => {
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

  test('lockdown globale + mobilità 0 blocca la crescita', async ({ page }) => {
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
  test('la card si apre, mostra SEIRD+V e si chiude', async ({ page }) => {
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

  test('sub-header "casi attivi" e semina-da-card', async ({ page }) => {
    await open(page);
    await openCard(page);
    await expect(page.locator('.cc-sub')).toContainText('casi attivi');
    await page.locator('.cc-seed').click();
    await expect.poll(async () => intOf(ccRow(page, 'Infetti'))).toBeGreaterThan(0);
  });

  test('tooltip metrica (Esp.+Inf.) == Esposti+Infetti della card', async ({ page }) => {
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

  test('lockdown della card disabilitato durante lo scrubbing', async ({ page }) => {
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

test.describe('import / export / continuazione', () => {
  test('esporta poi importa ripristina lo stato', async ({ page }) => {
    await open(page);
    await control([
      { type: 'seed', iso: 'USA', count: 50_000 },
      { type: 'setParams', params: params({ r0: 4 }) },
      { type: 'setSpeed', speed: 30 }, { type: 'play' },
    ]);
    await expect(async () => {
      expect(Number(await dayCell(page).textContent())).toBeGreaterThan(15);
    }).toPass({ timeout: 12_000 });
    await page.getByRole('button', { name: /Pausa/ }).click();
    await page.waitForTimeout(700);
    const savedDay = await dayCell(page).textContent();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: /Esporta/ }).click(),
    ]);
    const file = await download.path();

    await page.getByRole('button', { name: /Reset/ }).click();
    await expect(dayCell(page)).toHaveText('0');
    await page.locator('input[type=file]').setInputFiles(file);
    await expect(dayCell(page)).toHaveText(savedDay!);
    expect(await intOf(infChip(page))).toBeGreaterThan(0);

    await page.getByRole('button', { name: /Avvia/ }).click();
    await expect(async () => {
      expect(Number(await dayCell(page).textContent())).toBeGreaterThan(Number(savedDay));
    }).toPass({ timeout: 12_000 });
  });

  test('import di un file non valido mostra un alert', async ({ page }) => {
    await open(page);
    let dialogMsg = '';
    page.on('dialog', (d) => { dialogMsg = d.message(); void d.accept(); });
    await page.locator('input[type=file]').setInputFiles({
      name: 'bad.json', mimeType: 'application/json',
      buffer: Buffer.from('{"version":1,"frames":[]}'),
    });
    await expect.poll(() => dialogMsg).toContain('non valido');
  });
});

test.describe('totali mondiali', () => {
  test('la striscia sopra la mappa mostra i 6 compartimenti', async ({ page }) => {
    await open(page);
    await expect(page.locator('.world-totals .chip')).toHaveCount(6);
    await control([{ type: 'seed', iso: 'USA', count: 100_000 }, { type: 'step' }]);
    await expect.poll(async () => intOf(infChip(page))).toBeGreaterThan(0);
  });

  test('i totali restano non-negativi e plausibili a velocità alta', async ({ page }) => {
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

  test('i chip filtrano gli stati mostrati sulla mappa', async ({ page }) => {
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

test.describe('classifica', () => {
  test('mostra Paesi, cambia metrica e apre la card al click', async ({ page }) => {
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

test.describe('replay su riconnessione', () => {
  test('un client che si ricollega ricostruisce la timeline fino al giorno 0', async ({ page }) => {
    await open(page);
    await control([
      { type: 'seed', iso: 'USA', count: 100_000 },
      { type: 'setSpeed', speed: 30 }, { type: 'play' },
    ]);
    await expect(async () => {
      expect(Number(await dayCell(page).textContent())).toBeGreaterThan(20);
    }).toPass({ timeout: 12_000 });
    await page.getByRole('button', { name: /Pausa/ }).click();
    await page.waitForTimeout(700);
    const day = Number(await dayCell(page).textContent());

    await page.reload();
    await page.locator('vite-error-overlay').waitFor({ state: 'detached', timeout: 60_000 })
      .catch(() => undefined);
    await expect(page.locator('.status')).toHaveClass(/on/);
    await page.waitForTimeout(1500);
    await expect(async () => {
      expect(Number(await dayCell(page).textContent())).toBe(day);
    }).toPass({ timeout: 8_000 });

    await setRange(tlSlider(page), 0);
    await expect(dayCell(page)).toHaveText('0');
    expect(await intOf(infChip(page))).toBeGreaterThan(0);
  });
});

test.describe('backup automatico', () => {
  test('GET /api/backup riflette la run ed è importabile dalla UI', async ({ page }) => {
    await open(page);
    await control([
      { type: 'seed', iso: 'USA', count: 80_000 },
      { type: 'setSpeed', speed: 30 }, { type: 'play' },
    ]);
    await expect(async () => {
      expect(Number(await dayCell(page).textContent())).toBeGreaterThan(10);
    }).toPass({ timeout: 12_000 });
    await control([{ type: 'pause' }]);
    await page.waitForTimeout(500);
    const savedDay = await dayCell(page).textContent();

    const state = await getJson('/api/backup');
    expect(state.version).toBe(4);
    expect(state.frames.length).toBeGreaterThan(5);
    const lastDay = state.frames[state.frames.length - 1].day;
    expect(String(lastDay)).toBe(savedDay);

    await page.getByRole('button', { name: /Reset/ }).click();
    await expect(dayCell(page)).toHaveText('0');
    await page.locator('input[type=file]').setInputFiles({
      name: 'backup.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(state)),
    });
    await expect(dayCell(page)).toHaveText(String(lastDay));
    expect(await intOf(infChip(page))).toBeGreaterThan(0);
  });
});

test.describe('compatibilità formato salvataggio', () => {
  test('una versione non supportata (v3) viene rifiutata anche con frame validi', async ({
    page,
  }) => {
    let dialog = '';
    page.on('dialog', (d) => {
      dialog = d.message();
      void d.accept();
    });
    await open(page);
    await control([
      { type: 'seed', iso: 'USA', count: 40_000 },
      { type: 'setSpeed', speed: 30 },
      { type: 'play' },
    ]);
    await expect(async () => {
      expect(Number(await dayCell(page).textContent())).toBeGreaterThan(8);
    }).toPass({ timeout: 12_000 });
    await page.getByRole('button', { name: /Pausa/ }).click();
    await page.waitForTimeout(700);

    const v4 = await readDownload(page, () =>
      page.getByRole('button', { name: /Esporta/ }).click(),
    );
    const v3 = JSON.stringify({ version: 3, frames: v4.frames });

    await page.getByRole('button', { name: /Reset/ }).click();
    await expect(dayCell(page)).toHaveText('0');
    await page.locator('input[type=file]').setInputFiles({
      name: 'v3.json',
      mimeType: 'application/json',
      buffer: Buffer.from(v3),
    });
    await expect.poll(() => dialog).toContain('non valido');
    await expect(dayCell(page)).toHaveText('0');
  });

  test('import malformati (non-JSON e shape errata) mostrano un alert', async ({ page }) => {
    await open(page);
    const msgs: string[] = [];
    page.on('dialog', (d) => { msgs.push(d.message()); void d.accept(); });
    const file = page.locator('input[type=file]');

    await file.setInputFiles({
      name: 'a.json', mimeType: 'application/json', buffer: Buffer.from('definitely not json'),
    });
    await expect.poll(() => msgs.length).toBeGreaterThan(0);

    await file.setInputFiles({
      name: 'b.json', mimeType: 'application/json', buffer: Buffer.from('{"hello":"world"}'),
    });
    await expect.poll(() => msgs.length).toBeGreaterThan(1);
    expect(msgs.every((m) => /non valido/i.test(m))).toBe(true);
    await expect(dayCell(page)).toHaveText('0');
  });
});

test.describe('coerenza dei dati', () => {
  test('la popolazione mondiale si conserva (somma dei 6 chip ~ costante)', async ({ page }) => {
    await open(page);
    await page.waitForTimeout(1300);
    const base = await chipSum(page);
    expect(base).toBeGreaterThan(7e9);

    await control([
      { type: 'seed', iso: 'USA', count: 500_000 },
      { type: 'setParams', params: params({ r0: 4, fatality_rate: 0.05 }) },
      { type: 'setSpeed', speed: 40 }, { type: 'play' },
    ]);
    await expect(async () => {
      expect(Number(await dayCell(page).textContent())).toBeGreaterThan(25);
    }).toPass({ timeout: 14_000 });
    await control([{ type: 'pause' }]);
    await page.waitForTimeout(1400);

    await expect.poll(async () => Math.abs((await chipSum(page)) - base) / base, {
      timeout: 6_000,
    }).toBeLessThan(0.005);
  });

  test('dopo un import si può scrubbare tutta la timeline fino al giorno 0', async ({ page }) => {
    await open(page);
    await control([
      { type: 'seed', iso: 'BRA', count: 60_000 },
      { type: 'setSpeed', speed: 30 }, { type: 'play' },
    ]);
    await expect(async () => {
      expect(Number(await dayCell(page).textContent())).toBeGreaterThan(18);
    }).toPass({ timeout: 12_000 });
    await page.getByRole('button', { name: /Pausa/ }).click();
    await page.waitForTimeout(500);
    const day = await dayCell(page).textContent();
    const v = await readDownload(page, () =>
      page.getByRole('button', { name: /Esporta/ }).click());
    await page.getByRole('button', { name: /Reset/ }).click();
    await expect(dayCell(page)).toHaveText('0');
    await page.locator('input[type=file]').setInputFiles({
      name: 'state.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(v)),
    });
    await expect(dayCell(page)).toHaveText(day!);
    await setRange(tlSlider(page), 0);
    await expect(dayCell(page)).toHaveText('0');
    await page.getByRole('button', { name: /Live/ }).click();
    await expect(dayCell(page)).toHaveText(day!);
  });
});

test.describe('resync su salto indietro', () => {
  test('il client riallinea coerentemente se il motore torna a un giorno precedente', async ({
    page,
  }) => {
    await open(page);
    await runSomeDays(page, 22);
    await page.getByRole('button', { name: /Pausa/ }).click();
    await page.waitForTimeout(500);
    const localDay = Number(await dayCell(page).textContent());
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

test.describe('stato condiviso multi-client', () => {
  test('due client connessi vedono lo stesso giorno', async ({ page, context }) => {
    await open(page);
    const p2 = await context.newPage();
    await open(p2);
    await control([
      { type: 'seed', iso: 'USA', count: 100_000 },
      { type: 'setSpeed', speed: 25 }, { type: 'play' },
    ]);
    await expect(async () => {
      expect(Number(await dayCell(page).textContent())).toBeGreaterThan(10);
    }).toPass({ timeout: 12_000 });
    const d1 = Number(await dayCell(page).textContent());
    const d2 = Number(await dayCell(p2).textContent());
    expect(Math.abs(d1 - d2)).toBeLessThanOrEqual(3);
    await control([{ type: 'pause' }]);
    await p2.close();
  });
});

test.describe('classifica e grafici (dettaglio)', () => {
  test('classifica: medaglia, sparkline e cambio metrica riordina', async ({ page }) => {
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

  test('il grafico a curve si popola durante la run', async ({ page }) => {
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

  test('la card aperta dalla classifica mostra la sparkline dei casi attivi', async ({ page }) => {
    await open(page);
    await control([
      { type: 'seed', iso: 'USA', count: 250_000 },
      { type: 'setSpeed', speed: 30 }, { type: 'play' },
    ]);
    await expect(async () => {
      expect(Number(await dayCell(page).textContent())).toBeGreaterThan(12);
    }).toPass({ timeout: 12_000 });
    await control([{ type: 'pause' }]);
    await page.locator('.lb-row').first().click();
    await expect(page.locator('.country-card')).toBeVisible();
    await expect(page.locator('.cc-spark')).toBeVisible();
  });
});

test.describe('filtri mappa (dettaglio)', () => {
  test('non si possono spegnere tutti i filtri: almeno uno resta attivo', async ({ page }) => {
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

  test('il filtro attivo cambia la metrica del tooltip della mappa', async ({ page }) => {
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
