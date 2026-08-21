import {
  OPERATIONS_SCHEMA_VERSION,
  OperationsError,
  assertLive,
  assertOperationsSnapshot,
  createPendingJob,
  sameIntent,
  validateEncryptedRecord,
  validateJob,
  type ClaimedSafetyJob,
  type EncryptedMetadataRecord,
  type OperationsSnapshot,
  type OperationsStore,
  type SafetyJob,
  type SafetyJobIntent,
  type StoreMode,
  type SyntheticNoticeIntent,
} from './operations';

export class MemoryOperationsStore implements OperationsStore {
  readonly mode: StoreMode;
  private readonly metadata = new Map<string, EncryptedMetadataRecord>();
  private readonly jobs = new Map<string, SafetyJob>();

  constructor(mode: StoreMode = 'live') {
    this.mode = mode;
  }

  async writeMetadata(record: EncryptedMetadataRecord): Promise<void> {
    assertLive(this.mode);
    validateEncryptedRecord(record);
    this.metadata.set(record.recordId, structuredClone(record));
  }

  async commitMetadataAndOutbox(
    record: EncryptedMetadataRecord,
    intents: readonly SyntheticNoticeIntent[],
  ): Promise<readonly { duplicate: boolean; job: SafetyJob }[]> {
    assertLive(this.mode);
    validateEncryptedRecord(record);
    const staged: { duplicate: boolean; job: SafetyJob }[] = [];
    for (const intent of intents) {
      const existing = this.jobs.get(intent.jobId);
      if (existing !== undefined) {
        if (!sameIntent(existing, intent)) {
          throw new OperationsError(
            'IDEMPOTENCY_CONFLICT',
            'A safety job identifier cannot be reused for different intent.',
          );
        }
        staged.push({ duplicate: true, job: structuredClone(existing) });
      } else {
        staged.push({ duplicate: false, job: createPendingJob(intent) });
      }
    }
    this.metadata.set(record.recordId, structuredClone(record));
    for (const item of staged) {
      if (!item.duplicate) {
        this.jobs.set(item.job.jobId, structuredClone(item.job));
      }
    }
    return structuredClone(staged);
  }

  async readMetadata(
    recordId: string,
  ): Promise<EncryptedMetadataRecord | null> {
    const record = this.metadata.get(recordId);
    return record === undefined ? null : structuredClone(record);
  }

  async deleteMetadata(recordId: string): Promise<boolean> {
    assertLive(this.mode);
    return this.metadata.delete(recordId);
  }

  async purgeExpiredMetadata(at: number): Promise<number> {
    assertLive(this.mode);
    let purged = 0;
    for (const [recordId, record] of this.metadata) {
      if (record.retainUntil !== null && record.retainUntil <= at) {
        this.metadata.delete(recordId);
        purged += 1;
      }
    }
    return purged;
  }

  async enqueue(intent: SafetyJobIntent) {
    assertLive(this.mode);
    const existing = this.jobs.get(intent.jobId);
    if (existing !== undefined) {
      if (!sameIntent(existing, intent)) {
        throw new OperationsError(
          'IDEMPOTENCY_CONFLICT',
          'A safety job identifier cannot be reused for different intent.',
        );
      }
      return { duplicate: true, job: structuredClone(existing) };
    }
    const job = createPendingJob(intent);
    this.jobs.set(job.jobId, structuredClone(job));
    return { duplicate: false, job: structuredClone(job) };
  }

  async claimDue(input: {
    readonly workerId: string;
    readonly at: number;
    readonly leaseMs: number;
    readonly limit: number;
  }): Promise<readonly ClaimedSafetyJob[]> {
    assertLive(this.mode);
    for (const [jobId, job] of this.jobs) {
      if (
        job.status === 'leased' &&
        job.leaseExpiresAt !== null &&
        job.leaseExpiresAt <= input.at &&
        job.attempts >= job.maxAttempts
      ) {
        const dead: SafetyJob = {
          ...job,
          status: 'dead_letter',
          leaseId: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastFailureCode: 'lease_expired',
        };
        validateJob(dead);
        this.jobs.set(jobId, structuredClone(dead));
      }
    }
    const due = [...this.jobs.values()]
      .filter(
        (job) =>
          (job.status === 'pending' && job.availableAt <= input.at) ||
          (job.status === 'leased' &&
            job.leaseExpiresAt !== null &&
            job.leaseExpiresAt <= input.at),
      )
      .sort((left, right) =>
        left.availableAt === right.availableAt
          ? left.jobId.localeCompare(right.jobId)
          : left.availableAt - right.availableAt,
      )
      .slice(0, input.limit);
    return due.map((job) => {
      const leaseVersion = job.leaseVersion + 1;
      const leaseId = `lease_${job.jobId.slice(4)}_${leaseVersion}`;
      const claimed: SafetyJob = {
        ...job,
        status: 'leased',
        attempts: job.attempts + 1,
        leaseId,
        leaseOwner: input.workerId,
        leaseExpiresAt: input.at + input.leaseMs,
        leaseVersion,
      };
      validateJob(claimed);
      this.jobs.set(job.jobId, structuredClone(claimed));
      return { job: structuredClone(claimed), leaseId };
    });
  }

  async complete(input: {
    readonly jobId: string;
    readonly leaseId: string;
    readonly at: number;
  }): Promise<SafetyJob> {
    assertLive(this.mode);
    const job = this.requireLease(input.jobId, input.leaseId, input.at);
    const completed: SafetyJob = {
      ...job,
      status: 'completed',
      leaseId: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      completedAt: input.at,
    };
    validateJob(completed);
    this.jobs.set(job.jobId, structuredClone(completed));
    return structuredClone(completed);
  }

  async fail(input: {
    readonly jobId: string;
    readonly leaseId: string;
    readonly at: number;
    readonly failureCode: string;
    readonly retryAt: number;
  }): Promise<SafetyJob> {
    assertLive(this.mode);
    const job = this.requireLease(input.jobId, input.leaseId, input.at);
    if (input.retryAt <= input.at) {
      throw new OperationsError(
        'INVALID_INPUT',
        'A retry must be scheduled after the failed attempt.',
      );
    }
    const dead = job.attempts >= job.maxAttempts;
    const failed: SafetyJob = {
      ...job,
      status: dead ? 'dead_letter' : 'pending',
      availableAt: dead ? job.availableAt : input.retryAt,
      leaseId: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastFailureCode: input.failureCode,
    };
    validateJob(failed);
    this.jobs.set(job.jobId, structuredClone(failed));
    return structuredClone(failed);
  }

  async inspectJobs(): Promise<readonly SafetyJob[]> {
    return structuredClone(
      [...this.jobs.values()].sort((left, right) =>
        left.jobId.localeCompare(right.jobId),
      ),
    );
  }

  async exportSnapshot(): Promise<OperationsSnapshot> {
    return {
      schemaVersion: OPERATIONS_SCHEMA_VERSION,
      metadata: structuredClone(
        [...this.metadata.values()].sort((left, right) =>
          left.recordId.localeCompare(right.recordId),
        ),
      ),
      jobs: await this.inspectJobs(),
    };
  }

  async restoreSnapshot(snapshot: OperationsSnapshot): Promise<void> {
    if (this.mode !== 'restore_safe') {
      throw new OperationsError(
        'RESTORE_SAFE_MODE',
        'Operations restore is allowed only in restore-safe mode.',
      );
    }
    assertOperationsSnapshot(snapshot);
    if (this.metadata.size > 0 || this.jobs.size > 0) {
      throw new OperationsError(
        'ALREADY_EXISTS',
        'Operations restore requires an empty store.',
      );
    }
    for (const record of snapshot.metadata) {
      this.metadata.set(record.recordId, structuredClone(record));
    }
    for (const job of snapshot.jobs) {
      this.jobs.set(job.jobId, structuredClone(job));
    }
  }

  private requireLease(jobId: string, leaseId: string, at: number): SafetyJob {
    const job = this.jobs.get(jobId);
    if (job === undefined) {
      throw new OperationsError('NOT_FOUND', 'Safety job does not exist.');
    }
    if (job.status !== 'leased' || job.leaseId !== leaseId) {
      throw new OperationsError(
        'INVALID_LEASE',
        'Safety job settlement requires the current lease.',
      );
    }
    if (job.leaseExpiresAt === null || job.leaseExpiresAt <= at) {
      throw new OperationsError(
        'INVALID_LEASE',
        'An expired safety-job lease cannot settle.',
      );
    }
    return structuredClone(job);
  }
}
