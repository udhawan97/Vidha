import {
  PGlite,
  type PGliteInterface,
  type Transaction,
} from '@electric-sql/pglite';
import type { PlanState } from '@vidha/domain';

import {
  PlanStoreError,
  assertLive,
  assertSnapshot,
  cloneState,
  type AuditRecord,
  type PlanStoreSnapshot,
  type PortablePlanStore,
  type ProcessedCommandRecord,
  type StoreMode,
} from './store';

const PGLITE_MIGRATION = `
  CREATE TABLE IF NOT EXISTS vidha_schema (
    version INTEGER PRIMARY KEY
  );
  INSERT INTO vidha_schema(version) VALUES (1) ON CONFLICT DO NOTHING;
  CREATE TABLE IF NOT EXISTS plans (
    plan_id TEXT PRIMARY KEY,
    state_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS processed_commands (
    plan_id TEXT NOT NULL REFERENCES plans(plan_id),
    command_key TEXT NOT NULL,
    processed_at BIGINT NOT NULL,
    PRIMARY KEY (plan_id, command_key)
  );
  CREATE TABLE IF NOT EXISTS audit_events (
    plan_id TEXT NOT NULL REFERENCES plans(plan_id),
    event_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    occurred_at BIGINT NOT NULL,
    ordinal INTEGER NOT NULL,
    PRIMARY KEY (plan_id, event_id),
    UNIQUE (plan_id, ordinal)
  );
`;

interface CreatePglitePlanStoreOptions {
  readonly database?: PGliteInterface;
  readonly mode?: StoreMode;
}

export async function createPglitePlanStore(
  options: CreatePglitePlanStoreOptions = {},
): Promise<PglitePlanStore> {
  return await PglitePlanStore.create(options);
}

export class PglitePlanStore implements PortablePlanStore {
  readonly mode: StoreMode;

  private constructor(
    private readonly database: PGliteInterface,
    mode: StoreMode,
  ) {
    this.mode = mode;
  }

  static async create(
    options: CreatePglitePlanStoreOptions = {},
  ): Promise<PglitePlanStore> {
    const database = options.database ?? (await PGlite.create());
    await database.exec(PGLITE_MIGRATION);
    return new PglitePlanStore(database, options.mode ?? 'live');
  }

  async schemaVersion(): Promise<number> {
    const result = await this.database.query<{ version: number }>(
      'SELECT MAX(version) AS version FROM vidha_schema',
    );
    return Number(result.rows[0]?.version);
  }

  async initialize(state: PlanState): Promise<void> {
    assertLive(this.mode);
    await this.database.transaction(async (transaction) => {
      const existing = await transaction.query(
        'SELECT 1 FROM plans WHERE plan_id = $1',
        [state.planId],
      );
      if (existing.rows.length > 0) {
        throw new PlanStoreError('ALREADY_EXISTS', 'The Plan already exists.');
      }
      await this.insertPlanState(transaction, state);
    });
  }

  async read(planId: string): Promise<PlanState | null> {
    const result = await this.database.query<{ state_json: string }>(
      'SELECT state_json FROM plans WHERE plan_id = $1',
      [planId],
    );
    const row = result.rows[0];
    return row === undefined ? null : parseState(row.state_json);
  }

  async transact(
    planId: string,
    commandKey: string,
    authorize: (state: PlanState) => void,
    decide: (state: PlanState) => PlanState,
  ) {
    assertLive(this.mode);
    return await this.database.transaction(async (transaction) => {
      const result = await transaction.query<{ state_json: string }>(
        'SELECT state_json FROM plans WHERE plan_id = $1 FOR UPDATE',
        [planId],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new PlanStoreError('NOT_FOUND', 'The Plan does not exist.');
      }
      const state = parseState(row.state_json);
      authorize(cloneState(state));
      const duplicate = await transaction.query(
        'SELECT 1 FROM processed_commands WHERE plan_id = $1 AND command_key = $2',
        [planId, commandKey],
      );
      if (duplicate.rows.length > 0) {
        return { state, duplicate: true };
      }

      const next = decide(cloneState(state));
      await transaction.query(
        `INSERT INTO processed_commands(plan_id, command_key, processed_at)
         VALUES ($1, $2, $3)`,
        [planId, commandKey, next.lastCommandAt],
      );
      await transaction.query(
        'UPDATE plans SET state_json = $1 WHERE plan_id = $2',
        [JSON.stringify(next), planId],
      );
      await this.insertAuditRange(transaction, next, state.events.length);
      return { state: cloneState(next), duplicate: false };
    });
  }

  async audit(planId: string): Promise<readonly AuditRecord[]> {
    const result = await this.database.query<PostgresAuditRow>(
      `SELECT plan_id, event_id, event_type, occurred_at, ordinal
       FROM audit_events WHERE plan_id = $1 ORDER BY ordinal`,
      [planId],
    );
    return result.rows.map(mapAuditRow);
  }

  async exportSnapshot(): Promise<PlanStoreSnapshot> {
    const plans = await this.database.query<{ state_json: string }>(
      'SELECT state_json FROM plans ORDER BY plan_id',
    );
    const commands = await this.database.query<PostgresCommandRow>(
      `SELECT plan_id, command_key, processed_at
       FROM processed_commands ORDER BY plan_id, command_key`,
    );
    const auditEvents = await this.database.query<PostgresAuditRow>(
      `SELECT plan_id, event_id, event_type, occurred_at, ordinal
       FROM audit_events ORDER BY plan_id, ordinal`,
    );
    return {
      schemaVersion: await this.schemaVersion(),
      plans: plans.rows.map((row) => parseState(row.state_json)),
      processedCommands: commands.rows.map(mapCommandRow),
      auditEvents: auditEvents.rows.map(mapAuditRow),
    };
  }

  async restoreSnapshot(snapshot: PlanStoreSnapshot): Promise<void> {
    assertSnapshot(snapshot);
    await this.database.transaction(async (transaction) => {
      const count = await transaction.query<{ count: string }>(
        'SELECT COUNT(*) AS count FROM plans',
      );
      if (Number(count.rows[0]?.count) !== 0) {
        throw new PlanStoreError(
          'ALREADY_EXISTS',
          'Restore requires an empty Plan store.',
        );
      }
      for (const plan of snapshot.plans) {
        await transaction.query(
          'INSERT INTO plans(plan_id, state_json) VALUES ($1, $2)',
          [plan.planId, JSON.stringify(plan)],
        );
      }
      for (const command of snapshot.processedCommands) {
        await transaction.query(
          `INSERT INTO processed_commands(plan_id, command_key, processed_at)
           VALUES ($1, $2, $3)`,
          [command.planId, command.commandKey, command.processedAt],
        );
      }
      for (const event of snapshot.auditEvents) {
        await this.insertAudit(transaction, event);
      }
    });
  }

  async close(): Promise<void> {
    await this.database.close();
  }

  private async insertPlanState(
    transaction: Transaction,
    state: PlanState,
  ): Promise<void> {
    await transaction.query(
      'INSERT INTO plans(plan_id, state_json) VALUES ($1, $2)',
      [state.planId, JSON.stringify(state)],
    );
    for (const commandKey of state.processedCommandKeys) {
      await transaction.query(
        `INSERT INTO processed_commands(plan_id, command_key, processed_at)
         VALUES ($1, $2, $3)`,
        [state.planId, commandKey, state.lastCommandAt],
      );
    }
    await this.insertAuditRange(transaction, state, 0);
  }

  private async insertAuditRange(
    transaction: Transaction,
    state: PlanState,
    start: number,
  ): Promise<void> {
    for (let index = start; index < state.events.length; index += 1) {
      const event = state.events[index];
      if (event === undefined) {
        continue;
      }
      await this.insertAudit(transaction, {
        planId: state.planId,
        eventId: event.id,
        type: event.type,
        occurredAt: event.at,
        ordinal: index,
      });
    }
  }

  private async insertAudit(
    transaction: Transaction,
    event: AuditRecord,
  ): Promise<void> {
    await transaction.query(
      `INSERT INTO audit_events(
        plan_id, event_id, event_type, occurred_at, ordinal
      ) VALUES ($1, $2, $3, $4, $5)`,
      [
        event.planId,
        event.eventId,
        event.type,
        event.occurredAt,
        event.ordinal,
      ],
    );
  }
}

interface PostgresAuditRow {
  readonly plan_id: string;
  readonly event_id: string;
  readonly event_type: AuditRecord['type'];
  readonly occurred_at: number | string;
  readonly ordinal: number;
}

interface PostgresCommandRow {
  readonly plan_id: string;
  readonly command_key: string;
  readonly processed_at: number | string;
}

function mapAuditRow(row: PostgresAuditRow): AuditRecord {
  return {
    planId: row.plan_id,
    eventId: row.event_id,
    type: row.event_type,
    occurredAt: Number(row.occurred_at),
    ordinal: Number(row.ordinal),
  };
}

function mapCommandRow(row: PostgresCommandRow): ProcessedCommandRecord {
  return {
    planId: row.plan_id,
    commandKey: row.command_key,
    processedAt: Number(row.processed_at),
  };
}

function parseState(json: string): PlanState {
  return JSON.parse(json) as PlanState;
}
