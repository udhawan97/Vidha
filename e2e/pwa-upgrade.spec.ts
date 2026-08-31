import AxeBuilder from '@axe-core/playwright';
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from '@playwright/test';

const REHEARSAL_HEADERS = {
  'x-vidha-pwa-upgrade-rehearsal': 'phase-3p',
};
const SOURCE_BUILD_IDENTITY = 'phase-3p-source';
const REJECTED_BUILD_IDENTITY = 'phase-3p-rejected';
const TARGET_BUILD_IDENTITY = 'phase-3p-target';
const SOURCE_BUILD_LABEL = SOURCE_BUILD_IDENTITY.slice(0, 12);
const TARGET_BUILD_LABEL = TARGET_BUILD_IDENTITY.slice(0, 12);

async function switchBuild(
  request: APIRequestContext,
  build: 'rejected' | 'source' | 'target',
): Promise<void> {
  const response = await request.post(`/__vidha_pwa_upgrade/${build}`, {
    headers: REHEARSAL_HEADERS,
  });
  expect(response.ok()).toBe(true);
  expect(await response.json()).toEqual({ activeBuild: build });
}

async function requestUpdateAndWaitForInstallState(
  page: Page,
): Promise<ServiceWorkerState> {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return new Promise<ServiceWorkerState>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        reject(new Error('The service worker update did not settle in time.'));
      }, 10_000);
      let observedWorker: ServiceWorker | null = null;

      const finish = (state: ServiceWorkerState) => {
        window.clearTimeout(timeout);
        registration.removeEventListener('updatefound', observeUpdate);
        resolve(state);
      };
      const observeState = () => {
        const state = observedWorker?.state;
        if (state === 'installed' || state === 'redundant') finish(state);
      };
      const observeUpdate = () => {
        observedWorker = registration.installing;
        observedWorker?.addEventListener('statechange', observeState);
        observeState();
      };

      registration.addEventListener('updatefound', observeUpdate);
      void registration.update().then(observeUpdate, reject);
    });
  });
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
    rejectedBuildIdentity: REJECTED_BUILD_IDENTITY,
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
    `Build ${TARGET_BUILD_LABEL} and its controller agree.`,
  );
  await expect(receipt).toContainText(
    `changed from build ${SOURCE_BUILD_LABEL} to the expected build ${TARGET_BUILD_LABEL}`,
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

test('keeps the source rehearsal when an incomplete target precache is rejected', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await ensureControlled(page);
  await page.getByRole('button', { name: 'Envelopes' }).click();
  const title = page.getByLabel('Document title');
  await title.fill('Preserve this Phase 3P draft');

  await switchBuild(request, 'rejected');
  await expect(requestUpdateAndWaitForInstallState(page)).resolves.toBe(
    'redundant',
  );
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const registration = await navigator.serviceWorker.ready;
        return registration.waiting === null;
      }),
    )
    .toBe(true);
  await expect
    .poll(() => controllerBuildIdentity(page))
    .toBe(SOURCE_BUILD_IDENTITY);
  await expect(title).toHaveValue('Preserve this Phase 3P draft');
  await expect(page.getByText('A new build is ready.')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: /Review update|Update now/u }),
  ).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.sessionStorage.getItem('vidha.update-handoff.v1'),
      ),
    )
    .toBeNull();

  await switchBuild(request, 'target');
  await expect(requestUpdateAndWaitForInstallState(page)).resolves.toBe(
    'installed',
  );
  const updateStatus = page.getByLabel('Application update status');
  await expect(updateStatus).toContainText('A new build is ready.');
  await page.getByRole('button', { name: 'Review update' }).click();
  const confirmation = page.getByRole('dialog', {
    name: 'Update and clear this rehearsal?',
  });
  await expect(confirmation).toContainText('1 edited document');
  await expect(confirmation).toContainText('Preserve this Phase 3P draft');
  await confirmation
    .getByRole('button', { name: 'Update and clear session' })
    .click();

  await expect(
    page.getByLabel(
      new RegExp(
        `pre-alpha prototype with synthetic data\\. build ${TARGET_BUILD_IDENTITY}`,
        'i',
      ),
    ),
  ).toBeVisible();
  await expect(page.getByRole('status')).toContainText(
    `Build ${TARGET_BUILD_LABEL} and its controller agree.`,
  );
  await expect
    .poll(() => controllerBuildIdentity(page))
    .toBe(TARGET_BUILD_IDENTITY);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
