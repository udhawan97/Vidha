import { describe, expect, it } from 'vitest';
import { applyPlanCommand, createDraftPlan } from '@vidha/domain';

import { PLATFORM_SCHEMA_VERSION, platformMigrations } from './migrations';
import { createSyntheticConcernOutboxPlanner } from './postgresPlan';

const START = Date.parse('2026-08-21T12:00:00.000Z');

function commandKey(character: string): string {
  return `cmd_${character.repeat(64)}`;
}

describe('Phase 3B PostgreSQL schema', () => {
  it('is versioned and positively allowlists Concern-bounded work', () => {
    expect(platformMigrations.map((migration) => migration.version)).toEqual([
      ...Array.from(
        { length: PLATFORM_SCHEMA_VERSION },
        (_, index) => index + 1,
      ),
    ]);
    const sql = platformMigrations.map((migration) => migration.sql).join('\n');
    expect(sql).toContain("kind IN ('advance_plan_stage', 'synthetic_notice')");
    expect(sql).toContain('claim_generation');
    expect(sql).toContain('CREATE TABLE plans');
    expect(sql).toContain('CREATE TABLE audit_events');
    expect(sql).toContain('CREATE TABLE metadata_key_rotations');
    expect(sql).toContain('CREATE TABLE restore_promotions');
    expect(sql).not.toMatch(
      /guardian_attestation|recipient_delivery|veto_window|delivery_hold|automatic_fallback|release_task/iu,
    );
  });

  it('plans one-stage durable work and content-free synthetic observations', () => {
    const planner = createSyntheticConcernOutboxPlanner({
      channelRef: `channel_${'a'.repeat(64)}`,
      maxAttempts: 3,
    });
    const draft = createDraftPlan({
      planId: 'plan_demo',
      ownerId: 'owner_demo',
      at: START,
      policy: {
        checkInIntervalMs: 86_400_000,
        reminderLeadMs: 3_600_000,
        gracePeriodMs: 7_200_000,
      },
    });
    const rehearsed = applyPlanCommand(draft, {
      type: 'REHEARSE_PLAN',
      at: START,
      authenticated: true,
      expectedPolicyRevision: 1,
      idempotencyKey: commandKey('1'),
    });
    const armed = applyPlanCommand(rehearsed, {
      type: 'ARM_PLAN',
      at: START,
      authenticated: true,
      recentlyAuthenticated: true,
      expectedPolicyRevision: 1,
      idempotencyKey: commandKey('2'),
    });
    expect(planner(rehearsed, armed)).toEqual([
      expect.objectContaining({
        kind: 'advance_plan_stage',
        planRef: 'plan_demo',
        dueAt: armed.cycle.reminderAt,
      }),
    ]);

    const reminder = applyPlanCommand(armed, {
      type: 'ADVANCE_TIME',
      at: armed.cycle.reminderAt,
      idempotencyKey: commandKey('3'),
    });
    expect(planner(armed, reminder)).toEqual([
      expect.objectContaining({
        kind: 'advance_plan_stage',
        dueAt: reminder.cycle.dueAt,
      }),
      expect.objectContaining({
        kind: 'synthetic_notice',
        template: 'synthetic_rehearsal',
        dueAt: armed.cycle.reminderAt,
      }),
    ]);
  });
});
