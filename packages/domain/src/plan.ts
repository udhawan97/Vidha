export type PlanLifecycle = 'draft' | 'armed' | 'paused' | 'disabled';

export type CycleStage = 'on_time' | 'reminder' | 'overdue' | 'concern';

export type DomainEventType =
  | 'PLAN_DRAFTED'
  | 'PLAN_REHEARSED'
  | 'PLAN_ARMED'
  | 'PLAN_PAUSED'
  | 'PLAN_RESUMED'
  | 'PLAN_DISABLED'
  | 'REMINDER_ENTERED'
  | 'OVERDUE_ENTERED'
  | 'CONCERN_ENTERED'
  | 'CONCERN_CANCELLED'
  | 'OWNER_CHECKED_IN';

export interface TimelinePolicy {
  readonly checkInIntervalMs: number;
  readonly reminderLeadMs: number;
  readonly gracePeriodMs: number;
}

export interface ConcernCycle {
  readonly stage: CycleStage;
  readonly startedAt: number;
  readonly reminderAt: number;
  readonly dueAt: number;
  readonly concernAt: number;
}

export interface DomainEvent {
  readonly id: string;
  readonly type: DomainEventType;
  readonly at: number;
}

export interface PlanState {
  readonly planId: string;
  readonly ownerId: string;
  readonly lifecycle: PlanLifecycle;
  readonly policyRevision: number;
  readonly hasRehearsed: boolean;
  readonly lastCommandAt: number;
  readonly policy: TimelinePolicy;
  readonly cycle: ConcernCycle;
  readonly processedCommandKeys: readonly string[];
  readonly processedCommandFingerprints: Readonly<Record<string, string>>;
  readonly events: readonly DomainEvent[];
}

export type PlanCommand =
  | {
      readonly type: 'ADVANCE_TIME';
      readonly at: number;
      readonly idempotencyKey: string;
    }
  | {
      readonly type: 'OWNER_CHECK_IN';
      readonly at: number;
      readonly idempotencyKey: string;
      readonly authenticated: boolean;
    }
  | {
      readonly type: 'REHEARSE_PLAN';
      readonly at: number;
      readonly idempotencyKey: string;
      readonly authenticated: boolean;
      readonly expectedPolicyRevision: number;
    }
  | {
      readonly type: 'ARM_PLAN' | 'PAUSE_PLAN' | 'RESUME_PLAN' | 'DISABLE_PLAN';
      readonly at: number;
      readonly idempotencyKey: string;
      readonly authenticated: boolean;
      readonly recentlyAuthenticated: boolean;
      readonly expectedPolicyRevision: number;
    };

export type DomainErrorCode =
  | 'AUTHENTICATION_REQUIRED'
  | 'INVALID_COMMAND'
  | 'INVALID_POLICY'
  | 'INVALID_TIME'
  | 'INVALID_LIFECYCLE_TRANSITION'
  | 'PLAN_NOT_ARMED'
  | 'POLICY_REVISION_MISMATCH'
  | 'RECENT_AUTHENTICATION_REQUIRED'
  | 'REHEARSAL_REQUIRED';

export class DomainError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}

interface CreateDraftPlanInput {
  readonly planId: string;
  readonly ownerId: string;
  readonly at: number;
  readonly policy: TimelinePolicy;
}

export function createDraftPlan(input: CreateDraftPlanInput): PlanState {
  validateTimestamp(input.at);
  validatePolicy(input.policy);
  validateOpaqueIdentifier(input.planId, 'Plan');
  validateOpaqueIdentifier(input.ownerId, 'Owner');

  return {
    planId: input.planId,
    ownerId: input.ownerId,
    lifecycle: 'draft',
    policyRevision: 1,
    hasRehearsed: false,
    lastCommandAt: input.at,
    policy: { ...input.policy },
    cycle: createCycle(input.at, input.policy),
    processedCommandKeys: [],
    processedCommandFingerprints: {},
    events: [createEvent('PLAN_DRAFTED', input.at, 0)],
  };
}

export function applyPlanCommand(
  state: PlanState,
  command: PlanCommand,
): PlanState {
  validateCommand(command);

  const fingerprint = planCommandFingerprint(command);
  const existingFingerprint =
    state.processedCommandFingerprints[command.idempotencyKey];
  if (existingFingerprint !== undefined) {
    if (existingFingerprint !== fingerprint) {
      throw new DomainError(
        'INVALID_COMMAND',
        'An idempotency key cannot be reused for different command semantics.',
      );
    }
    return state;
  }

  if (command.at < state.lastCommandAt) {
    throw new DomainError(
      'INVALID_TIME',
      'A command cannot occur before the last accepted command.',
    );
  }

  if (command.type === 'OWNER_CHECK_IN') {
    return applyOwnerCheckIn(state, command);
  }

  if (command.type !== 'ADVANCE_TIME') {
    return applyLifecycleCommand(state, command);
  }

  return applyTimeAdvance(state, command);
}

function applyLifecycleCommand(
  state: PlanState,
  command: Exclude<PlanCommand, { type: 'ADVANCE_TIME' | 'OWNER_CHECK_IN' }>,
): PlanState {
  if (!command.authenticated) {
    throw new DomainError(
      'AUTHENTICATION_REQUIRED',
      'Plan lifecycle changes require an authenticated Owner action.',
    );
  }
  if (command.expectedPolicyRevision !== state.policyRevision) {
    throw new DomainError(
      'POLICY_REVISION_MISMATCH',
      'The Plan policy changed before this lifecycle command was accepted.',
    );
  }

  if (command.type === 'REHEARSE_PLAN') {
    requireLifecycle(state, 'draft', command.type);
    return acceptLifecycleCommand(state, command, {
      eventTypes: ['PLAN_REHEARSED'],
      hasRehearsed: true,
    });
  }

  if (!command.recentlyAuthenticated) {
    throw new DomainError(
      'RECENT_AUTHENTICATION_REQUIRED',
      'This Plan lifecycle change requires recent authentication.',
    );
  }

  switch (command.type) {
    case 'ARM_PLAN':
      requireLifecycle(state, 'draft', command.type);
      if (!state.hasRehearsed) {
        throw new DomainError(
          'REHEARSAL_REQUIRED',
          'A Plan must be rehearsed before it can be armed.',
        );
      }
      return acceptLifecycleCommand(state, command, {
        cycle: createCycle(command.at, state.policy),
        eventTypes: ['PLAN_ARMED'],
        lifecycle: 'armed',
      });
    case 'PAUSE_PLAN':
      requireLifecycle(state, 'armed', command.type);
      return acceptLifecycleCommand(state, command, {
        eventTypes: ['PLAN_PAUSED'],
        lifecycle: 'paused',
      });
    case 'RESUME_PLAN': {
      requireLifecycle(state, 'paused', command.type);
      const eventTypes: DomainEventType[] = [];
      if (state.cycle.stage === 'concern') {
        eventTypes.push('CONCERN_CANCELLED');
      }
      eventTypes.push('PLAN_RESUMED');
      return acceptLifecycleCommand(state, command, {
        cycle: createCycle(command.at, state.policy),
        eventTypes,
        lifecycle: 'armed',
      });
    }
    case 'DISABLE_PLAN': {
      if (state.lifecycle === 'disabled') {
        throw new DomainError(
          'INVALID_LIFECYCLE_TRANSITION',
          'A disabled Plan is a terminal state.',
        );
      }
      const eventTypes: DomainEventType[] = [];
      if (state.cycle.stage === 'concern') {
        eventTypes.push('CONCERN_CANCELLED');
      }
      eventTypes.push('PLAN_DISABLED');
      return acceptLifecycleCommand(state, command, {
        cycle:
          state.cycle.stage === 'concern'
            ? createCycle(command.at, state.policy)
            : state.cycle,
        eventTypes,
        lifecycle: 'disabled',
      });
    }
  }
}

interface LifecycleUpdate {
  readonly lifecycle?: PlanLifecycle;
  readonly hasRehearsed?: boolean;
  readonly cycle?: ConcernCycle;
  readonly eventTypes: readonly DomainEventType[];
}

function acceptLifecycleCommand(
  state: PlanState,
  command: PlanCommand,
  update: LifecycleUpdate,
): PlanState {
  return {
    ...state,
    ...(update.lifecycle === undefined ? {} : { lifecycle: update.lifecycle }),
    ...(update.hasRehearsed === undefined
      ? {}
      : { hasRehearsed: update.hasRehearsed }),
    ...(update.cycle === undefined ? {} : { cycle: update.cycle }),
    lastCommandAt: command.at,
    processedCommandKeys: [
      ...state.processedCommandKeys,
      command.idempotencyKey,
    ],
    processedCommandFingerprints: {
      ...state.processedCommandFingerprints,
      [command.idempotencyKey]: planCommandFingerprint(command),
    },
    events: [
      ...state.events,
      ...update.eventTypes.map((eventType, index) =>
        createEvent(eventType, command.at, state.events.length + index),
      ),
    ],
  };
}

function requireLifecycle(
  state: PlanState,
  expected: PlanLifecycle,
  commandType: PlanCommand['type'],
): void {
  if (state.lifecycle !== expected) {
    throw new DomainError(
      'INVALID_LIFECYCLE_TRANSITION',
      `${commandType} requires a ${expected} Plan.`,
    );
  }
}

function applyOwnerCheckIn(
  state: PlanState,
  command: Extract<PlanCommand, { type: 'OWNER_CHECK_IN' }>,
): PlanState {
  if (!command.authenticated) {
    throw new DomainError(
      'AUTHENTICATION_REQUIRED',
      'Check-in requires a fresh authenticated Owner action.',
    );
  }

  if (state.lifecycle !== 'armed') {
    throw new DomainError(
      'PLAN_NOT_ARMED',
      'Only an armed plan can accept a Check-in.',
    );
  }

  const events = [...state.events];
  if (state.cycle.stage === 'concern') {
    events.push(createEvent('CONCERN_CANCELLED', command.at, events.length));
  }
  events.push(createEvent('OWNER_CHECKED_IN', command.at, events.length));

  return {
    ...state,
    cycle: createCycle(command.at, state.policy),
    lastCommandAt: command.at,
    processedCommandKeys: [
      ...state.processedCommandKeys,
      command.idempotencyKey,
    ],
    processedCommandFingerprints: {
      ...state.processedCommandFingerprints,
      [command.idempotencyKey]: planCommandFingerprint(command),
    },
    events,
  };
}

function applyTimeAdvance(
  state: PlanState,
  command: Extract<PlanCommand, { type: 'ADVANCE_TIME' }>,
): PlanState {
  const processedCommandKeys = [
    ...state.processedCommandKeys,
    command.idempotencyKey,
  ];
  const processedCommandFingerprints = {
    ...state.processedCommandFingerprints,
    [command.idempotencyKey]: planCommandFingerprint(command),
  };

  if (state.lifecycle !== 'armed') {
    return {
      ...state,
      lastCommandAt: command.at,
      processedCommandKeys,
      processedCommandFingerprints,
    };
  }

  const transition = nextTimelineTransition(state.cycle, command.at);
  if (transition === null) {
    return {
      ...state,
      lastCommandAt: command.at,
      processedCommandKeys,
      processedCommandFingerprints,
    };
  }

  return {
    ...state,
    cycle: { ...state.cycle, stage: transition.stage },
    lastCommandAt: command.at,
    processedCommandKeys,
    processedCommandFingerprints,
    events: [
      ...state.events,
      createEvent(transition.eventType, command.at, state.events.length),
    ],
  };
}

function nextTimelineTransition(
  cycle: ConcernCycle,
  at: number,
): { stage: CycleStage; eventType: DomainEventType } | null {
  switch (cycle.stage) {
    case 'on_time':
      return at >= cycle.reminderAt
        ? { stage: 'reminder', eventType: 'REMINDER_ENTERED' }
        : null;
    case 'reminder':
      return at >= cycle.dueAt
        ? { stage: 'overdue', eventType: 'OVERDUE_ENTERED' }
        : null;
    case 'overdue':
      return at >= cycle.concernAt
        ? { stage: 'concern', eventType: 'CONCERN_ENTERED' }
        : null;
    case 'concern':
      return null;
  }
}

function createCycle(at: number, policy: TimelinePolicy): ConcernCycle {
  const dueAt = safeTimestampAdd(at, policy.checkInIntervalMs);

  return {
    stage: 'on_time',
    startedAt: at,
    reminderAt: safeTimestampAdd(dueAt, -policy.reminderLeadMs),
    dueAt,
    concernAt: safeTimestampAdd(dueAt, policy.gracePeriodMs),
  };
}

function createEvent(
  type: DomainEventType,
  at: number,
  ordinal: number,
): DomainEvent {
  return {
    id: `event:${ordinal}:${type.toLowerCase()}`,
    type,
    at,
  };
}

export function planCommandFingerprint(command: PlanCommand): string {
  switch (command.type) {
    case 'ADVANCE_TIME':
    case 'OWNER_CHECK_IN':
      return command.type;
    case 'REHEARSE_PLAN':
    case 'ARM_PLAN':
    case 'PAUSE_PLAN':
    case 'RESUME_PLAN':
    case 'DISABLE_PLAN':
      return `${command.type}:policy:${command.expectedPolicyRevision}`;
  }
}

function validateCommand(command: PlanCommand): void {
  validateTimestamp(command.at);
  if (!/^cmd_[a-f0-9]{64}$/u.test(command.idempotencyKey)) {
    throw new DomainError(
      'INVALID_COMMAND',
      'Every command requires an opaque SHA-256 command identifier.',
    );
  }
}

function validateTimestamp(at: number): void {
  if (!Number.isSafeInteger(at)) {
    throw new DomainError(
      'INVALID_TIME',
      'Time must be a safe-integer timestamp.',
    );
  }
}

function validatePolicy(policy: TimelinePolicy): void {
  const values = [
    policy.checkInIntervalMs,
    policy.reminderLeadMs,
    policy.gracePeriodMs,
  ];

  if (values.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new DomainError(
      'INVALID_POLICY',
      'Timeline durations must be positive safe-integer values.',
    );
  }

  if (policy.reminderLeadMs >= policy.checkInIntervalMs) {
    throw new DomainError(
      'INVALID_POLICY',
      'The reminder must occur after the cycle begins and before Check-in is due.',
    );
  }
}

function safeTimestampAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new DomainError(
      'INVALID_TIME',
      'Timeline arithmetic must remain within safe-integer bounds.',
    );
  }
  return result;
}

function validateOpaqueIdentifier(value: string, label: string): void {
  if (!/^[a-z][a-z0-9_-]{7,63}$/.test(value)) {
    throw new DomainError(
      'INVALID_COMMAND',
      `${label} identifiers must be opaque lowercase identifiers between 8 and 64 characters.`,
    );
  }
}
