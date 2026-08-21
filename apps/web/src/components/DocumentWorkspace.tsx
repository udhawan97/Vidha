import {
  type ChangeEvent,
  type Dispatch,
  type SetStateAction,
  useEffect,
  useRef,
  useState,
} from 'react';

import type { DemoEnvelope } from '../demo';

interface DocumentWorkspaceProps {
  readonly envelopes: DemoEnvelope[];
  readonly setEnvelopes: Dispatch<SetStateAction<DemoEnvelope[]>>;
}

type EditorMode = 'write' | 'preview';

const MAX_IMPORT_BYTES = 256 * 1024;

function filenameToTitle(filename: string): string {
  const withoutExtension = filename.replace(/\.[^.]+$/, '');
  return withoutExtension.replace(/[-_]+/g, ' ').trim() || 'Imported draft';
}

function safeFilename(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `${slug || 'vidha-draft'}.md`;
}

export function DocumentWorkspace({
  envelopes,
  setEnvelopes,
}: DocumentWorkspaceProps) {
  const [selectedId, setSelectedId] = useState(envelopes[0]?.id ?? '');
  const [editorMode, setEditorMode] = useState<EditorMode>('write');
  const [sessionStatus, setSessionStatus] = useState('Synthetic session draft');
  const [importError, setImportError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
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

  function updateActiveEnvelope(patch: Partial<DemoEnvelope>) {
    setSessionStatus('Editing in this session…');
    setEnvelopes((current) =>
      current.map((envelope) =>
        envelope.id === selectedEnvelope.id
          ? { ...envelope, ...patch }
          : envelope,
      ),
    );
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
    const supportedExtension = /\.(md|markdown|txt)$/i.test(file.name);
    if (!supportedExtension) {
      setImportError('This build imports only Markdown and plain-text files.');
      return;
    }
    if (file.size > MAX_IMPORT_BYTES) {
      setImportError('The demo import limit is 256 KB.');
      return;
    }

    const body = await file.text();
    updateActiveEnvelope({
      title: filenameToTitle(file.name),
      body,
    });
    setSessionStatus('Imported into this temporary session');
  }

  function exportMarkdown() {
    const blob = new Blob([selectedEnvelope.body], {
      type: 'text/markdown;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = safeFilename(selectedEnvelope.title);
    link.click();
    URL.revokeObjectURL(url);
    setSessionStatus('Markdown export prepared');
  }

  return (
    <div className="workspace-view" id="main-content">
      <header className="workspace-heading">
        <div>
          <p className="eyebrow">Document workspace · Phase 1</p>
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
            onClick={exportMarkdown}
            type="button"
          >
            Export Markdown
          </button>
        </div>
      </header>

      {importError === null ? null : (
        <p className="import-error" role="alert">
          {importError}
        </p>
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
            <p className="setting-label">Recipient</p>
            <strong>{selectedEnvelope.recipient}</strong>
            <span>Synthetic verified contact</span>
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
