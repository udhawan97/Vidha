import {
  parseEditableDocument,
  serializeEditableDocument,
  type EditableDocumentV1,
} from './editableDocument';

export const EDITABLE_DOCUMENT_HISTORY_SCHEMA =
  'vidha.editable-document-history';
export const EDITABLE_DOCUMENT_HISTORY_SCHEMA_VERSION = 1 as const;
export const MAX_EDITABLE_DOCUMENT_VERSIONS = 6;
const MAX_DATE_TIMESTAMP = 8_640_000_000_000_000;
const MAX_NEXT_VERSION_NUMBER = Number.MAX_SAFE_INTEGER - 1;

export interface EditableDocumentVersionV1 {
  readonly versionId: string;
  readonly versionNumber: number;
  readonly savedAt: number;
  readonly document: EditableDocumentV1;
}

export interface EditableDocumentHistoryV1 {
  readonly schema: typeof EDITABLE_DOCUMENT_HISTORY_SCHEMA;
  readonly schemaVersion: typeof EDITABLE_DOCUMENT_HISTORY_SCHEMA_VERSION;
  readonly nextVersionNumber: number;
  readonly versions: readonly EditableDocumentVersionV1[];
}

export interface EditableDocumentDifference {
  readonly hasChanges: boolean;
  readonly markdownChanged: boolean;
  readonly recipientChanged: boolean;
  readonly titleChanged: boolean;
}

export interface SaveEditableDocumentVersionResult {
  readonly created: boolean;
  readonly history: EditableDocumentHistoryV1;
  readonly version: EditableDocumentVersionV1;
}

export interface EditableDocumentRestorePlan {
  readonly changes: EditableDocumentDifference;
  readonly document: EditableDocumentV1;
  readonly history: EditableDocumentHistoryV1;
  readonly preservedCurrentVersion: EditableDocumentVersionV1 | null;
  readonly targetVersion: EditableDocumentVersionV1;
}

export class EditableDocumentHistoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EditableDocumentHistoryError';
  }
}

export function createEditableDocumentHistory(): EditableDocumentHistoryV1 {
  return {
    schema: EDITABLE_DOCUMENT_HISTORY_SCHEMA,
    schemaVersion: EDITABLE_DOCUMENT_HISTORY_SCHEMA_VERSION,
    nextVersionNumber: 1,
    versions: [],
  };
}

export function saveEditableDocumentVersion(
  history: EditableDocumentHistoryV1,
  document: EditableDocumentV1,
  savedAt: number,
): SaveEditableDocumentVersionResult {
  const validHistory = validateHistory(history);
  const validDocument = cloneDocument(document);
  validateTimestamp(savedAt);

  const latest = validHistory.versions[0];
  if (
    latest !== undefined &&
    serializeEditableDocument(latest.document) ===
      serializeEditableDocument(validDocument)
  ) {
    return {
      created: false,
      history: validHistory,
      version: cloneVersion(latest),
    };
  }

  const versionNumber = validHistory.nextVersionNumber;
  if (versionNumber >= MAX_NEXT_VERSION_NUMBER) {
    throw new EditableDocumentHistoryError(
      'The Editable Document history has exhausted its safe version identities.',
    );
  }
  const version: EditableDocumentVersionV1 = {
    versionId: `version-${versionNumber}`,
    versionNumber,
    savedAt,
    document: validDocument,
  };
  const nextHistory: EditableDocumentHistoryV1 = {
    schema: EDITABLE_DOCUMENT_HISTORY_SCHEMA,
    schemaVersion: EDITABLE_DOCUMENT_HISTORY_SCHEMA_VERSION,
    nextVersionNumber: versionNumber + 1,
    versions: [version, ...validHistory.versions]
      .slice(0, MAX_EDITABLE_DOCUMENT_VERSIONS)
      .map(cloneVersion),
  };
  return {
    created: true,
    history: nextHistory,
    version: cloneVersion(version),
  };
}

export function planEditableDocumentRestore(
  history: EditableDocumentHistoryV1,
  currentDocument: EditableDocumentV1,
  targetVersionId: string,
  savedAt: number,
): EditableDocumentRestorePlan {
  const validHistory = validateHistory(history);
  const validCurrent = cloneDocument(currentDocument);
  const target = validHistory.versions.find(
    (version) => version.versionId === targetVersionId,
  );
  if (target === undefined) {
    throw new EditableDocumentHistoryError(
      'The requested Document Version is not available in this session.',
    );
  }

  const changes = compareDocuments(validCurrent, target.document);
  if (!changes.hasChanges) {
    return {
      changes,
      document: cloneDocument(target.document),
      history: validHistory,
      preservedCurrentVersion: null,
      targetVersion: cloneVersion(target),
    };
  }

  const preserved = saveEditableDocumentVersion(
    validHistory,
    validCurrent,
    savedAt,
  );
  const restoreHistory = preserveRestoreTarget(validHistory, preserved, target);
  return {
    changes,
    document: cloneDocument(target.document),
    history: restoreHistory,
    preservedCurrentVersion: cloneVersion(preserved.version),
    targetVersion: cloneVersion(target),
  };
}

function preserveRestoreTarget(
  previousHistory: EditableDocumentHistoryV1,
  preserved: SaveEditableDocumentVersionResult,
  target: EditableDocumentVersionV1,
): EditableDocumentHistoryV1 {
  if (
    !preserved.created ||
    preserved.history.versions.some(
      (version) => version.versionId === target.versionId,
    )
  ) {
    return preserved.history;
  }

  const retainedPrevious = previousHistory.versions
    .filter((version) => version.versionId !== target.versionId)
    .slice(0, MAX_EDITABLE_DOCUMENT_VERSIONS - 2);
  const versions = [preserved.version, ...retainedPrevious, target]
    .sort((left, right) => right.versionNumber - left.versionNumber)
    .map(cloneVersion);
  return {
    schema: EDITABLE_DOCUMENT_HISTORY_SCHEMA,
    schemaVersion: EDITABLE_DOCUMENT_HISTORY_SCHEMA_VERSION,
    nextVersionNumber: preserved.history.nextVersionNumber,
    versions,
  };
}

function compareDocuments(
  current: EditableDocumentV1,
  target: EditableDocumentV1,
): EditableDocumentDifference {
  const titleChanged = current.title !== target.title;
  const recipientChanged = current.recipientLabel !== target.recipientLabel;
  const markdownChanged = current.markdown !== target.markdown;
  return {
    hasChanges: titleChanged || recipientChanged || markdownChanged,
    markdownChanged,
    recipientChanged,
    titleChanged,
  };
}

function validateHistory(
  history: EditableDocumentHistoryV1,
): EditableDocumentHistoryV1 {
  if (typeof history !== 'object' || history === null) {
    invalidHistory();
  }
  const candidate = history as unknown as Record<string, unknown>;
  const fields = Object.keys(candidate).sort();
  const expected = ['nextVersionNumber', 'schema', 'schemaVersion', 'versions'];
  const schema = candidate.schema;
  const schemaVersion = candidate.schemaVersion;
  const nextVersionNumberValue = candidate.nextVersionNumber;
  const versionsValue = candidate.versions;
  if (
    fields.length !== expected.length ||
    fields.some((field, index) => field !== expected[index]) ||
    schema !== EDITABLE_DOCUMENT_HISTORY_SCHEMA ||
    schemaVersion !== EDITABLE_DOCUMENT_HISTORY_SCHEMA_VERSION ||
    !Number.isSafeInteger(nextVersionNumberValue) ||
    (nextVersionNumberValue as number) < 1 ||
    (nextVersionNumberValue as number) > MAX_NEXT_VERSION_NUMBER ||
    !Array.isArray(versionsValue) ||
    versionsValue.length > MAX_EDITABLE_DOCUMENT_VERSIONS
  ) {
    invalidHistory();
  }

  const nextVersionNumber = nextVersionNumberValue as number;
  const versions = Array.from(versionsValue as unknown[], (version) =>
    validateVersion(version, nextVersionNumber),
  );
  if (
    (versions.length === 0 && nextVersionNumber !== 1) ||
    (versions.length > 0 &&
      versions[0]?.versionNumber !== nextVersionNumber - 1) ||
    new Set(versions.map((version) => version.versionNumber)).size !==
      versions.length ||
    versions.some(
      (version, index) =>
        index > 0 &&
        version.versionNumber >=
          (versions[index - 1]?.versionNumber ?? Number.POSITIVE_INFINITY),
    )
  ) {
    invalidHistory();
  }
  return {
    schema: EDITABLE_DOCUMENT_HISTORY_SCHEMA,
    schemaVersion: EDITABLE_DOCUMENT_HISTORY_SCHEMA_VERSION,
    nextVersionNumber,
    versions,
  };
}

function validateVersion(
  value: unknown,
  nextVersionNumber: number,
): EditableDocumentVersionV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalidHistory();
  }
  const candidate = value as Record<string, unknown>;
  const fields = Object.keys(candidate).sort();
  const expected = ['document', 'savedAt', 'versionId', 'versionNumber'];
  const versionId = candidate.versionId;
  const versionNumberValue = candidate.versionNumber;
  const savedAtValue = candidate.savedAt;
  const documentValue = candidate.document;
  if (
    fields.length !== expected.length ||
    fields.some((field, index) => field !== expected[index]) ||
    !Number.isSafeInteger(versionNumberValue) ||
    (versionNumberValue as number) < 1 ||
    (versionNumberValue as number) >= nextVersionNumber ||
    versionId !== `version-${String(versionNumberValue)}` ||
    !isValidTimestamp(savedAtValue)
  ) {
    invalidHistory();
  }
  let document: EditableDocumentV1;
  try {
    document = cloneDocument(documentValue as EditableDocumentV1);
  } catch {
    invalidHistory();
  }
  return {
    versionId: versionId as string,
    versionNumber: versionNumberValue as number,
    savedAt: savedAtValue as number,
    document,
  };
}

function validateTimestamp(savedAt: number): void {
  if (!isValidTimestamp(savedAt)) {
    throw new EditableDocumentHistoryError(
      'A Document Version timestamp must be a valid non-negative Unix timestamp.',
    );
  }
}

function isValidTimestamp(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= MAX_DATE_TIMESTAMP
  );
}

function cloneVersion(
  version: EditableDocumentVersionV1,
): EditableDocumentVersionV1 {
  return {
    versionId: version.versionId,
    versionNumber: version.versionNumber,
    savedAt: version.savedAt,
    document: cloneDocument(version.document),
  };
}

function cloneDocument(document: EditableDocumentV1): EditableDocumentV1 {
  if (typeof document !== 'object' || document === null) {
    throw new EditableDocumentHistoryError(
      'The Document Version contains an invalid Editable Document.',
    );
  }
  const candidate = document as unknown as Record<string, unknown>;
  const fields = Object.keys(candidate).sort();
  const expected = [
    'markdown',
    'recipientLabel',
    'schema',
    'schemaVersion',
    'title',
  ];
  if (
    fields.length !== expected.length ||
    fields.some((field, index) => field !== expected[index])
  ) {
    throw new EditableDocumentHistoryError(
      'The Document Version contains an invalid Editable Document.',
    );
  }
  const snapshot = {
    schema: candidate.schema,
    schemaVersion: candidate.schemaVersion,
    title: candidate.title,
    recipientLabel: candidate.recipientLabel,
    markdown: candidate.markdown,
  } as EditableDocumentV1;
  return parseEditableDocument(serializeEditableDocument(snapshot));
}

function invalidHistory(): never {
  throw new EditableDocumentHistoryError(
    'The Editable Document history is malformed or unsupported.',
  );
}
