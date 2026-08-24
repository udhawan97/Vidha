import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FileBackupInventory } from './fileBackupInventory';

const roots: string[] = [];
const START = Date.parse('2026-08-24T12:00:00.000Z');

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe('external file backup inventory', () => {
  it('advances monotonically and retires only an exact non-current generation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vidha-backup-inventory-'));
    roots.push(root);
    let now = START;
    const inventory = new FileBackupInventory(join(root, 'inventory.json'), {
      now: () => now,
    });
    await inventory.write({
      generation: 1,
      manifestDigest: 'a'.repeat(64),
    });
    now += 1;
    await inventory.write({
      generation: 2,
      manifestDigest: 'b'.repeat(64),
    });

    await expect(
      inventory.recordDeletion({
        at: now + 1,
        generation: 2,
        manifestDigest: 'b'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_SNAPSHOT' });
    await inventory.recordDeletion({
      at: now + 1,
      generation: 1,
      manifestDigest: 'a'.repeat(64),
    });

    await expect(inventory.read()).resolves.toEqual({
      generation: 2,
      manifestDigest: 'b'.repeat(64),
    });
    await expect(inventory.history()).resolves.toEqual([
      expect.objectContaining({ generation: 1, status: 'deleted' }),
      expect.objectContaining({ generation: 2, status: 'retained' }),
    ]);
    await expect(
      inventory.write({
        generation: 4,
        manifestDigest: 'c'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_SNAPSHOT' });
  });
});
