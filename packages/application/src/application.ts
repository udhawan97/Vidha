import {
  applyPlanCommand,
  type PlanCommand,
  type PlanState,
} from '@vidha/domain';
import type {
  AuthenticatedPrincipal,
  AuthenticationSession,
  SessionVerifier,
} from '@vidha/identity';

export type {
  AuthenticatedPrincipal,
  AuthenticationSession,
  PrincipalRole,
  SessionVerifier,
} from '@vidha/identity';

export interface Clock {
  now(): number;
}

export interface PlanTransactionResult {
  readonly state: PlanState;
  readonly duplicate: boolean;
}

export interface PlanTransactionStore {
  initialize(state: PlanState): Promise<void>;
  read(planId: string): Promise<PlanState | null>;
  transact(
    planId: string,
    commandKey: string,
    commandFingerprint: string,
    authorize: (state: PlanState) => void,
    decide: (state: PlanState) => PlanState,
  ): Promise<PlanTransactionResult>;
}

export interface ReminderChallenge {
  readonly challengeId: string;
  readonly planId: string;
  readonly expiresAt: number;
}

export interface ReminderInspection {
  readonly challengeId: string;
  readonly planId: string;
  readonly navigationOnly: true;
  readonly status: 'ready' | 'expired' | 'invalid_method';
}

type InteractivePlanAction =
  | { readonly type: 'OWNER_CHECK_IN' }
  | {
      readonly type: 'REHEARSE_PLAN';
      readonly expectedPolicyRevision: number;
    }
  | {
      readonly type: 'ARM_PLAN' | 'PAUSE_PLAN' | 'RESUME_PLAN' | 'DISABLE_PLAN';
      readonly expectedPolicyRevision: number;
    };

export interface InteractivePlanRequest {
  readonly action: InteractivePlanAction;
  readonly idempotencyKey: string;
  readonly method: string;
  readonly planId: string;
  readonly userPresence: boolean;
}

export type ApplicationErrorCode =
  | 'AUTHENTICATION_EXPIRED'
  | 'AUTHORIZATION_DENIED'
  | 'INVALID_IDEMPOTENCY_KEY'
  | 'METHOD_NOT_ALLOWED'
  | 'RECENT_AUTHENTICATION_REQUIRED'
  | 'USER_PRESENCE_REQUIRED';

export class ApplicationError extends Error {
  readonly code: ApplicationErrorCode;

  constructor(code: ApplicationErrorCode, message: string) {
    super(message);
    this.name = 'ApplicationError';
    this.code = code;
  }
}

export interface PlanApplication {
  advanceScheduled(
    planId: string,
    idempotencyKey: string,
  ): Promise<PlanTransactionResult>;
  execute(
    session: Pick<AuthenticationSession, 'sessionId'>,
    request: InteractivePlanRequest,
  ): Promise<PlanTransactionResult>;
  inspectReminder(
    challenge: ReminderChallenge,
    method: string,
  ): ReminderInspection;
}

interface CreatePlanApplicationInput {
  readonly clock: Clock;
  readonly recentAuthenticationWindowMs: number;
  readonly sessionVerifier: SessionVerifier;
  readonly store: PlanTransactionStore;
}

export function createPlanApplication({
  clock,
  recentAuthenticationWindowMs,
  sessionVerifier,
  store,
}: CreatePlanApplicationInput): PlanApplication {
  if (
    !Number.isSafeInteger(recentAuthenticationWindowMs) ||
    recentAuthenticationWindowMs <= 0
  ) {
    throw new RangeError('The recent-authentication window must be positive.');
  }

  return {
    async advanceScheduled(planId, idempotencyKey) {
      const at = clock.now();
      const commandKey = await deriveOpaqueCommandKey(idempotencyKey);
      return await store.transact(
        planId,
        commandKey,
        'ADVANCE_TIME',
        () => undefined,
        (state) =>
          applyPlanCommand(state, {
            type: 'ADVANCE_TIME',
            at,
            idempotencyKey: commandKey,
          }),
      );
    },
    async execute(sessionReference, request) {
      const at = clock.now();
      requireInteractiveRequest(request);
      const session = await sessionVerifier.verify(
        sessionReference.sessionId,
        at,
      );
      if (session === null) {
        throw new ApplicationError(
          'AUTHENTICATION_EXPIRED',
          'The authenticated session is unavailable or inactive.',
        );
      }
      requireInteractiveAuthentication(session, at);
      const recentlyAuthenticated =
        at - session.authenticatedAt <= recentAuthenticationWindowMs;
      const commandKey = await deriveOpaqueCommandKey(request.idempotencyKey);
      const commandFingerprint = interactiveCommandFingerprint(request.action);

      return await store.transact(
        request.planId,
        commandKey,
        commandFingerprint,
        (state) => {
          requireOwner(session.principal, state);
          requireActionAuthentication(request.action, recentlyAuthenticated);
        },
        (state) => {
          const command = toDomainCommand(
            request,
            at,
            recentlyAuthenticated,
            commandKey,
          );
          return applyPlanCommand(state, command);
        },
      );
    },
    inspectReminder(challenge, method) {
      const status =
        method !== 'GET' && method !== 'HEAD'
          ? 'invalid_method'
          : clock.now() > challenge.expiresAt
            ? 'expired'
            : 'ready';
      return {
        challengeId: challenge.challengeId,
        planId: challenge.planId,
        navigationOnly: true,
        status,
      };
    },
  };
}

function requireInteractiveAuthentication(
  session: AuthenticationSession,
  at: number,
): void {
  if (
    !Number.isSafeInteger(at) ||
    !Number.isSafeInteger(session.authenticatedAt) ||
    !Number.isSafeInteger(session.expiresAt) ||
    session.authenticatedAt > session.expiresAt
  ) {
    throw new ApplicationError(
      'AUTHENTICATION_EXPIRED',
      'The authenticated session has invalid time bounds.',
    );
  }
  requireActiveSession(session, at);
}

function requireInteractiveRequest(request: InteractivePlanRequest): void {
  if (request.method !== 'POST') {
    throw new ApplicationError(
      'METHOD_NOT_ALLOWED',
      'Only an explicit POST may submit a Plan command.',
    );
  }
  if (!request.userPresence) {
    throw new ApplicationError(
      'USER_PRESENCE_REQUIRED',
      'An explicit user-presence action is required.',
    );
  }
}

function requireActiveSession(
  session: AuthenticationSession,
  at: number,
): void {
  if (session.authenticatedAt > at || session.expiresAt < at) {
    throw new ApplicationError(
      'AUTHENTICATION_EXPIRED',
      'The authenticated session is not active at command time.',
    );
  }
}

function requireOwner(
  principal: AuthenticatedPrincipal,
  state: PlanState,
): void {
  if (principal.role !== 'owner' || principal.principalId !== state.ownerId) {
    throw new ApplicationError(
      'AUTHORIZATION_DENIED',
      'Only this Contingency Plan’s Owner may submit the command.',
    );
  }
}

function toDomainCommand(
  request: InteractivePlanRequest,
  at: number,
  recentlyAuthenticated: boolean,
  commandKey: string,
): PlanCommand {
  if (request.action.type === 'OWNER_CHECK_IN') {
    return {
      type: request.action.type,
      at,
      authenticated: true,
      idempotencyKey: commandKey,
    };
  }

  if (request.action.type === 'REHEARSE_PLAN') {
    return {
      type: request.action.type,
      at,
      authenticated: true,
      expectedPolicyRevision: request.action.expectedPolicyRevision,
      idempotencyKey: commandKey,
    };
  }

  if (!recentlyAuthenticated) {
    throw new ApplicationError(
      'RECENT_AUTHENTICATION_REQUIRED',
      'This lifecycle command requires recent authentication.',
    );
  }

  return {
    type: request.action.type,
    at,
    authenticated: true,
    recentlyAuthenticated: true,
    expectedPolicyRevision: request.action.expectedPolicyRevision,
    idempotencyKey: commandKey,
  };
}

function requireActionAuthentication(
  action: InteractivePlanAction,
  recentlyAuthenticated: boolean,
): void {
  if (
    action.type !== 'OWNER_CHECK_IN' &&
    action.type !== 'REHEARSE_PLAN' &&
    !recentlyAuthenticated
  ) {
    throw new ApplicationError(
      'RECENT_AUTHENTICATION_REQUIRED',
      'This lifecycle command requires recent authentication.',
    );
  }
}

function interactiveCommandFingerprint(action: InteractivePlanAction): string {
  return 'expectedPolicyRevision' in action
    ? `${action.type}:policy:${action.expectedPolicyRevision}`
    : action.type;
}

export async function deriveOpaqueCommandKey(rawKey: string): Promise<string> {
  if (rawKey.length === 0 || rawKey.length > 512) {
    throw new ApplicationError(
      'INVALID_IDEMPOTENCY_KEY',
      'The idempotency key must contain between 1 and 512 characters.',
    );
  }
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(rawKey),
  );
  return `cmd_${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`;
}
