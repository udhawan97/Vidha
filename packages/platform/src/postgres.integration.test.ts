import { createHash } from 'node:crypto';

import {
  createOwnerIdentityCoordinator,
  type CredentialProofVerifier,
  type IdentityCommand,
} from '@vidha/identity';
import { applyPlanCommand, createDraftPlan } from '@vidha/domain';
import {
  OperationsError,
  createEnvelopeMetadataCipher,
  createWebCryptoKeyProvider,
  type EncryptedMetadataRecord,
  type SafetyJobIntent,
} from '@vidha/operations';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import { createPostgresPlatform, type PostgresPlatform } from './postgres';
import { PLATFORM_SCHEMA_VERSION, platformMigrations } from './migrations';
import { PostgresOperationsStore } from './postgresOperations';
import {
  PostgresPlanStore,
  createSyntheticConcernOutboxPlanner,
} from './postgresPlan';

const connectionString = process.env.VIDHA_POSTGRES_URL;
if (
  process.env.VIDHA_REQUIRE_POSTGRES === '1' &&
  connectionString === undefined
) {
  throw new Error('VIDHA_POSTGRES_URL is required for the PostgreSQL gate.');
}

const suite = connectionString === undefined ? describe.skip : describe;
const START = Date.parse('2026-08-21T12:00:00.000Z');
const OWNER_ID = `owner_${'a'.repeat(64)}`;
const CREDENTIAL = `credential_${'b'.repeat(64)}`;
const SECOND_CREDENTIAL = `credential_${'c'.repeat(64)}`;
const THIRD_CREDENTIAL = `credential_${'d'.repeat(64)}`;
const CHANNEL = `channel_${'e'.repeat(64)}`;
const SESSION = `session_${'f'.repeat(64)}`;
const SECOND_SESSION = `session_${'e'.repeat(64)}`;
const JOB_ID = `job_${'1'.repeat(64)}`;
const PLAN_ID = 'plan_postgres_fixture';
const PLAN_OWNER_ID = 'owner_postgres_fixture';
const RECOVERY_LOCK_BASE_MS = 1_000;
const RECOVERY_LOCK_MAX_MS = 4_000;

function commandKey(character: string): string {
  return `cmd_${character.repeat(64)}`;
}

const verifier: CredentialProofVerifier = {
  async verifyAuthentication() {
    return { verified: true, userPresent: true, userVerified: true };
  },
  async verifyChannel() {
    return true;
  },
  async verifyRecovery() {
    return false;
  },
  async verifyRegistration() {
    return true;
  },
};

suite('disposable PostgreSQL 18 platform', () => {
  let platform: PostgresPlatform;
  let apiPlatform: PostgresPlatform;
  let workerPool: Pool;

  beforeAll(async () => {
    const bootstrap = new Pool({ connectionString: connectionString ?? '' });
    await bootstrap.query(`
      DO $roles$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vidha_api') THEN
          CREATE ROLE vidha_api LOGIN;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vidha_worker') THEN
          CREATE ROLE vidha_worker LOGIN;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vidha_restore') THEN
          CREATE ROLE vidha_restore NOLOGIN;
        END IF;
      END
      $roles$
    `);
    await bootstrap.query(
      "ALTER ROLE vidha_api LOGIN PASSWORD 'vidha-api-test'",
    );
    await bootstrap.query(
      "ALTER ROLE vidha_worker LOGIN PASSWORD 'vidha-worker-test'",
    );
    await bootstrap.end();
    platform = await createPostgresPlatform({
      connectionString: connectionString ?? '',
      environmentId: `environment_${'2'.repeat(64)}`,
      installationId: `installation_${'3'.repeat(64)}`,
      mode: 'live',
      recoveryProofAbusePolicy: {
        baseLockMs: RECOVERY_LOCK_BASE_MS,
        failureThreshold: 2,
        maxLockMs: RECOVERY_LOCK_MAX_MS,
      },
    });
    apiPlatform = await createPostgresPlatform({
      connectionString: connectionFor(
        connectionString ?? '',
        'vidha_api',
        'vidha-api-test',
      ),
      environmentId: `environment_${'2'.repeat(64)}`,
      installationId: `installation_${'3'.repeat(64)}`,
      manageSchema: false,
      mode: 'live',
      recoveryProofAbusePolicy: {
        baseLockMs: RECOVERY_LOCK_BASE_MS,
        failureThreshold: 2,
        maxLockMs: RECOVERY_LOCK_MAX_MS,
      },
    });
    workerPool = new Pool({
      connectionString: connectionFor(
        connectionString ?? '',
        'vidha_worker',
        'vidha-worker-test',
      ),
    });
  });

  afterAll(async () => {
    await workerPool?.end();
    await apiPlatform?.close();
    await platform?.close();
  });

  beforeEach(async () => {
    await platform.pool.query(`
      TRUNCATE TABLE
        restore_promotions,
        metadata_key_rotations,
        synthetic_sink_receipts,
        safety_jobs,
        encrypted_metadata,
        audit_events,
        processed_commands,
        plans,
        recovery_proof_attempts,
        webauthn_assertion_proofs,
        webauthn_credentials,
        webauthn_ceremonies,
        owner_identity_states
      CASCADE
    `);
  });

  function recoveryCoordinator(
    now: () => number,
    sessionIds: string[],
    proofVerifier: CredentialProofVerifier = verifier,
  ) {
    return createOwnerIdentityCoordinator({
      clock: { now },
      policy: {
        channelChangeCoolingOffMs: 1,
        recentAuthenticationWindowMs: 60_000,
        recoveryCoolingOffMs: 1,
        sessionLifetimeMs: 60_000,
      },
      repository: apiPlatform.identityRepository,
      sessionIdGenerator: () => {
        const sessionId = sessionIds.shift();
        if (sessionId === undefined) {
          throw new Error('A deterministic recovery session was not queued.');
        }
        return sessionId;
      },
      verifier: proofVerifier,
    });
  }

  async function beginRecovery(
    coordinator: ReturnType<typeof recoveryCoordinator>,
    attempt: {
      readonly attemptId: string;
      readonly issuedChannelProof: string;
      readonly savedCodeProof: string;
    },
    expectedSecurityRevision: number,
    compromisedFactor?: 'wrong-issued' | 'wrong-saved',
  ) {
    return await coordinator.execute({
      type: 'BEGIN_RECOVERY',
      attemptId: attempt.attemptId,
      expectedSecurityRevision,
      idempotencyKey: `postgres-abuse-${attempt.attemptId}-${compromisedFactor ?? 'valid'}`,
      issuedChannelProof:
        compromisedFactor === 'wrong-issued'
          ? `wrong_${'a'.repeat(64)}`
          : attempt.issuedChannelProof,
      ownerId: OWNER_ID,
      savedCodeProof:
        compromisedFactor === 'wrong-saved'
          ? `wrong_${'b'.repeat(64)}`
          : attempt.savedCodeProof,
    });
  }

  async function issueRecoveryPair(input: {
    readonly attemptId: string;
    readonly expiresAt: number;
    readonly issuedChannelProof: string;
    readonly ownerId: string;
    readonly savedCodeProof: string;
  }): Promise<void> {
    await apiPlatform.recoveryProofIssuer.issue({
      attemptId: input.attemptId,
      expiresAt: input.expiresAt,
      factor: 'saved_code',
      ownerId: input.ownerId,
      proof: input.savedCodeProof,
    });
    await apiPlatform.recoveryProofIssuer.issue({
      attemptId: input.attemptId,
      expiresAt: input.expiresAt,
      factor: 'issued_channel',
      ownerId: input.ownerId,
      proof: input.issuedChannelProof,
    });
  }

  it('reports the exact database major, migration, and runtime mode', async () => {
    await expect(platform.readiness()).resolves.toEqual({
      databaseMajor: 18,
      mode: 'live',
      schemaVersion: PLATFORM_SCHEMA_VERSION,
    });
    const client = await platform.pool.connect();
    try {
      await client.query('SET ROLE vidha_worker');
      await expect(
        client.query(
          `INSERT INTO owner_identity_states(owner_id, security_revision, state_json)
           VALUES ($1, 1, '{}'::jsonb)`,
          [OWNER_ID],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await client.query('RESET ROLE');
      client.release();
    }
  });

  it('migrates legacy paired recovery rows into fail-closed factor records', async () => {
    const schema = 'phase3b_recovery_migration';
    const pendingAttempt = `recovery_${'d'.repeat(64)}`;
    const consumedAttempt = `recovery_${'e'.repeat(64)}`;
    const client = await platform.pool.connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}`);
      await client.query(`
        CREATE TABLE vidha_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          checksum TEXT NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
        )
      `);
      await client.query(platformMigrations[0]!.sql);
      await client.query(platformMigrations[1]!.sql);
      await client.query(
        `INSERT INTO recovery_proof_attempts(
          attempt_id, owner_id, saved_code_digest, issued_channel_digest,
          expires_at, failures, locked_until, consumed_at
        ) VALUES
          ($1, $3, $4, $5, $6, 2, NULL, NULL),
          ($2, $3, $5, $4, $6, 0, NULL, $7)`,
        [
          pendingAttempt,
          consumedAttempt,
          OWNER_ID,
          '1'.repeat(64),
          '2'.repeat(64),
          START + 60_000,
          START,
        ],
      );
      await client.query(platformMigrations[2]!.sql);

      const attempts = await client.query<{
        accepted_at: string | null;
        attempt_id: string;
        cancelled_at: string | null;
        consumed_at: string | null;
        failures: number;
      }>(
        `SELECT attempt_id, failures, accepted_at, cancelled_at, consumed_at
         FROM recovery_proof_attempts ORDER BY attempt_id`,
      );
      expect(attempts.rows).toEqual([
        {
          accepted_at: null,
          attempt_id: pendingAttempt,
          cancelled_at: expect.any(String),
          consumed_at: null,
          failures: 2,
        },
        {
          accepted_at: String(START),
          attempt_id: consumedAttempt,
          cancelled_at: null,
          consumed_at: String(START),
          failures: 0,
        },
      ]);
      const factors = await client.query<{
        attempt_id: string;
        factor: string;
        failures: number;
        proof_digest: string;
      }>(
        `SELECT attempt_id, factor, proof_digest, failures FROM recovery_proof_factors
         ORDER BY attempt_id, factor`,
      );
      expect(factors.rows).toEqual([
        {
          attempt_id: pendingAttempt,
          factor: 'issued_channel',
          failures: 2,
          proof_digest: '2'.repeat(64),
        },
        {
          attempt_id: pendingAttempt,
          factor: 'saved_code',
          failures: 2,
          proof_digest: '1'.repeat(64),
        },
        {
          attempt_id: consumedAttempt,
          factor: 'issued_channel',
          failures: 0,
          proof_digest: '1'.repeat(64),
        },
        {
          attempt_id: consumedAttempt,
          factor: 'saved_code',
          failures: 0,
          proof_digest: '2'.repeat(64),
        },
      ]);
    } finally {
      await client.query('SET search_path TO public');
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      client.release();
    }
  });

  it('issues independent factors concurrently and replays identical lost acknowledgements', async () => {
    const attemptId = `recovery_${'6'.repeat(64)}`;
    const savedCodeProof = `saved_${'7'.repeat(64)}`;
    const issuedChannelProof = `issued_${'8'.repeat(64)}`;
    const expiresAt = Date.now() + 60_000;
    const savedIssue = {
      attemptId,
      expiresAt,
      factor: 'saved_code' as const,
      ownerId: OWNER_ID,
      proof: savedCodeProof,
    };
    const issuedIssue = {
      attemptId,
      expiresAt,
      factor: 'issued_channel' as const,
      ownerId: OWNER_ID,
      proof: issuedChannelProof,
    };

    await expect(
      Promise.all([
        apiPlatform.recoveryProofIssuer.issue(savedIssue),
        apiPlatform.recoveryProofIssuer.issue(issuedIssue),
        apiPlatform.recoveryProofIssuer.issue(savedIssue),
      ]),
    ).resolves.toEqual([undefined, undefined, undefined]);
    await expect(
      apiPlatform.recoveryProofIssuer.issue(issuedIssue),
    ).resolves.toBeUndefined();
    await expect(
      apiPlatform.recoveryProofIssuer.issue({
        ...savedIssue,
        proof: `saved_${'9'.repeat(64)}`,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_COMMAND' });
    await expect(
      apiPlatform.recoveryProofIssuer.issue({
        ...savedIssue,
        ownerId: `owner_${'9'.repeat(64)}`,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_COMMAND' });
    await expect(
      apiPlatform.recoveryProofIssuer.issue({
        ...savedIssue,
        expiresAt: expiresAt + 1,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_COMMAND' });

    const attempts = await apiPlatform.pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM recovery_proof_attempts WHERE attempt_id = $1',
      [attemptId],
    );
    expect(attempts.rows[0]?.count).toBe('1');
    const factors = await apiPlatform.pool.query<{
      factor: string;
      proof_digest: string;
    }>(
      `SELECT factor, proof_digest FROM recovery_proof_factors
       WHERE attempt_id = $1 ORDER BY factor`,
      [attemptId],
    );
    expect(factors.rows).toEqual([
      {
        factor: 'issued_channel',
        proof_digest: recoveryDigest(
          attemptId,
          'issued_channel',
          issuedChannelProof,
        ),
      },
      {
        factor: 'saved_code',
        proof_digest: recoveryDigest(attemptId, 'saved_code', savedCodeProof),
      },
    ]);
    await expect(
      apiPlatform.pool.query(
        `UPDATE recovery_proof_factors SET proof_digest = $2
         WHERE attempt_id = $1 AND factor = 'saved_code'`,
        [attemptId, '0'.repeat(64)],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      apiPlatform.pool.query(
        'UPDATE recovery_proof_attempts SET owner_id = $2 WHERE attempt_id = $1',
        [attemptId, `owner_${'0'.repeat(64)}`],
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('persists digest-only identity state across coordinator instances', async () => {
    const first = createOwnerIdentityCoordinator({
      clock: { now: () => START },
      policy: {
        channelChangeCoolingOffMs: 86_400_000,
        recentAuthenticationWindowMs: 300_000,
        recoveryCoolingOffMs: 172_800_000,
        sessionLifetimeMs: 3_600_000,
      },
      repository: apiPlatform.identityRepository,
      sessionIdGenerator: () => SESSION,
      verifier,
    });
    await first.initialize({
      credentialId: CREDENTIAL,
      ownerId: OWNER_ID,
      verifiedChannelRef: CHANNEL,
    });
    await first.authenticate({
      assertion: 'verified fixture',
      credentialId: CREDENTIAL,
      ownerId: OWNER_ID,
    });
    const second = createOwnerIdentityCoordinator({
      clock: { now: () => START },
      policy: {
        channelChangeCoolingOffMs: 86_400_000,
        recentAuthenticationWindowMs: 300_000,
        recoveryCoolingOffMs: 172_800_000,
        sessionLifetimeMs: 3_600_000,
      },
      repository: apiPlatform.identityRepository,
      sessionIdGenerator: () => `session_${'9'.repeat(64)}`,
      verifier,
    });
    await expect(second.verify(SESSION, START)).resolves.toMatchObject({
      principal: { principalId: OWNER_ID, role: 'owner' },
    });
    const persisted = await apiPlatform.identityRepository.read(OWNER_ID);
    expect(JSON.stringify(persisted)).not.toContain(SESSION);

    const commands: readonly IdentityCommand[] = [
      {
        type: 'ADD_CREDENTIAL',
        actorSessionId: SESSION,
        newCredentialId: SECOND_CREDENTIAL,
        ownerId: OWNER_ID,
        registrationProof: 'fixture',
        expectedSecurityRevision: 1,
        idempotencyKey: 'postgres-concurrency-one',
      },
      {
        type: 'ADD_CREDENTIAL',
        actorSessionId: SESSION,
        newCredentialId: THIRD_CREDENTIAL,
        ownerId: OWNER_ID,
        registrationProof: 'fixture',
        expectedSecurityRevision: 1,
        idempotencyKey: 'postgres-concurrency-two',
      },
    ];
    const settled = await Promise.allSettled([
      first.execute(commands[0]!),
      second.execute(commands[1]!),
    ]);
    expect(
      settled.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(settled.filter((result) => result.status === 'rejected')).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({ code: 'STALE_SECURITY_REVISION' }),
      }),
    ]);
  });

  it('atomically consumes ceremonies and assertion proofs', async () => {
    const ceremony = {
      ceremonyId: `ceremony_${'4'.repeat(32)}`,
      ownerId: OWNER_ID,
      purpose: 'authenticate' as const,
      challengeDigest: '5'.repeat(64),
      configurationRevision: 1,
      createdAt: START,
      expiresAt: START + 60_000,
      consumedAt: null,
    };
    await apiPlatform.webAuthnStore.createCeremony(ceremony);
    await expect(
      apiPlatform.webAuthnStore.consumeCeremony({
        ceremonyId: ceremony.ceremonyId,
        purpose: ceremony.purpose,
        at: START,
      }),
    ).resolves.toMatchObject({ consumedAt: START });
    await expect(
      apiPlatform.webAuthnStore.consumeCeremony({
        ceremonyId: ceremony.ceremonyId,
        purpose: ceremony.purpose,
        at: START,
      }),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_DENIED' });

    await apiPlatform.webAuthnStore.registerCredential({
      bootstrap: true,
      credential: {
        credentialId: CREDENTIAL,
        webauthnCredentialId: 'raw-fixture-id',
        ownerId: OWNER_ID,
        publicKey: new Uint8Array([1, 2, 3]),
        counter: 0,
        transports: ['internal'],
        createdAt: START,
        revokedAt: null,
      },
    });
    await apiPlatform.webAuthnStore.issueProof({
      proofId: '6'.repeat(64),
      ownerId: OWNER_ID,
      credentialId: CREDENTIAL,
      purpose: 'authenticate',
      authenticatedAt: START,
      expiresAt: START + 10_000,
    });
    await expect(
      apiPlatform.webAuthnStore.consumeProof({
        proofId: '6'.repeat(64),
        ownerId: OWNER_ID,
        credentialId: CREDENTIAL,
        at: START,
      }),
    ).resolves.toMatchObject({ credentialId: CREDENTIAL });
    await expect(
      apiPlatform.webAuthnStore.consumeProof({
        proofId: '6'.repeat(64),
        ownerId: OWNER_ID,
        credentialId: CREDENTIAL,
        at: START,
      }),
    ).resolves.toBeNull();
  });

  it('accepts and consumes digest-only recovery proofs only through identity commands', async () => {
    let now = Date.now();
    const attemptId = `recovery_${'7'.repeat(64)}`;
    const savedCodeProof = `saved_${'8'.repeat(64)}`;
    const issuedChannelProof = `issued_${'9'.repeat(64)}`;
    const coordinator = recoveryCoordinator(() => now, [SESSION]);
    await coordinator.initialize({
      credentialId: CREDENTIAL,
      ownerId: OWNER_ID,
      verifiedChannelRef: CHANNEL,
    });
    await coordinator.authenticate({
      assertion: 'fixture',
      credentialId: CREDENTIAL,
      ownerId: OWNER_ID,
    });
    await issueRecoveryPair({
      attemptId,
      expiresAt: Date.now() + 60_000,
      issuedChannelProof,
      ownerId: OWNER_ID,
      savedCodeProof,
    });

    const started = await coordinator.execute({
      type: 'BEGIN_RECOVERY',
      attemptId,
      expectedSecurityRevision: 1,
      idempotencyKey: 'postgres-recovery-begin',
      issuedChannelProof,
      ownerId: OWNER_ID,
      savedCodeProof,
    });
    expect(started.noticeIntents).toEqual([
      { channelRef: CHANNEL, template: 'recovery_started' },
    ]);
    now += 1;
    const completed = await coordinator.execute({
      type: 'COMPLETE_RECOVERY',
      attemptId,
      expectedSecurityRevision: 2,
      idempotencyKey: 'postgres-recovery-complete',
      issuedChannelProof,
      newCredentialId: SECOND_CREDENTIAL,
      ownerId: OWNER_ID,
      registrationProof: 'fixture',
      savedCodeProof,
    });

    expect(completed.state.recovery).toBeNull();
    expect(completed.state.sessions).toEqual([
      expect.objectContaining({ revokedAt: now }),
    ]);
    expect(completed.noticeIntents).toEqual([
      { channelRef: CHANNEL, template: 'recovery_completed' },
    ]);
    await expect(coordinator.verify(SESSION, now)).resolves.toBeNull();
    const attemptRow = await apiPlatform.pool.query<{
      accepted_at: string | null;
      cancelled_at: string | null;
      consumed_at: string | null;
    }>(
      `SELECT accepted_at, cancelled_at, consumed_at
       FROM recovery_proof_attempts WHERE attempt_id = $1`,
      [attemptId],
    );
    expect(attemptRow.rows[0]).toMatchObject({
      accepted_at: expect.any(String),
      cancelled_at: null,
      consumed_at: expect.any(String),
    });
    const factorRows = await apiPlatform.pool.query<{
      factor: string;
      proof_digest: string;
    }>(
      `SELECT factor, proof_digest FROM recovery_proof_factors
       WHERE attempt_id = $1 ORDER BY factor`,
      [attemptId],
    );
    expect(factorRows.rows).toEqual([
      {
        factor: 'issued_channel',
        proof_digest: recoveryDigest(
          attemptId,
          'issued_channel',
          issuedChannelProof,
        ),
      },
      {
        factor: 'saved_code',
        proof_digest: recoveryDigest(attemptId, 'saved_code', savedCodeProof),
      },
    ]);
    const persisted = JSON.stringify({
      attemptRow: attemptRow.rows[0],
      factorRows: factorRows.rows,
      state: completed.state,
      notices: completed.noticeIntents,
    });
    expect(persisted).not.toContain(savedCodeProof);
    expect(persisted).not.toContain(issuedChannelProof);
    expect(Object.keys(completed.noticeIntents[0]!).sort()).toEqual([
      'channelRef',
      'template',
    ]);
    await expect(
      apiPlatform.pool.query(
        `UPDATE recovery_proof_attempts
         SET consumed_at = consumed_at + 1 WHERE attempt_id = $1`,
        [attemptId],
      ),
    ).rejects.toMatchObject({ code: 'P0001' });
  });

  it('keeps an accepted pair retryable after failed completion checks', async () => {
    let now = Date.now();
    const attemptId = `recovery_${'5'.repeat(64)}`;
    const savedCodeProof = `saved_${'4'.repeat(64)}`;
    const issuedChannelProof = `issued_${'3'.repeat(64)}`;
    const coordinator = recoveryCoordinator(() => now, [SESSION]);
    await coordinator.initialize({
      credentialId: CREDENTIAL,
      ownerId: OWNER_ID,
      verifiedChannelRef: CHANNEL,
    });
    await issueRecoveryPair({
      attemptId,
      expiresAt: Date.now() + 60_000,
      issuedChannelProof,
      ownerId: OWNER_ID,
      savedCodeProof,
    });
    await coordinator.execute({
      type: 'BEGIN_RECOVERY',
      attemptId,
      expectedSecurityRevision: 1,
      idempotencyKey: 'postgres-retry-begin',
      issuedChannelProof,
      ownerId: OWNER_ID,
      savedCodeProof,
    });
    now += 1;

    await expect(
      coordinator.execute({
        type: 'COMPLETE_RECOVERY',
        attemptId,
        expectedSecurityRevision: 2,
        idempotencyKey: 'postgres-retry-wrong-factor',
        issuedChannelProof: `wrong_${'2'.repeat(64)}`,
        newCredentialId: SECOND_CREDENTIAL,
        ownerId: OWNER_ID,
        registrationProof: 'fixture',
        savedCodeProof,
      }),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_DENIED' });
    await expect(coordinator.read(OWNER_ID)).resolves.toMatchObject({
      recovery: { attemptId },
      securityRevision: 2,
    });
    await expect(recoveryAttemptState()).resolves.toMatchObject({
      consumed_at: null,
      failures: 1,
    });
    const factorFailures = await apiPlatform.pool.query<{
      factor: string;
      failures: number;
    }>(
      `SELECT factor, failures FROM recovery_proof_factors
       WHERE attempt_id = $1 ORDER BY factor`,
      [attemptId],
    );
    expect(factorFailures.rows).toEqual([
      { factor: 'issued_channel', failures: 1 },
      { factor: 'saved_code', failures: 0 },
    ]);

    const registrationDenied = recoveryCoordinator(
      () => now,
      [SECOND_SESSION],
      {
        ...verifier,
        async verifyRegistration() {
          return false;
        },
      },
    );
    await expect(
      registrationDenied.execute({
        type: 'COMPLETE_RECOVERY',
        attemptId,
        expectedSecurityRevision: 2,
        idempotencyKey: 'postgres-retry-registration-denied',
        issuedChannelProof,
        newCredentialId: SECOND_CREDENTIAL,
        ownerId: OWNER_ID,
        registrationProof: 'rejected-fixture',
        savedCodeProof,
      }),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_DENIED' });
    await expect(coordinator.read(OWNER_ID)).resolves.toMatchObject({
      recovery: { attemptId },
      securityRevision: 2,
    });
    await expect(recoveryAttemptState()).resolves.toMatchObject({
      consumed_at: null,
      failures: 1,
    });

    await expect(
      coordinator.execute({
        type: 'COMPLETE_RECOVERY',
        attemptId,
        expectedSecurityRevision: 2,
        idempotencyKey: 'postgres-retry-complete',
        issuedChannelProof,
        newCredentialId: SECOND_CREDENTIAL,
        ownerId: OWNER_ID,
        registrationProof: 'fixture',
        savedCodeProof,
      }),
    ).resolves.toMatchObject({
      state: { recovery: null, securityRevision: 3 },
    });
    await expect(recoveryAttemptState()).resolves.toMatchObject({
      consumed_at: expect.any(String),
      failures: 1,
    });

    async function recoveryAttemptState() {
      const result = await apiPlatform.pool.query<{
        consumed_at: string | null;
        failures: number;
      }>(
        `SELECT consumed_at, failures FROM recovery_proof_attempts
         WHERE attempt_id = $1`,
        [attemptId],
      );
      return result.rows[0];
    }
  });

  it('serializes concurrent recovery completion and cancellation through one transaction', async () => {
    let now = Date.now();
    const attemptId = `recovery_${'a'.repeat(64)}`;
    const savedCodeProof = `saved_${'b'.repeat(64)}`;
    const issuedChannelProof = `issued_${'c'.repeat(64)}`;
    const cancellationSession = `session_${'d'.repeat(64)}`;
    const coordinator = recoveryCoordinator(() => now, [cancellationSession]);
    await coordinator.initialize({
      credentialId: CREDENTIAL,
      ownerId: OWNER_ID,
      verifiedChannelRef: CHANNEL,
    });
    await issueRecoveryPair({
      attemptId,
      expiresAt: Date.now() + 60_000,
      issuedChannelProof,
      ownerId: OWNER_ID,
      savedCodeProof,
    });
    await coordinator.execute({
      type: 'BEGIN_RECOVERY',
      attemptId,
      expectedSecurityRevision: 1,
      idempotencyKey: 'postgres-race-begin',
      issuedChannelProof,
      ownerId: OWNER_ID,
      savedCodeProof,
    });
    now += 1;
    await coordinator.authenticate({
      assertion: 'fixture',
      credentialId: CREDENTIAL,
      ownerId: OWNER_ID,
    });

    const settled = await Promise.allSettled([
      coordinator.execute({
        type: 'COMPLETE_RECOVERY',
        attemptId,
        expectedSecurityRevision: 2,
        idempotencyKey: 'postgres-race-complete',
        issuedChannelProof,
        newCredentialId: SECOND_CREDENTIAL,
        ownerId: OWNER_ID,
        registrationProof: 'fixture',
        savedCodeProof,
      }),
      coordinator.execute({
        type: 'CANCEL_RECOVERY',
        actorSessionId: cancellationSession,
        expectedSecurityRevision: 2,
        idempotencyKey: 'postgres-race-cancel',
        ownerId: OWNER_ID,
      }),
    ]);

    expect(
      settled.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(settled.filter((result) => result.status === 'rejected')).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({ code: 'STALE_SECURITY_REVISION' }),
      }),
    ]);
    const row = await apiPlatform.pool.query<{
      cancelled: boolean;
      consumed: boolean;
    }>(
      `SELECT cancelled_at IS NOT NULL AS cancelled,
        consumed_at IS NOT NULL AS consumed
       FROM recovery_proof_attempts WHERE attempt_id = $1`,
      [attemptId],
    );
    expect([row.rows[0]?.cancelled, row.rows[0]?.consumed]).toEqual([
      expect.any(Boolean),
      expect.any(Boolean),
    ]);
    expect(Number(row.rows[0]?.cancelled) + Number(row.rows[0]?.consumed)).toBe(
      1,
    );
    expect((await coordinator.read(OWNER_ID))?.recovery).toBeNull();
  });

  it('persists independent-factor failures and escalates locks across attempts', async () => {
    const now = Date.now();
    const coordinator = recoveryCoordinator(() => now, [SESSION]);
    await coordinator.initialize({
      credentialId: CREDENTIAL,
      ownerId: OWNER_ID,
      verifiedChannelRef: CHANNEL,
    });
    const attempts = ['1', '2', '3', '4', '5', '6'].map((character) => ({
      attemptId: `recovery_${character.repeat(64)}`,
      issuedChannelProof: `issued_${character.repeat(64)}`,
      savedCodeProof: `saved_${character.repeat(64)}`,
    }));
    for (const attempt of attempts) {
      await issueRecoveryPair({
        ...attempt,
        expiresAt: Date.now() + 60_000,
        ownerId: OWNER_ID,
      });
    }
    await expect(
      beginRecovery(coordinator, attempts[0]!, 1, 'wrong-issued'),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_DENIED' });
    await expect(
      beginRecovery(coordinator, attempts[1]!, 1, 'wrong-saved'),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_DENIED' });
    const independentFailures = await apiPlatform.pool.query<{
      attempt_id: string;
      factor: string;
      failures: number;
    }>(
      `SELECT attempt_id, factor, failures FROM recovery_proof_factors
       WHERE attempt_id = ANY($1::text[]) ORDER BY attempt_id, factor`,
      [[attempts[0]!.attemptId, attempts[1]!.attemptId]],
    );
    expect(independentFailures.rows).toEqual([
      {
        attempt_id: attempts[0]!.attemptId,
        factor: 'issued_channel',
        failures: 1,
      },
      {
        attempt_id: attempts[0]!.attemptId,
        factor: 'saved_code',
        failures: 0,
      },
      {
        attempt_id: attempts[1]!.attemptId,
        factor: 'issued_channel',
        failures: 0,
      },
      {
        attempt_id: attempts[1]!.attemptId,
        factor: 'saved_code',
        failures: 1,
      },
    ]);
    await expect(
      beginRecovery(coordinator, attempts[2]!, 1),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_DENIED' });
    const firstLock = await recoveryLock(attempts[1]!.attemptId);
    expect((await coordinator.read(OWNER_ID))?.recovery).toBeNull();

    await waitForRecoveryUnlock(firstLock);
    await beginRecovery(coordinator, attempts[2]!, 1);
    await coordinator.authenticate({
      assertion: 'fixture',
      credentialId: CREDENTIAL,
      ownerId: OWNER_ID,
    });
    await coordinator.execute({
      type: 'CANCEL_RECOVERY',
      actorSessionId: SESSION,
      expectedSecurityRevision: 2,
      idempotencyKey: 'postgres-abuse-cancel',
      ownerId: OWNER_ID,
    });

    await expect(
      beginRecovery(coordinator, attempts[3]!, 3, 'wrong-issued'),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_DENIED' });
    await expect(
      beginRecovery(coordinator, attempts[4]!, 3, 'wrong-saved'),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_DENIED' });
    const secondLock = await recoveryLock(attempts[4]!.attemptId);
    expect(secondLock).toBeGreaterThanOrEqual(RECOVERY_LOCK_BASE_MS * 1.5);
    await expect(
      beginRecovery(coordinator, attempts[5]!, 3),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_DENIED' });
    const failures = await apiPlatform.pool.query<{ total: string }>(
      `SELECT SUM(failures)::text AS total FROM recovery_proof_attempts
       WHERE owner_id = $1`,
      [OWNER_ID],
    );
    expect(failures.rows[0]?.total).toBe('4');

    await waitForRecoveryUnlock(secondLock);
    await expect(
      beginRecovery(coordinator, attempts[5]!, 3),
    ).resolves.toMatchObject({
      state: { recovery: { attemptId: attempts[5]!.attemptId } },
    });

    async function recoveryLock(attemptId: string): Promise<number> {
      const result = await apiPlatform.pool.query<{ remaining_ms: string }>(
        `SELECT GREATEST(
            0,
            locked_until - floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
          )::text AS remaining_ms
         FROM recovery_proof_attempts WHERE attempt_id = $1`,
        [attemptId],
      );
      return Number(result.rows[0]?.remaining_ms);
    }

    async function waitForRecoveryUnlock(remainingMs: number): Promise<void> {
      await new Promise((resolve) => setTimeout(resolve, remainingMs + 25));
    }
  });

  it('uses SKIP LOCKED claims, database-time fencing, and an idempotent synthetic sink', async () => {
    const api = apiPlatform.operationsStore;
    const first = new PostgresOperationsStore(workerPool);
    const second = new PostgresOperationsStore(workerPool);
    const intent: SafetyJobIntent = {
      kind: 'synthetic_notice',
      jobId: JOB_ID,
      channelRef: `channel_${'8'.repeat(64)}`,
      template: 'synthetic_rehearsal',
      commandKey: `cmd_${'9'.repeat(64)}`,
      dueAt: START,
      maxAttempts: 3,
    };
    await expect(
      Promise.all([api.enqueue(intent), api.enqueue(intent)]),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ duplicate: false }),
        expect.objectContaining({ duplicate: true }),
      ]),
    );
    const [left, right] = await Promise.all([
      first.claimDue({
        workerId: 'worker_fixture_a',
        at: START,
        leaseMs: 40,
        limit: 1,
      }),
      second.claimDue({
        workerId: 'worker_fixture_b',
        at: START,
        leaseMs: 40,
        limit: 1,
      }),
    ]);
    const claim = [...left, ...right][0];
    expect([...left, ...right]).toHaveLength(1);
    expect(claim).toBeDefined();
    await expect(
      Promise.all([
        first.acceptSyntheticSink({
          jobId: JOB_ID,
          payloadDigest: 'c'.repeat(64),
        }),
        second.acceptSyntheticSink({
          jobId: JOB_ID,
          payloadDigest: 'c'.repeat(64),
        }),
      ]),
    ).resolves.toEqual(
      expect.arrayContaining([{ duplicate: false }, { duplicate: true }]),
    );

    await new Promise((resolve) => setTimeout(resolve, 60));
    const reclaimed = await second.claimDue({
      workerId: 'worker_fixture_b',
      at: START,
      leaseMs: 1_000,
      limit: 1,
    });
    expect(reclaimed[0]?.job.leaseVersion).toBe(2);
    await expect(
      first.complete({
        jobId: JOB_ID,
        leaseId: claim!.leaseId,
        at: START + 1,
      }),
    ).rejects.toBeInstanceOf(OperationsError);
    await expect(
      second.complete({
        jobId: JOB_ID,
        leaseId: reclaimed[0]!.leaseId,
        at: START + 2,
      }),
    ).resolves.toMatchObject({ status: 'completed', leaseVersion: 2 });

    await api.enqueue({
      ...intent,
      jobId: `job_${'2'.repeat(64)}`,
      commandKey: `cmd_${'3'.repeat(64)}`,
      dueAt: Date.now() + 60_000,
    });
    await expect(
      first.claimDue({
        workerId: 'worker_fixture_a',
        at: Number.MAX_SAFE_INTEGER,
        leaseMs: 1_000,
        limit: 1,
      }),
    ).resolves.toEqual([]);
  });

  it('prevents the worker role from rewriting immutable job intent', async () => {
    await apiPlatform.operationsStore.enqueue({
      kind: 'synthetic_notice',
      jobId: JOB_ID,
      channelRef: `channel_${'8'.repeat(64)}`,
      template: 'synthetic_rehearsal',
      commandKey: `cmd_${'9'.repeat(64)}`,
      dueAt: START,
      maxAttempts: 3,
    });
    await expect(
      workerPool.query(
        "UPDATE safety_jobs SET kind = 'advance_plan_stage' WHERE job_id = $1",
        [JOB_ID],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      workerPool.query(
        `UPDATE safety_jobs
         SET state_json = jsonb_set(
           state_json, '{kind}', '"advance_plan_stage"'::jsonb
         )
         WHERE job_id = $1`,
        [JOB_ID],
      ),
    ).rejects.toMatchObject({ code: 'P0001' });
  });

  it('atomically persists Plan state, audit, schedule, and synthetic outbox intent', async () => {
    const store = apiPlatform.createPlanStore(
      createSyntheticConcernOutboxPlanner({
        channelRef: `channel_${'8'.repeat(64)}`,
      }),
    );
    const draft = createDraftPlan({
      planId: PLAN_ID,
      ownerId: PLAN_OWNER_ID,
      at: START,
      policy: {
        checkInIntervalMs: 86_400_000,
        reminderLeadMs: 3_600_000,
        gracePeriodMs: 7_200_000,
      },
    });
    await store.initialize(draft);
    await store.transact(
      PLAN_ID,
      commandKey('1'),
      'REHEARSE_PLAN:policy:1',
      () => undefined,
      (state) =>
        applyPlanCommand(state, {
          type: 'REHEARSE_PLAN',
          at: START,
          authenticated: true,
          expectedPolicyRevision: 1,
          idempotencyKey: commandKey('1'),
        }),
    );
    const armed = await store.transact(
      PLAN_ID,
      commandKey('2'),
      'ARM_PLAN:policy:1',
      () => undefined,
      (state) =>
        applyPlanCommand(state, {
          type: 'ARM_PLAN',
          at: START,
          authenticated: true,
          recentlyAuthenticated: true,
          expectedPolicyRevision: 1,
          idempotencyKey: commandKey('2'),
        }),
    );
    const reminderAt = armed.state.cycle.reminderAt;
    const first = apiPlatform.createPlanStore(
      createSyntheticConcernOutboxPlanner({
        channelRef: `channel_${'8'.repeat(64)}`,
      }),
    );
    const second = apiPlatform.createPlanStore(
      createSyntheticConcernOutboxPlanner({
        channelRef: `channel_${'8'.repeat(64)}`,
      }),
    );
    const advance = (candidate: PostgresPlanStore) =>
      candidate.transact(
        PLAN_ID,
        commandKey('3'),
        'ADVANCE_TIME',
        () => undefined,
        (state) =>
          applyPlanCommand(state, {
            type: 'ADVANCE_TIME',
            at: reminderAt,
            idempotencyKey: commandKey('3'),
          }),
      );
    const concurrent = await Promise.all([advance(first), advance(second)]);
    expect(concurrent.filter((result) => result.duplicate)).toHaveLength(1);
    await expect(store.audit(PLAN_ID)).resolves.toHaveLength(4);
    const jobs = await apiPlatform.operationsStore.inspectJobs();
    expect(jobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'advance_plan_stage' }),
        expect.objectContaining({
          kind: 'synthetic_notice',
          template: 'synthetic_rehearsal',
        }),
      ]),
    );
  });

  it('rolls back an accepted Plan decision when outbox semantics conflict', async () => {
    const operations = apiPlatform.operationsStore;
    const existing: SafetyJobIntent = {
      kind: 'synthetic_notice',
      jobId: `job_${'4'.repeat(64)}`,
      channelRef: `channel_${'5'.repeat(64)}`,
      template: 'owner_security_notice',
      commandKey: commandKey('6'),
      dueAt: START,
      maxAttempts: 2,
    };
    await operations.enqueue(existing);
    const store = new PostgresPlanStore(apiPlatform.pool, 'live', () => [
      { ...existing, template: 'synthetic_rehearsal' },
    ]);
    const draft = createDraftPlan({
      planId: PLAN_ID,
      ownerId: PLAN_OWNER_ID,
      at: START,
      policy: {
        checkInIntervalMs: 86_400_000,
        reminderLeadMs: 3_600_000,
        gracePeriodMs: 7_200_000,
      },
    });
    await store.initialize(draft);
    await expect(
      store.transact(
        PLAN_ID,
        commandKey('7'),
        'REHEARSE_PLAN:policy:1',
        () => undefined,
        (state) =>
          applyPlanCommand(state, {
            type: 'REHEARSE_PLAN',
            at: START,
            authenticated: true,
            expectedPolicyRevision: 1,
            idempotencyKey: commandKey('7'),
          }),
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(store.read(PLAN_ID)).resolves.toMatchObject({
      hasRehearsed: false,
      processedCommandKeys: [],
    });
    await expect(store.audit(PLAN_ID)).resolves.toHaveLength(1);
  });

  it('rejects mutations and claims through a restore-safe operations adapter', async () => {
    const store = new PostgresOperationsStore(platform.pool, 'restore_safe');
    await expect(
      store.claimDue({
        workerId: 'worker_fixture_d',
        at: START,
        leaseMs: 1_000,
        limit: 1,
      }),
    ).rejects.toMatchObject({ code: 'RESTORE_SAFE_MODE' });
  });

  it('atomically rotates persisted wrapped keys and replays a lost acknowledgement', async () => {
    const sourceProvider = createWebCryptoKeyProvider({
      currentKeyVersion: 'key_source-1',
      keys: { 'key_source-1': new Uint8Array(32).fill(1) },
      providerId: 'file_fixture',
    });
    const targetProvider = createWebCryptoKeyProvider({
      currentKeyVersion: 'key_target-2',
      keys: { 'key_target-2': new Uint8Array(32).fill(2) },
      providerId: 'kms_fixture',
    });
    const sourceCipher = createEnvelopeMetadataCipher({
      keyProvider: sourceProvider,
    });
    const records: EncryptedMetadataRecord[] = [];
    for (const character of ['a', 'b']) {
      const recordId = `metadata_${character.repeat(64)}`;
      records.push({
        recordId,
        schemaVersion: 2,
        ...(await sourceCipher.encrypt({
          recordId,
          schemaVersion: 2,
          plaintext: new TextEncoder().encode(`synthetic-${character}`),
        })),
        retainUntil: null,
        updatedAt: START,
      });
    }
    for (const record of records) {
      await apiPlatform.operationsStore.writeMetadata(record);
    }

    for (const boundary of [
      'after_selection',
      'after_first_write',
      'before_commit',
    ] as const) {
      await expect(
        apiPlatform.keyRotationStore.rotate(
          {
            at: START,
            rotationId: `rotation_${'4'.repeat(64)}`,
            sourceCipher,
            targetProvider,
          },
          async (current) => {
            if (current === boundary) throw new Error(`interrupt:${boundary}`);
          },
        ),
      ).rejects.toThrow(`interrupt:${boundary}`);
      await expect(apiPlatform.keyRotationStore.history()).resolves.toEqual([]);
      for (const record of records) {
        await expect(
          apiPlatform.operationsStore.readMetadata(record.recordId),
        ).resolves.toMatchObject({
          ciphertext: record.ciphertext,
          keyProviderId: 'file_fixture',
          keyVersion: 'key_source-1',
        });
      }
    }

    await expect(
      apiPlatform.keyRotationStore.rotate(
        {
          at: START,
          rotationId: `rotation_${'4'.repeat(64)}`,
          sourceCipher,
          targetProvider,
        },
        async (current) => {
          if (current === 'after_commit') {
            throw new Error('interrupt:after_commit');
          }
        },
      ),
    ).rejects.toThrow('interrupt:after_commit');

    const replay = await apiPlatform.keyRotationStore.rotate({
      at: START,
      rotationId: `rotation_${'4'.repeat(64)}`,
      sourceCipher,
      targetProvider,
    });
    expect(replay).toMatchObject({
      duplicate: true,
      rotatedRecords: 2,
      sourceKeyVersions: ['file_fixture:key_source-1'],
      targetKeyVersion: 'key_target-2',
      targetProviderId: 'kms_fixture',
    });
    const targetCipher = createEnvelopeMetadataCipher({
      keyProvider: targetProvider,
    });
    for (const record of records) {
      const rotated = await apiPlatform.operationsStore.readMetadata(
        record.recordId,
      );
      expect(rotated).toMatchObject({
        ciphertext: record.ciphertext,
        initializationVector: record.initializationVector,
        keyProviderId: 'kms_fixture',
        keyVersion: 'key_target-2',
      });
      await expect(targetCipher.decrypt(rotated!)).resolves.toEqual(
        new TextEncoder().encode(
          `synthetic-${record.recordId.at(-1) === 'a' ? 'a' : 'b'}`,
        ),
      );
    }
    await expect(
      apiPlatform.keyRotationStore.rotate({
        at: START,
        rotationId: `rotation_${'4'.repeat(64)}`,
        sourceCipher,
        targetProvider: createWebCryptoKeyProvider({
          currentKeyVersion: 'key_conflict-3',
          keys: { 'key_conflict-3': new Uint8Array(32).fill(3) },
          providerId: 'kms_fixture',
        }),
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(
      apiPlatform.pool.query(
        `UPDATE metadata_key_rotations SET completed_at = completed_at + 1
         WHERE rotation_id = $1`,
        [`rotation_${'4'.repeat(64)}`],
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('rejects caller-forged store modes against persisted runtime mode', async () => {
    await expect(
      new PostgresOperationsStore(
        platform.pool,
        'restore_safe',
      ).restoreSnapshot({ schemaVersion: 1, metadata: [], jobs: [] }),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
    await expect(
      new PostgresPlanStore(platform.pool, 'restore_safe').restoreSnapshot({
        schemaVersion: 1,
        plans: [],
        processedCommands: [],
        auditEvents: [],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });

    await platform.pool.query(
      "UPDATE runtime_configuration SET mode = 'restore_safe' WHERE singleton",
    );
    try {
      await expect(
        apiPlatform.operationsStore.enqueue({
          kind: 'synthetic_notice',
          jobId: JOB_ID,
          channelRef: `channel_${'8'.repeat(64)}`,
          template: 'synthetic_rehearsal',
          commandKey: `cmd_${'9'.repeat(64)}`,
          dueAt: START,
          maxAttempts: 3,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
    } finally {
      await platform.pool.query(
        "UPDATE runtime_configuration SET mode = 'live' WHERE singleton",
      );
    }
  });
});

function recoveryDigest(
  attemptId: string,
  factor: 'issued_channel' | 'saved_code',
  proof: string,
): string {
  return createHash('sha256')
    .update(
      `vidha:recovery-proof:v2\0${attemptId}\0${factor}\0${proof}`,
      'utf8',
    )
    .digest('hex');
}

function connectionFor(
  base: string,
  username: string,
  password: string,
): string {
  const url = new URL(base);
  url.username = username;
  url.password = password;
  return url.toString();
}
