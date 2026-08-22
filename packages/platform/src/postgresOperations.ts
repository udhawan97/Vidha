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
} from '@vidha/operations';
import { Pool, type PoolClient } from 'pg';

export class PostgresOperationsStore implements OperationsStore {
  constructor(
    private readonly pool: Pool,
    readonly mode: StoreMode = 'live',
  ) {}

  async writeMetadata(record: EncryptedMetadataRecord): Promise<void> {
    assertLive(this.mode);
    validateEncryptedRecord(record);
    await transaction(this.pool, async (client) => {
      await assertDatabaseMode(client, this.mode);
      await writeMetadata(client, record);
    });
  }

  async commitMetadataAndOutbox(
    record: EncryptedMetadataRecord,
    intents: readonly SyntheticNoticeIntent[],
  ): Promise<readonly { duplicate: boolean; job: SafetyJob }[]> {
    assertLive(this.mode);
    validateEncryptedRecord(record);
    return await transaction(this.pool, async (client) => {
      await assertDatabaseMode(client, this.mode);
      await writeMetadata(client, record);
      const staged: { duplicate: boolean; job: SafetyJob }[] = [];
      for (const intent of intents) staged.push(await stageJob(client, intent));
      return structuredClone(staged);
    });
  }

  async readMetadata(
    recordId: string,
  ): Promise<EncryptedMetadataRecord | null> {
    const result = await this.pool.query<{ state_json: unknown }>(
      'SELECT state_json FROM encrypted_metadata WHERE record_id = $1',
      [recordId],
    );
    const row = result.rows[0];
    return row === undefined ? null : parseMetadata(row.state_json);
  }

  async deleteMetadata(recordId: string): Promise<boolean> {
    assertLive(this.mode);
    return await transaction(this.pool, async (client) => {
      await assertDatabaseMode(client, this.mode);
      const result = await client.query(
        'DELETE FROM encrypted_metadata WHERE record_id = $1 RETURNING record_id',
        [recordId],
      );
      return result.rowCount === 1;
    });
  }

  async purgeExpiredMetadata(at: number): Promise<number> {
    assertLive(this.mode);
    return await transaction(this.pool, async (client) => {
      await assertDatabaseMode(client, this.mode);
      const result = await client.query(
        `DELETE FROM encrypted_metadata
         WHERE retain_until IS NOT NULL AND retain_until <= $1
         RETURNING record_id`,
        [at],
      );
      return result.rowCount ?? 0;
    });
  }

  async enqueue(intent: SafetyJobIntent) {
    assertLive(this.mode);
    return await transaction(this.pool, async (client) => {
      await assertDatabaseMode(client, this.mode);
      return await stageJob(client, intent);
    });
  }

  async claimDue(input: {
    readonly workerId: string;
    readonly at: number;
    readonly leaseMs: number;
    readonly limit: number;
  }): Promise<readonly ClaimedSafetyJob[]> {
    assertLive(this.mode);
    return await transaction(this.pool, async (client) => {
      await assertDatabaseMode(client, this.mode);
      const now = await databaseNow(client);
      const result = await client.query<{ state_json: unknown }>(
        `SELECT state_json FROM safety_jobs
         WHERE
           (status = 'pending' AND available_at <= $1)
           OR (status = 'leased' AND lease_expires_at <= clock_timestamp())
         ORDER BY available_at, job_id
         FOR UPDATE SKIP LOCKED
         LIMIT $2`,
        [now, input.limit],
      );
      const claimed: ClaimedSafetyJob[] = [];
      for (const row of result.rows) {
        const job = parseJob(row.state_json);
        if (job.status === 'leased' && job.attempts >= job.maxAttempts) {
          await writeJob(client, {
            ...job,
            status: 'dead_letter',
            leaseId: null,
            leaseOwner: null,
            leaseExpiresAt: null,
            lastFailureCode: 'lease_expired',
          });
          continue;
        }
        const leaseVersion = job.leaseVersion + 1;
        const leaseId = `lease_${job.jobId.slice(4)}_${leaseVersion}`;
        const next: SafetyJob = {
          ...job,
          status: 'leased',
          attempts: job.attempts + 1,
          leaseId,
          leaseOwner: input.workerId,
          leaseExpiresAt: now + input.leaseMs,
          leaseVersion,
        };
        validateJob(next);
        await writeJob(client, next);
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
    return await this.settle(input.jobId, input.leaseId, (job) => ({
      ...job,
      status: 'completed',
      leaseId: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      completedAt: input.at,
    }));
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
    return await this.settle(input.jobId, input.leaseId, (job) => {
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
    });
  }

  async inspectJobs(): Promise<readonly SafetyJob[]> {
    const result = await this.pool.query<{ state_json: unknown }>(
      'SELECT state_json FROM safety_jobs ORDER BY job_id',
    );
    return result.rows.map((row) => parseJob(row.state_json));
  }

  async exportSnapshot(): Promise<OperationsSnapshot> {
    return await transaction(this.pool, async (client) => {
      const metadata = await client.query<{ state_json: unknown }>(
        'SELECT state_json FROM encrypted_metadata ORDER BY record_id',
      );
      const jobs = await client.query<{ state_json: unknown }>(
        'SELECT state_json FROM safety_jobs ORDER BY job_id',
      );
      return {
        schemaVersion: OPERATIONS_SCHEMA_VERSION,
        metadata: metadata.rows.map((row) => parseMetadata(row.state_json)),
        jobs: jobs.rows.map((row) => parseJob(row.state_json)),
      };
    });
  }

  async restoreSnapshot(snapshot: OperationsSnapshot): Promise<void> {
    if (this.mode !== 'restore_safe') {
      throw new OperationsError(
        'RESTORE_SAFE_MODE',
        'PostgreSQL restore is allowed only in restore-safe mode.',
      );
    }
    assertOperationsSnapshot(snapshot);
    await transaction(this.pool, async (client) => {
      await assertDatabaseMode(client, this.mode);
      const count = await client.query<{ count: string }>(
        `SELECT (
          (SELECT COUNT(*) FROM encrypted_metadata) +
          (SELECT COUNT(*) FROM safety_jobs)
        )::text AS count`,
      );
      if (count.rows[0]?.count !== '0') {
        throw new OperationsError(
          'ALREADY_EXISTS',
          'PostgreSQL restore requires empty operations tables.',
        );
      }
      for (const record of snapshot.metadata) {
        await client.query(
          `INSERT INTO encrypted_metadata(record_id, state_json, retain_until, updated_at)
           VALUES ($1, $2, $3, $4)`,
          [
            record.recordId,
            JSON.stringify(record),
            record.retainUntil,
            record.updatedAt,
          ],
        );
      }
      for (const job of snapshot.jobs) await insertJob(client, job);
    });
  }

  async acceptSyntheticSink(input: {
    readonly jobId: string;
    readonly payloadDigest: string;
  }): Promise<{ readonly duplicate: boolean }> {
    assertLive(this.mode);
    if (!/^[a-f0-9]{64}$/u.test(input.payloadDigest)) {
      throw new OperationsError(
        'INVALID_INPUT',
        'Sink payload digests must be opaque.',
      );
    }
    return await transaction(this.pool, async (client) => {
      await assertDatabaseMode(client, this.mode);
      const inserted = await client.query(
        `INSERT INTO synthetic_sink_receipts(job_id, payload_digest)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING
         RETURNING job_id`,
        [input.jobId, input.payloadDigest],
      );
      if (inserted.rowCount === 1) return { duplicate: false };
      const existing = await client.query<{ payload_digest: string }>(
        'SELECT payload_digest FROM synthetic_sink_receipts WHERE job_id = $1',
        [input.jobId],
      );
      if (existing.rows[0]?.payload_digest !== input.payloadDigest) conflict();
      return { duplicate: true };
    });
  }

  private async settle(
    jobId: string,
    leaseId: string,
    update: (job: SafetyJob) => SafetyJob,
  ): Promise<SafetyJob> {
    return await transaction(this.pool, async (client) => {
      await assertDatabaseMode(client, this.mode);
      const job = await readJob(client, jobId, true);
      if (
        job === null ||
        job.status !== 'leased' ||
        job.leaseId !== leaseId ||
        job.leaseExpiresAt === null ||
        job.leaseExpiresAt <= (await databaseNow(client))
      ) {
        throw new OperationsError(
          'INVALID_LEASE',
          'PostgreSQL settlement requires the current unexpired fencing tuple.',
        );
      }
      const next = update(job);
      validateJob(next);
      await writeJob(client, next);
      return structuredClone(next);
    });
  }
}

async function transaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function assertDatabaseMode(
  client: PoolClient,
  expected: StoreMode,
): Promise<void> {
  const result = await client.query<{ mode: StoreMode }>(
    'SELECT mode FROM runtime_configuration WHERE singleton',
  );
  if (result.rows[0]?.mode !== expected) {
    throw new OperationsError(
      'INVALID_CONFIGURATION',
      'The operations adapter mode does not match PostgreSQL runtime state.',
    );
  }
}

async function writeMetadata(
  client: PoolClient,
  record: EncryptedMetadataRecord,
): Promise<void> {
  await client.query(
    `INSERT INTO encrypted_metadata(record_id, state_json, retain_until, updated_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (record_id) DO UPDATE SET
       state_json = EXCLUDED.state_json,
       retain_until = EXCLUDED.retain_until,
       updated_at = EXCLUDED.updated_at`,
    [
      record.recordId,
      JSON.stringify(record),
      record.retainUntil,
      record.updatedAt,
    ],
  );
}

async function stageJob(
  client: PoolClient,
  intent: SafetyJobIntent,
): Promise<{ duplicate: boolean; job: SafetyJob }> {
  const job = createPendingJob(intent);
  if (await insertJob(client, job, true)) {
    return { duplicate: false, job };
  }
  const existing = await readJob(client, intent.jobId, false);
  if (existing === null || !sameIntent(existing, intent)) conflict();
  return { duplicate: true, job: existing };
}

async function insertJob(
  client: PoolClient,
  job: SafetyJob,
  ignoreConflict = false,
): Promise<boolean> {
  validateJob(job);
  const result = await client.query(
    `INSERT INTO safety_jobs(
      job_id, kind, semantic_key, status, available_at, lease_id,
      lease_owner, lease_expires_at, claim_generation, state_json
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7,
      CASE WHEN $8::bigint IS NULL THEN NULL ELSE to_timestamp($8::double precision / 1000) END,
      $9, $10
    )
    ${ignoreConflict ? 'ON CONFLICT DO NOTHING' : ''}
    RETURNING job_id`,
    [
      job.jobId,
      job.kind,
      job.commandKey,
      job.status,
      job.availableAt,
      job.leaseId,
      job.leaseOwner,
      job.leaseExpiresAt,
      job.leaseVersion,
      JSON.stringify(job),
    ],
  );
  return result.rowCount === 1;
}

async function writeJob(client: PoolClient, job: SafetyJob): Promise<void> {
  validateJob(job);
  await client.query(
    `UPDATE safety_jobs SET
      status = $2,
      available_at = $3,
      lease_id = $4,
      lease_owner = $5,
      lease_expires_at = CASE
        WHEN $6::bigint IS NULL THEN NULL
        ELSE to_timestamp($6::double precision / 1000)
      END,
      claim_generation = $7,
      state_json = $8
     WHERE job_id = $1`,
    [
      job.jobId,
      job.status,
      job.availableAt,
      job.leaseId,
      job.leaseOwner,
      job.leaseExpiresAt,
      job.leaseVersion,
      JSON.stringify(job),
    ],
  );
}

async function readJob(
  client: PoolClient,
  jobId: string,
  forUpdate: boolean,
): Promise<SafetyJob | null> {
  const result = await client.query<{ state_json: unknown }>(
    `SELECT state_json FROM safety_jobs WHERE job_id = $1${
      forUpdate ? ' FOR UPDATE' : ''
    }`,
    [jobId],
  );
  const row = result.rows[0];
  return row === undefined ? null : parseJob(row.state_json);
}

async function databaseNow(client: PoolClient): Promise<number> {
  const result = await client.query<{ now_ms: string }>(
    'SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::text AS now_ms',
  );
  const now = Number(result.rows[0]?.now_ms);
  if (!Number.isSafeInteger(now)) {
    throw new OperationsError(
      'INVALID_CONFIGURATION',
      'PostgreSQL clock is invalid.',
    );
  }
  return now;
}

function parseMetadata(value: unknown): EncryptedMetadataRecord {
  const record = parseJson<EncryptedMetadataRecord>(value);
  validateEncryptedRecord(record);
  return structuredClone(record);
}

function parseJob(value: unknown): SafetyJob {
  const job = parseJson<SafetyJob>(value);
  validateJob(job);
  return structuredClone(job);
}

function parseJson<T>(value: unknown): T {
  try {
    return (typeof value === 'string' ? JSON.parse(value) : value) as T;
  } catch {
    throw new OperationsError(
      'INVALID_SNAPSHOT',
      'PostgreSQL JSON is malformed.',
    );
  }
}

function conflict(): never {
  throw new OperationsError(
    'IDEMPOTENCY_CONFLICT',
    'A durable work semantic key cannot be reused for different intent.',
  );
}
