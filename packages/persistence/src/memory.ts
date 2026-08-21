import type { PlanState } from '@vidha/domain';

import {
  PLAN_STORE_SCHEMA_VERSION,
  PlanStoreError,
  assertLive,
  assertPlanTransition,
  assertPortablePlanState,
  assertSnapshot,
  auditRecord,
  cloneState,
  type AuditRecord,
  type PlanStoreSnapshot,
  type PortablePlanStore,
  type ProcessedCommandRecord,
  type StoreMode,
} from './store';

export class MemoryPlanStore implements PortablePlanStore {
  readonly mode: StoreMode;
  private readonly plans = new Map<string, PlanState>();
  private readonly commands = new Map<string, ProcessedCommandRecord>();
  private readonly auditEvents = new Map<string, AuditRecord[]>();

  constructor(mode: StoreMode = 'live') {
    this.mode = mode;
  }

  async schemaVersion(): Promise<number> {
    return PLAN_STORE_SCHEMA_VERSION;
  }

  async initialize(state: PlanState): Promise<void> {
    assertLive(this.mode);
    assertPortablePlanState(state);
    if (this.plans.has(state.planId)) {
      throw new PlanStoreError('ALREADY_EXISTS', 'The Plan already exists.');
    }
    this.insertState(state);
  }

  async read(planId: string): Promise<PlanState | null> {
    const state = this.plans.get(planId);
    return state === undefined ? null : cloneState(state);
  }

  async transact(
    planId: string,
    commandKey: string,
    commandFingerprint: string,
    authorize: (state: PlanState) => void,
    decide: (state: PlanState) => PlanState,
  ) {
    assertLive(this.mode);
    const state = this.plans.get(planId);
    if (state === undefined) {
      throw new PlanStoreError('NOT_FOUND', 'The Plan does not exist.');
    }
    authorize(cloneState(state));
    const storageKey = commandStorageKey(planId, commandKey);
    const existing = this.commands.get(storageKey);
    if (existing !== undefined) {
      if (existing.commandFingerprint !== commandFingerprint) {
        throw new PlanStoreError(
          'IDEMPOTENCY_CONFLICT',
          'An idempotency key cannot be reused for different command semantics.',
        );
      }
      return { state: cloneState(state), duplicate: true };
    }

    const next = decide(cloneState(state));
    assertPlanTransition(state, next, commandKey, commandFingerprint);
    const processedAt = next.lastCommandAt;
    const previousEventCount = state.events.length;
    const nextAudit = [
      ...(this.auditEvents.get(planId) ?? []),
      ...next.events
        .slice(previousEventCount)
        .map((_, index) =>
          auditRecord(planId, next, previousEventCount + index),
        ),
    ];
    this.plans.set(planId, cloneState(next));
    this.commands.set(storageKey, {
      planId,
      commandKey,
      commandFingerprint,
      processedAt,
    });
    this.auditEvents.set(planId, nextAudit);
    return { state: cloneState(next), duplicate: false };
  }

  async audit(planId: string): Promise<readonly AuditRecord[]> {
    return structuredClone(this.auditEvents.get(planId) ?? []);
  }

  async exportSnapshot(): Promise<PlanStoreSnapshot> {
    return {
      schemaVersion: PLAN_STORE_SCHEMA_VERSION,
      plans: structuredClone([...this.plans.values()]),
      processedCommands: structuredClone([...this.commands.values()]),
      auditEvents: structuredClone(
        [...this.auditEvents.values()].flat().sort(compareAudit),
      ),
    };
  }

  async restoreSnapshot(snapshot: PlanStoreSnapshot): Promise<void> {
    assertSnapshot(snapshot);
    if (this.plans.size > 0) {
      throw new PlanStoreError(
        'ALREADY_EXISTS',
        'Restore requires an empty Plan store.',
      );
    }
    for (const plan of snapshot.plans) {
      this.plans.set(plan.planId, cloneState(plan));
    }
    for (const command of snapshot.processedCommands) {
      this.commands.set(
        commandStorageKey(command.planId, command.commandKey),
        structuredClone(command),
      );
    }
    for (const event of snapshot.auditEvents) {
      const current = this.auditEvents.get(event.planId) ?? [];
      this.auditEvents.set(event.planId, [...current, structuredClone(event)]);
    }
  }

  private insertState(state: PlanState): void {
    this.plans.set(state.planId, cloneState(state));
    state.processedCommandKeys.forEach((commandKey) => {
      this.commands.set(commandStorageKey(state.planId, commandKey), {
        planId: state.planId,
        commandKey,
        commandFingerprint:
          state.processedCommandFingerprints[commandKey] ?? '',
        processedAt: state.lastCommandAt,
      });
    });
    this.auditEvents.set(
      state.planId,
      state.events.map((_, index) => auditRecord(state.planId, state, index)),
    );
  }
}

function commandStorageKey(planId: string, commandKey: string): string {
  return `${planId}\u0000${commandKey}`;
}

function compareAudit(left: AuditRecord, right: AuditRecord): number {
  return (
    left.planId.localeCompare(right.planId) || left.ordinal - right.ordinal
  );
}
