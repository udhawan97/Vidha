import { useCallback, useEffect, useRef, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';

import { buildIdentityLabel } from '../buildIdentity';
import type { SessionLossReview as SessionLossReviewModel } from '../sessionLossReview';
import {
  browserServiceWorkerController,
  requestServiceWorkerIdentity,
  type ServiceWorkerIdentityTarget,
} from '../serviceWorkerIdentity';
import {
  browserUpdateHandoffStorage,
  clearUpdateHandoffRecord,
  readUpdateHandoffReceipt,
  recordUpdateHandoff,
  type UpdateHandoffStorage,
} from '../updateHandoffReceipt';
import { OwnerActionDialog } from './OwnerActionDialog';
import { SessionLossReview } from './SessionLossReview';

interface UpdateNoticeProps {
  readonly actionPending: boolean;
  readonly buildIdentity?: string;
  readonly fileReviewPending: boolean;
  readonly hasSessionWork: boolean;
  readonly onReviewEnvelope: (envelopeId: string) => void;
  readonly otherTabBlocksUpdate: boolean;
  readonly sessionLossReview: SessionLossReviewModel;
  readonly storage?: UpdateHandoffStorage | null;
}

type WorkerRegistration = {
  readonly waiting: ServiceWorkerIdentityTarget | null;
};

type WorkerIdentityState =
  | { readonly status: 'checking' | 'idle' | 'unavailable' }
  | { readonly buildIdentity: string; readonly status: 'identified' };

type WorkerIdentityResult = {
  readonly state:
    | { readonly status: 'unavailable' }
    | { readonly buildIdentity: string; readonly status: 'identified' };
  readonly target: ServiceWorkerIdentityTarget;
};

function resolvedWorkerIdentity(
  target: ServiceWorkerIdentityTarget | null | undefined,
  result: WorkerIdentityResult | null,
): WorkerIdentityState {
  if (target === undefined) return { status: 'checking' };
  if (target === null) return { status: 'unavailable' };
  return result?.target === target ? result.state : { status: 'checking' };
}

export const UPDATE_HANDOFF_TIMEOUT_MS = 10_000;

export function UpdateNotice({
  actionPending,
  buildIdentity = 'local-development',
  fileReviewPending,
  hasSessionWork,
  onReviewEnvelope,
  otherTabBlocksUpdate,
  sessionLossReview,
  storage,
}: UpdateNoticeProps) {
  const [registeredWorker, setRegisteredWorker] = useState<
    WorkerRegistration | null | undefined
  >(undefined);
  const handleRegisteredWorker = useCallback(
    (_scriptUrl: string, registration: ServiceWorkerRegistration | undefined) =>
      setRegisteredWorker(registration ?? null),
    [],
  );
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW({ onRegisteredSW: handleRegisteredWorker });
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [updatePending, setUpdatePending] = useState(false);
  const [updateIssue, setUpdateIssue] = useState<string | null>(null);
  const [receiptStorage] = useState<UpdateHandoffStorage | null>(() =>
    storage === undefined ? browserUpdateHandoffStorage() : storage,
  );
  const [updateReceipt, setUpdateReceipt] = useState(() =>
    readUpdateHandoffReceipt(receiptStorage, buildIdentity),
  );
  const [waitingWorkerResult, setWaitingWorkerResult] =
    useState<WorkerIdentityResult | null>(null);
  const [controllerResult, setControllerResult] =
    useState<WorkerIdentityResult | null>(null);
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

  const waitingWorker =
    registeredWorker === undefined
      ? undefined
      : (registeredWorker?.waiting ?? null);
  const waitingWorkerIdentity = needRefresh
    ? resolvedWorkerIdentity(waitingWorker, waitingWorkerResult)
    : ({ status: 'idle' } satisfies WorkerIdentityState);

  useEffect(() => {
    if (!needRefresh || waitingWorker === null || waitingWorker === undefined)
      return;
    let active = true;
    void requestServiceWorkerIdentity(waitingWorker).then(
      (workerBuildIdentity) => {
        if (!active) return;
        setWaitingWorkerResult({
          state: {
            buildIdentity: workerBuildIdentity,
            status: 'identified',
          },
          target: waitingWorker,
        });
      },
      () => {
        if (active)
          setWaitingWorkerResult({
            state: { status: 'unavailable' },
            target: waitingWorker,
          });
      },
    );
    return () => {
      active = false;
    };
  }, [needRefresh, waitingWorker]);

  const controllerRequired =
    updateReceipt !== null && updateReceipt.targetBuildIdentity !== null;
  const controller = controllerRequired
    ? browserServiceWorkerController()
    : null;
  const controllerIdentity = controllerRequired
    ? resolvedWorkerIdentity(controller, controllerResult)
    : ({ status: 'idle' } satisfies WorkerIdentityState);

  useEffect(() => {
    if (!controllerRequired || controller === null) return;
    let active = true;
    void requestServiceWorkerIdentity(controller).then(
      (workerBuildIdentity) => {
        if (!active) return;
        setControllerResult({
          state: {
            buildIdentity: workerBuildIdentity,
            status: 'identified',
          },
          target: controller,
        });
      },
      () => {
        if (active)
          setControllerResult({
            state: { status: 'unavailable' },
            target: controller,
          });
      },
    );
    return () => {
      active = false;
    };
  }, [controller, controllerRequired]);

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
      clearUpdateHandoffRecord(receiptStorage);
      confirmedReloadRef.current = false;
      updatePendingRef.current = false;
      setUpdatePending(false);
      setUpdateIssue(issue);
    },
    [clearUpdateHandoffTimer, receiptStorage],
  );

  useEffect(() => {
    if (updateReceipt !== null) clearUpdateHandoffRecord(receiptStorage);
  }, [receiptStorage, updateReceipt]);

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
    if (
      waitingWorkerIdentity.status !== 'identified' ||
      waitingWorkerIdentity.buildIdentity === buildIdentity
    ) {
      setConfirmationOpen(false);
      setUpdateIssue(
        waitingWorkerIdentity.status === 'checking'
          ? 'Vidha is still checking the waiting service worker. The update was not started.'
          : waitingWorkerIdentity.status === 'identified'
            ? 'The waiting service worker reports the current build identity, so no distinct target build was verified. The update was not started.'
            : 'The waiting service worker could not provide a valid build identity. The update was not started.',
      );
      return;
    }
    if (
      !recordUpdateHandoff(
        receiptStorage,
        buildIdentity,
        waitingWorkerIdentity.buildIdentity,
      )
    ) {
      setConfirmationOpen(false);
      setUpdateIssue(
        'This browser could not record a content-free update receipt, so the update was not started. Keep working in this rehearsal.',
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

  if (!needRefresh && !offlineReady && updateReceipt === null) {
    return null;
  }

  const updateDescription = actionPending
    ? 'Finish the current Owner action before updating this local rehearsal.'
    : fileReviewPending
      ? 'Finish the current file review before updating this local rehearsal.'
      : otherTabBlocksUpdate
        ? 'Another tab contains changed work, a file review, or an Owner action in progress. Close it before updating; tabs do not synchronize.'
        : waitingWorkerIdentity.status === 'checking'
          ? 'Checking the waiting service worker identity before offering this update.'
          : waitingWorkerIdentity.status === 'unavailable'
            ? 'The waiting service worker did not provide a valid build identity, so this update stays blocked.'
            : waitingWorkerIdentity.status === 'identified' &&
                waitingWorkerIdentity.buildIdentity === buildIdentity
              ? 'The waiting service worker reports the current build identity, so a distinct target build was not verified.'
              : hasSessionWork
                ? 'Updating reloads this browser-only rehearsal. Download anything you want to keep before continuing.'
                : 'This untouched disposable rehearsal can reload into the new build.';
  const updateLabel = actionPending
    ? 'Owner action in progress'
    : fileReviewPending
      ? 'File review in progress'
      : otherTabBlocksUpdate
        ? 'Other tab needs attention'
        : waitingWorkerIdentity.status === 'checking'
          ? 'Checking waiting build…'
          : waitingWorkerIdentity.status === 'unavailable'
            ? 'Waiting build unverified'
            : waitingWorkerIdentity.status === 'identified' &&
                waitingWorkerIdentity.buildIdentity === buildIdentity
              ? 'Build identity unchanged'
              : updatePending
                ? 'Updating…'
                : hasSessionWork
                  ? 'Review update'
                  : 'Update now';
  const receiptChangedBuild = updateReceipt?.outcome === 'changed-build';
  const receiptExpectedBuild = updateReceipt?.outcome === 'expected-build';
  const controllerMatchesTarget =
    updateReceipt !== null &&
    updateReceipt.targetBuildIdentity !== null &&
    controllerIdentity.status === 'identified' &&
    controllerIdentity.buildIdentity === updateReceipt.targetBuildIdentity;
  const controllerMismatchesTarget =
    updateReceipt !== null &&
    updateReceipt.targetBuildIdentity !== null &&
    controllerIdentity.status === 'identified' &&
    controllerIdentity.buildIdentity !== updateReceipt.targetBuildIdentity;
  const receiptTitle = receiptChangedBuild
    ? `Build ${buildIdentityLabel(updateReceipt.currentBuildIdentity)} is now open.`
    : receiptExpectedBuild && controllerMatchesTarget
      ? `Build ${buildIdentityLabel(updateReceipt.currentBuildIdentity)} and its controller agree.`
      : receiptExpectedBuild && controllerMismatchesTarget
        ? 'The controller reports a different build.'
        : receiptExpectedBuild && controllerIdentity.status === 'checking'
          ? `Build ${buildIdentityLabel(updateReceipt.currentBuildIdentity)} opened; checking its controller.`
          : updateReceipt?.outcome === 'unexpected-build'
            ? 'The expected build did not open.'
            : 'The requested update is unverified.';
  const receiptDescription =
    updateReceipt === null
      ? null
      : receiptChangedBuild
        ? `This tab changed from build ${buildIdentityLabel(updateReceipt.sourceBuildIdentity)} to ${buildIdentityLabel(updateReceipt.currentBuildIdentity)}. Its previous in-memory rehearsal is no longer available.`
        : receiptExpectedBuild
          ? controllerMatchesTarget
            ? `This tab changed from build ${buildIdentityLabel(updateReceipt.sourceBuildIdentity)} to the expected build ${buildIdentityLabel(updateReceipt.currentBuildIdentity)}. Its controlling service worker also reports that build. The previous in-memory rehearsal is no longer available.`
            : controllerMismatchesTarget &&
                controllerIdentity.status === 'identified'
              ? `This tab opened the expected application build ${buildIdentityLabel(updateReceipt.currentBuildIdentity)}, but its controller reports build ${buildIdentityLabel(controllerIdentity.buildIdentity)}. No rehearsal was recovered.`
              : controllerIdentity.status === 'checking'
                ? `This tab opened the expected application build ${buildIdentityLabel(updateReceipt.currentBuildIdentity)}; its controlling service worker identity is still being checked. No rehearsal was recovered.`
                : `This tab opened the expected application build ${buildIdentityLabel(updateReceipt.currentBuildIdentity)}, but no controlling service worker identity was available. No rehearsal was recovered.`
          : updateReceipt.outcome === 'unexpected-build'
            ? `This tab expected build ${buildIdentityLabel(updateReceipt.targetBuildIdentity ?? '')} but opened ${buildIdentityLabel(updateReceipt.currentBuildIdentity)}. No rehearsal was recovered.`
            : `This tab returned on build ${buildIdentityLabel(updateReceipt.currentBuildIdentity)}; a different application build was not observed. No rehearsal was recovered.`;

  return (
    <>
      <aside
        aria-label="Application update status"
        aria-live="polite"
        className="update-notice"
      >
        <div>
          {needRefresh || offlineReady ? (
            <>
              <strong>
                {needRefresh ? 'A new build is ready.' : 'Ready offline.'}
              </strong>
              <p>
                {needRefresh
                  ? updateDescription
                  : 'The application shell can reopen without a connection.'}
              </p>
            </>
          ) : null}
          {updateReceipt === null ? null : (
            <div
              className={
                needRefresh || offlineReady ? 'update-receipt' : undefined
              }
              role="status"
            >
              <strong>{receiptTitle}</strong>
              <p>{receiptDescription}</p>
              <p className="update-receipt-boundary">
                This receipt compares application and self-reported service
                worker identities only. It does not inspect cache entries or
                asset bytes, prove a real cross-build upgrade, or recover a bad
                service worker.
              </p>
            </div>
          )}
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
                otherTabBlocksUpdate ||
                waitingWorkerIdentity.status !== 'identified' ||
                waitingWorkerIdentity.buildIdentity === buildIdentity
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
              setUpdateReceipt(null);
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
