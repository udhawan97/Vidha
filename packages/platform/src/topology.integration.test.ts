import { randomBytes } from 'node:crypto';

import { OperationsError, type SafetyJobIntent } from '@vidha/operations';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import {
  MIGRATION_REHEARSAL_BOUNDARIES,
  createPostgresPlatform,
  rehearseMigrationInterruptions,
  type MigrationRehearsalReport,
  type PostgresPlatform,
} from './postgres';
import {
  CLAIM_REHEARSAL_BOUNDARIES,
  PostgresOperationsStore,
  rehearseClaimInterruptions,
} from './postgresOperations';
import {
  TOPOLOGY_CAPACITY_PROFILE,
  rehearseTopologyCapacity,
} from './topologyRehearsal';

const connectionString = process.env.VIDHA_POSTGRES_URL;
const rehearsalRequired = process.env.VIDHA_REQUIRE_POSTGRES === '1';
if (rehearsalRequired) {
  if (connectionString === undefined) {
    throw new Error('VIDHA_POSTGRES_URL is required for the PostgreSQL gate.');
  }
  if (
    process.env.VIDHA_TOPOLOGY_REHEARSAL_AUTHORITY !==
    'disposable-loopback-cluster'
  ) {
    throw new Error(
      'The destructive topology gate requires explicit disposable-cluster authority.',
    );
  }
  const target = new URL(connectionString);
  if (
    (target.hostname !== '127.0.0.1' && target.hostname !== 'localhost') ||
    target.pathname !== '/vidha_fixture'
  ) {
    throw new Error(
      'The topology gate accepts only the loopback vidha_fixture database.',
    );
  }
}

const suite = connectionString === undefined ? describe.skip : describe;
const REHEARSAL_ID = randomBytes(8).toString('hex');
const DATABASE_NAME = `vidha_topology_${REHEARSAL_ID}`;
const DATABASE_SENTINEL = `vidha-disposable-topology:${REHEARSAL_ID}`;
const JOB_ID = `job_${'d'.repeat(64)}`;
const COMMAND_KEY = `cmd_${'e'.repeat(64)}`;

suite('disposable PostgreSQL topology rehearsal', () => {
  let adminPool: Pool;
  let ownerPlatform: PostgresPlatform;
  let apiPlatform: PostgresPlatform;
  let workerPool: Pool;
  let ownerConnectionString: string;
  let workerConnectionString: string;
  let migrationReport: MigrationRehearsalReport;
  let databaseCreated = false;

  beforeAll(async () => {
    adminPool = new Pool({
      application_name: 'vidha-topology-control',
      connectionString: connectionString ?? '',
    });
    const authority = await adminPool.query<{
      database_name: string;
      database_user: string;
      is_superuser: string;
    }>(
      `SELECT
         current_database() AS database_name,
         current_user AS database_user,
         current_setting('is_superuser') AS is_superuser`,
    );
    if (
      authority.rows[0]?.database_name !== 'vidha_fixture' ||
      authority.rows[0].is_superuser !== 'on'
    ) {
      throw new Error(
        'The topology control connection is not the disposable fixture owner.',
      );
    }
    const roles = await adminPool.query<{ role_count: string }>(
      `SELECT COUNT(*)::text AS role_count FROM pg_roles
       WHERE rolname IN ('vidha_api', 'vidha_worker', 'vidha_restore')`,
    );
    if (roles.rows[0]?.role_count !== '3') {
      throw new Error(
        'Run the disposable PostgreSQL integration gate before topology rehearsal.',
      );
    }
    const collision = await adminPool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM pg_database WHERE datname = $1',
      [DATABASE_NAME],
    );
    if (collision.rows[0]?.count !== '0') {
      throw new Error('The disposable topology database name already exists.');
    }
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(DATABASE_NAME)}`);
    databaseCreated = true;
    await adminPool.query(
      `COMMENT ON DATABASE ${quoteIdentifier(DATABASE_NAME)} IS ${quoteLiteral(DATABASE_SENTINEL)}`,
    );

    ownerConnectionString = connectionForDatabase(
      connectionString ?? '',
      DATABASE_NAME,
    );
    const migrationPool = new Pool({
      application_name: 'vidha-topology-migrator',
      connectionString: ownerConnectionString,
      max: 1,
    });
    try {
      migrationReport = await rehearseMigrationInterruptions(
        migrationPool,
        adminPool,
      );
    } finally {
      await migrationPool.end();
    }

    ownerPlatform = await createPostgresPlatform({
      connectionString: ownerConnectionString,
      environmentId: `environment_${'4'.repeat(64)}`,
      installationId: `installation_${'5'.repeat(64)}`,
      mode: 'live',
    });
    const apiConnectionString = connectionForRole(
      ownerConnectionString,
      'vidha_api',
      'vidha-api-test',
    );
    workerConnectionString = connectionForRole(
      ownerConnectionString,
      'vidha_worker',
      'vidha-worker-test',
    );
    apiPlatform = await createPostgresPlatform({
      connectionString: apiConnectionString,
      environmentId: `environment_${'4'.repeat(64)}`,
      installationId: `installation_${'5'.repeat(64)}`,
      manageSchema: false,
      mode: 'live',
    });
    workerPool = new Pool({
      application_name: 'vidha-topology-worker',
      connectionString: workerConnectionString,
      max: 6,
    });
  }, 120_000);

  afterAll(async () => {
    const closures = await Promise.allSettled([
      workerPool?.end() ?? Promise.resolve(),
      apiPlatform?.close() ?? Promise.resolve(),
      ownerPlatform?.close() ?? Promise.resolve(),
    ]);
    try {
      if (adminPool !== undefined && databaseCreated) {
        const ownership = await adminPool.query<{ sentinel: string | null }>(
          `SELECT shobj_description(oid, 'pg_database') AS sentinel
           FROM pg_database WHERE datname = $1`,
          [DATABASE_NAME],
        );
        if (ownership.rows[0]?.sentinel !== DATABASE_SENTINEL) {
          throw new Error(
            'Refusing to drop a topology database without this run sentinel.',
          );
        }
        await adminPool.query(
          `DROP DATABASE ${quoteIdentifier(DATABASE_NAME)} WITH (FORCE)`,
        );
        const remaining = await adminPool.query<{ count: string }>(
          'SELECT COUNT(*)::text AS count FROM pg_database WHERE datname = $1',
          [DATABASE_NAME],
        );
        expect(remaining.rows[0]?.count).toBe('0');
      }
    } finally {
      await adminPool?.end();
    }
    const rejected = closures.find((result) => result.status === 'rejected');
    if (rejected?.status === 'rejected') {
      throw rejected.reason;
    }
  });

  it('rolls back or replays all defined migration checkpoints', () => {
    expect(migrationReport).toEqual({
      interruptedBoundaries: MIGRATION_REHEARSAL_BOUNDARIES,
      postCommitReplayVerified: true,
      rollbackVerified: true,
      schemaVersion: 1,
    });
  });

  it('exhausts and recovers the pool while claiming 1,000 of 100,000 outbox rows beside 100,000 audit rows', async () => {
    await expect(
      rehearseTopologyCapacity({
        ownerPool: ownerPlatform.pool,
        poolConnectionString: workerConnectionString,
        rehearsalId: REHEARSAL_ID,
        workerPool,
      }),
    ).resolves.toEqual({
      auditRows: TOPOLOGY_CAPACITY_PROFILE.auditRows,
      cleanupVerified: true,
      claimedDueJobs: TOPOLOGY_CAPACITY_PROFILE.dueJobs,
      distinctClaimedDueJobs: TOPOLOGY_CAPACITY_PROFILE.dueJobs,
      outboxRows: TOPOLOGY_CAPACITY_PROFILE.outboxRows,
      poolExhaustionObserved: true,
      poolRecovered: true,
    });
  }, 120_000);

  it('rolls back worker backend crashes across claim and sink boundaries', async () => {
    const intent: SafetyJobIntent = {
      kind: 'synthetic_notice',
      jobId: JOB_ID,
      channelRef: `channel_${'f'.repeat(64)}`,
      template: 'synthetic_rehearsal',
      commandKey: COMMAND_KEY,
      dueAt: Date.now() - 1_000,
      maxAttempts: 5,
    };
    await apiPlatform.operationsStore.enqueue(intent);

    const rehearsal = await rehearseClaimInterruptions({
      controlPool: ownerPlatform.pool,
      jobId: JOB_ID,
      leaseMs: 40,
      workerId: 'worker_crash_fixture',
      workerPool,
    });
    expect(rehearsal).toEqual({
      committedLeaseId: expect.stringMatching(/^lease_.+_1$/u),
      finalClaimGeneration: 2,
      finalLeaseId: expect.stringMatching(/^lease_.+_2$/u),
      interruptedBoundaries: CLAIM_REHEARSAL_BOUNDARIES,
      jobId: JOB_ID,
      postCommitReplayVerified: true,
      rollbackVerified: true,
    });
    const worker = new PostgresOperationsStore(workerPool);
    await expect(
      worker.complete({
        jobId: JOB_ID,
        leaseId: rehearsal.committedLeaseId,
        at: Date.now(),
      }),
    ).rejects.toBeInstanceOf(OperationsError);

    await delay(70);
    const afterClaimCrash = await worker.claimDue({
      workerId: 'worker_crash_fixture',
      at: 0,
      leaseMs: 40,
      limit: 1,
    });
    expect(afterClaimCrash[0]?.job).toMatchObject({
      jobId: JOB_ID,
      leaseVersion: 3,
      status: 'leased',
    });
    await expect(
      worker.acceptSyntheticSink({
        jobId: JOB_ID,
        payloadDigest: 'a'.repeat(64),
      }),
    ).resolves.toEqual({ duplicate: false });

    await delay(70);
    const afterSinkCrash = await worker.claimDue({
      workerId: 'worker_crash_fixture',
      at: 0,
      leaseMs: 1_000,
      limit: 1,
    });
    const finalClaim = afterSinkCrash[0];
    expect(finalClaim?.job).toMatchObject({
      jobId: JOB_ID,
      leaseVersion: 4,
      status: 'leased',
    });
    await expect(
      worker.acceptSyntheticSink({
        jobId: JOB_ID,
        payloadDigest: 'a'.repeat(64),
      }),
    ).resolves.toEqual({ duplicate: true });
    await expect(
      worker.complete({
        jobId: JOB_ID,
        leaseId: afterClaimCrash[0]!.leaseId,
        at: Date.now(),
      }),
    ).rejects.toBeInstanceOf(OperationsError);
    await expect(
      worker.complete({
        jobId: JOB_ID,
        leaseId: finalClaim!.leaseId,
        at: Date.now(),
      }),
    ).resolves.toMatchObject({ status: 'completed', leaseVersion: 4 });
  });
});

function connectionForDatabase(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

function connectionForRole(
  base: string,
  username: string,
  password: string,
): string {
  const url = new URL(base);
  url.username = username;
  url.password = password;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{7,62}$/u.test(value)) {
    throw new Error('Disposable database identifiers must be bounded.');
  }
  return `"${value}"`;
}

function quoteLiteral(value: string): string {
  if (!/^vidha-disposable-topology:[a-f0-9]{16}$/u.test(value)) {
    throw new Error('Disposable database sentinels must be bounded.');
  }
  return `'${value}'`;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
