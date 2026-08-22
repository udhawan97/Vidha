export const OPERATIONS_SCHEMA_VERSION = 1;

export type StoreMode = 'live' | 'restore_safe';
export type MetadataValue = string | number | boolean | null;

export interface EncryptedMetadataRecord {
  readonly recordId: string;
  readonly schemaVersion: number;
  readonly keyVersion: string;
  readonly keyProviderId?: string;
  readonly wrappedDataKey?: string;
  readonly initializationVector: string;
  readonly ciphertext: string;
  readonly retainUntil: number | null;
  readonly updatedAt: number;
}

export type SafetyJobIntent =
  | {
      readonly kind: 'advance_plan_stage';
      readonly jobId: string;
      readonly planRef: string;
      readonly commandKey: string;
      readonly dueAt: number;
      readonly maxAttempts: number;
    }
  | {
      readonly kind: 'synthetic_notice';
      readonly jobId: string;
      readonly channelRef: string;
      readonly template: 'owner_security_notice' | 'synthetic_rehearsal';
      readonly commandKey: string;
      readonly dueAt: number;
      readonly maxAttempts: number;
    };

export type SyntheticNoticeIntent = Extract<
  SafetyJobIntent,
  { readonly kind: 'synthetic_notice' }
>;

export type SafetyJobStatus =
  'pending' | 'leased' | 'completed' | 'dead_letter';

interface SafetyJobFields {
  readonly status: SafetyJobStatus;
  readonly attempts: number;
  readonly availableAt: number;
  readonly leaseId: string | null;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: number | null;
  readonly leaseVersion: number;
  readonly completedAt: number | null;
  readonly lastFailureCode: string | null;
}

export type SafetyJob = SafetyJobIntent & SafetyJobFields;

export interface ClaimedSafetyJob {
  readonly job: SafetyJob;
  readonly leaseId: string;
}

export interface OperationsSnapshot {
  readonly schemaVersion: number;
  readonly metadata: readonly EncryptedMetadataRecord[];
  readonly jobs: readonly SafetyJob[];
}

export interface OperationsStore {
  readonly mode: StoreMode;
  writeMetadata(record: EncryptedMetadataRecord): Promise<void>;
  commitMetadataAndOutbox(
    record: EncryptedMetadataRecord,
    intents: readonly SyntheticNoticeIntent[],
  ): Promise<readonly { duplicate: boolean; job: SafetyJob }[]>;
  readMetadata(recordId: string): Promise<EncryptedMetadataRecord | null>;
  deleteMetadata(recordId: string): Promise<boolean>;
  purgeExpiredMetadata(at: number): Promise<number>;
  enqueue(
    intent: SafetyJobIntent,
  ): Promise<{ duplicate: boolean; job: SafetyJob }>;
  claimDue(input: {
    readonly workerId: string;
    readonly at: number;
    readonly leaseMs: number;
    readonly limit: number;
  }): Promise<readonly ClaimedSafetyJob[]>;
  complete(input: {
    readonly jobId: string;
    readonly leaseId: string;
    readonly at: number;
  }): Promise<SafetyJob>;
  fail(input: {
    readonly jobId: string;
    readonly leaseId: string;
    readonly at: number;
    readonly failureCode: string;
    readonly retryAt: number;
  }): Promise<SafetyJob>;
  inspectJobs(): Promise<readonly SafetyJob[]>;
  exportSnapshot(): Promise<OperationsSnapshot>;
  restoreSnapshot(snapshot: OperationsSnapshot): Promise<void>;
}

export interface MetadataCipher {
  readonly currentKeyVersion: string;
  encrypt(input: {
    readonly recordId: string;
    readonly schemaVersion: number;
    readonly plaintext: Uint8Array;
  }): Promise<{
    readonly keyVersion: string;
    readonly keyProviderId?: string;
    readonly wrappedDataKey?: string;
    readonly initializationVector: string;
    readonly ciphertext: string;
  }>;
  decrypt(record: EncryptedMetadataRecord): Promise<Uint8Array>;
}

export interface SafetyJobExecutor {
  execute(
    job: SafetyJobIntent,
  ): Promise<
    | { readonly outcome: 'completed' }
    | { readonly outcome: 'retry'; readonly failureCode: string }
  >;
}

export interface OperationsFoundation {
  writeMetadata(input: {
    readonly recordId: string;
    readonly schemaVersion: number;
    readonly metadata: Readonly<Record<string, MetadataValue>>;
    readonly retainUntil?: number;
  }): Promise<void>;
  commitMetadataWithOutbox(input: {
    readonly recordId: string;
    readonly schemaVersion: number;
    readonly metadata: Readonly<Record<string, MetadataValue>>;
    readonly retainUntil?: number;
    readonly outbox: readonly SyntheticNoticeIntent[];
  }): Promise<readonly { duplicate: boolean; job: SafetyJob }[]>;
  readMetadata(
    recordId: string,
  ): Promise<Readonly<Record<string, MetadataValue>> | null>;
  deleteMetadata(recordId: string): Promise<boolean>;
  purgeExpiredMetadata(): Promise<number>;
  schedule(
    intent: SafetyJobIntent,
  ): Promise<{ duplicate: boolean; job: SafetyJob }>;
  runDue(input: {
    readonly executor: SafetyJobExecutor;
    readonly leaseMs: number;
    readonly limit: number;
    readonly retryDelayMs: number;
    readonly workerId: string;
  }): Promise<readonly SafetyJob[]>;
  inspectJobs(): Promise<readonly SafetyJob[]>;
  exportSnapshot(): Promise<OperationsSnapshot>;
  restoreSnapshot(snapshot: OperationsSnapshot): Promise<void>;
}

export type OperationsErrorCode =
  | 'ALREADY_EXISTS'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVALID_CONFIGURATION'
  | 'INVALID_INPUT'
  | 'INVALID_LEASE'
  | 'INVALID_SNAPSHOT'
  | 'NOT_FOUND'
  | 'RESTORE_SAFE_MODE';

export class OperationsError extends Error {
  readonly code: OperationsErrorCode;

  constructor(code: OperationsErrorCode, message: string) {
    super(message);
    this.name = 'OperationsError';
    this.code = code;
  }
}

interface CreateOperationsFoundationInput {
  readonly cipher: MetadataCipher;
  readonly clock: { now(): number };
  readonly store: OperationsStore;
}

export function createOperationsFoundation({
  cipher,
  clock,
  store,
}: CreateOperationsFoundationInput): OperationsFoundation {
  async function encryptedMetadata(input: {
    readonly recordId: string;
    readonly schemaVersion: number;
    readonly metadata: Readonly<Record<string, MetadataValue>>;
    readonly retainUntil?: number;
  }): Promise<EncryptedMetadataRecord> {
    validateRecordId(input.recordId);
    validateMetadata(input.metadata);
    validatePositiveSafeInteger(input.schemaVersion, 'Metadata schema version');
    const at = validNow(clock);
    const retainUntil = input.retainUntil ?? null;
    if (retainUntil !== null) {
      validateTime(retainUntil);
      if (retainUntil <= at) {
        invalid('Metadata retention must end after the write time.');
      }
    }
    const plaintext = new TextEncoder().encode(JSON.stringify(input.metadata));
    const encrypted = await cipher.encrypt({
      recordId: input.recordId,
      schemaVersion: input.schemaVersion,
      plaintext,
    });
    return {
      recordId: input.recordId,
      schemaVersion: input.schemaVersion,
      ...encrypted,
      retainUntil,
      updatedAt: at,
    };
  }

  return {
    async writeMetadata(input) {
      assertLive(store.mode);
      await store.writeMetadata(await encryptedMetadata(input));
    },
    async commitMetadataWithOutbox(input) {
      assertLive(store.mode);
      const jobIds = new Set<string>();
      for (const intent of input.outbox) {
        validateJobIntent(intent);
        if (intent.kind !== 'synthetic_notice') {
          invalid('Only synthetic notice intent may enter the Phase 3 outbox.');
        }
        if (jobIds.has(intent.jobId)) {
          invalid('One atomic outbox commit cannot repeat a job identifier.');
        }
        jobIds.add(intent.jobId);
      }
      return await store.commitMetadataAndOutbox(
        await encryptedMetadata(input),
        structuredClone(input.outbox),
      );
    },
    async readMetadata(recordId) {
      validateRecordId(recordId);
      const record = await store.readMetadata(recordId);
      if (record === null) {
        return null;
      }
      const plaintext = await cipher.decrypt(record);
      try {
        const metadata: unknown = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(plaintext),
        );
        validateMetadata(metadata);
        return metadata;
      } catch {
        throw new OperationsError(
          'INVALID_SNAPSHOT',
          'Encrypted metadata did not decode to valid JSON.',
        );
      }
    },
    async deleteMetadata(recordId) {
      assertLive(store.mode);
      validateRecordId(recordId);
      return await store.deleteMetadata(recordId);
    },
    async purgeExpiredMetadata() {
      assertLive(store.mode);
      return await store.purgeExpiredMetadata(validNow(clock));
    },
    async schedule(intent) {
      assertLive(store.mode);
      validateJobIntent(intent);
      return await store.enqueue(structuredClone(intent));
    },
    async runDue(input) {
      assertLive(store.mode);
      validateWorkerId(input.workerId);
      validatePositiveSafeInteger(input.leaseMs, 'Lease duration');
      validatePositiveSafeInteger(input.limit, 'Claim limit');
      validatePositiveSafeInteger(input.retryDelayMs, 'Retry delay');
      const at = validNow(clock);
      const claimed = await store.claimDue({
        workerId: input.workerId,
        at,
        leaseMs: input.leaseMs,
        limit: input.limit,
      });
      const settled: SafetyJob[] = [];
      for (const claim of claimed) {
        let execution:
          | { readonly outcome: 'completed' }
          | { readonly outcome: 'retry'; readonly failureCode: string };
        try {
          execution = await input.executor.execute(toIntent(claim.job));
        } catch {
          execution = { outcome: 'retry', failureCode: 'executor_exception' };
        }
        const settlementAt = validNow(clock);
        if (execution.outcome === 'completed') {
          settled.push(
            await store.complete({
              jobId: claim.job.jobId,
              leaseId: claim.leaseId,
              at: settlementAt,
            }),
          );
        } else {
          settled.push(
            await store.fail({
              jobId: claim.job.jobId,
              leaseId: claim.leaseId,
              at: settlementAt,
              failureCode: sanitizeFailureCode(execution.failureCode),
              retryAt: safeAdd(settlementAt, input.retryDelayMs),
            }),
          );
        }
      }
      return settled;
    },
    async inspectJobs() {
      return await store.inspectJobs();
    },
    async exportSnapshot() {
      const snapshot = await store.exportSnapshot();
      assertOperationsSnapshot(snapshot);
      return structuredClone(snapshot);
    },
    async restoreSnapshot(snapshot) {
      assertOperationsSnapshot(snapshot);
      await store.restoreSnapshot(structuredClone(snapshot));
    },
  };
}

export function createWebCryptoMetadataCipher(input: {
  readonly currentKeyVersion: string;
  readonly keys: Readonly<Record<string, Uint8Array>>;
  readonly randomBytes?: (length: number) => Uint8Array;
}): MetadataCipher {
  validateKeyVersion(input.currentKeyVersion);
  const keys = new Map(
    Object.entries(input.keys).map(([version, key]) => {
      validateKeyVersion(version);
      if (key.byteLength !== 32) {
        throw new OperationsError(
          'INVALID_CONFIGURATION',
          'AES-256-GCM fixture keys must contain exactly 32 bytes.',
        );
      }
      return [version, Uint8Array.from(key)] as const;
    }),
  );
  if (!keys.has(input.currentKeyVersion)) {
    throw new OperationsError(
      'INVALID_CONFIGURATION',
      'The current metadata key version is absent from the keyring.',
    );
  }
  const randomBytes =
    input.randomBytes ??
    ((length: number) =>
      globalThis.crypto.getRandomValues(new Uint8Array(length)));
  const usedInitializationVectors = new Set<string>();

  return {
    currentKeyVersion: input.currentKeyVersion,
    async encrypt({ recordId, schemaVersion, plaintext }) {
      validateRecordId(recordId);
      validatePositiveSafeInteger(schemaVersion, 'Metadata schema version');
      if (plaintext.byteLength === 0 || plaintext.byteLength > 65_536) {
        invalid('Metadata plaintext must contain between 1 and 65,536 bytes.');
      }
      const keyVersion = input.currentKeyVersion;
      const key = requireKey(keys, keyVersion);
      const initializationVector = ownedBytes(randomBytes(12));
      if (initializationVector.byteLength !== 12) {
        throw new OperationsError(
          'INVALID_CONFIGURATION',
          'AES-GCM initialization vectors must contain exactly 12 bytes.',
        );
      }
      const encodedInitializationVector = bytesToBase64(initializationVector);
      const nonceKey = `${keyVersion}:${encodedInitializationVector}`;
      if (usedInitializationVectors.has(nonceKey)) {
        throw new OperationsError(
          'INVALID_CONFIGURATION',
          'The metadata random source reused an AES-GCM initialization vector.',
        );
      }
      usedInitializationVectors.add(nonceKey);
      const encrypted = await globalThis.crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: initializationVector,
          additionalData: additionalData(recordId, schemaVersion),
          tagLength: 128,
        },
        await importAesKey(key),
        ownedBytes(plaintext),
      );
      return {
        keyVersion,
        initializationVector: encodedInitializationVector,
        ciphertext: bytesToBase64(new Uint8Array(encrypted)),
      };
    },
    async decrypt(record) {
      validateEncryptedRecord(record);
      const key = requireKey(keys, record.keyVersion);
      try {
        const plaintext = await globalThis.crypto.subtle.decrypt(
          {
            name: 'AES-GCM',
            iv: base64ToBytes(record.initializationVector),
            additionalData: additionalData(
              record.recordId,
              record.schemaVersion,
            ),
            tagLength: 128,
          },
          await importAesKey(key),
          base64ToBytes(record.ciphertext),
        );
        return new Uint8Array(plaintext);
      } catch {
        throw new OperationsError(
          'INVALID_SNAPSHOT',
          'Encrypted metadata authentication failed closed.',
        );
      }
    },
  };
}

export interface DeploymentManifest {
  readonly applicationRoles: readonly ['api', 'worker'];
  readonly database: 'postgresql';
  readonly identityAdapter: string;
  readonly notificationAdapter: string;
  readonly objectStorageAdapter: string;
  readonly restoreStartsSafe: true;
  readonly watchdogCanMutateState: false;
}

export function validateDeploymentManifest(
  manifest: DeploymentManifest,
): DeploymentManifest {
  if (
    manifest.applicationRoles.length !== 2 ||
    manifest.applicationRoles[0] !== 'api' ||
    manifest.applicationRoles[1] !== 'worker' ||
    manifest.database !== 'postgresql' ||
    manifest.restoreStartsSafe !== true ||
    manifest.watchdogCanMutateState !== false
  ) {
    throw new OperationsError(
      'INVALID_CONFIGURATION',
      'The deployment manifest violates the bounded Phase 3 topology.',
    );
  }
  for (const adapter of [
    manifest.identityAdapter,
    manifest.notificationAdapter,
    manifest.objectStorageAdapter,
  ]) {
    if (!/^[a-z][a-z0-9_-]{2,63}$/u.test(adapter)) {
      throw new OperationsError(
        'INVALID_CONFIGURATION',
        'Deployment adapters require bounded opaque identifiers, not credentials.',
      );
    }
  }
  return structuredClone(manifest);
}

export function assertOperationsSnapshot(snapshot: OperationsSnapshot): void {
  if (
    snapshot === null ||
    typeof snapshot !== 'object' ||
    !Array.isArray(snapshot.metadata) ||
    !Array.isArray(snapshot.jobs)
  ) {
    invalidSnapshot(
      'Operations snapshot must contain metadata and job arrays.',
    );
  }
  if (snapshot.schemaVersion !== OPERATIONS_SCHEMA_VERSION) {
    invalidSnapshot('Unsupported Operations snapshot schema version.');
  }
  const recordIds = new Set<string>();
  for (const record of snapshot.metadata) {
    validateEncryptedRecord(record);
    if (recordIds.has(record.recordId)) {
      invalidSnapshot('Duplicate encrypted metadata record.');
    }
    recordIds.add(record.recordId);
  }
  const jobIds = new Set<string>();
  for (const job of snapshot.jobs) {
    validateJob(job);
    if (jobIds.has(job.jobId)) {
      invalidSnapshot('Duplicate safety job.');
    }
    jobIds.add(job.jobId);
  }
}

export function validateJob(job: SafetyJob): void {
  validateJobIntent(job);
  if (
    job.status !== 'pending' &&
    job.status !== 'leased' &&
    job.status !== 'completed' &&
    job.status !== 'dead_letter'
  ) {
    invalidSnapshot('Safety job status is unsupported.');
  }
  validateTime(job.availableAt);
  validatePositiveSafeInteger(job.leaseVersion, 'Lease version', true);
  validatePositiveSafeInteger(job.attempts, 'Attempt count', true);
  if (job.attempts > job.maxAttempts) {
    invalidSnapshot('Safety job attempts exceed the configured maximum.');
  }
  if (job.status === 'leased') {
    if (
      job.leaseId === null ||
      job.leaseOwner === null ||
      job.leaseExpiresAt === null
    ) {
      invalidSnapshot('A leased safety job requires complete lease state.');
    }
    validateLeaseId(job.leaseId);
    validateWorkerId(job.leaseOwner);
    validateTime(job.leaseExpiresAt);
  } else if (
    job.leaseId !== null ||
    job.leaseOwner !== null ||
    job.leaseExpiresAt !== null
  ) {
    invalidSnapshot('Only a leased safety job may retain lease state.');
  }
  if (job.status === 'completed' && job.completedAt === null) {
    invalidSnapshot('A completed safety job requires its completion time.');
  }
  if (job.status !== 'completed' && job.completedAt !== null) {
    invalidSnapshot(
      'Only a completed safety job may retain a completion time.',
    );
  }
  if (job.status === 'pending' && job.attempts >= job.maxAttempts) {
    invalidSnapshot('A pending safety job must retain an available attempt.');
  }
  if (job.completedAt !== null) {
    validateTime(job.completedAt);
  }
  if (job.lastFailureCode !== null) {
    sanitizeFailureCode(job.lastFailureCode);
  }
}

export function validateJobIntent(intent: SafetyJobIntent): void {
  validateJobId(intent.jobId);
  validateCommandKey(intent.commandKey);
  validateTime(intent.dueAt);
  validatePositiveSafeInteger(intent.maxAttempts, 'Maximum attempts');
  if (intent.maxAttempts > 100) {
    invalid('Maximum attempts cannot exceed 100.');
  }
  if (intent.kind === 'advance_plan_stage') {
    if (
      !/^(?:[a-z][a-z0-9_-]{7,63}|plan_[a-f0-9]{64})$/u.test(intent.planRef)
    ) {
      invalid('Scheduled Plan references must be opaque.');
    }
  } else if (intent.kind === 'synthetic_notice') {
    if (!/^channel_[a-f0-9]{64}$/u.test(intent.channelRef)) {
      invalid('Notification channel references must be opaque.');
    }
    if (
      intent.template !== 'owner_security_notice' &&
      intent.template !== 'synthetic_rehearsal'
    ) {
      invalid('Notification jobs require a bounded content-free template.');
    }
  } else {
    invalid('Safety job kind is unsupported.');
  }
}

export function validateEncryptedRecord(record: EncryptedMetadataRecord): void {
  validateRecordId(record.recordId);
  validatePositiveSafeInteger(record.schemaVersion, 'Metadata schema version');
  validateKeyVersion(record.keyVersion);
  validateTime(record.updatedAt);
  if (record.retainUntil !== null) {
    validateTime(record.retainUntil);
  }
  if (!isBase64(record.initializationVector) || !isBase64(record.ciphertext)) {
    invalidSnapshot('Encrypted metadata must use bounded base64 fields.');
  }
  if (
    (record.keyProviderId === undefined) !==
      (record.wrappedDataKey === undefined) ||
    (record.keyProviderId !== undefined &&
      !/^[a-z][a-z0-9_-]{2,63}$/u.test(record.keyProviderId)) ||
    (record.wrappedDataKey !== undefined && !isBase64(record.wrappedDataKey))
  ) {
    invalidSnapshot(
      'Wrapped metadata keys require a bounded provider and base64 envelope.',
    );
  }
  if (base64ToBytes(record.initializationVector).byteLength !== 12) {
    invalidSnapshot(
      'Encrypted metadata requires a 12-byte initialization vector.',
    );
  }
}

export function assertLive(mode: StoreMode): void {
  if (mode === 'restore_safe') {
    throw new OperationsError(
      'RESTORE_SAFE_MODE',
      'Restore-safe mode rejects metadata writes and safety-job execution.',
    );
  }
}

export function createPendingJob(intent: SafetyJobIntent): SafetyJob {
  validateJobIntent(intent);
  return {
    ...structuredClone(intent),
    status: 'pending',
    attempts: 0,
    availableAt: intent.dueAt,
    leaseId: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    leaseVersion: 0,
    completedAt: null,
    lastFailureCode: null,
  };
}

export function sameIntent(job: SafetyJob, intent: SafetyJobIntent): boolean {
  return JSON.stringify(toIntent(job)) === JSON.stringify(intent);
}

export function toIntent(job: SafetyJob): SafetyJobIntent {
  return job.kind === 'advance_plan_stage'
    ? {
        kind: job.kind,
        jobId: job.jobId,
        planRef: job.planRef,
        commandKey: job.commandKey,
        dueAt: job.dueAt,
        maxAttempts: job.maxAttempts,
      }
    : {
        kind: job.kind,
        jobId: job.jobId,
        channelRef: job.channelRef,
        template: job.template,
        commandKey: job.commandKey,
        dueAt: job.dueAt,
        maxAttempts: job.maxAttempts,
      };
}

function additionalData(
  recordId: string,
  schemaVersion: number,
): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    `vidha:encrypted-metadata:v1:${recordId}:${schemaVersion}`,
  );
}

async function importAesKey(key: Uint8Array): Promise<CryptoKey> {
  return await globalThis.crypto.subtle.importKey(
    'raw',
    ownedBytes(key),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  );
}

function requireKey(
  keys: ReadonlyMap<string, Uint8Array>,
  version: string,
): Uint8Array {
  const key = keys.get(version);
  if (key === undefined) {
    throw new OperationsError(
      'INVALID_CONFIGURATION',
      `Metadata key version ${version} is unavailable.`,
    );
  }
  return Uint8Array.from(key);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function ownedBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  return owned;
}

function isBase64(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 1_000_000 &&
    value.length % 4 === 0 &&
    /^[A-Za-z0-9+/]+={0,2}$/u.test(value)
  );
}

function validateMetadata(
  value: unknown,
): asserts value is Readonly<Record<string, MetadataValue>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid('Metadata must be a flat bounded object.');
  }
  const entries = Object.entries(value);
  if (entries.length > 100) {
    invalid('Metadata cannot contain more than 100 fields.');
  }
  for (const [key, entry] of entries) {
    if (!/^[a-z][a-z0-9_]{0,63}$/u.test(key)) {
      invalid('Metadata field names must be bounded identifiers.');
    }
    if (
      entry !== null &&
      typeof entry !== 'string' &&
      typeof entry !== 'number' &&
      typeof entry !== 'boolean'
    ) {
      invalid('Metadata values must be scalar JSON values.');
    }
    if (typeof entry === 'string' && entry.length > 4_096) {
      invalid('Metadata string values cannot exceed 4,096 characters.');
    }
    if (typeof entry === 'number' && !Number.isFinite(entry)) {
      invalid('Metadata numeric values must be finite.');
    }
  }
}

function validateRecordId(value: string): void {
  if (!/^metadata_[a-f0-9]{64}$/u.test(value)) {
    invalid('Metadata record identifiers must be opaque.');
  }
}

function validateKeyVersion(value: string): void {
  if (!/^key_[a-z0-9_-]{1,32}$/u.test(value)) {
    throw new OperationsError(
      'INVALID_CONFIGURATION',
      'Metadata key versions require bounded identifiers.',
    );
  }
}

function validateJobId(value: string): void {
  if (!/^job_[a-f0-9]{64}$/u.test(value)) {
    invalid('Safety job identifiers must be opaque.');
  }
}

function validateCommandKey(value: string): void {
  if (!/^cmd_[a-f0-9]{64}$/u.test(value)) {
    invalid('Safety jobs require opaque semantic command identifiers.');
  }
}

function validateWorkerId(value: string): void {
  if (!/^worker_[a-z0-9_-]{3,63}$/u.test(value)) {
    invalid('Worker identifiers must be bounded and content-free.');
  }
}

function validateLeaseId(value: string): void {
  if (!/^lease_[a-f0-9]{64}_[1-9][0-9]*$/u.test(value)) {
    invalidSnapshot('Lease identifiers are malformed.');
  }
}

function sanitizeFailureCode(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,63}$/u.test(value)) {
    invalid('Failure codes must be bounded and content-free.');
  }
  return value;
}

function validNow(clock: { now(): number }): number {
  const at = clock.now();
  validateTime(at);
  return at;
}

function validateTime(value: number): void {
  if (!Number.isSafeInteger(value)) {
    invalid('Operations time must be a safe integer.');
  }
}

function validatePositiveSafeInteger(
  value: number,
  label: string,
  allowZero = false,
): void {
  if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value <= 0)) {
    invalid(
      `${label} must be ${allowZero ? 'a non-negative' : 'a positive'} safe integer.`,
    );
  }
}

function safeAdd(left: number, right: number): number {
  const value = left + right;
  validateTime(value);
  return value;
}

function invalid(message: string): never {
  throw new OperationsError('INVALID_INPUT', message);
}

function invalidSnapshot(message: string): never {
  throw new OperationsError('INVALID_SNAPSHOT', message);
}
