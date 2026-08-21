import { PGlite, type Transaction } from '@electric-sql/pglite';

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

const MIGRATION = `
  CREATE TABLE IF NOT EXISTS operations_schema (
    version INTEGER PRIMARY KEY
  );
  INSERT INTO operations_schema(version) VALUES (1) ON CONFLICT DO NOTHING;
  CREATE TABLE IF NOT EXISTS encrypted_metadata (
    record_id TEXT PRIMARY KEY,
    state_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS safety_jobs (
    job_id TEXT PRIMARY KEY,
    state_json TEXT NOT NULL
  );
`;

interface PgliteOperationsStoreOptions {
  readonly database?: PGlite;
  readonly mode?: StoreMode;
}

export class PgliteOperationsStore implements OperationsStore {
  readonly mode: StoreMode;
  private readonly database: PGlite;

  constructor(database: PGlite, mode: StoreMode = 'live') {
    this.database = database;
    this.mode = mode;
  }

  async writeMetadata(record: EncryptedMetadataRecord): Promise<void> {
    assertLive(this.mode);
    validateEncryptedRecord(record);
    await this.database.query(
      `INSERT INTO encrypted_metadata(record_id, state_json) VALUES ($1, $2)
       ON CONFLICT (record_id) DO UPDATE SET state_json = EXCLUDED.state_json`,
      [record.recordId, JSON.stringify(record)],
    );
  }

  async commitMetadataAndOutbox(
    record: EncryptedMetadataRecord,
    intents: readonly SyntheticNoticeIntent[],
  ): Promise<readonly { duplicate: boolean; job: SafetyJob }[]> {
    assertLive(this.mode);
    validateEncryptedRecord(record);
    return await this.database.transaction(async (transaction) => {
      const staged: { duplicate: boolean; job: SafetyJob }[] = [];
      for (const intent of intents) {
        const existing = await readJob(transaction, intent.jobId, true);
        if (existing !== null) {
          if (!sameIntent(existing, intent)) {
            throw new OperationsError(
              'IDEMPOTENCY_CONFLICT',
              'A safety job identifier cannot be reused for different intent.',
            );
          }
          staged.push({ duplicate: true, job: existing });
        } else {
          staged.push({ duplicate: false, job: createPendingJob(intent) });
        }
      }
      await transaction.query(
        `INSERT INTO encrypted_metadata(record_id, state_json) VALUES ($1, $2)
         ON CONFLICT (record_id) DO UPDATE SET state_json = EXCLUDED.state_json`,
        [record.recordId, JSON.stringify(record)],
      );
      for (const item of staged) {
        if (!item.duplicate) {
          await transaction.query(
            'INSERT INTO safety_jobs(job_id, state_json) VALUES ($1, $2)',
            [item.job.jobId, JSON.stringify(item.job)],
          );
        }
      }
      return structuredClone(staged);
    });
  }

  async readMetadata(
    recordId: string,
  ): Promise<EncryptedMetadataRecord | null> {
    const result = await this.database.query<{ state_json: string }>(
      'SELECT state_json FROM encrypted_metadata WHERE record_id = $1',
      [recordId],
    );
    const row = result.rows[0];
    return row === undefined ? null : parseMetadata(row.state_json);
  }

  async deleteMetadata(recordId: string): Promise<boolean> {
    assertLive(this.mode);
    const result = await this.database.query(
      'DELETE FROM encrypted_metadata WHERE record_id = $1 RETURNING record_id',
      [recordId],
    );
    return result.rows.length > 0;
  }

  async purgeExpiredMetadata(at: number): Promise<number> {
    assertLive(this.mode);
    return await this.database.transaction(async (transaction) => {
      const records = await transaction.query<{
        record_id: string;
        state_json: string;
      }>('SELECT record_id, state_json FROM encrypted_metadata FOR UPDATE');
      const expired = records.rows
        .map((row) => parseMetadata(row.state_json))
        .filter(
          (record) => record.retainUntil !== null && record.retainUntil <= at,
        );
      for (const record of expired) {
        await transaction.query(
          'DELETE FROM encrypted_metadata WHERE record_id = $1',
          [record.recordId],
        );
      }
      return expired.length;
    });
  }

  async enqueue(intent: SafetyJobIntent) {
    assertLive(this.mode);
    return await this.database.transaction(async (transaction) => {
      const existing = await readJob(transaction, intent.jobId, true);
      if (existing !== null) {
        if (!sameIntent(existing, intent)) {
          throw new OperationsError(
            'IDEMPOTENCY_CONFLICT',
            'A safety job identifier cannot be reused for different intent.',
          );
        }
        return { duplicate: true, job: existing };
      }
      const job = createPendingJob(intent);
      await transaction.query(
        'INSERT INTO safety_jobs(job_id, state_json) VALUES ($1, $2)',
        [job.jobId, JSON.stringify(job)],
      );
      return { duplicate: false, job };
    });
  }

  async claimDue(input: {
    readonly workerId: string;
    readonly at: number;
    readonly leaseMs: number;
    readonly limit: number;
  }): Promise<readonly ClaimedSafetyJob[]> {
    assertLive(this.mode);
    return await this.database.transaction(async (transaction) => {
      const rows = await transaction.query<{
        job_id: string;
        state_json: string;
      }>('SELECT job_id, state_json FROM safety_jobs FOR UPDATE');
      const jobs = rows.rows.map((row) => parseJob(row.state_json));
      for (const job of jobs) {
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
          await writeJob(transaction, dead);
        }
      }
      const due = jobs
        .filter(
          (job) =>
            (job.status === 'pending' && job.availableAt <= input.at) ||
            (job.status === 'leased' &&
              job.leaseExpiresAt !== null &&
              job.leaseExpiresAt <= input.at &&
              job.attempts < job.maxAttempts),
        )
        .sort((left, right) =>
          left.availableAt === right.availableAt
            ? left.jobId.localeCompare(right.jobId)
            : left.availableAt - right.availableAt,
        )
        .slice(0, input.limit);
      const claimed: ClaimedSafetyJob[] = [];
      for (const job of due) {
        const leaseVersion = job.leaseVersion + 1;
        const leaseId = `lease_${job.jobId.slice(4)}_${leaseVersion}`;
        const next: SafetyJob = {
          ...job,
          status: 'leased',
          attempts: job.attempts + 1,
          leaseId,
          leaseOwner: input.workerId,
          leaseExpiresAt: input.at + input.leaseMs,
          leaseVersion,
        };
        validateJob(next);
        await writeJob(transaction, next);
        claimed.push({ job: structuredClone(next), leaseId });
      }
      return claimed;
    });
  }

  async complete(input: {
    readonly jobId: string;
    readonly leaseId: string;
    readonly at: number;
  }): Promise<SafetyJob> {
    assertLive(this.mode);
    return await this.updateLease(
      input.jobId,
      input.leaseId,
      input.at,
      (job) => ({
        ...job,
        status: 'completed',
        leaseId: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        completedAt: input.at,
      }),
    );
  }

  async fail(input: {
    readonly jobId: string;
    readonly leaseId: string;
    readonly at: number;
    readonly failureCode: string;
    readonly retryAt: number;
  }): Promise<SafetyJob> {
    assertLive(this.mode);
    if (input.retryAt <= input.at) {
      throw new OperationsError(
        'INVALID_INPUT',
        'A retry must be scheduled after the failed attempt.',
      );
    }
    return await this.updateLease(
      input.jobId,
      input.leaseId,
      input.at,
      (job) => {
        const dead = job.attempts >= job.maxAttempts;
        return {
          ...job,
          status: dead ? 'dead_letter' : 'pending',
          availableAt: dead ? job.availableAt : input.retryAt,
          leaseId: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastFailureCode: input.failureCode,
        };
      },
    );
  }

  async inspectJobs(): Promise<readonly SafetyJob[]> {
    const rows = await this.database.query<{ state_json: string }>(
      'SELECT state_json FROM safety_jobs ORDER BY job_id',
    );
    return rows.rows.map((row) => parseJob(row.state_json));
  }

  async exportSnapshot(): Promise<OperationsSnapshot> {
    return await this.database.transaction(async (transaction) => {
      const schema = await transaction.query<{ version: number }>(
        'SELECT MAX(version) AS version FROM operations_schema',
      );
      const metadata = await transaction.query<{ state_json: string }>(
        'SELECT state_json FROM encrypted_metadata ORDER BY record_id',
      );
      const jobs = await transaction.query<{ state_json: string }>(
        'SELECT state_json FROM safety_jobs ORDER BY job_id',
      );
      return {
        schemaVersion: Number(schema.rows[0]?.version),
        metadata: metadata.rows.map((row) => parseMetadata(row.state_json)),
        jobs: jobs.rows.map((row) => parseJob(row.state_json)),
      };
    });
  }

  async restoreSnapshot(snapshot: OperationsSnapshot): Promise<void> {
    if (this.mode !== 'restore_safe') {
      throw new OperationsError(
        'RESTORE_SAFE_MODE',
        'Operations restore is allowed only in restore-safe mode.',
      );
    }
    assertOperationsSnapshot(snapshot);
    await this.database.transaction(async (transaction) => {
      const counts = await transaction.query<{
        metadata: string;
        jobs: string;
      }>(
        `SELECT
          (SELECT COUNT(*) FROM encrypted_metadata)::text AS metadata,
          (SELECT COUNT(*) FROM safety_jobs)::text AS jobs`,
      );
      const count = counts.rows[0];
      if (count === undefined || count.metadata !== '0' || count.jobs !== '0') {
        throw new OperationsError(
          'ALREADY_EXISTS',
          'Operations restore requires an empty store.',
        );
      }
      for (const record of snapshot.metadata) {
        await transaction.query(
          'INSERT INTO encrypted_metadata(record_id, state_json) VALUES ($1, $2)',
          [record.recordId, JSON.stringify(record)],
        );
      }
      for (const job of snapshot.jobs) {
        await transaction.query(
          'INSERT INTO safety_jobs(job_id, state_json) VALUES ($1, $2)',
          [job.jobId, JSON.stringify(job)],
        );
      }
    });
  }

  async close(): Promise<void> {
    await this.database.close();
  }

  private async updateLease(
    jobId: string,
    leaseId: string,
    at: number,
    update: (job: SafetyJob) => SafetyJob,
  ): Promise<SafetyJob> {
    return await this.database.transaction(async (transaction) => {
      const job = await readJob(transaction, jobId, true);
      if (job === null) {
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
      const next = update(job);
      validateJob(next);
      await writeJob(transaction, next);
      return structuredClone(next);
    });
  }
}

export async function createPgliteOperationsStore(
  options: PgliteOperationsStoreOptions = {},
): Promise<PgliteOperationsStore> {
  const database = options.database ?? new PGlite();
  await database.exec(MIGRATION);
  const schema = await database.query<{ version: number }>(
    'SELECT MAX(version) AS version FROM operations_schema',
  );
  if (Number(schema.rows[0]?.version) !== OPERATIONS_SCHEMA_VERSION) {
    await database.close();
    throw new OperationsError(
      'INVALID_CONFIGURATION',
      'The PGlite operations schema version is unsupported.',
    );
  }
  return new PgliteOperationsStore(database, options.mode);
}

async function readJob(
  transaction: Transaction,
  jobId: string,
  forUpdate: boolean,
): Promise<SafetyJob | null> {
  const result = await transaction.query<{ state_json: string }>(
    `SELECT state_json FROM safety_jobs WHERE job_id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [jobId],
  );
  const row = result.rows[0];
  return row === undefined ? null : parseJob(row.state_json);
}

async function writeJob(
  transaction: Transaction,
  job: SafetyJob,
): Promise<void> {
  await transaction.query(
    'UPDATE safety_jobs SET state_json = $1 WHERE job_id = $2',
    [JSON.stringify(job), job.jobId],
  );
}

function parseMetadata(json: string): EncryptedMetadataRecord {
  try {
    const record = JSON.parse(json) as EncryptedMetadataRecord;
    validateEncryptedRecord(record);
    return structuredClone(record);
  } catch (error) {
    if (error instanceof OperationsError) {
      throw error;
    }
    throw new OperationsError(
      'INVALID_SNAPSHOT',
      'Persisted encrypted metadata is malformed.',
    );
  }
}

function parseJob(json: string): SafetyJob {
  try {
    const job = JSON.parse(json) as SafetyJob;
    validateJob(job);
    return structuredClone(job);
  } catch (error) {
    if (error instanceof OperationsError) {
      throw error;
    }
    throw new OperationsError(
      'INVALID_SNAPSHOT',
      'Persisted safety-job state is malformed.',
    );
  }
}
