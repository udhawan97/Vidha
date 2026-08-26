import { useEffect, useRef, type KeyboardEvent, type RefObject } from 'react';

import './OwnerActionDialog.css';

interface OwnerActionDialogProps {
  readonly actionLabel: string;
  readonly busy: boolean;
  readonly busyLabel: string;
  readonly cancelLabel: string;
  readonly description: string;
  readonly eyebrow: string;
  readonly issue: string | null;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly returnFocusRef: RefObject<HTMLButtonElement | null>;
  readonly title: string;
  readonly tone?: 'primary' | 'danger';
}

export function OwnerActionDialog({
  actionLabel,
  busy,
  busyLabel,
  cancelLabel,
  description,
  eyebrow,
  issue,
  onCancel,
  onConfirm,
  returnFocusRef,
  title,
  tone = 'primary',
}: OwnerActionDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = `owner-action-${eyebrow.toLowerCase().replaceAll(/[^a-z0-9]+/gu, '-')}-title`;
  const descriptionId = `${titleId}-description`;

  useEffect(() => {
    const dialog = dialogRef.current;
    const returnFocus = returnFocusRef.current;
    if (dialog === null) return;
    if (!dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    }
    dialog
      .querySelector<HTMLElement>('[data-safe-default]')
      ?.focus({ preventScroll: true });
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
      aria-busy={busy}
      aria-describedby={descriptionId}
      aria-labelledby={titleId}
      className="confirmation-dialog owner-action-dialog"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
      onKeyDown={containFocus}
      ref={dialogRef}
      tabIndex={-1}
    >
      <p className="eyebrow">{eyebrow}</p>
      <h2 id={titleId}>{title}</h2>
      <p id={descriptionId}>{description}</p>
      {issue === null ? null : (
        <p className="owner-action-issue" role="alert">
          {issue}
        </p>
      )}
      <div className="dialog-actions">
        <button
          autoFocus
          className="button button-quiet"
          data-safe-default
          disabled={busy}
          onClick={onCancel}
          type="button"
        >
          {cancelLabel}
        </button>
        <button
          className={
            tone === 'danger'
              ? 'button button-text-danger'
              : 'button button-primary'
          }
          disabled={busy}
          onClick={onConfirm}
          type="button"
        >
          {busy ? busyLabel : actionLabel}
        </button>
      </div>
    </dialog>
  );
}
