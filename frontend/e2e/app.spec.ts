import { expect, test, type Locator, type Page } from '@playwright/test';

/* ============================================================
   Helpers — drive the real backend over a control WebSocket and
   observe the real UI react (true end-to-end).
   ============================================================ */
const WS = 'ws://localhost:8000/ws';
const API = 'http://localhost:8000';

function params(over: Record<string, number> = {}): Record<string, number> {
  return {
    r0: 2.5, incubation_days: 5, infectious_days: 7, fatality_rate: 0.01,
    vaccination_rate: 0, intervention: 0, mobility: 1, ...over,
  };
}

async function control(cmds: Record<string, unknown>[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(WS);
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* ignore */ }
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
  // if the dev server is mid-recompile it shows an overlay that eats clicks
  await page.locator('vite-error-overlay').waitFor({ state: 'detached', timeout: 60_000 })
    .catch(() => undefined);
  await expect(page.locator('.status')).toHaveClass(/on/);
  await page.waitForTimeout(1500); // map ready before canvas clicks
}

/** Click the Leaflet canvas at land points until a country card opens. */
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

async function runSomeDays(page: Page, min = 20): Promise<void> {
  await control([{ type: 'reset' }, { type: 'setSpeed', speed: 30 }, { type: 'play' }]);
  await expect(async () => {
    expect(Number(await dayCell(page).textContent())).toBeGreaterThan(min);
  }).toPass({ timeout: 12_000 });
}

test.beforeEach(async () => {
  await control([{ type: 'reset' }]);
});

/* ============================================================ */
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
    await setRange(page.locator('section', { hasText: 'Velocità' }).locator('input[type=range]'), 15);
    await expect(page.locator('section', { hasText: 'Velocità' }).locator('.val')).toHaveText(/15/);
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
    await setRange(page.locator('section.timeline input[type=range]'), 0);
    const live = page.getByRole('button', { name: /Live/ });
    await expect(live).toBeVisible();
    const a = Number(await dayCell(page).textContent());
    await page.waitForTimeout(900);
    expect(Number(await dayCell(page).textContent())).toBe(a); // paused while scrubbing
    await expect(page.locator('.timeline .val')).toHaveText(/giorno/);
    await live.click();
    await expect(page.locator('.timeline .val')).toHaveText(/LIVE/);
  });

  test('controlli disabilitati durante lo scrubbing', async ({ page }) => {
    await open(page);
    await runSomeDays(page);
    await setRange(page.locator('section.timeline input[type=range]'), 0);
    await expect(page.getByRole('button', { name: /Live/ })).toBeVisible();
    await expect(paramSlider(page, 'R₀')).toBeDisabled();
    await expect(page.locator('section', { hasText: 'Velocità' }).locator('input[type=range]')).toBeDisabled();
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

  test('tooltip "Casi attivi" == Esposti+Infetti della card', async ({ page }) => {
    await open(page);
    const pos = await openCard(page);
    await page.locator('.cc-seed').click();
    await expect.poll(async () => intOf(ccRow(page, 'Infetti'))).toBeGreaterThan(0);
    const esposti = await intOf(ccRow(page, 'Esposti'));
    const infetti = await intOf(ccRow(page, 'Infetti'));
    await page.locator('.map').hover({ position: pos });
    const tip = page.locator('.leaflet-tooltip');
    await expect(tip).toContainText('Casi attivi');
    const tipActive = Number(((await tip.textContent()) ?? '').replace(/\D/g, '')) || 0;
    expect(tipActive).toBe(esposti + infetti);
  });

  test('lockdown della card disabilitato durante lo scrubbing', async ({ page }) => {
    await open(page);
    await openCard(page);
    await page.locator('.cc-seed').click();
    await control([{ type: 'setSpeed', speed: 30 }, { type: 'play' }]);
    await page.waitForTimeout(1500);
    await setRange(page.locator('section.timeline input[type=range]'), 0);
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

    // continue: play resumes from the imported day
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
