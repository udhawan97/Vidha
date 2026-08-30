import {
  type ChangeEvent,
  type Dispatch,
  type KeyboardEvent,
  type SetStateAction,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  AttachmentIntakeError,
  EditableDocumentError,
  EditableDocumentHistoryError,
  ImportIntakeError,
  SUPPORTED_ATTACHMENT_FORMATS,
  createEditableDocument,
  createEditableDocumentHistory,
  createImportIntake,
  exportEditableDocument,
  planEditableDocumentRestore,
  prepareAttachmentCandidate,
  saveEditableDocumentVersion,
  serializeEditableDocument,
  utf8TextConverter,
  type AttachmentCandidate,
  type EditableDocumentHistoryV1,
  type EditableDocumentRestorePlan,
  type EditableDocumentV1,
  type ImportScanner,
  type PortableDocumentFormat,
  type ReviewableTextImport,
} from '@vidha/documents';

import {
  demoRecipients,
  type DemoAttachment,
  type DemoEnvelope,
  type DemoImportSource,
} from '../demo';
import type { WorkspaceSessionState } from '../sessionLossReview';

interface DocumentWorkspaceProps {
  readonly envelopes: DemoEnvelope[];
  readonly now: () => number;
  readonly onFileReviewStateChange: (state: FileReviewState) => void;
  readonly onSessionWork: () => void;
  readonly onSelectEnvelope: (envelopeId: string) => void;
  readonly onWorkspaceSessionStateChange: (
    state: WorkspaceSessionState,
  ) => void;
  readonly selectedEnvelopeId: string;
  readonly sessionEnded: boolean;
  readonly setEnvelopes: Dispatch<SetStateAction<DemoEnvelope[]>>;
}

export interface FileReviewState {
  readonly busy: boolean;
  readonly envelopeIds: readonly string[];
}

type EditorMode = 'write' | 'preview';

interface DraftSnapshot {
  readonly documentDraft: DemoEnvelope['documentDraft'];
  readonly importSource: DemoImportSource | null;
  readonly attachments: DemoAttachment[];
}

interface DraftHistory {
  readonly past: readonly DraftSnapshot[];
  readonly future: readonly DraftSnapshot[];
}

interface PendingDocumentRestore {
  readonly documentIdentity: string;
  readonly envelopeId: string;
  readonly historyIdentity: string;
  readonly plan: EditableDocumentRestorePlan;
  readonly reviewedDocument: EditableDocumentV1;
}

type FileReviewKind = 'attachment' | 'import';

interface ActiveFileOperation {
  readonly envelopeId: string;
  readonly focusAtStart: Element | null;
  readonly focusOrigin: HTMLElement | null;
  readonly input: HTMLInputElement;
  readonly kind: FileReviewKind;
  readonly requestId: number;
}

type PendingImportReview = ReviewableTextImport & {
  readonly envelopeId: string;
  readonly focusOrigin: HTMLElement | null;
  readonly requestId: number;
};

interface PendingAttachmentReview {
  readonly candidates: readonly AttachmentCandidate[];
  readonly envelopeId: string;
  readonly focusOrigin: HTMLElement | null;
  readonly requestId: number;
}

const MAX_IMPORT_BYTES = 256 * 1024;
const MAX_IMPORT_LINES = 10_000;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_ATTACHMENT_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_ATTACHMENTS = 8;
const MAX_UNDO_STEPS = 50;
const ATTACHMENT_ACCEPT = SUPPORTED_ATTACHMENT_FORMATS.map(
  (format) => `.${format.extension}`,
).join(',');

const syntheticFixtureScanner: ImportScanner = {
  async scan(source) {
    const startedAt = Date.now();
    return {
      scannerId: 'synthetic-fixture-inspection-no-malware-scan',
      engineVersion: 'fixture-v1',
      signatureSetIdentity: `sha256-${'0'.repeat(64)}`,
      signatureSetVersion: 'not-applicable',
      sourceId: source.sourceId,
      scannedBytes: source.sizeBytes,
      startedAt,
      completedAt: startedAt,
      isolationProfile: 'synthetic_fixture',
      verdict: 'clean',
    };
  },
};

const importIntake = createImportIntake({
  converter: utf8TextConverter,
  inspectionPolicy: {
    acceptedIsolationProfiles: ['synthetic_fixture'],
    maxScanDurationMs: 5_000,
  },
  limits: { maxBytes: MAX_IMPORT_BYTES, maxLines: MAX_IMPORT_LINES },
  scanner: syntheticFixtureScanner,
});

function filenameToTitle(filename: string): string {
  const withoutExtension = filename.replace(/\.[^.]+$/, '');
  return withoutExtension.replace(/[-_]+/g, ' ').trim() || 'Imported draft';
}

function snapshotEnvelope(envelope: DemoEnvelope): DraftSnapshot {
  return {
    documentDraft: { ...envelope.documentDraft },
    importSource: envelope.importSource,
    attachments: envelope.attachments.map((attachment) => ({
      ...attachment,
      originalBytes: Uint8Array.from(attachment.originalBytes),
      warnings: [...attachment.warnings],
    })),
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatVersionTime(timestamp: number): string {
  return new Intl.DateTimeFormat('en', {
    hour: 'numeric',
    minute: '2-digit',
  }).format(timestamp);
}

function documentHistoryIdentity(history: EditableDocumentHistoryV1): string {
  return JSON.stringify(history);
}

function summarizeMarkdown(markdown: string): string {
  const plainText = markdown.replaceAll(/\s+/gu, ' ').trim();
  const characters = Array.from(plainText);
  return characters.length > 180
    ? `${characters.slice(0, 180).join('')}…`
    : plainText || 'This version has no Markdown content.';
}

function withoutRecordKey<T>(
  record: Readonly<Record<string, T>>,
  key: string,
): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}

export function DocumentWorkspace({
  envelopes,
  now,
  onFileReviewStateChange,
  onSessionWork,
  onSelectEnvelope,
  onWorkspaceSessionStateChange,
  selectedEnvelopeId,
  sessionEnded,
  setEnvelopes,
}: DocumentWorkspaceProps) {
  const [editorMode, setEditorMode] = useState<EditorMode>('write');
  const [sessionStatus, setSessionStatus] = useState('Synthetic session draft');
  const [exportFormat, setExportFormat] =
    useState<PortableDocumentFormat>('markdown');
  const [importError, setImportError] = useState<string | null>(null);
  const [pendingImportsByEnvelope, setPendingImportsByEnvelope] = useState<
    Record<string, PendingImportReview>
  >({});
  const [pendingAttachmentsByEnvelope, setPendingAttachmentsByEnvelope] =
    useState<Record<string, PendingAttachmentReview>>({});
  const [activeFileOperation, setActiveFileOperation] =
    useState<ActiveFileOperation | null>(null);
  const [approvingImportRequestId, setApprovingImportRequestId] = useState<
    number | null
  >(null);
  const [historyByEnvelope, setHistoryByEnvelope] = useState<
    Record<string, DraftHistory>
  >({});
  const [versionsByEnvelope, setVersionsByEnvelope] = useState<
    Record<string, EditableDocumentHistoryV1>
  >({});
  const [pendingRestore, setPendingRestore] =
    useState<PendingDocumentRestore | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const attachmentRef = useRef<HTMLInputElement>(null);
  const importTriggerRef = useRef<HTMLButtonElement>(null);
  const attachmentTriggerRef = useRef<HTMLButtonElement>(null);
  const nextImportFocusOriginRef = useRef<HTMLElement | null>(null);
  const nextAttachmentFocusOriginRef = useRef<HTMLElement | null>(null);
  const importReviewTitleRef = useRef<HTMLHeadingElement>(null);
  const attachmentReviewTitleRef = useRef<HTMLHeadingElement>(null);
  const fileOperationSequenceRef = useRef(0);
  const activeFileOperationRef = useRef<ActiveFileOperation | null>(null);
  const approvingImportRequestRef = useRef<number | null>(null);
  const selectedEnvelopeIdRef = useRef(selectedEnvelopeId);
  const envelopesRef = useRef(envelopes);
  const sessionEndedRef = useRef(sessionEnded);
  const pendingImportsRef = useRef(pendingImportsByEnvelope);
  const pendingAttachmentsRef = useRef(pendingAttachmentsByEnvelope);
  const restoreDialogRef = useRef<HTMLDialogElement>(null);
  const restoreTriggerRef = useRef<HTMLButtonElement>(null);
  const activeEnvelope =
    envelopes.find((envelope) => envelope.id === selectedEnvelopeId) ??
    envelopes[0];

  useEffect(() => {
    selectedEnvelopeIdRef.current = selectedEnvelopeId;
    envelopesRef.current = envelopes;
    sessionEndedRef.current = sessionEnded;
    pendingImportsRef.current = pendingImportsByEnvelope;
    pendingAttachmentsRef.current = pendingAttachmentsByEnvelope;
  }, [
    envelopes,
    pendingAttachmentsByEnvelope,
    pendingImportsByEnvelope,
    selectedEnvelopeId,
    sessionEnded,
  ]);

  useEffect(() => {
    if (!sessionEnded) return;
    sessionEndedRef.current = true;
    fileOperationSequenceRef.current += 1;
    activeFileOperationRef.current = null;
    approvingImportRequestRef.current = null;
    pendingImportsRef.current = {};
    pendingAttachmentsRef.current = {};
  }, [sessionEnded]);

  useEffect(() => {
    const pendingImport = pendingImportsRef.current[selectedEnvelopeId];
    const pendingAttachments =
      pendingAttachmentsRef.current[selectedEnvelopeId];
    setSessionStatus(
      pendingImport !== undefined
        ? 'Editable copy review ready'
        : pendingAttachments !== undefined
          ? 'Attachment review ready'
          : activeFileOperationRef.current?.envelopeId === selectedEnvelopeId
            ? 'Preparing file review…'
            : sessionEndedRef.current
              ? 'Synthetic session ended'
              : 'Synthetic session draft',
    );
  }, [selectedEnvelopeId]);

  useEffect(
    () => () => {
      fileOperationSequenceRef.current += 1;
      activeFileOperationRef.current = null;
      approvingImportRequestRef.current = null;
    },
    [],
  );

  useEffect(() => {
    if (sessionEnded) {
      onFileReviewStateChange({
        busy: false,
        envelopeIds: [],
      });
      return;
    }
    const envelopeIds = Array.from(
      new Set([
        ...Object.keys(pendingImportsByEnvelope),
        ...Object.keys(pendingAttachmentsByEnvelope),
        ...(activeFileOperation === null
          ? []
          : [activeFileOperation.envelopeId]),
      ]),
    ).sort();
    onFileReviewStateChange({
      busy: activeFileOperation !== null || approvingImportRequestId !== null,
      envelopeIds,
    });
  }, [
    activeFileOperation,
    approvingImportRequestId,
    onFileReviewStateChange,
    pendingAttachmentsByEnvelope,
    pendingImportsByEnvelope,
    sessionEnded,
  ]);

  useEffect(
    () => () =>
      onFileReviewStateChange({
        busy: false,
        envelopeIds: [],
      }),
    [onFileReviewStateChange],
  );

  useEffect(() => {
    const envelopeIds = Array.from(
      new Set([
        ...Object.keys(historyByEnvelope),
        ...Object.keys(versionsByEnvelope),
      ]),
    ).sort();
    onWorkspaceSessionStateChange({
      envelopes: envelopeIds.map((envelopeId) => {
        const history = historyByEnvelope[envelopeId];
        const versions = versionsByEnvelope[envelopeId];
        return {
          envelopeId,
          redoSteps: history?.future.length ?? 0,
          undoSteps: history?.past.length ?? 0,
          versionCount: versions?.versions.length ?? 0,
        };
      }),
    });
  }, [historyByEnvelope, onWorkspaceSessionStateChange, versionsByEnvelope]);

  useEffect(
    () => () => onWorkspaceSessionStateChange({ envelopes: [] }),
    [onWorkspaceSessionStateChange],
  );

  useEffect(() => {
    const dialog = restoreDialogRef.current;
    if (sessionEnded || pendingRestore === null || dialog === null) {
      return;
    }
    if (!dialog.open) {
      if (typeof dialog.showModal === 'function') {
        dialog.showModal();
      } else {
        dialog.setAttribute('open', '');
      }
    }
    return () => {
      if (dialog.open && typeof dialog.close === 'function') {
        dialog.close();
      } else {
        dialog.removeAttribute('open');
      }
      window.requestAnimationFrame(() => restoreTriggerRef.current?.focus());
    };
  }, [pendingRestore, sessionEnded]);

  if (activeEnvelope === undefined) {
    return null;
  }
  const selectedEnvelope = activeEnvelope;
  const activeHistory = historyByEnvelope[selectedEnvelope.id] ?? {
    past: [],
    future: [],
  };
  const activeVersions =
    versionsByEnvelope[selectedEnvelope.id] ?? createEditableDocumentHistory();
  const pendingImport = sessionEnded
    ? null
    : (pendingImportsByEnvelope[selectedEnvelope.id] ?? null);
  const pendingAttachmentReview = sessionEnded
    ? null
    : (pendingAttachmentsByEnvelope[selectedEnvelope.id] ?? null);
  const pendingAttachments = pendingAttachmentReview?.candidates ?? [];

  function rejectEndedSessionMutation(): boolean {
    if (!sessionEndedRef.current) return false;
    setImportError(
      'This ended rehearsal is read-only. Start a fresh local rehearsal to make changes.',
    );
    setSessionStatus('Ended rehearsal is read-only');
    return true;
  }

  function updateEnvelopeById(
    envelopeId: string,
    patch: Partial<DemoEnvelope>,
    status = 'Editing in this session…',
  ): boolean {
    if (rejectEndedSessionMutation()) return false;
    const currentEnvelope = envelopesRef.current.find(
      (envelope) => envelope.id === envelopeId,
    );
    if (currentEnvelope === undefined) {
      return false;
    }
    onSessionWork();
    setSessionStatus(status);
    setHistoryByEnvelope((current) => {
      const history = current[envelopeId] ?? {
        past: [],
        future: [],
      };
      return {
        ...current,
        [envelopeId]: {
          past: [...history.past, snapshotEnvelope(currentEnvelope)].slice(
            -MAX_UNDO_STEPS,
          ),
          future: [],
        },
      };
    });
    setEnvelopes((current) =>
      current.map((envelope) =>
        envelope.id === envelopeId ? { ...envelope, ...patch } : envelope,
      ),
    );
    return true;
  }

  function updateActiveEnvelope(patch: Partial<DemoEnvelope>) {
    updateEnvelopeById(selectedEnvelope.id, patch);
  }

  function updateActiveDocument(
    patch: Partial<
      Pick<
        DemoEnvelope['documentDraft'],
        'markdown' | 'recipientLabel' | 'title'
      >
    >,
  ) {
    updateActiveEnvelope({
      documentDraft: {
        ...selectedEnvelope.documentDraft,
        ...patch,
      },
    });
  }

  function replaceActiveEnvelope(snapshot: DraftSnapshot) {
    setEnvelopes((current) =>
      current.map((envelope) =>
        envelope.id === selectedEnvelope.id
          ? { ...envelope, ...snapshot }
          : envelope,
      ),
    );
  }

  function undoEdit() {
    if (rejectEndedSessionMutation()) return;
    const previous = activeHistory.past.at(-1);
    if (previous === undefined) {
      return;
    }
    const currentSnapshot = snapshotEnvelope(selectedEnvelope);
    setHistoryByEnvelope((current) => ({
      ...current,
      [selectedEnvelope.id]: {
        past: activeHistory.past.slice(0, -1),
        future: [currentSnapshot, ...activeHistory.future],
      },
    }));
    replaceActiveEnvelope(previous);
    setSessionStatus('Undid the latest session edit');
  }

  function redoEdit() {
    if (rejectEndedSessionMutation()) return;
    const next = activeHistory.future[0];
    if (next === undefined) {
      return;
    }
    const currentSnapshot = snapshotEnvelope(selectedEnvelope);
    setHistoryByEnvelope((current) => ({
      ...current,
      [selectedEnvelope.id]: {
        past: [...activeHistory.past, currentSnapshot],
        future: activeHistory.future.slice(1),
      },
    }));
    replaceActiveEnvelope(next);
    setSessionStatus('Redid the latest session edit');
  }

  function saveDocumentVersion() {
    if (rejectEndedSessionMutation()) return;
    try {
      setImportError(null);
      const result = saveEditableDocumentVersion(
        activeVersions,
        createEditableDocument(selectedEnvelope.documentDraft),
        now(),
      );
      setVersionsByEnvelope((current) => ({
        ...current,
        [selectedEnvelope.id]: result.history,
      }));
      if (result.created) onSessionWork();
      setSessionStatus(
        result.created
          ? `Session Version ${result.version.versionNumber} saved`
          : `Draft already matches Version ${result.version.versionNumber}`,
      );
    } catch (error) {
      setImportError(
        error instanceof EditableDocumentError ||
          error instanceof EditableDocumentHistoryError
          ? error.message
          : 'The session version could not be saved.',
      );
    }
  }

  function reviewDocumentRestore(
    versionId: string,
    reviewedAt: number,
    trigger: HTMLButtonElement,
  ) {
    if (rejectEndedSessionMutation()) return;
    try {
      setImportError(null);
      const reviewedDocument = createEditableDocument(
        selectedEnvelope.documentDraft,
      );
      const plan = planEditableDocumentRestore(
        activeVersions,
        reviewedDocument,
        versionId,
        reviewedAt,
      );
      if (!plan.changes.hasChanges) {
        setSessionStatus(
          `Draft already matches Version ${plan.targetVersion.versionNumber}`,
        );
        return;
      }
      restoreTriggerRef.current = trigger;
      setPendingRestore({
        documentIdentity: serializeEditableDocument(reviewedDocument),
        envelopeId: selectedEnvelope.id,
        historyIdentity: documentHistoryIdentity(activeVersions),
        plan,
        reviewedDocument,
      });
    } catch (error) {
      setImportError(
        error instanceof EditableDocumentError ||
          error instanceof EditableDocumentHistoryError
          ? error.message
          : 'The session version could not be reviewed.',
      );
    }
  }

  function confirmDocumentRestore() {
    if (rejectEndedSessionMutation()) {
      setPendingRestore(null);
      return;
    }
    if (pendingRestore === null) {
      return;
    }
    const reviewed = pendingRestore;
    const latestEnvelope = envelopes.find(
      (envelope) => envelope.id === reviewed.envelopeId,
    );
    const latestHistory =
      versionsByEnvelope[reviewed.envelopeId] ??
      createEditableDocumentHistory();
    let latestDocument: EditableDocumentV1;
    try {
      if (
        selectedEnvelope.id !== reviewed.envelopeId ||
        latestEnvelope === undefined
      ) {
        throw new EditableDocumentHistoryError(
          'The selected Envelope changed after restore review.',
        );
      }
      latestDocument = createEditableDocument(latestEnvelope.documentDraft);
      if (
        serializeEditableDocument(latestDocument) !==
          reviewed.documentIdentity ||
        documentHistoryIdentity(latestHistory) !== reviewed.historyIdentity
      ) {
        throw new EditableDocumentHistoryError(
          'The draft or Session versions changed after restore review.',
        );
      }
    } catch {
      setPendingRestore(null);
      setImportError(
        'The draft or Session versions changed. Review the restore again before applying it.',
      );
      setSessionStatus('Restore review expired');
      return;
    }
    setVersionsByEnvelope((current) => ({
      ...current,
      [reviewed.envelopeId]: reviewed.plan.history,
    }));
    updateActiveDocument({
      title: reviewed.plan.document.title,
      recipientLabel: reviewed.plan.document.recipientLabel,
      markdown: reviewed.plan.document.markdown,
    });
    setPendingRestore(null);
    setSessionStatus(
      `Version ${reviewed.plan.targetVersion.versionNumber} restored; the previous draft remains saved`,
    );
  }

  function containRestoreDialogFocus(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key !== 'Tab') {
      return;
    }
    const dialog = event.currentTarget;
    const controls = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ),
    );
    const first = controls[0];
    const last = controls.at(-1);
    if (first === undefined || last === undefined) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const focused = document.activeElement;
    if (event.shiftKey && (focused === first || !dialog.contains(focused))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && focused === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function insertMarkdown(prefix: string, suffix = prefix) {
    if (rejectEndedSessionMutation()) return;
    const textarea = textareaRef.current;
    if (textarea === null) {
      return;
    }

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const markdown = selectedEnvelope.documentDraft.markdown;
    const selection = markdown.slice(start, end) || 'text';
    const nextMarkdown = `${markdown.slice(0, start)}${prefix}${selection}${suffix}${markdown.slice(end)}`;
    updateActiveDocument({ markdown: nextMarkdown });

    window.requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(
        start + prefix.length,
        start + prefix.length + selection.length,
      );
    });
  }

  function beginFileOperation(
    kind: FileReviewKind,
    input: HTMLInputElement,
    focusOrigin: HTMLElement | null,
  ): ActiveFileOperation | null {
    if (sessionEndedRef.current) {
      setImportError('This synthetic session has ended.');
      return null;
    }
    if (activeFileOperationRef.current !== null) {
      setImportError('Wait for the current file review to finish preparing.');
      return null;
    }
    if (
      pendingImportsByEnvelope[selectedEnvelope.id] !== undefined ||
      pendingAttachmentsByEnvelope[selectedEnvelope.id] !== undefined
    ) {
      setImportError(
        'Approve or discard the current file review before choosing another file.',
      );
      return null;
    }
    const operation: ActiveFileOperation = {
      envelopeId: selectedEnvelope.id,
      focusAtStart: document.activeElement,
      focusOrigin,
      input,
      kind,
      requestId: ++fileOperationSequenceRef.current,
    };
    activeFileOperationRef.current = operation;
    setActiveFileOperation(operation);
    setImportError(null);
    setSessionStatus(
      kind === 'import'
        ? 'Preparing editable copy review…'
        : 'Preparing Attachment review…',
    );
    return operation;
  }

  function isCurrentFileOperation(operation: ActiveFileOperation): boolean {
    return (
      !sessionEndedRef.current &&
      activeFileOperationRef.current?.requestId === operation.requestId &&
      activeFileOperationRef.current.envelopeId === operation.envelopeId
    );
  }

  function finishFileOperation(operation: ActiveFileOperation) {
    if (activeFileOperationRef.current?.requestId !== operation.requestId) {
      return;
    }
    activeFileOperationRef.current = null;
    setActiveFileOperation(null);
  }

  function announceReadyReview(
    operation: ActiveFileOperation,
    titleRef: { readonly current: HTMLHeadingElement | null },
    status: string,
  ) {
    if (selectedEnvelopeIdRef.current !== operation.envelopeId) {
      return;
    }
    const focused = document.activeElement;
    const shouldMoveFocus =
      focused === operation.focusAtStart ||
      focused === operation.focusOrigin ||
      focused === operation.input ||
      focused === document.body;
    setSessionStatus(status);
    if (shouldMoveFocus) {
      window.requestAnimationFrame(() => {
        if (
          !sessionEndedRef.current &&
          selectedEnvelopeIdRef.current === operation.envelopeId
        ) {
          titleRef.current?.focus();
        }
      });
    }
  }

  function restoreFileTriggerFocus(focusOrigin: HTMLElement | null) {
    window.requestAnimationFrame(() => {
      if (focusOrigin?.isConnected) {
        focusOrigin.focus();
      }
    });
  }

  async function importTextFile(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = '';
    if (file === undefined) {
      return;
    }
    const focusOrigin =
      nextImportFocusOriginRef.current ?? importTriggerRef.current;
    nextImportFocusOriginRef.current = null;
    const operation = beginFileOperation('import', input, focusOrigin);
    if (operation === null) {
      return;
    }

    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!isCurrentFileOperation(operation)) return;
      const prepared = await importIntake.prepare({
        bytes,
        declaredMediaType: file.type,
        filename: file.name,
      });
      if (!isCurrentFileOperation(operation)) return;
      const inspected = await importIntake.inspect(prepared);
      if (!isCurrentFileOperation(operation)) return;
      const reviewable = await importIntake.review(inspected);
      if (!isCurrentFileOperation(operation)) return;
      const nextPendingImports = {
        ...pendingImportsRef.current,
        [operation.envelopeId]: {
          ...reviewable,
          envelopeId: operation.envelopeId,
          focusOrigin: operation.focusOrigin,
          requestId: operation.requestId,
        },
      };
      pendingImportsRef.current = nextPendingImports;
      setPendingImportsByEnvelope(nextPendingImports);
      onSessionWork();
      finishFileOperation(operation);
      announceReadyReview(
        operation,
        importReviewTitleRef,
        'Editable copy review ready',
      );
    } catch (error) {
      if (!isCurrentFileOperation(operation)) return;
      finishFileOperation(operation);
      if (selectedEnvelopeIdRef.current === operation.envelopeId) {
        setImportError(
          error instanceof ImportIntakeError
            ? error.message
            : 'The import could not be inspected.',
        );
        setSessionStatus('Editable copy review failed');
      }
    }
  }

  async function stageAttachmentFiles(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const files = [...(input.files ?? [])];
    input.value = '';
    if (files.length === 0) {
      return;
    }
    const focusOrigin =
      nextAttachmentFocusOriginRef.current ?? attachmentTriggerRef.current;
    nextAttachmentFocusOriginRef.current = null;
    const operation = beginFileOperation('attachment', input, focusOrigin);
    if (operation === null) {
      return;
    }
    const originEnvelope = envelopesRef.current.find(
      (envelope) => envelope.id === operation.envelopeId,
    );
    if (originEnvelope === undefined) {
      finishFileOperation(operation);
      return;
    }

    const candidates: AttachmentCandidate[] = [];
    const errors: string[] = [];
    const existingSourceIds = new Set(
      originEnvelope.attachments.map((attachment) => attachment.sourceId),
    );
    let totalBytes = originEnvelope.attachments.reduce(
      (total, attachment) => total + attachment.sizeBytes,
      0,
    );

    for (const file of files) {
      if (!isCurrentFileOperation(operation)) return;
      if (
        originEnvelope.attachments.length + candidates.length >=
        MAX_ATTACHMENTS
      ) {
        errors.push(
          `${file.name}: this rehearsal keeps at most ${MAX_ATTACHMENTS} Attachment candidates per Envelope.`,
        );
        continue;
      }
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (!isCurrentFileOperation(operation)) return;
        const candidate = await prepareAttachmentCandidate(
          {
            bytes,
            declaredMediaType: file.type,
            filename: file.name,
          },
          { maxBytes: MAX_ATTACHMENT_BYTES },
        );
        if (!isCurrentFileOperation(operation)) return;
        if (
          existingSourceIds.has(candidate.sourceId) ||
          candidates.some(
            (existing) => existing.sourceId === candidate.sourceId,
          )
        ) {
          errors.push(
            `${candidate.filename}: these exact bytes are already staged.`,
          );
          continue;
        }
        if (totalBytes + candidate.sizeBytes > MAX_ATTACHMENT_TOTAL_BYTES) {
          errors.push(
            `${candidate.filename}: the Envelope would exceed the ${formatBytes(MAX_ATTACHMENT_TOTAL_BYTES)} session total.`,
          );
          continue;
        }
        candidates.push(candidate);
        totalBytes += candidate.sizeBytes;
      } catch (error) {
        errors.push(
          `${file.name}: ${
            error instanceof AttachmentIntakeError
              ? error.message
              : 'The file could not be staged.'
          }`,
        );
      }
    }

    if (!isCurrentFileOperation(operation)) return;
    if (candidates.length > 0) {
      setPendingAttachmentsByEnvelope((current) => ({
        ...current,
        [operation.envelopeId]: {
          candidates,
          envelopeId: operation.envelopeId,
          focusOrigin: operation.focusOrigin,
          requestId: operation.requestId,
        },
      }));
      onSessionWork();
    }
    finishFileOperation(operation);
    if (selectedEnvelopeIdRef.current === operation.envelopeId) {
      if (errors.length > 0) {
        setImportError(errors.join(' '));
      }
      if (candidates.length > 0) {
        announceReadyReview(
          operation,
          attachmentReviewTitleRef,
          `${candidates.length} Attachment review${candidates.length === 1 ? '' : 's'} ready`,
        );
      } else {
        setSessionStatus('Attachment review found no files to keep');
      }
    }
  }

  function approvePendingAttachments() {
    if (rejectEndedSessionMutation()) return;
    if (pendingAttachmentReview === null) {
      return;
    }
    const latestEnvelope = envelopesRef.current.find(
      (envelope) => envelope.id === pendingAttachmentReview.envelopeId,
    );
    const sourceIds = new Set(
      latestEnvelope?.attachments.map((attachment) => attachment.sourceId) ??
        [],
    );
    const existingBytes =
      latestEnvelope?.attachments.reduce(
        (total, attachment) => total + attachment.sizeBytes,
        0,
      ) ?? 0;
    const candidateBytes = pendingAttachments.reduce(
      (total, attachment) => total + attachment.sizeBytes,
      0,
    );
    if (
      latestEnvelope === undefined ||
      selectedEnvelopeIdRef.current !== pendingAttachmentReview.envelopeId ||
      latestEnvelope.attachments.length + pendingAttachments.length >
        MAX_ATTACHMENTS ||
      existingBytes + candidateBytes > MAX_ATTACHMENT_TOTAL_BYTES ||
      pendingAttachments.some((candidate) => sourceIds.has(candidate.sourceId))
    ) {
      setPendingAttachmentsByEnvelope((current) =>
        withoutRecordKey(current, pendingAttachmentReview.envelopeId),
      );
      setImportError(
        'The Envelope changed after this review. Choose the files again before keeping them.',
      );
      setSessionStatus('Attachment review expired');
      return;
    }
    updateEnvelopeById(
      pendingAttachmentReview.envelopeId,
      {
        attachments: [
          ...latestEnvelope.attachments,
          ...pendingAttachments.map((candidate) => ({
            sourceId: candidate.sourceId,
            filename: candidate.filename,
            mediaType: candidate.mediaType,
            kind: candidate.kind,
            sizeBytes: candidate.sizeBytes,
            originalBytes: Uint8Array.from(candidate.originalBytes),
            warnings: [...candidate.warnings],
          })),
        ],
      },
      `${pendingAttachments.length} Attachment${pendingAttachments.length === 1 ? '' : 's'} kept in this session`,
    );
    setPendingAttachmentsByEnvelope((current) =>
      withoutRecordKey(current, pendingAttachmentReview.envelopeId),
    );
  }

  async function approvePendingImport() {
    if (rejectEndedSessionMutation()) return;
    if (pendingImport === null || approvingImportRequestRef.current !== null) {
      return;
    }
    const reviewed = pendingImport;
    approvingImportRequestRef.current = reviewed.requestId;
    setApprovingImportRequestId(reviewed.requestId);
    try {
      const approved = await importIntake.approve(reviewed);
      const latestPending = pendingImportsRef.current[reviewed.envelopeId];
      const latestEnvelope = envelopesRef.current.find(
        (envelope) => envelope.id === reviewed.envelopeId,
      );
      if (
        sessionEndedRef.current ||
        selectedEnvelopeIdRef.current !== reviewed.envelopeId
      ) {
        return;
      }
      if (
        latestPending?.requestId !== reviewed.requestId ||
        latestEnvelope === undefined
      ) {
        setImportError(
          'The Envelope or import changed after this review. Review the source again before creating a copy.',
        );
        setSessionStatus('Editable copy review expired');
        return;
      }
      const canonicalDocument = createEditableDocument({
        title: filenameToTitle(approved.filename),
        markdown: approved.text,
        recipientLabel: latestEnvelope.documentDraft.recipientLabel,
      });
      updateEnvelopeById(
        reviewed.envelopeId,
        {
          documentDraft: {
            title: canonicalDocument.title,
            recipientLabel: canonicalDocument.recipientLabel,
            markdown: canonicalDocument.markdown,
          },
          importSource: {
            filename: approved.filename,
            mediaType: approved.declaredMediaType || approved.detectedMediaType,
            detectedMediaType: approved.detectedMediaType,
            sizeBytes: approved.sizeBytes,
            sourceId: approved.sourceId,
            scannerId: approved.scan.scannerId,
            converterId: approved.converterId,
            conversionWarnings: [...approved.conversionWarnings],
            schemaVersion: 1,
            originalBytes: Uint8Array.from(approved.originalBytes),
            text: approved.text,
          },
        },
        'Editable copy created from the reviewed source',
      );
      if (
        pendingImportsRef.current[reviewed.envelopeId]?.requestId ===
        reviewed.requestId
      ) {
        const nextPendingImports = withoutRecordKey(
          pendingImportsRef.current,
          reviewed.envelopeId,
        );
        pendingImportsRef.current = nextPendingImports;
        setPendingImportsByEnvelope(nextPendingImports);
      }
    } catch (error) {
      if (
        !sessionEndedRef.current &&
        selectedEnvelopeIdRef.current === reviewed.envelopeId
      ) {
        setImportError(
          error instanceof ImportIntakeError
            ? error.message
            : 'The inspected import could not be approved.',
        );
      }
    } finally {
      if (approvingImportRequestRef.current === reviewed.requestId) {
        approvingImportRequestRef.current = null;
        setApprovingImportRequestId(null);
      }
    }
  }

  function discardPendingImport() {
    if (pendingImport === null) return;
    const discarded = pendingImport;
    if (
      pendingImportsRef.current[discarded.envelopeId]?.requestId !==
      discarded.requestId
    ) {
      return;
    }
    const nextPendingImports = withoutRecordKey(
      pendingImportsRef.current,
      discarded.envelopeId,
    );
    pendingImportsRef.current = nextPendingImports;
    setPendingImportsByEnvelope(nextPendingImports);
    setSessionStatus('Editable copy review discarded');
    restoreFileTriggerFocus(discarded.focusOrigin ?? importTriggerRef.current);
  }

  function discardPendingAttachments() {
    if (pendingAttachmentReview === null) return;
    const discarded = pendingAttachmentReview;
    setPendingAttachmentsByEnvelope((current) => {
      if (current[discarded.envelopeId]?.requestId !== discarded.requestId) {
        return current;
      }
      return withoutRecordKey(current, discarded.envelopeId);
    });
    setSessionStatus('Attachment review discarded');
    restoreFileTriggerFocus(
      discarded.focusOrigin ?? attachmentTriggerRef.current,
    );
  }

  function removeAttachment(sourceId: string) {
    if (rejectEndedSessionMutation()) return;
    updateActiveEnvelope({
      attachments: selectedEnvelope.attachments.filter(
        (attachment) => attachment.sourceId !== sourceId,
      ),
    });
    setSessionStatus('Attachment removed from this session');
  }

  function downloadDocument(
    content: BlobPart,
    mediaType: string,
    filename: string,
    status: string,
  ) {
    const blob = new Blob([content], {
      type: mediaType.startsWith('text/')
        ? `${mediaType};charset=utf-8`
        : mediaType,
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
    setSessionStatus(status);
  }

  function downloadPortableCopy() {
    try {
      setImportError(null);
      const canonicalDocument = createEditableDocument(
        selectedEnvelope.documentDraft,
      );
      const copy = exportEditableDocument(canonicalDocument, exportFormat);
      downloadDocument(
        copy.content,
        copy.mediaType,
        copy.filename,
        `${exportFormat === 'html' ? 'Semantic HTML' : exportFormat === 'markdown' ? 'Markdown' : 'Text'} copy prepared from schema v${copy.schemaVersion}`,
      );
    } catch (error) {
      setImportError(
        error instanceof EditableDocumentError
          ? error.message
          : 'The portable copy could not be prepared.',
      );
    }
  }

  function restoreImportedSource() {
    if (rejectEndedSessionMutation()) return;
    const source = selectedEnvelope.importSource;
    if (source === null) {
      return;
    }
    const canonicalSource = createEditableDocument({
      title: filenameToTitle(source.filename),
      markdown: source.text,
      recipientLabel: selectedEnvelope.documentDraft.recipientLabel,
    });
    updateActiveDocument({ markdown: canonicalSource.markdown });
    setSessionStatus('Imported text snapshot restored');
  }

  function downloadImportedOriginal() {
    const source = selectedEnvelope.importSource;
    if (source === null) {
      return;
    }
    const originalBytes = new Uint8Array(source.originalBytes.byteLength);
    originalBytes.set(source.originalBytes);
    downloadDocument(
      originalBytes.buffer,
      source.mediaType,
      source.filename,
      'Original session bytes prepared for download',
    );
  }

  function downloadAttachment(attachment: DemoAttachment) {
    const bytes = new Uint8Array(attachment.originalBytes.byteLength);
    bytes.set(attachment.originalBytes);
    downloadDocument(
      bytes.buffer,
      attachment.mediaType,
      attachment.filename,
      'Attachment bytes prepared for download',
    );
  }

  return (
    <div className={`workspace-view${sessionEnded ? ' is-ended' : ''}`}>
      <header className="workspace-heading">
        <div>
          <p className="eyebrow">Envelope studio · synthetic rehearsal</p>
          <h1>Write the handoff, not the ceremony.</h1>
          <p>
            These synthetic drafts live only in memory. Do not enter personal or
            sensitive information in this pre-alpha build.
          </p>
        </div>
        <div className="workspace-actions">
          <input
            accept=".md,.markdown,.txt,text/markdown,text/plain"
            aria-label="Import Markdown or plain text"
            className="visually-hidden"
            onChange={(event) => void importTextFile(event)}
            ref={importRef}
            type="file"
          />
          <input
            accept={ATTACHMENT_ACCEPT}
            aria-label="Add Attachment candidates"
            className="visually-hidden"
            multiple
            onChange={(event) => void stageAttachmentFiles(event)}
            ref={attachmentRef}
            type="file"
          />
          <button
            className="button button-quiet"
            disabled={
              sessionEnded ||
              activeFileOperation !== null ||
              pendingImport !== null ||
              pendingAttachmentReview !== null
            }
            onClick={(event) => {
              nextImportFocusOriginRef.current = event.currentTarget;
              importRef.current?.click();
            }}
            ref={importTriggerRef}
            type="button"
          >
            Import editable text
          </button>
          <button
            className="button button-quiet"
            disabled={
              sessionEnded ||
              activeFileOperation !== null ||
              pendingImport !== null ||
              pendingAttachmentReview !== null
            }
            onClick={(event) => {
              nextAttachmentFocusOriginRef.current = event.currentTarget;
              attachmentRef.current?.click();
            }}
            ref={attachmentTriggerRef}
            type="button"
          >
            Add files
          </button>
          <div className="portable-copy-control">
            <label>
              <span>Portable copy</span>
              <select
                aria-label="Portable copy format"
                onChange={(event) =>
                  setExportFormat(event.target.value as PortableDocumentFormat)
                }
                value={exportFormat}
              >
                <option value="markdown">Markdown · editable</option>
                <option value="html">HTML · semantic reading copy</option>
                <option value="text">Text · keeps Markdown punctuation</option>
              </select>
            </label>
            <button
              className="button button-primary"
              onClick={downloadPortableCopy}
              type="button"
            >
              Download copy
            </button>
          </div>
        </div>
      </header>

      {sessionEnded ? (
        <section
          aria-label="Ended rehearsal workspace"
          className="ended-session-notice"
          role="status"
        >
          <div>
            <p className="eyebrow">Terminal synthetic state</p>
            <strong>This ended rehearsal is read-only.</strong>
            <p id="ended-workspace-copy">
              Review or download its local documents and original files. Return
              to Overview and start a fresh local rehearsal before making any
              changes.
            </p>
          </div>
          <span>Nothing here is durably saved</span>
        </section>
      ) : null}

      {importError === null ? null : (
        <p className="import-error" role="alert">
          {importError}
        </p>
      )}

      {pendingImport === null ? null : (
        <section
          className="pending-import"
          aria-labelledby="pending-import-title"
        >
          <div>
            <p className="eyebrow">Editable copy review</p>
            <h2
              id="pending-import-title"
              ref={importReviewTitleRef}
              tabIndex={-1}
            >
              Review before replacing this draft
            </h2>
            <p>
              <strong>{pendingImport.filename}</strong> ·{' '}
              {formatBytes(pendingImport.sizeBytes)} ·{' '}
              {pendingImport.detectedMediaType}
            </p>
            <p className="intake-warning">
              Synthetic fixture inspection only · no malware scanner or
              sandboxed converter is active.
            </p>
            <p className="intake-warning">
              Inspection evidence · {pendingImport.scan.scannerId}
            </p>
            <p className="intake-warning">
              Conversion evidence · {pendingImport.converterId}
            </p>
            <code className="source-digest">{pendingImport.sourceId}</code>
            {pendingImport.warnings.map((warning) => (
              <p className="intake-warning" key={warning}>
                {warning}
              </p>
            ))}
            <div className="conversion-review-grid">
              <div>
                <span className="review-label">What Vidha will keep</span>
                <ul>
                  <li>Exact original bytes for download until refresh</li>
                  <li>Source digest and conversion provenance</li>
                  <li>A separate schema v1 Editable Document copy</li>
                </ul>
              </div>
              <div>
                <span className="review-label">Conversion notes</span>
                <ul>
                  {pendingImport.conversionWarnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </div>
            </div>
            <details className="conversion-preview">
              <summary>Preview converted copy</summary>
              <pre>{pendingImport.text}</pre>
            </details>
          </div>
          <div className="pending-import-actions">
            <button
              className="button button-quiet"
              disabled={
                sessionEnded ||
                approvingImportRequestId === pendingImport.requestId
              }
              onClick={discardPendingImport}
              type="button"
            >
              Discard
            </button>
            <button
              className="button button-primary"
              disabled={
                sessionEnded ||
                approvingImportRequestId === pendingImport.requestId
              }
              onClick={() => void approvePendingImport()}
              type="button"
            >
              Create editable copy
            </button>
          </div>
        </section>
      )}

      {pendingAttachments.length === 0 ? null : (
        <section
          className="pending-import pending-attachments"
          aria-labelledby="pending-attachments-title"
        >
          <div>
            <p className="eyebrow">Attachment review</p>
            <h2
              id="pending-attachments-title"
              ref={attachmentReviewTitleRef}
              tabIndex={-1}
            >
              Keep {pendingAttachments.length} file
              {pendingAttachments.length === 1 ? '' : 's'} with this Envelope?
            </h2>
            <ul>
              {pendingAttachments.map((attachment) => (
                <li key={attachment.sourceId}>
                  <strong>{attachment.filename}</strong>
                  <span>
                    {attachment.kind} · {formatBytes(attachment.sizeBytes)}
                  </span>
                  {attachment.warnings.map((warning) => (
                    <span className="intake-warning" key={warning}>
                      {warning}
                    </span>
                  ))}
                </li>
              ))}
            </ul>
            <p className="intake-warning">
              Filename classification only. No malware scan, safe preview,
              upload, encryption, or delivery occurs in this browser fixture.
            </p>
          </div>
          <div className="pending-import-actions">
            <button
              className="button button-quiet"
              disabled={sessionEnded}
              onClick={discardPendingAttachments}
              type="button"
            >
              Discard
            </button>
            <button
              className="button button-primary"
              disabled={sessionEnded}
              onClick={approvePendingAttachments}
              type="button"
            >
              Keep as Attachments
            </button>
          </div>
        </section>
      )}

      <div className="workspace-shell">
        <span className="folio-marker" aria-hidden="true" lang="ja">
          二・封筒
        </span>
        <aside className="document-list" aria-label="Demo Envelopes">
          <div className="document-list-heading">
            <span>Envelopes</span>
            <span>{envelopes.length}</span>
          </div>
          {envelopes.map((envelope) => {
            const hasPendingReview =
              !sessionEnded &&
              (pendingImportsByEnvelope[envelope.id] !== undefined ||
                pendingAttachmentsByEnvelope[envelope.id] !== undefined);
            const isPreparingReview =
              !sessionEnded && activeFileOperation?.envelopeId === envelope.id;
            return (
              <button
                aria-current={
                  envelope.id === selectedEnvelope.id ? 'page' : undefined
                }
                className={
                  envelope.id === selectedEnvelope.id
                    ? 'document-choice is-selected'
                    : 'document-choice'
                }
                key={envelope.id}
                onClick={() => {
                  selectedEnvelopeIdRef.current = envelope.id;
                  onSelectEnvelope(envelope.id);
                  setPendingRestore(null);
                  setImportError(null);
                  setSessionStatus(
                    sessionEnded
                      ? 'Ended rehearsal · review and download only'
                      : pendingImportsByEnvelope[envelope.id] !== undefined
                        ? 'Editable copy review ready'
                        : pendingAttachmentsByEnvelope[envelope.id] !==
                            undefined
                          ? 'Attachment review ready'
                          : activeFileOperation?.envelopeId === envelope.id
                            ? 'Preparing file review…'
                            : 'Synthetic session draft',
                  );
                }}
                onFocus={(event) => {
                  if (
                    typeof event.currentTarget.scrollIntoView === 'function'
                  ) {
                    event.currentTarget.scrollIntoView({
                      behavior: 'auto',
                      block: 'nearest',
                      inline: 'nearest',
                    });
                  }
                }}
                type="button"
              >
                <strong>{envelope.documentDraft.title}</strong>
                <span>For {envelope.documentDraft.recipientLabel}</span>
                <span>
                  {hasPendingReview
                    ? 'Review ready'
                    : isPreparingReview
                      ? 'Preparing review'
                      : `${envelope.attachments.length} Attachment${envelope.attachments.length === 1 ? '' : 's'}`}
                </span>
              </button>
            );
          })}
          <div className="list-boundary">
            <span aria-hidden="true">＋</span>
            <p>
              Creating and persisting new Envelopes comes after secure storage.
            </p>
          </div>
        </aside>

        <section className="document-editor" aria-label="Document editor">
          <div className="editor-topline">
            <label>
              <span className="visually-hidden">Document title</span>
              <input
                aria-describedby={
                  sessionEnded ? 'ended-workspace-copy' : undefined
                }
                className="document-title-input"
                onChange={(event) =>
                  updateActiveDocument({ title: event.target.value })
                }
                maxLength={200}
                readOnly={sessionEnded}
                value={selectedEnvelope.documentDraft.title}
              />
            </label>
            <div className="editor-modes" aria-label="Editor mode">
              <button
                aria-pressed={editorMode === 'write'}
                onClick={() => setEditorMode('write')}
                type="button"
              >
                Write
              </button>
              <button
                aria-pressed={editorMode === 'preview'}
                onClick={() => setEditorMode('preview')}
                type="button"
              >
                Read
              </button>
            </div>
          </div>

          <div
            aria-label={
              sessionEnded
                ? 'Read-only Markdown formatting controls'
                : 'Markdown formatting'
            }
            className="editor-toolbar"
            tabIndex={sessionEnded ? 0 : undefined}
          >
            <button
              aria-label="Undo session edit"
              disabled={sessionEnded || activeHistory.past.length === 0}
              onClick={undoEdit}
              type="button"
            >
              Undo
            </button>
            <button
              aria-label="Redo session edit"
              disabled={sessionEnded || activeHistory.future.length === 0}
              onClick={redoEdit}
              type="button"
            >
              Redo
            </button>
            <span className="toolbar-divider" />
            <button
              aria-label="Bold selected text"
              disabled={sessionEnded}
              onClick={() => insertMarkdown('**')}
              type="button"
            >
              <strong>B</strong>
            </button>
            <button
              aria-label="Italicize selected text"
              disabled={sessionEnded}
              onClick={() => insertMarkdown('_')}
              type="button"
            >
              <em>I</em>
            </button>
            <button
              aria-label="Make selected text a heading"
              disabled={sessionEnded}
              onClick={() => insertMarkdown('## ', '')}
              type="button"
            >
              H2
            </button>
            <button
              aria-label="Make selected text a list item"
              disabled={sessionEnded}
              onClick={() => insertMarkdown('- ', '')}
              type="button"
            >
              List
            </button>
            <span className="toolbar-divider" />
            <button
              disabled={sessionEnded}
              onClick={saveDocumentVersion}
              type="button"
            >
              Save version
            </button>
            <span aria-live="polite" className="editor-status" role="status">
              {sessionEnded
                ? 'Ended rehearsal · review and download only'
                : sessionStatus}
            </span>
          </div>

          {editorMode === 'write' ? (
            <textarea
              aria-describedby={
                sessionEnded ? 'ended-workspace-copy' : undefined
              }
              aria-label="Envelope Markdown content"
              className="document-textarea"
              onChange={(event) =>
                updateActiveDocument({ markdown: event.target.value })
              }
              maxLength={1_000_000}
              readOnly={sessionEnded}
              ref={textareaRef}
              spellCheck="true"
              value={selectedEnvelope.documentDraft.markdown}
            />
          ) : (
            <article
              className="document-preview"
              aria-label="Plain-text preview"
            >
              {selectedEnvelope.documentDraft.markdown}
            </article>
          )}
        </section>

        <aside className="document-settings" aria-label="Envelope settings">
          <div className="setting-block">
            <label className="setting-label" htmlFor="demo-recipient">
              Recipient
            </label>
            <select
              disabled={sessionEnded}
              id="demo-recipient"
              onChange={(event) =>
                updateActiveDocument({ recipientLabel: event.target.value })
              }
              value={selectedEnvelope.documentDraft.recipientLabel}
            >
              {demoRecipients.map((recipient) => (
                <option key={recipient}>{recipient}</option>
              ))}
            </select>
            <span>Synthetic verified contact</span>
          </div>
          <div className="setting-block">
            <p className="setting-label">Imported text snapshot</p>
            {selectedEnvelope.importSource === null ? (
              <span>No source file in this session</span>
            ) : (
              <>
                <strong>{selectedEnvelope.importSource.filename}</strong>
                <span>
                  {formatBytes(selectedEnvelope.importSource.sizeBytes)} ·{' '}
                  {selectedEnvelope.importSource.detectedMediaType}
                </span>
                <span>Exact original bytes held until refresh</span>
                <span>
                  Schema v{selectedEnvelope.importSource.schemaVersion} ·{' '}
                  {selectedEnvelope.importSource.converterId}
                </span>
                <span>
                  Synthetic inspection ·{' '}
                  {selectedEnvelope.importSource.scannerId}
                </span>
                <code className="source-digest">
                  {selectedEnvelope.importSource.sourceId}
                </code>
                {selectedEnvelope.importSource.conversionWarnings.map(
                  (warning) => (
                    <span className="source-note" key={warning}>
                      {warning}
                    </span>
                  ),
                )}
                <button
                  className="text-action"
                  disabled={sessionEnded}
                  onClick={restoreImportedSource}
                  type="button"
                >
                  Restore imported text
                </button>
                <button
                  className="text-action"
                  onClick={downloadImportedOriginal}
                  type="button"
                >
                  Download original
                </button>
              </>
            )}
          </div>
          <div className="setting-block attachment-block">
            <div className="attachment-heading">
              <p className="setting-label">Attachments</p>
              <span>
                {selectedEnvelope.attachments.length}/{MAX_ATTACHMENTS}
              </span>
            </div>
            {selectedEnvelope.attachments.length === 0 ? (
              <>
                <span>No file is attached in this session.</span>
                <button
                  className="text-action"
                  disabled={
                    sessionEnded ||
                    activeFileOperation !== null ||
                    pendingImport !== null ||
                    pendingAttachmentReview !== null
                  }
                  onClick={(event) => {
                    nextAttachmentFocusOriginRef.current = event.currentTarget;
                    attachmentRef.current?.click();
                  }}
                  type="button"
                >
                  Add supporting files
                </button>
              </>
            ) : (
              <ul>
                {selectedEnvelope.attachments.map((attachment) => (
                  <li key={attachment.sourceId}>
                    <div>
                      <strong>{attachment.filename}</strong>
                      <span>
                        {attachment.kind} · {formatBytes(attachment.sizeBytes)}
                      </span>
                    </div>
                    <div className="attachment-actions">
                      <button
                        aria-label={`Download ${attachment.filename}`}
                        className="text-action"
                        onClick={() => downloadAttachment(attachment)}
                        type="button"
                      >
                        Download
                      </button>
                      <button
                        aria-label={`Remove ${attachment.filename}`}
                        className="text-action text-action-danger"
                        disabled={sessionEnded}
                        onClick={() => removeAttachment(attachment.sourceId)}
                        type="button"
                      >
                        Remove
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <span>No file was uploaded or sent.</span>
          </div>
          <div className="setting-block version-block">
            <p className="setting-label">Session versions</p>
            <span>
              Document only · Attachments and imported source stay unchanged ·
              refresh clears this history
            </span>
            {activeVersions.versions.length === 0 ? (
              <span>Save a version before a larger edit.</span>
            ) : (
              <ol>
                {activeVersions.versions.map((version, index) => (
                  <li key={version.versionId}>
                    <strong>
                      Version {version.versionNumber}
                      {index === 0 ? ' · most recently saved' : ''}
                    </strong>
                    <span>{version.document.title}</span>
                    <time dateTime={new Date(version.savedAt).toISOString()}>
                      {formatVersionTime(version.savedAt)}
                    </time>
                    <button
                      aria-label={`Review Version ${version.versionNumber}: ${version.document.title}`}
                      className="text-action"
                      data-version-id={version.versionId}
                      disabled={sessionEnded}
                      onClick={(event) =>
                        reviewDocumentRestore(
                          version.versionId,
                          now(),
                          event.currentTarget,
                        )
                      }
                      type="button"
                    >
                      Review restore
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </div>
          <div className="setting-block">
            <p className="setting-label">Protection</p>
            <strong>Standard Mode</strong>
            <span>UI direction only · no encryption is implemented</span>
          </div>
          <div className="setting-block">
            <p className="setting-label">Release policy</p>
            <strong>Guardian attestation first</strong>
            <span>Not executable in this build</span>
          </div>
          <div className="setting-block is-disabled">
            <p className="setting-label">Sealed Mode</p>
            <strong>Unavailable</strong>
            <span>Blocked pending protocol and independent review</span>
          </div>
        </aside>
      </div>

      {sessionEnded || pendingRestore === null ? null : (
        <dialog
          aria-describedby="restore-version-description"
          aria-labelledby="restore-version-title"
          className="confirmation-dialog version-restore-dialog"
          onCancel={(event) => {
            event.preventDefault();
            setPendingRestore(null);
          }}
          onKeyDown={containRestoreDialogFocus}
          ref={restoreDialogRef}
          tabIndex={-1}
        >
          <p className="eyebrow">Document-only session restore</p>
          <h2 id="restore-version-title">
            Restore Version {pendingRestore.plan.targetVersion.versionNumber}?
          </h2>
          <p id="restore-version-description">
            This restores only the Editable Document. Attachments and
            imported-source provenance stay unchanged.
          </p>
          <dl className="restore-comparison">
            {pendingRestore.plan.changes.titleChanged ? (
              <div>
                <dt>Title</dt>
                <dd>
                  <span>
                    <span className="visually-hidden">Current title: </span>
                    {pendingRestore.reviewedDocument.title}
                  </span>
                  <span aria-hidden="true">→</span>
                  <strong>
                    <span className="visually-hidden">Restored title: </span>
                    {pendingRestore.plan.targetVersion.document.title}
                  </strong>
                </dd>
              </div>
            ) : null}
            {pendingRestore.plan.changes.recipientChanged ? (
              <div>
                <dt>Recipient</dt>
                <dd>
                  <span>
                    <span className="visually-hidden">Current Recipient: </span>
                    {pendingRestore.reviewedDocument.recipientLabel}
                  </span>
                  <span aria-hidden="true">→</span>
                  <strong>
                    <span className="visually-hidden">
                      Restored Recipient:{' '}
                    </span>
                    {pendingRestore.plan.targetVersion.document.recipientLabel}
                  </strong>
                </dd>
              </div>
            ) : null}
          </dl>
          {pendingRestore.plan.changes.markdownChanged ? (
            <div className="restore-preview">
              <span className="review-label">
                Version {pendingRestore.plan.targetVersion.versionNumber}{' '}
                content preview
              </span>
              <blockquote>
                {summarizeMarkdown(
                  pendingRestore.plan.targetVersion.document.markdown,
                )}
              </blockquote>
            </div>
          ) : null}
          {pendingRestore.plan.preservedCurrentVersion === null ? null : (
            <p className="restore-preservation">
              Your current draft remains available as Version{' '}
              {pendingRestore.plan.preservedCurrentVersion.versionNumber}.
            </p>
          )}
          <div className="dialog-actions">
            <button
              autoFocus
              className="button button-quiet"
              onClick={() => setPendingRestore(null)}
              type="button"
            >
              Keep current draft
            </button>
            <button
              className="button button-primary"
              disabled={sessionEnded}
              onClick={confirmDocumentRestore}
              type="button"
            >
              Restore document
            </button>
          </div>
        </dialog>
      )}
    </div>
  );
}
