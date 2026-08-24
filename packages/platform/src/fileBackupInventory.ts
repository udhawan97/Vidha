import { dirname, isAbsolute } from 'node:path';
import { open, readFile, rename, unlink, writeFile } from 'node:fs/promises';

import { OperationsError, type BackupInventory } from '@vidha/operations';

export interface FileBackupInventoryEntry {
  readonly deletedAt: number | null;
  readonly generation: number;
  readonly manifestDigest: string;
  readonly registeredAt: number;
  readonly status: 'retained' | 'deleted';
}

interface InventoryDocument {
  readonly entries: readonly FileBackupInventoryEntry[];
  readonly schemaVersion: 1;
}

export class FileBackupInventory implements BackupInventory {
  private readonly lockPath: string;

  constructor(
    private readonly inventoryPath: string,
    private readonly clock: { now(): number },
  ) {
    if (!isAbsolute(inventoryPath) || !inventoryPath.endsWith('.json')) {
      throw new OperationsError(
        'INVALID_CONFIGURATION',
        'The external backup inventory requires an absolute JSON path.',
      );
    }
    this.lockPath = `${inventoryPath}.lock`;
  }

  async read() {
    const document = await this.readDocument();
    const current = document.entries.at(-1);
    if (current === undefined) return null;
    if (current.status !== 'retained') {
      invalid('The current external backup generation cannot be deleted.');
    }
    return {
      generation: current.generation,
      manifestDigest: current.manifestDigest,
    };
  }

  async write(entry: {
    readonly generation: number;
    readonly manifestDigest: string;
  }): Promise<void> {
    await this.withLock(async () => {
      const document = await this.readDocument();
      const previous = document.entries.at(-1);
      if (
        !Number.isSafeInteger(entry.generation) ||
        entry.generation <= 0 ||
        !/^[a-f0-9]{64}$/u.test(entry.manifestDigest) ||
        entry.generation !== (previous?.generation ?? 0) + 1
      ) {
        invalid(
          'External backup inventory generations must increase by exactly one.',
        );
      }
      await this.writeDocument({
        entries: [
          ...document.entries,
          {
            deletedAt: null,
            generation: entry.generation,
            manifestDigest: entry.manifestDigest,
            registeredAt: validTime(this.clock.now()),
            status: 'retained',
          },
        ],
        schemaVersion: 1,
      });
    });
  }

  async history(): Promise<readonly FileBackupInventoryEntry[]> {
    return structuredClone((await this.readDocument()).entries);
  }

  async recordDeletion(input: {
    readonly at: number;
    readonly generation: number;
    readonly manifestDigest: string;
  }): Promise<void> {
    await this.withLock(async () => {
      const document = await this.readDocument();
      const current = document.entries.at(-1);
      const entry = document.entries.find(
        (candidate) => candidate.generation === input.generation,
      );
      if (
        entry === undefined ||
        entry.manifestDigest !== input.manifestDigest ||
        entry.status !== 'retained' ||
        current?.generation === entry.generation ||
        validTime(input.at) < entry.registeredAt
      ) {
        invalid(
          'Only an exact retained non-current backup generation may be retired.',
        );
      }
      await this.writeDocument({
        entries: document.entries.map((candidate) =>
          candidate.generation === input.generation
            ? { ...candidate, deletedAt: input.at, status: 'deleted' as const }
            : candidate,
        ),
        schemaVersion: 1,
      });
    });
  }

  private async readDocument(): Promise<InventoryDocument> {
    let raw: string;
    try {
      raw = await readFile(this.inventoryPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { entries: [], schemaVersion: 1 };
      }
      throw error;
    }
    try {
      return validateDocument(JSON.parse(raw) as unknown);
    } catch (error) {
      if (error instanceof OperationsError) throw error;
      invalid('The external backup inventory is malformed.');
    }
  }

  private async writeDocument(document: InventoryDocument): Promise<void> {
    const temporaryPath = `${this.inventoryPath}.next`;
    await writeFile(temporaryPath, `${JSON.stringify(document)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    try {
      await rename(temporaryPath, this.inventoryPath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    if (dirname(this.inventoryPath) === this.inventoryPath) {
      throw new OperationsError(
        'INVALID_CONFIGURATION',
        'The external backup inventory path has no parent directory.',
      );
    }
    let handle;
    try {
      handle = await open(this.lockPath, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new OperationsError(
          'IDEMPOTENCY_CONFLICT',
          'The external backup inventory is already being updated.',
        );
      }
      throw error;
    }
    try {
      return await operation();
    } finally {
      await handle.close();
      await unlink(this.lockPath).catch(() => undefined);
    }
  }
}

function validateDocument(value: unknown): InventoryDocument {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    (value as { schemaVersion?: unknown }).schemaVersion !== 1 ||
    !Array.isArray((value as { entries?: unknown }).entries)
  ) {
    invalid('The external backup inventory is malformed.');
  }
  const entries = (value as { entries: unknown[] }).entries;
  let previousGeneration = 0;
  const parsed = entries.map((entry, index): FileBackupInventoryEntry => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      invalid('The external backup inventory is malformed.');
    }
    const candidate = entry as FileBackupInventoryEntry;
    if (
      candidate.generation !== previousGeneration + 1 ||
      !/^[a-f0-9]{64}$/u.test(candidate.manifestDigest) ||
      !Number.isSafeInteger(candidate.registeredAt) ||
      candidate.registeredAt < 0 ||
      (candidate.status !== 'retained' && candidate.status !== 'deleted') ||
      (candidate.status === 'retained' && candidate.deletedAt !== null) ||
      (candidate.status === 'deleted' &&
        (candidate.deletedAt === null ||
          !Number.isSafeInteger(candidate.deletedAt) ||
          candidate.deletedAt < candidate.registeredAt)) ||
      (index === entries.length - 1 && candidate.status !== 'retained')
    ) {
      invalid('The external backup inventory is malformed.');
    }
    previousGeneration = candidate.generation;
    return { ...candidate };
  });
  return { entries: parsed, schemaVersion: 1 };
}

function validTime(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    invalid('Backup inventory times must be non-negative safe integers.');
  }
  return value;
}

function invalid(message: string): never {
  throw new OperationsError('INVALID_SNAPSHOT', message);
}
