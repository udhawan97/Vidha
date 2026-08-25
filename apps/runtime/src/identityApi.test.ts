import { createHash } from 'node:crypto';
import { createServer, request as httpRequest, type Server } from 'node:http';

import {
  createMemoryOwnerIdentityRepository,
  createMemoryWebAuthnStateStore,
  simpleWebAuthnServerAdapter,
  type WebAuthnServerAdapter,
} from '@vidha/identity';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createIdentityRehearsalHandler,
  type IdentityRehearsalHandler,
} from './identityApi';

const START = Date.parse('2026-08-25T12:00:00.000Z');
const OWNER_ID = `owner_${'a'.repeat(64)}`;
const CHANNEL = `channel_${'b'.repeat(64)}`;
const CAPABILITY = 'disposable-capability-with-at-least-256-bits-of-entropy';
const CREDENTIAL_ID = 'disposable-credential';
const FIRST_SESSION = `session_${'1'.repeat(64)}`;
const SECOND_SESSION = `session_${'2'.repeat(64)}`;
const THIRD_SESSION = `session_${'3'.repeat(64)}`;

interface TestResponse {
  readonly body: Record<string, unknown>;
  readonly headers: Readonly<Record<string, string | readonly string[]>>;
  readonly status: number;
}

describe('disposable identity HTTP boundary', () => {
  let server: Server;
  let handler: IdentityRehearsalHandler;
  let origin: string;
  let port: number;
  let now = START;
  const sessions = [FIRST_SESSION, SECOND_SESSION, THIRD_SESSION];

  beforeAll(async () => {
    server = createServer(async (request, response) => {
      if (!(await handler.handle(request, response))) {
        response.writeHead(404).end(JSON.stringify({ status: 'not_found' }));
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Expected a TCP fixture address.');
    }
    port = address.port;
    origin = `http://localhost:${port}`;
    handler = createIdentityRehearsalHandler({
      bootstrapCapabilityDigest: sha256(CAPABILITY),
      clock: { now: () => now },
      csrfSecret: 'csrf-fixture-secret-with-more-than-thirty-two-characters',
      identityRepository: createMemoryOwnerIdentityRepository(),
      publicOrigin: origin,
      rpId: 'localhost',
      sessionIdGenerator: () => {
        const session = sessions.shift();
        if (session === undefined)
          throw new Error('No queued fixture session.');
        return session;
      },
      verifiedChannelRef: CHANNEL,
      webAuthnAdapter: fixtureAdapter,
      webAuthnStore: createMemoryWebAuthnStateStore(),
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) =>
        error === undefined ? resolve() : reject(error),
      ),
    );
  });

  it('binds bootstrap, authentication, cookie rotation, CSRF, revocation, and expiry', async () => {
    const page = await send({ method: 'GET', path: '/rehearsal/webauthn' });
    expect(page.status).toBe(200);
    expect(page.headers['content-security-policy']).toContain(
      "default-src 'none'",
    );
    expect(page.bodyText).toContain('synthetic identity only');
    expect(page.bodyText).toContain('No fallback shortcut.');
    expect(page.bodyText).toContain('There is no in-place reset.');
    expect(page.bodyText).toMatch(/Verified Owner\s+Channel delivery\./u);

    await expect(
      sendJson({ method: 'GET', path: '/rehearsal/webauthn/status' }),
    ).resolves.toMatchObject({
      body: {
        credentialReady: false,
        recoveryAvailable: false,
        sessionActive: false,
        verifiedChannelDeliveryAvailable: false,
      },
      status: 200,
    });

    const missingOrigin = await sendJson({
      body: { bootstrapCapability: CAPABILITY, ownerId: OWNER_ID },
      includeOrigin: false,
      path: '/v1/identity/webauthn/bootstrap/options',
    });
    expect(missingOrigin).toMatchObject({
      body: { status: 'origin_denied' },
      status: 403,
    });

    await expect(
      sendJson({
        body: {
          bootstrapCapability: CAPABILITY,
          ownerId: `owner_${'f'.repeat(64)}`,
        },
        path: '/v1/identity/webauthn/bootstrap/options',
      }),
    ).resolves.toMatchObject({
      body: { status: 'invalid_rehearsal_owner' },
      status: 400,
    });

    const firstBootstrap = await bootstrapOptions();
    const secondBootstrap = await bootstrapOptions();
    await expectBootstrapVerified(firstBootstrap, 201);
    await expect(
      sendJson({ method: 'GET', path: '/rehearsal/webauthn/status' }),
    ).resolves.toMatchObject({
      body: { credentialReady: true, sessionActive: false },
      status: 200,
    });
    await expectBootstrapVerified(secondBootstrap, 403);
    await expect(bootstrapOptions()).resolves.toMatchObject({
      body: { status: 'authentication_denied' },
      status: 403,
    });

    const firstAuthentication = await authenticate();
    const firstCookie = cookie(firstAuthentication);
    const firstSetCookie = setCookieHeader(firstAuthentication);
    expect(firstSetCookie).toContain('HttpOnly');
    expect(firstSetCookie).toContain('Secure');
    expect(firstSetCookie).toContain('SameSite=Strict');
    await expect(
      sendJson({
        cookie: firstCookie,
        method: 'GET',
        path: '/rehearsal/webauthn/status',
      }),
    ).resolves.toMatchObject({
      body: { credentialReady: true, sessionActive: true },
      status: 200,
    });

    const active = await sendJson({
      cookie: firstCookie,
      method: 'GET',
      path: '/v1/identity/session',
    });
    expect(active).toMatchObject({
      body: {
        csrfToken: expect.any(String),
        principal: { principalId: OWNER_ID, role: 'owner' },
        status: 'session_active',
      },
      status: 200,
    });

    const duplicateCookie = await sendJson({
      cookie: `${firstCookie}; ${firstCookie}`,
      method: 'GET',
      path: '/v1/identity/session',
    });
    expect(duplicateCookie).toMatchObject({
      body: { status: 'session_inactive' },
      status: 401,
    });

    const rotation = await authenticate(firstCookie);
    const secondCookie = cookie(rotation);
    expect(secondCookie).not.toBe(firstCookie);
    await expectSession(firstCookie, 401);
    await expectSession(secondCookie, 200);

    const missingCsrf = await sendJson({
      body: {},
      cookie: secondCookie,
      path: '/v1/identity/session/revoke',
    });
    expect(missingCsrf).toMatchObject({
      body: { status: 'csrf_denied' },
      status: 403,
    });

    const csrf = rotation.body.csrfToken;
    if (typeof csrf !== 'string') throw new Error('Expected a CSRF fixture.');
    const revoked = await sendJson({
      body: {},
      cookie: secondCookie,
      csrf,
      path: '/v1/identity/session/revoke',
    });
    expect(revoked).toMatchObject({
      body: { status: 'session_revoked' },
      status: 200,
    });
    await expectSession(secondCookie, 401);
    await expect(
      sendJson({
        cookie: secondCookie,
        method: 'GET',
        path: '/rehearsal/webauthn/status',
      }),
    ).resolves.toMatchObject({
      body: { credentialReady: true, sessionActive: false },
      status: 200,
    });

    const expiring = await authenticate();
    const thirdCookie = cookie(expiring);
    now += 900_001;
    await expectSession(thirdCookie, 401);
  });

  async function bootstrapOptions(): Promise<TestResponse> {
    return await sendJson({
      body: { bootstrapCapability: CAPABILITY, ownerId: OWNER_ID },
      path: '/v1/identity/webauthn/bootstrap/options',
    });
  }

  async function expectBootstrapVerified(
    started: TestResponse,
    expectedStatus: number,
  ): Promise<void> {
    const options = record(started.body.options);
    const result = await sendJson({
      body: {
        ceremonyId: started.body.ceremonyId,
        response: registrationResponse(requiredString(options, 'challenge')),
      },
      path: '/v1/identity/webauthn/bootstrap/verify',
    });
    expect(result.status).toBe(expectedStatus);
  }

  async function authenticate(existingCookie?: string): Promise<TestResponse> {
    const started = await sendJson({
      body: { ownerId: OWNER_ID },
      path: '/v1/identity/webauthn/authentication/options',
    });
    const options = record(started.body.options);
    return await sendJson({
      body: {
        ceremonyId: started.body.ceremonyId,
        response: authenticationResponse(requiredString(options, 'challenge')),
      },
      ...(existingCookie === undefined ? {} : { cookie: existingCookie }),
      path: '/v1/identity/webauthn/authentication/verify',
    });
  }

  async function expectSession(
    sessionCookie: string,
    expectedStatus: number,
  ): Promise<void> {
    await expect(
      sendJson({
        cookie: sessionCookie,
        method: 'GET',
        path: '/v1/identity/session',
      }),
    ).resolves.toMatchObject({ status: expectedStatus });
  }

  function sendJson(input: {
    readonly body?: Readonly<Record<string, unknown>>;
    readonly cookie?: string;
    readonly csrf?: string;
    readonly includeOrigin?: boolean;
    readonly method?: 'GET' | 'POST';
    readonly path: string;
  }): Promise<TestResponse> {
    const body =
      input.body === undefined ? undefined : JSON.stringify(input.body);
    return send({
      ...(body === undefined ? {} : { body }),
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(input.cookie === undefined ? {} : { cookie: input.cookie }),
        ...(input.csrf === undefined ? {} : { 'x-vidha-csrf': input.csrf }),
        ...(input.includeOrigin === false ? {} : { origin }),
      },
      method: input.method ?? 'POST',
      path: input.path,
    }).then((response) => ({
      body: JSON.parse(response.bodyText) as Record<string, unknown>,
      headers: response.headers,
      status: response.status,
    }));
  }

  function send(input: {
    readonly body?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly method: 'GET' | 'POST';
    readonly path: string;
  }): Promise<{
    readonly bodyText: string;
    readonly headers: Readonly<Record<string, string | readonly string[]>>;
    readonly status: number;
  }> {
    return new Promise((resolve, reject) => {
      const body = input.body ?? '';
      const request = httpRequest(
        {
          headers: {
            host: `localhost:${port}`,
            ...(body.length === 0
              ? {}
              : { 'content-length': String(Buffer.byteLength(body)) }),
            ...input.headers,
          },
          hostname: '127.0.0.1',
          method: input.method,
          path: input.path,
          port,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            const headers: Record<string, string | readonly string[]> = {};
            for (const [name, value] of Object.entries(response.headers)) {
              if (value !== undefined) headers[name] = value;
            }
            resolve({
              bodyText: Buffer.concat(chunks).toString('utf8'),
              headers,
              status: response.statusCode ?? 0,
            });
          });
        },
      );
      request.on('error', reject);
      request.end(body);
    });
  }
});

const fixtureAdapter: WebAuthnServerAdapter = {
  ...simpleWebAuthnServerAdapter,
  async verifyRegistration(input) {
    return {
      credential: {
        counter: 0,
        id: input.response.id,
        publicKey: new Uint8Array([1, 2, 3]),
        transports: ['internal'],
      },
      userVerified: true,
      verified: await input.challengeMatches(
        challengeFrom(input.response.response.clientDataJSON),
      ),
    };
  },
  async verifyAuthentication(input) {
    return {
      newCounter: input.credential.counter + 1,
      userVerified: true,
      verified: await input.challengeMatches(
        challengeFrom(input.response.response.clientDataJSON),
      ),
    };
  },
};

function registrationResponse(challenge: string) {
  return {
    clientExtensionResults: {},
    id: CREDENTIAL_ID,
    rawId: CREDENTIAL_ID,
    response: {
      attestationObject: 'fixture',
      clientDataJSON: clientData(challenge),
      transports: ['internal'],
    },
    type: 'public-key',
  } as const;
}

function authenticationResponse(challenge: string) {
  return {
    clientExtensionResults: {},
    id: CREDENTIAL_ID,
    rawId: CREDENTIAL_ID,
    response: {
      authenticatorData: 'fixture',
      clientDataJSON: clientData(challenge),
      signature: 'fixture',
    },
    type: 'public-key',
  } as const;
}

function clientData(challenge: string): string {
  return Buffer.from(JSON.stringify({ challenge }), 'utf8').toString(
    'base64url',
  );
}

function challengeFrom(clientDataJson: string): string {
  const value: unknown = JSON.parse(
    Buffer.from(clientDataJson, 'base64url').toString('utf8'),
  );
  return requiredString(record(value), 'challenge');
}

function cookie(response: TestResponse): string {
  const first = setCookieHeader(response).split(';')[0];
  if (first === undefined) throw new Error('Expected a session cookie value.');
  return first;
}

function setCookieHeader(response: TestResponse): string {
  const header = response.headers['set-cookie'];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string') throw new Error('Expected a session cookie.');
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected an object fixture.');
  }
  return value as Record<string, unknown>;
}

function requiredString(
  value: Readonly<Record<string, unknown>>,
  key: string,
): string {
  const result = value[key];
  if (typeof result !== 'string') throw new Error(`Expected ${key}.`);
  return result;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
