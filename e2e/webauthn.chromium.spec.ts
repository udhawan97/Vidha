import { expect, test, type BrowserContext } from '@playwright/test';

const cookieName = '__Host-vidha_session';

test('completes WebAuthn, rotates the opaque cookie, rejects replay, and revokes', async ({
  baseURL,
  browserName,
  context,
  page,
}) => {
  test.skip(
    browserName !== 'chromium',
    'CDP virtual authenticators are Chromium-only.',
  );
  if (baseURL === undefined) throw new Error('Expected the fixture origin.');
  const capability = process.env.VIDHA_WEBAUTHN_CAPABILITY;
  if (capability === undefined) {
    throw new Error('VIDHA_WEBAUTHN_CAPABILITY is required.');
  }

  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      automaticPresenceSimulation: true,
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      protocol: 'ctap2',
      transport: 'internal',
    },
  });

  const verificationBodies: unknown[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/authentication/verify')) {
      verificationBodies.push(request.postDataJSON());
    }
  });

  await page.goto('/rehearsal/webauthn');
  await page.getByLabel('Bootstrap capability').fill(capability);
  await page.getByRole('button', { name: 'Create credential' }).click();
  await expect(page.getByRole('status')).toContainText('Credential ready');
  await page.reload();
  await expect(page.getByRole('status')).toContainText('Credential ready');
  await expect(page.getByLabel('Bootstrap capability')).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Create credential' }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Authenticate', exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole('button', { name: 'Check session' }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'End session' }),
  ).toBeDisabled();

  await page.getByRole('button', { name: 'Authenticate', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Session active');
  const firstCookie = await sessionCookie(context);
  expect(firstCookie.httpOnly).toBe(true);
  expect(firstCookie.secure).toBe(true);
  expect(firstCookie.sameSite).toBe('Strict');
  await expect
    .poll(async () => await page.evaluate(() => document.cookie))
    .not.toContain(cookieName);
  await page.reload();
  await expect(page.getByRole('status')).toContainText(
    'Session restored from its HttpOnly cookie',
  );
  await expect(
    page.getByRole('button', { name: 'Create credential' }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Authenticate', exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole('button', { name: 'Check session' }),
  ).toBeEnabled();
  await expect(page.getByRole('button', { name: 'End session' })).toBeEnabled();

  const csrfDenied = await page.evaluate(async () => {
    const response = await fetch('/v1/identity/session/revoke', {
      body: '{}',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    return { body: await response.json(), status: response.status };
  });
  expect(csrfDenied).toEqual({ body: { status: 'csrf_denied' }, status: 403 });

  const firstVerification = verificationBodies[0];
  if (firstVerification === undefined) {
    throw new Error('Expected an authentication verification request.');
  }
  const replay = await context.request.post(
    '/v1/identity/webauthn/authentication/verify',
    {
      data: firstVerification,
      headers: { origin: baseURL },
    },
  );
  expect(replay.status()).toBe(403);
  await expect(replay.json()).resolves.toEqual({
    status: 'authentication_denied',
  });

  await page.getByRole('button', { name: 'Authenticate', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Session active');
  const secondCookie = await sessionCookie(context);
  expect(secondCookie.value).not.toBe(firstCookie.value);

  const oldAuthority = await fetch(`${baseURL}/v1/identity/session`, {
    headers: { cookie: `${cookieName}=${firstCookie.value}` },
  });
  expect(oldAuthority.status).toBe(401);

  await page.getByRole('button', { name: 'Check session' }).click();
  await expect(page.getByRole('status')).toContainText('Session is active');
  await page.getByRole('button', { name: 'End session' }).click();
  await expect(page.getByRole('status')).toContainText('Session ended');

  const ended = await context.request.get('/v1/identity/session');
  expect(ended.status()).toBe(401);
  expect(
    (await context.cookies(baseURL)).find(
      (cookie) => cookie.name === cookieName,
    ),
  ).toBeUndefined();
});

async function sessionCookie(context: BrowserContext) {
  const cookie = (await context.cookies()).find(
    (candidate) => candidate.name === cookieName,
  );
  if (cookie === undefined)
    throw new Error('Expected the HttpOnly session cookie.');
  return cookie;
}
