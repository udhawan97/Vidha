import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { describe, expect, it } from 'vitest';

import {
  createMemoryWebAuthnStateStore,
  createWebAuthnCeremonyCoordinator,
  simpleWebAuthnServerAdapter,
  type WebAuthnServerAdapter,
  type WebAuthnStateStore,
} from './webauthn';

const START = Date.parse('2026-08-21T12:00:00.000Z');
const OWNER_ID = `owner_${'a'.repeat(64)}`;
const RAW_CREDENTIAL_ID = 'credential-public-id';
const CAPABILITY = 'bootstrap-capability-with-256-bits-of-fixture-entropy';

const registrationResponse: RegistrationResponseJSON = {
  id: RAW_CREDENTIAL_ID,
  rawId: RAW_CREDENTIAL_ID,
  type: 'public-key',
  clientExtensionResults: {},
  response: {
    attestationObject: 'fixture',
    clientDataJSON: 'fixture',
  },
};

const authenticationResponse: AuthenticationResponseJSON = {
  id: RAW_CREDENTIAL_ID,
  rawId: RAW_CREDENTIAL_ID,
  type: 'public-key',
  clientExtensionResults: {},
  response: {
    authenticatorData: 'fixture',
    clientDataJSON: 'fixture',
    signature: 'fixture',
  },
};

async function digest(value: string): Promise<string> {
  const result = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(result)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function setup(input?: {
  readonly configurationRevision?: number;
  readonly store?: WebAuthnStateStore;
}) {
  let now = START;
  let ordinal = 0;
  const adapter: WebAuthnServerAdapter = {
    ...simpleWebAuthnServerAdapter,
    async verifyRegistration(input) {
      return {
        verified: await input.challengeMatches(
          decodeChallenge(input.response.response.clientDataJSON),
        ),
        userVerified: true,
        credential: {
          id: input.response.id,
          publicKey: new Uint8Array([1, 2, 3]),
          counter: 0,
          transports: ['internal'],
        },
      };
    },
    async verifyAuthentication(input) {
      return {
        verified: await input.challengeMatches(
          decodeChallenge(input.response.response.clientDataJSON),
        ),
        userVerified: true,
        newCounter: input.credential.counter + 1,
      };
    },
  };
  const store = input?.store ?? createMemoryWebAuthnStateStore();
  const coordinator = createWebAuthnCeremonyCoordinator({
    adapter,
    allowedOrigins: ['http://localhost:4178'],
    bootstrapCapabilityDigest: await digest(CAPABILITY),
    ceremonyIdGenerator: () =>
      `ceremony_${String(++ordinal).padStart(32, '0')}`,
    clock: { now: () => now },
    configurationRevision: input?.configurationRevision ?? 1,
    policy: { ceremonyLifetimeMs: 60_000, proofLifetimeMs: 10_000 },
    proofIdGenerator: () => `proof_${String(++ordinal).padStart(32, '0')}`,
    rpId: 'localhost',
    rpName: 'Vidha disposable fixture',
    store,
  });
  return {
    coordinator,
    setNow(value: number) {
      now = value;
    },
  };
}

function responseWithChallenge<
  T extends RegistrationResponseJSON | AuthenticationResponseJSON,
>(response: T, challenge: string): T {
  return {
    ...response,
    response: {
      ...response.response,
      clientDataJSON: encodeBase64Url(JSON.stringify({ challenge })),
    },
  };
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

function decodeChallenge(value: string): string {
  const padded = value
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return (JSON.parse(new TextDecoder().decode(bytes)) as { challenge: string })
    .challenge;
}

describe('WebAuthn ceremony coordinator', () => {
  it('uses exact RP/origin configuration and permanently closes bootstrap', async () => {
    const runtime = await setup();
    await expect(
      runtime.coordinator.startRegistration({
        bootstrapCapability: CAPABILITY,
        origin: 'http://localhost:4178',
        ownerId: OWNER_ID,
        purpose: 'bootstrap_register',
        requestHost: 'example.com',
      }),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_DENIED' });

    const started = await runtime.coordinator.startRegistration({
      bootstrapCapability: CAPABILITY,
      origin: 'http://localhost:4178',
      ownerId: OWNER_ID,
      purpose: 'bootstrap_register',
      requestHost: '[::1]:4178',
    });
    expect(started.options).toMatchObject({
      rp: { id: 'localhost' },
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'required',
      },
      attestation: 'none',
    });

    const credential = await runtime.coordinator.finishRegistration({
      ceremonyId: started.ceremonyId,
      purpose: 'bootstrap_register',
      response: responseWithChallenge(
        registrationResponse,
        started.options.challenge,
      ),
    });
    expect(credential).toMatchObject({
      credentialId: `credential_${await digest(RAW_CREDENTIAL_ID)}`,
      ownerId: OWNER_ID,
      webauthnCredentialId: RAW_CREDENTIAL_ID,
    });
    await expect(
      runtime.coordinator.startRegistration({
        bootstrapCapability: CAPABILITY,
        origin: 'http://localhost:4178',
        ownerId: OWNER_ID,
        purpose: 'bootstrap_register',
        requestHost: 'localhost:4178',
      }),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_DENIED' });
  });

  it('binds ceremony purpose, expiry, challenge, and one-time consumption', async () => {
    const runtime = await setup();
    const started = await runtime.coordinator.startRegistration({
      bootstrapCapability: CAPABILITY,
      origin: 'http://localhost:4178',
      ownerId: OWNER_ID,
      purpose: 'bootstrap_register',
      requestHost: '127.0.0.1:4178',
    });
    await expect(
      runtime.coordinator.finishRegistration({
        ceremonyId: started.ceremonyId,
        purpose: 'register',
        response: responseWithChallenge(
          registrationResponse,
          started.options.challenge,
        ),
      }),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_DENIED' });

    runtime.setNow(START + 60_001);
    await expect(
      runtime.coordinator.finishRegistration({
        ceremonyId: started.ceremonyId,
        purpose: 'bootstrap_register',
        response: responseWithChallenge(
          registrationResponse,
          started.options.challenge,
        ),
      }),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_DENIED' });
  });

  it('issues one-time, expiring assertion proofs after verified UP and UV', async () => {
    const runtime = await setup();
    const registration = await runtime.coordinator.startRegistration({
      bootstrapCapability: CAPABILITY,
      origin: 'http://localhost:4178',
      ownerId: OWNER_ID,
      purpose: 'bootstrap_register',
      requestHost: 'localhost:4178',
    });
    const credential = await runtime.coordinator.finishRegistration({
      ceremonyId: registration.ceremonyId,
      purpose: 'bootstrap_register',
      response: responseWithChallenge(
        registrationResponse,
        registration.options.challenge,
      ),
    });
    const authentication = await runtime.coordinator.startAuthentication({
      ownerId: OWNER_ID,
      purpose: 'reauthenticate',
    });
    const proof = await runtime.coordinator.finishAuthentication({
      ceremonyId: authentication.ceremonyId,
      purpose: 'reauthenticate',
      response: responseWithChallenge(
        authenticationResponse,
        authentication.options.challenge,
      ),
    });

    await expect(
      runtime.coordinator.consumeAuthenticationProof({
        proofId: proof.proofId,
        ownerId: OWNER_ID,
        credentialId: credential.credentialId,
      }),
    ).resolves.toEqual({
      verified: true,
      userPresent: true,
      userVerified: true,
    });
    await expect(
      runtime.coordinator.consumeAuthenticationProof({
        proofId: proof.proofId,
        ownerId: OWNER_ID,
        credentialId: credential.credentialId,
      }),
    ).resolves.toEqual({
      verified: false,
      userPresent: false,
      userVerified: false,
    });
  });

  it('requires and consumes a fresh reauthentication proof before adding a credential', async () => {
    const runtime = await setup();
    const registration = await runtime.coordinator.startRegistration({
      bootstrapCapability: CAPABILITY,
      origin: 'http://localhost:4178',
      ownerId: OWNER_ID,
      purpose: 'bootstrap_register',
      requestHost: 'localhost:4178',
    });
    const credential = await runtime.coordinator.finishRegistration({
      ceremonyId: registration.ceremonyId,
      purpose: 'bootstrap_register',
      response: responseWithChallenge(
        registrationResponse,
        registration.options.challenge,
      ),
    });
    await expect(
      runtime.coordinator.startRegistration({
        origin: 'http://localhost:4178',
        ownerId: OWNER_ID,
        purpose: 'register',
        requestHost: 'localhost:4178',
      }),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_DENIED' });

    const authentication = await runtime.coordinator.startAuthentication({
      ownerId: OWNER_ID,
      purpose: 'reauthenticate',
    });
    const proof = await runtime.coordinator.finishAuthentication({
      ceremonyId: authentication.ceremonyId,
      purpose: 'reauthenticate',
      response: responseWithChallenge(
        authenticationResponse,
        authentication.options.challenge,
      ),
    });
    await expect(
      runtime.coordinator.startRegistration({
        authenticationProof: proof.proofId,
        credentialId: credential.credentialId,
        origin: 'http://localhost:4178',
        ownerId: OWNER_ID,
        purpose: 'register',
        requestHost: 'localhost:4178',
      }),
    ).resolves.toMatchObject({ options: { rp: { id: 'localhost' } } });
    await expect(
      runtime.coordinator.startRegistration({
        authenticationProof: proof.proofId,
        credentialId: credential.credentialId,
        origin: 'http://localhost:4178',
        ownerId: OWNER_ID,
        purpose: 'register',
        requestHost: 'localhost:4178',
      }),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_DENIED' });
  });

  it('rejects a ceremony created under a stale relying-party configuration', async () => {
    const store = createMemoryWebAuthnStateStore();
    const original = await setup({ configurationRevision: 1, store });
    const registration = await original.coordinator.startRegistration({
      bootstrapCapability: CAPABILITY,
      origin: 'http://localhost:4178',
      ownerId: OWNER_ID,
      purpose: 'bootstrap_register',
      requestHost: 'localhost:4178',
    });
    const revised = await setup({ configurationRevision: 2, store });
    await expect(
      revised.coordinator.finishRegistration({
        ceremonyId: registration.ceremonyId,
        purpose: 'bootstrap_register',
        response: responseWithChallenge(
          registrationResponse,
          registration.options.challenge,
        ),
      }),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_DENIED' });
  });
});
