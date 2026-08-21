import type { PlanTransactionStore } from '@vidha/application';
import type { DomainEventType, PlanState } from '@vidha/domain';

export const PLAN_STORE_SCHEMA_VERSION = 1;

export type StoreMode = 'live' | 'restore_safe';

export interface AuditRecord {
  readonly planId: string;
  readonly eventId: string;
  readonly type: DomainEventType;
  readonly occurredAt: number;
  readonly ordinal: number;
}

export interface ProcessedCommandRecord {
  readonly planId: string;
  readonly commandKey: string;
  readonly commandFingerprint: string;
  readonly processedAt: number;
}

export interface PlanStoreSnapshot {
  readonly schemaVersion: number;
  readonly plans: readonly PlanState[];
  readonly processedCommands: readonly ProcessedCommandRecord[];
  readonly auditEvents: readonly AuditRecord[];
}

export interface PortablePlanStore extends PlanTransactionStore {
  readonly mode: StoreMode;
  schemaVersion(): Promise<number>;
  audit(planId: string): Promise<readonly AuditRecord[]>;
  exportSnapshot(): Promise<PlanStoreSnapshot>;
  restoreSnapshot(snapshot: PlanStoreSnapshot): Promise<void>;
}

export type PlanStoreErrorCode =
  | 'ALREADY_EXISTS'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVALID_SNAPSHOT'
  | 'INVALID_TRANSITION'
  | 'NOT_FOUND'
  | 'RESTORE_SAFE_MODE';

export class PlanStoreError extends Error {
  readonly code: PlanStoreErrorCode;

  constructor(code: PlanStoreErrorCode, message: string) {
    super(message);
    this.name = 'PlanStoreError';
    this.code = code;
  }
}

export function assertLive(mode: StoreMode): void {
  if (mode === 'restore_safe') {
    throw new PlanStoreError(
      'RESTORE_SAFE_MODE',
      'Restore-safe mode permits inspection but rejects state-changing commands.',
    );
  }
}

export function assertSnapshot(snapshot: PlanStoreSnapshot): void {
  if (snapshot.schemaVersion !== PLAN_STORE_SCHEMA_VERSION) {
    throw new PlanStoreError(
      'INVALID_SNAPSHOT',
      `Unsupported Plan store schema version ${snapshot.schemaVersion}.`,
    );
  }

  const planIds = new Set(snapshot.plans.map((plan) => plan.planId));
  if (planIds.size !== snapshot.plans.length) {
    invalidSnapshot('A snapshot cannot contain duplicate Plan identifiers.');
  }
  const commandKeys = new Set<string>();
  for (const command of snapshot.processedCommands) {
    if (!planIds.has(command.planId)) {
      invalidSnapshot('A processed command references an absent Plan.');
    }
    const key = `${command.planId}\u0000${command.commandKey}`;
    if (commandKeys.has(key)) {
      invalidSnapshot('A snapshot contains a duplicate processed command.');
    }
    commandKeys.add(key);
    if (!Number.isSafeInteger(command.processedAt)) {
      invalidSnapshot('Processed command timestamps must be safe integers.');
    }
    if (
      planIds.has(command.planId) &&
      snapshot.plans.find((plan) => plan.planId === command.planId)
        ?.processedCommandFingerprints[command.commandKey] !==
        command.commandFingerprint
    ) {
      invalidSnapshot(
        'Plan state and processed command fingerprints do not match.',
      );
    }
  }

  for (const plan of snapshot.plans) {
    assertPortablePlanState(plan);
    const auditEvents = snapshot.auditEvents
      .filter((event) => event.planId === plan.planId)
      .sort((left, right) => left.ordinal - right.ordinal);
    if (auditEvents.length !== plan.events.length) {
      invalidSnapshot('Plan state and append-only audit length do not match.');
    }
    plan.events.forEach((event, ordinal) => {
      const audit = auditEvents[ordinal];
      if (
        audit === undefined ||
        audit.ordinal !== ordinal ||
        audit.eventId !== event.id ||
        audit.type !== event.type ||
        audit.occurredAt !== event.at
      ) {
        invalidSnapshot(
          'Plan state and append-only audit events do not match.',
        );
      }
    });

    const persistedKeys = new Set(
      snapshot.processedCommands
        .filter((command) => command.planId === plan.planId)
        .map((command) => command.commandKey),
    );
    if (
      persistedKeys.size !== plan.processedCommandKeys.length ||
      plan.processedCommandKeys.some((key) => !persistedKeys.has(key)) ||
      Object.keys(plan.processedCommandFingerprints).length !==
        plan.processedCommandKeys.length
    ) {
      invalidSnapshot('Plan state and processed command keys do not match.');
    }
  }

  if (snapshot.auditEvents.some((event) => !planIds.has(event.planId))) {
    invalidSnapshot('An audit event references an absent Plan.');
  }
}

export function assertPortablePlanState(state: PlanState): void {
  const numericValues = [
    state.policyRevision,
    state.lastCommandAt,
    state.policy.checkInIntervalMs,
    state.policy.reminderLeadMs,
    state.policy.gracePeriodMs,
    state.cycle.startedAt,
    state.cycle.reminderAt,
    state.cycle.dueAt,
    state.cycle.concernAt,
    ...state.events.map((event) => event.at),
  ];
  if (numericValues.some((value) => !Number.isSafeInteger(value))) {
    invalidSnapshot('Plan timestamps and durations must be safe integers.');
  }
  if (state.policyRevision <= 0) {
    invalidSnapshot(
      'The Plan policy revision must be a positive safe integer.',
    );
  }
  if (
    new Set(state.processedCommandKeys).size !==
    state.processedCommandKeys.length
  ) {
    invalidSnapshot('Plan command identifiers must be unique.');
  }
  if (
    state.processedCommandKeys.some(
      (key) =>
        !/^cmd_[a-f0-9]{64}$/u.test(key) ||
        !isCommandFingerprint(state.processedCommandFingerprints[key]),
    )
  ) {
    invalidSnapshot(
      'Plan command identifiers must be opaque and fingerprinted.',
    );
  }
  if (
    Object.keys(state.processedCommandFingerprints).length !==
    state.processedCommandKeys.length
  ) {
    invalidSnapshot(
      'Plan command identifiers and fingerprints must have exact parity.',
    );
  }
}

export function assertPlanTransition(
  previous: PlanState,
  next: PlanState,
  commandKey: string,
  commandFingerprint: string,
): void {
  assertPortablePlanState(next);
  if (next.planId !== previous.planId || next.ownerId !== previous.ownerId) {
    invalidTransition('A transaction cannot replace Plan identity.');
  }
  if (
    next.processedCommandKeys.length !==
      previous.processedCommandKeys.length + 1 ||
    previous.processedCommandKeys.some(
      (key, index) => next.processedCommandKeys[index] !== key,
    ) ||
    next.processedCommandKeys.at(-1) !== commandKey ||
    next.processedCommandFingerprints[commandKey] !== commandFingerprint
  ) {
    invalidTransition(
      'The decided state must append exactly the persisted command identifier and fingerprint.',
    );
  }
  if (
    previous.processedCommandKeys.some(
      (key) =>
        !next.processedCommandKeys.includes(key) ||
        next.processedCommandFingerprints[key] !==
          previous.processedCommandFingerprints[key],
    )
  ) {
    invalidTransition(
      'A transaction cannot rewrite processed command history.',
    );
  }
  if (
    next.events.length < previous.events.length ||
    previous.events.some((event, index) => {
      const persisted = next.events[index];
      return (
        persisted === undefined ||
        persisted.id !== event.id ||
        persisted.type !== event.type ||
        persisted.at !== event.at
      );
    })
  ) {
    invalidTransition(
      'A transaction cannot rewrite append-only audit history.',
    );
  }
}

function isCommandFingerprint(value: string | undefined): boolean {
  return (
    value !== undefined &&
    /^(?:ADVANCE_TIME|OWNER_CHECK_IN|(?:REHEARSE_PLAN|ARM_PLAN|PAUSE_PLAN|RESUME_PLAN|DISABLE_PLAN):policy:[1-9][0-9]*)$/u.test(
      value,
    )
  );
}

function invalidSnapshot(message: string): never {
  throw new PlanStoreError('INVALID_SNAPSHOT', message);
}

function invalidTransition(message: string): never {
  throw new PlanStoreError('INVALID_TRANSITION', message);
}

export function auditRecord(
  planId: string,
  state: PlanState,
  eventIndex: number,
): AuditRecord {
  const event = state.events[eventIndex];
  if (event === undefined) {
    throw new RangeError(
      'Audit event index is outside the Plan event history.',
    );
  }
  return {
    planId,
    eventId: event.id,
    type: event.type,
    occurredAt: event.at,
    ordinal: eventIndex,
  };
}

export function cloneState(state: PlanState): PlanState {
  return structuredClone(state);
}
