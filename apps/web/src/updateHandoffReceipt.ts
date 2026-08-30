export const UPDATE_HANDOFF_STORAGE_KEY = 'vidha.update-handoff.v1';

const UPDATE_HANDOFF_PROTOCOL = 'vidha.update-handoff.v1';
const BUILD_IDENTITY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/u;

export interface UpdateHandoffStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

interface UpdateHandoffRecord {
  readonly protocol: typeof UPDATE_HANDOFF_PROTOCOL;
  readonly sourceBuildIdentity: string;
}

export interface UpdateHandoffReceipt {
  readonly currentBuildIdentity: string;
  readonly outcome: 'changed-build' | 'unverified';
  readonly sourceBuildIdentity: string;
}

export function isBuildIdentity(value: unknown): value is string {
  return typeof value === 'string' && BUILD_IDENTITY_PATTERN.test(value);
}

export function buildIdentityLabel(identity: string): string {
  return identity.length > 12 ? identity.slice(0, 12) : identity;
}

function isUpdateHandoffRecord(value: unknown): value is UpdateHandoffRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).sort().join(',') === 'protocol,sourceBuildIdentity' &&
    record.protocol === UPDATE_HANDOFF_PROTOCOL &&
    isBuildIdentity(record.sourceBuildIdentity)
  );
}

export function recordUpdateHandoff(
  storage: UpdateHandoffStorage | null,
  sourceBuildIdentity: string,
): boolean {
  if (storage === null || !isBuildIdentity(sourceBuildIdentity)) return false;
  const record: UpdateHandoffRecord = {
    protocol: UPDATE_HANDOFF_PROTOCOL,
    sourceBuildIdentity,
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
    if (!isUpdateHandoffRecord(record)) return null;
    return {
      currentBuildIdentity,
      outcome:
        record.sourceBuildIdentity === currentBuildIdentity
          ? 'unverified'
          : 'changed-build',
      sourceBuildIdentity: record.sourceBuildIdentity,
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
