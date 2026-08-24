import { createHash } from 'node:crypto';

import {
  OPERATIONS_SCHEMA_VERSION,
  assertOperationsSnapshot,
  OperationsError,
  type EncryptedMetadataRecord,
  type SafetyJob,
} from '@vidha/operations';
import type { DomainEventType, PlanState } from '@vidha/domain';
import {
  PLAN_STORE_SCHEMA_VERSION,
  assertSnapshot as assertPlanSnapshot,
  type AuditRecord,
  type ProcessedCommandRecord,
} from '@vidha/persistence';
import { Pool, type PoolClient } from 'pg';

import { PLATFORM_SCHEMA_VERSION, platformMigrations } from './migrations';

export interface RestoreInvariantReport {
  readonly databaseMajor: number;
  readonly environmentId: string;
  readonly installationId: string;
  readonly keyVersions: readonly string[];
  readonly migrationDigest: string;
  readonly mode: 'restore_safe';
  readonly reportDigest: string;
  readonly schemaVersion: number;
  readonly tableCounts: Readonly<Record<string, number>>;
}

export interface RestoreExpectation {
  readonly environmentId: string;
  readonly installationId: string;
}

export interface RestorePromotionReport {
  readonly duplicate: boolean;
  readonly promotedAt: number;
  readonly promotionId: string;
  readonly reportDigest: string;
}

export async function inspectPostgresRestore(
  pool: Pool,
  expected: RestoreExpectation,
): Promise<RestoreInvariantReport> {
  const client = await pool.connect();
  try {
    return await inspect(client, expected);
  } finally {
    client.release();
  }
}

export async function promotePostgresRestore(
  pool: Pool,
  input: RestoreExpectation & {
    readonly at: number;
    readonly promotionId: string;
    readonly reportDigest: string;
  },
): Promise<RestorePromotionReport> {
  validatePromotionInput(input);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [0x52455354]);
    const existing = await client.query<{
      promoted_at: string;
      report_digest: string;
    }>(
      `SELECT report_digest, promoted_at FROM restore_promotions
       WHERE promotion_id = $1`,
      [input.promotionId],
    );
    const prior = existing.rows[0];
    if (prior !== undefined) {
      if (prior.report_digest !== input.reportDigest) conflict();
      await client.query('COMMIT');
      return {
        duplicate: true,
        promotedAt: Number(prior.promoted_at),
        promotionId: input.promotionId,
        reportDigest: prior.report_digest,
      };
    }
    const report = await inspect(client, input);
    if (report.reportDigest !== input.reportDigest) {
      throw new OperationsError(
        'INVALID_SNAPSHOT',
        'The restore changed after its invariant report was accepted.',
      );
    }
    await client.query(
      `INSERT INTO restore_promotions(promotion_id, report_digest, promoted_at)
       VALUES ($1, $2, $3)`,
      [input.promotionId, input.reportDigest, input.at],
    );
    const updated = await client.query(
      `UPDATE runtime_configuration
       SET mode = 'live', promoted_at = $1
       WHERE singleton AND mode = 'restore_safe'
       RETURNING singleton`,
      [input.at],
    );
    if (updated.rowCount !== 1) {
      throw new OperationsError(
        'INVALID_CONFIGURATION',
        'Restore promotion requires an inspected restore-safe database.',
      );
    }
    await client.query('COMMIT');
    return {
      duplicate: false,
      promotedAt: input.at,
      promotionId: input.promotionId,
      reportDigest: input.reportDigest,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function inspect(
  client: PoolClient,
  expected: RestoreExpectation,
): Promise<RestoreInvariantReport> {
  validateOpaque(expected.environmentId, 'environment');
  validateOpaque(expected.installationId, 'installation');
  const runtime = await client.query<{
    environment_id: string;
    installation_id: string;
    major: string;
    mode: string;
    schema_version: number;
  }>(`
    SELECT
      current_setting('server_version_num')::integer / 10000 AS major,
      environment_id,
      installation_id,
      mode,
      (SELECT MAX(version) FROM vidha_migrations) AS schema_version
    FROM runtime_configuration WHERE singleton
  `);
  const row = runtime.rows[0];
  if (
    row === undefined ||
    Number(row.major) !== 18 ||
    row.environment_id !== expected.environmentId ||
    row.installation_id !== expected.installationId ||
    row.mode !== 'restore_safe' ||
    Number(row.schema_version) !== PLATFORM_SCHEMA_VERSION
  ) {
    invalid(
      'The restored PostgreSQL runtime identity or safe mode is invalid.',
    );
  }

  const migrations = await client.query<{
    checksum: string;
    name: string;
    version: number;
  }>('SELECT version, name, checksum FROM vidha_migrations ORDER BY version');
  const expectedMigrations = platformMigrations.map((migration) => ({
    checksum: sha256(migration.sql),
    name: migration.name,
    version: migration.version,
  }));
  const restoredMigrations = migrations.rows.map((migration) => ({
    checksum: migration.checksum,
    name: migration.name,
    version: Number(migration.version),
  }));
  if (
    JSON.stringify(restoredMigrations) !== JSON.stringify(expectedMigrations)
  ) {
    invalid('The restored PostgreSQL migration ledger is invalid.');
  }

  const planRows = await client.query<{ state_json: unknown }>(
    'SELECT state_json FROM plans ORDER BY plan_id',
  );
  const commandRows = await client.query<{
    command_fingerprint: string;
    command_key: string;
    plan_id: string;
    processed_at: string;
  }>(
    `SELECT plan_id, command_key, command_fingerprint, processed_at
     FROM processed_commands ORDER BY plan_id, command_key`,
  );
  const auditRows = await client.query<{
    event_id: string;
    event_type: DomainEventType;
    occurred_at: string;
    ordinal: number;
    plan_id: string;
  }>(
    `SELECT plan_id, event_id, event_type, occurred_at, ordinal
     FROM audit_events ORDER BY plan_id, ordinal`,
  );
  const planSnapshot = {
    auditEvents: auditRows.rows.map((event): AuditRecord => ({
      eventId: event.event_id,
      occurredAt: Number(event.occurred_at),
      ordinal: Number(event.ordinal),
      planId: event.plan_id,
      type: event.event_type,
    })),
    plans: planRows.rows.map((plan) => plan.state_json as PlanState),
    processedCommands: commandRows.rows.map(
      (command): ProcessedCommandRecord => ({
        commandFingerprint: command.command_fingerprint,
        commandKey: command.command_key,
        planId: command.plan_id,
        processedAt: Number(command.processed_at),
      }),
    ),
    schemaVersion: PLAN_STORE_SCHEMA_VERSION,
  };
  assertPlanSnapshot(planSnapshot);
  const metadataRows = await client.query<{ state_json: unknown }>(
    'SELECT state_json FROM encrypted_metadata ORDER BY record_id',
  );
  const jobRows = await client.query<{ state_json: unknown }>(
    'SELECT state_json FROM safety_jobs ORDER BY job_id',
  );
  const operationsSnapshot = {
    jobs: jobRows.rows.map((job) => job.state_json as SafetyJob),
    metadata: metadataRows.rows.map(
      (record) => record.state_json as EncryptedMetadataRecord,
    ),
    schemaVersion: OPERATIONS_SCHEMA_VERSION,
  };
  assertOperationsSnapshot(operationsSnapshot);

  const counts = await client.query<Record<string, string>>(`
    SELECT
      (SELECT COUNT(*)::text FROM plans) AS plans,
      (SELECT COUNT(*)::text FROM processed_commands) AS processed_commands,
      (SELECT COUNT(*)::text FROM audit_events) AS audit_events,
      (SELECT COUNT(*)::text FROM encrypted_metadata) AS encrypted_metadata,
      (SELECT COUNT(*)::text FROM safety_jobs) AS safety_jobs,
      (SELECT COUNT(*)::text FROM metadata_key_rotations) AS key_rotations
  `);
  const countRow = counts.rows[0];
  if (countRow === undefined) invalid('Restore invariant counts are absent.');
  const tableCounts = Object.fromEntries(
    Object.entries(countRow).map(([name, value]) => [name, Number(value)]),
  );
  if (
    Object.values(tableCounts).some(
      (value) => !Number.isSafeInteger(value) || value < 0,
    )
  ) {
    invalid('Restore invariant counts are invalid.');
  }
  const keyVersions = [
    ...new Set(operationsSnapshot.metadata.map((record) => record.keyVersion)),
  ].sort();
  const facts = {
    databaseMajor: Number(row.major),
    environmentId: row.environment_id,
    installationId: row.installation_id,
    keyVersions,
    migrationDigest: sha256(JSON.stringify(expectedMigrations)),
    mode: 'restore_safe' as const,
    schemaVersion: Number(row.schema_version),
    tableCounts,
  };
  return { ...facts, reportDigest: sha256(JSON.stringify(facts)) };
}

function validatePromotionInput(
  input: RestoreExpectation & {
    readonly at: number;
    readonly promotionId: string;
    readonly reportDigest: string;
  },
): void {
  validateOpaque(input.environmentId, 'environment');
  validateOpaque(input.installationId, 'installation');
  if (
    !Number.isSafeInteger(input.at) ||
    input.at < 0 ||
    !/^promotion_[a-f0-9]{64}$/u.test(input.promotionId) ||
    !/^[a-f0-9]{64}$/u.test(input.reportDigest)
  ) {
    throw new OperationsError(
      'INVALID_INPUT',
      'The restore-promotion request is invalid.',
    );
  }
}

function validateOpaque(value: string, prefix: string): void {
  if (!new RegExp(`^${prefix}_[a-f0-9]{64}$`, 'u').test(value)) {
    throw new OperationsError(
      'INVALID_INPUT',
      `The ${prefix} identifier is invalid.`,
    );
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function conflict(): never {
  throw new OperationsError(
    'IDEMPOTENCY_CONFLICT',
    'The restore-promotion identifier has conflicting semantics.',
  );
}

function invalid(message: string): never {
  throw new OperationsError('INVALID_SNAPSHOT', message);
}
