import {
  createPlanApplication,
  type AuthenticationSession,
  type Clock,
  type InteractivePlanRequest,
  type PlanApplication,
} from '@vidha/application';
import type { PlanLifecycle, PlanState } from '@vidha/domain';
import { MemoryPlanStore } from '@vidha/persistence/memory';
import { useRef, useState } from 'react';

import { DocumentWorkspace } from './components/DocumentWorkspace';
import { Overview } from './components/Overview';
import { UpdateNotice } from './components/UpdateNotice';
import { createDemoPlan, demoEnvelopes } from './demo';

type View = 'overview' | 'workspace';

interface DemoClock extends Clock {
  set(at: number): void;
}

interface DemoRuntime {
  readonly application: PlanApplication;
  readonly clock: DemoClock;
  readonly initialPlan: PlanState;
  readonly ready: Promise<void>;
}

function createDemoRuntime(): DemoRuntime {
  const initialPlan = createDemoPlan();
  let currentTime = initialPlan.lastCommandAt;
  const clock: DemoClock = {
    now() {
      return currentTime;
    },
    set(at) {
      currentTime = at;
    },
  };
  const store = new MemoryPlanStore();
  return {
    application: createPlanApplication({
      clock,
      recentAuthenticationWindowMs: 5 * 60 * 1_000,
      sessionVerifier: {
        async verify(sessionId) {
          const match = /^synthetic-session-([0-9]+)$/u.exec(sessionId);
          if (match?.[1] === undefined) {
            return null;
          }
          const authenticatedAt = Number(match[1]);
          return Number.isSafeInteger(authenticatedAt)
            ? syntheticOwnerSession(authenticatedAt)
            : null;
        },
      },
      store,
    }),
    clock,
    initialPlan,
    ready: store.initialize(initialPlan),
  };
}

function syntheticOwnerSession(at: number): AuthenticationSession {
  return {
    sessionId: `synthetic-session-${at}`,
    principal: { principalId: 'synthetic-owner', role: 'owner' },
    authenticatedAt: at,
    expiresAt: at + 5 * 60 * 1_000,
  };
}

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
  const [runtime] = useState(createDemoRuntime);
  const [view, setView] = useState<View>('overview');
  const [plan, setPlan] = useState(runtime.initialPlan);
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

  async function advanceStage() {
    const at = nextStageTime(plan);
    if (at === null) {
      return;
    }
    await runtime.ready;
    runtime.clock.set(Math.max(at, plan.lastCommandAt));
    const result = await runtime.application.advanceScheduled(
      plan.planId,
      commandKey('advance'),
    );
    const next = result.state;
    setPlan(next);
    setAnnouncement(
      `Rehearsal advanced to ${next.cycle.stage.replace('_', ' ')}.`,
    );
  }

  async function checkIn() {
    await executeOwnerAction(
      { type: 'OWNER_CHECK_IN' },
      commandKey('check-in'),
    );
    setAnnouncement('Synthetic authenticated Check-in recorded.');
  }

  async function changeLifecycle(
    lifecycle: Extract<PlanLifecycle, 'armed' | 'paused' | 'disabled'>,
  ) {
    const actionType =
      lifecycle === 'armed'
        ? 'RESUME_PLAN'
        : lifecycle === 'paused'
          ? 'PAUSE_PLAN'
          : 'DISABLE_PLAN';
    await executeOwnerAction(
      { type: actionType, expectedPolicyRevision: plan.policyRevision },
      commandKey(lifecycle),
    );
    setAnnouncement(`Synthetic Plan lifecycle changed to ${lifecycle}.`);
  }

  async function rehearsePlan() {
    await executeOwnerAction(
      { type: 'REHEARSE_PLAN', expectedPolicyRevision: plan.policyRevision },
      commandKey('rehearse'),
    );
    setAnnouncement('Synthetic Draft rehearsal completed.');
  }

  async function armPlan() {
    await executeOwnerAction(
      { type: 'ARM_PLAN', expectedPolicyRevision: plan.policyRevision },
      commandKey('arm'),
    );
    setAnnouncement('Synthetic Plan lifecycle changed to armed.');
  }

  async function executeOwnerAction(
    action: InteractivePlanRequest['action'],
    idempotencyKey: string,
  ) {
    await runtime.ready;
    const at = Math.max(Date.now(), plan.lastCommandAt);
    runtime.clock.set(at);
    const result = await runtime.application.execute(
      syntheticOwnerSession(at),
      {
        action,
        idempotencyKey,
        method: 'POST',
        planId: plan.planId,
        userPresence: true,
      },
    );
    setPlan(result.state);
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
            <span className="build-label">
              Phase 2 foundations · synthetic data
            </span>
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
              onArm={armPlan}
              onAdvance={advanceStage}
              onCheckIn={checkIn}
              onDisable={() => changeLifecycle('disabled')}
              onPause={() => changeLifecycle('paused')}
              onRehearse={rehearsePlan}
              onResume={() => changeLifecycle('armed')}
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
