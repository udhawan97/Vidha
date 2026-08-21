import {
  applyPlanCommand,
  createDraftPlan,
  type PlanState,
} from '@vidha/domain';
import { afterEach, describe, expect, it } from 'vitest';

import { MemoryPlanStore } from './memory';
import { createPglitePlanStore } from './pglite';
import { SqlitePlanStore } from './sqlite';
import type { PortablePlanStore, StoreMode } from './store';

const DAY = 24 * 60 * 60 * 1_000;
const START = Date.parse('2026-01-01T12:00:00.000Z');

interface ClosableStore extends PortablePlanStore {
  close?(): Promise<void> | void;
}

type StoreFactory = (mode?: StoreMode) => Promise<ClosableStore>;

function makePlan(): PlanState {
  const draft = createDraftPlan({
    planId: 'plan_demo',
    ownerId: 'owner_demo',
    at: START,
    policy: {
      checkInIntervalMs: 30 * DAY,
      reminderLeadMs: 5 * DAY,
      gracePeriodMs: 7 * DAY,
    },
  });
  const rehearsed = applyPlanCommand(draft, {
    type: 'REHEARSE_PLAN',
    at: START,
    authenticated: true,
    expectedPolicyRevision: 1,
    idempotencyKey: 'rehearse',
  });
  return applyPlanCommand(rehearsed, {
    type: 'ARM_PLAN',
    at: START,
    authenticated: true,
    recentlyAuthenticated: true,
    expectedPolicyRevision: 1,
    idempotencyKey: 'arm',
  });
}

function reminderDecision(state: PlanState, commandKey: string): PlanState {
  return applyPlanCommand(state, {
    type: 'ADVANCE_TIME',
    at: state.cycle.reminderAt,
    idempotencyKey: commandKey,
  });
}

function storeContract(name: string, factory: StoreFactory): void {
  describe(`${name} Plan store contract`, () => {
    const openStores: ClosableStore[] = [];

    async function open(mode?: StoreMode): Promise<ClosableStore> {
      const store = await factory(mode);
      openStores.push(store);
      return store;
    }

    afterEach(async () => {
      await Promise.all(openStores.splice(0).map((store) => store.close?.()));
    });

    it('applies migration version 1 and round-trips synthetic state', async () => {
      const store = await open();
      const plan = makePlan();
      await store.initialize(plan);

      expect(await store.schemaVersion()).toBe(1);
      expect(await store.read(plan.planId)).toEqual(plan);
      expect(await store.audit(plan.planId)).toHaveLength(plan.events.length);
    });

    it('commits state, command identity, and append-only audit together', async () => {
      const store = await open();
      const plan = makePlan();
      await store.initialize(plan);

      const result = await store.transact(
        plan.planId,
        'scheduler-reminder',
        () => undefined,
        (state) => reminderDecision(state, 'scheduler-reminder'),
      );
      const audit = await store.audit(plan.planId);

      expect(result.duplicate).toBe(false);
      expect(result.state.cycle.stage).toBe('reminder');
      expect(audit.map((event) => event.type)).toEqual([
        'PLAN_DRAFTED',
        'PLAN_REHEARSED',
        'PLAN_ARMED',
        'REMINDER_ENTERED',
      ]);
      expect(audit.map((event) => event.ordinal)).toEqual([0, 1, 2, 3]);
    });

    it('keeps content, contacts, filenames, and tokens out of audit exports', async () => {
      const store = await open();
      const plan = makePlan();
      await store.initialize(plan);
      const sensitiveParts = [
        'private document content',
        'guardian@example.com',
        'taxes.pdf',
        'bearer-secret-token',
      ];
      const commandKey = sensitiveParts.join('|');

      await store.transact(
        plan.planId,
        commandKey,
        () => undefined,
        (state) => reminderDecision(state, commandKey),
      );

      const auditExport = JSON.stringify(await store.audit(plan.planId));
      for (const sensitivePart of sensitiveParts) {
        expect(auditExport).not.toContain(sensitivePart);
      }
    });

    it('returns the committed result for a duplicate semantic command', async () => {
      const store = await open();
      const plan = makePlan();
      await store.initialize(plan);
      const decide = (state: PlanState) =>
        reminderDecision(state, 'scheduler-reminder');

      const first = await store.transact(
        plan.planId,
        'scheduler-reminder',
        () => undefined,
        decide,
      );
      const replay = await store.transact(
        plan.planId,
        'scheduler-reminder',
        () => undefined,
        () => {
          throw new Error('A duplicate must not re-run the decision.');
        },
      );

      expect(first.duplicate).toBe(false);
      expect(replay.duplicate).toBe(true);
      expect(replay.state).toEqual(first.state);
      expect(await store.audit(plan.planId)).toHaveLength(4);
    });

    it('runs authorization inside the transaction before duplicate detection', async () => {
      const store = await open();
      const plan = makePlan();
      await store.initialize(plan);
      await store.transact(
        plan.planId,
        'authorized-first',
        () => undefined,
        (state) => reminderDecision(state, 'authorized-first'),
      );

      await expect(
        store.transact(
          plan.planId,
          'authorized-first',
          () => {
            throw new Error('authorization denied');
          },
          () => {
            throw new Error('duplicate decision must not run');
          },
        ),
      ).rejects.toThrow('authorization denied');
      expect(await store.audit(plan.planId)).toHaveLength(4);
    });

    it('serializes concurrent writers without duplicating the transition', async () => {
      const store = await open();
      const plan = makePlan();
      await store.initialize(plan);

      await Promise.all([
        store.transact(
          plan.planId,
          'concurrent-a',
          () => undefined,
          (state) => reminderDecision(state, 'concurrent-a'),
        ),
        store.transact(
          plan.planId,
          'concurrent-b',
          () => undefined,
          (state) => reminderDecision(state, 'concurrent-b'),
        ),
      ]);

      const restored = await store.read(plan.planId);
      expect(restored?.cycle.stage).toBe('reminder');
      expect(
        restored?.events.filter((event) => event.type === 'REMINDER_ENTERED'),
      ).toHaveLength(1);
      expect(restored?.processedCommandKeys).toEqual(
        expect.arrayContaining(['concurrent-a', 'concurrent-b']),
      );
    });

    it('serializes concurrent writers that use the same semantic key', async () => {
      const store = await open();
      const plan = makePlan();
      await store.initialize(plan);
      const decide = (state: PlanState) =>
        reminderDecision(state, 'concurrent-same-key');

      const results = await Promise.all([
        store.transact(
          plan.planId,
          'concurrent-same-key',
          () => undefined,
          decide,
        ),
        store.transact(
          plan.planId,
          'concurrent-same-key',
          () => undefined,
          decide,
        ),
      ]);

      expect(results.filter((result) => result.duplicate)).toHaveLength(1);
      expect(
        results[0].state.events.filter(
          (event) => event.type === 'REMINDER_ENTERED',
        ),
      ).toHaveLength(1);
      expect(await store.audit(plan.planId)).toHaveLength(4);
    });

    it('rolls back a failed decision so the command can be retried', async () => {
      const store = await open();
      const plan = makePlan();
      await store.initialize(plan);

      await expect(
        store.transact(
          plan.planId,
          'crash-retry',
          () => undefined,
          () => {
            throw new Error('synthetic crash');
          },
        ),
      ).rejects.toThrow('synthetic crash');
      const retried = await store.transact(
        plan.planId,
        'crash-retry',
        () => undefined,
        (state) => reminderDecision(state, 'crash-retry'),
      );

      expect(retried.duplicate).toBe(false);
      expect(retried.state.cycle.stage).toBe('reminder');
      expect(await store.audit(plan.planId)).toHaveLength(4);
    });

    it('restores a portable snapshot into read-only restore-safe mode', async () => {
      const live = await open();
      const plan = makePlan();
      await live.initialize(plan);
      await live.transact(
        plan.planId,
        'scheduler-reminder',
        () => undefined,
        (state) => reminderDecision(state, 'scheduler-reminder'),
      );
      const snapshot = await live.exportSnapshot();

      const restored = await open('restore_safe');
      await restored.restoreSnapshot(snapshot);
      expect(await restored.read(plan.planId)).toEqual(
        await live.read(plan.planId),
      );
      expect(await restored.audit(plan.planId)).toEqual(
        await live.audit(plan.planId),
      );
      await expect(
        restored.transact(
          plan.planId,
          'must-not-run',
          () => undefined,
          (state) => state,
        ),
      ).rejects.toMatchObject({ code: 'RESTORE_SAFE_MODE' });
    });

    it('rejects a restore whose audit no longer matches Plan state', async () => {
      const live = await open();
      const plan = makePlan();
      await live.initialize(plan);
      const snapshot = await live.exportSnapshot();
      const restored = await open('restore_safe');

      await expect(
        restored.restoreSnapshot({
          ...snapshot,
          auditEvents: snapshot.auditEvents.slice(1),
        }),
      ).rejects.toMatchObject({ code: 'INVALID_SNAPSHOT' });
    });
  });
}

storeContract('in-memory', async (mode) => new MemoryPlanStore(mode));
storeContract(
  'SQLite',
  async (mode) => new SqlitePlanStore(mode === undefined ? {} : { mode }),
);
storeContract('PGlite', async (mode) =>
  createPglitePlanStore(mode === undefined ? {} : { mode }),
);
