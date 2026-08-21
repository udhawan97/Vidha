export type PrincipalRole = 'owner' | 'guardian' | 'recipient' | 'operator';

export interface AuthenticatedPrincipal {
  readonly principalId: string;
  readonly role: PrincipalRole;
}

export interface AuthenticationSession {
  readonly sessionId: string;
  readonly principal: AuthenticatedPrincipal;
  readonly authenticatedAt: number;
  readonly expiresAt: number;
}

export interface SessionVerifier {
  verify(sessionId: string, at: number): Promise<AuthenticationSession | null>;
}

export interface CredentialProofVerifier {
  verifyAuthentication(input: {
    readonly assertion: string;
    readonly credentialId: string;
    readonly ownerId: string;
  }): Promise<{
    readonly verified: boolean;
    readonly userPresent: boolean;
    readonly userVerified: boolean;
  }>;
  verifyRecovery(input: {
    readonly attemptId: string;
    readonly factor: 'issued_channel' | 'saved_code';
    readonly ownerId: string;
    readonly proof: string;
  }): Promise<boolean>;
  verifyRegistration(input: {
    readonly credentialId: string;
    readonly ownerId: string;
    readonly proof: string;
  }): Promise<boolean>;
  verifyChannel(input: {
    readonly channelRef: string;
    readonly ownerId: string;
    readonly proof: string;
  }): Promise<boolean>;
}

export interface IdentityPolicy {
  readonly channelChangeCoolingOffMs: number;
  readonly recentAuthenticationWindowMs: number;
  readonly recoveryCoolingOffMs: number;
  readonly sessionLifetimeMs: number;
}

export interface IdentityNoticeIntent {
  readonly channelRef: string;
  readonly template:
    | 'credential_added'
    | 'credential_revoked'
    | 'recovery_cancelled'
    | 'recovery_completed'
    | 'recovery_started'
    | 'verified_channel_change_cancelled'
    | 'verified_channel_change_started'
    | 'verified_channel_changed';
}

interface CredentialRecord {
  readonly credentialId: string;
  readonly enrolledAt: number;
  readonly status: 'active' | 'revoked';
  readonly revokedAt?: number;
}

interface SessionRecord {
  readonly sessionDigest: string;
  readonly credentialId: string;
  readonly authenticatedAt: number;
  readonly expiresAt: number;
  readonly sessionEpoch: number;
  readonly revokedAt?: number;
}

interface RecoveryAttempt {
  readonly attemptId: string;
  readonly startedAt: number;
  readonly readyAt: number;
}

interface VerifiedChannelChange {
  readonly changeId: string;
  readonly previousChannelRef: string;
  readonly nextChannelRef: string;
  readonly startedAt: number;
  readonly readyAt: number;
}

interface ProcessedIdentityCommand {
  readonly commandKey: string;
  readonly fingerprint: string;
  readonly resultRevision: number;
}

export type IdentityEventType =
  | 'IDENTITY_INITIALIZED'
  | 'SESSION_ISSUED'
  | 'SESSION_REVOKED'
  | 'CREDENTIAL_ADDED'
  | 'CREDENTIAL_REVOKED'
  | 'RECOVERY_STARTED'
  | 'RECOVERY_CANCELLED'
  | 'RECOVERY_COMPLETED'
  | 'VERIFIED_CHANNEL_CHANGE_STARTED'
  | 'VERIFIED_CHANNEL_CHANGE_CANCELLED'
  | 'VERIFIED_CHANNEL_CHANGED';

export interface IdentityEvent {
  readonly eventId: string;
  readonly type: IdentityEventType;
  readonly at: number;
}

export interface OwnerIdentityState {
  readonly ownerId: string;
  readonly securityRevision: number;
  readonly sessionEpoch: number;
  readonly verifiedChannelRef: string;
  readonly credentials: readonly CredentialRecord[];
  readonly sessions: readonly SessionRecord[];
  readonly recovery: RecoveryAttempt | null;
  readonly verifiedChannelChange: VerifiedChannelChange | null;
  readonly processedCommands: readonly ProcessedIdentityCommand[];
  readonly events: readonly IdentityEvent[];
}

type IdentityCommandDetails =
  | {
      readonly type: 'ADD_CREDENTIAL';
      readonly actorSessionId: string;
      readonly newCredentialId: string;
      readonly ownerId: string;
      readonly registrationProof: string;
    }
  | {
      readonly type: 'REVOKE_SESSION';
      readonly actorSessionId: string;
      readonly ownerId: string;
      readonly targetSessionId: string;
    }
  | {
      readonly type: 'REVOKE_CREDENTIAL';
      readonly actorSessionId: string;
      readonly ownerId: string;
      readonly targetCredentialId: string;
    }
  | {
      readonly type: 'BEGIN_RECOVERY';
      readonly attemptId: string;
      readonly issuedChannelProof: string;
      readonly ownerId: string;
      readonly savedCodeProof: string;
    }
  | {
      readonly type: 'CANCEL_RECOVERY';
      readonly actorSessionId: string;
      readonly ownerId: string;
    }
  | {
      readonly type: 'COMPLETE_RECOVERY';
      readonly attemptId: string;
      readonly newCredentialId: string;
      readonly ownerId: string;
      readonly issuedChannelProof: string;
      readonly savedCodeProof: string;
      readonly registrationProof: string;
    }
  | {
      readonly type: 'BEGIN_VERIFIED_CHANNEL_CHANGE';
      readonly actorSessionId: string;
      readonly changeId: string;
      readonly nextChannelRef: string;
      readonly nextChannelVerificationProof: string;
      readonly ownerId: string;
    }
  | {
      readonly type: 'COMPLETE_VERIFIED_CHANNEL_CHANGE';
      readonly actorSessionId: string;
      readonly changeId: string;
      readonly ownerId: string;
    }
  | {
      readonly type: 'CANCEL_VERIFIED_CHANNEL_CHANGE';
      readonly actorSessionId: string;
      readonly changeId: string;
      readonly ownerId: string;
    };

interface IdentityCommandControl {
  readonly expectedSecurityRevision: number;
  readonly idempotencyKey: string;
}

export type IdentityCommand = IdentityCommandDetails & IdentityCommandControl;

export interface IdentityResult {
  readonly state: OwnerIdentityState;
  readonly noticeIntents: readonly IdentityNoticeIntent[];
  readonly duplicate: boolean;
}

export type IdentityErrorCode =
  | 'ALREADY_EXISTS'
  | 'AUTHENTICATION_DENIED'
  | 'COOLING_OFF'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVALID_COMMAND'
  | 'NOT_FOUND'
  | 'RECENT_AUTHENTICATION_REQUIRED'
  | 'RECOVERY_NOT_PENDING'
  | 'STALE_SECURITY_REVISION';

export class IdentityError extends Error {
  readonly code: IdentityErrorCode;

  constructor(code: IdentityErrorCode, message: string) {
    super(message);
    this.name = 'IdentityError';
    this.code = code;
  }
}

export interface OwnerIdentityCoordinator extends SessionVerifier {
  initialize(input: {
    readonly credentialId: string;
    readonly ownerId: string;
    readonly verifiedChannelRef: string;
  }): Promise<OwnerIdentityState>;
  authenticate(input: {
    readonly assertion: string;
    readonly credentialId: string;
    readonly ownerId: string;
  }): Promise<AuthenticationSession>;
  execute(command: IdentityCommand): Promise<IdentityResult>;
  read(ownerId: string): Promise<OwnerIdentityState | null>;
}

interface CreateOwnerIdentityCoordinatorInput {
  readonly clock: { now(): number };
  readonly policy: IdentityPolicy;
  readonly sessionIdGenerator?: () => string;
  readonly verifier: CredentialProofVerifier;
}

export function createOwnerIdentityCoordinator({
  clock,
  policy,
  sessionIdGenerator = generateSessionId,
  verifier,
}: CreateOwnerIdentityCoordinatorInput): OwnerIdentityCoordinator {
  validatePolicy(policy);
  const states = new Map<string, OwnerIdentityState>();
  let mutationTail: Promise<void> = Promise.resolve();

  async function serialize<T>(mutation: () => Promise<T>): Promise<T> {
    const pending = mutationTail.then(mutation);
    mutationTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return await pending;
  }

  return {
    async initialize(input) {
      return await serialize(async () => {
        const at = validNow(clock);
        validateOwnerId(input.ownerId);
        validateCredentialId(input.credentialId);
        validateChannelRef(input.verifiedChannelRef);
        if (states.has(input.ownerId)) {
          throw new IdentityError(
            'ALREADY_EXISTS',
            'Owner Identity already exists.',
          );
        }
        assertCredentialAvailable(states, input.credentialId);
        const state: OwnerIdentityState = {
          ownerId: input.ownerId,
          securityRevision: 1,
          sessionEpoch: 1,
          verifiedChannelRef: input.verifiedChannelRef,
          credentials: [
            {
              credentialId: input.credentialId,
              enrolledAt: at,
              status: 'active',
            },
          ],
          sessions: [],
          recovery: null,
          verifiedChannelChange: null,
          processedCommands: [],
          events: [event('IDENTITY_INITIALIZED', at, 0)],
        };
        states.set(input.ownerId, cloneState(state));
        return cloneState(state);
      });
    },
    async authenticate(input) {
      return await serialize(async () => {
        const at = validNow(clock);
        validateCredentialId(input.credentialId);
        const state = requireState(states, input.ownerId);
        const credential = state.credentials.find(
          (candidate) => candidate.credentialId === input.credentialId,
        );
        if (credential?.status !== 'active') {
          denied('The credential is not active for this Owner.');
        }
        const proof = await verifier.verifyAuthentication({
          assertion: input.assertion,
          credentialId: input.credentialId,
          ownerId: input.ownerId,
        });
        if (!proof.verified || !proof.userPresent || !proof.userVerified) {
          denied('Credential authentication requires verified user presence.');
        }
        const sessionId = sessionIdGenerator();
        validateSessionId(sessionId);
        const sessionDigest = await digestSessionId(sessionId);
        if (
          [...states.values()].some((candidate) =>
            candidate.sessions.some(
              (session) => session.sessionDigest === sessionDigest,
            ),
          )
        ) {
          throw new IdentityError(
            'INVALID_COMMAND',
            'The session generator produced a duplicate secret.',
          );
        }
        const expiresAt = safeAdd(at, policy.sessionLifetimeMs);
        const session: SessionRecord = {
          sessionDigest,
          credentialId: input.credentialId,
          authenticatedAt: at,
          expiresAt,
          sessionEpoch: state.sessionEpoch,
        };
        const next = appendEvent(
          { ...state, sessions: [...state.sessions, session] },
          'SESSION_ISSUED',
          at,
        );
        states.set(input.ownerId, cloneState(next));
        return canonicalSession(sessionId, input.ownerId, at, expiresAt);
      });
    },
    async verify(sessionId, at) {
      validateTime(at);
      if (!isSessionId(sessionId)) {
        return null;
      }
      const sessionDigest = await digestSessionId(sessionId);
      for (const state of states.values()) {
        const session = state.sessions.find(
          (candidate) => candidate.sessionDigest === sessionDigest,
        );
        if (
          session !== undefined &&
          session.revokedAt === undefined &&
          session.sessionEpoch === state.sessionEpoch &&
          session.authenticatedAt <= at &&
          session.expiresAt >= at
        ) {
          return canonicalSession(
            sessionId,
            state.ownerId,
            session.authenticatedAt,
            session.expiresAt,
          );
        }
      }
      return null;
    },
    async execute(command) {
      return await serialize(async () => {
        const at = validNow(clock);
        const state = requireState(states, command.ownerId);
        const commandKey = await deriveCommandKey(command.idempotencyKey);
        const fingerprint = await identityCommandFingerprint(command);
        const processed = state.processedCommands.find(
          (candidate) => candidate.commandKey === commandKey,
        );
        if (processed !== undefined) {
          if (processed.fingerprint !== fingerprint) {
            throw new IdentityError(
              'IDEMPOTENCY_CONFLICT',
              'An identity command key cannot be reused for different intent.',
            );
          }
          if (processed.resultRevision !== state.securityRevision) {
            throw new IdentityError(
              'STALE_SECURITY_REVISION',
              'The identity retry result is no longer the current security revision.',
            );
          }
          return {
            state: cloneState(state),
            noticeIntents: [],
            duplicate: true,
          };
        }
        validatePositiveSafeInteger(
          command.expectedSecurityRevision,
          'Expected security revision',
        );
        if (command.expectedSecurityRevision !== state.securityRevision) {
          throw new IdentityError(
            'STALE_SECURITY_REVISION',
            'The identity command targets a stale security revision.',
          );
        }
        if (command.type === 'ADD_CREDENTIAL') {
          assertCredentialAvailable(states, command.newCredentialId);
        } else if (command.type === 'COMPLETE_RECOVERY') {
          assertCredentialAvailable(states, command.newCredentialId);
        }
        const decided = await executeIdentityCommand(
          state,
          command,
          at,
          policy,
          verifier,
          async (sessionId) =>
            await verifyOwnerSession(states, command.ownerId, sessionId, at),
        );
        const next: OwnerIdentityState = {
          ...decided.state,
          securityRevision: state.securityRevision + 1,
          processedCommands: [
            ...state.processedCommands,
            {
              commandKey,
              fingerprint,
              resultRevision: state.securityRevision + 1,
            },
          ],
        };
        states.set(command.ownerId, cloneState(next));
        return {
          state: cloneState(next),
          noticeIntents: decided.noticeIntents.map((intent) => ({ ...intent })),
          duplicate: false,
        };
      });
    },
    async read(ownerId) {
      const state = states.get(ownerId);
      return state === undefined ? null : cloneState(state);
    },
  };
}

async function executeIdentityCommand(
  state: OwnerIdentityState,
  command: IdentityCommand,
  at: number,
  policy: IdentityPolicy,
  verifier: CredentialProofVerifier,
  ownerSession: (sessionId: string) => Promise<AuthenticationSession>,
): Promise<IdentityResult> {
  switch (command.type) {
    case 'ADD_CREDENTIAL': {
      await requireRecentSession(
        command.actorSessionId,
        at,
        policy,
        ownerSession,
      );
      validateCredentialId(command.newCredentialId);
      if (
        state.credentials.some(
          (credential) => credential.credentialId === command.newCredentialId,
        )
      ) {
        throw new IdentityError(
          'INVALID_COMMAND',
          'Credential identifiers cannot be reused.',
        );
      }
      if (
        !(await verifier.verifyRegistration({
          credentialId: command.newCredentialId,
          ownerId: command.ownerId,
          proof: command.registrationProof,
        }))
      ) {
        denied('Credential registration proof was not accepted.');
      }
      return result(
        appendEvent(
          {
            ...state,
            credentials: [
              ...state.credentials,
              {
                credentialId: command.newCredentialId,
                enrolledAt: at,
                status: 'active',
              },
            ],
          },
          'CREDENTIAL_ADDED',
          at,
        ),
        [
          {
            channelRef: state.verifiedChannelRef,
            template: 'credential_added',
          },
        ],
      );
    }
    case 'REVOKE_SESSION': {
      await requireRecentSession(
        command.actorSessionId,
        at,
        policy,
        ownerSession,
      );
      const targetDigest = await digestSessionId(command.targetSessionId);
      if (
        !state.sessions.some(
          (session) => session.sessionDigest === targetDigest,
        )
      ) {
        throw new IdentityError(
          'NOT_FOUND',
          'The target session does not exist.',
        );
      }
      return result(
        appendEvent(
          {
            ...state,
            sessions: state.sessions.map((session) =>
              session.sessionDigest === targetDigest &&
              session.revokedAt === undefined
                ? { ...session, revokedAt: at }
                : session,
            ),
          },
          'SESSION_REVOKED',
          at,
        ),
      );
    }
    case 'REVOKE_CREDENTIAL': {
      await requireRecentSession(
        command.actorSessionId,
        at,
        policy,
        ownerSession,
      );
      const target = state.credentials.find(
        (credential) => credential.credentialId === command.targetCredentialId,
      );
      if (target?.status !== 'active') {
        throw new IdentityError(
          'NOT_FOUND',
          'The active credential does not exist.',
        );
      }
      if (
        state.credentials.filter((credential) => credential.status === 'active')
          .length <= 1
      ) {
        throw new IdentityError(
          'INVALID_COMMAND',
          'The last active credential can be replaced only through recovery.',
        );
      }
      const next = revokeCredentialSessions(
        {
          ...state,
          credentials: state.credentials.map((credential) =>
            credential.credentialId === command.targetCredentialId
              ? { ...credential, status: 'revoked' as const, revokedAt: at }
              : credential,
          ),
        },
        command.targetCredentialId,
        at,
      );
      return result(appendEvent(next, 'CREDENTIAL_REVOKED', at), [
        {
          channelRef: state.verifiedChannelRef,
          template: 'credential_revoked',
        },
      ]);
    }
    case 'BEGIN_RECOVERY': {
      validateAttemptId(command.attemptId);
      if (state.recovery !== null) {
        throw new IdentityError(
          'INVALID_COMMAND',
          'Recovery is already pending.',
        );
      }
      const [savedCodeVerified, issuedChannelVerified] = await Promise.all([
        verifier.verifyRecovery({
          attemptId: command.attemptId,
          factor: 'saved_code',
          ownerId: command.ownerId,
          proof: command.savedCodeProof,
        }),
        verifier.verifyRecovery({
          attemptId: command.attemptId,
          factor: 'issued_channel',
          ownerId: command.ownerId,
          proof: command.issuedChannelProof,
        }),
      ]);
      if (!savedCodeVerified || !issuedChannelVerified) {
        denied('Both independently modeled recovery proofs are required.');
      }
      const next = {
        ...state,
        recovery: {
          attemptId: command.attemptId,
          startedAt: at,
          readyAt: safeAdd(at, policy.recoveryCoolingOffMs),
        },
      };
      return result(appendEvent(next, 'RECOVERY_STARTED', at), [
        { channelRef: state.verifiedChannelRef, template: 'recovery_started' },
      ]);
    }
    case 'CANCEL_RECOVERY': {
      await requireRecentSession(
        command.actorSessionId,
        at,
        policy,
        ownerSession,
      );
      if (state.recovery === null) {
        throw new IdentityError(
          'RECOVERY_NOT_PENDING',
          'Recovery is not pending.',
        );
      }
      return result(
        appendEvent({ ...state, recovery: null }, 'RECOVERY_CANCELLED', at),
        [
          {
            channelRef: state.verifiedChannelRef,
            template: 'recovery_cancelled',
          },
        ],
      );
    }
    case 'COMPLETE_RECOVERY': {
      validateCredentialId(command.newCredentialId);
      const recovery = state.recovery;
      if (recovery === null || recovery.attemptId !== command.attemptId) {
        throw new IdentityError(
          'RECOVERY_NOT_PENDING',
          'Recovery is not pending.',
        );
      }
      if (at < recovery.readyAt) {
        throw new IdentityError(
          'COOLING_OFF',
          'Recovery cooling-off is still active.',
        );
      }
      const [savedCodeVerified, issuedChannelVerified, registrationVerified] =
        await Promise.all([
          verifier.verifyRecovery({
            attemptId: command.attemptId,
            factor: 'saved_code',
            ownerId: command.ownerId,
            proof: command.savedCodeProof,
          }),
          verifier.verifyRecovery({
            attemptId: command.attemptId,
            factor: 'issued_channel',
            ownerId: command.ownerId,
            proof: command.issuedChannelProof,
          }),
          verifier.verifyRegistration({
            credentialId: command.newCredentialId,
            ownerId: command.ownerId,
            proof: command.registrationProof,
          }),
        ]);
      if (
        !savedCodeVerified ||
        !issuedChannelVerified ||
        !registrationVerified
      ) {
        denied('Recovery completion proofs were not accepted.');
      }
      if (
        state.credentials.some(
          (credential) => credential.credentialId === command.newCredentialId,
        )
      ) {
        throw new IdentityError(
          'INVALID_COMMAND',
          'Credential identifiers cannot be reused.',
        );
      }
      const next = revokeAllSessions(
        {
          ...state,
          sessionEpoch: state.sessionEpoch + 1,
          credentials: [
            ...state.credentials.map((credential) =>
              credential.status === 'active'
                ? { ...credential, status: 'revoked' as const, revokedAt: at }
                : credential,
            ),
            {
              credentialId: command.newCredentialId,
              enrolledAt: at,
              status: 'active',
            },
          ],
          recovery: null,
        },
        at,
      );
      return result(appendEvent(next, 'RECOVERY_COMPLETED', at), [
        {
          channelRef: state.verifiedChannelRef,
          template: 'recovery_completed',
        },
      ]);
    }
    case 'BEGIN_VERIFIED_CHANNEL_CHANGE': {
      await requireRecentSession(
        command.actorSessionId,
        at,
        policy,
        ownerSession,
      );
      validateAttemptId(command.changeId);
      validateChannelRef(command.nextChannelRef);
      if (state.verifiedChannelChange !== null) {
        throw new IdentityError(
          'INVALID_COMMAND',
          'A verified-channel change is already pending.',
        );
      }
      if (
        !(await verifier.verifyChannel({
          channelRef: command.nextChannelRef,
          ownerId: command.ownerId,
          proof: command.nextChannelVerificationProof,
        }))
      ) {
        denied('The next Owner channel was not verified.');
      }
      return result(
        appendEvent(
          {
            ...state,
            verifiedChannelChange: {
              changeId: command.changeId,
              previousChannelRef: state.verifiedChannelRef,
              nextChannelRef: command.nextChannelRef,
              startedAt: at,
              readyAt: safeAdd(at, policy.channelChangeCoolingOffMs),
            },
          },
          'VERIFIED_CHANNEL_CHANGE_STARTED',
          at,
        ),
        [
          {
            channelRef: state.verifiedChannelRef,
            template: 'verified_channel_change_started',
          },
          {
            channelRef: command.nextChannelRef,
            template: 'verified_channel_change_started',
          },
        ],
      );
    }
    case 'COMPLETE_VERIFIED_CHANNEL_CHANGE': {
      await requireRecentSession(
        command.actorSessionId,
        at,
        policy,
        ownerSession,
      );
      const change = state.verifiedChannelChange;
      if (change === null || change.changeId !== command.changeId) {
        throw new IdentityError(
          'NOT_FOUND',
          'The verified-channel change does not exist.',
        );
      }
      if (at < change.readyAt) {
        throw new IdentityError(
          'COOLING_OFF',
          'Verified-channel cooling-off is still active.',
        );
      }
      const next = revokeAllSessions(
        {
          ...state,
          sessionEpoch: state.sessionEpoch + 1,
          verifiedChannelRef: change.nextChannelRef,
          verifiedChannelChange: null,
        },
        at,
      );
      return result(appendEvent(next, 'VERIFIED_CHANNEL_CHANGED', at), [
        {
          channelRef: change.previousChannelRef,
          template: 'verified_channel_changed',
        },
        {
          channelRef: change.nextChannelRef,
          template: 'verified_channel_changed',
        },
      ]);
    }
    case 'CANCEL_VERIFIED_CHANNEL_CHANGE': {
      await requireRecentSession(
        command.actorSessionId,
        at,
        policy,
        ownerSession,
      );
      const change = state.verifiedChannelChange;
      if (change === null || change.changeId !== command.changeId) {
        throw new IdentityError(
          'NOT_FOUND',
          'The verified-channel change does not exist.',
        );
      }
      return result(
        appendEvent(
          { ...state, verifiedChannelChange: null },
          'VERIFIED_CHANNEL_CHANGE_CANCELLED',
          at,
        ),
        [
          {
            channelRef: change.previousChannelRef,
            template: 'verified_channel_change_cancelled',
          },
          {
            channelRef: change.nextChannelRef,
            template: 'verified_channel_change_cancelled',
          },
        ],
      );
    }
  }
}

async function requireRecentSession(
  sessionId: string,
  at: number,
  policy: IdentityPolicy,
  ownerSession: (sessionId: string) => Promise<AuthenticationSession>,
): Promise<AuthenticationSession> {
  const session = await ownerSession(sessionId);
  if (at - session.authenticatedAt > policy.recentAuthenticationWindowMs) {
    throw new IdentityError(
      'RECENT_AUTHENTICATION_REQUIRED',
      'This Identity change requires recent authentication.',
    );
  }
  return session;
}

async function verifyOwnerSession(
  states: ReadonlyMap<string, OwnerIdentityState>,
  ownerId: string,
  sessionId: string,
  at: number,
): Promise<AuthenticationSession> {
  validateSessionId(sessionId);
  const state = requireState(states, ownerId);
  const digest = await digestSessionId(sessionId);
  const session = state.sessions.find(
    (candidate) => candidate.sessionDigest === digest,
  );
  if (
    session === undefined ||
    session.revokedAt !== undefined ||
    session.sessionEpoch !== state.sessionEpoch ||
    session.authenticatedAt > at ||
    session.expiresAt < at
  ) {
    denied('The Owner session is not active.');
  }
  return canonicalSession(
    sessionId,
    ownerId,
    session.authenticatedAt,
    session.expiresAt,
  );
}

function revokeAllSessions(
  state: OwnerIdentityState,
  at: number,
): OwnerIdentityState {
  return {
    ...state,
    sessions: state.sessions.map((session) =>
      session.revokedAt === undefined ? { ...session, revokedAt: at } : session,
    ),
  };
}

function revokeCredentialSessions(
  state: OwnerIdentityState,
  credentialId: string,
  at: number,
): OwnerIdentityState {
  return {
    ...state,
    sessions: state.sessions.map((session) =>
      session.credentialId === credentialId && session.revokedAt === undefined
        ? { ...session, revokedAt: at }
        : session,
    ),
  };
}

function appendEvent(
  state: OwnerIdentityState,
  type: IdentityEventType,
  at: number,
): OwnerIdentityState {
  return {
    ...state,
    events: [...state.events, event(type, at, state.events.length)],
  };
}

function event(
  type: IdentityEventType,
  at: number,
  ordinal: number,
): IdentityEvent {
  return {
    eventId: `identity-event:${ordinal}:${type.toLowerCase()}`,
    type,
    at,
  };
}

function result(
  state: OwnerIdentityState,
  noticeIntents: readonly IdentityNoticeIntent[] = [],
): IdentityResult {
  return { state, noticeIntents, duplicate: false };
}

function canonicalSession(
  sessionId: string,
  ownerId: string,
  authenticatedAt: number,
  expiresAt: number,
): AuthenticationSession {
  return {
    sessionId,
    principal: { principalId: ownerId, role: 'owner' },
    authenticatedAt,
    expiresAt,
  };
}

function validatePolicy(policy: IdentityPolicy): void {
  const values = [
    policy.channelChangeCoolingOffMs,
    policy.recentAuthenticationWindowMs,
    policy.recoveryCoolingOffMs,
    policy.sessionLifetimeMs,
  ];
  if (values.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new IdentityError(
      'INVALID_COMMAND',
      'Identity policy durations must be positive safe integers.',
    );
  }
  if (policy.recentAuthenticationWindowMs > policy.sessionLifetimeMs) {
    throw new IdentityError(
      'INVALID_COMMAND',
      'Recent authentication cannot outlive a session.',
    );
  }
}

function requireState(
  states: ReadonlyMap<string, OwnerIdentityState>,
  ownerId: string,
): OwnerIdentityState {
  const state = states.get(ownerId);
  if (state === undefined) {
    throw new IdentityError('NOT_FOUND', 'Owner Identity does not exist.');
  }
  return cloneState(state);
}

function validNow(clock: { now(): number }): number {
  const at = clock.now();
  validateTime(at);
  return at;
}

function validateTime(at: number): void {
  if (!Number.isSafeInteger(at)) {
    throw new IdentityError(
      'INVALID_COMMAND',
      'Identity time must be a safe integer.',
    );
  }
}

function validatePositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new IdentityError(
      'INVALID_COMMAND',
      `${label} must be a positive safe integer.`,
    );
  }
}

function safeAdd(left: number, right: number): number {
  const result = left + right;
  validateTime(result);
  return result;
}

function validateOwnerId(value: string): void {
  if (!/^owner_[a-f0-9]{64}$/u.test(value)) {
    throw new IdentityError(
      'INVALID_COMMAND',
      'Owner identifiers must be opaque.',
    );
  }
}

function validateCredentialId(value: string): void {
  if (!/^credential_[A-Za-z0-9_-]{32,512}$/u.test(value)) {
    throw new IdentityError(
      'INVALID_COMMAND',
      'Credential identifiers must be opaque.',
    );
  }
}

function validateChannelRef(value: string): void {
  if (!/^channel_[a-f0-9]{64}$/u.test(value)) {
    throw new IdentityError(
      'INVALID_COMMAND',
      'Verified channel references must be opaque.',
    );
  }
}

function validateAttemptId(value: string): void {
  if (!/^(?:recovery|change)_[a-f0-9]{64}$/u.test(value)) {
    throw new IdentityError(
      'INVALID_COMMAND',
      'Attempt identifiers must be opaque.',
    );
  }
}

function validateSessionId(value: string): void {
  if (!isSessionId(value)) {
    throw new IdentityError(
      'INVALID_COMMAND',
      'Session identifiers must be high entropy.',
    );
  }
}

function isSessionId(value: string): boolean {
  return /^session_[A-Za-z0-9_-]{32,512}$/u.test(value);
}

async function digestSessionId(sessionId: string): Promise<string> {
  return await sha256Text(sessionId);
}

async function deriveCommandKey(idempotencyKey: string): Promise<string> {
  if (!/^[\x21-\x7e]{1,512}$/u.test(idempotencyKey)) {
    throw new IdentityError(
      'INVALID_COMMAND',
      'Identity idempotency keys must be bounded non-secret request values.',
    );
  }
  return await sha256Text(`vidha:identity-command:v1:${idempotencyKey}`);
}

async function identityCommandFingerprint(
  command: IdentityCommand,
): Promise<string> {
  const control = {
    type: command.type,
    expectedSecurityRevision: command.expectedSecurityRevision,
  };
  let semantic: object;
  switch (command.type) {
    case 'ADD_CREDENTIAL':
      semantic = {
        ...control,
        actorSessionId: command.actorSessionId,
        newCredentialId: command.newCredentialId,
      };
      break;
    case 'REVOKE_SESSION':
      semantic = {
        ...control,
        actorSessionId: command.actorSessionId,
        targetSessionId: command.targetSessionId,
      };
      break;
    case 'REVOKE_CREDENTIAL':
      semantic = {
        ...control,
        actorSessionId: command.actorSessionId,
        targetCredentialId: command.targetCredentialId,
      };
      break;
    case 'BEGIN_RECOVERY':
      semantic = { ...control, attemptId: command.attemptId };
      break;
    case 'CANCEL_RECOVERY':
      semantic = { ...control, actorSessionId: command.actorSessionId };
      break;
    case 'COMPLETE_RECOVERY':
      semantic = {
        ...control,
        attemptId: command.attemptId,
        newCredentialId: command.newCredentialId,
      };
      break;
    case 'BEGIN_VERIFIED_CHANNEL_CHANGE':
      semantic = {
        ...control,
        actorSessionId: command.actorSessionId,
        changeId: command.changeId,
        nextChannelRef: command.nextChannelRef,
      };
      break;
    case 'COMPLETE_VERIFIED_CHANNEL_CHANGE':
    case 'CANCEL_VERIFIED_CHANNEL_CHANGE':
      semantic = {
        ...control,
        actorSessionId: command.actorSessionId,
        changeId: command.changeId,
      };
      break;
  }
  return await sha256Text(JSON.stringify(semantic));
}

function assertCredentialAvailable(
  states: ReadonlyMap<string, OwnerIdentityState>,
  credentialId: string,
): void {
  validateCredentialId(credentialId);
  if (
    [...states.values()].some((state) =>
      state.credentials.some(
        (credential) => credential.credentialId === credentialId,
      ),
    )
  ) {
    throw new IdentityError(
      'INVALID_COMMAND',
      'Credential identifiers cannot be reused across Owner identities.',
    );
  }
}

function generateSessionId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  const secret = btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
  return `session_${secret}`;
}

async function sha256Text(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function denied(message: string): never {
  throw new IdentityError('AUTHENTICATION_DENIED', message);
}

function cloneState(state: OwnerIdentityState): OwnerIdentityState {
  return structuredClone(state);
}
