import {
  applyPlanCommand,
  type PlanCommand,
  type PlanState,
} from '@vidha/domain';

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
    session: AuthenticationSession,
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
  readonly store: PlanTransactionStore;
}

export function createPlanApplication({
  clock,
  recentAuthenticationWindowMs,
  store,
}: CreatePlanApplicationInput): PlanApplication {
  if (
    !Number.isFinite(recentAuthenticationWindowMs) ||
    recentAuthenticationWindowMs <= 0
  ) {
    throw new RangeError('The recent-authentication window must be positive.');
  }

  return {
    async advanceScheduled(planId, idempotencyKey) {
      const at = clock.now();
      return await store.transact(
        planId,
        idempotencyKey,
        () => undefined,
        (state) =>
          applyPlanCommand(state, {
            type: 'ADVANCE_TIME',
            at,
            idempotencyKey,
          }),
      );
    },
    async execute(session, request) {
      const at = clock.now();
      requireInteractiveAuthentication(session, request, at);
      const recentlyAuthenticated =
        at - session.authenticatedAt <= recentAuthenticationWindowMs;

      return await store.transact(
        request.planId,
        request.idempotencyKey,
        (state) => requireOwner(session.principal, state),
        (state) => {
          const command = toDomainCommand(request, at, recentlyAuthenticated);
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
  request: InteractivePlanRequest,
  at: number,
): void {
  if (
    !Number.isFinite(at) ||
    !Number.isFinite(session.authenticatedAt) ||
    !Number.isFinite(session.expiresAt) ||
    session.authenticatedAt > session.expiresAt
  ) {
    throw new ApplicationError(
      'AUTHENTICATION_EXPIRED',
      'The authenticated session has invalid time bounds.',
    );
  }
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
): PlanCommand {
  if (request.action.type === 'OWNER_CHECK_IN') {
    return {
      type: request.action.type,
      at,
      authenticated: true,
      idempotencyKey: request.idempotencyKey,
    };
  }

  if (request.action.type === 'REHEARSE_PLAN') {
    return {
      type: request.action.type,
      at,
      authenticated: true,
      expectedPolicyRevision: request.action.expectedPolicyRevision,
      idempotencyKey: request.idempotencyKey,
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
    idempotencyKey: request.idempotencyKey,
  };
}
