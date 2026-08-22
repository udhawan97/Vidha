import {
  OperationsError,
  type EncryptedMetadataRecord,
  type MetadataCipher,
} from './operations';

export interface MetadataKeyProvider {
  readonly currentKeyVersion: string;
  readonly providerId: string;
  generateDataKey(): Promise<Uint8Array>;
  wrapDataKey(input: {
    readonly dataKey: Uint8Array;
    readonly keyVersion: string;
  }): Promise<Uint8Array>;
  unwrapDataKey(input: {
    readonly keyVersion: string;
    readonly wrappedDataKey: Uint8Array;
  }): Promise<Uint8Array>;
}

export interface WrappedMetadataCipher extends MetadataCipher {
  rewrap(
    record: EncryptedMetadataRecord,
    target: MetadataKeyProvider,
  ): Promise<EncryptedMetadataRecord>;
}

export function createEnvelopeMetadataCipher(input: {
  readonly keyProvider: MetadataKeyProvider;
  readonly randomBytes?: (length: number) => Uint8Array;
}): WrappedMetadataCipher {
  validateKeyVersion(input.keyProvider.currentKeyVersion);
  validateProviderId(input.keyProvider.providerId);
  const randomBytes =
    input.randomBytes ??
    ((length: number) =>
      globalThis.crypto.getRandomValues(new Uint8Array(length)));
  const usedNonces = new Set<string>();

  return {
    currentKeyVersion: input.keyProvider.currentKeyVersion,
    async encrypt({ recordId, schemaVersion, plaintext }) {
      validateContext(recordId, schemaVersion, plaintext);
      const dataKey = owned(await input.keyProvider.generateDataKey());
      requireLength(dataKey, 32, 'Generated metadata data keys');
      const iv = owned(randomBytes(12));
      requireLength(iv, 12, 'Metadata initialization vectors');
      const encodedIv = toBase64(iv);
      const nonceKey = `${recordId}:${encodedIv}`;
      if (usedNonces.has(nonceKey)) {
        configuration('The metadata random source reused an AES-GCM nonce.');
      }
      usedNonces.add(nonceKey);
      const wrappedDataKey = await input.keyProvider.wrapDataKey({
        dataKey,
        keyVersion: input.keyProvider.currentKeyVersion,
      });
      const ciphertext = await globalThis.crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv,
          additionalData: context(recordId, schemaVersion),
          tagLength: 128,
        },
        await importKey('AES-GCM', dataKey, ['encrypt']),
        owned(plaintext),
      );
      dataKey.fill(0);
      return {
        keyVersion: input.keyProvider.currentKeyVersion,
        keyProviderId: input.keyProvider.providerId,
        wrappedDataKey: toBase64(wrappedDataKey),
        initializationVector: encodedIv,
        ciphertext: toBase64(new Uint8Array(ciphertext)),
      };
    },
    async decrypt(record) {
      const envelope = requireEnvelope(record);
      if (envelope.keyProviderId !== input.keyProvider.providerId) {
        invalid(
          'The metadata key provider does not match the record envelope.',
        );
      }
      const dataKey = owned(
        await input.keyProvider.unwrapDataKey({
          keyVersion: record.keyVersion,
          wrappedDataKey: fromBase64(envelope.wrappedDataKey),
        }),
      );
      requireLength(dataKey, 32, 'Unwrapped metadata data keys');
      try {
        const plaintext = await globalThis.crypto.subtle.decrypt(
          {
            name: 'AES-GCM',
            iv: fromBase64(record.initializationVector),
            additionalData: context(record.recordId, record.schemaVersion),
            tagLength: 128,
          },
          await importKey('AES-GCM', dataKey, ['decrypt']),
          fromBase64(record.ciphertext),
        );
        return new Uint8Array(plaintext);
      } catch {
        invalid('Wrapped metadata authentication failed.');
      } finally {
        dataKey.fill(0);
      }
    },
    async rewrap(record, target) {
      const envelope = requireEnvelope(record);
      if (envelope.keyProviderId !== input.keyProvider.providerId) {
        invalid(
          'The source metadata key provider does not match the envelope.',
        );
      }
      validateProviderId(target.providerId);
      validateKeyVersion(target.currentKeyVersion);
      const dataKey = owned(
        await input.keyProvider.unwrapDataKey({
          keyVersion: record.keyVersion,
          wrappedDataKey: fromBase64(envelope.wrappedDataKey),
        }),
      );
      try {
        requireLength(dataKey, 32, 'Unwrapped metadata data keys');
        const wrappedDataKey = await target.wrapDataKey({
          dataKey,
          keyVersion: target.currentKeyVersion,
        });
        return {
          ...record,
          keyVersion: target.currentKeyVersion,
          keyProviderId: target.providerId,
          wrappedDataKey: toBase64(wrappedDataKey),
        };
      } finally {
        dataKey.fill(0);
      }
    },
  };
}

export function createWebCryptoKeyProvider(input: {
  readonly currentKeyVersion: string;
  readonly keys: Readonly<Record<string, Uint8Array>>;
  readonly providerId: string;
  readonly randomBytes?: (length: number) => Uint8Array;
}): MetadataKeyProvider {
  validateProviderId(input.providerId);
  validateKeyVersion(input.currentKeyVersion);
  const keys = new Map(
    Object.entries(input.keys).map(([version, key]) => {
      validateKeyVersion(version);
      const ownedKey = owned(key);
      requireLength(ownedKey, 32, 'Metadata wrapping keys');
      return [version, ownedKey] as const;
    }),
  );
  if (!keys.has(input.currentKeyVersion)) {
    configuration('The current metadata wrapping key is absent.');
  }
  const randomBytes =
    input.randomBytes ??
    ((length: number) =>
      globalThis.crypto.getRandomValues(new Uint8Array(length)));

  return {
    currentKeyVersion: input.currentKeyVersion,
    providerId: input.providerId,
    async generateDataKey() {
      const key = owned(randomBytes(32));
      requireLength(key, 32, 'Generated metadata data keys');
      return key;
    },
    async wrapDataKey({ dataKey, keyVersion }) {
      requireLength(dataKey, 32, 'Metadata data keys');
      const wrappingKey = requireKey(keys, keyVersion);
      const exported = await globalThis.crypto.subtle.wrapKey(
        'raw',
        await importKey('AES-GCM', dataKey, ['encrypt', 'decrypt'], true),
        await importKey('AES-KW', wrappingKey, ['wrapKey']),
        'AES-KW',
      );
      return new Uint8Array(exported);
    },
    async unwrapDataKey({ keyVersion, wrappedDataKey }) {
      const wrappingKey = requireKey(keys, keyVersion);
      try {
        const key = await globalThis.crypto.subtle.unwrapKey(
          'raw',
          owned(wrappedDataKey),
          await importKey('AES-KW', wrappingKey, ['unwrapKey']),
          'AES-KW',
          { name: 'AES-GCM', length: 256 },
          true,
          ['encrypt', 'decrypt'],
        );
        return new Uint8Array(
          await globalThis.crypto.subtle.exportKey('raw', key),
        );
      } catch {
        invalid('The metadata data-key envelope could not be unwrapped.');
      }
    },
  };
}

export interface BackupManifest {
  readonly applicationCommit: string;
  readonly ciphertextDigest: string;
  readonly createdAt: number;
  readonly databaseMajor: number;
  readonly environmentId: string;
  readonly generation: number;
  readonly installationId: string;
  readonly keyVersions: readonly string[];
  readonly parentManifestDigest: string | null;
  readonly schemaVersion: number;
}

export interface BackupInventory {
  read(): Promise<{
    readonly generation: number;
    readonly manifestDigest: string;
  } | null>;
  write(entry: {
    readonly generation: number;
    readonly manifestDigest: string;
  }): Promise<void>;
}

export interface BackupManifestSigner {
  sign(message: Uint8Array): Promise<Uint8Array>;
  verify(message: Uint8Array, signature: Uint8Array): Promise<boolean>;
}

export function createAuthenticatedBackupChain(input: {
  readonly inventory: BackupInventory;
  readonly signer: BackupManifestSigner;
}) {
  return {
    async create(
      details: Omit<
        BackupManifest,
        'ciphertextDigest' | 'generation' | 'parentManifestDigest'
      > & {
        readonly ciphertext: Uint8Array;
      },
    ) {
      const previous = await input.inventory.read();
      const manifest: BackupManifest = {
        applicationCommit: details.applicationCommit,
        ciphertextDigest: await digestBytes(details.ciphertext),
        createdAt: details.createdAt,
        databaseMajor: details.databaseMajor,
        environmentId: details.environmentId,
        generation: (previous?.generation ?? 0) + 1,
        installationId: details.installationId,
        keyVersions: [...details.keyVersions].sort(),
        parentManifestDigest: previous?.manifestDigest ?? null,
        schemaVersion: details.schemaVersion,
      };
      validateManifest(manifest);
      const bytes = canonicalManifest(manifest);
      const signature = await input.signer.sign(bytes);
      const manifestDigest = await digestBytes(bytes);
      await input.inventory.write({
        generation: manifest.generation,
        manifestDigest,
      });
      return { manifest, manifestDigest, signature };
    },
    async verify(details: {
      readonly ciphertext: Uint8Array;
      readonly manifest: BackupManifest;
      readonly signature: Uint8Array;
    }) {
      validateManifest(details.manifest);
      const bytes = canonicalManifest(details.manifest);
      const inventory = await input.inventory.read();
      const manifestDigest = await digestBytes(bytes);
      if (
        !(await input.signer.verify(bytes, details.signature)) ||
        (await digestBytes(details.ciphertext)) !==
          details.manifest.ciphertextDigest ||
        inventory === null ||
        details.manifest.generation !== inventory.generation ||
        manifestDigest !== inventory.manifestDigest
      ) {
        invalid('The authenticated backup or external inventory is invalid.');
      }
      return { manifestDigest };
    },
  };
}

export function encodeBackupManifest(
  manifest: BackupManifest,
): Uint8Array<ArrayBuffer> {
  validateManifest(manifest);
  return canonicalManifest(manifest);
}

export async function createEd25519BackupSigner(input?: {
  readonly privateKey: CryptoKey;
  readonly publicKey: CryptoKey;
}): Promise<BackupManifestSigner> {
  const keys =
    input ??
    ((await globalThis.crypto.subtle.generateKey('Ed25519', true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair);
  return {
    async sign(message) {
      return new Uint8Array(
        await globalThis.crypto.subtle.sign(
          'Ed25519',
          keys.privateKey,
          owned(message),
        ),
      );
    },
    async verify(message, signature) {
      return await globalThis.crypto.subtle.verify(
        'Ed25519',
        keys.publicKey,
        owned(signature),
        owned(message),
      );
    },
  };
}

export function createMemoryBackupInventory(): BackupInventory {
  let current: {
    readonly generation: number;
    readonly manifestDigest: string;
  } | null = null;
  return {
    async read() {
      return current === null ? null : { ...current };
    },
    async write(entry) {
      if (current !== null && entry.generation !== current.generation + 1) {
        invalid('Backup inventory generations must increase by exactly one.');
      }
      current = { ...entry };
    },
  };
}

function requireEnvelope(record: EncryptedMetadataRecord): {
  readonly keyProviderId: string;
  readonly wrappedDataKey: string;
} {
  if (
    record.keyProviderId === undefined ||
    record.wrappedDataKey === undefined
  ) {
    invalid('The encrypted metadata record has no wrapped data-key envelope.');
  }
  return {
    keyProviderId: record.keyProviderId,
    wrappedDataKey: record.wrappedDataKey,
  };
}

function validateContext(
  recordId: string,
  schemaVersion: number,
  plaintext: Uint8Array,
): void {
  if (
    !/^metadata_[a-f0-9]{64}$/u.test(recordId) ||
    !Number.isSafeInteger(schemaVersion) ||
    schemaVersion <= 0 ||
    plaintext.byteLength === 0 ||
    plaintext.byteLength > 65_536
  ) {
    invalid('The wrapped metadata encryption context is invalid.');
  }
}

function validateManifest(manifest: BackupManifest): void {
  if (
    !/^[a-f0-9]{40,64}$/u.test(manifest.applicationCommit) ||
    !/^[a-f0-9]{64}$/u.test(manifest.ciphertextDigest) ||
    !Number.isSafeInteger(manifest.createdAt) ||
    !Number.isSafeInteger(manifest.databaseMajor) ||
    manifest.databaseMajor < 18 ||
    !/^environment_[a-f0-9]{64}$/u.test(manifest.environmentId) ||
    !Number.isSafeInteger(manifest.generation) ||
    manifest.generation <= 0 ||
    !/^installation_[a-f0-9]{64}$/u.test(manifest.installationId) ||
    !Number.isSafeInteger(manifest.schemaVersion) ||
    manifest.schemaVersion <= 0 ||
    (manifest.parentManifestDigest !== null &&
      !/^[a-f0-9]{64}$/u.test(manifest.parentManifestDigest)) ||
    manifest.keyVersions.length === 0 ||
    manifest.keyVersions.some(
      (version) => !/^key_[a-z0-9_-]{1,32}$/u.test(version),
    )
  ) {
    invalid('The authenticated backup manifest is malformed.');
  }
}

function canonicalManifest(manifest: BackupManifest): Uint8Array<ArrayBuffer> {
  return owned(new TextEncoder().encode(JSON.stringify(manifest)));
}

function context(
  recordId: string,
  schemaVersion: number,
): Uint8Array<ArrayBuffer> {
  return owned(
    new TextEncoder().encode(
      JSON.stringify({ recordId, schemaVersion, purpose: 'vidha-metadata-v2' }),
    ),
  );
}

async function importKey(
  name: 'AES-GCM' | 'AES-KW',
  key: Uint8Array,
  usages: KeyUsage[],
  extractable = false,
): Promise<CryptoKey> {
  return await globalThis.crypto.subtle.importKey(
    'raw',
    owned(key),
    name,
    extractable,
    usages,
  );
}

function requireKey(
  keys: ReadonlyMap<string, Uint8Array>,
  version: string,
): Uint8Array {
  const key = keys.get(version);
  if (key === undefined)
    invalid('The metadata wrapping-key version is unavailable.');
  return owned(key);
}

function owned(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(value.byteLength);
  bytes.set(value);
  return bytes;
}

function toBase64(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    invalid('The encrypted metadata envelope is not valid base64.');
  }
}

async function digestBytes(value: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', owned(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function requireLength(value: Uint8Array, length: number, label: string): void {
  if (value.byteLength !== length)
    configuration(`${label} must contain ${length} bytes.`);
}

function validateProviderId(value: string): void {
  if (!/^[a-z][a-z0-9_-]{2,63}$/u.test(value))
    configuration('The metadata key-provider identifier is invalid.');
}

function validateKeyVersion(value: string): void {
  if (!/^key_[a-z0-9_-]{1,32}$/u.test(value))
    configuration('The metadata key version is invalid.');
}

function invalid(message: string): never {
  throw new OperationsError('INVALID_SNAPSHOT', message);
}

function configuration(message: string): never {
  throw new OperationsError('INVALID_CONFIGURATION', message);
}
