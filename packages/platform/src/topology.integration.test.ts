import { randomBytes } from 'node:crypto';

import { applyPlanCommand, createDraftPlan } from '@vidha/domain';
import { OperationsError, type SafetyJobIntent } from '@vidha/operations';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';

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
  SCHEDULED_PLAN_EXECUTION_BOUNDARIES,
  PostgresPlanStore,
  createSyntheticConcernOutboxPlanner,
  rehearseScheduledPlanInterruption,
} from './postgresPlan';
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
  const unexpectedPoolErrors: Error[] = [];
  const terminationErrors = createTerminationErrorTracker(unexpectedPoolErrors);

  beforeAll(async () => {
    adminPool = new Pool({
      application_name: 'vidha-topology-control',
      connectionString: connectionString ?? '',
    });
    adminPool.on('error', (error) => unexpectedPoolErrors.push(error));
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
    terminationErrors.capture(migrationPool);
    try {
      migrationReport = await rehearseMigrationInterruptions(
        migrationPool,
        adminPool,
        (client, boundary) =>
          terminationErrors.register(client, `migration:${boundary}`),
      );
    } finally {
      await migrationPool.end();
    }

    ownerPlatform = await createPostgresPlatform({
      connectionString: ownerConnectionString,
      environmentId: `environment_${'4'.repeat(64)}`,
      installationId: `installation_${'5'.repeat(64)}`,
      mode: 'live',
      onPoolError: (error) => unexpectedPoolErrors.push(error),
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
      onPoolError: (error) => unexpectedPoolErrors.push(error),
    });
    workerPool = new Pool({
      application_name: 'vidha-topology-worker',
      connectionString: workerConnectionString,
      max: 6,
    });
    terminationErrors.capture(workerPool);
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
    expect(unexpectedPoolErrors).toEqual([]);
    const terminationReport = terminationErrors.report();
    expect(terminationReport.registered).toEqual([
      ...MIGRATION_REHEARSAL_BOUNDARIES.map(
        (boundary) => `migration:${boundary}`,
      ),
      ...CLAIM_REHEARSAL_BOUNDARIES.map((boundary) => `claim:${boundary}`),
      ...SCHEDULED_PLAN_EXECUTION_BOUNDARIES.map(
        (boundary) => `scheduled-plan:${boundary}`,
      ),
    ]);
    // node-postgres can surface a killed backend through the rejected operation,
    // a client or pool error event, or both. Any event remains exact-client scoped.
    expect(terminationReport.observed.length).toBeGreaterThan(0);
    expect(
      terminationReport.observed.every((label) =>
        terminationReport.registered.includes(label),
      ),
    ).toBe(true);
  });

  it('rolls back or replays all defined migration checkpoints', () => {
    expect(migrationReport).toEqual({
      interruptedBoundaries: MIGRATION_REHEARSAL_BOUNDARIES,
      postCommitReplayVerified: true,
      rollbackVerified: true,
      schemaVersion: 4,
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
      expectTermination: (client, boundary) =>
        terminationErrors.register(client, `claim:${boundary}`),
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

  it('atomically advances one scheduled stage across crashes, stale policy, and retry exhaustion', async () => {
    const start = Date.now() - 86_400_000;
    const planId = 'plan_scheduled_crash_fixture';
    const channelRef = `channel_${'a'.repeat(64)}`;
    const planner = createSyntheticConcernOutboxPlanner({
      channelRef,
      maxAttempts: 8,
    });
    const apiStore = apiPlatform.createPlanStore(planner);
    const workerStore = new PostgresPlanStore(workerPool, 'live', planner);
    await expect(
      workerPool.query('SELECT event_id FROM audit_events LIMIT 1'),
    ).rejects.toMatchObject({ code: '42501' });
    await initializeArmedPlan(apiStore, planId, start);
    const operations = new PostgresOperationsStore(workerPool);
    const firstJob = (await apiPlatform.operationsStore.inspectJobs()).find(
      (job) => job.kind === 'advance_plan_stage' && job.planRef === planId,
    );
    expect(firstJob).toBeDefined();
    const jobsBeforeCrashMatrix = new Set(
      (await apiPlatform.operationsStore.inspectJobs()).map((job) => job.jobId),
    );
    let lostAcknowledgementLeaseId: string | undefined;

    for (const boundary of SCHEDULED_PLAN_EXECUTION_BOUNDARIES) {
      const claims = await operations.claimDue({
        workerId: 'worker_scheduled_crash_fixture',
        at: 0,
        leaseMs: 1_000,
        limit: 10,
      });
      const claim = claims.find(
        (candidate) => candidate.job.jobId === firstJob!.jobId,
      );
      expect(claim).toBeDefined();
      await expect(
        rehearseScheduledPlanInterruption({
          boundary,
          controlPool: ownerPlatform.pool,
          expectTermination: (client, interrupted) =>
            terminationErrors.register(client, `scheduled-plan:${interrupted}`),
          jobId: claim!.job.jobId,
          leaseId: claim!.leaseId,
          planOutbox: planner,
          workerPool,
        }),
      ).resolves.toEqual({ committed: boundary === 'after_commit' });

      const state = await apiStore.read(planId);
      const job = (await apiPlatform.operationsStore.inspectJobs()).find(
        (candidate) => candidate.jobId === firstJob!.jobId,
      );
      const command = await ownerPlatform.pool.query<{
        command_fingerprint: string;
      }>(
        `SELECT command_fingerprint FROM processed_commands
         WHERE plan_id = $1 AND command_key = $2`,
        [planId, firstJob!.commandKey],
      );
      const newlyStaged = (
        await apiPlatform.operationsStore.inspectJobs()
      ).filter((candidate) => !jobsBeforeCrashMatrix.has(candidate.jobId));
      if (boundary === 'after_commit') {
        lostAcknowledgementLeaseId = claim!.leaseId;
        expect(state?.cycle.stage).toBe('reminder');
        expect(job?.status).toBe('completed');
        expect(await apiStore.audit(planId)).toHaveLength(4);
        expect(command.rows).toEqual([{ command_fingerprint: 'ADVANCE_TIME' }]);
        expect(newlyStaged).toHaveLength(2);
        expect(newlyStaged).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: 'advance_plan_stage',
              planRef: planId,
              status: 'pending',
            }),
            expect.objectContaining({
              kind: 'synthetic_notice',
              status: 'pending',
              template: 'synthetic_rehearsal',
            }),
          ]),
        );
      } else {
        expect(state?.cycle.stage).toBe('on_time');
        expect(job?.status).toBe('leased');
        expect(await apiStore.audit(planId)).toHaveLength(3);
        expect(command.rows).toEqual([]);
        expect(newlyStaged).toEqual([]);
        await delay(1_050);
      }
    }
    expect(lostAcknowledgementLeaseId).toBeDefined();
    await expect(
      workerStore.advanceScheduled({
        jobId: firstJob!.jobId,
        leaseId: lostAcknowledgementLeaseId!,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_LEASE' });

    const overdueClaim = (
      await operations.claimDue({
        workerId: 'worker_scheduled_catchup_fixture',
        at: 0,
        leaseMs: 1_000,
        limit: 10,
      })
    ).find(
      (claim) =>
        claim.job.kind === 'advance_plan_stage' && claim.job.planRef === planId,
    );
    expect(overdueClaim).toBeDefined();
    await expect(
      workerStore.advanceScheduled({
        jobId: overdueClaim!.job.jobId,
        leaseId: overdueClaim!.leaseId,
      }),
    ).resolves.toMatchObject({
      outcome: 'advanced',
      state: { cycle: { stage: 'overdue' } },
    });

    const concernClaim = (
      await operations.claimDue({
        workerId: 'worker_scheduled_catchup_fixture',
        at: 0,
        leaseMs: 1_000,
        limit: 10,
      })
    ).find(
      (claim) =>
        claim.job.kind === 'advance_plan_stage' && claim.job.planRef === planId,
    );
    expect(concernClaim).toBeDefined();
    await expect(
      workerStore.advanceScheduled({
        jobId: concernClaim!.job.jobId,
        leaseId: concernClaim!.leaseId,
      }),
    ).resolves.toMatchObject({
      outcome: 'advanced',
      state: { cycle: { stage: 'concern' } },
    });
    expect(await apiStore.audit(planId)).toHaveLength(6);
    expect(
      (await apiPlatform.operationsStore.inspectJobs()).filter(
        (job) =>
          job.kind === 'advance_plan_stage' &&
          job.planRef === planId &&
          job.status === 'pending',
      ),
    ).toEqual([]);

    const stalePlanId = 'plan_stale_policy_fixture';
    await initializeArmedPlan(apiStore, stalePlanId, start);
    await ownerPlatform.pool.query(
      `UPDATE plans SET state_json = jsonb_set(
         state_json, '{policyRevision}',
         to_jsonb((state_json->>'policyRevision')::integer + 1)
       ) WHERE plan_id = $1`,
      [stalePlanId],
    );
    const staleClaim = (
      await operations.claimDue({
        workerId: 'worker_stale_policy_fixture',
        at: 0,
        leaseMs: 1_000,
        limit: 10,
      })
    ).find(
      (claim) =>
        claim.job.kind === 'advance_plan_stage' &&
        claim.job.planRef === stalePlanId,
    );
    expect(staleClaim).toBeDefined();
    await expect(
      workerStore.advanceScheduled({
        jobId: staleClaim!.job.jobId,
        leaseId: staleClaim!.leaseId,
      }),
    ).resolves.toMatchObject({
      job: {
        lastFailureCode: 'stale_schedule',
        status: 'dead_letter',
      },
      outcome: 'stale_schedule',
      state: { cycle: { stage: 'on_time' }, policyRevision: 2 },
    });
    expect(await apiStore.audit(stalePlanId)).toHaveLength(3);

    const orphan: SafetyJobIntent = {
      kind: 'advance_plan_stage',
      jobId: `job_${'b'.repeat(64)}`,
      planRef: 'plan_missing_fixture',
      commandKey: `cmd_${'c'.repeat(64)}`,
      dueAt: start,
      maxAttempts: 2,
    };
    await apiPlatform.operationsStore.enqueue(orphan);
    for (const attempt of [1, 2]) {
      const claim = (
        await operations.claimDue({
          workerId: 'worker_retry_exhaustion_fixture',
          at: 0,
          leaseMs: 1_000,
          limit: 10,
        })
      ).find((candidate) => candidate.job.jobId === orphan.jobId);
      expect(claim?.job.attempts).toBe(attempt);
      await expect(
        workerStore.advanceScheduled({
          jobId: claim!.job.jobId,
          leaseId: claim!.leaseId,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await operations.fail({
        jobId: claim!.job.jobId,
        leaseId: claim!.leaseId,
        at: start,
        failureCode: 'plan_unavailable',
        retryAt: start + 1,
      });
    }
    expect(
      (await apiPlatform.operationsStore.inspectJobs()).find(
        (job) => job.jobId === orphan.jobId,
      ),
    ).toMatchObject({
      attempts: 2,
      lastFailureCode: 'plan_unavailable',
      status: 'dead_letter',
    });
  }, 30_000);
});

async function initializeArmedPlan(
  store: PostgresPlanStore,
  planId: string,
  at: number,
): Promise<void> {
  await store.initialize(
    createDraftPlan({
      planId,
      ownerId: 'owner_scheduled_fixture',
      at,
      policy: {
        checkInIntervalMs: 14_400_000,
        reminderLeadMs: 3_600_000,
        gracePeriodMs: 7_200_000,
      },
    }),
  );
  await store.transact(
    planId,
    `cmd_${'d'.repeat(64)}`,
    'REHEARSE_PLAN:policy:1',
    () => undefined,
    (state) =>
      applyPlanCommand(state, {
        type: 'REHEARSE_PLAN',
        at,
        authenticated: true,
        expectedPolicyRevision: 1,
        idempotencyKey: `cmd_${'d'.repeat(64)}`,
      }),
  );
  await store.transact(
    planId,
    `cmd_${'e'.repeat(64)}`,
    'ARM_PLAN:policy:1',
    () => undefined,
    (state) =>
      applyPlanCommand(state, {
        type: 'ARM_PLAN',
        at,
        authenticated: true,
        recentlyAuthenticated: true,
        expectedPolicyRevision: 1,
        idempotencyKey: `cmd_${'e'.repeat(64)}`,
      }),
  );
}

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

function isExpectedTerminationError(error: Error): boolean {
  const code = (error as Error & { readonly code?: string }).code;
  return (
    code === '57P01' || error.message === 'Connection terminated unexpectedly'
  );
}

function createTerminationErrorTracker(unexpected: Error[]) {
  const registered = new Map<PoolClient, string>();
  const observed = new Set<string>();
  const capture = (client: PoolClient, error: Error) => {
    const label = registered.get(client);
    if (label !== undefined && isExpectedTerminationError(error)) {
      observed.add(label);
      return;
    }
    unexpected.push(error);
  };
  return {
    capture(pool: Pool) {
      pool.on('connect', (client) =>
        client.on('error', (error) => capture(client, error)),
      );
      pool.on('error', (error, client) => capture(client, error));
    },
    register(client: PoolClient, label: string) {
      if (registered.has(client)) {
        throw new Error('A terminated PostgreSQL client was reused.');
      }
      registered.set(client, label);
    },
    report() {
      return {
        registered: [...registered.values()],
        observed: [...observed],
      };
    },
  };
}
