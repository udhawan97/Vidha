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
const JOB_ID = `job_${'1'.repeat(64)}`;
const PLAN_ID = 'plan_postgres_fixture';
const PLAN_OWNER_ID = 'owner_postgres_fixture';

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
    return true;
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

  it('reports the exact database major, migration, and runtime mode', async () => {
    await expect(platform.readiness()).resolves.toEqual({
      databaseMajor: 18,
      mode: 'live',
      schemaVersion: 1,
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

  it('atomically consumes ceremonies, assertion proofs, and independent recovery proofs', async () => {
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

    const recoveryNow = Date.now();
    await apiPlatform.recoveryProofStore.issue({
      attemptId: `recovery_${'7'.repeat(64)}`,
      ownerId: OWNER_ID,
      savedCodeProof: 'saved proof',
      issuedChannelProof: 'issued proof',
      expiresAt: recoveryNow + 60_000,
    });
    await expect(
      apiPlatform.recoveryProofStore.consumePair({
        at: Number.MAX_SAFE_INTEGER,
        attemptId: `recovery_${'7'.repeat(64)}`,
        issuedChannelProof: 'wrong',
        lockMs: 25,
        maxFailures: 2,
        ownerId: OWNER_ID,
        savedCodeProof: 'wrong',
      }),
    ).resolves.toBe(false);
    await expect(
      apiPlatform.recoveryProofStore.consumePair({
        at: Number.MAX_SAFE_INTEGER,
        attemptId: `recovery_${'7'.repeat(64)}`,
        issuedChannelProof: 'wrong again',
        lockMs: 25,
        maxFailures: 2,
        ownerId: OWNER_ID,
        savedCodeProof: 'wrong again',
      }),
    ).resolves.toBe(false);
    await expect(
      apiPlatform.recoveryProofStore.consumePair({
        at: Number.MAX_SAFE_INTEGER,
        attemptId: `recovery_${'7'.repeat(64)}`,
        issuedChannelProof: 'issued proof',
        lockMs: 25,
        maxFailures: 2,
        ownerId: OWNER_ID,
        savedCodeProof: 'saved proof',
      }),
    ).resolves.toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 35));
    await expect(
      apiPlatform.recoveryProofStore.consumePair({
        at: 0,
        attemptId: `recovery_${'7'.repeat(64)}`,
        issuedChannelProof: 'issued proof',
        lockMs: 25,
        maxFailures: 2,
        ownerId: OWNER_ID,
        savedCodeProof: 'saved proof',
      }),
    ).resolves.toBe(true);
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
