import { describe, expect, it, vi } from 'vitest';

import { buildIdentityLabel } from './buildIdentity';
import {
  clearUpdateHandoffRecord,
  readUpdateHandoffReceipt,
  recordUpdateHandoff,
  UPDATE_HANDOFF_STORAGE_KEY,
  type UpdateHandoffStorage,
} from './updateHandoffReceipt';

function memoryStorage(): UpdateHandoffStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  };
}

describe('update handoff receipt', () => {
  it('records only a protocol and the outgoing and expected build identities', () => {
    const storage = memoryStorage();

    expect(
      recordUpdateHandoff(storage, 'build-source-123', 'build-target-456'),
    ).toBe(true);

    expect(
      JSON.parse(storage.getItem(UPDATE_HANDOFF_STORAGE_KEY) ?? ''),
    ).toEqual({
      protocol: 'vidha.update-handoff.v2',
      sourceBuildIdentity: 'build-source-123',
      targetBuildIdentity: 'build-target-456',
    });
  });

  it('distinguishes the expected page build from an unexpected return', () => {
    const storage = memoryStorage();
    recordUpdateHandoff(storage, 'build-source-123', 'build-target-456');

    expect(readUpdateHandoffReceipt(storage, 'build-target-456')).toEqual({
      currentBuildIdentity: 'build-target-456',
      outcome: 'expected-build',
      sourceBuildIdentity: 'build-source-123',
      targetBuildIdentity: 'build-target-456',
    });
    expect(readUpdateHandoffReceipt(storage, 'build-source-123')).toEqual({
      currentBuildIdentity: 'build-source-123',
      outcome: 'unexpected-build',
      sourceBuildIdentity: 'build-source-123',
      targetBuildIdentity: 'build-target-456',
    });
  });

  it('still reads a legacy content-free handoff without inventing a target', () => {
    const storage = memoryStorage();
    storage.setItem(
      UPDATE_HANDOFF_STORAGE_KEY,
      JSON.stringify({
        protocol: 'vidha.update-handoff.v1',
        sourceBuildIdentity: 'build-source-123',
      }),
    );

    expect(readUpdateHandoffReceipt(storage, 'build-target-456')).toEqual({
      currentBuildIdentity: 'build-target-456',
      outcome: 'changed-build',
      sourceBuildIdentity: 'build-source-123',
      targetBuildIdentity: null,
    });
  });

  it('rejects malformed, content-bearing, and invalid build records', () => {
    const storage = memoryStorage();
    const invalid = [
      '{',
      JSON.stringify({
        protocol: 'vidha.update-handoff.v1',
        sourceBuildIdentity: 'build-source',
        envelopeTitle: 'must not cross the handoff',
      }),
      JSON.stringify({
        protocol: 'vidha.update-handoff.v1',
        sourceBuildIdentity: '<script>',
      }),
      JSON.stringify({
        protocol: 'vidha.update-handoff.v2',
        sourceBuildIdentity: 'build-source',
        targetBuildIdentity: 'build-target',
        recipient: 'must not cross the handoff',
      }),
      JSON.stringify({
        protocol: 'vidha.update-handoff.v2',
        sourceBuildIdentity: 'same-build',
        targetBuildIdentity: 'same-build',
      }),
    ];

    for (const serialized of invalid) {
      storage.setItem(UPDATE_HANDOFF_STORAGE_KEY, serialized);
      expect(readUpdateHandoffReceipt(storage, 'build-target')).toBeNull();
    }
  });

  it('fails closed when tab-scoped storage is unavailable', () => {
    const storage: UpdateHandoffStorage = {
      getItem: () => {
        throw new Error('blocked read');
      },
      removeItem: vi.fn(() => {
        throw new Error('blocked cleanup');
      }),
      setItem: () => {
        throw new Error('blocked write');
      },
    };

    expect(recordUpdateHandoff(storage, 'build-source', 'build-target')).toBe(
      false,
    );
    expect(readUpdateHandoffReceipt(storage, 'build-target')).toBeNull();
    expect(() => clearUpdateHandoffRecord(storage)).not.toThrow();
  });

  it('refuses a handoff without two distinct valid identities', () => {
    const storage = memoryStorage();

    expect(recordUpdateHandoff(storage, 'same-build', 'same-build')).toBe(
      false,
    );
    expect(recordUpdateHandoff(storage, 'bad identity', 'target')).toBe(false);
    expect(recordUpdateHandoff(storage, 'source', '<target>')).toBe(false);
    expect(storage.getItem(UPDATE_HANDOFF_STORAGE_KEY)).toBeNull();
  });

  it('keeps displayed build identities bounded', () => {
    expect(buildIdentityLabel('short-build')).toBe('short-build');
    expect(buildIdentityLabel('1234567890abcdefghijkl')).toBe('1234567890ab');
  });
});
