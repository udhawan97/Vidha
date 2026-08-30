import { describe, expect, it, vi } from 'vitest';

import {
  buildIdentityLabel,
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
  it('records only a protocol and the outgoing build identity', () => {
    const storage = memoryStorage();

    expect(recordUpdateHandoff(storage, 'build-source-123')).toBe(true);

    expect(
      JSON.parse(storage.getItem(UPDATE_HANDOFF_STORAGE_KEY) ?? ''),
    ).toEqual({
      protocol: 'vidha.update-handoff.v1',
      sourceBuildIdentity: 'build-source-123',
    });
  });

  it('distinguishes a changed page build from an unverified return', () => {
    const storage = memoryStorage();
    recordUpdateHandoff(storage, 'build-source-123');

    expect(readUpdateHandoffReceipt(storage, 'build-target-456')).toEqual({
      currentBuildIdentity: 'build-target-456',
      outcome: 'changed-build',
      sourceBuildIdentity: 'build-source-123',
    });
    expect(readUpdateHandoffReceipt(storage, 'build-source-123')).toEqual({
      currentBuildIdentity: 'build-source-123',
      outcome: 'unverified',
      sourceBuildIdentity: 'build-source-123',
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

    expect(recordUpdateHandoff(storage, 'build-source')).toBe(false);
    expect(readUpdateHandoffReceipt(storage, 'build-target')).toBeNull();
    expect(() => clearUpdateHandoffRecord(storage)).not.toThrow();
  });

  it('keeps displayed build identities bounded', () => {
    expect(buildIdentityLabel('short-build')).toBe('short-build');
    expect(buildIdentityLabel('1234567890abcdefghijkl')).toBe('1234567890ab');
  });
});
