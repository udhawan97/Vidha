import { createHash } from 'node:crypto';

import {
  OperationsError,
  assertLive,
  validateEncryptedRecord,
  type EncryptedMetadataRecord,
  type MetadataKeyProvider,
  type StoreMode,
  type WrappedMetadataCipher,
} from '@vidha/operations';
import { Pool, type PoolClient } from 'pg';

export const KEY_ROTATION_BOUNDARIES = [
  'after_selection',
  'after_first_write',
  'before_commit',
  'after_commit',
] as const;

export type KeyRotationBoundary = (typeof KEY_ROTATION_BOUNDARIES)[number];

export interface KeyRotationReport {
  readonly completedAt: number;
  readonly duplicate: boolean;
  readonly recordSetDigest: string;
  readonly requestDigest: string;
  readonly rotatedRecords: number;
  readonly rotationId: string;
  readonly sourceKeyVersions: readonly string[];
  readonly targetKeyVersion: string;
  readonly targetProviderId: string;
}

export interface KeyRotationInput {
  readonly at: number;
  readonly rotationId: string;
  readonly sourceCipher: WrappedMetadataCipher;
  readonly targetProvider: MetadataKeyProvider;
}

type KeyRotationObserver = (
  boundary: KeyRotationBoundary,
  client: PoolClient,
) => Promise<void>;

export class PostgresKeyRotationStore {
  constructor(
    private readonly pool: Pool,
    readonly mode: StoreMode = 'live',
  ) {}

  async rotate(
    input: KeyRotationInput,
    observe: KeyRotationObserver = async () => undefined,
  ): Promise<KeyRotationReport> {
    assertLive(this.mode);
    validateInput(input);
    const requestDigest = sha256(
      JSON.stringify({
        rotationId: input.rotationId,
        targetKeyVersion: input.targetProvider.currentKeyVersion,
        targetProviderId: input.targetProvider.providerId,
      }),
    );
    const client = await this.pool.connect();
    let discard = false;
    try {
      await client.query('BEGIN');
      await assertDatabaseMode(client, this.mode);
      const prior = await client.query<{ report_json: unknown }>(
        `SELECT report_json FROM metadata_key_rotations
         WHERE rotation_id = $1 FOR UPDATE`,
        [input.rotationId],
      );
      if (prior.rows[0] !== undefined) {
        const report = parseReport(prior.rows[0].report_json);
        if (report.requestDigest !== requestDigest) conflict();
        await client.query('COMMIT');
        return { ...report, duplicate: true };
      }

      const rows = await client.query<{
        record_id: string;
        state_json: unknown;
      }>(
        `SELECT record_id, state_json FROM encrypted_metadata
         ORDER BY record_id FOR UPDATE`,
      );
      const records = rows.rows.map((row) => parseRecord(row.state_json));
      const candidates = records.filter(
        (record) =>
          record.keyProviderId !== input.targetProvider.providerId ||
          record.keyVersion !== input.targetProvider.currentKeyVersion,
      );
      if (candidates.length === 0) {
        throw new OperationsError(
          'INVALID_INPUT',
          'Metadata key rotation requires at least one source record.',
        );
      }
      await observe('after_selection', client);

      const sourceKeyVersions = [
        ...new Set(
          candidates.map(
            (record) =>
              `${record.keyProviderId ?? 'direct'}:${record.keyVersion}`,
          ),
        ),
      ].sort();
      const digestEntries: {
        readonly ciphertextDigest: string;
        readonly recordId: string;
        readonly sourceKeyVersion: string;
      }[] = [];
      for (const [index, record] of candidates.entries()) {
        const rotated = await input.sourceCipher.rewrap(
          record,
          input.targetProvider,
        );
        validateRotation(record, rotated, input.targetProvider);
        await client.query(
          `UPDATE encrypted_metadata SET state_json = $2
           WHERE record_id = $1`,
          [record.recordId, JSON.stringify(rotated)],
        );
        digestEntries.push({
          ciphertextDigest: sha256(record.ciphertext),
          recordId: record.recordId,
          sourceKeyVersion: `${record.keyProviderId ?? 'direct'}:${record.keyVersion}`,
        });
        if (index === 0) await observe('after_first_write', client);
      }
      const report: KeyRotationReport = {
        completedAt: input.at,
        duplicate: false,
        recordSetDigest: sha256(JSON.stringify(digestEntries)),
        requestDigest,
        rotatedRecords: candidates.length,
        rotationId: input.rotationId,
        sourceKeyVersions,
        targetKeyVersion: input.targetProvider.currentKeyVersion,
        targetProviderId: input.targetProvider.providerId,
      };
      await client.query(
        `INSERT INTO metadata_key_rotations(
          rotation_id, request_digest, target_provider_id, target_key_version,
          rotated_records, record_set_digest, completed_at, report_json
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          report.rotationId,
          report.requestDigest,
          report.targetProviderId,
          report.targetKeyVersion,
          report.rotatedRecords,
          report.recordSetDigest,
          report.completedAt,
          JSON.stringify(report),
        ],
      );
      await observe('before_commit', client);
      await client.query('COMMIT');
      await observe('after_commit', client);
      return report;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        discard = true;
      }
      throw error;
    } finally {
      client.release(discard);
    }
  }

  async history(): Promise<readonly KeyRotationReport[]> {
    const result = await this.pool.query<{ report_json: unknown }>(
      `SELECT report_json FROM metadata_key_rotations
       ORDER BY completed_at, rotation_id`,
    );
    return result.rows.map((row) => parseReport(row.report_json));
  }
}

function validateInput(input: KeyRotationInput): void {
  if (
    !/^rotation_[a-f0-9]{64}$/u.test(input.rotationId) ||
    !Number.isSafeInteger(input.at) ||
    input.at < 0 ||
    !/^[a-z][a-z0-9_-]{2,63}$/u.test(input.targetProvider.providerId) ||
    !/^key_[a-z0-9_-]{1,32}$/u.test(input.targetProvider.currentKeyVersion)
  ) {
    throw new OperationsError(
      'INVALID_INPUT',
      'The metadata key-rotation request is invalid.',
    );
  }
}

function validateRotation(
  source: EncryptedMetadataRecord,
  target: EncryptedMetadataRecord,
  provider: MetadataKeyProvider,
): void {
  validateEncryptedRecord(target);
  if (
    target.recordId !== source.recordId ||
    target.schemaVersion !== source.schemaVersion ||
    target.initializationVector !== source.initializationVector ||
    target.ciphertext !== source.ciphertext ||
    target.retainUntil !== source.retainUntil ||
    target.updatedAt !== source.updatedAt ||
    target.keyProviderId !== provider.providerId ||
    target.keyVersion !== provider.currentKeyVersion ||
    target.wrappedDataKey === source.wrappedDataKey
  ) {
    throw new OperationsError(
      'INVALID_SNAPSHOT',
      'Metadata key rotation changed record content or missed its target.',
    );
  }
}

function parseRecord(value: unknown): EncryptedMetadataRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalidSnapshot('PostgreSQL encrypted metadata is malformed.');
  }
  const record = value as EncryptedMetadataRecord;
  validateEncryptedRecord(record);
  return structuredClone(record);
}

function parseReport(value: unknown): KeyRotationReport {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalidSnapshot('PostgreSQL key-rotation history is malformed.');
  }
  const report = value as KeyRotationReport;
  if (
    !/^rotation_[a-f0-9]{64}$/u.test(report.rotationId) ||
    !/^[a-f0-9]{64}$/u.test(report.requestDigest) ||
    !/^[a-f0-9]{64}$/u.test(report.recordSetDigest) ||
    !Number.isSafeInteger(report.rotatedRecords) ||
    report.rotatedRecords <= 0 ||
    !Number.isSafeInteger(report.completedAt) ||
    report.completedAt < 0 ||
    !Array.isArray(report.sourceKeyVersions) ||
    report.sourceKeyVersions.length === 0 ||
    report.sourceKeyVersions.some(
      (version) =>
        !/^(?:[a-z][a-z0-9_-]{2,63}|direct):key_[a-z0-9_-]{1,32}$/u.test(
          version,
        ),
    ) ||
    !/^[a-z][a-z0-9_-]{2,63}$/u.test(report.targetProviderId) ||
    !/^key_[a-z0-9_-]{1,32}$/u.test(report.targetKeyVersion)
  ) {
    invalidSnapshot('PostgreSQL key-rotation history is malformed.');
  }
  return structuredClone(report);
}

async function assertDatabaseMode(
  client: PoolClient,
  mode: StoreMode,
): Promise<void> {
  const result = await client.query<{ mode: StoreMode }>(
    'SELECT mode FROM runtime_configuration WHERE singleton',
  );
  if (result.rows[0]?.mode !== mode) {
    throw new OperationsError(
      'INVALID_CONFIGURATION',
      'The PostgreSQL key-rotation mode does not match the runtime.',
    );
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function conflict(): never {
  throw new OperationsError(
    'IDEMPOTENCY_CONFLICT',
    'The metadata key-rotation identifier has conflicting semantics.',
  );
}

function invalidSnapshot(message: string): never {
  throw new OperationsError('INVALID_SNAPSHOT', message);
}
