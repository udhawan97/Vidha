import { SUPPORTED_ATTACHMENT_FORMATS } from '@vidha/documents';

const attachmentGroups = [
  { kind: 'document', label: 'Documents' },
  { kind: 'image', label: 'Images' },
  { kind: 'audio', label: 'Audio' },
  { kind: 'video', label: 'Video' },
  { kind: 'data', label: 'Data and contacts' },
  { kind: 'archive', label: 'Archives' },
] as const;

function extensionsFor(kind: (typeof attachmentGroups)[number]['kind']) {
  return SUPPORTED_ATTACHMENT_FORMATS.filter((format) => format.kind === kind)
    .map((format) => format.extension.toUpperCase())
    .join(', ');
}

export function OwnerGuide() {
  return (
    <div className="guide-view">
      <header className="guide-hero">
        <div>
          <p className="eyebrow">Owner guide · synthetic rehearsal</p>
          <h1>Build a handoff someone can actually follow.</h1>
        </div>
        <p>
          Vidha is organized around recipient-specific Envelopes, not one
          all-access vault. Each Envelope should answer one person’s practical
          question without giving a Guardian access to its contents.
        </p>
      </header>

      <section
        className="guide-boundary"
        aria-labelledby="guide-boundary-title"
      >
        <p className="eyebrow">Before you start</p>
        <h2 id="guide-boundary-title">
          This build rehearses; it does not relay.
        </h2>
        <p>
          Everything clears on refresh. Files are not uploaded, scanned,
          encrypted, persisted, or sent. Use only the included synthetic
          examples—never personal material.
        </p>
      </section>

      <section className="handoff-path" aria-labelledby="handoff-path-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">A calm four-part path</p>
            <h2 id="handoff-path-title">From intention to rehearsal</h2>
          </div>
          <span className="readiness-mark">Owner stays in control</span>
        </div>
        <ol>
          <li>
            <span>01</span>
            <div>
              <h3>Choose one Recipient and one purpose</h3>
              <p>
                Separate a pet-care routine, home handoff, private letter, or
                file index when the audience or Release Policy differs.
              </p>
            </div>
          </li>
          <li>
            <span>02</span>
            <div>
              <h3>Write the first action, then add context</h3>
              <p>
                Lead with what the Recipient should do, where they can verify
                it, what may change, and who else can help.
              </p>
            </div>
          </li>
          <li>
            <span>03</span>
            <div>
              <h3>Keep editable text and original files distinct</h3>
              <p>
                TXT and Markdown can become Editable Documents here. Other
                allowed formats stay byte-for-byte Attachment candidates.
              </p>
            </div>
          </li>
          <li>
            <span>04</span>
            <div>
              <h3>Review consequences and rehearse</h3>
              <p>
                Confirm the Recipient, Protection Mode, Release Policy, and
                timeline. Rehearsal never exposes the real Envelope.
              </p>
            </div>
          </li>
        </ol>
      </section>

      <div className="guide-grid">
        <section className="guide-panel" aria-labelledby="choice-guide-title">
          <p className="eyebrow">What the choices entail</p>
          <h2 id="choice-guide-title">Know the trade-off before arming</h2>
          <dl className="consequence-list">
            <div>
              <dt>Editable Document</dt>
              <dd>
                Designed for focused writing, checkpoints, and portable copies.
                Conversion can change formatting, so the original source stays
                separate.
              </dd>
            </div>
            <div>
              <dt>Attachment</dt>
              <dd>
                Preserves the original file without promising in-app editing or
                safe preview. The current browser intake is a local fixture
                only.
              </dd>
            </div>
            <div>
              <dt>Standard Mode</dt>
              <dd>
                The intended recoverable mode. Managed encryption and recovery
                are targets, not implemented protection in this prototype.
              </dd>
            </div>
            <div>
              <dt>Sealed Mode</dt>
              <dd>
                Intended to trade recovery and server-assisted features for
                operator-unreadable content. It remains unavailable pending a
                reviewed protocol.
              </dd>
            </div>
            <div>
              <dt>Guardian Attestation first</dt>
              <dd>
                The default intended Release Policy. A Guardian answers a
                bounded prompt during Concern and never declares death or sees
                Envelope content.
              </dd>
            </div>
            <div>
              <dt>Automatic Fallback</dt>
              <dd>
                A future per-Envelope opt-in with a longer delay and a full Veto
                Window. It is not available in this build.
              </dd>
            </div>
          </dl>
        </section>

        <section className="guide-panel" aria-labelledby="file-guide-title">
          <p className="eyebrow">File guide</p>
          <h2 id="file-guide-title">Broad handoff, narrow promises</h2>
          <div className="file-contract">
            <div>
              <strong>Editable in this rehearsal</strong>
              <span>TXT, MD, MARKDOWN · 256 KB</span>
            </div>
            {attachmentGroups.map((group) => (
              <div key={group.kind}>
                <strong>{group.label}</strong>
                <span>{extensionsFor(group.kind)}</span>
              </div>
            ))}
          </div>
          <p className="guide-limit">
            Attachment candidates: up to 8 files, 5 MB each, and 20 MB per
            Envelope in this session. HTML, SVG, scripts, executables, and
            macro-enabled Office files are deliberately excluded.
          </p>
        </section>
      </div>

      <section className="guide-safety" aria-labelledby="guide-safety-title">
        <div>
          <p className="eyebrow">Use Vidha for continuity</p>
          <h2 id="guide-safety-title">Leave guidance, not hidden authority.</h2>
        </div>
        <ul>
          <li>Point to authoritative originals instead of replacing them.</li>
          <li>
            Do not store passwords, passkeys, or cryptocurrency seed phrases.
          </li>
          <li>Do not rely on Vidha for emergency response or legal effect.</li>
          <li>
            Review an Envelope whenever its Recipient or instructions change.
          </li>
        </ul>
      </section>
    </div>
  );
}
