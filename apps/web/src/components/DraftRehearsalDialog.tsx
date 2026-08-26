import type { DraftRehearsalReview } from '@vidha/application';
import { useEffect, useRef, type KeyboardEvent, type RefObject } from 'react';

interface DraftRehearsalDialogProps {
  readonly completing: boolean;
  readonly onCancel: () => void;
  readonly onComplete: () => Promise<void>;
  readonly returnFocusRef: RefObject<HTMLButtonElement | null>;
  readonly review: DraftRehearsalReview;
}

const DAY = 24 * 60 * 60 * 1_000;

function formatTimelineOffset(afterMs: number): string {
  const days = afterMs / DAY;
  return Number.isInteger(days)
    ? `Day ${String(days)}`
    : `${new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(days)} days`;
}

export function DraftRehearsalDialog({
  completing,
  onCancel,
  onComplete,
  returnFocusRef,
  review,
}: DraftRehearsalDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    const returnFocus = returnFocusRef.current;
    if (dialog === null) return;
    if (!dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    }
    dialog.scrollTop = 0;
    dialog.focus({ preventScroll: true });
    return () => {
      if (dialog.open && typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
      window.requestAnimationFrame(() => returnFocus?.focus());
    };
  }, [returnFocusRef]);

  function containFocus(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key !== 'Tab') return;
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
    if (
      event.shiftKey &&
      (focused === dialog || focused === first || !dialog.contains(focused))
    ) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && focused === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <dialog
      aria-describedby="draft-rehearsal-description"
      aria-labelledby="draft-rehearsal-title"
      className="confirmation-dialog rehearsal-review-dialog"
      onCancel={(event) => {
        event.preventDefault();
        if (!completing) onCancel();
      }}
      onKeyDown={containFocus}
      ref={dialogRef}
      tabIndex={-1}
    >
      <div className="rehearsal-dialog-heading">
        <div>
          <p className="eyebrow">Draft rehearsal run-sheet</p>
          <h2 id="draft-rehearsal-title">
            Review what this local rehearsal will test
          </h2>
        </div>
        <div className="rehearsal-tally" aria-label="Local rehearsal tally">
          <strong>{review.noticeIntents.length}</strong>
          <span>notice previews</span>
          <strong>0</strong>
          <span>messages sent</span>
        </div>
      </div>
      <p id="draft-rehearsal-description">
        This review binds the current Draft, synthetic contacts, and every
        Editable Document and Attachment identity. It never contacts anyone or
        activates a Check-in timeline.
      </p>

      <div className="rehearsal-review-grid">
        <section aria-labelledby="rehearsal-timeline-title">
          <p className="review-label" id="rehearsal-timeline-title">
            Timeline after a later Arm action
          </p>
          <ol className="rehearsal-timeline">
            {review.timeline.map((step) => (
              <li className={step.stop ? 'is-stop' : undefined} key={step.id}>
                <span>{formatTimelineOffset(step.afterMs)}</span>
                <strong>{step.label}</strong>
                {step.stop ? (
                  <small>No Guardian Attestation or Release follows.</small>
                ) : null}
              </li>
            ))}
          </ol>
        </section>
        <section aria-labelledby="rehearsal-checks-title">
          <p className="review-label" id="rehearsal-checks-title">
            Readiness checks
          </p>
          <ul className="rehearsal-checks">
            {review.checks.map((check) => (
              <li className={`is-${check.status}`} key={check.id}>
                <span aria-hidden="true">
                  {check.status === 'ready' ? '✓' : '!'}
                </span>
                <div>
                  <strong>{check.title}</strong>
                  <small>{check.detail}</small>
                </div>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section
        aria-labelledby="rehearsal-handoffs-title"
        className="rehearsal-handoffs"
      >
        <p className="review-label" id="rehearsal-handoffs-title">
          Prepared handoffs in this review
        </p>
        <div>
          {review.envelopes.map((envelope) => (
            <article key={envelope.envelopeId}>
              <strong>{envelope.title}</strong>
              <span>For {envelope.recipientLabel}</span>
              <small>
                {envelope.protectionMode} direction · {envelope.releasePolicy} ·{' '}
                {envelope.attachmentCount} Attachment
                {envelope.attachmentCount === 1 ? '' : 's'}
              </small>
            </article>
          ))}
        </div>
      </section>

      <section
        aria-labelledby="rehearsal-notice-title"
        className="rehearsal-notice-preview"
      >
        <div>
          <p className="review-label" id="rehearsal-notice-title">
            Content-free notice preview
          </p>
          <span>
            Shown for {review.noticeIntents.length} synthetic Guardian and
            Recipient contacts
          </span>
        </div>
        <blockquote>
          {review.noticeIntents[0]?.message ??
            'No notice preview is available.'}
        </blockquote>
      </section>

      <p className="rehearsal-stop-note">
        This phase stops at a local PLAN_REHEARSED event. No provider, Guardian
        authority, final notice, Veto Window, Delivery Hold, Automatic Fallback,
        or Release is implemented.
      </p>
      <div className="dialog-actions">
        <button
          className="button button-quiet"
          disabled={completing}
          onClick={onCancel}
          type="button"
        >
          Keep Draft
        </button>
        <button
          className="button button-primary"
          disabled={!review.canComplete || completing}
          onClick={() => void onComplete()}
          type="button"
        >
          {completing ? 'Running local rehearsal…' : 'Run local rehearsal'}
        </button>
      </div>
    </dialog>
  );
}
