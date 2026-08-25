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
    page.getByRole('heading', {
      name: 'Review before replacing this draft',
    }),
  ).toBeVisible();
  await expect(page.getByText('browser-rehearsal.md')).toBeVisible();
  await expect(
    page.getByText('Synthetic fixture inspection only', { exact: false }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Create editable copy' }).click();

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

test('keeps undo history and safely restores session Document Versions', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Envelopes' }).click();
  const title = page.getByLabel('Document title');
  const originalTitle = await title.inputValue();
  await page.getByRole('button', { name: 'Save version' }).click();
  await page.getByLabel('Recipient').selectOption('Sam Rivera');
  await expect(page.getByLabel('Recipient')).toHaveValue('Sam Rivera');

  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await page.getByRole('button', { name: 'Envelopes' }).click();

  await page.getByRole('button', { name: 'Undo session edit' }).click();
  await expect(page.getByLabel('Recipient')).toHaveValue('Mira Chen');
  await page.getByRole('button', { name: 'Redo session edit' }).click();
  await expect(page.getByLabel('Recipient')).toHaveValue('Sam Rivera');

  await title.fill('Current draft');
  await page.getByRole('button', { name: 'Save version' }).click();
  await page
    .getByLabel('Envelope Markdown content')
    .fill('# Unsaved current draft');
  const versionButtons = page.locator('[data-version-id]');
  await expect(versionButtons).toHaveCount(2);
  const versionIds = await versionButtons.evaluateAll((buttons) =>
    buttons.map((button) => button.getAttribute('data-version-id')),
  );
  expect(new Set(versionIds).size).toBe(2);

  await page
    .getByRole('button', { name: `Review Version 1: ${originalTitle}` })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Restore Version 1?' });
  await expect(dialog).toContainText(
    `Current title: Current draft→Restored title: ${originalTitle}`,
  );
  await expect(dialog).toContainText(
    'Current Recipient: Sam Rivera→Restored Recipient: Mira Chen',
  );
  await expect(dialog).toContainText('Version 1 content preview');
  await expect(dialog).toContainText(
    'Your current draft remains available as Version 3.',
  );
  const keepCurrent = page.getByRole('button', { name: 'Keep current draft' });
  const restoreDocument = page.getByRole('button', {
    name: 'Restore document',
  });
  await expect(keepCurrent).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(restoreDocument).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(keepCurrent).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  const reviewVersion = page.getByRole('button', {
    name: `Review Version 1: ${originalTitle}`,
  });
  await expect(reviewVersion).toBeFocused();
  await reviewVersion.click();
  await page.getByRole('button', { name: 'Restore document' }).click();

  await expect(page.getByLabel('Recipient')).toHaveValue('Mira Chen');
  await expect(title).toHaveValue(originalTitle);
  await expect(versionButtons).toHaveCount(3);
});

test('keeps the version restore confirmation reachable at 375px', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByRole('button', { name: 'Envelopes' }).click();
  const originalTitle = await page.getByLabel('Document title').inputValue();
  await page.getByRole('button', { name: 'Save version' }).click();
  await page.getByLabel('Document title').fill('Mobile current draft');
  await page
    .getByRole('button', { name: `Review Version 1: ${originalTitle}` })
    .click();

  const restore = page.getByRole('button', { name: 'Restore document' });
  const restoreBox = await restore.boundingBox();
  const viewport = await page.locator('body').evaluate((body) => ({
    clientWidth: body.clientWidth,
    scrollWidth: body.scrollWidth,
  }));

  expect(restoreBox).not.toBeNull();
  expect(restoreBox!.y + restoreBox!.height).toBeLessThanOrEqual(812);
  expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth);
});

test('opens the intended Envelope from the overview review action', async ({
  page,
}) => {
  await page
    .getByRole('button', { name: 'Review Juniper’s ordinary week' })
    .click();

  await expect(page.getByLabel('Document title')).toHaveValue(
    'Juniper’s ordinary week',
  );
  await expect(page.getByRole('button', { name: 'Envelopes' })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

test('keeps the Draft next action above mobile navigation', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const nextAction = await page
    .getByRole('button', { name: 'Rehearse Draft' })
    .boundingBox();
  const navigation = await page.locator('.app-rail').boundingBox();

  expect(nextAction).not.toBeNull();
  expect(navigation).not.toBeNull();
  expect(nextAction!.y + nextAction!.height).toBeLessThan(navigation!.y);
});

test('keeps conversion review actions reachable at 375px', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByRole('button', { name: 'Envelopes' }).click();
  await page.getByLabel('Import Markdown or plain text').setInputFiles({
    buffer: Buffer.from('# Mobile review\n\nNothing was sent.'),
    mimeType: 'text/markdown',
    name: 'mobile-review.md',
  });

  const accept = page.getByRole('button', { name: 'Create editable copy' });
  await accept.scrollIntoViewIfNeeded();
  const acceptBox = await accept.boundingBox();
  const navigation = await page.locator('.app-rail').boundingBox();
  const viewport = await page.locator('body').evaluate((body) => ({
    clientWidth: body.clientWidth,
    scrollWidth: body.scrollWidth,
  }));

  expect(acceptBox).not.toBeNull();
  expect(navigation).not.toBeNull();
  expect(acceptBox!.y + acceptBox!.height).toBeLessThan(navigation!.y);
  expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth);
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
  await page.getByRole('button', { name: 'Create editable copy' }).click();
  await expect(page.getByText('source-copy.md')).toBeVisible();
  const sourceDigest = page.getByText(/^sha256:[a-f0-9]{64}$/u);
  const digestText = await sourceDigest.textContent();
  await expect(sourceDigest).toBeVisible();
  await expect(
    page.getByText(
      'Synthetic inspection · synthetic-fixture-inspection-no-malware-scan',
    ),
  ).toBeVisible();
  await expect(page.getByText('Schema v1 · vidha-utf8-text-v1')).toBeVisible();
  const conversionWarning = page.getByText(
    'Markdown formatting will remain editable source text.',
  );
  await expect(conversionWarning).toBeVisible();

  await page.getByRole('button', { name: 'Save version' }).click();
  await page.getByLabel('Document title').fill('Changed after import');
  await page.getByLabel('Recipient').selectOption('Sam Rivera');
  await page.getByLabel('Envelope Markdown content').fill('Changed later');
  await page
    .getByRole('button', { name: 'Review Version 1: source copy' })
    .click();
  await page.getByRole('button', { name: 'Restore document' }).click();
  await expect(page.getByText('source-copy.md')).toBeVisible();
  await expect(sourceDigest).toHaveText(digestText ?? '');
  await expect(
    page.getByText(
      'Synthetic inspection · synthetic-fixture-inspection-no-malware-scan',
    ),
  ).toBeVisible();
  await expect(page.getByText('Schema v1 · vidha-utf8-text-v1')).toBeVisible();
  await expect(conversionWarning).toBeVisible();

  await page.getByLabel('Envelope Markdown content').fill('Changed later');
  await page.getByRole('button', { name: 'Restore imported text' }).click();
  await expect(page.getByLabel('Envelope Markdown content')).toHaveValue(
    '# Source copy\n\nHarmless imported text.',
  );

  const markdownDownload = page.waitForEvent('download');
  await page.getByLabel('Portable copy format').selectOption('markdown');
  await page.getByRole('button', { name: 'Download copy' }).click();
  const markdownCopy = await markdownDownload;
  await expect(markdownCopy.suggestedFilename()).toBe('source-copy.md');
  await expect(await readDownload(markdownCopy)).toBe(
    '# Source copy\n\nHarmless imported text.',
  );

  const textDownload = page.waitForEvent('download');
  await page.getByLabel('Portable copy format').selectOption('text');
  await page.getByRole('button', { name: 'Download copy' }).click();
  const textCopy = await textDownload;
  await expect(textCopy.suggestedFilename()).toBe('source-copy.txt');
  await expect(await readDownload(textCopy)).toBe(
    '# Source copy\n\nHarmless imported text.',
  );

  await page
    .getByLabel('Envelope Markdown content')
    .fill('# Source copy\n\n<script>remains text</script>');

  const htmlDownload = page.waitForEvent('download');
  await page.getByLabel('Portable copy format').selectOption('html');
  await page.getByRole('button', { name: 'Download copy' }).click();
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

test('reviews distinct file types before keeping session-only Attachments', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Envelopes' }).click();
  await page.getByLabel('Add Attachment candidates').setInputFiles([
    {
      buffer: Buffer.from('%PDF synthetic fixture'),
      mimeType: 'application/pdf',
      name: 'care-sheet.pdf',
    },
    {
      buffer: Buffer.from('BEGIN:VCARD\nEND:VCARD'),
      mimeType: 'text/vcard',
      name: 'helper.vcf',
    },
  ]);

  await expect(
    page.getByRole('heading', { name: 'Keep 2 files with this Envelope?' }),
  ).toBeVisible();
  await expect(
    page.getByText('Filename classification only.', { exact: false }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Keep as Attachments' }).click();

  await expect(page.getByText('care-sheet.pdf')).toBeVisible();
  await expect(page.getByText('helper.vcf')).toBeVisible();
  await expect(page.getByText('No file was uploaded or sent.')).toBeVisible();

  const attachmentDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download care-sheet.pdf' }).click();
  const attachment = await attachmentDownload;
  await expect(attachment.suggestedFilename()).toBe('care-sheet.pdf');
  await expect(await readDownload(attachment)).toBe('%PDF synthetic fixture');
});

test('provides an Owner guide with role, consequence, and file boundaries', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Guide' }).click();

  await expect(
    page.getByRole('heading', {
      name: 'Build a handoff someone can actually follow.',
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', {
      name: 'This build rehearses; it does not relay.',
    }),
  ).toBeVisible();
  await expect(
    page.getByText('Guardian Attestation first', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('HTML, SVG, scripts, executables', { exact: false }),
  ).toBeVisible();
});

test('keeps every primary view inside the documented responsive widths', async ({
  page,
}) => {
  for (const width of [320, 375, 414, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const view of ['Overview', 'Envelopes', 'Guide']) {
      await page.getByRole('button', { name: view, exact: true }).click();
      const viewport = await page.locator('body').evaluate((body) => ({
        clientWidth: body.clientWidth,
        scrollWidth: body.scrollWidth,
      }));
      expect(
        viewport.scrollWidth,
        `${view} should not overflow at ${width}px`,
      ).toBeLessThanOrEqual(viewport.clientWidth);
    }
  }
});

test('has no serious or critical automated accessibility violations', async ({
  page,
}) => {
  for (const view of ['Overview', 'Envelopes', 'Guide']) {
    await page.getByRole('button', { name: view, exact: true }).click();
    const results = await new AxeBuilder({ page }).analyze();
    const materialViolations = results.violations.filter(({ impact }) =>
      ['serious', 'critical'].includes(impact ?? ''),
    );

    expect(materialViolations, `${view} accessibility`).toEqual([]);
  }

  await page.getByRole('button', { name: 'Envelopes', exact: true }).click();
  const originalTitle = await page.getByLabel('Document title').inputValue();
  await page.getByRole('button', { name: 'Save version' }).click();
  await page.getByLabel('Document title').fill('Accessibility review draft');
  await page
    .getByRole('button', { name: `Review Version 1: ${originalTitle}` })
    .click();
  const dialogResults = await new AxeBuilder({ page }).analyze();
  const dialogViolations = dialogResults.violations.filter(({ impact }) =>
    ['serious', 'critical'].includes(impact ?? ''),
  );

  expect(dialogViolations, 'restore dialog accessibility').toEqual([]);
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
