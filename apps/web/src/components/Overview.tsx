import type { DomainEvent, PlanState } from '@vidha/domain';
import { useState } from 'react';

import type { DemoEnvelope } from '../demo';
import { ContinuityLine } from './ContinuityLine';

interface OverviewProps {
  readonly plan: PlanState;
  readonly envelopes: readonly DemoEnvelope[];
  readonly onAdvance: () => void;
  readonly onCheckIn: () => void;
}

const eventLabels: Record<DomainEvent['type'], string> = {
  PLAN_ARMED: 'Rehearsal plan armed',
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
  onAdvance,
  onCheckIn,
}: OverviewProps) {
  const [confirming, setConfirming] = useState(false);
  const copy = stageCopy[plan.cycle.stage];
  const canAdvance = plan.cycle.stage !== 'concern';

  function confirmCheckIn() {
    onCheckIn();
    setConfirming(false);
  }

  return (
    <div className="overview-view" id="main-content">
      <section className={`status-field stage-${plan.cycle.stage}`}>
        <div className="status-heading">
          <div>
            <p className="eyebrow">{copy.eyebrow}</p>
            <h1>{copy.title}</h1>
            <p className="status-explanation">{copy.body}</p>
          </div>
          <div className="next-date" aria-label="Next Check-in due date">
            <span>Next Check-in</span>
            <strong>{formatLongDate(plan.cycle.dueAt)}</strong>
          </div>
        </div>

        <ContinuityLine cycle={plan.cycle} />

        <div className="status-actions">
          <button
            className="button button-primary"
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
            {canAdvance ? 'Advance one stage' : 'Simulation stops at Concern'}
          </button>
          <p className="action-note">
            Synthetic rehearsal · no messages are sent
          </p>
        </div>
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
                </div>
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
    </div>
  );
}
