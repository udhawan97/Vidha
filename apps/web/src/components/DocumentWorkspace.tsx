import {
  type ChangeEvent,
  type Dispatch,
  type SetStateAction,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  ImportIntakeError,
  createImportIntake,
  utf8TextConverter,
  type ImportScanner,
  type InspectedImport,
} from '@vidha/documents';

import {
  demoRecipients,
  type DemoEnvelope,
  type DemoImportSource,
} from '../demo';
import { buildPortableHtml, exportFilename } from '../documentExport';

interface DocumentWorkspaceProps {
  readonly envelopes: DemoEnvelope[];
  readonly setEnvelopes: Dispatch<SetStateAction<DemoEnvelope[]>>;
}

type EditorMode = 'write' | 'preview';

interface DraftSnapshot {
  readonly title: string;
  readonly body: string;
  readonly recipient: string;
  readonly importSource: DemoImportSource | null;
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
const MAX_UNDO_STEPS = 50;
const MAX_CHECKPOINTS = 6;

const syntheticFixtureScanner: ImportScanner = {
  async scan(source) {
    const startedAt = Date.now();
    return {
      scannerId: 'synthetic-fixture-inspection-no-malware-scan',
      engineVersion: 'fixture-v1',
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
    title: envelope.title,
    body: envelope.body,
    recipient: envelope.recipient,
    importSource: envelope.importSource,
  };
}

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function formatCheckpointTime(timestamp: number): string {
  return new Intl.DateTimeFormat('en', {
    hour: 'numeric',
    minute: '2-digit',
  }).format(timestamp);
}

export function DocumentWorkspace({
  envelopes,
  setEnvelopes,
}: DocumentWorkspaceProps) {
  const [selectedId, setSelectedId] = useState(envelopes[0]?.id ?? '');
  const [editorMode, setEditorMode] = useState<EditorMode>('write');
  const [sessionStatus, setSessionStatus] = useState('Synthetic session draft');
  const [importError, setImportError] = useState<string | null>(null);
  const [pendingImport, setPendingImport] = useState<InspectedImport | null>(
    null,
  );
  const [historyByEnvelope, setHistoryByEnvelope] = useState<
    Record<string, DraftHistory>
  >({});
  const [checkpointsByEnvelope, setCheckpointsByEnvelope] = useState<
    Record<string, readonly SessionCheckpoint[]>
  >({});
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const checkpointSequence = useRef(0);
  const activeEnvelope =
    envelopes.find((envelope) => envelope.id === selectedId) ?? envelopes[0];

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
    const selection = selectedEnvelope.body.slice(start, end) || 'text';
    const body = `${selectedEnvelope.body.slice(0, start)}${prefix}${selection}${suffix}${selectedEnvelope.body.slice(end)}`;
    updateActiveEnvelope({ body });

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
    try {
      const prepared = await importIntake.prepare({
        bytes: new Uint8Array(await file.arrayBuffer()),
        declaredMediaType: file.type,
        filename: file.name,
      });
      const inspected = await importIntake.inspect(prepared);
      setPendingImport(inspected);
      setSessionStatus('Import quarantined for explicit approval');
    } catch (error) {
      setPendingImport(null);
      setImportError(
        error instanceof ImportIntakeError
          ? error.message
          : 'The import could not be inspected.',
      );
    }
  }

  async function approvePendingImport() {
    if (pendingImport === null) {
      return;
    }
    try {
      const approved = await importIntake.approve(pendingImport);
      updateActiveEnvelope({
        title: filenameToTitle(approved.filename),
        body: approved.text,
        importSource: {
          filename: approved.filename,
          mediaType: approved.declaredMediaType || approved.detectedMediaType,
          detectedMediaType: approved.detectedMediaType,
          sizeBytes: approved.sizeBytes,
          sourceId: approved.sourceId,
          scannerId: approved.scan.scannerId,
          originalBytes: Uint8Array.from(approved.originalBytes),
          text: approved.text,
        },
      });
      setPendingImport(null);
      setSessionStatus('Approved decoded text imported into this session');
    } catch (error) {
      setImportError(
        error instanceof ImportIntakeError
          ? error.message
          : 'The inspected import could not be approved.',
      );
    }
  }

  function downloadDocument(
    content: BlobPart,
    mediaType: string,
    filename: string,
    status: string,
  ) {
    const blob = new Blob([content], { type: `${mediaType};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
    setSessionStatus(status);
  }

  function restoreImportedSource() {
    const source = selectedEnvelope.importSource;
    if (source === null) {
      return;
    }
    updateActiveEnvelope({
      title: filenameToTitle(source.filename),
      body: source.text,
    });
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

  return (
    <div className="workspace-view">
      <header className="workspace-heading">
        <div>
          <p className="eyebrow">Document workspace · Phase 2 foundation</p>
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
          <button
            className="button button-quiet"
            onClick={() => importRef.current?.click()}
            type="button"
          >
            Import text
          </button>
          <button
            className="button button-primary"
            onClick={() =>
              downloadDocument(
                selectedEnvelope.body,
                'text/markdown',
                exportFilename(selectedEnvelope.title, 'md'),
                'Markdown export prepared',
              )
            }
            type="button"
          >
            Export Markdown
          </button>
          <button
            className="button button-quiet"
            onClick={() =>
              downloadDocument(
                selectedEnvelope.body,
                'text/plain',
                exportFilename(selectedEnvelope.title, 'txt'),
                'Plain-text export prepared',
              )
            }
            type="button"
          >
            Export text
          </button>
          <button
            className="button button-quiet"
            onClick={() =>
              downloadDocument(
                buildPortableHtml(selectedEnvelope),
                'text/html',
                exportFilename(selectedEnvelope.title, 'html'),
                'Escaped standalone HTML export prepared',
              )
            }
            type="button"
          >
            Export HTML
          </button>
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
            <p className="eyebrow">Quarantined session intake</p>
            <h2 id="pending-import-title">Review {pendingImport.filename}</h2>
            <p>
              {formatBytes(pendingImport.sizeBytes)} ·{' '}
              {pendingImport.detectedMediaType}. Original bytes are held only
              for this browser session.
            </p>
            <p className="intake-warning">
              Synthetic fixture inspection only · no malware scanner or
              sandboxed converter is active.
            </p>
            {pendingImport.warnings.map((warning) => (
              <p className="intake-warning" key={warning}>
                {warning}
              </p>
            ))}
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
              Approve decoded text
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
              onClick={() => setSelectedId(envelope.id)}
              type="button"
            >
              <strong>{envelope.title}</strong>
              <span>For {envelope.recipient}</span>
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
                  updateActiveEnvelope({ title: event.target.value })
                }
                value={selectedEnvelope.title}
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
                updateActiveEnvelope({ body: event.target.value })
              }
              ref={textareaRef}
              spellCheck="true"
              value={selectedEnvelope.body}
            />
          ) : (
            <article
              className="document-preview"
              aria-label="Plain-text preview"
            >
              {selectedEnvelope.body}
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
                updateActiveEnvelope({ recipient: event.target.value })
              }
              value={selectedEnvelope.recipient}
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
