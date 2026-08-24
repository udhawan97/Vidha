import type { DomainEvent, PlanState } from '@vidha/domain';
import { useState } from 'react';

import type { DemoEnvelope } from '../demo';
import { ContinuityLine } from './ContinuityLine';

interface OverviewProps {
  readonly plan: PlanState;
  readonly envelopes: readonly DemoEnvelope[];
  readonly onArm: () => void;
  readonly onAdvance: () => void;
  readonly onCheckIn: () => void;
  readonly onDisable: () => void;
  readonly onPause: () => void;
  readonly onOpenEnvelope: (envelopeId: string) => void;
  readonly onRehearse: () => void;
  readonly onResume: () => void;
}

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

export function Overview({
  plan,
  envelopes,
  onArm,
  onAdvance,
  onCheckIn,
  onDisable,
  onPause,
  onOpenEnvelope,
  onRehearse,
  onResume,
}: OverviewProps) {
  const [confirming, setConfirming] = useState(false);
  const [confirmingDisable, setConfirmingDisable] = useState(false);
  const isArmed = plan.lifecycle === 'armed';
  const copy = isArmed
    ? stageCopy[plan.cycle.stage]
    : lifecycleCopy[plan.lifecycle];
  const canAdvance = isArmed && plan.cycle.stage !== 'concern';

  function confirmCheckIn() {
    onCheckIn();
    setConfirming(false);
  }

  function confirmDisable() {
    onDisable();
    setConfirmingDisable(false);
  }

  const lifecycleControls = (
    <div className="lifecycle-controls" aria-label="Plan lifecycle controls">
      <span>Plan controls</span>
      {plan.lifecycle === 'draft' ? (
        plan.hasRehearsed ? (
          <button
            className="button button-primary"
            onClick={onArm}
            type="button"
          >
            Arm rehearsal
          </button>
        ) : (
          <button
            className="button button-primary"
            onClick={onRehearse}
            type="button"
          >
            Rehearse Draft
          </button>
        )
      ) : plan.lifecycle === 'armed' ? (
        <button className="button button-quiet" onClick={onPause} type="button">
          Pause rehearsal
        </button>
      ) : plan.lifecycle === 'paused' ? (
        <button
          className="button button-quiet"
          onClick={onResume}
          type="button"
        >
          Resume with fresh interval
        </button>
      ) : null}
      {plan.lifecycle === 'disabled' ? null : (
        <button
          className="button button-text-danger"
          onClick={() => setConfirmingDisable(true)}
          type="button"
        >
          Disable rehearsal
        </button>
      )}
      {plan.lifecycle === 'disabled' ? (
        <p>Disabled is terminal in this synthetic foundation.</p>
      ) : null}
    </div>
  );

  return (
    <div className="overview-view">
      <section className={`status-field stage-${plan.cycle.stage}`}>
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
            disabled={!isArmed}
            onClick={() => setConfirming(true)}
            type="button"
          >
            Rehearse Check-in
          </button>
          <button
            className="button button-quiet"
            disabled={!canAdvance}
            onClick={onAdvance}
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
            <span className="readiness-mark">Rehearsal ready</span>
          </div>
          <div className="envelope-rows">
            {envelopes.map((envelope, index) => (
              <article className="envelope-row" key={envelope.id}>
                <span className="envelope-index" aria-hidden="true">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <div>
                  <h3>{envelope.title}</h3>
                  <p>For {envelope.recipient}</p>
                </div>
                <div className="envelope-meta">
                  <span>{envelope.protectionMode}</span>
                  <span>{envelope.releasePolicy}</span>
                  <span>{`${envelope.attachments.length} Attachment${envelope.attachments.length === 1 ? '' : 's'}`}</span>
                </div>
                <button
                  aria-label={`Review ${envelope.title}`}
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
          <span className="session-label">Clears on refresh</span>
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

      {confirming ? (
        <div className="dialog-backdrop" role="presentation">
          <div
            aria-describedby="check-in-description"
            aria-labelledby="check-in-title"
            aria-modal="true"
            className="confirmation-dialog"
            role="dialog"
          >
            <p className="eyebrow">Explicit Owner action</p>
            <h2 id="check-in-title">Confirm this rehearsal Check-in?</h2>
            <p id="check-in-description">
              The real product will require strong authentication. This local
              demo records a synthetic authenticated action.
            </p>
            <div className="dialog-actions">
              <button
                className="button button-quiet"
                onClick={() => setConfirming(false)}
                type="button"
              >
                Go back
              </button>
              <button
                autoFocus
                className="button button-primary"
                onClick={confirmCheckIn}
                type="button"
              >
                Confirm Check-in
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {confirmingDisable ? (
        <div className="dialog-backdrop" role="presentation">
          <div
            aria-describedby="disable-description"
            aria-labelledby="disable-title"
            aria-modal="true"
            className="confirmation-dialog"
            role="dialog"
          >
            <p className="eyebrow">Terminal synthetic state</p>
            <h2 id="disable-title">Disable this rehearsal Plan?</h2>
            <p id="disable-description">
              Disabled is terminal in this foundation model. Refresh the page to
              load a new disposable rehearsal.
            </p>
            <div className="dialog-actions">
              <button
                className="button button-quiet"
                onClick={() => setConfirmingDisable(false)}
                type="button"
              >
                Keep rehearsal
              </button>
              <button
                autoFocus
                className="button button-text-danger"
                onClick={confirmDisable}
                type="button"
              >
                Confirm disable
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
