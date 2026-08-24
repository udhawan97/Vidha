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

export interface LogicalBackupContext {
  readonly databaseMajor: number;
  readonly environmentId: string;
  readonly installationId: string;
  readonly schemaVersion: number;
}

export interface EncryptedLogicalBackup {
  readonly ciphertext: Uint8Array;
  readonly initializationVector: string;
  readonly keyProviderId: string;
  readonly keyVersion: string;
  readonly wrappedDataKey: string;
}

export interface LogicalBackupCipher {
  encrypt(
    plaintext: Uint8Array,
    context: LogicalBackupContext,
  ): Promise<EncryptedLogicalBackup>;
  decrypt(
    backup: EncryptedLogicalBackup,
    context: LogicalBackupContext,
  ): Promise<Uint8Array>;
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

export function createLogicalBackupCipher(input: {
  readonly keyProvider: MetadataKeyProvider;
  readonly randomBytes?: (length: number) => Uint8Array;
}): LogicalBackupCipher {
  validateProviderId(input.keyProvider.providerId);
  validateKeyVersion(input.keyProvider.currentKeyVersion);
  const randomBytes =
    input.randomBytes ??
    ((length: number) =>
      globalThis.crypto.getRandomValues(new Uint8Array(length)));

  return {
    async encrypt(plaintext, backupContext) {
      validateLogicalBackup(plaintext, backupContext);
      const dataKey = owned(await input.keyProvider.generateDataKey());
      requireLength(dataKey, 32, 'Generated logical-backup data keys');
      const iv = owned(randomBytes(12));
      requireLength(iv, 12, 'Logical-backup initialization vectors');
      try {
        const wrappedDataKey = await input.keyProvider.wrapDataKey({
          dataKey,
          keyVersion: input.keyProvider.currentKeyVersion,
        });
        const ciphertext = await globalThis.crypto.subtle.encrypt(
          {
            name: 'AES-GCM',
            iv,
            additionalData: logicalBackupContext(backupContext),
            tagLength: 128,
          },
          await importKey('AES-GCM', dataKey, ['encrypt']),
          owned(plaintext),
        );
        return {
          ciphertext: new Uint8Array(ciphertext),
          initializationVector: toBase64(iv),
          keyProviderId: input.keyProvider.providerId,
          keyVersion: input.keyProvider.currentKeyVersion,
          wrappedDataKey: toBase64(wrappedDataKey),
        };
      } finally {
        dataKey.fill(0);
      }
    },
    async decrypt(backup, backupContext) {
      validateLogicalBackupEnvelope(backup, backupContext);
      if (backup.keyProviderId !== input.keyProvider.providerId) {
        invalid('The logical-backup key provider does not match.');
      }
      const dataKey = owned(
        await input.keyProvider.unwrapDataKey({
          keyVersion: backup.keyVersion,
          wrappedDataKey: fromBase64(backup.wrappedDataKey),
        }),
      );
      requireLength(dataKey, 32, 'Unwrapped logical-backup data keys');
      try {
        const plaintext = new Uint8Array(
          await globalThis.crypto.subtle.decrypt(
            {
              name: 'AES-GCM',
              iv: fromBase64(backup.initializationVector),
              additionalData: logicalBackupContext(backupContext),
              tagLength: 128,
            },
            await importKey('AES-GCM', dataKey, ['decrypt']),
            owned(backup.ciphertext),
          ),
        );
        validateLogicalBackup(plaintext, backupContext);
        return plaintext;
      } catch (error) {
        if (error instanceof OperationsError) throw error;
        invalid('Logical-backup authentication failed.');
      } finally {
        dataKey.fill(0);
      }
    },
  };
}

export interface BackupManifest {
  readonly applicationCommit: string;
  readonly backupFormat: 'postgres_custom_v1';
  readonly ciphertextDigest: string;
  readonly createdAt: number;
  readonly databaseMajor: number;
  readonly encryptionKeyVersion: string;
  readonly encryptionProviderId: string;
  readonly environmentId: string;
  readonly generation: number;
  readonly initializationVector: string;
  readonly installationId: string;
  readonly keyVersions: readonly string[];
  readonly parentManifestDigest: string | null;
  readonly schemaVersion: number;
  readonly wrappedDataKey: string;
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
        readonly persist: (artifact: {
          readonly manifest: BackupManifest;
          readonly manifestDigest: string;
          readonly signature: Uint8Array;
        }) => Promise<void>;
      },
    ) {
      const previous = await input.inventory.read();
      const manifest: BackupManifest = {
        applicationCommit: details.applicationCommit,
        backupFormat: details.backupFormat,
        ciphertextDigest: await digestBytes(details.ciphertext),
        createdAt: details.createdAt,
        databaseMajor: details.databaseMajor,
        encryptionKeyVersion: details.encryptionKeyVersion,
        encryptionProviderId: details.encryptionProviderId,
        environmentId: details.environmentId,
        generation: (previous?.generation ?? 0) + 1,
        initializationVector: details.initializationVector,
        installationId: details.installationId,
        keyVersions: [...details.keyVersions].sort(),
        parentManifestDigest: previous?.manifestDigest ?? null,
        schemaVersion: details.schemaVersion,
        wrappedDataKey: details.wrappedDataKey,
      };
      validateManifest(manifest);
      const bytes = canonicalManifest(manifest);
      const signature = await input.signer.sign(bytes);
      const manifestDigest = await digestBytes(bytes);
      await details.persist({ manifest, manifestDigest, signature });
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
    manifest.backupFormat !== 'postgres_custom_v1' ||
    !/^[a-f0-9]{64}$/u.test(manifest.ciphertextDigest) ||
    !Number.isSafeInteger(manifest.createdAt) ||
    !Number.isSafeInteger(manifest.databaseMajor) ||
    manifest.databaseMajor < 18 ||
    !/^key_[a-z0-9_-]{1,32}$/u.test(manifest.encryptionKeyVersion) ||
    !/^[a-z][a-z0-9_-]{2,63}$/u.test(manifest.encryptionProviderId) ||
    !/^environment_[a-f0-9]{64}$/u.test(manifest.environmentId) ||
    !Number.isSafeInteger(manifest.generation) ||
    manifest.generation <= 0 ||
    !/^installation_[a-f0-9]{64}$/u.test(manifest.installationId) ||
    !isBase64WithLength(manifest.initializationVector, 12) ||
    !Number.isSafeInteger(manifest.schemaVersion) ||
    manifest.schemaVersion <= 0 ||
    (manifest.parentManifestDigest !== null &&
      !/^[a-f0-9]{64}$/u.test(manifest.parentManifestDigest)) ||
    manifest.keyVersions.length === 0 ||
    manifest.keyVersions.some(
      (version) => !/^key_[a-z0-9_-]{1,32}$/u.test(version),
    ) ||
    !isBase64WithLength(manifest.wrappedDataKey, 40)
  ) {
    invalid('The authenticated backup manifest is malformed.');
  }
}

function validateLogicalBackup(
  plaintext: Uint8Array,
  backupContext: LogicalBackupContext,
): void {
  validateLogicalBackupContext(backupContext);
  if (
    plaintext.byteLength < 5 ||
    plaintext.byteLength > 67_108_864 ||
    plaintext[0] !== 0x50 ||
    plaintext[1] !== 0x47 ||
    plaintext[2] !== 0x44 ||
    plaintext[3] !== 0x4d ||
    plaintext[4] !== 0x50
  ) {
    invalid('Logical backups must be bounded PostgreSQL custom archives.');
  }
}

function validateLogicalBackupEnvelope(
  backup: EncryptedLogicalBackup,
  backupContext: LogicalBackupContext,
): void {
  validateLogicalBackupContext(backupContext);
  validateProviderId(backup.keyProviderId);
  validateKeyVersion(backup.keyVersion);
  if (
    backup.ciphertext.byteLength < 21 ||
    backup.ciphertext.byteLength > 67_108_880 ||
    !isBase64WithLength(backup.initializationVector, 12) ||
    !isBase64WithLength(backup.wrappedDataKey, 40)
  ) {
    invalid('The encrypted logical-backup envelope is malformed.');
  }
}

function validateLogicalBackupContext(value: LogicalBackupContext): void {
  if (
    !Number.isSafeInteger(value.databaseMajor) ||
    value.databaseMajor < 18 ||
    !/^environment_[a-f0-9]{64}$/u.test(value.environmentId) ||
    !/^installation_[a-f0-9]{64}$/u.test(value.installationId) ||
    !Number.isSafeInteger(value.schemaVersion) ||
    value.schemaVersion <= 0
  ) {
    invalid('The logical-backup context is invalid.');
  }
}

function logicalBackupContext(
  value: LogicalBackupContext,
): Uint8Array<ArrayBuffer> {
  return owned(
    new TextEncoder().encode(
      JSON.stringify({ ...value, purpose: 'vidha-postgres-backup-v1' }),
    ),
  );
}

function isBase64WithLength(value: string, length: number): boolean {
  try {
    return fromBase64(value).byteLength === length;
  } catch {
    return false;
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
