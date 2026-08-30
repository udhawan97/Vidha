import { useCallback, useEffect, useRef, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';

import type { SessionLossReview as SessionLossReviewModel } from '../sessionLossReview';
import { OwnerActionDialog } from './OwnerActionDialog';
import { SessionLossReview } from './SessionLossReview';

interface UpdateNoticeProps {
  readonly actionPending: boolean;
  readonly fileReviewPending: boolean;
  readonly hasSessionWork: boolean;
  readonly onReviewEnvelope: (envelopeId: string) => void;
  readonly otherTabBlocksUpdate: boolean;
  readonly sessionLossReview: SessionLossReviewModel;
}

export const UPDATE_HANDOFF_TIMEOUT_MS = 10_000;

export function UpdateNotice({
  actionPending,
  fileReviewPending,
  hasSessionWork,
  onReviewEnvelope,
  otherTabBlocksUpdate,
  sessionLossReview,
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
  const suppressConfirmationReturnFocusRef = useRef(false);
  const shouldReturnConfirmationFocus = useCallback(
    () => !suppressConfirmationReturnFocusRef.current,
    [],
  );
  const confirmedReloadRef = useRef(false);
  const updateAttemptRef = useRef(0);
  const updateHandoffTimerRef = useRef<number | null>(null);
  const updatePendingRef = useRef(false);

  const clearUpdateHandoffTimer = useCallback(() => {
    if (updateHandoffTimerRef.current === null) return;
    window.clearTimeout(updateHandoffTimerRef.current);
    updateHandoffTimerRef.current = null;
  }, []);

  const restoreUpdateDecision = useCallback(
    (attempt: number, issue: string) => {
      if (updateAttemptRef.current !== attempt) return;
      updateAttemptRef.current += 1;
      clearUpdateHandoffTimer();
      confirmedReloadRef.current = false;
      updatePendingRef.current = false;
      setUpdatePending(false);
      setUpdateIssue(issue);
    },
    [clearUpdateHandoffTimer],
  );

  useEffect(() => {
    if (!hasSessionWork && !fileReviewPending) {
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
  }, [fileReviewPending, hasSessionWork]);

  useEffect(() => {
    function restoreReturnedTab() {
      if (!confirmedReloadRef.current || !updatePendingRef.current) return;
      restoreUpdateDecision(
        updateAttemptRef.current,
        'This tab returned before the update finished. Your local rehearsal is still open, and changed work is protected again. Keep working or try again.',
      );
    }

    window.addEventListener('pageshow', restoreReturnedTab);
    return () => window.removeEventListener('pageshow', restoreReturnedTab);
  }, [restoreUpdateDecision]);

  useEffect(
    () => () => {
      updateAttemptRef.current += 1;
      clearUpdateHandoffTimer();
    },
    [clearUpdateHandoffTimer],
  );

  async function applyUpdate() {
    if (actionPending || fileReviewPending || updatePendingRef.current) return;
    if (otherTabBlocksUpdate) {
      setConfirmationOpen(false);
      setUpdateIssue(
        'Another tab contains changed work, a file review, or an Owner action in progress. Close it before updating this build.',
      );
      return;
    }
    const attempt = updateAttemptRef.current + 1;
    updateAttemptRef.current = attempt;
    confirmedReloadRef.current = true;
    updatePendingRef.current = true;
    setUpdateIssue(null);
    setUpdatePending(true);
    clearUpdateHandoffTimer();
    updateHandoffTimerRef.current = window.setTimeout(() => {
      restoreUpdateDecision(
        attempt,
        'The update did not replace this tab in time. Your local rehearsal is still open, and changed work is protected again. Keep working or try again.',
      );
    }, UPDATE_HANDOFF_TIMEOUT_MS);
    try {
      await updateServiceWorker(true);
    } catch {
      restoreUpdateDecision(
        attempt,
        'The update did not start. Your local rehearsal is still open. Keep working or try again.',
      );
    }
  }

  function requestUpdate() {
    if (
      actionPending ||
      fileReviewPending ||
      updatePendingRef.current ||
      otherTabBlocksUpdate
    )
      return;
    if (hasSessionWork) {
      suppressConfirmationReturnFocusRef.current = false;
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
    : fileReviewPending
      ? 'Finish the current file review before updating this local rehearsal.'
      : otherTabBlocksUpdate
        ? 'Another tab contains changed work, a file review, or an Owner action in progress. Close it before updating; tabs do not synchronize.'
        : hasSessionWork
          ? 'Updating reloads this browser-only rehearsal. Download anything you want to keep before continuing.'
          : 'This untouched disposable rehearsal can reload into the new build.';
  const updateLabel = actionPending
    ? 'Owner action in progress'
    : fileReviewPending
      ? 'File review in progress'
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
              disabled={
                actionPending ||
                fileReviewPending ||
                updatePending ||
                otherTabBlocksUpdate
              }
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
          shouldReturnFocus={shouldReturnConfirmationFocus}
          title="Update and clear this rehearsal?"
          tone="danger"
        >
          <SessionLossReview
            onReviewEnvelope={(envelopeId) => {
              suppressConfirmationReturnFocusRef.current = true;
              setConfirmationOpen(false);
              setUpdateIssue(null);
              onReviewEnvelope(envelopeId);
            }}
            review={sessionLossReview}
          />
        </OwnerActionDialog>
      ) : null}
    </>
  );
}
