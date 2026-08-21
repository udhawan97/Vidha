export type PlanLifecycle = 'armed' | 'paused' | 'disabled';

export type CycleStage = 'on_time' | 'reminder' | 'overdue' | 'concern';

export type DomainEventType =
  | 'PLAN_ARMED'
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
  readonly commandKey: string;
}

export interface PlanState {
  readonly planId: string;
  readonly ownerId: string;
  readonly lifecycle: PlanLifecycle;
  readonly lastCommandAt: number;
  readonly policy: TimelinePolicy;
  readonly cycle: ConcernCycle;
  readonly processedCommandKeys: readonly string[];
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
    };

export type DomainErrorCode =
  | 'AUTHENTICATION_REQUIRED'
  | 'INVALID_COMMAND'
  | 'INVALID_POLICY'
  | 'INVALID_TIME'
  | 'PLAN_NOT_ARMED';

export class DomainError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}

interface CreateArmedPlanInput {
  readonly planId: string;
  readonly ownerId: string;
  readonly at: number;
  readonly policy: TimelinePolicy;
}

export function createArmedPlan(input: CreateArmedPlanInput): PlanState {
  validateTimestamp(input.at);
  validatePolicy(input.policy);

  return {
    planId: input.planId,
    ownerId: input.ownerId,
    lifecycle: 'armed',
    lastCommandAt: input.at,
    policy: { ...input.policy },
    cycle: createCycle(input.at, input.policy),
    processedCommandKeys: [],
    events: [createEvent('PLAN_ARMED', input.at, `initial:${input.planId}`)],
  };
}

export function applyPlanCommand(
  state: PlanState,
  command: PlanCommand,
): PlanState {
  validateCommand(command);

  if (state.processedCommandKeys.includes(command.idempotencyKey)) {
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

  return applyTimeAdvance(state, command);
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
    events.push(
      createEvent('CONCERN_CANCELLED', command.at, command.idempotencyKey),
    );
  }
  events.push(
    createEvent('OWNER_CHECKED_IN', command.at, command.idempotencyKey),
  );

  return {
    ...state,
    cycle: createCycle(command.at, state.policy),
    lastCommandAt: command.at,
    processedCommandKeys: [
      ...state.processedCommandKeys,
      command.idempotencyKey,
    ],
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

  if (state.lifecycle !== 'armed') {
    return { ...state, lastCommandAt: command.at, processedCommandKeys };
  }

  const transition = nextTimelineTransition(state.cycle, command.at);
  if (transition === null) {
    return { ...state, lastCommandAt: command.at, processedCommandKeys };
  }

  return {
    ...state,
    cycle: { ...state.cycle, stage: transition.stage },
    lastCommandAt: command.at,
    processedCommandKeys,
    events: [
      ...state.events,
      createEvent(transition.eventType, command.at, command.idempotencyKey),
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
  const dueAt = at + policy.checkInIntervalMs;

  return {
    stage: 'on_time',
    startedAt: at,
    reminderAt: dueAt - policy.reminderLeadMs,
    dueAt,
    concernAt: dueAt + policy.gracePeriodMs,
  };
}

function createEvent(
  type: DomainEventType,
  at: number,
  commandKey: string,
): DomainEvent {
  return {
    id: `${commandKey}:${type.toLowerCase()}`,
    type,
    at,
    commandKey,
  };
}

function validateCommand(command: PlanCommand): void {
  validateTimestamp(command.at);
  if (command.idempotencyKey.trim().length === 0) {
    throw new DomainError(
      'INVALID_COMMAND',
      'Every command requires a non-empty idempotency key.',
    );
  }
}

function validateTimestamp(at: number): void {
  if (!Number.isFinite(at)) {
    throw new DomainError('INVALID_TIME', 'Time must be a finite timestamp.');
  }
}

function validatePolicy(policy: TimelinePolicy): void {
  const values = [
    policy.checkInIntervalMs,
    policy.reminderLeadMs,
    policy.gracePeriodMs,
  ];

  if (values.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new DomainError(
      'INVALID_POLICY',
      'Timeline durations must be positive finite values.',
    );
  }

  if (policy.reminderLeadMs >= policy.checkInIntervalMs) {
    throw new DomainError(
      'INVALID_POLICY',
      'The reminder must occur after the cycle begins and before Check-in is due.',
    );
  }
}
