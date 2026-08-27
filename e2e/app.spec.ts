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
  await page.getByRole('button', { name: 'Review rehearsal' }).click();
  await expect(
    page.getByRole('dialog', {
      name: 'Review what this local rehearsal will test',
    }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Run local rehearsal' }).click();
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

test('reviews the bounded Draft run-sheet and invalidates it after an edit', async ({
  page,
}) => {
  const review = page.getByRole('button', { name: 'Review rehearsal' });
  await review.click();
  const dialog = page.getByRole('dialog', {
    name: 'Review what this local rehearsal will test',
  });
  await expect(dialog).toContainText('Day 25Reminder begins');
  await expect(dialog).toContainText('Day 30Check-in due');
  await expect(dialog).toContainText('Day 37Concern may begin');
  await expect(dialog).toContainText('3notice previews0messages sent');
  await expect(dialog).toContainText(
    'No private Envelope content is included.',
  );
  const keepDraft = page.getByRole('button', { name: 'Keep Draft' });
  const runRehearsal = page.getByRole('button', {
    name: 'Run local rehearsal',
  });
  await expect(dialog).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(runRehearsal).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(keepDraft).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(runRehearsal).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(keepDraft).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(review).toBeFocused();

  await review.click();
  await runRehearsal.click();
  await expect(
    page.getByRole('button', { name: 'Arm rehearsal' }),
  ).toBeVisible();
  await expect(page.getByText('Locally rehearsed')).toBeVisible();

  await page.getByRole('button', { name: 'Envelopes' }).click();
  await page
    .getByLabel('Envelope Markdown content')
    .fill('# Changed after local rehearsal');
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Review changes' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Arm rehearsal' })).toHaveCount(
    0,
  );
});

test('invalidates an accepted review when an Attachment is added or removed', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Review rehearsal' }).click();
  await page.getByRole('button', { name: 'Run local rehearsal' }).click();
  await expect(
    page.getByRole('button', { name: 'Arm rehearsal' }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Envelopes' }).click();
  await page.getByLabel('Add Attachment candidates').setInputFiles({
    buffer: Buffer.from('%PDF review identity fixture'),
    mimeType: 'application/pdf',
    name: 'review-identity.pdf',
  });
  await page.getByRole('button', { name: 'Keep as Attachments' }).click();
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Review changes' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Arm rehearsal' })).toHaveCount(
    0,
  );

  await page.getByRole('button', { name: 'Review changes' }).click();
  await page.getByRole('button', { name: 'Run local rehearsal' }).click();
  await expect(
    page.getByRole('button', { name: 'Arm rehearsal' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Envelopes' }).click();
  await page
    .getByRole('button', { name: 'Remove review-identity.pdf' })
    .click();
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Review changes' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Arm rehearsal' })).toHaveCount(
    0,
  );
});

test('keeps the rehearsal review completion reachable at 375px', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByRole('button', { name: 'Review rehearsal' }).click();
  const complete = page.getByRole('button', { name: 'Run local rehearsal' });
  await complete.scrollIntoViewIfNeeded();
  const completeBox = await complete.boundingBox();
  const viewport = await page.locator('body').evaluate((body) => ({
    clientWidth: body.clientWidth,
    scrollWidth: body.scrollWidth,
  }));

  expect(completeBox).not.toBeNull();
  expect(completeBox!.y + completeBox!.height).toBeLessThanOrEqual(812);
  expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth);
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
    .getByRole('button', { name: 'Review rehearsal' })
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

test('has no automated accessibility violations', async ({ page }) => {
  for (const view of ['Overview', 'Envelopes', 'Guide']) {
    await page.getByRole('button', { name: view, exact: true }).click();
    const results = await new AxeBuilder({ page }).analyze();

    expect(results.violations, `${view} accessibility`).toEqual([]);
  }

  await page.getByRole('button', { name: 'Envelopes', exact: true }).click();
  const originalTitle = await page.getByLabel('Document title').inputValue();
  await page.getByRole('button', { name: 'Save version' }).click();
  await page.getByLabel('Document title').fill('Accessibility review draft');
  await page
    .getByRole('button', { name: `Review Version 1: ${originalTitle}` })
    .click();
  const dialogResults = await new AxeBuilder({ page }).analyze();

  expect(dialogResults.violations, 'restore dialog accessibility').toEqual([]);

  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await page.getByRole('button', { name: 'Review rehearsal' }).click();
  const rehearsalDialogResults = await new AxeBuilder({ page }).analyze();

  expect(
    rehearsalDialogResults.violations,
    'rehearsal review dialog accessibility',
  ).toEqual([]);
});

test('uses the courier mark and stops its continuity-line motion when requested', async ({
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

  for (const asset of [
    '/vidha-mark.svg',
    '/vidha-mark-reversed.svg',
    '/vidha-mark-maskable.svg',
  ]) {
    await page.goto(asset);
    await expect(page.locator('title')).toContainText('working-concept');
    await expect(page.locator('desc')).toContainText('clearance');
    await expect(
      page.locator('script, style, foreignObject, a, image, use'),
    ).toHaveCount(0);
    expect(
      await page
        .locator('*')
        .evaluateAll((elements) =>
          elements.some((element) =>
            element.getAttributeNames().some((name) => name.startsWith('on')),
          ),
        ),
    ).toBe(false);
    if (asset === '/vidha-mark-maskable.svg') {
      await expect(page.locator('svg > g')).toHaveAttribute(
        'transform',
        'translate(30 35) scale(.5)',
      );
    }
  }

  await page.goto('/');
  await armDemo(page);
  const courier = page.locator('.continuity-courier');
  await expect(courier).toBeVisible();
  await expect
    .poll(() =>
      courier.evaluate((element) => getComputedStyle(element).animationName),
    )
    .toContain('courier-bob');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect
    .poll(() =>
      courier.evaluate(
        (element) => getComputedStyle(element).animationIterationCount,
      ),
    )
    .toBe('1');
  const reducedFrame = await courier.screenshot();
  await page.waitForTimeout(500);
  expect((await courier.screenshot()).equals(reducedFrame)).toBe(true);
});

test('keeps every mobile courier stage aligned, visible, and keyboard reachable', async ({
  page,
}) => {
  for (const width of [320, 414]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/');
    await armDemo(page);
    const scrollRegion = page.locator('.continuity-scroll');
    await expect(scrollRegion).toHaveAttribute('tabindex', '0');

    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    });
    let reachedTimeline = false;
    for (let tabIndex = 0; tabIndex < 12; tabIndex += 1) {
      await page.keyboard.press('Tab');
      reachedTimeline = await scrollRegion.evaluate(
        (element) => document.activeElement === element,
      );
      if (reachedTimeline) break;
    }
    expect(reachedTimeline).toBe(true);
    await scrollRegion.evaluate((element) => {
      element.scrollTo({ behavior: 'auto', left: 0 });
    });
    await expect
      .poll(() => scrollRegion.evaluate((element) => element.scrollLeft))
      .toBe(0);
    const initialScroll = await scrollRegion.evaluate(
      (element) => element.scrollLeft,
    );
    await page.keyboard.press('ArrowRight');
    await expect
      .poll(() => scrollRegion.evaluate((element) => element.scrollLeft))
      .toBeGreaterThan(initialScroll);
    await scrollRegion.evaluate((element) => {
      element.scrollTo({ behavior: 'auto', left: 0 });
    });

    for (let stageIndex = 0; stageIndex < 4; stageIndex += 1) {
      const courier = page.locator('.continuity-courier');
      const currentKnot = page.locator(
        '.continuity-point.is-current .continuity-knot',
      );
      await expect(courier).toHaveCount(1);
      await expect(currentKnot).toHaveCount(1);
      await expect
        .poll(async () => {
          const courierBox = await courier.boundingBox();
          const knotBox = await currentKnot.boundingBox();
          if (courierBox === null || knotBox === null) {
            return Number.POSITIVE_INFINITY;
          }
          return Math.abs(
            courierBox.x +
              courierBox.width / 2 -
              (knotBox.x + knotBox.width / 2),
          );
        })
        .toBeLessThanOrEqual(2);

      for (const element of [currentKnot, courier]) {
        await expect
          .poll(() =>
            element.evaluate((node) => {
              const region = node.closest('.continuity-scroll');
              if (region === null) return false;
              const nodeBox = node.getBoundingClientRect();
              const regionBox = region.getBoundingClientRect();
              return (
                nodeBox.left >= regionBox.left &&
                nodeBox.right <= regionBox.right
              );
            }),
          )
          .toBe(true);
      }

      if (stageIndex < 3) {
        await page.getByRole('button', { name: 'Advance one stage' }).click();
      }
    }
  }
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

test('protects accepted session work from an ordinary reload', async ({
  page,
}) => {
  expect(
    await page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    }),
  ).toBe(false);

  await page.getByRole('button', { name: 'Envelopes' }).click();
  await page.getByLabel('Document title').fill('Changed session title');

  expect(
    await page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    }),
  ).toBe(true);
});

test('detects separate rehearsal tabs and clears the warning when a peer leaves', async ({
  context,
  page,
}) => {
  const peer = await context.newPage();
  await peer.goto('/');

  const firstTabNotice = page.getByRole('complementary', {
    name: 'Multi-tab rehearsal status',
  });
  const secondTabNotice = peer.getByRole('complementary', {
    name: 'Multi-tab rehearsal status',
  });
  await expect(firstTabNotice).toContainText('Another rehearsal tab is open.');
  await expect(secondTabNotice).toContainText('Another rehearsal tab is open.');

  await peer.getByRole('button', { name: 'Envelopes' }).click();
  await peer.getByLabel('Document title').fill('Changed in the second tab');
  await expect(firstTabNotice).toContainText(
    'Another tab contains changed rehearsal work.',
  );
  await expect(firstTabNotice).toContainText('Tabs do not synchronize.');
  await expect(firstTabNotice).toContainText(
    'Only tab presence and content-free work/action flags are shared.',
  );
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(
    await page.locator('body').evaluate((body) => body.scrollWidth),
  ).toBeLessThanOrEqual(
    await page.locator('body').evaluate((body) => body.clientWidth),
  );

  await peer.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide'));
  });
  await peer.close();
  await expect(firstTabNotice).toHaveCount(0);
});
