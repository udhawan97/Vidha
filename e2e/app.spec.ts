import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Download } from '@playwright/test';

async function readDownload(download: Download): Promise<string> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

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

test('keeps Recipient history and checkpoints for the page session', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Envelopes' }).click();
  await page.getByRole('button', { name: 'Save checkpoint' }).click();
  await page.getByLabel('Recipient').selectOption('Sam Rivera');
  await expect(page.getByLabel('Recipient')).toHaveValue('Sam Rivera');

  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await page.getByRole('button', { name: 'Envelopes' }).click();

  await page.getByRole('button', { name: 'Undo session edit' }).click();
  await expect(page.getByLabel('Recipient')).toHaveValue('Mira Chen');
  await page.getByRole('button', { name: 'Redo session edit' }).click();
  await expect(page.getByLabel('Recipient')).toHaveValue('Sam Rivera');

  await page.getByRole('button', { name: 'Save checkpoint' }).click();
  const checkpointButtons = page.locator('[data-checkpoint-id]');
  await expect(checkpointButtons).toHaveCount(2);
  const checkpointIds = await checkpointButtons.evaluateAll((buttons) =>
    buttons.map((button) => button.getAttribute('data-checkpoint-id')),
  );
  expect(new Set(checkpointIds).size).toBe(2);

  await page.getByRole('button', { name: 'Restore checkpoint 2' }).click();
  await expect(page.getByLabel('Recipient')).toHaveValue('Mira Chen');
});

test('restores decoded imported text and offers text and HTML copies', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Envelopes' }).click();
  await page.getByLabel('Import Markdown or plain text').setInputFiles({
    buffer: Buffer.from('# Source copy\n\n<script>remains text</script>'),
    mimeType: 'text/markdown',
    name: 'source-copy.md',
  });
  await expect(page.getByText('source-copy.md')).toBeVisible();

  await page.getByLabel('Envelope Markdown content').fill('Changed later');
  await page.getByRole('button', { name: 'Restore imported text' }).click();
  await expect(page.getByLabel('Envelope Markdown content')).toHaveValue(
    '# Source copy\n\n<script>remains text</script>',
  );

  const textDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export text' }).click();
  const textCopy = await textDownload;
  await expect(textCopy.suggestedFilename()).toBe('source-copy.txt');
  await expect(await readDownload(textCopy)).toBe(
    '# Source copy\n\n<script>remains text</script>',
  );

  const htmlDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export HTML' }).click();
  const htmlCopy = await htmlDownload;
  const html = await readDownload(htmlCopy);
  await expect(htmlCopy.suggestedFilename()).toBe('source-copy.html');
  await expect(html).toContain('&lt;script&gt;remains text&lt;/script&gt;');
  await expect(html).not.toContain('<script>remains text</script>');
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
