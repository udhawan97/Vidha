import { createDraftPlan } from '@vidha/domain';
import {
  createPendingJob,
  type ClaimedSafetyJob,
  type SafetyJob,
  type SafetyJobIntent,
} from '@vidha/operations';
import { describe, expect, it, vi } from 'vitest';

import {
  WORKER_CLAIM_LIMIT,
  runWorkerClaim,
  serializeWorkerTelemetry,
} from './worker';

const START = Date.parse('2026-08-25T12:00:00.000Z');
const PLAN_ID = 'plan_worker_fixture';

describe('runtime safety-job dispatcher', () => {
  it('claims only the job it can execute before the lease expires', () => {
    expect(WORKER_CLAIM_LIMIT).toBe(1);
  });

  it('gives scheduled work only its opaque claim and fencing identifiers', async () => {
    const claim = claimed({
      kind: 'advance_plan_stage',
      jobId: `job_${'1'.repeat(64)}`,
      planRef: PLAN_ID,
      commandKey: `cmd_${'2'.repeat(64)}`,
      dueAt: START,
      maxAttempts: 3,
    });
    const advanceScheduled = vi.fn(async () => ({
      job: completed(claim.job),
      outcome: 'advanced' as const,
      state: plan(),
    }));
    const report = vi.fn();

    await runWorkerClaim({
      claim,
      clock: { now: () => START + 1 },
      operations: operationsFixture(),
      report,
      retryDelayMs: 60_000,
      scheduledPlans: { advanceScheduled },
    });

    expect(advanceScheduled).toHaveBeenCalledWith({
      jobId: claim.job.jobId,
      leaseId: claim.leaseId,
    });
    expect(report).not.toHaveBeenCalled();
  });

  it('replays a synthetic sink before fenced completion', async () => {
    const claim = claimed({
      kind: 'synthetic_notice',
      jobId: `job_${'3'.repeat(64)}`,
      channelRef: `channel_${'4'.repeat(64)}`,
      template: 'synthetic_rehearsal',
      commandKey: `cmd_${'5'.repeat(64)}`,
      dueAt: START,
      maxAttempts: 3,
    });
    const accepted: string[] = [];
    const completedJobs: string[] = [];
    const operations = operationsFixture({
      async acceptSyntheticSink(input) {
        accepted.push(input.payloadDigest);
        return { duplicate: true };
      },
      async complete(input) {
        completedJobs.push(input.jobId);
        return completed(claim.job);
      },
    });

    await runWorkerClaim({
      claim,
      clock: { now: () => START + 1 },
      operations,
      report: vi.fn(),
      retryDelayMs: 60_000,
      scheduledPlans: {
        async advanceScheduled() {
          throw new Error('Synthetic notices cannot advance a Plan.');
        },
      },
    });

    expect(accepted).toEqual([expect.stringMatching(/^[a-f0-9]{64}$/u)]);
    expect(completedJobs).toEqual([claim.job.jobId]);
  });

  it('dead-letters exhausted work with content-free telemetry', async () => {
    const privateMarker = 'private-envelope-title';
    const claim = claimed({
      kind: 'advance_plan_stage',
      jobId: `job_${'6'.repeat(64)}`,
      planRef: PLAN_ID,
      commandKey: `cmd_${'7'.repeat(64)}`,
      dueAt: START,
      maxAttempts: 1,
    });
    const reports: string[] = [];
    const fail = vi.fn(async () => ({
      ...claim.job,
      status: 'dead_letter' as const,
      leaseId: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastFailureCode: 'executor_exception',
    }));

    await runWorkerClaim({
      claim,
      clock: { now: () => START + 1 },
      operations: operationsFixture({ fail }),
      report: (event) => reports.push(serializeWorkerTelemetry(event)),
      retryDelayMs: 60_000,
      scheduledPlans: {
        async advanceScheduled() {
          throw new Error(`${privateMarker}:${claim.job.jobId}:${PLAN_ID}`);
        },
      },
    });

    expect(fail).toHaveBeenCalledWith({
      at: START + 1,
      failureCode: 'executor_exception',
      jobId: claim.job.jobId,
      leaseId: claim.leaseId,
      retryAt: START + 60_001,
    });
    expect(reports).toEqual([
      '{"event":"worker_job_dead_lettered","failureCode":"executor_exception","kind":"advance_plan_stage"}',
    ]);
    expect(reports[0]).not.toContain(privateMarker);
    expect(reports[0]).not.toContain(claim.job.jobId);
    expect(reports[0]).not.toContain(PLAN_ID);
  });
});

function claimed(intent: SafetyJobIntent): ClaimedSafetyJob {
  const pending = createPendingJob(intent);
  const leaseId = `lease_${intent.jobId.slice(4)}_1`;
  return {
    leaseId,
    job: {
      ...pending,
      status: 'leased',
      attempts: 1,
      leaseId,
      leaseOwner: 'worker_fixture_runtime',
      leaseExpiresAt: START + 120_000,
      leaseVersion: 1,
    },
  };
}

function completed(job: SafetyJob): SafetyJob {
  return {
    ...job,
    status: 'completed',
    leaseId: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    completedAt: START + 1,
  };
}

function plan() {
  return createDraftPlan({
    planId: PLAN_ID,
    ownerId: 'owner_worker_fixture',
    at: START,
    policy: {
      checkInIntervalMs: 86_400_000,
      reminderLeadMs: 3_600_000,
      gracePeriodMs: 7_200_000,
    },
  });
}

function operationsFixture(
  overrides: Partial<{
    acceptSyntheticSink(
      input: Parameters<PostgresOperationsFixture['acceptSyntheticSink']>[0],
    ): Promise<{ readonly duplicate: boolean }>;
    complete(
      input: Parameters<PostgresOperationsFixture['complete']>[0],
    ): Promise<SafetyJob>;
    fail(
      input: Parameters<PostgresOperationsFixture['fail']>[0],
    ): Promise<SafetyJob>;
  }> = {},
): PostgresOperationsFixture {
  return {
    async acceptSyntheticSink() {
      return { duplicate: false };
    },
    async complete() {
      throw new Error('Unexpected completion.');
    },
    async fail() {
      throw new Error('Unexpected failure settlement.');
    },
    ...overrides,
  };
}

type PostgresOperationsFixture = Parameters<
  typeof runWorkerClaim
>[0]['operations'];
