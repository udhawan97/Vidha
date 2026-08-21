import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('keeps the release boundary visible while rehearsing the timeline', async ({
  page,
}) => {
  await expect(
    page.getByText('Release logic is not active in this build.'),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Advance one stage' }).click();

  await expect(
    page.getByLabel('Current timeline stage: reminder'),
  ).toBeVisible();
  await expect(page.getByText('Reminder stage entered')).toBeVisible();
});

test('imports and edits Markdown only inside the temporary session', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Envelopes' }).click();
  await page.getByLabel('Import Markdown or plain text').setInputFiles({
    buffer: Buffer.from('# Browser rehearsal\n\nNothing was sent.'),
    mimeType: 'text/markdown',
    name: 'browser-rehearsal.md',
  });

  await expect(page.getByLabel('Envelope Markdown content')).toHaveValue(
    '# Browser rehearsal\n\nNothing was sent.',
  );
  await expect(
    page.getByRole('textbox', { name: 'Document title' }),
  ).toHaveValue('browser rehearsal');
  await expect(page.getByText('Not executable in this build')).toBeVisible();
});

test('has no serious or critical automated accessibility violations', async ({
  page,
}) => {
  const results = await new AxeBuilder({ page }).analyze();
  const materialViolations = results.violations.filter(({ impact }) =>
    ['serious', 'critical'].includes(impact ?? ''),
  );

  expect(materialViolations).toEqual([]);
});

test('fits the viewport and exposes installable PWA infrastructure', async ({
  page,
}) => {
  const viewport = await page.locator('body').evaluate((body) => ({
    clientWidth: body.clientWidth,
    scrollWidth: body.scrollWidth,
  }));
  expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth);

  const manifestHref = await page
    .locator('link[rel="manifest"]')
    .getAttribute('href');
  expect(manifestHref).toBeTruthy();

  const manifestResponse = await page.request.get(manifestHref!);
  expect(manifestResponse.ok()).toBe(true);
  await expect
    .poll(() =>
      page.evaluate(async () => {
        if (!('serviceWorker' in navigator)) {
          return false;
        }
        const registration = await navigator.serviceWorker.getRegistration();
        return registration !== undefined;
      }),
    )
    .toBe(true);
});
