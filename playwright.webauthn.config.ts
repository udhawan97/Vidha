import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.VIDHA_WEBAUTHN_ORIGIN;
if (baseURL === undefined) {
  throw new Error('VIDHA_WEBAUTHN_ORIGIN is required.');
}

export default defineConfig({
  testDir: './e2e',
  testMatch: /webauthn\..*\.spec\.ts/u,
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium-webauthn',
      testMatch: /webauthn\.(?:boundary|chromium)\.spec\.ts/u,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox-boundary',
      testMatch: /webauthn\.boundary\.spec\.ts/u,
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'webkit-boundary',
      testMatch: /webauthn\.boundary\.spec\.ts/u,
      use: { ...devices['Desktop Safari'] },
    },
  ],
});
