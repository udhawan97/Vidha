import { describe, expect, it } from 'vitest';

import {
  createAuthenticatedBackupChain,
  createEd25519BackupSigner,
  createEnvelopeMetadataCipher,
  createMemoryBackupInventory,
  createWebCryptoKeyProvider,
  encodeBackupManifest,
} from './keyCustody';
import { MemoryOperationsStore } from './memory';
import {
  createOperationsFoundation,
  type EncryptedMetadataRecord,
} from './operations';

const RECORD_ID = `metadata_${'a'.repeat(64)}`;
const START = Date.parse('2026-08-21T12:00:00.000Z');
const COMMIT = 'a'.repeat(40);

function provider(
  providerId: string,
  currentKeyVersion: string,
  keys: Readonly<Record<string, Uint8Array>>,
) {
  return createWebCryptoKeyProvider({
    currentKeyVersion,
    keys,
    providerId,
    randomBytes: (length) => new Uint8Array(length).fill(7),
  });
}

function record(
  encrypted: Awaited<
    ReturnType<ReturnType<typeof createEnvelopeMetadataCipher>['encrypt']>
  >,
): EncryptedMetadataRecord {
  return {
    recordId: RECORD_ID,
    schemaVersion: 2,
    ...encrypted,
    retainUntil: null,
    updatedAt: START,
  };
}

describe('wrapped metadata key custody', () => {
  it('uses a distinct wrapped data key and authenticates record context', async () => {
    const keyProvider = provider('file_fixture', 'key_kek-1', {
      'key_kek-1': new Uint8Array(32).fill(1),
    });
    const cipher = createEnvelopeMetadataCipher({
      keyProvider,
      randomBytes: (length) => new Uint8Array(length).fill(9),
    });
    const plaintext = new TextEncoder().encode(
      JSON.stringify({ state: 'synthetic-only' }),
    );
    const encrypted = record(
      await cipher.encrypt({
        recordId: RECORD_ID,
        schemaVersion: 2,
        plaintext,
      }),
    );

    expect(JSON.stringify(encrypted)).not.toContain('synthetic-only');
    expect(encrypted).toMatchObject({
      keyProviderId: 'file_fixture',
      keyVersion: 'key_kek-1',
    });
    await expect(cipher.decrypt(encrypted)).resolves.toEqual(plaintext);
    await expect(
      cipher.decrypt({ ...encrypted, schemaVersion: 3 }),
    ).rejects.toMatchObject({ code: 'INVALID_SNAPSHOT' });
  });

  it('rewraps a data key without changing ciphertext and fails closed on key loss', async () => {
    const first = provider('file_fixture', 'key_kek-1', {
      'key_kek-1': new Uint8Array(32).fill(1),
    });
    const second = provider('kms_fixture', 'key_kek-2', {
      'key_kek-2': new Uint8Array(32).fill(2),
    });
    const source = createEnvelopeMetadataCipher({ keyProvider: first });
    const plaintext = new TextEncoder().encode('synthetic rotation fixture');
    const encrypted = record(
      await source.encrypt({
        recordId: RECORD_ID,
        schemaVersion: 2,
        plaintext,
      }),
    );
    const rotated = await source.rewrap(encrypted, second);
    const target = createEnvelopeMetadataCipher({ keyProvider: second });

    expect(rotated.ciphertext).toBe(encrypted.ciphertext);
    expect(rotated.wrappedDataKey).not.toBe(encrypted.wrappedDataKey);
    await expect(target.decrypt(rotated)).resolves.toEqual(plaintext);
    await expect(source.decrypt(rotated)).rejects.toMatchObject({
      code: 'INVALID_SNAPSHOT',
    });
    const missing = createEnvelopeMetadataCipher({
      keyProvider: provider('kms_fixture', 'key_kek-3', {
        'key_kek-3': new Uint8Array(32).fill(3),
      }),
    });
    await expect(missing.decrypt(rotated)).rejects.toMatchObject({
      code: 'INVALID_SNAPSHOT',
    });
  });

  it('persists and reads a wrapped-key record through the operations contract', async () => {
    const keyProvider = provider('file_fixture', 'key_kek-1', {
      'key_kek-1': new Uint8Array(32).fill(1),
    });
    const foundation = createOperationsFoundation({
      cipher: createEnvelopeMetadataCipher({ keyProvider }),
      clock: { now: () => START },
      store: new MemoryOperationsStore(),
    });
    await foundation.writeMetadata({
      recordId: RECORD_ID,
      schemaVersion: 2,
      metadata: { state: 'synthetic-only' },
    });
    await expect(foundation.readMetadata(RECORD_ID)).resolves.toEqual({
      state: 'synthetic-only',
    });
    await expect(foundation.exportSnapshot()).resolves.toMatchObject({
      metadata: [
        {
          keyProviderId: 'file_fixture',
          keyVersion: 'key_kek-1',
          wrappedDataKey: expect.any(String),
        },
      ],
    });
  });
});

describe('authenticated backup chain', () => {
  it('signs generations and rejects tampering and rollback below inventory', async () => {
    const inventory = createMemoryBackupInventory();
    const signer = await createEd25519BackupSigner();
    const chain = createAuthenticatedBackupChain({ inventory, signer });
    const common = {
      applicationCommit: COMMIT,
      createdAt: START,
      databaseMajor: 18,
      environmentId: `environment_${'b'.repeat(64)}`,
      installationId: `installation_${'c'.repeat(64)}`,
      keyVersions: ['key_kek-1'],
      schemaVersion: 2,
    };
    const firstCiphertext = new TextEncoder().encode('age ciphertext one');
    const first = await chain.create({
      ...common,
      ciphertext: firstCiphertext,
    });
    await expect(
      chain.verify({
        ciphertext: firstCiphertext,
        manifest: first.manifest,
        signature: first.signature,
      }),
    ).resolves.toEqual({ manifestDigest: first.manifestDigest });

    const secondCiphertext = new TextEncoder().encode('age ciphertext two');
    const second = await chain.create({
      ...common,
      createdAt: START + 1,
      ciphertext: secondCiphertext,
    });
    expect(second.manifest).toMatchObject({
      generation: 2,
      parentManifestDigest: first.manifestDigest,
    });
    await expect(
      chain.verify({
        ciphertext: firstCiphertext,
        manifest: first.manifest,
        signature: first.signature,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_SNAPSHOT' });
    const tampered = secondCiphertext.slice();
    tampered[0] = (tampered[0] ?? 0) ^ 1;
    await expect(
      chain.verify({
        ciphertext: tampered,
        manifest: second.manifest,
        signature: second.signature,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_SNAPSHOT' });
    const signedFuture = {
      ...second.manifest,
      generation: 3,
      parentManifestDigest: 'f'.repeat(64),
    };
    await expect(
      chain.verify({
        ciphertext: secondCiphertext,
        manifest: signedFuture,
        signature: await signer.sign(encodeBackupManifest(signedFuture)),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_SNAPSHOT' });
  });
});
