import { createHash } from 'node:crypto';

import {
  IdentityError,
  type OwnerIdentityRepository,
  type OwnerIdentityRepositoryTransaction,
  type OwnerIdentityState,
  type WebAuthnAssertionProof,
  type WebAuthnCeremonyRecord,
  type WebAuthnCredentialRecord,
  type WebAuthnStateStore,
} from '@vidha/identity';
import { Pool, type PoolClient } from 'pg';

import { PLATFORM_SCHEMA_VERSION, platformMigrations } from './migrations';
import { PostgresOperationsStore } from './postgresOperations';
import { PostgresPlanStore, type PlanOutboxPlanner } from './postgresPlan';

export type PlatformMode = 'live' | 'restore_safe';

export const MIGRATION_REHEARSAL_BOUNDARIES = [
  'after_advisory_lock',
  'after_migration_ledger',
  'after_migration_sql',
  'after_migration_record',
  'before_commit',
  'after_commit',
] as const;

export type MigrationRehearsalBoundary =
  (typeof MIGRATION_REHEARSAL_BOUNDARIES)[number];

export interface MigrationRehearsalReport {
  readonly interruptedBoundaries: readonly MigrationRehearsalBoundary[];
  readonly postCommitReplayVerified: boolean;
  readonly rollbackVerified: boolean;
  readonly schemaVersion: number;
}

export interface RecoveryProofStore {
  issue(input: {
    readonly attemptId: string;
    readonly expiresAt: number;
    readonly issuedChannelProof: string;
    readonly ownerId: string;
    readonly savedCodeProof: string;
  }): Promise<void>;
  consumePair(input: {
    readonly at: number;
    readonly attemptId: string;
    readonly issuedChannelProof: string;
    readonly lockMs: number;
    readonly maxFailures: number;
    readonly ownerId: string;
    readonly savedCodeProof: string;
  }): Promise<boolean>;
}

export interface PostgresPlatform {
  readonly operationsStore: PostgresOperationsStore;
  readonly identityRepository: OwnerIdentityRepository;
  readonly mode: PlatformMode;
  readonly pool: Pool;
  readonly recoveryProofStore: RecoveryProofStore;
  readonly webAuthnStore: WebAuthnStateStore;
  close(): Promise<void>;
  createPlanStore(planOutbox?: PlanOutboxPlanner): PostgresPlanStore;
  readiness(): Promise<{
    readonly databaseMajor: number;
    readonly mode: PlatformMode;
    readonly schemaVersion: number;
  }>;
}

export interface CreatePostgresPlatformInput {
  readonly connectionString: string;
  readonly environmentId: string;
  readonly installationId: string;
  readonly manageSchema?: boolean;
  readonly mode: PlatformMode;
  readonly onPoolError?: (error: Error) => void;
  readonly poolSize?: number;
}

export async function createPostgresPlatform(
  input: CreatePostgresPlatformInput,
): Promise<PostgresPlatform> {
  validateOpaque(input.environmentId, 'environment');
  validateOpaque(input.installationId, 'installation');
  const pool = new Pool({
    connectionString: input.connectionString,
    max: input.poolSize ?? 10,
    application_name: `vidha-${input.mode}`,
  });
  pool.on('error', input.onPoolError ?? (() => undefined));
  try {
    if (input.manageSchema ?? true) {
      await applyMigrations(pool);
      await configureRuntime(pool, input);
    } else {
      await verifyRuntimeConfiguration(pool, input);
    }
    const assertLive = () => {
      if (input.mode === 'restore_safe') {
        throw new IdentityError(
          'INVALID_COMMAND',
          'Restore-safe mode rejects identity, ceremony, and recovery mutations.',
        );
      }
    };
    return {
      identityRepository: new PostgresOwnerIdentityRepository(pool, assertLive),
      mode: input.mode,
      operationsStore: new PostgresOperationsStore(pool, input.mode),
      pool,
      recoveryProofStore: new PostgresRecoveryProofStore(pool, assertLive),
      webAuthnStore: new PostgresWebAuthnStateStore(pool, assertLive),
      async close() {
        await pool.end();
      },
      createPlanStore(planOutbox = () => []) {
        return new PostgresPlanStore(pool, input.mode, planOutbox);
      },
      async readiness() {
        const result = await pool.query<{
          major: string;
          mode: PlatformMode;
          schema_version: number;
        }>(`
          SELECT
            current_setting('server_version_num')::integer / 10000 AS major,
            (SELECT mode FROM runtime_configuration WHERE singleton) AS mode,
            (SELECT MAX(version) FROM vidha_migrations) AS schema_version
        `);
        const row = result.rows[0];
        if (
          row === undefined ||
          Number(row.major) !== 18 ||
          Number(row.schema_version) !== PLATFORM_SCHEMA_VERSION ||
          row.mode !== input.mode
        ) {
          throw new Error('The disposable PostgreSQL runtime is not ready.');
        }
        return {
          databaseMajor: Number(row.major),
          mode: row.mode,
          schemaVersion: Number(row.schema_version),
        };
      },
    };
  } catch (error) {
    await pool.end();
    throw error;
  }
}

async function verifyRuntimeConfiguration(
  pool: Pool,
  input: CreatePostgresPlatformInput,
): Promise<void> {
  const result = await pool.query<{
    environment_id: string;
    installation_id: string;
    mode: PlatformMode;
    schema_version: number;
  }>(`
    SELECT
      runtime_configuration.environment_id,
      runtime_configuration.installation_id,
      runtime_configuration.mode,
      (SELECT MAX(version) FROM vidha_migrations) AS schema_version
    FROM runtime_configuration WHERE singleton
  `);
  const row = result.rows[0];
  if (
    row === undefined ||
    row.environment_id !== input.environmentId ||
    row.installation_id !== input.installationId ||
    row.mode !== input.mode ||
    Number(row.schema_version) !== PLATFORM_SCHEMA_VERSION
  ) {
    throw new Error(
      'The PostgreSQL runtime configuration does not match startup.',
    );
  }
}

export async function applyMigrations(pool: Pool): Promise<void> {
  await applyMigrationsTransaction(pool);
}

export async function rehearseMigrationInterruptions(
  migrationPool: Pool,
  controlPool: Pool,
): Promise<MigrationRehearsalReport> {
  const existing = await migrationPool.query<{
    migration_ledger: string | null;
  }>("SELECT to_regclass('public.vidha_migrations')::text AS migration_ledger");
  if (existing.rows[0]?.migration_ledger !== null) {
    throw new Error(
      'Migration interruption rehearsal requires an empty disposable database.',
    );
  }
  const identity = await migrationPool.query<{
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
    expected.application_name !== 'vidha-topology-migrator'
  ) {
    throw new Error(
      'Migration rehearsal requires its isolated application ID.',
    );
  }

  const interruptedBoundaries: MigrationRehearsalBoundary[] = [];
  for (const target of MIGRATION_REHEARSAL_BOUNDARIES) {
    let terminated = false;
    try {
      await applyMigrationsTransaction(
        migrationPool,
        async (boundary, backendPid) => {
          if (boundary !== target) return;
          const result = await controlPool.query<{ terminated: boolean }>(
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
              `PostgreSQL did not terminate the migrator at ${target}.`,
            );
          }
          terminated = true;
          throw new Error(`Injected migration interruption at ${target}.`);
        },
      );
    } catch {
      if (!terminated) {
        throw new Error(
          `Migration interruption did not reach the ${target} boundary.`,
        );
      }
    }
    if (!terminated) {
      throw new Error(
        `Migration interruption unexpectedly committed at ${target}.`,
      );
    }
    if (target === 'after_commit') {
      const committed = await migrationPool.query<{ schema_version: number }>(
        'SELECT MAX(version)::integer AS schema_version FROM vidha_migrations',
      );
      if (
        Number(committed.rows[0]?.schema_version) !== PLATFORM_SCHEMA_VERSION
      ) {
        throw new Error('Committed migration disappeared after a lost ack.');
      }
    } else {
      const rolledBack = await migrationPool.query<{
        migration_ledger: string | null;
      }>(
        "SELECT to_regclass('public.vidha_migrations')::text AS migration_ledger",
      );
      if (rolledBack.rows[0]?.migration_ledger !== null) {
        throw new Error(
          `Migration interruption left schema state behind at ${target}.`,
        );
      }
    }
    interruptedBoundaries.push(target);
  }

  await applyMigrations(migrationPool);
  const applied = await migrationPool.query<{ schema_version: number }>(
    'SELECT MAX(version)::integer AS schema_version FROM vidha_migrations',
  );
  if (Number(applied.rows[0]?.schema_version) !== PLATFORM_SCHEMA_VERSION) {
    throw new Error('Migration restart did not reach the expected schema.');
  }
  return {
    interruptedBoundaries,
    postCommitReplayVerified: true,
    rollbackVerified: true,
    schemaVersion: PLATFORM_SCHEMA_VERSION,
  };
}

type MigrationObserver = (
  boundary: MigrationRehearsalBoundary,
  backendPid: number,
) => Promise<void>;

async function applyMigrationsTransaction(
  pool: Pool,
  observe: MigrationObserver = async () => undefined,
): Promise<void> {
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [0x56494448]);
    const backend = await client.query<{ backend_pid: number }>(
      'SELECT pg_backend_pid() AS backend_pid',
    );
    const backendPid = Number(backend.rows[0]?.backend_pid);
    if (!Number.isSafeInteger(backendPid)) {
      throw new Error('PostgreSQL did not report a migrator backend PID.');
    }
    await observe('after_advisory_lock', backendPid);
    await client.query(`
      CREATE TABLE IF NOT EXISTS vidha_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        checksum TEXT NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
        applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
      )
    `);
    await observe('after_migration_ledger', backendPid);
    for (const migration of platformMigrations) {
      const checksum = sha256(migration.sql);
      const existing = await client.query<{ checksum: string; name: string }>(
        'SELECT name, checksum FROM vidha_migrations WHERE version = $1',
        [migration.version],
      );
      const row = existing.rows[0];
      if (row !== undefined) {
        if (row.name !== migration.name || row.checksum !== checksum) {
          throw new Error(
            `PostgreSQL migration ${migration.version} checksum mismatch.`,
          );
        }
        continue;
      }
      await client.query(migration.sql);
      await observe('after_migration_sql', backendPid);
      await client.query(
        'INSERT INTO vidha_migrations(version, name, checksum) VALUES ($1, $2, $3)',
        [migration.version, migration.name, checksum],
      );
      await observe('after_migration_record', backendPid);
    }
    await observe('before_commit', backendPid);
    await client.query('COMMIT');
    await observe('after_commit', backendPid);
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      discard = true;
      // A terminated migrator backend already caused PostgreSQL to roll back.
    }
    throw error;
  } finally {
    client.release(discard);
  }
}

class PostgresOwnerIdentityRepository implements OwnerIdentityRepository {
  constructor(
    private readonly pool: Pool,
    private readonly assertLive: () => void,
  ) {}

  async transaction<T>(
    operation: (transaction: OwnerIdentityRepositoryTransaction) => Promise<T>,
  ): Promise<T> {
    this.assertLive();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await client.query('SELECT pg_advisory_xact_lock($1)', [0x4944454e]);
      const rows = await client.query<{
        owner_id: string;
        state_json: unknown;
      }>(
        'SELECT owner_id, state_json FROM owner_identity_states ORDER BY owner_id FOR UPDATE',
      );
      const staged = new Map(
        rows.rows.map((row) => [row.owner_id, parseIdentity(row.state_json)]),
      );
      const written = new Set<string>();
      const transaction: OwnerIdentityRepositoryTransaction = {
        async list() {
          return [...staged.values()].map(cloneIdentity);
        },
        async read(ownerId) {
          const state = staged.get(ownerId);
          return state === undefined ? null : cloneIdentity(state);
        },
        async write(state) {
          staged.set(state.ownerId, cloneIdentity(state));
          written.add(state.ownerId);
        },
      };
      const result = await operation(transaction);
      for (const ownerId of written) {
        const state = staged.get(ownerId);
        if (state === undefined)
          throw new Error('Staged identity disappeared.');
        await client.query(
          `INSERT INTO owner_identity_states(owner_id, security_revision, state_json)
           VALUES ($1, $2, $3)
           ON CONFLICT (owner_id) DO UPDATE SET
             security_revision = EXCLUDED.security_revision,
             state_json = EXCLUDED.state_json,
             updated_at = clock_timestamp()`,
          [state.ownerId, state.securityRevision, JSON.stringify(state)],
        );
      }
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async list(): Promise<readonly OwnerIdentityState[]> {
    const result = await this.pool.query<{ state_json: unknown }>(
      'SELECT state_json FROM owner_identity_states ORDER BY owner_id',
    );
    return result.rows.map((row) => parseIdentity(row.state_json));
  }

  async read(ownerId: string): Promise<OwnerIdentityState | null> {
    const result = await this.pool.query<{ state_json: unknown }>(
      'SELECT state_json FROM owner_identity_states WHERE owner_id = $1',
      [ownerId],
    );
    const row = result.rows[0];
    return row === undefined ? null : parseIdentity(row.state_json);
  }
}

class PostgresWebAuthnStateStore implements WebAuthnStateStore {
  constructor(
    private readonly pool: Pool,
    private readonly assertLive: () => void,
  ) {}

  async countCredentials(): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM webauthn_credentials',
    );
    return Number(result.rows[0]?.count);
  }

  async createCeremony(record: WebAuthnCeremonyRecord): Promise<void> {
    this.assertLive();
    await this.pool.query(
      `INSERT INTO webauthn_ceremonies(
        ceremony_id, owner_id, purpose, challenge_digest,
        configuration_revision, created_at, expires_at, consumed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL)`,
      [
        record.ceremonyId,
        record.ownerId,
        record.purpose,
        record.challengeDigest,
        record.configurationRevision,
        record.createdAt,
        record.expiresAt,
      ],
    );
  }

  async consumeCeremony(input: {
    readonly ceremonyId: string;
    readonly purpose: WebAuthnCeremonyRecord['purpose'];
    readonly at: number;
  }): Promise<WebAuthnCeremonyRecord> {
    this.assertLive();
    const result = await this.pool.query<WebAuthnCeremonyRow>(
      `UPDATE webauthn_ceremonies SET consumed_at = $3
       WHERE ceremony_id = $1 AND purpose = $2 AND consumed_at IS NULL
         AND created_at <= $3 AND expires_at >= $3
       RETURNING *`,
      [input.ceremonyId, input.purpose, input.at],
    );
    const row = result.rows[0];
    if (row === undefined) denied('The WebAuthn ceremony cannot be consumed.');
    return mapCeremony(row);
  }

  async registerCredential(input: {
    readonly credential: WebAuthnCredentialRecord;
    readonly bootstrap: boolean;
  }): Promise<void> {
    this.assertLive();
    await withTransaction(this.pool, async (client) => {
      await client.query('LOCK TABLE webauthn_credentials IN EXCLUSIVE MODE');
      if (input.bootstrap) {
        const count = await client.query<{ count: string }>(
          'SELECT COUNT(*)::text AS count FROM webauthn_credentials',
        );
        if (count.rows[0]?.count !== '0') {
          denied('Disposable bootstrap has already been completed.');
        }
      }
      await client.query(
        `INSERT INTO webauthn_credentials(
          credential_id, webauthn_credential_id, owner_id, public_key,
          counter, transports_json, created_at, revoked_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          input.credential.credentialId,
          input.credential.webauthnCredentialId,
          input.credential.ownerId,
          Buffer.from(input.credential.publicKey),
          input.credential.counter,
          input.credential.transports === undefined
            ? null
            : JSON.stringify(input.credential.transports),
          input.credential.createdAt,
          input.credential.revokedAt,
        ],
      );
    });
  }

  async listCredentials(
    ownerId: string,
  ): Promise<readonly WebAuthnCredentialRecord[]> {
    const result = await this.pool.query<WebAuthnCredentialRow>(
      'SELECT * FROM webauthn_credentials WHERE owner_id = $1 ORDER BY credential_id',
      [ownerId],
    );
    return result.rows.map(mapCredential);
  }

  async readCredentialByWebAuthnId(
    webauthnCredentialId: string,
  ): Promise<WebAuthnCredentialRecord | null> {
    const result = await this.pool.query<WebAuthnCredentialRow>(
      'SELECT * FROM webauthn_credentials WHERE webauthn_credential_id = $1',
      [webauthnCredentialId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapCredential(row);
  }

  async updateCounter(input: {
    readonly credentialId: string;
    readonly expectedCounter: number;
    readonly nextCounter: number;
  }): Promise<void> {
    this.assertLive();
    const result = await this.pool.query(
      `UPDATE webauthn_credentials SET counter = $3
       WHERE credential_id = $1 AND counter = $2 AND revoked_at IS NULL
         AND $3 >= counter RETURNING credential_id`,
      [input.credentialId, input.expectedCounter, input.nextCounter],
    );
    if (result.rowCount !== 1) denied('The WebAuthn counter update is stale.');
  }

  async issueProof(proof: WebAuthnAssertionProof): Promise<void> {
    this.assertLive();
    await this.pool.query(
      `INSERT INTO webauthn_assertion_proofs(
        proof_digest, owner_id, credential_id, purpose,
        authenticated_at, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        proof.proofId,
        proof.ownerId,
        proof.credentialId,
        proof.purpose,
        proof.authenticatedAt,
        proof.expiresAt,
      ],
    );
  }

  async consumeProof(input: {
    readonly proofId: string;
    readonly ownerId: string;
    readonly credentialId: string;
    readonly at: number;
  }): Promise<WebAuthnAssertionProof | null> {
    this.assertLive();
    const result = await this.pool.query<WebAuthnProofRow>(
      `DELETE FROM webauthn_assertion_proofs
       WHERE proof_digest = $1 AND owner_id = $2 AND credential_id = $3
         AND authenticated_at <= $4 AND expires_at >= $4
       RETURNING *`,
      [input.proofId, input.ownerId, input.credentialId, input.at],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapProof(row);
  }
}

class PostgresRecoveryProofStore implements RecoveryProofStore {
  constructor(
    private readonly pool: Pool,
    private readonly assertLive: () => void,
  ) {}

  async issue(input: {
    readonly attemptId: string;
    readonly expiresAt: number;
    readonly issuedChannelProof: string;
    readonly ownerId: string;
    readonly savedCodeProof: string;
  }): Promise<void> {
    this.assertLive();
    await this.pool.query(
      `INSERT INTO recovery_proof_attempts(
        attempt_id, owner_id, saved_code_digest, issued_channel_digest, expires_at
      ) VALUES ($1, $2, $3, $4, $5)`,
      [
        input.attemptId,
        input.ownerId,
        sha256(input.savedCodeProof),
        sha256(input.issuedChannelProof),
        input.expiresAt,
      ],
    );
  }

  async consumePair(input: {
    readonly at: number;
    readonly attemptId: string;
    readonly issuedChannelProof: string;
    readonly lockMs: number;
    readonly maxFailures: number;
    readonly ownerId: string;
    readonly savedCodeProof: string;
  }): Promise<boolean> {
    this.assertLive();
    if (
      !Number.isSafeInteger(input.at) ||
      !Number.isSafeInteger(input.lockMs) ||
      input.lockMs <= 0 ||
      !Number.isSafeInteger(input.maxFailures) ||
      input.maxFailures <= 0 ||
      input.maxFailures > 100
    ) {
      throw new IdentityError(
        'INVALID_COMMAND',
        'Recovery proof limits and time must be bounded safe integers.',
      );
    }
    return await withTransaction(this.pool, async (client) => {
      const now = await databaseNow(client);
      const result = await client.query<RecoveryProofRow>(
        'SELECT * FROM recovery_proof_attempts WHERE attempt_id = $1 FOR UPDATE',
        [input.attemptId],
      );
      const row = result.rows[0];
      if (
        row === undefined ||
        row.owner_id !== input.ownerId ||
        row.consumed_at !== null ||
        number(row.expires_at) < now ||
        (row.locked_until !== null && number(row.locked_until) >= now)
      ) {
        return false;
      }
      const accepted =
        row.saved_code_digest === sha256(input.savedCodeProof) &&
        row.issued_channel_digest === sha256(input.issuedChannelProof);
      if (accepted) {
        await client.query(
          'UPDATE recovery_proof_attempts SET consumed_at = $2 WHERE attempt_id = $1',
          [input.attemptId, now],
        );
        return true;
      }
      const failures = row.failures + 1;
      await client.query(
        `UPDATE recovery_proof_attempts SET
          failures = $2::integer,
          locked_until = CASE
            WHEN $2::integer >= $3::integer THEN $4::bigint
            ELSE locked_until
          END
         WHERE attempt_id = $1`,
        [input.attemptId, failures, input.maxFailures, now + input.lockMs],
      );
      return false;
    });
  }
}

async function configureRuntime(
  pool: Pool,
  input: CreatePostgresPlatformInput,
): Promise<void> {
  await withTransaction(pool, async (client) => {
    const current = await client.query<{
      environment_id: string;
      installation_id: string;
      mode: PlatformMode;
    }>(
      'SELECT environment_id, installation_id, mode FROM runtime_configuration WHERE singleton FOR UPDATE',
    );
    const row = current.rows[0];
    if (row === undefined) {
      await client.query(
        `INSERT INTO runtime_configuration(
          singleton, environment_id, installation_id, mode
        ) VALUES (TRUE, $1, $2, $3)`,
        [input.environmentId, input.installationId, input.mode],
      );
    } else if (
      row.environment_id !== input.environmentId ||
      row.installation_id !== input.installationId ||
      row.mode !== input.mode
    ) {
      throw new Error(
        'The PostgreSQL runtime identity or restore mode does not match.',
      );
    }
  });
}

async function withTransaction<T>(
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

interface WebAuthnCeremonyRow {
  readonly ceremony_id: string;
  readonly owner_id: string;
  readonly purpose: WebAuthnCeremonyRecord['purpose'];
  readonly challenge_digest: string;
  readonly configuration_revision: number;
  readonly created_at: string;
  readonly expires_at: string;
  readonly consumed_at: string | null;
}

interface WebAuthnCredentialRow {
  readonly credential_id: string;
  readonly webauthn_credential_id: string;
  readonly owner_id: string;
  readonly public_key: Buffer;
  readonly counter: string;
  readonly transports_json: unknown;
  readonly created_at: string;
  readonly revoked_at: string | null;
}

interface WebAuthnProofRow {
  readonly proof_digest: string;
  readonly owner_id: string;
  readonly credential_id: string;
  readonly purpose: WebAuthnAssertionProof['purpose'];
  readonly authenticated_at: string;
  readonly expires_at: string;
}

interface RecoveryProofRow {
  readonly owner_id: string;
  readonly saved_code_digest: string;
  readonly issued_channel_digest: string;
  readonly expires_at: string;
  readonly failures: number;
  readonly locked_until: string | null;
  readonly consumed_at: string | null;
}

function mapCeremony(row: WebAuthnCeremonyRow): WebAuthnCeremonyRecord {
  return {
    ceremonyId: row.ceremony_id,
    ownerId: row.owner_id,
    purpose: row.purpose,
    challengeDigest: row.challenge_digest,
    configurationRevision: row.configuration_revision,
    createdAt: number(row.created_at),
    expiresAt: number(row.expires_at),
    consumedAt: row.consumed_at === null ? null : number(row.consumed_at),
  };
}

function mapCredential(row: WebAuthnCredentialRow): WebAuthnCredentialRecord {
  const transports =
    row.transports_json === null
      ? undefined
      : (row.transports_json as WebAuthnCredentialRecord['transports']);
  return {
    credentialId: row.credential_id,
    webauthnCredentialId: row.webauthn_credential_id,
    ownerId: row.owner_id,
    publicKey: Uint8Array.from(row.public_key),
    counter: number(row.counter),
    ...(transports === undefined ? {} : { transports }),
    createdAt: number(row.created_at),
    revokedAt: row.revoked_at === null ? null : number(row.revoked_at),
  };
}

function mapProof(row: WebAuthnProofRow): WebAuthnAssertionProof {
  return {
    proofId: row.proof_digest,
    ownerId: row.owner_id,
    credentialId: row.credential_id,
    purpose: row.purpose,
    authenticatedAt: number(row.authenticated_at),
    expiresAt: number(row.expires_at),
  };
}

function parseIdentity(value: unknown): OwnerIdentityState {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Persisted Owner Identity state is malformed.');
  }
  return structuredClone(value as OwnerIdentityState);
}

function cloneIdentity(state: OwnerIdentityState): OwnerIdentityState {
  return structuredClone(state);
}

function number(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error('PostgreSQL returned an unsafe integer.');
  }
  return parsed;
}

async function databaseNow(client: PoolClient): Promise<number> {
  const result = await client.query<{ now_ms: string }>(
    'SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::text AS now_ms',
  );
  return number(result.rows[0]?.now_ms ?? '');
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function validateOpaque(value: string, prefix: string): void {
  if (!new RegExp(`^${prefix}_[a-f0-9]{64}$`, 'u').test(value)) {
    throw new Error(`The ${prefix} identifier is invalid.`);
  }
}

function denied(message: string): never {
  throw new IdentityError('AUTHENTICATION_DENIED', message);
}
