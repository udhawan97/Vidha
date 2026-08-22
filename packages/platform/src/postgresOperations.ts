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

export const CLAIM_REHEARSAL_BOUNDARIES = [
  'after_selection',
  'after_first_write',
  'before_commit',
  'after_commit',
] as const;

export type ClaimRehearsalBoundary =
  (typeof CLAIM_REHEARSAL_BOUNDARIES)[number];

export interface ClaimRehearsalReport {
  readonly committedLeaseId: string;
  readonly finalClaimGeneration: number;
  readonly finalLeaseId: string;
  readonly interruptedBoundaries: readonly ClaimRehearsalBoundary[];
  readonly jobId: string;
  readonly postCommitReplayVerified: boolean;
  readonly rollbackVerified: boolean;
}

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
    return await claimDueTransaction(this.pool, this.mode, input);
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

export async function rehearseClaimInterruptions(input: {
  readonly controlPool: Pool;
  readonly jobId: string;
  readonly leaseMs: number;
  readonly workerId: string;
  readonly workerPool: Pool;
}): Promise<ClaimRehearsalReport> {
  const identity = await input.workerPool.query<{
    application_name: string;
    database_name: string;
    database_user: string;
  }>(
    `SELECT
       current_setting('application_name') AS application_name,
       current_database() AS database_name,
       current_user AS database_user`,
  );
  const expected = identity.rows[0];
  if (
    expected === undefined ||
    expected.application_name !== 'vidha-topology-worker'
  ) {
    throw new Error('Claim rehearsal requires its isolated application ID.');
  }
  const interruptedBoundaries: ClaimRehearsalBoundary[] = [];
  let committedLeaseId: string | undefined;
  for (const target of CLAIM_REHEARSAL_BOUNDARIES) {
    let terminated = false;
    try {
      await claimDueTransaction(
        input.workerPool,
        'live',
        {
          workerId: input.workerId,
          at: 0,
          leaseMs: input.leaseMs,
          limit: 1,
        },
        async (boundary, backendPid) => {
          if (boundary !== target) return;
          const result = await input.controlPool.query<{ terminated: boolean }>(
            `SELECT pg_terminate_backend(pid) AS terminated
             FROM pg_stat_activity
             WHERE pid = $1 AND datname = $2 AND usename = $3
               AND application_name = $4`,
            [
              backendPid,
              expected.database_name,
              expected.database_user,
              expected.application_name,
            ],
          );
          if (result.rows[0]?.terminated !== true) {
            throw new Error(
              `PostgreSQL did not terminate the worker at ${target}.`,
            );
          }
          terminated = true;
          throw new Error(`Injected claim interruption at ${target}.`);
        },
      );
    } catch {
      if (!terminated) {
        throw new Error(
          `Claim interruption did not reach the ${target} boundary.`,
        );
      }
    }
    if (!terminated) {
      throw new Error(
        `Claim interruption unexpectedly committed at ${target}.`,
      );
    }
    const state = await input.controlPool.query<{
      claim_generation: number;
      lease_id: string | null;
      status: SafetyJob['status'];
    }>(
      `SELECT status, claim_generation, lease_id
       FROM safety_jobs WHERE job_id = $1`,
      [input.jobId],
    );
    const row = state.rows[0];
    if (target === 'after_commit') {
      if (
        row?.status !== 'leased' ||
        Number(row.claim_generation) !== 1 ||
        row.lease_id === null
      ) {
        throw new Error('Committed claim disappeared after a lost ack.');
      }
      committedLeaseId = row.lease_id;
    } else if (
      row?.status !== 'pending' ||
      Number(row.claim_generation) !== 0 ||
      row.lease_id !== null
    ) {
      throw new Error(`Claim interruption did not roll back at ${target}.`);
    }
    interruptedBoundaries.push(target);
  }

  await delay(input.leaseMs + 25);
  const final = await claimDueTransaction(input.workerPool, 'live', {
    workerId: input.workerId,
    at: 0,
    leaseMs: input.leaseMs,
    limit: 1,
  });
  const claim = final[0];
  if (
    claim === undefined ||
    claim.job.jobId !== input.jobId ||
    claim.job.leaseVersion !== 2 ||
    committedLeaseId === undefined
  ) {
    throw new Error('Claim restart did not fence a committed lost ack.');
  }
  return {
    committedLeaseId,
    finalClaimGeneration: claim.job.leaseVersion,
    finalLeaseId: claim.leaseId,
    interruptedBoundaries,
    jobId: claim.job.jobId,
    postCommitReplayVerified: true,
    rollbackVerified: true,
  };
}

type ClaimObserver = (
  boundary: ClaimRehearsalBoundary,
  backendPid: number,
) => Promise<void>;

async function claimDueTransaction(
  pool: Pool,
  mode: StoreMode,
  input: {
    readonly workerId: string;
    readonly at: number;
    readonly leaseMs: number;
    readonly limit: number;
  },
  observe: ClaimObserver = async () => undefined,
): Promise<readonly ClaimedSafetyJob[]> {
  let backendPid: number | undefined;
  return await transaction(
    pool,
    async (client) => {
      await assertDatabaseMode(client, mode);
      const backend = await client.query<{ backend_pid: number }>(
        'SELECT pg_backend_pid() AS backend_pid',
      );
      backendPid = Number(backend.rows[0]?.backend_pid);
      if (!Number.isSafeInteger(backendPid)) {
        throw new Error('PostgreSQL did not report a worker backend PID.');
      }
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
      await observe('after_selection', backendPid);
      const claimed: ClaimedSafetyJob[] = [];
      let wrote = false;
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
          if (!wrote) {
            wrote = true;
            await observe('after_first_write', backendPid);
          }
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
        if (!wrote) {
          wrote = true;
          await observe('after_first_write', backendPid);
        }
        claimed.push({ job: structuredClone(next), leaseId });
      }
      await observe('before_commit', backendPid);
      return claimed;
    },
    async () => {
      if (backendPid === undefined) {
        throw new Error('The claim transaction lost its backend identity.');
      }
      await observe('after_commit', backendPid);
    },
  );
}

async function transaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
  afterCommit: (client: PoolClient) => Promise<void> = async () => undefined,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    await afterCommit(client);
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // A terminated worker backend already caused PostgreSQL to roll back.
    }
    throw error;
  } finally {
    client.release();
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
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
