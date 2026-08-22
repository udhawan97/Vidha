import { createHash } from 'node:crypto';

import { createDraftPlan } from '@vidha/domain';
import { Pool, type PoolClient } from 'pg';

import { PostgresOperationsStore } from './postgresOperations';
import { PostgresPlanStore } from './postgresPlan';

export const TOPOLOGY_CAPACITY_PROFILE = {
  auditRows: 100_000,
  dueJobs: 1_000,
  outboxRows: 100_000,
  parallelClaimers: 4,
} as const;

export interface TopologyCapacityReport {
  readonly auditRows: number;
  readonly cleanupVerified: boolean;
  readonly claimedDueJobs: number;
  readonly distinctClaimedDueJobs: number;
  readonly outboxRows: number;
  readonly poolExhaustionObserved: boolean;
  readonly poolRecovered: boolean;
}

interface TopologyCapacityRehearsalInput {
  readonly ownerPool: Pool;
  readonly poolConnectionString: string;
  readonly rehearsalId: string;
  readonly workerPool: Pool;
}

const CAPACITY_AT = Date.parse('2026-08-21T12:00:00.000Z');

export async function rehearseTopologyCapacity(
  input: TopologyCapacityRehearsalInput,
): Promise<TopologyCapacityReport> {
  if (!/^[a-f0-9]{16}$/u.test(input.rehearsalId)) {
    throw new Error('Capacity rehearsal IDs must be run-unique and opaque.');
  }
  const capacityPlanId = `plan_capacity_${input.rehearsalId}`;
  const capacityChannelRef = `channel_${sha256(`capacity:${input.rehearsalId}`)}`;
  let measured: Omit<TopologyCapacityReport, 'cleanupVerified'> | undefined;
  try {
    await new PostgresPlanStore(input.ownerPool).initialize(
      createDraftPlan({
        planId: capacityPlanId,
        ownerId: 'owner_capacity_fixture',
        at: CAPACITY_AT,
        policy: {
          checkInIntervalMs: 86_400_000,
          reminderLeadMs: 3_600_000,
          gracePeriodMs: 7_200_000,
        },
      }),
    );
    await seedAuditRows(input.ownerPool, capacityPlanId, input.rehearsalId);
    await seedOutboxRows(
      input.ownerPool,
      capacityChannelRef,
      input.rehearsalId,
    );

    const counts = await input.ownerPool.query<{
      audit_rows: string;
      outbox_rows: string;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM audit_events WHERE plan_id = $1)::text AS audit_rows,
         (
           SELECT COUNT(*) FROM safety_jobs
           WHERE state_json->>'channelRef' = $2
         )::text AS outbox_rows`,
      [capacityPlanId, capacityChannelRef],
    );
    const auditRows = Number(counts.rows[0]?.audit_rows);
    const outboxRows = Number(counts.rows[0]?.outbox_rows);
    if (
      auditRows !== TOPOLOGY_CAPACITY_PROFILE.auditRows ||
      outboxRows !== TOPOLOGY_CAPACITY_PROFILE.outboxRows
    ) {
      throw new Error(
        'The topology capacity fixture did not reach its profile.',
      );
    }

    const claimedIds = new Set<string>();
    const claimers = Array.from(
      { length: TOPOLOGY_CAPACITY_PROFILE.parallelClaimers },
      () => new PostgresOperationsStore(input.workerPool),
    );
    while (claimedIds.size < TOPOLOGY_CAPACITY_PROFILE.dueJobs) {
      const batches = await Promise.all(
        claimers.map((store, index) =>
          store.claimDue({
            workerId: `worker_capacity_${index}`,
            at: 0,
            leaseMs: 60_000,
            limit: 100,
          }),
        ),
      );
      const claims = batches.flat();
      if (claims.length === 0) break;
      for (const claim of claims) claimedIds.add(claim.job.jobId);
    }
    const claimed = await input.ownerPool.query<{ claimed: string }>(
      `SELECT COUNT(*)::text AS claimed FROM safety_jobs
       WHERE state_json->>'channelRef' = $1 AND status = 'leased'`,
      [capacityChannelRef],
    );
    const claimedDueJobs = Number(claimed.rows[0]?.claimed);
    if (
      claimedDueJobs !== TOPOLOGY_CAPACITY_PROFILE.dueJobs ||
      claimedIds.size !== TOPOLOGY_CAPACITY_PROFILE.dueJobs
    ) {
      throw new Error(
        'The topology capacity fixture did not claim every due job.',
      );
    }

    const pool = await rehearsePoolExhaustion(input.poolConnectionString);
    measured = {
      auditRows,
      claimedDueJobs,
      distinctClaimedDueJobs: claimedIds.size,
      outboxRows,
      poolExhaustionObserved: pool.exhaustionObserved,
      poolRecovered: pool.recovered,
    };
  } finally {
    await input.ownerPool.query(
      `DELETE FROM safety_jobs WHERE state_json->>'channelRef' = $1`,
      [capacityChannelRef],
    );
    await input.ownerPool.query('DELETE FROM plans WHERE plan_id = $1', [
      capacityPlanId,
    ]);
  }

  if (measured === undefined) {
    throw new Error('The topology capacity rehearsal did not complete.');
  }
  const remaining = await input.ownerPool.query<{
    audit_rows: string;
    outbox_rows: string;
    plan_rows: string;
  }>(
    `SELECT
       (SELECT COUNT(*) FROM audit_events WHERE plan_id = $1)::text AS audit_rows,
       (
         SELECT COUNT(*) FROM safety_jobs
         WHERE state_json->>'channelRef' = $2
       )::text AS outbox_rows,
       (SELECT COUNT(*) FROM plans WHERE plan_id = $1)::text AS plan_rows`,
    [capacityPlanId, capacityChannelRef],
  );
  const row = remaining.rows[0];
  if (
    row?.audit_rows !== '0' ||
    row.outbox_rows !== '0' ||
    row.plan_rows !== '0'
  ) {
    throw new Error('The topology capacity fixture did not clean up its rows.');
  }
  return { ...measured, cleanupVerified: true };
}

async function seedAuditRows(
  pool: Pool,
  planId: string,
  rehearsalId: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO audit_events(
       plan_id, event_id, event_type, occurred_at, ordinal
     )
     SELECT
       $1,
       'capacity_event_' || $4 || '_' || ordinal::text,
       'TOPOLOGY_CAPACITY_FIXTURE',
       $2,
       ordinal
     FROM generate_series(1, $3::integer - 1) AS ordinal`,
    [planId, CAPACITY_AT, TOPOLOGY_CAPACITY_PROFILE.auditRows, rehearsalId],
  );
}

async function seedOutboxRows(
  pool: Pool,
  channelRef: string,
  rehearsalId: string,
): Promise<void> {
  await transaction(pool, async (client) => {
    const clock = await client.query<{ now_ms: string }>(
      'SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::text AS now_ms',
    );
    const now = Number(clock.rows[0]?.now_ms);
    if (!Number.isSafeInteger(now)) {
      throw new Error(
        'PostgreSQL did not report a safe capacity-fixture clock.',
      );
    }
    await client.query(
      `WITH fixture AS (
         SELECT
           ordinal,
           $5::text || lpad(to_hex(ordinal::bigint), 48, '0') AS opaque,
           CASE
             WHEN ordinal <= $1::integer THEN $2::bigint
             ELSE $2::bigint + 86400000
           END AS available_at
         FROM generate_series(1, $3::integer) AS ordinal
       )
       INSERT INTO safety_jobs(
         job_id, kind, semantic_key, status, available_at, lease_id,
         lease_owner, lease_expires_at, claim_generation, state_json
       )
       SELECT
         'job_' || opaque,
         'synthetic_notice',
         'cmd_' || opaque,
         'pending',
         available_at,
         NULL,
         NULL,
         NULL,
         0,
         jsonb_build_object(
           'kind', 'synthetic_notice',
           'jobId', 'job_' || opaque,
           'channelRef', $4,
           'template', 'synthetic_rehearsal',
           'commandKey', 'cmd_' || opaque,
           'dueAt', available_at,
           'maxAttempts', 3,
           'status', 'pending',
           'attempts', 0,
           'availableAt', available_at,
           'leaseId', NULL,
           'leaseOwner', NULL,
           'leaseExpiresAt', NULL,
           'leaseVersion', 0,
           'completedAt', NULL,
           'lastFailureCode', NULL
         )
       FROM fixture`,
      [
        TOPOLOGY_CAPACITY_PROFILE.dueJobs,
        now,
        TOPOLOGY_CAPACITY_PROFILE.outboxRows,
        channelRef,
        rehearsalId,
      ],
    );
  });
}

async function rehearsePoolExhaustion(connectionString: string): Promise<{
  readonly exhaustionObserved: boolean;
  readonly recovered: boolean;
}> {
  const pool = new Pool({
    connectionString,
    connectionTimeoutMillis: 100,
    max: 2,
  });
  let first: PoolClient | undefined;
  let second: PoolClient | undefined;
  let exhaustionObserved = false;
  let recovered: boolean;
  try {
    first = await pool.connect();
    second = await pool.connect();
    try {
      const unexpected = await pool.connect();
      unexpected.release();
    } catch {
      exhaustionObserved = true;
    }
    first.release();
    first = undefined;
    const replacement = await pool.connect();
    try {
      const result = await replacement.query<{ ready: number }>(
        'SELECT 1::integer AS ready',
      );
      recovered = Number(result.rows[0]?.ready) === 1;
    } finally {
      replacement.release();
    }
  } finally {
    first?.release();
    second?.release();
    await pool.end();
  }
  if (!exhaustionObserved || !recovered) {
    throw new Error('The bounded PostgreSQL pool did not exhaust and recover.');
  }
  return { exhaustionObserved, recovered };
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

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
