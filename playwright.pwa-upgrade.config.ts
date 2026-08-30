import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: /pwa-upgrade\.spec\.ts/u,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4179',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'webkit-desktop-upgrade',
      use: { ...devices['Desktop Safari'] },
    },
    {
      name: 'webkit-mobile-upgrade',
      use: { ...devices['iPhone 13'] },
    },
  ],
  webServer: {
    command: 'node scripts/serve-pwa-upgrade-rehearsal.mjs',
    reuseExistingServer: false,
    timeout: 180_000,
    url: 'http://127.0.0.1:4179/__vidha_pwa_upgrade/status',
  },
});
