import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  type WebAuthnCredential,
} from '@simplewebauthn/server';

import { IdentityError } from './identity';

export type WebAuthnCeremonyPurpose =
  'bootstrap_register' | 'register' | 'authenticate' | 'reauthenticate';

export interface WebAuthnCeremonyRecord {
  readonly ceremonyId: string;
  readonly ownerId: string;
  readonly purpose: WebAuthnCeremonyPurpose;
  readonly challengeDigest: string;
  readonly configurationRevision: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly consumedAt: number | null;
}

export interface WebAuthnCredentialRecord {
  readonly credentialId: string;
  readonly webauthnCredentialId: string;
  readonly ownerId: string;
  readonly publicKey: Uint8Array;
  readonly counter: number;
  readonly transports?: NonNullable<WebAuthnCredential['transports']>;
  readonly createdAt: number;
  readonly revokedAt: number | null;
}

export interface WebAuthnAssertionProof {
  readonly proofId: string;
  readonly ownerId: string;
  readonly credentialId: string;
  readonly purpose: 'authenticate' | 'reauthenticate';
  readonly authenticatedAt: number;
  readonly expiresAt: number;
}

export interface WebAuthnStateStore {
  countCredentials(): Promise<number>;
  createCeremony(record: WebAuthnCeremonyRecord): Promise<void>;
  consumeCeremony(input: {
    readonly ceremonyId: string;
    readonly purpose: WebAuthnCeremonyPurpose;
    readonly at: number;
  }): Promise<WebAuthnCeremonyRecord>;
  registerCredential(input: {
    readonly credential: WebAuthnCredentialRecord;
    readonly bootstrap: boolean;
  }): Promise<void>;
  listCredentials(
    ownerId: string,
  ): Promise<readonly WebAuthnCredentialRecord[]>;
  readCredentialByWebAuthnId(
    webauthnCredentialId: string,
  ): Promise<WebAuthnCredentialRecord | null>;
  updateCounter(input: {
    readonly credentialId: string;
    readonly expectedCounter: number;
    readonly nextCounter: number;
  }): Promise<void>;
  issueProof(proof: WebAuthnAssertionProof): Promise<void>;
  consumeProof(input: {
    readonly proofId: string;
    readonly ownerId: string;
    readonly credentialId: string;
    readonly at: number;
  }): Promise<WebAuthnAssertionProof | null>;
}

export interface WebAuthnServerAdapter {
  registrationOptions(input: {
    readonly challenge: string;
    readonly credentials: readonly WebAuthnCredentialRecord[];
    readonly ownerId: string;
    readonly rpId: string;
    readonly rpName: string;
    readonly timeoutMs: number;
  }): Promise<PublicKeyCredentialCreationOptionsJSON>;
  authenticationOptions(input: {
    readonly challenge: string;
    readonly credentials: readonly WebAuthnCredentialRecord[];
    readonly rpId: string;
    readonly timeoutMs: number;
  }): Promise<PublicKeyCredentialRequestOptionsJSON>;
  verifyRegistration(input: {
    readonly challengeMatches: (challenge: string) => Promise<boolean>;
    readonly origins: readonly string[];
    readonly response: RegistrationResponseJSON;
    readonly rpId: string;
  }): Promise<{
    readonly credential: WebAuthnCredential;
    readonly userVerified: boolean;
    readonly verified: boolean;
  }>;
  verifyAuthentication(input: {
    readonly challengeMatches: (challenge: string) => Promise<boolean>;
    readonly credential: WebAuthnCredentialRecord;
    readonly origins: readonly string[];
    readonly response: AuthenticationResponseJSON;
    readonly rpId: string;
  }): Promise<{
    readonly newCounter: number;
    readonly userVerified: boolean;
    readonly verified: boolean;
  }>;
}

export interface WebAuthnCeremonyCoordinator {
  startRegistration(input: {
    readonly authenticationProof?: string;
    readonly bootstrapCapability?: string;
    readonly credentialId?: string;
    readonly origin: string;
    readonly ownerId: string;
    readonly purpose: 'bootstrap_register' | 'register';
    readonly requestHost: string;
  }): Promise<{
    readonly ceremonyId: string;
    readonly options: PublicKeyCredentialCreationOptionsJSON;
  }>;
  finishRegistration(input: {
    readonly ceremonyId: string;
    readonly purpose: 'bootstrap_register' | 'register';
    readonly response: RegistrationResponseJSON;
  }): Promise<WebAuthnCredentialRecord>;
  startAuthentication(input: {
    readonly ownerId: string;
    readonly purpose: 'authenticate' | 'reauthenticate';
  }): Promise<{
    readonly ceremonyId: string;
    readonly options: PublicKeyCredentialRequestOptionsJSON;
  }>;
  finishAuthentication(input: {
    readonly ceremonyId: string;
    readonly response: AuthenticationResponseJSON;
    readonly purpose: 'authenticate' | 'reauthenticate';
  }): Promise<{ readonly proofId: string }>;
  consumeAuthenticationProof(input: {
    readonly proofId: string;
    readonly ownerId: string;
    readonly credentialId: string;
  }): Promise<{
    readonly verified: boolean;
    readonly userPresent: boolean;
    readonly userVerified: boolean;
  }>;
}

interface CreateWebAuthnCeremonyCoordinatorInput {
  readonly adapter?: WebAuthnServerAdapter;
  readonly allowedOrigins: readonly string[];
  readonly bootstrapCapabilityDigest: string;
  readonly ceremonyIdGenerator?: () => string;
  readonly clock: { now(): number };
  readonly configurationRevision: number;
  readonly proofIdGenerator?: () => string;
  readonly policy: {
    readonly ceremonyLifetimeMs: number;
    readonly proofLifetimeMs: number;
  };
  readonly rpId: string;
  readonly rpName: string;
  readonly store: WebAuthnStateStore;
}

export function createWebAuthnCeremonyCoordinator({
  adapter = simpleWebAuthnServerAdapter,
  allowedOrigins,
  bootstrapCapabilityDigest,
  ceremonyIdGenerator = () => randomId('ceremony'),
  clock,
  configurationRevision,
  proofIdGenerator = () => randomId('proof'),
  policy,
  rpId,
  rpName,
  store,
}: CreateWebAuthnCeremonyCoordinatorInput): WebAuthnCeremonyCoordinator {
  if (
    !/^[a-z0-9.-]{1,253}$/u.test(rpId) ||
    !Number.isSafeInteger(configurationRevision) ||
    configurationRevision <= 0 ||
    allowedOrigins.length === 0 ||
    !allowedOrigins.every((origin) => isSecureOrigin(origin, rpId)) ||
    !/^[a-f0-9]{64}$/u.test(bootstrapCapabilityDigest) ||
    !positive(policy.ceremonyLifetimeMs) ||
    !positive(policy.proofLifetimeMs)
  ) {
    invalid('The WebAuthn relying-party configuration is invalid.');
  }

  async function createCeremony(
    ownerId: string,
    purpose: WebAuthnCeremonyPurpose,
  ): Promise<{
    readonly ceremonyId: string;
    readonly challenge: string;
  }> {
    const at = validNow(clock);
    const ceremonyId = ceremonyIdGenerator();
    const challenge = randomSecret();
    validateOpaqueId(ceremonyId, 'ceremony');
    await store.createCeremony({
      ceremonyId,
      ownerId,
      purpose,
      challengeDigest: await sha256(challenge),
      configurationRevision,
      createdAt: at,
      expiresAt: safeAdd(at, policy.ceremonyLifetimeMs),
      consumedAt: null,
    });
    return { ceremonyId, challenge };
  }

  return {
    async startRegistration(input) {
      validateOwnerId(input.ownerId);
      if (!allowedOrigins.includes(input.origin)) {
        denied('The registration origin is not allowed.');
      }
      if (input.purpose === 'bootstrap_register') {
        if (
          !isLoopbackHost(input.requestHost) ||
          input.bootstrapCapability === undefined ||
          !(await constantTimeDigestMatch(
            input.bootstrapCapability,
            bootstrapCapabilityDigest,
          )) ||
          (await store.countCredentials()) !== 0
        ) {
          denied('Disposable Owner bootstrap is not authorized.');
        }
      } else {
        if (
          input.authenticationProof === undefined ||
          input.credentialId === undefined
        ) {
          denied('Adding an Owner Credential requires fresh authentication.');
        }
        const proof = await store.consumeProof({
          proofId: await sha256(input.authenticationProof),
          ownerId: input.ownerId,
          credentialId: input.credentialId,
          at: validNow(clock),
        });
        if (proof === null || proof.purpose !== 'reauthenticate') {
          denied('The credential-registration proof is absent or misbound.');
        }
      }
      const ceremony = await createCeremony(input.ownerId, input.purpose);
      const credentials = await store.listCredentials(input.ownerId);
      return {
        ceremonyId: ceremony.ceremonyId,
        options: await adapter.registrationOptions({
          challenge: ceremony.challenge,
          credentials,
          ownerId: input.ownerId,
          rpId,
          rpName,
          timeoutMs: policy.ceremonyLifetimeMs,
        }),
      };
    },
    async finishRegistration(input) {
      const at = validNow(clock);
      const ceremony = await store.consumeCeremony({
        ceremonyId: input.ceremonyId,
        purpose: input.purpose,
        at,
      });
      if (ceremony.configurationRevision !== configurationRevision) {
        denied('The WebAuthn ceremony configuration is stale.');
      }
      const verification = await adapter.verifyRegistration({
        challengeMatches: async (challenge) =>
          (await sha256(challenge)) === ceremony.challengeDigest,
        origins: allowedOrigins,
        response: input.response,
        rpId,
      });
      if (!verification.verified || !verification.userVerified) {
        denied('The WebAuthn registration response was not verified.');
      }
      const credential: WebAuthnCredentialRecord = {
        credentialId: `credential_${await sha256(verification.credential.id)}`,
        webauthnCredentialId: verification.credential.id,
        ownerId: ceremony.ownerId,
        publicKey: verification.credential.publicKey.slice(),
        counter: verification.credential.counter,
        ...(verification.credential.transports === undefined
          ? {}
          : { transports: verification.credential.transports }),
        createdAt: at,
        revokedAt: null,
      };
      await store.registerCredential({
        credential,
        bootstrap: input.purpose === 'bootstrap_register',
      });
      return cloneCredential(credential);
    },
    async startAuthentication(input) {
      validateOwnerId(input.ownerId);
      const credentials = (await store.listCredentials(input.ownerId)).filter(
        (credential) => credential.revokedAt === null,
      );
      if (credentials.length === 0) {
        denied('No active Owner Credential is available.');
      }
      const ceremony = await createCeremony(input.ownerId, input.purpose);
      return {
        ceremonyId: ceremony.ceremonyId,
        options: await adapter.authenticationOptions({
          challenge: ceremony.challenge,
          credentials,
          rpId,
          timeoutMs: policy.ceremonyLifetimeMs,
        }),
      };
    },
    async finishAuthentication(input) {
      const at = validNow(clock);
      const ceremony = await store.consumeCeremony({
        ceremonyId: input.ceremonyId,
        purpose: input.purpose,
        at,
      });
      if (ceremony.configurationRevision !== configurationRevision) {
        denied('The WebAuthn ceremony configuration is stale.');
      }
      const credential = await store.readCredentialByWebAuthnId(
        input.response.id,
      );
      if (
        credential === null ||
        credential.ownerId !== ceremony.ownerId ||
        credential.revokedAt !== null
      ) {
        denied('The Owner Credential is unknown or revoked.');
      }
      const verification = await adapter.verifyAuthentication({
        challengeMatches: async (challenge) =>
          (await sha256(challenge)) === ceremony.challengeDigest,
        credential,
        origins: allowedOrigins,
        response: input.response,
        rpId,
      });
      if (!verification.verified || !verification.userVerified) {
        denied('The WebAuthn assertion was not verified.');
      }
      await store.updateCounter({
        credentialId: credential.credentialId,
        expectedCounter: credential.counter,
        nextCounter: verification.newCounter,
      });
      const proofId = proofIdGenerator();
      validateOpaqueId(proofId, 'proof');
      await store.issueProof({
        proofId: await sha256(proofId),
        ownerId: ceremony.ownerId,
        credentialId: credential.credentialId,
        purpose: input.purpose,
        authenticatedAt: at,
        expiresAt: safeAdd(at, policy.proofLifetimeMs),
      });
      return { proofId };
    },
    async consumeAuthenticationProof(input) {
      const proof = await store.consumeProof({
        proofId: await sha256(input.proofId),
        ownerId: input.ownerId,
        credentialId: input.credentialId,
        at: validNow(clock),
      });
      return {
        verified: proof !== null,
        userPresent: proof !== null,
        userVerified: proof !== null,
      };
    },
  };
}

export const simpleWebAuthnServerAdapter: WebAuthnServerAdapter = {
  async registrationOptions(input) {
    return await generateRegistrationOptions({
      rpName: input.rpName,
      rpID: input.rpId,
      userName: input.ownerId,
      userDisplayName: 'Disposable Vidha Owner',
      userID: new TextEncoder().encode(input.ownerId),
      challenge: fromBase64Url(input.challenge),
      timeout: input.timeoutMs,
      attestationType: 'none',
      excludeCredentials: input.credentials.map((credential) => ({
        id: credential.webauthnCredentialId,
        ...(credential.transports === undefined
          ? {}
          : { transports: credential.transports }),
      })),
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'required',
      },
    });
  },
  async authenticationOptions(input) {
    return await generateAuthenticationOptions({
      rpID: input.rpId,
      challenge: fromBase64Url(input.challenge),
      timeout: input.timeoutMs,
      userVerification: 'required',
      allowCredentials: input.credentials.map((credential) => ({
        id: credential.webauthnCredentialId,
        ...(credential.transports === undefined
          ? {}
          : { transports: credential.transports }),
      })),
    });
  },
  async verifyRegistration(input) {
    const result = await verifyRegistrationResponse({
      response: input.response,
      expectedChallenge: input.challengeMatches,
      expectedOrigin: [...input.origins],
      expectedRPID: input.rpId,
      requireUserPresence: true,
      requireUserVerification: true,
    });
    if (!result.verified) {
      return {
        verified: false,
        userVerified: false,
        credential: emptyCredential,
      };
    }
    return {
      verified: true,
      userVerified: result.registrationInfo.userVerified,
      credential: result.registrationInfo.credential,
    };
  },
  async verifyAuthentication(input) {
    const result = await verifyAuthenticationResponse({
      response: input.response,
      expectedChallenge: input.challengeMatches,
      expectedOrigin: [...input.origins],
      expectedRPID: input.rpId,
      credential: {
        id: input.credential.webauthnCredentialId,
        publicKey: input.credential.publicKey.slice(),
        counter: input.credential.counter,
        ...(input.credential.transports === undefined
          ? {}
          : { transports: input.credential.transports }),
      },
      requireUserVerification: true,
    });
    return {
      verified: result.verified,
      userVerified: result.authenticationInfo.userVerified,
      newCounter: result.authenticationInfo.newCounter,
    };
  },
};

const emptyCredential: WebAuthnCredential = {
  id: '',
  publicKey: new Uint8Array(),
  counter: 0,
};

export function createMemoryWebAuthnStateStore(): WebAuthnStateStore {
  const ceremonies = new Map<string, WebAuthnCeremonyRecord>();
  const credentials = new Map<string, WebAuthnCredentialRecord>();
  const proofs = new Map<string, WebAuthnAssertionProof>();

  return {
    async countCredentials() {
      return credentials.size;
    },
    async createCeremony(record) {
      if (ceremonies.has(record.ceremonyId)) {
        invalid('A WebAuthn ceremony identifier cannot be reused.');
      }
      ceremonies.set(record.ceremonyId, structuredClone(record));
    },
    async consumeCeremony(input) {
      const record = ceremonies.get(input.ceremonyId);
      if (
        record === undefined ||
        record.purpose !== input.purpose ||
        record.consumedAt !== null ||
        record.createdAt > input.at ||
        record.expiresAt < input.at
      ) {
        denied(
          'The WebAuthn ceremony is absent, expired, consumed, or misbound.',
        );
      }
      const consumed = { ...record, consumedAt: input.at };
      ceremonies.set(record.ceremonyId, consumed);
      return structuredClone(consumed);
    },
    async registerCredential(input) {
      if (
        credentials.has(input.credential.credentialId) ||
        (input.bootstrap && credentials.size !== 0)
      ) {
        denied('The WebAuthn credential cannot be registered.');
      }
      credentials.set(
        input.credential.credentialId,
        cloneCredential(input.credential),
      );
    },
    async listCredentials(ownerId) {
      return [...credentials.values()]
        .filter((credential) => credential.ownerId === ownerId)
        .map(cloneCredential);
    },
    async readCredentialByWebAuthnId(webauthnCredentialId) {
      const credential = [...credentials.values()].find(
        (candidate) => candidate.webauthnCredentialId === webauthnCredentialId,
      );
      return credential === undefined ? null : cloneCredential(credential);
    },
    async updateCounter(input) {
      const credential = credentials.get(input.credentialId);
      if (
        credential === undefined ||
        credential.counter !== input.expectedCounter ||
        input.nextCounter < credential.counter
      ) {
        denied('The WebAuthn credential counter update is stale.');
      }
      credentials.set(input.credentialId, {
        ...credential,
        counter: input.nextCounter,
      });
    },
    async issueProof(proof) {
      if (proofs.has(proof.proofId)) {
        invalid('A WebAuthn assertion proof identifier cannot be reused.');
      }
      proofs.set(proof.proofId, structuredClone(proof));
    },
    async consumeProof(input) {
      const proof = proofs.get(input.proofId);
      if (
        proof === undefined ||
        proof.ownerId !== input.ownerId ||
        proof.credentialId !== input.credentialId ||
        proof.authenticatedAt > input.at ||
        proof.expiresAt < input.at
      ) {
        return null;
      }
      proofs.delete(input.proofId);
      return structuredClone(proof);
    },
  };
}

function cloneCredential(
  credential: WebAuthnCredentialRecord,
): WebAuthnCredentialRecord {
  return {
    ...credential,
    publicKey: credential.publicKey.slice(),
    ...(credential.transports === undefined
      ? {}
      : { transports: [...credential.transports] }),
  };
}

function isSecureOrigin(origin: string, rpId: string): boolean {
  try {
    const url = new URL(origin);
    return (
      url.origin === origin &&
      ((url.protocol === 'https:' && url.hostname === rpId) ||
        (url.protocol === 'http:' && isLoopbackHost(url.hostname)))
    );
  } catch {
    return false;
  }
}

function isLoopbackHost(host: string): boolean {
  try {
    const normalized = new URL(`http://${host}`).hostname.replace(
      /^\[|\]$/gu,
      '',
    );
    return (
      normalized === 'localhost' ||
      normalized === '127.0.0.1' ||
      normalized === '::1'
    );
  } catch {
    return false;
  }
}

function validateOwnerId(ownerId: string): void {
  if (!/^owner_[a-f0-9]{64}$/u.test(ownerId)) {
    invalid('The WebAuthn Owner identifier is invalid.');
  }
}

function validateOpaqueId(value: string, prefix: 'ceremony' | 'proof'): void {
  if (!new RegExp(`^${prefix}_[A-Za-z0-9_-]{32,128}$`, 'u').test(value)) {
    invalid(`The WebAuthn ${prefix} identifier is invalid.`);
  }
}

function randomId(prefix: 'ceremony' | 'proof'): string {
  return `${prefix}_${randomSecret()}`;
}

function randomSecret(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  return base64Url(bytes);
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function sha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function constantTimeDigestMatch(
  value: string,
  expectedDigest: string,
): Promise<boolean> {
  const actual = await sha256(value);
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) {
    difference |= actual.charCodeAt(index) ^ expectedDigest.charCodeAt(index);
  }
  return difference === 0;
}

function validNow(clock: { now(): number }): number {
  const value = clock.now();
  if (!Number.isSafeInteger(value))
    invalid('WebAuthn time must be a safe integer.');
  return value;
}

function safeAdd(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value)) invalid('WebAuthn time overflowed.');
  return value;
}

function positive(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function denied(message: string): never {
  throw new IdentityError('AUTHENTICATION_DENIED', message);
}

function invalid(message: string): never {
  throw new IdentityError('INVALID_COMMAND', message);
}
