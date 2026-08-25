import {
  type ChangeEvent,
  type Dispatch,
  type SetStateAction,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  AttachmentIntakeError,
  EditableDocumentError,
  ImportIntakeError,
  SUPPORTED_ATTACHMENT_FORMATS,
  createEditableDocument,
  createImportIntake,
  exportEditableDocument,
  prepareAttachmentCandidate,
  utf8TextConverter,
  type AttachmentCandidate,
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

interface DocumentWorkspaceProps {
  readonly envelopes: DemoEnvelope[];
  readonly onSelectEnvelope: (envelopeId: string) => void;
  readonly selectedEnvelopeId: string;
  readonly setEnvelopes: Dispatch<SetStateAction<DemoEnvelope[]>>;
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

interface SessionCheckpoint {
  readonly id: string;
  readonly createdAt: number;
  readonly snapshot: DraftSnapshot;
}

const MAX_IMPORT_BYTES = 256 * 1024;
const MAX_IMPORT_LINES = 10_000;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_ATTACHMENT_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_ATTACHMENTS = 8;
const MAX_UNDO_STEPS = 50;
const MAX_CHECKPOINTS = 6;
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

function formatCheckpointTime(timestamp: number): string {
  return new Intl.DateTimeFormat('en', {
    hour: 'numeric',
    minute: '2-digit',
  }).format(timestamp);
}

export function DocumentWorkspace({
  envelopes,
  onSelectEnvelope,
  selectedEnvelopeId,
  setEnvelopes,
}: DocumentWorkspaceProps) {
  const [editorMode, setEditorMode] = useState<EditorMode>('write');
  const [sessionStatus, setSessionStatus] = useState('Synthetic session draft');
  const [exportFormat, setExportFormat] =
    useState<PortableDocumentFormat>('markdown');
  const [importError, setImportError] = useState<string | null>(null);
  const [pendingImport, setPendingImport] =
    useState<ReviewableTextImport | null>(null);
  const [pendingAttachments, setPendingAttachments] = useState<
    readonly AttachmentCandidate[]
  >([]);
  const [historyByEnvelope, setHistoryByEnvelope] = useState<
    Record<string, DraftHistory>
  >({});
  const [checkpointsByEnvelope, setCheckpointsByEnvelope] = useState<
    Record<string, readonly SessionCheckpoint[]>
  >({});
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const attachmentRef = useRef<HTMLInputElement>(null);
  const checkpointSequence = useRef(0);
  const activeEnvelope =
    envelopes.find((envelope) => envelope.id === selectedEnvelopeId) ??
    envelopes[0];

  useEffect(() => {
    if (activeEnvelope === undefined) {
      return;
    }
    const timer = window.setTimeout(() => {
      setSessionStatus('Session draft updated');
    }, 500);
    return () => window.clearTimeout(timer);
  }, [activeEnvelope]);

  if (activeEnvelope === undefined) {
    return null;
  }
  const selectedEnvelope = activeEnvelope;
  const activeHistory = historyByEnvelope[selectedEnvelope.id] ?? {
    past: [],
    future: [],
  };
  const activeCheckpoints = checkpointsByEnvelope[selectedEnvelope.id] ?? [];

  function updateActiveEnvelope(patch: Partial<DemoEnvelope>) {
    setSessionStatus('Editing in this session…');
    setHistoryByEnvelope((current) => {
      const history = current[selectedEnvelope.id] ?? {
        past: [],
        future: [],
      };
      return {
        ...current,
        [selectedEnvelope.id]: {
          past: [...history.past, snapshotEnvelope(selectedEnvelope)].slice(
            -MAX_UNDO_STEPS,
          ),
          future: [],
        },
      };
    });
    setEnvelopes((current) =>
      current.map((envelope) =>
        envelope.id === selectedEnvelope.id
          ? { ...envelope, ...patch }
          : envelope,
      ),
    );
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

  function saveCheckpoint() {
    checkpointSequence.current += 1;
    const createdAt = Date.now();
    const checkpoint: SessionCheckpoint = {
      id: `${selectedEnvelope.id}-${checkpointSequence.current}`,
      createdAt,
      snapshot: snapshotEnvelope(selectedEnvelope),
    };
    setCheckpointsByEnvelope((current) => ({
      ...current,
      [selectedEnvelope.id]: [
        checkpoint,
        ...(current[selectedEnvelope.id] ?? []),
      ].slice(0, MAX_CHECKPOINTS),
    }));
    setSessionStatus('Session checkpoint saved');
  }

  function restoreCheckpoint(checkpoint: SessionCheckpoint) {
    updateActiveEnvelope(checkpoint.snapshot);
    setSessionStatus('Session checkpoint restored');
  }

  function insertMarkdown(prefix: string, suffix = prefix) {
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

  async function importTextFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (file === undefined) {
      return;
    }

    setImportError(null);
    setPendingAttachments([]);
    try {
      const prepared = await importIntake.prepare({
        bytes: new Uint8Array(await file.arrayBuffer()),
        declaredMediaType: file.type,
        filename: file.name,
      });
      const inspected = await importIntake.inspect(prepared);
      const reviewable = await importIntake.review(inspected);
      setPendingImport(reviewable);
      setSessionStatus('Editable copy ready for explicit review');
    } catch (error) {
      setPendingImport(null);
      setImportError(
        error instanceof ImportIntakeError
          ? error.message
          : 'The import could not be inspected.',
      );
    }
  }

  async function stageAttachmentFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = [...(event.currentTarget.files ?? [])];
    event.currentTarget.value = '';
    if (files.length === 0) {
      return;
    }

    setImportError(null);
    setPendingImport(null);
    const candidates: AttachmentCandidate[] = [];
    const errors: string[] = [];
    const existingSourceIds = new Set(
      selectedEnvelope.attachments.map((attachment) => attachment.sourceId),
    );
    let totalBytes = selectedEnvelope.attachments.reduce(
      (total, attachment) => total + attachment.sizeBytes,
      0,
    );

    for (const file of files) {
      if (
        selectedEnvelope.attachments.length + candidates.length >=
        MAX_ATTACHMENTS
      ) {
        errors.push(
          `${file.name}: this rehearsal keeps at most ${MAX_ATTACHMENTS} Attachment candidates per Envelope.`,
        );
        continue;
      }
      try {
        const candidate = await prepareAttachmentCandidate(
          {
            bytes: new Uint8Array(await file.arrayBuffer()),
            declaredMediaType: file.type,
            filename: file.name,
          },
          { maxBytes: MAX_ATTACHMENT_BYTES },
        );
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

    setPendingAttachments(candidates);
    if (errors.length > 0) {
      setImportError(errors.join(' '));
    }
    if (candidates.length > 0) {
      setSessionStatus(
        `${candidates.length} Attachment candidate${candidates.length === 1 ? '' : 's'} staged for review`,
      );
    }
  }

  function approvePendingAttachments() {
    if (pendingAttachments.length === 0) {
      return;
    }
    updateActiveEnvelope({
      attachments: [
        ...selectedEnvelope.attachments,
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
    });
    setPendingAttachments([]);
    setSessionStatus(
      `${pendingAttachments.length} Attachment${pendingAttachments.length === 1 ? '' : 's'} kept in this session`,
    );
  }

  async function approvePendingImport() {
    if (pendingImport === null) {
      return;
    }
    try {
      const approved = await importIntake.approve(pendingImport);
      const canonicalDocument = createEditableDocument({
        title: filenameToTitle(approved.filename),
        markdown: approved.text,
        recipientLabel: selectedEnvelope.documentDraft.recipientLabel,
      });
      updateActiveEnvelope({
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
      });
      setPendingImport(null);
      setSessionStatus('Editable copy created from the reviewed source');
    } catch (error) {
      setImportError(
        error instanceof ImportIntakeError
          ? error.message
          : 'The inspected import could not be approved.',
      );
    }
  }

  function removeAttachment(sourceId: string) {
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
    <div className="workspace-view">
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
            onClick={() => importRef.current?.click()}
            type="button"
          >
            Import editable text
          </button>
          <button
            className="button button-quiet"
            onClick={() => attachmentRef.current?.click()}
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
            <h2 id="pending-import-title">
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
              onClick={() => setPendingImport(null)}
              type="button"
            >
              Discard
            </button>
            <button
              className="button button-primary"
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
            <h2 id="pending-attachments-title">
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
              onClick={() => setPendingAttachments([])}
              type="button"
            >
              Discard
            </button>
            <button
              className="button button-primary"
              onClick={approvePendingAttachments}
              type="button"
            >
              Keep as Attachments
            </button>
          </div>
        </section>
      )}

      <div className="workspace-shell">
        <aside className="document-list" aria-label="Demo Envelopes">
          <div className="document-list-heading">
            <span>Envelopes</span>
            <span>{envelopes.length}</span>
          </div>
          {envelopes.map((envelope) => (
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
                onSelectEnvelope(envelope.id);
                setPendingImport(null);
                setPendingAttachments([]);
                setImportError(null);
              }}
              type="button"
            >
              <strong>{envelope.documentDraft.title}</strong>
              <span>For {envelope.documentDraft.recipientLabel}</span>
              <span>{`${envelope.attachments.length} Attachment${envelope.attachments.length === 1 ? '' : 's'}`}</span>
            </button>
          ))}
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
                className="document-title-input"
                onChange={(event) =>
                  updateActiveDocument({ title: event.target.value })
                }
                maxLength={200}
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

          <div className="editor-toolbar" aria-label="Markdown formatting">
            <button
              aria-label="Undo session edit"
              disabled={activeHistory.past.length === 0}
              onClick={undoEdit}
              type="button"
            >
              Undo
            </button>
            <button
              aria-label="Redo session edit"
              disabled={activeHistory.future.length === 0}
              onClick={redoEdit}
              type="button"
            >
              Redo
            </button>
            <span className="toolbar-divider" />
            <button
              aria-label="Bold selected text"
              onClick={() => insertMarkdown('**')}
              type="button"
            >
              <strong>B</strong>
            </button>
            <button
              aria-label="Italicize selected text"
              onClick={() => insertMarkdown('_')}
              type="button"
            >
              <em>I</em>
            </button>
            <button
              aria-label="Make selected text a heading"
              onClick={() => insertMarkdown('## ', '')}
              type="button"
            >
              H2
            </button>
            <button
              aria-label="Make selected text a list item"
              onClick={() => insertMarkdown('- ', '')}
              type="button"
            >
              List
            </button>
            <span className="toolbar-divider" />
            <button onClick={saveCheckpoint} type="button">
              Save checkpoint
            </button>
            <span className="editor-status">{sessionStatus}</span>
          </div>

          {editorMode === 'write' ? (
            <textarea
              aria-label="Envelope Markdown content"
              className="document-textarea"
              onChange={(event) =>
                updateActiveDocument({ markdown: event.target.value })
              }
              maxLength={1_000_000}
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
                  onClick={() => attachmentRef.current?.click()}
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
          <div className="setting-block checkpoint-block">
            <p className="setting-label">Session checkpoints</p>
            {activeCheckpoints.length === 0 ? (
              <span>Save a checkpoint before a larger edit.</span>
            ) : (
              <ol>
                {activeCheckpoints.map((checkpoint, index) => (
                  <li key={checkpoint.id}>
                    <span>
                      {index === 0 ? 'Latest' : `Checkpoint ${index + 1}`} ·{' '}
                      {formatCheckpointTime(checkpoint.createdAt)}
                    </span>
                    <button
                      aria-label={`Restore ${
                        index === 0
                          ? 'latest checkpoint'
                          : `checkpoint ${index + 1}`
                      }`}
                      className="text-action"
                      data-checkpoint-id={checkpoint.id}
                      onClick={() => restoreCheckpoint(checkpoint)}
                      type="button"
                    >
                      Restore
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
    </div>
  );
}
