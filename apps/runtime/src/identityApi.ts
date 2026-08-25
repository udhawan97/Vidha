import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  IdentityError,
  createOwnerIdentityCoordinator,
  createWebAuthnCeremonyCoordinator,
  type OwnerIdentityCoordinator,
  type OwnerIdentityRepository,
  type WebAuthnCeremonyCoordinator,
  type WebAuthnServerAdapter,
  type WebAuthnStateStore,
} from '@vidha/identity';

import {
  identityRehearsalCss,
  identityRehearsalHtml,
  identityRehearsalJavascript,
} from './identityRehearsalAssets';

const SESSION_COOKIE = '__Host-vidha_session';
const MAX_JSON_BYTES = 128 * 1024;
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "script-src 'self'",
  "style-src 'self'",
].join('; ');

type RegistrationResponse = Parameters<
  WebAuthnCeremonyCoordinator['finishRegistration']
>[0]['response'];
type AuthenticationResponse = Parameters<
  WebAuthnCeremonyCoordinator['finishAuthentication']
>[0]['response'];

export interface CreateIdentityRehearsalHandlerInput {
  readonly bootstrapCapabilityDigest: string;
  readonly clock?: { now(): number };
  readonly configurationRevision?: number;
  readonly csrfSecret: string;
  readonly identityRepository: OwnerIdentityRepository;
  readonly publicOrigin: string;
  readonly rpId: string;
  readonly sessionIdGenerator?: () => string;
  readonly verifiedChannelRef: string;
  readonly webAuthnAdapter?: WebAuthnServerAdapter;
  readonly webAuthnStore: WebAuthnStateStore;
}

export interface IdentityRehearsalHandler {
  handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
}

export function createIdentityRehearsalHandler(
  input: CreateIdentityRehearsalHandlerInput,
): IdentityRehearsalHandler {
  const origin = validateConfiguration(input);
  const clock = input.clock ?? { now: () => Date.now() };
  const webAuthn = createWebAuthnCeremonyCoordinator({
    ...(input.webAuthnAdapter === undefined
      ? {}
      : { adapter: input.webAuthnAdapter }),
    allowedOrigins: [origin.origin],
    bootstrapCapabilityDigest: input.bootstrapCapabilityDigest,
    clock,
    configurationRevision: input.configurationRevision ?? 1,
    policy: { ceremonyLifetimeMs: 120_000, proofLifetimeMs: 30_000 },
    rpId: input.rpId,
    rpName: 'Vidha disposable credential boundary',
    store: input.webAuthnStore,
  });
  const identity = createOwnerIdentityCoordinator({
    clock,
    policy: {
      channelChangeCoolingOffMs: 86_400_000,
      recentAuthenticationWindowMs: 300_000,
      recoveryCoolingOffMs: 172_800_000,
      sessionLifetimeMs: 900_000,
    },
    repository: input.identityRepository,
    ...(input.sessionIdGenerator === undefined
      ? {}
      : { sessionIdGenerator: input.sessionIdGenerator }),
    verifier: {
      async verifyAuthentication(details) {
        return await webAuthn.consumeAuthenticationProof({
          credentialId: details.credentialId,
          ownerId: details.ownerId,
          proofId: details.assertion,
        });
      },
      async verifyChannel() {
        return false;
      },
      async verifyRecovery() {
        return false;
      },
      async verifyRegistration() {
        return false;
      },
    },
  });

  return {
    async handle(request, response) {
      setSecurityHeaders(response);
      try {
        if (!matchesHost(request, origin.host)) {
          throw new HttpBoundaryError(403, 'origin_denied');
        }
        if (request.method === 'GET') {
          const handled = await handleGet(
            request,
            response,
            identity,
            input.csrfSecret,
            clock,
          );
          if (handled) return true;
          if (isIdentityPath(request.url)) {
            writeJson(response, 405, { status: 'method_not_allowed' });
            return true;
          }
          return false;
        }
        if (request.method === 'POST') {
          await handlePost(
            request,
            response,
            webAuthn,
            identity,
            input,
            origin,
            clock,
          );
          return true;
        }
        if (isIdentityPath(request.url)) {
          writeJson(response, 405, { status: 'method_not_allowed' });
          return true;
        }
        return false;
      } catch (error) {
        if (error instanceof HttpBoundaryError) {
          writeJson(response, error.statusCode, { status: error.publicCode });
          return true;
        }
        if (error instanceof IdentityError) {
          writeJson(response, identityStatus(error), {
            status: identityPublicCode(error),
          });
          return true;
        }
        writeJson(response, 500, { status: 'internal_error' });
        return true;
      }
    },
  };
}

async function handleGet(
  request: IncomingMessage,
  response: ServerResponse,
  identity: OwnerIdentityCoordinator,
  csrfSecret: string,
  clock: { now(): number },
): Promise<boolean> {
  if (request.url === '/rehearsal/webauthn') {
    writeAsset(response, 'text/html; charset=utf-8', identityRehearsalHtml);
    return true;
  }
  if (request.url === '/rehearsal/webauthn.css') {
    writeAsset(response, 'text/css; charset=utf-8', identityRehearsalCss);
    return true;
  }
  if (request.url === '/rehearsal/webauthn.js') {
    writeAsset(
      response,
      'text/javascript; charset=utf-8',
      identityRehearsalJavascript,
    );
    return true;
  }
  if (request.url !== '/v1/identity/session') return false;
  const sessionId = readSessionCookie(request);
  const session =
    sessionId === null ? null : await identity.verify(sessionId, clock.now());
  if (session === null || sessionId === null) {
    clearSessionCookie(response);
    writeJson(response, 401, { status: 'session_inactive' });
    return true;
  }
  writeJson(response, 200, {
    authenticatedAt: session.authenticatedAt,
    csrfToken: csrfToken(csrfSecret, sessionId),
    expiresAt: session.expiresAt,
    principal: session.principal,
    status: 'session_active',
  });
  return true;
}

async function handlePost(
  request: IncomingMessage,
  response: ServerResponse,
  webAuthn: WebAuthnCeremonyCoordinator,
  identity: OwnerIdentityCoordinator,
  input: CreateIdentityRehearsalHandlerInput,
  origin: URL,
  clock: { now(): number },
): Promise<void> {
  if (!isIdentityPostPath(request.url)) {
    throw new HttpBoundaryError(404, 'not_found');
  }
  requireSameOriginPost(request, origin.origin);
  const body = await readJson(request);

  switch (request.url) {
    case '/v1/identity/webauthn/bootstrap/options': {
      const ownerId = requiredString(body, 'ownerId');
      const started = await webAuthn.startRegistration({
        bootstrapCapability: requiredString(body, 'bootstrapCapability'),
        origin: origin.origin,
        ownerId,
        purpose: 'bootstrap_register',
        requestHost: origin.host,
      });
      writeJson(response, 200, {
        ceremonyId: started.ceremonyId,
        options: started.options,
        status: 'bootstrap_options_ready',
      });
      return;
    }
    case '/v1/identity/webauthn/bootstrap/verify': {
      const credential = await webAuthn.finishRegistration({
        ceremonyId: requiredString(body, 'ceremonyId'),
        purpose: 'bootstrap_register',
        response: registrationResponse(body.response),
      });
      await identity.initialize({
        credentialId: credential.credentialId,
        ownerId: credential.ownerId,
        verifiedChannelRef: input.verifiedChannelRef,
      });
      writeJson(response, 201, { status: 'credential_ready' });
      return;
    }
    case '/v1/identity/webauthn/authentication/options': {
      const started = await webAuthn.startAuthentication({
        ownerId: requiredString(body, 'ownerId'),
        purpose: 'authenticate',
      });
      writeJson(response, 200, {
        ceremonyId: started.ceremonyId,
        options: started.options,
        status: 'authentication_options_ready',
      });
      return;
    }
    case '/v1/identity/webauthn/authentication/verify': {
      const proof = await webAuthn.finishAuthentication({
        ceremonyId: requiredString(body, 'ceremonyId'),
        purpose: 'authenticate',
        response: authenticationResponse(body.response),
      });
      const currentSessionId = readSessionCookie(request);
      const currentSession =
        currentSessionId === null
          ? null
          : await identity.verify(currentSessionId, clock.now());
      const session = await identity.authenticate({
        assertion: proof.proofId,
        credentialId: proof.credentialId,
        ownerId: proof.ownerId,
        ...(currentSessionId !== null &&
        currentSession?.principal.principalId === proof.ownerId
          ? { replacesSessionId: currentSessionId }
          : {}),
      });
      setSessionCookie(
        response,
        session.sessionId,
        session.expiresAt - clock.now(),
      );
      writeJson(response, 200, {
        csrfToken: csrfToken(input.csrfSecret, session.sessionId),
        expiresAt: session.expiresAt,
        status: 'authenticated',
      });
      return;
    }
    case '/v1/identity/session/revoke': {
      const sessionId = readSessionCookie(request);
      const session =
        sessionId === null
          ? null
          : await identity.verify(sessionId, clock.now());
      if (session === null || sessionId === null) {
        throw new HttpBoundaryError(401, 'session_inactive');
      }
      requireCsrf(request, input.csrfSecret, sessionId);
      const state = await identity.read(session.principal.principalId);
      if (state === null) {
        throw new HttpBoundaryError(401, 'session_inactive');
      }
      await identity.execute({
        type: 'REVOKE_SESSION',
        actorSessionId: sessionId,
        expectedSecurityRevision: state.securityRevision,
        idempotencyKey: `session-revoke-${sha256(sessionId)}`,
        ownerId: session.principal.principalId,
        targetSessionId: sessionId,
      });
      clearSessionCookie(response);
      writeJson(response, 200, { status: 'session_revoked' });
      return;
    }
  }
}

function validateConfiguration(
  input: CreateIdentityRehearsalHandlerInput,
): URL {
  let origin: URL;
  try {
    origin = new URL(input.publicOrigin);
  } catch {
    throw new Error('VIDHA_PUBLIC_ORIGIN is invalid.');
  }
  if (
    origin.origin !== input.publicOrigin ||
    origin.protocol !== 'http:' ||
    origin.hostname !== 'localhost' ||
    input.rpId !== 'localhost' ||
    !/^[a-f0-9]{64}$/u.test(input.bootstrapCapabilityDigest) ||
    input.csrfSecret.length < 32 ||
    !/^channel_[a-f0-9]{64}$/u.test(input.verifiedChannelRef) ||
    (input.configurationRevision !== undefined &&
      (!Number.isSafeInteger(input.configurationRevision) ||
        input.configurationRevision <= 0))
  ) {
    throw new Error(
      'The disposable identity boundary configuration is invalid.',
    );
  }
  return origin;
}

function matchesHost(request: IncomingMessage, expectedHost: string): boolean {
  const host = request.headers.host;
  return typeof host === 'string' && host === expectedHost;
}

function requireSameOriginPost(
  request: IncomingMessage,
  expectedOrigin: string,
): void {
  const origin = request.headers.origin;
  const contentType = request.headers['content-type'];
  const contentEncoding = request.headers['content-encoding'];
  const fetchSite = request.headers['sec-fetch-site'];
  if (
    origin !== expectedOrigin ||
    typeof contentType !== 'string' ||
    !/^application\/json(?:;|$)/iu.test(contentType) ||
    (contentEncoding !== undefined && contentEncoding !== 'identity') ||
    (fetchSite !== undefined && fetchSite !== 'same-origin')
  ) {
    throw new HttpBoundaryError(403, 'origin_denied');
  }
}

async function readJson(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const declaredLength = Number(request.headers['content-length'] ?? '0');
  if (
    !Number.isSafeInteger(declaredLength) ||
    declaredLength < 0 ||
    declaredLength > MAX_JSON_BYTES
  ) {
    throw new HttpBoundaryError(413, 'request_too_large');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    size += chunk.length;
    if (size > MAX_JSON_BYTES) {
      throw new HttpBoundaryError(413, 'request_too_large');
    }
    chunks.push(chunk);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpBoundaryError(400, 'invalid_json');
  }
}

function requiredString(
  body: Readonly<Record<string, unknown>>,
  name: string,
): string {
  const value = body[name];
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048) {
    throw new HttpBoundaryError(400, 'invalid_request');
  }
  return value;
}

function registrationResponse(value: unknown): RegistrationResponse {
  const response = credentialResponse(value);
  const attestationObject = response.response.attestationObject;
  const clientDataJSON = response.response.clientDataJSON;
  if (
    typeof attestationObject !== 'string' ||
    typeof clientDataJSON !== 'string'
  ) {
    throw new HttpBoundaryError(400, 'invalid_request');
  }
  return {
    clientExtensionResults:
      response.clientExtensionResults as RegistrationResponse['clientExtensionResults'],
    id: response.id,
    rawId: response.rawId,
    response: {
      attestationObject,
      clientDataJSON,
      ...(Array.isArray(response.response.transports)
        ? {
            transports: response.response.transports as NonNullable<
              RegistrationResponse['response']['transports']
            >,
          }
        : {}),
    },
    type: 'public-key',
  };
}

function authenticationResponse(value: unknown): AuthenticationResponse {
  const response = credentialResponse(value);
  const authenticatorData = response.response.authenticatorData;
  const clientDataJSON = response.response.clientDataJSON;
  const signature = response.response.signature;
  const userHandle = response.response.userHandle;
  if (
    typeof authenticatorData !== 'string' ||
    typeof clientDataJSON !== 'string' ||
    typeof signature !== 'string' ||
    (userHandle !== undefined && typeof userHandle !== 'string')
  ) {
    throw new HttpBoundaryError(400, 'invalid_request');
  }
  return {
    clientExtensionResults:
      response.clientExtensionResults as AuthenticationResponse['clientExtensionResults'],
    id: response.id,
    rawId: response.rawId,
    response: {
      authenticatorData,
      clientDataJSON,
      signature,
      ...(userHandle === undefined ? {} : { userHandle }),
    },
    type: 'public-key',
  };
}

function credentialResponse(value: unknown): {
  readonly clientExtensionResults: Record<string, unknown>;
  readonly id: string;
  readonly rawId: string;
  readonly response: Record<string, unknown>;
  readonly type: 'public-key';
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpBoundaryError(400, 'invalid_request');
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== 'string' ||
    record.id.length === 0 ||
    record.id.length > 2_048 ||
    typeof record.rawId !== 'string' ||
    record.rawId.length > 2_048 ||
    record.type !== 'public-key' ||
    typeof record.clientExtensionResults !== 'object' ||
    record.clientExtensionResults === null ||
    Array.isArray(record.clientExtensionResults) ||
    typeof record.response !== 'object' ||
    record.response === null ||
    Array.isArray(record.response)
  ) {
    throw new HttpBoundaryError(400, 'invalid_request');
  }
  return {
    clientExtensionResults: record.clientExtensionResults as Record<
      string,
      unknown
    >,
    id: record.id,
    rawId: record.rawId,
    response: record.response as Record<string, unknown>,
    type: 'public-key',
  };
}

function readSessionCookie(request: IncomingMessage): string | null {
  const header = request.headers.cookie;
  if (header === undefined) return null;
  if (typeof header !== 'string' || header.length > 4_096) {
    throw new HttpBoundaryError(401, 'session_inactive');
  }
  let value: string | null = null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== SESSION_COOKIE) {
      continue;
    }
    if (value !== null) {
      throw new HttpBoundaryError(401, 'session_inactive');
    }
    value = part.slice(separator + 1).trim();
  }
  if (value === null) return null;
  if (!/^session_[A-Za-z0-9_-]{32,512}$/u.test(value)) {
    throw new HttpBoundaryError(401, 'session_inactive');
  }
  return value;
}

function requireCsrf(
  request: IncomingMessage,
  secret: string,
  sessionId: string,
): void {
  const supplied = request.headers['x-vidha-csrf'];
  const expected = csrfToken(secret, sessionId);
  if (typeof supplied !== 'string' || !constantTimeEqual(supplied, expected)) {
    throw new HttpBoundaryError(403, 'csrf_denied');
  }
}

function csrfToken(secret: string, sessionId: string): string {
  return createHmac('sha256', secret)
    .update(`vidha-csrf-v1\0${sessionId}`, 'utf8')
    .digest('base64url');
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function setSessionCookie(
  response: ServerResponse,
  sessionId: string,
  lifetimeMs: number,
): void {
  const maxAge = Math.max(1, Math.floor(lifetimeMs / 1_000));
  response.setHeader(
    'set-cookie',
    `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`,
  );
}

function clearSessionCookie(response: ServerResponse): void {
  response.setHeader(
    'set-cookie',
    `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
  );
}

function isIdentityPostPath(url: string | undefined): boolean {
  return (
    url === '/v1/identity/webauthn/bootstrap/options' ||
    url === '/v1/identity/webauthn/bootstrap/verify' ||
    url === '/v1/identity/webauthn/authentication/options' ||
    url === '/v1/identity/webauthn/authentication/verify' ||
    url === '/v1/identity/session/revoke'
  );
}

function isIdentityPath(url: string | undefined): boolean {
  return (
    url === '/rehearsal/webauthn' ||
    url === '/rehearsal/webauthn.css' ||
    url === '/rehearsal/webauthn.js' ||
    url === '/v1/identity/session' ||
    isIdentityPostPath(url)
  );
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader('cache-control', 'no-store');
  response.setHeader('content-security-policy', CONTENT_SECURITY_POLICY);
  response.setHeader('cross-origin-opener-policy', 'same-origin');
  response.setHeader('cross-origin-resource-policy', 'same-origin');
  response.setHeader(
    'permissions-policy',
    'publickey-credentials-create=(self), publickey-credentials-get=(self)',
  );
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('x-frame-options', 'DENY');
}

function writeAsset(
  response: ServerResponse,
  contentType: string,
  body: string,
): void {
  response.setHeader('content-type', contentType);
  response.writeHead(200).end(body);
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  value: Readonly<Record<string, unknown>>,
): void {
  if (response.headersSent) return;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.writeHead(statusCode).end(JSON.stringify(value));
}

function identityStatus(error: IdentityError): number {
  switch (error.code) {
    case 'AUTHENTICATION_DENIED':
    case 'COOLING_OFF':
    case 'RECENT_AUTHENTICATION_REQUIRED':
      return 403;
    case 'ALREADY_EXISTS':
    case 'IDEMPOTENCY_CONFLICT':
    case 'STALE_SECURITY_REVISION':
      return 409;
    case 'NOT_FOUND':
    case 'RECOVERY_NOT_PENDING':
      return 404;
    case 'INVALID_COMMAND':
      return 400;
  }
}

function identityPublicCode(error: IdentityError): string {
  return error.code.toLowerCase();
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

class HttpBoundaryError extends Error {
  constructor(
    readonly statusCode: number,
    readonly publicCode: string,
  ) {
    super(publicCode);
    this.name = 'HttpBoundaryError';
  }
}
