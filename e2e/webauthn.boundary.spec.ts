import { expect, test } from '@playwright/test';

test('keeps the disposable identity surface same-origin and non-claiming', async ({
  page,
  request,
}) => {
  const response = await page.goto('/rehearsal/webauthn');
  expect(response?.status()).toBe(200);
  expect(response?.headers()['content-security-policy']).toContain(
    "default-src 'none'",
  );
  expect(response?.headers()['permissions-policy']).toContain(
    'publickey-credentials-get=(self)',
  );
  await expect(page).toHaveTitle('Vidha credential boundary rehearsal');
  await expect(
    page.getByText('Disposable loopback rehearsal · synthetic identity only'),
  ).toBeVisible();
  await expect(page.locator('.lede')).toContainText(
    'It does not create a real Vidha account or contact anyone.',
  );

  const geometry = await page.evaluate(() => ({
    body: document.body.scrollWidth,
    viewport: document.documentElement.clientWidth,
  }));
  expect(geometry.body).toBeLessThanOrEqual(geometry.viewport);
  await page.setViewportSize({ height: 812, width: 375 });
  const mobileGeometry = await page.evaluate(() => ({
    body: document.body.scrollWidth,
    viewport: document.documentElement.clientWidth,
  }));
  expect(mobileGeometry.body).toBeLessThanOrEqual(mobileGeometry.viewport);

  const session = await request.get('/v1/identity/session');
  expect(session.status()).toBe(401);
  await expect(session.json()).resolves.toEqual({ status: 'session_inactive' });

  const noOrigin = await request.post(
    '/v1/identity/webauthn/bootstrap/options',
    {
      data: {
        bootstrapCapability: 'not-authorized',
        ownerId: `owner_${'a'.repeat(64)}`,
      },
    },
  );
  expect(noOrigin.status()).toBe(403);
  await expect(noOrigin.json()).resolves.toEqual({ status: 'origin_denied' });

  const readOnlyMutation = await request.get('/v1/identity/session/revoke');
  expect(readOnlyMutation.status()).toBe(405);
  await expect(readOnlyMutation.json()).resolves.toEqual({
    status: 'method_not_allowed',
  });
});
