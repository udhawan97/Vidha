import AxeBuilder from '@axe-core/playwright';
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from '@playwright/test';

const REHEARSAL_HEADERS = {
  'x-vidha-pwa-upgrade-rehearsal': 'phase-3o',
};
const SOURCE_BUILD_IDENTITY = 'phase-3o-source';
const TARGET_BUILD_IDENTITY = 'phase-3o-target';

async function switchBuild(
  request: APIRequestContext,
  build: 'source' | 'target',
): Promise<void> {
  const response = await request.post(`/__vidha_pwa_upgrade/${build}`, {
    headers: REHEARSAL_HEADERS,
  });
  expect(response.ok()).toBe(true);
  expect(await response.json()).toEqual({ activeBuild: build });
}

async function ensureControlled(page: Page): Promise<void> {
  await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) {
      throw new Error('Service workers are unavailable in this browser.');
    }
    await navigator.serviceWorker.ready;
  });
  if (
    !(await page.evaluate(() => navigator.serviceWorker.controller !== null))
  ) {
    await page.reload();
  }
  await expect
    .poll(() =>
      page.evaluate(() => navigator.serviceWorker.controller !== null),
    )
    .toBe(true);
}

async function controllerBuildIdentity(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const controller = navigator.serviceWorker.controller;
    if (controller === null) {
      throw new Error('No controlling service worker is available.');
    }
    return new Promise<string>((resolve, reject) => {
      const channel = new MessageChannel();
      const timeout = window.setTimeout(() => {
        channel.port1.close();
        reject(new Error('The service worker identity request timed out.'));
      }, 5_000);
      channel.port1.onmessage = (event: MessageEvent<unknown>) => {
        window.clearTimeout(timeout);
        channel.port1.close();
        const response = event.data as { buildIdentity?: unknown };
        if (typeof response.buildIdentity !== 'string') {
          reject(
            new Error('The service worker identity response was invalid.'),
          );
          return;
        }
        resolve(response.buildIdentity);
      };
      channel.port1.start();
      controller.postMessage(
        {
          protocol: 'vidha.service-worker-identity.v1',
          type: 'identify-service-worker',
        },
        [channel.port2],
      );
    });
  });
}

test.beforeEach(async ({ request }) => {
  await switchBuild(request, 'source');
});

test('rehearses a real old-build to waiting-new-build Update Handoff', async ({
  page,
  request,
}) => {
  const unauthenticatedSwitch = await request.post(
    '/__vidha_pwa_upgrade/target',
  );
  expect(unauthenticatedSwitch.status()).toBe(404);
  const readOnlySwitch = await request.get('/__vidha_pwa_upgrade/target', {
    headers: REHEARSAL_HEADERS,
  });
  expect(readOnlySwitch.status()).toBe(404);
  const traversal = await request.get('/%2e%2e/package.json');
  expect(traversal.status()).toBe(404);
  const status = await request.get('/__vidha_pwa_upgrade/status');
  expect(await status.json()).toEqual({
    activeBuild: 'source',
    sourceBuildIdentity: SOURCE_BUILD_IDENTITY,
    targetBuildIdentity: TARGET_BUILD_IDENTITY,
  });

  await page.goto('/');
  await ensureControlled(page);
  await expect(
    page.getByLabel(
      new RegExp(
        `pre-alpha prototype with synthetic data\\. build ${SOURCE_BUILD_IDENTITY}`,
        'i',
      ),
    ),
  ).toBeVisible();
  await expect
    .poll(() => controllerBuildIdentity(page))
    .toBe(SOURCE_BUILD_IDENTITY);

  await switchBuild(request, 'target');
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    await registration.update();
  });

  const updateStatus = page.getByLabel('Application update status');
  await expect(updateStatus).toContainText('A new build is ready.');
  const updateButton = page.getByRole('button', { name: 'Update now' });
  await expect(updateButton).toBeEnabled();
  await updateButton.click();

  await expect(
    page.getByLabel(
      new RegExp(
        `pre-alpha prototype with synthetic data\\. build ${TARGET_BUILD_IDENTITY}`,
        'i',
      ),
    ),
  ).toBeVisible();
  const receipt = page.getByRole('status');
  await expect(receipt).toContainText(
    'Build phase-3o-tar and its controller agree.',
  );
  await expect(receipt).toContainText(
    'changed from build phase-3o-sou to the expected build phase-3o-tar',
  );
  await expect(receipt).toContainText(
    'does not inspect cache entries or asset bytes',
  );
  await expect
    .poll(() => controllerBuildIdentity(page))
    .toBe(TARGET_BUILD_IDENTITY);
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.sessionStorage.getItem('vidha.update-handoff.v1'),
      ),
    )
    .toBeNull();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
