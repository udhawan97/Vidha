import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { applyPlanCommand, createDraftPlan } from '@vidha/domain';
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

    const report = await inspectPostgresRestore(pool, {
      environmentId: ENVIRONMENT_ID,
      installationId: INSTALLATION_ID,
    });
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
    await writeFile(
      join(required('VIDHA_BACKUP_ROOT'), 'rehearsal-report.json'),
      `${JSON.stringify({
        authenticatedGenerations: 2,
        databaseMajor: 18,
        explicitPromotion: true,
        keyRotationRecords: 2,
        logicalRestore: true,
        restoreSafeInspection: true,
      })}\n`,
      { encoding: 'utf8', flag: 'wx' },
    );
  } finally {
    await live.close();
  }
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
