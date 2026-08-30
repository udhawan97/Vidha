import { isBuildIdentity } from './buildIdentity';

export const UPDATE_HANDOFF_STORAGE_KEY = 'vidha.update-handoff.v1';

const LEGACY_UPDATE_HANDOFF_PROTOCOL = 'vidha.update-handoff.v1';
const UPDATE_HANDOFF_PROTOCOL = 'vidha.update-handoff.v2';

export interface UpdateHandoffStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

interface LegacyUpdateHandoffRecord {
  readonly protocol: typeof LEGACY_UPDATE_HANDOFF_PROTOCOL;
  readonly sourceBuildIdentity: string;
}

interface UpdateHandoffRecord {
  readonly protocol: typeof UPDATE_HANDOFF_PROTOCOL;
  readonly sourceBuildIdentity: string;
  readonly targetBuildIdentity: string;
}

export interface UpdateHandoffReceipt {
  readonly currentBuildIdentity: string;
  readonly outcome:
    'changed-build' | 'expected-build' | 'unexpected-build' | 'unverified';
  readonly sourceBuildIdentity: string;
  readonly targetBuildIdentity: string | null;
}

function isLegacyUpdateHandoffRecord(
  value: unknown,
): value is LegacyUpdateHandoffRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).sort().join(',') === 'protocol,sourceBuildIdentity' &&
    record.protocol === LEGACY_UPDATE_HANDOFF_PROTOCOL &&
    isBuildIdentity(record.sourceBuildIdentity)
  );
}

function isUpdateHandoffRecord(value: unknown): value is UpdateHandoffRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).sort().join(',') ===
      'protocol,sourceBuildIdentity,targetBuildIdentity' &&
    record.protocol === UPDATE_HANDOFF_PROTOCOL &&
    isBuildIdentity(record.sourceBuildIdentity) &&
    isBuildIdentity(record.targetBuildIdentity)
  );
}

export function recordUpdateHandoff(
  storage: UpdateHandoffStorage | null,
  sourceBuildIdentity: string,
  targetBuildIdentity: string,
): boolean {
  if (
    storage === null ||
    !isBuildIdentity(sourceBuildIdentity) ||
    !isBuildIdentity(targetBuildIdentity) ||
    sourceBuildIdentity === targetBuildIdentity
  )
    return false;
  const record: UpdateHandoffRecord = {
    protocol: UPDATE_HANDOFF_PROTOCOL,
    sourceBuildIdentity,
    targetBuildIdentity,
  };
  try {
    storage.setItem(UPDATE_HANDOFF_STORAGE_KEY, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

export function readUpdateHandoffReceipt(
  storage: UpdateHandoffStorage | null,
  currentBuildIdentity: string,
): UpdateHandoffReceipt | null {
  if (storage === null || !isBuildIdentity(currentBuildIdentity)) return null;
  try {
    const serialized = storage.getItem(UPDATE_HANDOFF_STORAGE_KEY);
    if (serialized === null) return null;
    const record: unknown = JSON.parse(serialized);
    if (isLegacyUpdateHandoffRecord(record)) {
      return {
        currentBuildIdentity,
        outcome:
          record.sourceBuildIdentity === currentBuildIdentity
            ? 'unverified'
            : 'changed-build',
        sourceBuildIdentity: record.sourceBuildIdentity,
        targetBuildIdentity: null,
      };
    }
    if (
      !isUpdateHandoffRecord(record) ||
      record.sourceBuildIdentity === record.targetBuildIdentity
    )
      return null;
    return {
      currentBuildIdentity,
      outcome:
        record.targetBuildIdentity === currentBuildIdentity
          ? 'expected-build'
          : 'unexpected-build',
      sourceBuildIdentity: record.sourceBuildIdentity,
      targetBuildIdentity: record.targetBuildIdentity,
    };
  } catch {
    return null;
  }
}

export function clearUpdateHandoffRecord(
  storage: UpdateHandoffStorage | null,
): void {
  try {
    storage?.removeItem(UPDATE_HANDOFF_STORAGE_KEY);
  } catch {
    // A blocked cleanup can only leave a content-free, schema-bounded record.
  }
}

export function browserUpdateHandoffStorage(): UpdateHandoffStorage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
