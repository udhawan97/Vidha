import {
  DraftRehearsalError,
  acceptDraftRehearsalReview,
  createDraftRehearsalReview,
  type DraftRehearsalInput,
  type DraftRehearsalReview,
} from '@vidha/application';
import type { DomainEvent, PlanState } from '@vidha/domain';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { demoContacts, type DemoEnvelope } from '../demo';
import type { SessionLossReview as SessionLossReviewModel } from '../sessionLossReview';
import { ContinuityLine } from './ContinuityLine';
import { DraftRehearsalDialog } from './DraftRehearsalDialog';
import { OwnerActionDialog } from './OwnerActionDialog';
import { SessionLossReview } from './SessionLossReview';

interface OverviewProps {
  readonly actionIssue: string | null;
  readonly actionPending: boolean;
  readonly fileReviewBusy: boolean;
  readonly fileReviewEnvelopeIds: readonly string[];
  readonly plan: PlanState;
  readonly envelopes: readonly DemoEnvelope[];
  readonly onArm: () => Promise<void>;
  readonly onAdvance: () => Promise<void>;
  readonly onCheckIn: () => Promise<void>;
  readonly onDisable: () => Promise<void>;
  readonly onPause: () => Promise<void>;
  readonly onOpenEnvelope: (envelopeId: string) => void;
  readonly onRehearse: (reviewIdentity: string) => Promise<void>;
  readonly onRestart: () => Promise<void>;
  readonly onResume: () => Promise<void>;
  readonly otherTabBlocksSessionReset: boolean;
  readonly sessionLossReview: SessionLossReviewModel;
}

type OwnerConfirmation = 'check-in' | 'disable' | 'restart';

const confirmationCopy = {
  'check-in': {
    actionLabel: 'Confirm Check-in',
    busyLabel: 'Recording Check-in…',
    cancelLabel: 'Go back',
    description:
      'The real product will require strong authentication. This local demo records a synthetic authenticated action.',
    eyebrow: 'Explicit Owner action',
    failure: 'The synthetic Check-in could not be recorded.',
    title: 'Confirm this rehearsal Check-in?',
    tone: 'primary',
  },
  disable: {
    actionLabel: 'Confirm disable',
    busyLabel: 'Disabling rehearsal…',
    cancelLabel: 'Keep rehearsal',
    description:
      'Disabled is terminal for this Plan. You can later start a separate disposable rehearsal, but this Plan will not resume.',
    eyebrow: 'Terminal synthetic state',
    failure: 'The rehearsal Plan could not be disabled.',
    title: 'Disable this rehearsal Plan?',
    tone: 'danger',
  },
  restart: {
    actionLabel: 'Start fresh rehearsal',
    busyLabel: 'Starting fresh rehearsal…',
    cancelLabel: 'Keep ended rehearsal',
    description:
      'This clears every session edit, Attachment, Document Version, and local event, then loads a separate synthetic Draft. The Disabled Plan remains terminal.',
    eyebrow: 'New disposable session',
    failure: 'A fresh local rehearsal could not be started.',
    title: 'Start a fresh local rehearsal?',
    tone: 'danger',
  },
} as const;

const eventLabels: Record<DomainEvent['type'], string> = {
  PLAN_DRAFTED: 'Synthetic Plan drafted',
  PLAN_REHEARSED: 'Synthetic Plan rehearsed',
  PLAN_ARMED: 'Rehearsal plan armed',
  PLAN_PAUSED: 'Rehearsal plan paused',
  PLAN_RESUMED: 'Rehearsal plan resumed',
  PLAN_DISABLED: 'Rehearsal plan disabled',
  REMINDER_ENTERED: 'Reminder stage entered',
  OVERDUE_ENTERED: 'Check-in became overdue',
  CONCERN_ENTERED: 'Concern began — no release authorized',
  CONCERN_CANCELLED: 'Concern cancelled by Owner',
  OWNER_CHECKED_IN: 'Authenticated Check-in recorded',
};

const stageCopy = {
  on_time: {
    eyebrow: 'Plan is on time',
    title: 'Nothing needs your attention.',
    body: 'Your rehearsal stays quiet until the next Check-in approaches.',
  },
  reminder: {
    eyebrow: 'Check-in reminder',
    title: 'A quick confirmation keeps the plan quiet.',
    body: 'Opening a reminder never counts. Only the action below changes state.',
  },
  overdue: {
    eyebrow: 'Check-in overdue',
    title: 'You still have time to reset the schedule.',
    body: 'No Guardian has been contacted and no material can be released.',
  },
  concern: {
    eyebrow: 'Concern is active',
    title: 'The plan is waiting for you.',
    body: 'This build stops here. Guardian decisions and Release are not implemented.',
  },
} as const;

const lifecycleCopy = {
  draft: {
    eyebrow: 'Plan is a Draft',
    title: 'Rehearse before the timeline begins.',
    body: 'No Check-in timeline or Concern transition is active while this synthetic Plan is a Draft.',
  },
  paused: {
    eyebrow: 'Plan is paused',
    title: 'The timeline is safely suspended.',
    body: 'Time cannot advance this synthetic Plan until the Owner resumes with a fresh full interval.',
  },
  disabled: {
    eyebrow: 'Plan is disabled',
    title: 'This rehearsal has ended.',
    body: 'Disabled is terminal. No Check-in timeline, Concern transition, or Release path is active.',
  },
} as const;

function formatLongDate(timestamp: number): string {
  return new Intl.DateTimeFormat('en', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(timestamp);
}

function formatEventTime(timestamp: number): string {
  return new Intl.DateTimeFormat('en', {
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
  }).format(timestamp);
}

function rehearsalInput(
  plan: PlanState,
  envelopes: readonly DemoEnvelope[],
): DraftRehearsalInput {
  return {
    contacts: demoContacts,
    envelopes: envelopes.map((envelope) => ({
      attachmentSourceIds: envelope.attachments.map(
        (attachment) => attachment.sourceId,
      ),
      document: { ...envelope.documentDraft },
      envelopeId: envelope.id,
      protectionMode: envelope.protectionMode,
      releasePolicy: envelope.releasePolicy,
    })),
    plan,
  };
}

export function Overview({
  actionIssue,
  actionPending,
  fileReviewBusy,
  fileReviewEnvelopeIds,
  plan,
  envelopes,
  onArm,
  onAdvance,
  onCheckIn,
  onDisable,
  onPause,
  onOpenEnvelope,
  onRehearse,
  onRestart,
  onResume,
  otherTabBlocksSessionReset,
  sessionLossReview,
}: OverviewProps) {
  const [confirmation, setConfirmation] = useState<OwnerConfirmation | null>(
    null,
  );
  const [confirmationIssue, setConfirmationIssue] = useState<string | null>(
    null,
  );
  const [acceptedRehearsalIdentity, setAcceptedRehearsalIdentity] = useState<
    string | null
  >(null);
  const [currentRehearsal, setCurrentRehearsal] =
    useState<DraftRehearsalReview | null>(null);
  const [pendingRehearsal, setPendingRehearsal] =
    useState<DraftRehearsalReview | null>(null);
  const [completingRehearsal, setCompletingRehearsal] = useState(false);
  const [rehearsalIssue, setRehearsalIssue] = useState<string | null>(null);
  const rehearsalTriggerRef = useRef<HTMLButtonElement>(null);
  const checkInTriggerRef = useRef<HTMLButtonElement>(null);
  const disableTriggerRef = useRef<HTMLButtonElement>(null);
  const restartTriggerRef = useRef<HTMLButtonElement>(null);
  const suppressConfirmationReturnFocusRef = useRef(false);
  const shouldReturnConfirmationFocus = useCallback(
    () => !suppressConfirmationReturnFocusRef.current,
    [],
  );
  const rehearsalCompletionRef = useRef(false);
  const currentRehearsalInput = useMemo(
    () => rehearsalInput(plan, envelopes),
    [envelopes, plan],
  );
  const isArmed = plan.lifecycle === 'armed';
  const copy = isArmed
    ? stageCopy[plan.cycle.stage]
    : lifecycleCopy[plan.lifecycle];
  const canAdvance = isArmed && plan.cycle.stage !== 'concern';
  const rehearsalIsCurrent =
    plan.hasRehearsed &&
    acceptedRehearsalIdentity !== null &&
    currentRehearsal?.reviewIdentity === acceptedRehearsalIdentity;
  const fileReviewBlocksDraft = fileReviewEnvelopeIds.length > 0;

  useEffect(() => {
    if (plan.lifecycle !== 'draft') {
      return;
    }
    let ignore = false;
    void createDraftRehearsalReview(currentRehearsalInput, Date.now())
      .then((review) => {
        if (!ignore) {
          setCurrentRehearsal(review);
          setRehearsalIssue(null);
        }
      })
      .catch((error: unknown) => {
        if (!ignore) {
          setCurrentRehearsal(null);
          setRehearsalIssue(
            error instanceof Error
              ? error.message
              : 'The local rehearsal review could not be prepared.',
          );
        }
      });
    return () => {
      ignore = true;
    };
  }, [currentRehearsalInput, plan.lifecycle]);

  function openConfirmation(next: OwnerConfirmation) {
    suppressConfirmationReturnFocusRef.current = false;
    setConfirmationIssue(null);
    setConfirmation(next);
  }

  async function confirmOwnerAction() {
    if (confirmation === null) return;
    setConfirmationIssue(null);
    const copy = confirmationCopy[confirmation];
    try {
      if (confirmation === 'check-in') await onCheckIn();
      else if (confirmation === 'disable') await onDisable();
      else await onRestart();
      setConfirmation(null);
    } catch {
      setConfirmationIssue(copy.failure);
    }
  }

  function runHandled(action: () => Promise<void>) {
    void action().catch(() => undefined);
  }

  async function reviewDraftRehearsal() {
    if (fileReviewBlocksDraft) {
      setRehearsalIssue(
        'Finish or discard every file review before reviewing this Draft.',
      );
      return;
    }
    setRehearsalIssue(null);
    try {
      const review = await createDraftRehearsalReview(
        currentRehearsalInput,
        Date.now(),
      );
      setCurrentRehearsal(review);
      setPendingRehearsal(review);
    } catch (error) {
      setRehearsalIssue(
        error instanceof Error
          ? error.message
          : 'The local rehearsal review could not be prepared.',
      );
    }
  }

  async function completeDraftRehearsal() {
    if (
      pendingRehearsal === null ||
      rehearsalCompletionRef.current ||
      fileReviewBlocksDraft
    ) {
      if (fileReviewBlocksDraft) {
        setPendingRehearsal(null);
        setRehearsalIssue(
          'A file review is unsettled. Resolve it before running the Draft rehearsal.',
        );
      }
      return;
    }
    rehearsalCompletionRef.current = true;
    setCompletingRehearsal(true);
    const reviewed = pendingRehearsal;
    try {
      const acceptance = await acceptDraftRehearsalReview(
        reviewed,
        rehearsalInput(plan, envelopes),
      );
      await onRehearse(acceptance.reviewIdentity);
      setAcceptedRehearsalIdentity(acceptance.reviewIdentity);
      setPendingRehearsal(null);
      setRehearsalIssue(null);
    } catch (error) {
      setPendingRehearsal(null);
      setRehearsalIssue(
        error instanceof DraftRehearsalError || error instanceof Error
          ? error.message
          : 'The Plan changed. Review the local rehearsal again.',
      );
    } finally {
      rehearsalCompletionRef.current = false;
      setCompletingRehearsal(false);
    }
  }

  async function armReviewedDraft() {
    if (fileReviewBlocksDraft) {
      setRehearsalIssue(
        'A file review is unsettled. Resolve it before arming this Draft.',
      );
      return;
    }
    try {
      const latest = await createDraftRehearsalReview(
        rehearsalInput(plan, envelopes),
        Date.now(),
      );
      if (
        acceptedRehearsalIdentity === null ||
        latest.reviewIdentity !== acceptedRehearsalIdentity
      ) {
        setCurrentRehearsal(latest);
        setRehearsalIssue(
          'The Plan or an Envelope changed after rehearsal. Review the local rehearsal again before arming.',
        );
        return;
      }
      await onArm();
    } catch (error) {
      setRehearsalIssue(
        error instanceof Error
          ? error.message
          : 'The reviewed Draft could not be armed.',
      );
    }
  }

  const lifecycleControls = (
    <div className="lifecycle-controls" aria-label="Plan lifecycle controls">
      <span>Plan controls</span>
      {plan.lifecycle === 'draft' ? (
        rehearsalIsCurrent ? (
          <button
            className="button button-primary"
            disabled={actionPending || fileReviewBlocksDraft}
            onClick={() => void armReviewedDraft()}
            ref={rehearsalTriggerRef}
            type="button"
          >
            Arm rehearsal
          </button>
        ) : (
          <button
            className="button button-primary"
            disabled={actionPending || fileReviewBlocksDraft}
            onClick={() => void reviewDraftRehearsal()}
            ref={rehearsalTriggerRef}
            type="button"
          >
            {plan.hasRehearsed ? 'Review changes' : 'Review rehearsal'}
          </button>
        )
      ) : plan.lifecycle === 'armed' ? (
        <button
          className="button button-quiet"
          disabled={actionPending}
          onClick={() => runHandled(onPause)}
          type="button"
        >
          Pause rehearsal
        </button>
      ) : plan.lifecycle === 'paused' ? (
        <button
          className="button button-quiet"
          disabled={actionPending}
          onClick={() => runHandled(onResume)}
          type="button"
        >
          Resume with fresh interval
        </button>
      ) : null}
      {plan.lifecycle === 'disabled' ? null : (
        <button
          className="button button-text-danger"
          disabled={actionPending}
          onClick={() => openConfirmation('disable')}
          ref={disableTriggerRef}
          type="button"
        >
          Disable rehearsal
        </button>
      )}
      {plan.lifecycle === 'disabled' ? (
        <>
          <p>
            Disabled is terminal. A fresh rehearsal creates a separate local
            Draft.
          </p>
          {otherTabBlocksSessionReset ? (
            <p className="owner-action-inline-issue" role="status">
              Another tab has changed work or an Owner action in progress. Close
              it before starting fresh here.
            </p>
          ) : null}
          <button
            className="button button-primary"
            disabled={actionPending || otherTabBlocksSessionReset}
            onClick={() => openConfirmation('restart')}
            ref={restartTriggerRef}
            type="button"
          >
            Start fresh local rehearsal
          </button>
        </>
      ) : null}
      {plan.lifecycle === 'draft' && rehearsalIssue !== null ? (
        <p className="rehearsal-inline-issue" role="alert">
          {rehearsalIssue}
        </p>
      ) : null}
      {plan.lifecycle === 'draft' && fileReviewBlocksDraft ? (
        <div
          aria-label="Draft file review hold"
          className="file-review-hold"
          role="status"
        >
          <p>
            {fileReviewBusy
              ? 'A selected file is still being prepared for review.'
              : `${fileReviewEnvelopeIds.length} file review${fileReviewEnvelopeIds.length === 1 ? ' is' : 's are'} waiting for a decision.`}{' '}
            Draft rehearsal and Arm stay unavailable until every review is kept
            or discarded.
          </p>
          <button
            className="button button-quiet"
            onClick={() => {
              const envelopeId = fileReviewEnvelopeIds[0];
              if (envelopeId !== undefined) onOpenEnvelope(envelopeId);
            }}
            type="button"
          >
            Open pending file review
          </button>
        </div>
      ) : null}
      {confirmation === null && actionIssue !== null ? (
        <p className="owner-action-inline-issue" role="alert">
          {actionIssue}
        </p>
      ) : null}
    </div>
  );
  const activeConfirmation =
    confirmation === null ? null : confirmationCopy[confirmation];
  const confirmationReturnFocusRef =
    confirmation === 'check-in'
      ? checkInTriggerRef
      : confirmation === 'disable'
        ? disableTriggerRef
        : restartTriggerRef;

  return (
    <div className="overview-view">
      <span className="folio-marker" aria-hidden="true" lang="ja">
        一・現状
      </span>
      <section className={`status-field stage-${plan.cycle.stage}`}>
        <span className="status-watermark" aria-hidden="true">
          Contingency relay
        </span>
        <div className="status-heading">
          <div>
            <p className="eyebrow">{copy.eyebrow}</p>
            <h1>{copy.title}</h1>
            <p className="status-explanation">{copy.body}</p>
          </div>
          {isArmed ? (
            <div className="next-date" aria-label="Next Check-in due date">
              <span>Next Check-in</span>
              <strong>{formatLongDate(plan.cycle.dueAt)}</strong>
            </div>
          ) : (
            <div className="next-date" aria-label="Timeline inactive">
              <span>Timeline</span>
              <strong>Inactive</strong>
            </div>
          )}
        </div>

        {isArmed ? (
          <ContinuityLine cycle={plan.cycle} />
        ) : (
          <div className="inactive-timeline-note">
            <p>No active Check-in due date is being counted down.</p>
            <p>Release logic is not active in this build.</p>
          </div>
        )}

        {isArmed ? null : lifecycleControls}
        <div className="status-actions">
          <span className={`lifecycle-badge lifecycle-${plan.lifecycle}`}>
            Lifecycle: {plan.lifecycle}
          </span>
          <button
            className="button button-primary"
            disabled={!isArmed || actionPending}
            onClick={() => openConfirmation('check-in')}
            ref={checkInTriggerRef}
            type="button"
          >
            Rehearse Check-in
          </button>
          <button
            className="button button-quiet"
            disabled={!canAdvance || actionPending}
            onClick={() => runHandled(onAdvance)}
            type="button"
          >
            {canAdvance
              ? 'Advance one stage'
              : isArmed
                ? 'Simulation stops at Concern'
                : 'Timeline is not armed'}
          </button>
          <p className="action-note">
            Synthetic rehearsal · no messages are sent
          </p>
        </div>
        {isArmed ? lifecycleControls : null}
      </section>

      <div className="overview-columns">
        <section className="prepared-section" aria-labelledby="prepared-title">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Prepared handoffs</p>
              <h2 id="prepared-title">Two demo Envelopes</h2>
            </div>
            <span
              className={`readiness-mark ${
                rehearsalIsCurrent
                  ? 'is-reviewed'
                  : currentRehearsal?.canComplete === false
                    ? 'needs-attention'
                    : ''
              }`}
            >
              {rehearsalIsCurrent
                ? 'Locally rehearsed'
                : currentRehearsal?.canComplete === false
                  ? 'Needs attention'
                  : 'Review required'}
            </span>
          </div>
          <div className="envelope-rows">
            {envelopes.map((envelope, index) => (
              <article className="envelope-row" key={envelope.id}>
                <span className="envelope-index" aria-hidden="true">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <div>
                  <h3>{envelope.documentDraft.title}</h3>
                  <p>For {envelope.documentDraft.recipientLabel}</p>
                </div>
                <div className="envelope-meta">
                  <span>{envelope.protectionMode}</span>
                  <span>{envelope.releasePolicy}</span>
                  <span>{`${envelope.attachments.length} Attachment${envelope.attachments.length === 1 ? '' : 's'}`}</span>
                </div>
                <button
                  aria-label={`Review ${envelope.documentDraft.title}`}
                  className="envelope-review"
                  onClick={() => onOpenEnvelope(envelope.id)}
                  type="button"
                >
                  <span>Review</span>
                  <span aria-hidden="true">→</span>
                </button>
              </article>
            ))}
          </div>
        </section>

        <aside className="readiness-section" aria-labelledby="readiness-title">
          <p className="eyebrow">People readiness</p>
          <h2 id="readiness-title">A small, known circle</h2>
          <ul className="people-list">
            <li>
              <span className="person-monogram">MC</span>
              <span>
                <strong>Mira Chen</strong>
                <small>Recipient · synthetic</small>
              </span>
              <span className="verified-word">Verified</span>
            </li>
            <li>
              <span className="person-monogram">NW</span>
              <span>
                <strong>Noah Williams</strong>
                <small>Guardian · synthetic</small>
              </span>
              <span className="verified-word">Verified</span>
            </li>
            <li>
              <span className="person-monogram">SR</span>
              <span>
                <strong>Sam Rivera</strong>
                <small>Recipient · synthetic</small>
              </span>
              <span className="verified-word">Verified</span>
            </li>
          </ul>
          <div className="safety-note">
            <span aria-hidden="true">↳</span>
            <p>
              Guardians never see Envelope content through their verification
              role.
            </p>
          </div>
        </aside>
      </div>

      <section className="activity-section" aria-labelledby="activity-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Local event record</p>
            <h2 id="activity-title">What this rehearsal changed</h2>
          </div>
          <span className="session-label">
            Clears on refresh or fresh rehearsal
          </span>
        </div>
        <ol className="activity-list">
          {[...plan.events]
            .reverse()
            .slice(0, 5)
            .map((event) => (
              <li key={event.id}>
                <span className="activity-dot" aria-hidden="true" />
                <div>
                  <strong>{eventLabels[event.type]}</strong>
                  <time dateTime={new Date(event.at).toISOString()}>
                    {formatEventTime(event.at)}
                  </time>
                </div>
              </li>
            ))}
        </ol>
      </section>

      {pendingRehearsal === null ? null : (
        <DraftRehearsalDialog
          completing={completingRehearsal}
          onCancel={() => {
            if (!rehearsalCompletionRef.current) setPendingRehearsal(null);
          }}
          onComplete={completeDraftRehearsal}
          returnFocusRef={rehearsalTriggerRef}
          review={pendingRehearsal}
        />
      )}

      {activeConfirmation === null ? null : (
        <OwnerActionDialog
          actionLabel={activeConfirmation.actionLabel}
          busy={actionPending}
          busyLabel={activeConfirmation.busyLabel}
          cancelLabel={activeConfirmation.cancelLabel}
          description={activeConfirmation.description}
          eyebrow={activeConfirmation.eyebrow}
          issue={confirmationIssue}
          onCancel={() => {
            if (!actionPending) setConfirmation(null);
          }}
          onConfirm={() => void confirmOwnerAction()}
          returnFocusRef={confirmationReturnFocusRef}
          shouldReturnFocus={shouldReturnConfirmationFocus}
          title={activeConfirmation.title}
          tone={activeConfirmation.tone}
        >
          {confirmation === 'restart' ? (
            <SessionLossReview
              onReviewEnvelope={(envelopeId) => {
                suppressConfirmationReturnFocusRef.current = true;
                setConfirmation(null);
                onOpenEnvelope(envelopeId);
              }}
              review={sessionLossReview}
            />
          ) : null}
        </OwnerActionDialog>
      )}
    </div>
  );
}
