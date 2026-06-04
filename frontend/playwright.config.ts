import { defineConfig, devices } from '@playwright/test';

/**
 * E2E config: real browser against a real backend + real frontend.
 *
 * Both servers are started (or reused if already up). The backend keeps its
 * default port 8000 and the frontend runs on 4200, so no
 * production code needs test-only configuration.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 40_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4200',
    headless: true,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'uv run uvicorn app.main:app --port 8000',
      cwd: '../backend',
      url: 'http://localhost:8000/api/health',
      timeout: 60_000,
      reuseExistingServer: true,
    },
    {
      command: 'npm start',
      url: 'http://localhost:4200',
      timeout: 180_000,
      reuseExistingServer: true,
    },
  ],
});
