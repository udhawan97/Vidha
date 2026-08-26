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
  await page
    .getByRole('button', { name: 'Start fresh local rehearsal' })
    .click();
  const restartDialog = page.getByRole('dialog', {
    name: 'Start a fresh local rehearsal?',
  });
  await expect(restartDialog).toContainText(
    'The Disabled Plan remains terminal.',
  );
  await expect(
    page.getByRole('button', { name: 'Keep ended rehearsal' }),
  ).toBeFocused();
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
