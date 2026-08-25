import { createHash } from 'node:crypto';

import type { ClaimedSafetyJob, SafetyJob } from '@vidha/operations';
import type {
  PostgresOperationsStore,
  PostgresPlanStore,
} from '@vidha/platform';

export const WORKER_CLAIM_LIMIT = 1;

export type WorkerTelemetryEvent =
  | {
      readonly event: 'worker_job_dead_lettered';
      readonly failureCode: WorkerFailureCode;
      readonly kind: SafetyJob['kind'];
    }
  | {
      readonly event: 'worker_job_retry_scheduled';
      readonly failureCode: WorkerFailureCode;
      readonly kind: SafetyJob['kind'];
    }
  | {
      readonly event: 'worker_job_settlement_failed';
      readonly failureCode: WorkerFailureCode;
      readonly kind: SafetyJob['kind'];
    };

export type WorkerFailureCode =
  | 'configuration_error'
  | 'database_unavailable'
  | 'executor_exception'
  | 'invalid_lease'
  | 'plan_unavailable'
  | 'restore_safe_mode'
  | 'stale_schedule';

interface RunWorkerClaimInput {
  readonly claim: ClaimedSafetyJob;
  readonly clock: { now(): number };
  readonly operations: Pick<
    PostgresOperationsStore,
    'acceptSyntheticSink' | 'complete' | 'fail'
  >;
  readonly report: (event: WorkerTelemetryEvent) => void;
  readonly retryDelayMs: number;
  readonly scheduledPlans: Pick<PostgresPlanStore, 'advanceScheduled'>;
}

export async function runWorkerClaim(
  input: RunWorkerClaimInput,
): Promise<void> {
  try {
    if (input.claim.job.kind === 'synthetic_notice') {
      const payloadDigest = sha256(
        JSON.stringify({
          jobId: input.claim.job.jobId,
          kind: input.claim.job.kind,
          template: input.claim.job.template,
        }),
      );
      await input.operations.acceptSyntheticSink({
        jobId: input.claim.job.jobId,
        payloadDigest,
      });
      await input.operations.complete({
        jobId: input.claim.job.jobId,
        leaseId: input.claim.leaseId,
        at: input.clock.now(),
      });
      return;
    }

    const result = await input.scheduledPlans.advanceScheduled({
      jobId: input.claim.job.jobId,
      leaseId: input.claim.leaseId,
    });
    if (result.job.status === 'dead_letter') {
      input.report({
        event: 'worker_job_dead_lettered',
        failureCode: 'stale_schedule',
        kind: input.claim.job.kind,
      });
    }
  } catch (error) {
    const failureCode = workerFailureCode(error);
    const at = input.clock.now();
    try {
      const settled = await input.operations.fail({
        jobId: input.claim.job.jobId,
        leaseId: input.claim.leaseId,
        at,
        failureCode,
        retryAt: safeAdd(at, input.retryDelayMs),
      });
      input.report({
        event:
          settled.status === 'dead_letter'
            ? 'worker_job_dead_lettered'
            : 'worker_job_retry_scheduled',
        failureCode,
        kind: input.claim.job.kind,
      });
    } catch {
      input.report({
        event: 'worker_job_settlement_failed',
        failureCode,
        kind: input.claim.job.kind,
      });
    }
  }
}

export function serializeWorkerTelemetry(event: WorkerTelemetryEvent): string {
  return JSON.stringify({
    event: event.event,
    failureCode: event.failureCode,
    kind: event.kind,
  });
}

function workerFailureCode(error: unknown): WorkerFailureCode {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { readonly code?: unknown }).code
      : undefined;
  switch (code) {
    case 'INVALID_CONFIGURATION':
      return 'configuration_error';
    case 'INVALID_LEASE':
      return 'invalid_lease';
    case 'NOT_FOUND':
      return 'plan_unavailable';
    case 'RESTORE_SAFE_MODE':
      return 'restore_safe_mode';
    case '08003':
    case '08006':
    case '57P01':
    case 'ECONNRESET':
      return 'database_unavailable';
    default:
      return 'executor_exception';
  }
}

function safeAdd(at: number, duration: number): number {
  if (!Number.isSafeInteger(duration) || duration <= 0) {
    throw new RangeError('The worker retry delay must be positive.');
  }
  const result = at + duration;
  if (!Number.isSafeInteger(result)) {
    throw new RangeError('The worker retry time exceeds the safe range.');
  }
  return result;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
