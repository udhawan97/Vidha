import { DatabaseSync } from 'node:sqlite';

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

const SQLITE_MIGRATION = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS vidha_schema (
    version INTEGER PRIMARY KEY
  ) STRICT;
  INSERT OR IGNORE INTO vidha_schema(version) VALUES (1);
  CREATE TABLE IF NOT EXISTS plans (
    plan_id TEXT PRIMARY KEY,
    state_json TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS processed_commands (
    plan_id TEXT NOT NULL,
    command_key TEXT NOT NULL,
    processed_at INTEGER NOT NULL,
    PRIMARY KEY (plan_id, command_key),
    FOREIGN KEY (plan_id) REFERENCES plans(plan_id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS audit_events (
    plan_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    occurred_at INTEGER NOT NULL,
    ordinal INTEGER NOT NULL,
    PRIMARY KEY (plan_id, event_id),
    UNIQUE (plan_id, ordinal),
    FOREIGN KEY (plan_id) REFERENCES plans(plan_id)
  ) STRICT;
`;

interface SqlitePlanStoreOptions {
  readonly database?: DatabaseSync;
  readonly mode?: StoreMode;
}

export class SqlitePlanStore implements PortablePlanStore {
  readonly mode: StoreMode;
  private readonly database: DatabaseSync;

  constructor(options: SqlitePlanStoreOptions = {}) {
    this.database = options.database ?? new DatabaseSync(':memory:');
    this.mode = options.mode ?? 'live';
    this.database.exec(SQLITE_MIGRATION);
  }

  async schemaVersion(): Promise<number> {
    const row = this.database
      .prepare('SELECT MAX(version) AS version FROM vidha_schema')
      .get() as { version: number };
    return row.version;
  }

  async initialize(state: PlanState): Promise<void> {
    assertLive(this.mode);
    this.withTransaction(() => {
      const existing = this.database
        .prepare('SELECT 1 AS found FROM plans WHERE plan_id = ?')
        .get(state.planId);
      if (existing !== undefined) {
        throw new PlanStoreError('ALREADY_EXISTS', 'The Plan already exists.');
      }
      this.insertPlanState(state);
    });
  }

  async read(planId: string): Promise<PlanState | null> {
    const row = this.database
      .prepare('SELECT state_json FROM plans WHERE plan_id = ?')
      .get(planId) as { state_json: string } | undefined;
    return row === undefined ? null : parseState(row.state_json);
  }

  async transact(
    planId: string,
    commandKey: string,
    authorize: (state: PlanState) => void,
    decide: (state: PlanState) => PlanState,
  ) {
    assertLive(this.mode);
    return this.withTransaction(() => {
      const row = this.database
        .prepare('SELECT state_json FROM plans WHERE plan_id = ?')
        .get(planId) as { state_json: string } | undefined;
      if (row === undefined) {
        throw new PlanStoreError('NOT_FOUND', 'The Plan does not exist.');
      }
      const state = parseState(row.state_json);
      authorize(cloneState(state));
      const duplicate = this.database
        .prepare(
          'SELECT 1 AS found FROM processed_commands WHERE plan_id = ? AND command_key = ?',
        )
        .get(planId, commandKey);
      if (duplicate !== undefined) {
        return { state, duplicate: true };
      }

      const next = decide(cloneState(state));
      this.database
        .prepare(
          'INSERT INTO processed_commands(plan_id, command_key, processed_at) VALUES (?, ?, ?)',
        )
        .run(planId, commandKey, next.lastCommandAt);
      this.database
        .prepare('UPDATE plans SET state_json = ? WHERE plan_id = ?')
        .run(JSON.stringify(next), planId);
      this.insertAuditRange(next, state.events.length);
      return { state: cloneState(next), duplicate: false };
    });
  }

  async audit(planId: string): Promise<readonly AuditRecord[]> {
    const rows = this.database
      .prepare(
        `SELECT plan_id, event_id, event_type, occurred_at, ordinal
         FROM audit_events WHERE plan_id = ? ORDER BY ordinal`,
      )
      .all(planId) as unknown as SqliteAuditRow[];
    return rows.map(mapAuditRow);
  }

  async exportSnapshot(): Promise<PlanStoreSnapshot> {
    const planRows = this.database
      .prepare('SELECT state_json FROM plans ORDER BY plan_id')
      .all() as unknown as { state_json: string }[];
    const commandRows = this.database
      .prepare(
        `SELECT plan_id, command_key, processed_at
         FROM processed_commands ORDER BY plan_id, command_key`,
      )
      .all() as unknown as SqliteCommandRow[];
    const auditRows = this.database
      .prepare(
        `SELECT plan_id, event_id, event_type, occurred_at, ordinal
         FROM audit_events ORDER BY plan_id, ordinal`,
      )
      .all() as unknown as SqliteAuditRow[];
    return {
      schemaVersion: await this.schemaVersion(),
      plans: planRows.map((row) => parseState(row.state_json)),
      processedCommands: commandRows.map(mapCommandRow),
      auditEvents: auditRows.map(mapAuditRow),
    };
  }

  async restoreSnapshot(snapshot: PlanStoreSnapshot): Promise<void> {
    assertSnapshot(snapshot);
    this.withTransaction(() => {
      const row = this.database
        .prepare('SELECT COUNT(*) AS count FROM plans')
        .get() as {
        count: number;
      };
      if (row.count !== 0) {
        throw new PlanStoreError(
          'ALREADY_EXISTS',
          'Restore requires an empty Plan store.',
        );
      }
      for (const plan of snapshot.plans) {
        this.database
          .prepare('INSERT INTO plans(plan_id, state_json) VALUES (?, ?)')
          .run(plan.planId, JSON.stringify(plan));
      }
      for (const command of snapshot.processedCommands) {
        this.database
          .prepare(
            'INSERT INTO processed_commands(plan_id, command_key, processed_at) VALUES (?, ?, ?)',
          )
          .run(command.planId, command.commandKey, command.processedAt);
      }
      for (const event of snapshot.auditEvents) {
        this.insertAudit(event);
      }
    });
  }

  close(): void {
    this.database.close();
  }

  private withTransaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private insertPlanState(state: PlanState): void {
    this.database
      .prepare('INSERT INTO plans(plan_id, state_json) VALUES (?, ?)')
      .run(state.planId, JSON.stringify(state));
    for (const commandKey of state.processedCommandKeys) {
      this.database
        .prepare(
          'INSERT INTO processed_commands(plan_id, command_key, processed_at) VALUES (?, ?, ?)',
        )
        .run(state.planId, commandKey, state.lastCommandAt);
    }
    this.insertAuditRange(state, 0);
  }

  private insertAuditRange(state: PlanState, start: number): void {
    for (let index = start; index < state.events.length; index += 1) {
      const event = state.events[index];
      if (event === undefined) {
        continue;
      }
      this.insertAudit({
        planId: state.planId,
        eventId: event.id,
        type: event.type,
        occurredAt: event.at,
        ordinal: index,
      });
    }
  }

  private insertAudit(event: AuditRecord): void {
    this.database
      .prepare(
        `INSERT INTO audit_events(
          plan_id, event_id, event_type, occurred_at, ordinal
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        event.planId,
        event.eventId,
        event.type,
        event.occurredAt,
        event.ordinal,
      );
  }
}

interface SqliteAuditRow {
  readonly plan_id: string;
  readonly event_id: string;
  readonly event_type: AuditRecord['type'];
  readonly occurred_at: number;
  readonly ordinal: number;
}

interface SqliteCommandRow {
  readonly plan_id: string;
  readonly command_key: string;
  readonly processed_at: number;
}

function mapAuditRow(row: SqliteAuditRow): AuditRecord {
  return {
    planId: row.plan_id,
    eventId: row.event_id,
    type: row.event_type,
    occurredAt: Number(row.occurred_at),
    ordinal: Number(row.ordinal),
  };
}

function mapCommandRow(row: SqliteCommandRow): ProcessedCommandRecord {
  return {
    planId: row.plan_id,
    commandKey: row.command_key,
    processedAt: Number(row.processed_at),
  };
}

function parseState(json: string): PlanState {
  return JSON.parse(json) as PlanState;
}
