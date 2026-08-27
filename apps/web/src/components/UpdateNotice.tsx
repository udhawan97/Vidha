import { useEffect, useRef, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';

import { OwnerActionDialog } from './OwnerActionDialog';

interface UpdateNoticeProps {
  readonly actionPending: boolean;
  readonly hasSessionWork: boolean;
  readonly otherTabBlocksUpdate: boolean;
}

export function UpdateNotice({
  actionPending,
  hasSessionWork,
  otherTabBlocksUpdate,
}: UpdateNoticeProps) {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW();
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [updatePending, setUpdatePending] = useState(false);
  const [updateIssue, setUpdateIssue] = useState<string | null>(null);
  const updateTriggerRef = useRef<HTMLButtonElement>(null);
  const confirmedReloadRef = useRef(false);

  useEffect(() => {
    if (!hasSessionWork) {
      confirmedReloadRef.current = false;
      return;
    }
    function protectSessionWork(event: BeforeUnloadEvent) {
      if (confirmedReloadRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    }
    window.addEventListener('beforeunload', protectSessionWork);
    return () => window.removeEventListener('beforeunload', protectSessionWork);
  }, [hasSessionWork]);

  async function applyUpdate() {
    if (actionPending || updatePending) return;
    if (otherTabBlocksUpdate) {
      setConfirmationOpen(false);
      setUpdateIssue(
        'Another tab contains changed work or an Owner action in progress. Close it before updating this build.',
      );
      return;
    }
    confirmedReloadRef.current = true;
    setUpdateIssue(null);
    setUpdatePending(true);
    try {
      await updateServiceWorker(true);
    } catch {
      confirmedReloadRef.current = false;
      setUpdatePending(false);
      setUpdateIssue(
        'The update did not start. Your local rehearsal is still open. Keep working or try again.',
      );
    }
  }

  function requestUpdate() {
    if (actionPending || updatePending || otherTabBlocksUpdate) return;
    if (hasSessionWork) {
      setUpdateIssue(null);
      setConfirmationOpen(true);
      return;
    }
    void applyUpdate();
  }

  if (!needRefresh && !offlineReady) {
    return null;
  }

  const updateDescription = actionPending
    ? 'Finish the current Owner action before updating this local rehearsal.'
    : otherTabBlocksUpdate
      ? 'Another tab contains changed work or an Owner action in progress. Close it before updating; tabs do not synchronize.'
      : hasSessionWork
        ? 'Updating reloads this browser-only rehearsal. Download anything you want to keep before continuing.'
        : 'This untouched disposable rehearsal can reload into the new build.';
  const updateLabel = actionPending
    ? 'Owner action in progress'
    : otherTabBlocksUpdate
      ? 'Other tab needs attention'
      : updatePending
        ? 'Updating…'
        : hasSessionWork
          ? 'Review update'
          : 'Update now';

  return (
    <>
      <aside
        aria-label="Application update status"
        aria-live="polite"
        className="update-notice"
      >
        <div>
          <strong>
            {needRefresh ? 'A new build is ready.' : 'Ready offline.'}
          </strong>
          <p>
            {needRefresh
              ? updateDescription
              : 'The application shell can reopen without a connection.'}
          </p>
          {updateIssue === null || confirmationOpen ? null : (
            <p className="update-issue" role="alert">
              {updateIssue}
            </p>
          )}
        </div>
        <div className="update-actions">
          {needRefresh ? (
            <button
              className="button button-primary"
              disabled={actionPending || updatePending || otherTabBlocksUpdate}
              onClick={requestUpdate}
              ref={updateTriggerRef}
              type="button"
            >
              {updateLabel}
            </button>
          ) : null}
          <button
            aria-label="Dismiss update notice"
            className="notice-dismiss"
            disabled={updatePending}
            onClick={() => {
              setNeedRefresh(false);
              setOfflineReady(false);
              setUpdateIssue(null);
            }}
            type="button"
          >
            ×
          </button>
        </div>
      </aside>
      {confirmationOpen ? (
        <OwnerActionDialog
          actionLabel="Update and clear session"
          busy={updatePending}
          busyLabel="Updating…"
          cancelLabel="Keep working"
          description="Updating reloads this tab and clears its in-memory Plan timeline, Editable Document edits, import source, Attachments, Document Versions, review state, and local events. Nothing in this prototype is durably saved."
          eyebrow="Browser-only session"
          issue={updateIssue}
          onCancel={() => {
            setConfirmationOpen(false);
            setUpdateIssue(null);
          }}
          onConfirm={() => void applyUpdate()}
          returnFocusRef={updateTriggerRef}
          title="Update and clear this rehearsal?"
          tone="danger"
        />
      ) : null}
    </>
  );
}
