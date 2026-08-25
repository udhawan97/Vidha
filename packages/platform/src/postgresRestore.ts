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

  const recoveryRows = await client.query<{
    accepted_at: string | null;
    attempt_id: string;
    cancelled_at: string | null;
    consumed_at: string | null;
    expires_at: string;
    failures: number;
    locked_until: string | null;
    owner_id: string;
  }>(
    `SELECT attempt_id, owner_id, expires_at, failures, locked_until,
      accepted_at, cancelled_at, consumed_at
     FROM recovery_proof_attempts ORDER BY attempt_id`,
  );
  for (const recovery of recoveryRows.rows) {
    const expiresAt = optionalSafeInteger(recovery.expires_at);
    const lockedUntil = optionalSafeInteger(recovery.locked_until);
    const acceptedAt = optionalSafeInteger(recovery.accepted_at);
    const consumedAt = optionalSafeInteger(recovery.consumed_at);
    if (
      !/^recovery_[a-f0-9]{64}$/u.test(recovery.attempt_id) ||
      !/^owner_[a-f0-9]{64}$/u.test(recovery.owner_id) ||
      expiresAt === false ||
      expiresAt === null ||
      expiresAt <= 0 ||
      !Number.isSafeInteger(recovery.failures) ||
      recovery.failures < 0 ||
      lockedUntil === false ||
      (lockedUntil !== null && recovery.failures === 0) ||
      acceptedAt === false ||
      consumedAt === false ||
      (acceptedAt !== null && acceptedAt > expiresAt) ||
      (consumedAt !== null && consumedAt > expiresAt) ||
      (recovery.consumed_at !== null && recovery.accepted_at === null) ||
      (recovery.cancelled_at !== null && recovery.consumed_at !== null) ||
      !validRecoveryTimes(recovery)
    ) {
      invalid('A restored recovery proof attempt is invalid.');
    }
  }
  const recoveryFactors = await client.query<{
    attempt_id: string;
    factor: string;
    failures: number;
    proof_digest: string;
  }>(
    `SELECT attempt_id, factor, proof_digest, failures FROM recovery_proof_factors
     ORDER BY attempt_id, factor`,
  );
  const factorsByAttempt = new Map<string, Map<string, number>>();
  for (const factor of recoveryFactors.rows) {
    if (
      !/^recovery_[a-f0-9]{64}$/u.test(factor.attempt_id) ||
      !['issued_channel', 'saved_code'].includes(factor.factor) ||
      !/^[a-f0-9]{64}$/u.test(factor.proof_digest) ||
      !Number.isSafeInteger(factor.failures) ||
      factor.failures < 0
    ) {
      invalid('A restored recovery proof factor is invalid.');
    }
    const factors = factorsByAttempt.get(factor.attempt_id) ?? new Map();
    factors.set(factor.factor, factor.failures);
    factorsByAttempt.set(factor.attempt_id, factors);
  }
  for (const recovery of recoveryRows.rows) {
    const factors = factorsByAttempt.get(recovery.attempt_id);
    const factorFailures = [...(factors?.values() ?? [])];
    const failureSum = factorFailures.reduce(
      (sum, failures) => sum + failures,
      0,
    );
    if (
      (recovery.failures > 0 && factors?.size !== 2) ||
      factorFailures.some((failures) => failures > recovery.failures) ||
      failureSum < recovery.failures ||
      failureSum > recovery.failures * 2
    ) {
      invalid('Restored recovery proof failure counters are inconsistent.');
    }
  }
  if (
    recoveryRows.rows.some((recovery) => {
      const factors = factorsByAttempt.get(recovery.attempt_id);
      return (
        recovery.accepted_at !== null &&
        (factors?.size !== 2 ||
          !factors.has('saved_code') ||
          !factors.has('issued_channel'))
      );
    })
  ) {
    invalid('An accepted recovery attempt lacks independent factors.');
  }

  const identityRows = await client.query<{
    owner_id: string;
    state_json: unknown;
  }>(
    'SELECT owner_id, state_json FROM owner_identity_states ORDER BY owner_id',
  );
  const pendingRecoveryOwners = new Map<string, string>();
  const attemptsById = new Map(
    recoveryRows.rows.map((recovery) => [recovery.attempt_id, recovery]),
  );
  for (const identity of identityRows.rows) {
    const pending = restoredRecoveryReference(identity);
    if (pending === null) continue;
    if (pendingRecoveryOwners.has(pending.attemptId)) {
      invalid('A restored recovery attempt is referenced more than once.');
    }
    const attempt = attemptsById.get(pending.attemptId);
    const factors = factorsByAttempt.get(pending.attemptId);
    if (
      attempt === undefined ||
      attempt.owner_id !== pending.ownerId ||
      Number(attempt.expires_at) < pending.readyAt ||
      attempt.accepted_at === null ||
      attempt.cancelled_at !== null ||
      attempt.consumed_at !== null ||
      factors?.size !== 2 ||
      !factors.has('saved_code') ||
      !factors.has('issued_channel')
    ) {
      invalid(
        'A restored pending Owner recovery lacks its accepted proof attempt.',
      );
    }
    pendingRecoveryOwners.set(pending.attemptId, pending.ownerId);
  }
  if (
    recoveryRows.rows.some(
      (attempt) =>
        attempt.accepted_at !== null &&
        attempt.cancelled_at === null &&
        attempt.consumed_at === null &&
        pendingRecoveryOwners.get(attempt.attempt_id) !== attempt.owner_id,
    )
  ) {
    invalid('An active restored recovery attempt lacks its Owner state.');
  }

  const counts = await client.query<Record<string, string>>(`
    SELECT
      (SELECT COUNT(*)::text FROM plans) AS plans,
      (SELECT COUNT(*)::text FROM processed_commands) AS processed_commands,
      (SELECT COUNT(*)::text FROM audit_events) AS audit_events,
      (SELECT COUNT(*)::text FROM encrypted_metadata) AS encrypted_metadata,
      (SELECT COUNT(*)::text FROM safety_jobs) AS safety_jobs,
      (SELECT COUNT(*)::text FROM metadata_key_rotations) AS key_rotations,
      (SELECT COUNT(*)::text FROM recovery_proof_attempts) AS recovery_proof_attempts,
      (SELECT COUNT(*)::text FROM recovery_proof_factors) AS recovery_proof_factors
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

function validRecoveryTimes(input: {
  readonly accepted_at: string | null;
  readonly cancelled_at: string | null;
  readonly consumed_at: string | null;
}): boolean {
  const acceptedAt = optionalSafeInteger(input.accepted_at);
  const cancelledAt = optionalSafeInteger(input.cancelled_at);
  const consumedAt = optionalSafeInteger(input.consumed_at);
  if (acceptedAt === false || cancelledAt === false || consumedAt === false) {
    return false;
  }
  return (
    (consumedAt === null ||
      (acceptedAt !== null && consumedAt >= acceptedAt)) &&
    (cancelledAt === null || acceptedAt === null || cancelledAt >= acceptedAt)
  );
}

function restoredRecoveryReference(input: {
  readonly owner_id: string;
  readonly state_json: unknown;
}): {
  readonly attemptId: string;
  readonly ownerId: string;
  readonly readyAt: number;
} | null {
  if (
    typeof input.state_json !== 'object' ||
    input.state_json === null ||
    !('ownerId' in input.state_json) ||
    input.state_json.ownerId !== input.owner_id ||
    !/^owner_[a-f0-9]{64}$/u.test(input.owner_id) ||
    !('recovery' in input.state_json)
  ) {
    invalid('A restored Owner Identity state is invalid.');
  }
  const recovery = input.state_json.recovery;
  if (recovery === null) return null;
  if (
    typeof recovery !== 'object' ||
    !('attemptId' in recovery) ||
    typeof recovery.attemptId !== 'string' ||
    !/^recovery_[a-f0-9]{64}$/u.test(recovery.attemptId) ||
    !('startedAt' in recovery) ||
    !Number.isSafeInteger(recovery.startedAt) ||
    Number(recovery.startedAt) < 0 ||
    !('readyAt' in recovery) ||
    !Number.isSafeInteger(recovery.readyAt) ||
    Number(recovery.readyAt) < Number(recovery.startedAt)
  ) {
    invalid('A restored pending Owner recovery is invalid.');
  }
  return {
    attemptId: recovery.attemptId,
    ownerId: input.owner_id,
    readyAt: Number(recovery.readyAt),
  };
}

function optionalSafeInteger(value: string | null): number | null | false {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : false;
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
