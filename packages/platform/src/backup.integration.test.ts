import { createHash } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { applyPlanCommand, createDraftPlan } from '@vidha/domain';
import {
  createOwnerIdentityCoordinator,
  type CredentialProofVerifier,
} from '@vidha/identity';
import {
  createAuthenticatedBackupChain,
  createEd25519BackupSigner,
  createEnvelopeMetadataCipher,
  createLogicalBackupCipher,
  createWebCryptoKeyProvider,
  type EncryptedLogicalBackup,
} from '@vidha/operations';
import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import { FileBackupInventory } from './fileBackupInventory';
import { PLATFORM_SCHEMA_VERSION } from './migrations';
import { createPostgresPlatform } from './postgres';
import {
  inspectPostgresRestore,
  promotePostgresRestore,
} from './postgresRestore';

const phase = process.env.VIDHA_BACKUP_REHEARSAL_PHASE;
if (process.env.VIDHA_REQUIRE_BACKUP_REHEARSAL === '1' && phase === undefined) {
  throw new Error('VIDHA_BACKUP_REHEARSAL_PHASE is required.');
}
const suite = phase === undefined ? describe.skip : describe;
const START = Date.parse('2026-08-24T12:00:00.000Z');
const ENVIRONMENT_ID = `environment_${'2'.repeat(64)}`;
const INSTALLATION_ID = `installation_${'3'.repeat(64)}`;
const ROTATION_ID = `rotation_${'4'.repeat(64)}`;
const RECOVERY_OWNER_ID = `owner_${'6'.repeat(64)}`;
const RECOVERY_CREDENTIAL_ID = `credential_${'7'.repeat(64)}`;
const RECOVERY_CHANNEL_REF = `channel_${'8'.repeat(64)}`;
const RECOVERY_ATTEMPT_ID = `recovery_${'9'.repeat(64)}`;
const RECOVERY_SAVED_PROOF = `saved_${'a'.repeat(64)}`;
const RECOVERY_ISSUED_PROOF = `issued_${'b'.repeat(64)}`;
const RECOVERY_SESSION_ID = `session_${'c'.repeat(64)}`;

interface RecoveryAttemptFixture {
  readonly acceptedAt?: number;
  readonly attemptId: string;
  readonly cancelledAt?: number;
  readonly consumedAt?: number;
  readonly expiresAt: number;
  readonly failures?: number;
  readonly issuedChannelFailures?: number;
  readonly lockedUntil?: number;
  readonly savedCodeFailures?: number;
}

const identityVerifier: CredentialProofVerifier = {
  async verifyAuthentication() {
    return { verified: true, userPresent: true, userVerified: true };
  },
  async verifyChannel() {
    return false;
  },
  async verifyRecovery() {
    return false;
  },
  async verifyRegistration() {
    return false;
  },
};

suite('authenticated PostgreSQL logical-backup rehearsal', () => {
  it(`executes the ${phase ?? 'disabled'} phase`, async () => {
    switch (phase) {
      case 'seed':
        await seedSource();
        break;
      case 'protect':
        await protectBackup();
        break;
      case 'verify':
        await verifyRestore();
        break;
      default:
        throw new Error(`Unsupported backup rehearsal phase: ${phase}`);
    }
  });
});

async function seedSource(): Promise<void> {
  const platform = await createPostgresPlatform({
    connectionString: required('VIDHA_BACKUP_SOURCE_URL'),
    environmentId: ENVIRONMENT_ID,
    installationId: INSTALLATION_ID,
    mode: 'live',
  });
  try {
    const sourceProvider = metadataProvider('file_fixture', 'key_source-1', 1);
    const sourceCipher = createEnvelopeMetadataCipher({
      keyProvider: sourceProvider,
    });
    for (const character of ['a', 'b']) {
      const recordId = `metadata_${character.repeat(64)}`;
      await platform.operationsStore.writeMetadata({
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
    const targetProvider = metadataProvider('kms_fixture', 'key_target-2', 2);
    await platform.keyRotationStore.rotate({
      at: START,
      rotationId: ROTATION_ID,
      sourceCipher,
      targetProvider,
    });

    const store = platform.createPlanStore();
    const draft = createDraftPlan({
      at: START,
      ownerId: 'owner_backup_fixture',
      planId: 'plan_backup_fixture',
      policy: {
        checkInIntervalMs: 86_400_000,
        gracePeriodMs: 7_200_000,
        reminderLeadMs: 3_600_000,
      },
    });
    await store.initialize(draft);
    await store.transact(
      draft.planId,
      `cmd_${'5'.repeat(64)}`,
      'REHEARSE_PLAN:policy:1',
      () => undefined,
      (state) =>
        applyPlanCommand(state, {
          at: START,
          authenticated: true,
          expectedPolicyRevision: 1,
          idempotencyKey: `cmd_${'5'.repeat(64)}`,
          type: 'REHEARSE_PLAN',
        }),
    );

    const recoveryExpiry = Date.now() + 259_200_000;
    await platform.recoveryProofIssuer.issue({
      attemptId: RECOVERY_ATTEMPT_ID,
      expiresAt: recoveryExpiry,
      factor: 'saved_code',
      ownerId: RECOVERY_OWNER_ID,
      proof: RECOVERY_SAVED_PROOF,
    });
    await platform.recoveryProofIssuer.issue({
      attemptId: RECOVERY_ATTEMPT_ID,
      expiresAt: recoveryExpiry,
      factor: 'issued_channel',
      ownerId: RECOVERY_OWNER_ID,
      proof: RECOVERY_ISSUED_PROOF,
    });
    const identity = recoveryCoordinator(platform, () => START);
    await identity.initialize({
      credentialId: RECOVERY_CREDENTIAL_ID,
      ownerId: RECOVERY_OWNER_ID,
      verifiedChannelRef: RECOVERY_CHANNEL_REF,
    });
    await identity.execute({
      type: 'BEGIN_RECOVERY',
      attemptId: RECOVERY_ATTEMPT_ID,
      expectedSecurityRevision: 1,
      idempotencyKey: 'backup-recovery-begin',
      issuedChannelProof: RECOVERY_ISSUED_PROOF,
      ownerId: RECOVERY_OWNER_ID,
      savedCodeProof: RECOVERY_SAVED_PROOF,
    });
  } finally {
    await platform.close();
  }
}

async function protectBackup(): Promise<void> {
  const root = required('VIDHA_BACKUP_ROOT');
  const plaintext = new Uint8Array(await readFile(join(root, 'source.dump')));
  const partial = new Uint8Array(await readFile(join(root, 'partial.dump')));
  expect(partial.byteLength).toBeLessThan(plaintext.byteLength);
  const provider = metadataProvider('backup_fixture', 'key_backup-1', 6);
  const cipher = createLogicalBackupCipher({ keyProvider: provider });
  const context = backupContext();
  const inventory = new FileBackupInventory(join(root, 'inventory.json'), {
    now: () => START,
  });
  const chain = createAuthenticatedBackupChain({
    inventory,
    signer: await createEd25519BackupSigner(),
  });

  const firstEnvelope = await cipher.encrypt(plaintext, context);
  const first = await createGeneration(1, firstEnvelope);
  const secondEnvelope = await cipher.encrypt(plaintext, context);
  const second = await createGeneration(2, secondEnvelope);
  await expect(
    chain.verify({
      ciphertext: firstEnvelope.ciphertext,
      manifest: first.manifest,
      signature: first.signature,
    }),
  ).rejects.toMatchObject({ code: 'INVALID_SNAPSHOT' });
  await expect(
    chain.verify({
      ciphertext: secondEnvelope.ciphertext,
      manifest: second.manifest,
      signature: second.signature,
    }),
  ).resolves.toEqual({ manifestDigest: second.manifestDigest });
  const decrypted = await cipher.decrypt(secondEnvelope, context);
  expect(decrypted).toEqual(plaintext);
  await writeFile(join(root, 'restore.dump'), decrypted, { flag: 'wx' });
  await unlink(join(root, 'generation-1.json'));
  await inventory.recordDeletion({
    at: START + 2,
    generation: 1,
    manifestDigest: first.manifestDigest,
  });
  await expect(inventory.history()).resolves.toEqual([
    expect.objectContaining({ generation: 1, status: 'deleted' }),
    expect.objectContaining({ generation: 2, status: 'retained' }),
  ]);

  async function createGeneration(
    generation: number,
    envelope: EncryptedLogicalBackup,
  ) {
    return await chain.create({
      applicationCommit: required('VIDHA_APPLICATION_COMMIT'),
      backupFormat: 'postgres_custom_v1',
      ciphertext: envelope.ciphertext,
      createdAt: START + generation,
      databaseMajor: context.databaseMajor,
      encryptionKeyVersion: envelope.keyVersion,
      encryptionProviderId: envelope.keyProviderId,
      environmentId: context.environmentId,
      initializationVector: envelope.initializationVector,
      installationId: context.installationId,
      keyVersions: ['key_target-2'],
      persist: async ({ manifest, manifestDigest, signature }) => {
        await writeFile(
          join(root, `generation-${generation}.json`),
          `${JSON.stringify({
            ciphertext: Buffer.from(envelope.ciphertext).toString('base64'),
            manifest,
            manifestDigest,
            signature: Buffer.from(signature).toString('base64'),
          })}\n`,
          { encoding: 'utf8', flag: 'wx', mode: 0o600 },
        );
      },
      schemaVersion: context.schemaVersion,
      wrappedDataKey: envelope.wrappedDataKey,
    });
  }
}

async function verifyRestore(): Promise<void> {
  const connectionString = required('VIDHA_BACKUP_RESTORE_URL');
  const restoreSafe = await createPostgresPlatform({
    connectionString,
    environmentId: ENVIRONMENT_ID,
    installationId: INSTALLATION_ID,
    manageSchema: false,
    mode: 'restore_safe',
  });
  await expect(
    restoreSafe.operationsStore.writeMetadata({} as never),
  ).rejects.toMatchObject({ code: 'RESTORE_SAFE_MODE' });
  await expect(
    restoreSafe.recoveryProofIssuer.issue({
      attemptId: `recovery_${'d'.repeat(64)}`,
      expiresAt: Date.now() + 60_000,
      factor: 'saved_code',
      ownerId: RECOVERY_OWNER_ID,
      proof: `saved_${'e'.repeat(64)}`,
    }),
  ).rejects.toMatchObject({ code: 'INVALID_COMMAND' });
  await expect(
    restoreSafe.identityRepository.transaction(async () => undefined),
  ).rejects.toMatchObject({ code: 'INVALID_COMMAND' });
  await restoreSafe.close();

  const pool = new Pool({ connectionString });
  try {
    const client = await pool.connect();
    try {
      await client.query('SET ROLE vidha_restore');
      await expect(
        client.query('SELECT COUNT(*) FROM encrypted_metadata'),
      ).resolves.toMatchObject({ rows: [{ count: '2' }] });
      await expect(
        client.query("UPDATE runtime_configuration SET mode = 'live'"),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await client.query('RESET ROLE');
      client.release();
    }

    const expectedRestore = {
      environmentId: ENVIRONMENT_ID,
      installationId: INSTALLATION_ID,
    };
    const originalIdentity = await pool.query<{
      ready_at: string | null;
      state_json: unknown;
    }>(
      `SELECT state_json, state_json #>> '{recovery,readyAt}' AS ready_at
       FROM owner_identity_states WHERE owner_id = $1`,
      [RECOVERY_OWNER_ID],
    );
    const originalState = originalIdentity.rows[0]?.state_json;
    const readyAt = Number(originalIdentity.rows[0]?.ready_at);
    if (originalState === undefined || !Number.isSafeInteger(readyAt)) {
      throw new Error('The restored recovery Owner state is absent.');
    }
    const missingAttemptId = `recovery_${'d'.repeat(64)}`;
    try {
      await setPendingAttempt(missingAttemptId);
      await expect(
        inspectPostgresRestore(pool, expectedRestore),
      ).rejects.toMatchObject({ code: 'INVALID_SNAPSHOT' });
    } finally {
      await restoreIdentity();
    }

    const terminalAttemptId = `recovery_${'e'.repeat(64)}`;
    await insertRecoveryAttempt({
      acceptedAt: START,
      attemptId: terminalAttemptId,
      cancelledAt: START,
      expiresAt: readyAt + 60_000,
    });
    try {
      await setPendingAttempt(terminalAttemptId);
      await expect(
        inspectPostgresRestore(pool, expectedRestore),
      ).rejects.toMatchObject({ code: 'INVALID_SNAPSHOT' });
    } finally {
      await restoreIdentity();
      await pool.query(
        'DELETE FROM recovery_proof_attempts WHERE attempt_id = $1',
        [terminalAttemptId],
      );
    }

    const orphanAttemptId = `recovery_${'f'.repeat(64)}`;
    await insertRecoveryAttempt({
      acceptedAt: START,
      attemptId: orphanAttemptId,
      expiresAt: readyAt + 60_000,
    });
    try {
      await expect(
        inspectPostgresRestore(pool, expectedRestore),
      ).rejects.toMatchObject({ code: 'INVALID_SNAPSHOT' });
    } finally {
      await pool.query(
        'DELETE FROM recovery_proof_attempts WHERE attempt_id = $1',
        [orphanAttemptId],
      );
    }

    await expectInvalidAttempt(
      {
        acceptedAt: START,
        attemptId: `recovery_${'0'.repeat(64)}`,
        expiresAt: readyAt - 1,
      },
      true,
    );
    await expectInvalidAttempt(
      {
        acceptedAt: readyAt + 2,
        attemptId: `recovery_${'1'.repeat(64)}`,
        expiresAt: readyAt + 1,
      },
      true,
    );
    await expectInvalidAttempt({
      acceptedAt: START,
      attemptId: `recovery_${'2'.repeat(64)}`,
      consumedAt: readyAt + 2,
      expiresAt: readyAt + 1,
    });
    await expectInvalidAttempt({
      attemptId: `recovery_${'3'.repeat(64)}`,
      expiresAt: readyAt + 60_000,
      lockedUntil: readyAt + 1,
    });
    await expectInvalidAttempt({
      attemptId: `recovery_${'4'.repeat(64)}`,
      expiresAt: readyAt + 60_000,
      failures: 1,
    });

    const recoveryProof = await pool.query<{
      accepted_at: string;
      expires_at: string;
      failures: number;
      locked_until: string | null;
    }>(
      `SELECT accepted_at::text, expires_at::text, failures, locked_until::text
       FROM recovery_proof_attempts WHERE attempt_id = $1`,
      [RECOVERY_ATTEMPT_ID],
    );
    expect(recoveryProof.rows[0]).toMatchObject({
      accepted_at: expect.any(String),
      failures: 0,
      locked_until: null,
    });
    expect(Number(recoveryProof.rows[0]?.expires_at)).toBeGreaterThan(START);
    const factorProofs = await pool.query<{
      factor: string;
      failures: number;
      proof_digest: string;
    }>(
      `SELECT factor, failures, proof_digest FROM recovery_proof_factors
       WHERE attempt_id = $1 ORDER BY factor`,
      [RECOVERY_ATTEMPT_ID],
    );
    expect(factorProofs.rows).toEqual([
      {
        factor: 'issued_channel',
        failures: 0,
        proof_digest: recoveryDigest(
          RECOVERY_ATTEMPT_ID,
          'issued_channel',
          RECOVERY_ISSUED_PROOF,
        ),
      },
      {
        factor: 'saved_code',
        failures: 0,
        proof_digest: recoveryDigest(
          RECOVERY_ATTEMPT_ID,
          'saved_code',
          RECOVERY_SAVED_PROOF,
        ),
      },
    ]);

    const report = await inspectPostgresRestore(pool, expectedRestore);
    expect(report).toMatchObject({
      databaseMajor: 18,
      keyVersions: ['key_target-2'],
      mode: 'restore_safe',
      schemaVersion: PLATFORM_SCHEMA_VERSION,
      tableCounts: {
        audit_events: 2,
        encrypted_metadata: 2,
        key_rotations: 1,
        plans: 1,
        processed_commands: 1,
        recovery_proof_factors: 2,
        recovery_proof_attempts: 1,
      },
    });
    const promotion = await promotePostgresRestore(pool, {
      at: START + 3,
      environmentId: ENVIRONMENT_ID,
      installationId: INSTALLATION_ID,
      promotionId: `promotion_${'7'.repeat(64)}`,
      reportDigest: report.reportDigest,
    });
    expect(promotion.duplicate).toBe(false);
    await expect(
      promotePostgresRestore(pool, {
        at: START + 3,
        environmentId: ENVIRONMENT_ID,
        installationId: INSTALLATION_ID,
        promotionId: `promotion_${'7'.repeat(64)}`,
        reportDigest: report.reportDigest,
      }),
    ).resolves.toMatchObject({ duplicate: true });

    async function setPendingAttempt(attemptId: string): Promise<void> {
      await pool.query(
        `UPDATE owner_identity_states
         SET state_json = jsonb_set(state_json, '{recovery,attemptId}', to_jsonb($2::text))
         WHERE owner_id = $1`,
        [RECOVERY_OWNER_ID, attemptId],
      );
    }

    async function restoreIdentity(): Promise<void> {
      await pool.query(
        'UPDATE owner_identity_states SET state_json = $2::jsonb WHERE owner_id = $1',
        [RECOVERY_OWNER_ID, JSON.stringify(originalState)],
      );
    }

    async function expectInvalidAttempt(
      input: RecoveryAttemptFixture,
      referenced = false,
    ): Promise<void> {
      await insertRecoveryAttempt(input);
      try {
        if (referenced) await setPendingAttempt(input.attemptId);
        await expect(
          inspectPostgresRestore(pool, expectedRestore),
        ).rejects.toMatchObject({ code: 'INVALID_SNAPSHOT' });
      } finally {
        if (referenced) await restoreIdentity();
        await pool.query(
          'DELETE FROM recovery_proof_attempts WHERE attempt_id = $1',
          [input.attemptId],
        );
      }
    }

    async function insertRecoveryAttempt(
      input: RecoveryAttemptFixture,
    ): Promise<void> {
      await pool.query(
        `INSERT INTO recovery_proof_attempts(
          attempt_id, owner_id, expires_at, failures, locked_until,
          accepted_at, cancelled_at, consumed_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          input.attemptId,
          RECOVERY_OWNER_ID,
          input.expiresAt,
          input.failures ?? 0,
          input.lockedUntil ?? null,
          input.acceptedAt ?? null,
          input.cancelledAt ?? null,
          input.consumedAt ?? null,
        ],
      );
      await pool.query(
        `INSERT INTO recovery_proof_factors(
          attempt_id, factor, proof_digest, failures
        ) VALUES
          ($1, 'saved_code', $2, $4),
          ($1, 'issued_channel', $3, $5)`,
        [
          input.attemptId,
          '1'.repeat(64),
          '2'.repeat(64),
          input.savedCodeFailures ?? 0,
          input.issuedChannelFailures ?? 0,
        ],
      );
    }
  } finally {
    await pool.end();
  }

  const live = await createPostgresPlatform({
    connectionString,
    environmentId: ENVIRONMENT_ID,
    installationId: INSTALLATION_ID,
    manageSchema: false,
    mode: 'live',
  });
  try {
    await expect(live.readiness()).resolves.toMatchObject({
      mode: 'live',
      schemaVersion: PLATFORM_SCHEMA_VERSION,
    });
    const targetCipher = createEnvelopeMetadataCipher({
      keyProvider: metadataProvider('kms_fixture', 'key_target-2', 2),
    });
    for (const character of ['a', 'b']) {
      const record = await live.operationsStore.readMetadata(
        `metadata_${character.repeat(64)}`,
      );
      await expect(targetCipher.decrypt(record!)).resolves.toEqual(
        new TextEncoder().encode(`synthetic-${character}`),
      );
    }
    const identity = recoveryCoordinator(live, () => START + 1);
    await identity.authenticate({
      assertion: 'fixture',
      credentialId: RECOVERY_CREDENTIAL_ID,
      ownerId: RECOVERY_OWNER_ID,
    });
    const cancelled = await identity.execute({
      type: 'CANCEL_RECOVERY',
      actorSessionId: RECOVERY_SESSION_ID,
      expectedSecurityRevision: 2,
      idempotencyKey: 'backup-recovery-cancel',
      ownerId: RECOVERY_OWNER_ID,
    });
    expect(cancelled.state.recovery).toBeNull();
    expect(cancelled.noticeIntents).toEqual([
      {
        channelRef: RECOVERY_CHANNEL_REF,
        template: 'recovery_cancelled',
      },
    ]);
    const recoveryRow = await live.pool.query<{
      cancelled_at: string | null;
      consumed_at: string | null;
    }>(
      `SELECT cancelled_at, consumed_at FROM recovery_proof_attempts
       WHERE attempt_id = $1`,
      [RECOVERY_ATTEMPT_ID],
    );
    expect(recoveryRow.rows[0]).toMatchObject({
      cancelled_at: expect.any(String),
      consumed_at: null,
    });
    await writeFile(
      join(required('VIDHA_BACKUP_ROOT'), 'rehearsal-report.json'),
      `${JSON.stringify({
        authenticatedGenerations: 2,
        databaseMajor: 18,
        explicitPromotion: true,
        keyRotationRecords: 2,
        logicalRestore: true,
        recoveryCancellationAfterPromotion: true,
        restoreSafeInspection: true,
      })}\n`,
      { encoding: 'utf8', flag: 'wx' },
    );
  } finally {
    await live.close();
  }
}

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

function recoveryCoordinator(
  platform: Awaited<ReturnType<typeof createPostgresPlatform>>,
  now: () => number,
) {
  return createOwnerIdentityCoordinator({
    clock: { now },
    policy: {
      channelChangeCoolingOffMs: 86_400_000,
      recentAuthenticationWindowMs: 300_000,
      recoveryCoolingOffMs: 172_800_000,
      sessionLifetimeMs: 900_000,
    },
    repository: platform.identityRepository,
    sessionIdGenerator: () => RECOVERY_SESSION_ID,
    verifier: identityVerifier,
  });
}

function metadataProvider(
  providerId: string,
  currentKeyVersion: string,
  byte: number,
) {
  return createWebCryptoKeyProvider({
    currentKeyVersion,
    keys: { [currentKeyVersion]: new Uint8Array(32).fill(byte) },
    providerId,
  });
}

function backupContext() {
  return {
    databaseMajor: 18,
    environmentId: ENVIRONMENT_ID,
    installationId: INSTALLATION_ID,
    schemaVersion: PLATFORM_SCHEMA_VERSION,
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required.`);
  }
  return value;
}
