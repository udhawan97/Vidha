import { applyPlanCommand, type PlanState } from '@vidha/domain';
import { useRef, useState } from 'react';

import { DocumentWorkspace } from './components/DocumentWorkspace';
import { Overview } from './components/Overview';
import { UpdateNotice } from './components/UpdateNotice';
import { createDemoPlan, demoEnvelopes } from './demo';

type View = 'overview' | 'workspace';

function nextStageTime(plan: PlanState): number | null {
  switch (plan.cycle.stage) {
    case 'on_time':
      return plan.cycle.reminderAt;
    case 'reminder':
      return plan.cycle.dueAt;
    case 'overdue':
      return plan.cycle.concernAt;
    case 'concern':
      return null;
  }
}

export function App() {
  const [view, setView] = useState<View>('overview');
  const [plan, setPlan] = useState(createDemoPlan);
  const [envelopes, setEnvelopes] = useState(() =>
    demoEnvelopes.map((envelope) => ({ ...envelope })),
  );
  const [announcement, setAnnouncement] = useState(
    'Synthetic rehearsal loaded.',
  );
  const commandSequence = useRef(0);

  function commandKey(label: string) {
    commandSequence.current += 1;
    return `demo-${label}-${commandSequence.current}`;
  }

  function advanceStage() {
    const at = nextStageTime(plan);
    if (at === null) {
      return;
    }
    const next = applyPlanCommand(plan, {
      type: 'ADVANCE_TIME',
      at: Math.max(at, plan.lastCommandAt),
      idempotencyKey: commandKey('advance'),
    });
    setPlan(next);
    setAnnouncement(
      `Rehearsal advanced to ${next.cycle.stage.replace('_', ' ')}.`,
    );
  }

  function checkIn() {
    const next = applyPlanCommand(plan, {
      type: 'OWNER_CHECK_IN',
      at: Math.max(Date.now(), plan.lastCommandAt),
      authenticated: true,
      idempotencyKey: commandKey('check-in'),
    });
    setPlan(next);
    setAnnouncement('Synthetic authenticated Check-in recorded.');
  }

  return (
    <div className="app-frame">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <aside className="app-rail">
        <button
          aria-label="Open overview"
          className="wordmark"
          onClick={() => setView('overview')}
          type="button"
        >
          <img alt="" src="/vidha-mark.svg" />
          <span>Vidha</span>
        </button>
        <nav aria-label="Primary navigation">
          <button
            aria-current={view === 'overview' ? 'page' : undefined}
            className={view === 'overview' ? 'nav-item is-active' : 'nav-item'}
            onClick={() => setView('overview')}
            type="button"
          >
            <span className="nav-glyph" aria-hidden="true">
              ◉
            </span>
            <span>Overview</span>
          </button>
          <button
            aria-current={view === 'workspace' ? 'page' : undefined}
            className={view === 'workspace' ? 'nav-item is-active' : 'nav-item'}
            onClick={() => setView('workspace')}
            type="button"
          >
            <span className="nav-glyph" aria-hidden="true">
              ≡
            </span>
            <span>Envelopes</span>
          </button>
        </nav>
        <div className="rail-footnote">
          <span className="demo-pulse" aria-hidden="true" />
          <span>Local demo</span>
        </div>
      </aside>

      <div className="app-surface">
        <header className="topbar">
          <div>
            <span className="build-label">Phase 1 · synthetic data</span>
          </div>
          <div className="owner-chip" aria-label="Synthetic Owner profile">
            <span>DO</span>
            <div>
              <strong>Demo Owner</strong>
              <small>Rehearsal only</small>
            </div>
          </div>
        </header>

        <main id="main-content">
          <div hidden={view !== 'overview'}>
            <Overview
              envelopes={envelopes}
              onAdvance={advanceStage}
              onCheckIn={checkIn}
              plan={plan}
            />
          </div>
          <div hidden={view !== 'workspace'}>
            <DocumentWorkspace
              envelopes={envelopes}
              setEnvelopes={setEnvelopes}
            />
          </div>
        </main>
      </div>

      <p className="visually-hidden" aria-live="polite">
        {announcement}
      </p>
      <UpdateNotice />
    </div>
  );
}
