import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Download, type Page } from '@playwright/test';

async function readDownload(download: Download): Promise<string> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function armDemo(page: Page): Promise<void> {
  await expect(page.getByText('Lifecycle: draft')).toBeVisible();
  await page.getByRole('button', { name: 'Rehearse Draft' }).click();
  await page.getByRole('button', { name: 'Arm rehearsal' }).click();
  await expect(page.getByText('Lifecycle: armed')).toBeVisible();
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
  await armDemo(page);

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

  await expect(
    page.getByRole('heading', { name: 'Review browser-rehearsal.md' }),
  ).toBeVisible();
  await expect(
    page.getByText('Synthetic fixture inspection only', { exact: false }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Approve decoded text' }).click();

  await expect(page.getByLabel('Envelope Markdown content')).toHaveValue(
    '# Browser rehearsal\n\nNothing was sent.',
  );
  await expect(
    page.getByRole('textbox', { name: 'Document title' }),
  ).toHaveValue('browser rehearsal');
  await expect(page.getByText('Not executable in this build')).toBeVisible();
});

test('rehearses explicit Plan pause, fresh resume, and terminal disable', async ({
  page,
}) => {
  await armDemo(page);
  await page.getByRole('button', { name: 'Pause rehearsal' }).click();
  await expect(page.getByText('Lifecycle: paused')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Timeline is not armed' }),
  ).toBeDisabled();

  await page
    .getByRole('button', { name: 'Resume with fresh interval' })
    .click();
  await expect(page.getByText('Lifecycle: armed')).toBeVisible();

  for (let stage = 0; stage < 3; stage += 1) {
    await page.getByRole('button', { name: 'Advance one stage' }).click();
  }
  await expect(page.getByText('Concern is active')).toBeVisible();

  await page.getByRole('button', { name: 'Disable rehearsal' }).click();
  await expect(
    page.getByRole('dialog', { name: 'Disable this rehearsal Plan?' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Confirm disable' }).click();
  await expect(page.getByText('Lifecycle: disabled')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'This rehearsal has ended.' }),
  ).toBeVisible();
  await expect(page.getByLabel('Next Check-in due date')).toHaveCount(0);
  await expect(page.getByLabel('Timeline inactive')).toBeVisible();
  await expect(page.getByText('Concern is active')).toHaveCount(0);
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
    buffer: Buffer.from('# Source copy\n\nHarmless imported text.'),
    mimeType: 'text/markdown',
    name: 'source-copy.md',
  });
  await page.getByRole('button', { name: 'Approve decoded text' }).click();
  await expect(page.getByText('source-copy.md')).toBeVisible();

  await page.getByLabel('Envelope Markdown content').fill('Changed later');
  await page.getByRole('button', { name: 'Restore imported text' }).click();
  await expect(page.getByLabel('Envelope Markdown content')).toHaveValue(
    '# Source copy\n\nHarmless imported text.',
  );

  const textDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export text' }).click();
  const textCopy = await textDownload;
  await expect(textCopy.suggestedFilename()).toBe('source-copy.txt');
  await expect(await readDownload(textCopy)).toBe(
    '# Source copy\n\nHarmless imported text.',
  );

  await page
    .getByLabel('Envelope Markdown content')
    .fill('# Source copy\n\n<script>remains text</script>');

  const htmlDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export HTML' }).click();
  const htmlCopy = await htmlDownload;
  const html = await readDownload(htmlCopy);
  await expect(htmlCopy.suggestedFilename()).toBe('source-copy.html');
  await expect(html).toContain('&lt;script&gt;remains text&lt;/script&gt;');
  await expect(html).not.toContain('<script>remains text</script>');

  const originalDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download original' }).click();
  const original = await originalDownload;
  await expect(original.suggestedFilename()).toBe('source-copy.md');
  await expect(await readDownload(original)).toBe(
    '# Source copy\n\nHarmless imported text.',
  );
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

test('uses the motion-aware working-concept icon with a reduced-motion fallback', async ({
  page,
}) => {
  const embeddedMark = page.locator('img[src="/vidha-mark.svg"]');
  await expect(embeddedMark).toBeVisible();
  await expect
    .poll(() => embeddedMark.evaluate((image) => image.currentSrc))
    .toContain('/vidha-mark.svg');
  await expect(
    page.locator('link[rel="icon"][media*="reduced-motion: reduce"]'),
  ).toHaveAttribute('href', '/pwa-192.png');
  await expect(
    page.locator('link[rel="icon"][media*="reduced-motion: no-preference"]'),
  ).toHaveAttribute('href', '/vidha-mark.svg');

  await page.goto('/vidha-mark.svg');
  const continuitySpan = page.locator('.continuity-span');
  await expect(continuitySpan).toHaveCount(1);
  await expect
    .poll(() =>
      continuitySpan.evaluate(
        (element) => getComputedStyle(element).animationName,
      ),
    )
    .toContain('relay-span');
  await expect
    .poll(() =>
      continuitySpan.evaluate(
        (element) => getComputedStyle(element).animationIterationCount,
      ),
    )
    .toBe('1');

  const openDestination = page.locator('.open-destination');
  await expect
    .poll(() =>
      openDestination.evaluate(
        (element) => getComputedStyle(element).animationName,
      ),
    )
    .toContain('relay-arrival');
  await expect
    .poll(() =>
      openDestination.evaluate(
        (element) => getComputedStyle(element).animationIterationCount,
      ),
    )
    .toBe('1');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect
    .poll(() =>
      continuitySpan.evaluate(
        (element) => getComputedStyle(element).animationName,
      ),
    )
    .toBe('none');
  await expect
    .poll(() =>
      openDestination.evaluate(
        (element) => getComputedStyle(element).animationName,
      ),
    )
    .toBe('none');

  await page.goto('/');
  const reducedMark = page.locator('img[src="/vidha-mark.svg"]');
  await expect(reducedMark).toBeVisible();
  await expect
    .poll(() => reducedMark.evaluate((image) => image.currentSrc))
    .toContain('/pwa-192.png');
  const reducedFrame = await reducedMark.screenshot();
  await page.waitForTimeout(4_000);
  expect((await reducedMark.screenshot()).equals(reducedFrame)).toBe(true);
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
