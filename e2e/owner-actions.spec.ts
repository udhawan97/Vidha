import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

async function armDemo(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Review rehearsal' }).click();
  await page.getByRole('button', { name: 'Run local rehearsal' }).click();
  await page.getByRole('button', { name: 'Arm rehearsal' }).click();
  await expect(page.getByText('Lifecycle: armed')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('contains Owner confirmations and serializes repeated activation', async ({
  page,
}) => {
  await armDemo(page);
  const trigger = page.getByRole('button', { name: 'Rehearse Check-in' });
  await trigger.click();

  const dialog = page.getByRole('dialog', {
    name: 'Confirm this rehearsal Check-in?',
  });
  const cancel = page.getByRole('button', { name: 'Go back' });
  const confirm = page.getByRole('button', { name: 'Confirm Check-in' });
  await expect(dialog).toBeVisible();
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(confirm).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(cancel).toBeFocused();

  const accessibility = await new AxeBuilder({ page }).analyze();
  const materialViolations = accessibility.violations.filter(({ impact }) =>
    ['serious', 'critical'].includes(impact ?? ''),
  );
  expect(materialViolations).toEqual([]);

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await trigger.click();
  await page
    .getByRole('button', { name: 'Confirm Check-in' })
    .evaluate((button) => {
      button.click();
      button.click();
    });
  await expect(
    page.getByRole('dialog', {
      name: 'Confirm this rehearsal Check-in?',
    }),
  ).toHaveCount(0);
  await expect(
    page.getByText('Authenticated Check-in recorded', { exact: true }),
  ).toHaveCount(1);
});

test('starts a clean disposable Draft without resuming the Disabled Plan', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Envelopes' }).click();
  await page.getByLabel('Document title').fill('Changed session');
  await page.getByLabel('Add Attachment candidates').setInputFiles({
    buffer: Buffer.from('%PDF-synthetic'),
    mimeType: 'application/pdf',
    name: 'cleared-on-restart.pdf',
  });
  await page.getByRole('button', { name: 'Keep as Attachments' }).click();
  await page.getByRole('button', { name: 'Save version' }).click();
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await armDemo(page);

  const disable = page.getByRole('button', { name: 'Disable rehearsal' });
  await disable.click();
  const disableDialog = page.getByRole('dialog', {
    name: 'Disable this rehearsal Plan?',
  });
  await expect(disableDialog).toContainText('this Plan will not resume');
  await expect(
    page.getByRole('button', { name: 'Keep rehearsal' }),
  ).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(disableDialog).toHaveCount(0);
  await expect(disable).toBeFocused();

  await disable.click();
  await page.getByRole('button', { name: 'Confirm disable' }).click();
  await expect(page.getByText('Lifecycle: disabled')).toBeVisible();

  await page.getByRole('button', { name: 'Envelopes' }).click();
  const endedWorkspace = page.getByRole('status', {
    name: 'Ended rehearsal workspace',
  });
  await expect(endedWorkspace).toContainText(
    'This ended rehearsal is read-only.',
  );
  await expect(page.getByLabel('Document title')).toHaveValue(
    'Changed session',
  );
  await expect(page.getByLabel('Document title')).toHaveAttribute('readonly');
  await expect(page.getByLabel('Envelope Markdown content')).toHaveAttribute(
    'readonly',
  );
  await expect(page.getByLabel('Recipient')).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Import editable text' }),
  ).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Add files' })).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Save version' }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: /Review Version 1/u }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Remove cleared-on-restart.pdf' }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Download cleared-on-restart.pdf' }),
  ).toBeEnabled();
  await expect(
    page.getByRole('button', { name: 'Download copy' }),
  ).toBeEnabled();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(
    await page.locator('body').evaluate((body) => body.scrollWidth),
  ).toBeLessThanOrEqual(
    await page.locator('body').evaluate((body) => body.clientWidth),
  );

  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await page
    .getByRole('button', { name: 'Start fresh local rehearsal' })
    .click();
  const restartDialog = page.getByRole('dialog', {
    name: 'Start a fresh local rehearsal?',
  });
  await expect(restartDialog).toContainText(
    'The Disabled Plan remains terminal.',
  );
  await expect(restartDialog).toContainText('1 edited document');
  await expect(restartDialog).toContainText('1 Attachment');
  await expect(restartDialog).toContainText('1 Document Version');
  await expect(restartDialog).toContainText(/undo\/redo steps/u);
  await expect(restartDialog).toContainText(/local Plan events/u);
  await expect(
    page.getByRole('button', { name: 'Keep ended rehearsal' }),
  ).toBeFocused();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(
    await page.locator('body').evaluate((body) => body.scrollWidth),
  ).toBeLessThanOrEqual(
    await page.locator('body').evaluate((body) => body.clientWidth),
  );

  await page.getByRole('button', { name: 'Review Envelope' }).click();
  await expect(restartDialog).toHaveCount(0);
  await expect(page.getByLabel('Document title')).toHaveValue(
    'Changed session',
  );

  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await page
    .getByRole('button', { name: 'Start fresh local rehearsal' })
    .click();
  await page.getByRole('button', { name: 'Start fresh rehearsal' }).click();

  await expect(page.getByText('Lifecycle: draft')).toBeVisible();
  await expect(page.getByText('Synthetic Plan drafted')).toBeVisible();
  await expect(page.getByText('Rehearsal plan disabled')).toHaveCount(0);
  await page.getByRole('button', { name: 'Envelopes' }).click();
  await expect(page.getByLabel('Document title')).toHaveValue(
    'The house, without guesswork',
  );
  await expect(page.getByText('cleared-on-restart.pdf')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: /Review Version/u }),
  ).toHaveCount(0);
  await expect(page.getByText('0/8')).toBeVisible();
});
