import { createHash } from 'node:crypto';

import type { PlanState } from '@vidha/domain';
import {
  createPendingJob,
  sameIntent,
  type SafetyJob,
  type SafetyJobIntent,
} from '@vidha/operations';
import {
  PLAN_STORE_SCHEMA_VERSION,
  PlanStoreError,
  assertLive,
  assertPlanTransition,
  assertPortablePlanState,
  assertSnapshot,
  cloneState,
  type AuditRecord,
  type PlanStoreSnapshot,
  type PortablePlanStore,
  type ProcessedCommandRecord,
  type StoreMode,
} from '@vidha/persistence';
import { Pool, type PoolClient } from 'pg';

export type PlanOutboxPlanner = (
  previous: PlanState,
  next: PlanState,
) => readonly SafetyJobIntent[];

export interface SyntheticConcernOutboxPlannerInput {
  readonly channelRef: string;
  readonly maxAttempts?: number;
}

export class PostgresPlanStore implements PortablePlanStore {
  constructor(
    private readonly pool: Pool,
    readonly mode: StoreMode = 'live',
    private readonly planOutbox: PlanOutboxPlanner = () => [],
  ) {}

  async schemaVersion(): Promise<number> {
    const result = await this.pool.query<{ version: number }>(
      'SELECT MAX(version) AS version FROM plan_schema',
    );
    return Number(result.rows[0]?.version);
  }

  async initialize(state: PlanState): Promise<void> {
    assertLive(this.mode);
    assertPortablePlanState(state);
    await transaction(this.pool, async (client) => {
      await assertDatabaseMode(client, this.mode);
      if (!(await insertPlanState(client, state, true))) {
        throw new PlanStoreError('ALREADY_EXISTS', 'The Plan already exists.');
      }
    });
  }

  async read(planId: string): Promise<PlanState | null> {
    const result = await this.pool.query<{ state_json: unknown }>(
      'SELECT state_json FROM plans WHERE plan_id = $1',
      [planId],
    );
    const row = result.rows[0];
    return row === undefined ? null : parseState(row.state_json);
  }

  async transact(
    planId: string,
    commandKey: string,
    commandFingerprint: string,
    authorize: (state: PlanState) => void,
    decide: (state: PlanState) => PlanState,
  ) {
    assertLive(this.mode);
    return await transaction(this.pool, async (client) => {
      await assertDatabaseMode(client, this.mode);
      const result = await client.query<{ state_json: unknown }>(
        'SELECT state_json FROM plans WHERE plan_id = $1 FOR UPDATE',
        [planId],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new PlanStoreError('NOT_FOUND', 'The Plan does not exist.');
      }
      const state = parseState(row.state_json);
      authorize(cloneState(state));
      const duplicate = await client.query<{ command_fingerprint: string }>(
        `SELECT command_fingerprint FROM processed_commands
         WHERE plan_id = $1 AND command_key = $2`,
        [planId, commandKey],
      );
      const replay = duplicate.rows[0];
      if (replay !== undefined) {
        if (replay.command_fingerprint !== commandFingerprint) {
          throw new PlanStoreError(
            'IDEMPOTENCY_CONFLICT',
            'A Plan command key cannot be reused for different intent.',
          );
        }
        return { state: cloneState(state), duplicate: true };
      }

      const next = decide(cloneState(state));
      assertPlanTransition(state, next, commandKey, commandFingerprint);
      const outbox = this.planOutbox(cloneState(state), cloneState(next));
      await stageOutbox(client, outbox);
      await client.query(
        `INSERT INTO processed_commands(
          plan_id, command_key, command_fingerprint, processed_at
        ) VALUES ($1, $2, $3, $4)`,
        [planId, commandKey, commandFingerprint, next.lastCommandAt],
      );
      await client.query(
        'UPDATE plans SET state_json = $1 WHERE plan_id = $2',
        [JSON.stringify(next), planId],
      );
      await insertAuditRange(client, next, state.events.length);
      return { state: cloneState(next), duplicate: false };
    });
  }

  async audit(planId: string): Promise<readonly AuditRecord[]> {
    const result = await this.pool.query<PostgresAuditRow>(
      `SELECT plan_id, event_id, event_type, occurred_at, ordinal
       FROM audit_events WHERE plan_id = $1 ORDER BY ordinal`,
      [planId],
    );
    return result.rows.map(mapAudit);
  }

  async exportSnapshot(): Promise<PlanStoreSnapshot> {
    return await transaction(this.pool, async (client) => {
      const plans = await client.query<{ state_json: unknown }>(
        'SELECT state_json FROM plans ORDER BY plan_id',
      );
      const commands = await client.query<PostgresCommandRow>(
        `SELECT plan_id, command_key, command_fingerprint, processed_at
         FROM processed_commands ORDER BY plan_id, command_key`,
      );
      const audit = await client.query<PostgresAuditRow>(
        `SELECT plan_id, event_id, event_type, occurred_at, ordinal
         FROM audit_events ORDER BY plan_id, ordinal`,
      );
      return {
        schemaVersion: await schemaVersion(client),
        plans: plans.rows.map((row) => parseState(row.state_json)),
        processedCommands: commands.rows.map(mapCommand),
        auditEvents: audit.rows.map(mapAudit),
      };
    });
  }

  async restoreSnapshot(snapshot: PlanStoreSnapshot): Promise<void> {
    if (this.mode !== 'restore_safe') {
      throw new PlanStoreError(
        'RESTORE_SAFE_MODE',
        'PostgreSQL Plan restore is allowed only in restore-safe mode.',
      );
    }
    assertSnapshot(snapshot);
    await transaction(this.pool, async (client) => {
      await assertDatabaseMode(client, this.mode);
      const count = await client.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM plans',
      );
      if (count.rows[0]?.count !== '0') {
        throw new PlanStoreError(
          'ALREADY_EXISTS',
          'PostgreSQL Plan restore requires an empty store.',
        );
      }
      for (const plan of snapshot.plans) {
        await client.query(
          'INSERT INTO plans(plan_id, state_json) VALUES ($1, $2)',
          [plan.planId, JSON.stringify(plan)],
        );
      }
      for (const command of snapshot.processedCommands) {
        await client.query(
          `INSERT INTO processed_commands(
            plan_id, command_key, command_fingerprint, processed_at
          ) VALUES ($1, $2, $3, $4)`,
          [
            command.planId,
            command.commandKey,
            command.commandFingerprint,
            command.processedAt,
          ],
        );
      }
      for (const event of snapshot.auditEvents)
        await insertAudit(client, event);
    });
  }
}

export function createSyntheticConcernOutboxPlanner({
  channelRef,
  maxAttempts = 5,
}: SyntheticConcernOutboxPlannerInput): PlanOutboxPlanner {
  if (!/^channel_[a-f0-9]{64}$/u.test(channelRef)) {
    throw new TypeError(
      'The synthetic outbox requires an opaque channel reference.',
    );
  }
  if (
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts <= 0 ||
    maxAttempts > 100
  ) {
    throw new RangeError(
      'The synthetic outbox attempt bound must be between 1 and 100.',
    );
  }
  return (previous, next) => {
    const intents: SafetyJobIntent[] = [];
    const dueAt = nextScheduleAt(next);
    if (dueAt !== null) {
      const semantic = `advance:${next.planId}:${next.cycle.startedAt}:${next.cycle.stage}:${dueAt}`;
      intents.push({
        kind: 'advance_plan_stage',
        jobId: opaqueId('job', semantic),
        planRef: next.planId,
        commandKey: opaqueId('cmd', semantic),
        dueAt,
        maxAttempts,
      });
    }
    for (const event of next.events.slice(previous.events.length)) {
      if (
        event.type !== 'REMINDER_ENTERED' &&
        event.type !== 'CONCERN_ENTERED'
      ) {
        continue;
      }
      const semantic = `synthetic-notice:${next.planId}:${event.id}:${event.at}`;
      intents.push({
        kind: 'synthetic_notice',
        jobId: opaqueId('job', semantic),
        channelRef,
        template: 'synthetic_rehearsal',
        commandKey: opaqueId('cmd', semantic),
        dueAt: event.at,
        maxAttempts,
      });
    }
    return intents;
  };
}

function nextScheduleAt(state: PlanState): number | null {
  if (state.lifecycle !== 'armed') return null;
  switch (state.cycle.stage) {
    case 'on_time':
      return state.cycle.reminderAt;
    case 'reminder':
      return state.cycle.dueAt;
    case 'overdue':
      return state.cycle.concernAt;
    case 'concern':
      return null;
  }
}

function opaqueId(prefix: 'cmd' | 'job', semantic: string): string {
  return `${prefix}_${createHash('sha256').update(semantic, 'utf8').digest('hex')}`;
}

async function stageOutbox(
  client: PoolClient,
  intents: readonly SafetyJobIntent[],
): Promise<void> {
  const seen = new Set<string>();
  for (const intent of intents) {
    if (seen.has(intent.jobId)) {
      throw new PlanStoreError(
        'IDEMPOTENCY_CONFLICT',
        'One Plan transaction cannot repeat a durable-work identifier.',
      );
    }
    seen.add(intent.jobId);
    const job = createPendingJob(intent);
    if (await insertSafetyJob(client, job, true)) continue;
    const existing = await client.query<{ state_json: unknown }>(
      'SELECT state_json FROM safety_jobs WHERE job_id = $1',
      [intent.jobId],
    );
    const row = existing.rows[0];
    if (
      row === undefined ||
      !sameIntent(parseSafetyJob(row.state_json), intent)
    ) {
      outboxConflict();
    }
  }
}

async function insertSafetyJob(
  client: PoolClient,
  job: SafetyJob,
  ignoreConflict = false,
): Promise<boolean> {
  const result = await client.query(
    `INSERT INTO safety_jobs(
      job_id, kind, semantic_key, status, available_at, lease_id,
      lease_owner, lease_expires_at, claim_generation, state_json
    ) VALUES ($1, $2, $3, $4, $5, NULL, NULL, NULL, $6, $7)
    ${ignoreConflict ? 'ON CONFLICT DO NOTHING' : ''}
    RETURNING job_id`,
    [
      job.jobId,
      job.kind,
      job.commandKey,
      job.status,
      job.availableAt,
      job.leaseVersion,
      JSON.stringify(job),
    ],
  );
  return result.rowCount === 1;
}

async function assertDatabaseMode(
  client: PoolClient,
  expected: StoreMode,
): Promise<void> {
  const result = await client.query<{ mode: StoreMode }>(
    'SELECT mode FROM runtime_configuration WHERE singleton',
  );
  if (result.rows[0]?.mode !== expected) {
    throw new PlanStoreError(
      'INVALID_CONFIGURATION',
      'The Plan adapter mode does not match PostgreSQL runtime state.',
    );
  }
}

function parseSafetyJob(value: unknown): SafetyJob {
  return structuredClone(
    (typeof value === 'string' ? JSON.parse(value) : value) as SafetyJob,
  );
}

function outboxConflict(): never {
  throw new PlanStoreError(
    'IDEMPOTENCY_CONFLICT',
    'A durable-work identifier cannot be reused for different intent.',
  );
}

async function insertPlanState(
  client: PoolClient,
  state: PlanState,
  ignoreConflict = false,
): Promise<boolean> {
  const inserted = await client.query(
    `INSERT INTO plans(plan_id, state_json) VALUES ($1, $2)
     ${ignoreConflict ? 'ON CONFLICT DO NOTHING' : ''}
     RETURNING plan_id`,
    [state.planId, JSON.stringify(state)],
  );
  if (inserted.rowCount !== 1) return false;
  for (const commandKey of state.processedCommandKeys) {
    const fingerprint = state.processedCommandFingerprints[commandKey];
    if (fingerprint === undefined) {
      throw new PlanStoreError(
        'INVALID_SNAPSHOT',
        'A Plan command identifier has no fingerprint.',
      );
    }
    await client.query(
      `INSERT INTO processed_commands(
        plan_id, command_key, command_fingerprint, processed_at
      ) VALUES ($1, $2, $3, $4)`,
      [state.planId, commandKey, fingerprint, state.lastCommandAt],
    );
  }
  await insertAuditRange(client, state, 0);
  return true;
}

async function insertAuditRange(
  client: PoolClient,
  state: PlanState,
  start: number,
): Promise<void> {
  for (let ordinal = start; ordinal < state.events.length; ordinal += 1) {
    const event = state.events[ordinal];
    if (event === undefined) continue;
    await insertAudit(client, {
      planId: state.planId,
      eventId: event.id,
      type: event.type,
      occurredAt: event.at,
      ordinal,
    });
  }
}

async function insertAudit(
  client: PoolClient,
  event: AuditRecord,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events(
      plan_id, event_id, event_type, occurred_at, ordinal
    ) VALUES ($1, $2, $3, $4, $5)`,
    [event.planId, event.eventId, event.type, event.occurredAt, event.ordinal],
  );
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

async function schemaVersion(client: PoolClient): Promise<number> {
  const result = await client.query<{ version: number }>(
    'SELECT MAX(version) AS version FROM plan_schema',
  );
  const version = Number(result.rows[0]?.version);
  if (version !== PLAN_STORE_SCHEMA_VERSION) {
    throw new PlanStoreError(
      'INVALID_SNAPSHOT',
      'The PostgreSQL Plan schema version is unsupported.',
    );
  }
  return version;
}

interface PostgresAuditRow {
  readonly plan_id: string;
  readonly event_id: string;
  readonly event_type: AuditRecord['type'];
  readonly occurred_at: string;
  readonly ordinal: number;
}

interface PostgresCommandRow {
  readonly plan_id: string;
  readonly command_key: string;
  readonly command_fingerprint: string;
  readonly processed_at: string;
}

function mapAudit(row: PostgresAuditRow): AuditRecord {
  return {
    planId: row.plan_id,
    eventId: row.event_id,
    type: row.event_type,
    occurredAt: Number(row.occurred_at),
    ordinal: Number(row.ordinal),
  };
}

function mapCommand(row: PostgresCommandRow): ProcessedCommandRecord {
  return {
    planId: row.plan_id,
    commandKey: row.command_key,
    commandFingerprint: row.command_fingerprint,
    processedAt: Number(row.processed_at),
  };
}

function parseState(value: unknown): PlanState {
  return structuredClone(
    (typeof value === 'string' ? JSON.parse(value) : value) as PlanState,
  );
}
