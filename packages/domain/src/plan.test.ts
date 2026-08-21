import { describe, expect, it } from 'vitest';

import {
  DomainError,
  applyPlanCommand,
  createArmedPlan,
  type PlanState,
  type TimelinePolicy,
} from './plan';

const DAY = 24 * 60 * 60 * 1_000;
const START = Date.parse('2026-01-01T12:00:00.000Z');

const policy: TimelinePolicy = {
  checkInIntervalMs: 30 * DAY,
  reminderLeadMs: 5 * DAY,
  gracePeriodMs: 7 * DAY,
};

function makePlan(): PlanState {
  return createArmedPlan({
    planId: 'plan_demo',
    ownerId: 'owner_demo',
    at: START,
    policy,
  });
}

describe('plan timeline', () => {
  it('moves at exact boundaries and never before them', () => {
    const initial = makePlan();

    const beforeReminder = applyPlanCommand(initial, {
      type: 'ADVANCE_TIME',
      at: initial.cycle.reminderAt - 1,
      idempotencyKey: 'before-reminder',
    });
    expect(beforeReminder.cycle.stage).toBe('on_time');

    const reminder = applyPlanCommand(beforeReminder, {
      type: 'ADVANCE_TIME',
      at: initial.cycle.reminderAt,
      idempotencyKey: 'at-reminder',
    });
    expect(reminder.cycle.stage).toBe('reminder');

    const overdue = applyPlanCommand(reminder, {
      type: 'ADVANCE_TIME',
      at: initial.cycle.dueAt,
      idempotencyKey: 'at-due',
    });
    expect(overdue.cycle.stage).toBe('overdue');

    const concern = applyPlanCommand(overdue, {
      type: 'ADVANCE_TIME',
      at: initial.cycle.concernAt,
      idempotencyKey: 'at-concern',
    });
    expect(concern.cycle.stage).toBe('concern');
  });

  it('advances no more than one semantic stage per scheduler command', () => {
    const farFuture = START + 100 * DAY;
    const reminder = applyPlanCommand(makePlan(), {
      type: 'ADVANCE_TIME',
      at: farFuture,
      idempotencyKey: 'catch-up-1',
    });
    expect(reminder.cycle.stage).toBe('reminder');

    const overdue = applyPlanCommand(reminder, {
      type: 'ADVANCE_TIME',
      at: farFuture,
      idempotencyKey: 'catch-up-2',
    });
    expect(overdue.cycle.stage).toBe('overdue');

    const concern = applyPlanCommand(overdue, {
      type: 'ADVANCE_TIME',
      at: farFuture,
      idempotencyKey: 'catch-up-3',
    });
    expect(concern.cycle.stage).toBe('concern');

    const stillConcern = applyPlanCommand(concern, {
      type: 'ADVANCE_TIME',
      at: farFuture,
      idempotencyKey: 'catch-up-4',
    });
    expect(stillConcern.cycle.stage).toBe('concern');
    expect(stillConcern.events.map((event) => event.type)).not.toContain(
      'RELEASED',
    );
  });

  it('treats a repeated idempotency key as the same command', () => {
    const initial = makePlan();
    const command = {
      type: 'ADVANCE_TIME' as const,
      at: initial.cycle.reminderAt,
      idempotencyKey: 'scheduler-reminder',
    };

    const first = applyPlanCommand(initial, command);
    const repeated = applyPlanCommand(first, command);

    expect(repeated).toBe(first);
    expect(
      repeated.events.filter((event) => event.type === 'REMINDER_ENTERED'),
    ).toHaveLength(1);
  });

  it('requires an authenticated Owner action for Check-in', () => {
    expect(() =>
      applyPlanCommand(makePlan(), {
        type: 'OWNER_CHECK_IN',
        at: START + DAY,
        idempotencyKey: 'untrusted-link-fetch',
        authenticated: false,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<DomainError>>({
        code: 'AUTHENTICATION_REQUIRED',
      }),
    );
  });

  it('rejects commands that move the accepted timeline backward', () => {
    const initial = makePlan();
    const reminder = applyPlanCommand(initial, {
      type: 'ADVANCE_TIME',
      at: initial.cycle.reminderAt,
      idempotencyKey: 'ordered-reminder',
    });

    expect(() =>
      applyPlanCommand(reminder, {
        type: 'OWNER_CHECK_IN',
        at: initial.cycle.reminderAt - 1,
        idempotencyKey: 'stale-check-in',
        authenticated: true,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<DomainError>>({ code: 'INVALID_TIME' }),
    );
  });

  it('cancels Concern and starts a fresh interval after an authenticated Check-in', () => {
    const farFuture = START + 100 * DAY;
    const reminder = applyPlanCommand(makePlan(), {
      type: 'ADVANCE_TIME',
      at: farFuture,
      idempotencyKey: 'concern-1',
    });
    const overdue = applyPlanCommand(reminder, {
      type: 'ADVANCE_TIME',
      at: farFuture,
      idempotencyKey: 'concern-2',
    });
    const concern = applyPlanCommand(overdue, {
      type: 'ADVANCE_TIME',
      at: farFuture,
      idempotencyKey: 'concern-3',
    });

    const checkedIn = applyPlanCommand(concern, {
      type: 'OWNER_CHECK_IN',
      at: farFuture,
      idempotencyKey: 'owner-check-in',
      authenticated: true,
    });

    expect(checkedIn.cycle.stage).toBe('on_time');
    expect(checkedIn.cycle.dueAt).toBe(farFuture + policy.checkInIntervalMs);
    expect(checkedIn.events.slice(-2).map((event) => event.type)).toEqual([
      'CONCERN_CANCELLED',
      'OWNER_CHECKED_IN',
    ]);
  });

  it('rejects Check-in while a plan is paused', () => {
    const paused: PlanState = { ...makePlan(), lifecycle: 'paused' };

    expect(() =>
      applyPlanCommand(paused, {
        type: 'OWNER_CHECK_IN',
        at: START + DAY,
        idempotencyKey: 'paused-check-in',
        authenticated: true,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<DomainError>>({
        code: 'PLAN_NOT_ARMED',
      }),
    );
  });
});
