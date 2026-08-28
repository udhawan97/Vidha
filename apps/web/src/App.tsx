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
import { OwnerGuide } from './components/OwnerGuide';
import { Overview } from './components/Overview';
import { RehearsalPeerNotice } from './components/RehearsalPeerNotice';
import { UpdateNotice } from './components/UpdateNotice';
import { createDemoPlan, demoEnvelopes, type DemoEnvelope } from './demo';
import { useRehearsalPeers } from './useRehearsalPeers';

type View = 'guide' | 'overview' | 'workspace';

type OwnerActionName =
  | 'advance'
  | 'arm'
  | 'check-in'
  | 'disable'
  | 'pause'
  | 'rehearse'
  | 'restart'
  | 'resume';

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

function createDemoEnvelopeSession(): DemoEnvelope[] {
  return demoEnvelopes.map((envelope) => ({
    ...envelope,
    documentDraft: { ...envelope.documentDraft },
    importSource:
      envelope.importSource === null
        ? null
        : {
            ...envelope.importSource,
            conversionWarnings: [...envelope.importSource.conversionWarnings],
            originalBytes: Uint8Array.from(envelope.importSource.originalBytes),
          },
    attachments: envelope.attachments.map((attachment) => ({
      ...attachment,
      originalBytes: Uint8Array.from(attachment.originalBytes),
      warnings: [...attachment.warnings],
    })),
  }));
}

function actionFailure(label: string, error: unknown): string {
  const detail =
    error instanceof Error
      ? error.message
      : 'The local action returned an unknown error.';
  return `The ${label} was not recorded. ${detail}`;
}

export function App() {
  const [runtime, setRuntime] = useState(createDemoRuntime);
  const [view, setView] = useState<View>('overview');
  const [selectedEnvelopeId, setSelectedEnvelopeId] = useState(
    demoEnvelopes[0]?.id ?? '',
  );
  const [plan, setPlan] = useState(runtime.initialPlan);
  const [envelopes, setEnvelopes] = useState<DemoEnvelope[]>(
    createDemoEnvelopeSession,
  );
  const [hasSessionWork, setHasSessionWork] = useState(false);
  const [sessionRevision, setSessionRevision] = useState(1);
  const [pendingAction, setPendingAction] = useState<OwnerActionName | null>(
    null,
  );
  const [actionIssue, setActionIssue] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState(
    'Synthetic rehearsal loaded.',
  );
  const commandSequence = useRef(0);
  const actionInFlight = useRef<{
    readonly action: OwnerActionName;
    readonly promise: Promise<void>;
  } | null>(null);
  const rehearsalPeers = useRehearsalPeers({
    actionPending: pendingAction !== null,
    hasSessionWork,
  });
  const otherTabBlocksDestructiveAction =
    rehearsalPeers.peerActionPending || rehearsalPeers.peerHasSessionWork;

  function commandKey(label: string) {
    commandSequence.current += 1;
    return `demo-${label}-${commandSequence.current}`;
  }

  function runOwnerAction(
    action: OwnerActionName,
    failureLabel: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    if (actionInFlight.current !== null) {
      return actionInFlight.current.action === action
        ? actionInFlight.current.promise
        : Promise.reject(
            new Error(
              'Another synthetic Owner action is still being recorded.',
            ),
          );
    }
    setPendingAction(action);
    setActionIssue(null);
    const trackedPromise = Promise.resolve()
      .then(operation)
      .catch((error: unknown) => {
        const issue = actionFailure(failureLabel, error);
        setActionIssue(issue);
        throw error;
      })
      .finally(() => {
        if (actionInFlight.current?.promise === trackedPromise) {
          actionInFlight.current = null;
          setPendingAction(null);
        }
      });
    actionInFlight.current = { action, promise: trackedPromise };
    return trackedPromise;
  }

  function advanceStage() {
    const at = nextStageTime(plan);
    if (at === null) {
      return Promise.resolve();
    }
    return runOwnerAction('advance', 'synthetic timeline advance', async () => {
      await runtime.ready;
      runtime.clock.set(Math.max(at, plan.lastCommandAt));
      const result = await runtime.application.advanceScheduled(
        plan.planId,
        commandKey('advance'),
      );
      const next = result.state;
      setPlan(next);
      setHasSessionWork(true);
      setAnnouncement(
        `Rehearsal advanced to ${next.cycle.stage.replace('_', ' ')}.`,
      );
    });
  }

  function checkIn() {
    return runOwnerAction('check-in', 'synthetic Check-in', async () => {
      await executeOwnerAction(
        { type: 'OWNER_CHECK_IN' },
        commandKey('check-in'),
      );
      setAnnouncement('Synthetic authenticated Check-in recorded.');
    });
  }

  function changeLifecycle(
    lifecycle: Extract<PlanLifecycle, 'armed' | 'paused' | 'disabled'>,
  ) {
    const actionType =
      lifecycle === 'armed'
        ? 'RESUME_PLAN'
        : lifecycle === 'paused'
          ? 'PAUSE_PLAN'
          : 'DISABLE_PLAN';
    const actionName =
      lifecycle === 'armed'
        ? 'resume'
        : lifecycle === 'paused'
          ? 'pause'
          : 'disable';
    return runOwnerAction(actionName, `${lifecycle} action`, async () => {
      await executeOwnerAction(
        { type: actionType, expectedPolicyRevision: plan.policyRevision },
        commandKey(lifecycle),
      );
      setAnnouncement(`Synthetic Plan lifecycle changed to ${lifecycle}.`);
    });
  }

  function rehearsePlan(reviewIdentity: string) {
    return runOwnerAction('rehearse', 'Draft rehearsal', async () => {
      await executeOwnerAction(
        { type: 'REHEARSE_PLAN', expectedPolicyRevision: plan.policyRevision },
        `draft-rehearsal:${reviewIdentity}`,
      );
      setAnnouncement('Synthetic Draft rehearsal completed.');
    });
  }

  function armPlan() {
    return runOwnerAction('arm', 'Arm action', async () => {
      await executeOwnerAction(
        { type: 'ARM_PLAN', expectedPolicyRevision: plan.policyRevision },
        commandKey('arm'),
      );
      setAnnouncement('Synthetic Plan lifecycle changed to armed.');
    });
  }

  function restartLocalRehearsal() {
    if (otherTabBlocksDestructiveAction) {
      return Promise.reject(
        new Error(
          'Another tab contains changed rehearsal work or an unsettled Owner action. Close it before starting fresh here.',
        ),
      );
    }
    return runOwnerAction('restart', 'fresh local rehearsal', async () => {
      const freshRuntime = createDemoRuntime();
      await freshRuntime.ready;
      setRuntime(freshRuntime);
      setPlan(freshRuntime.initialPlan);
      setEnvelopes(createDemoEnvelopeSession());
      setSelectedEnvelopeId(demoEnvelopes[0]?.id ?? '');
      setView('overview');
      setSessionRevision((current) => current + 1);
      setHasSessionWork(false);
      commandSequence.current = 0;
      setAnnouncement(
        'Fresh disposable rehearsal loaded. The Disabled Plan was not resumed.',
      );
    });
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
    setHasSessionWork(true);
  }

  return (
    <div className="app-frame">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <aside aria-label="Application navigation" className="app-rail">
        <button
          aria-label="Open overview"
          className="wordmark"
          onClick={() => setView('overview')}
          type="button"
        >
          <picture>
            <source
              media="(prefers-color-scheme: dark)"
              srcSet="/vidha-mark-reversed.svg"
            />
            <img alt="" height="450" src="/vidha-mark.svg" width="600" />
          </picture>
          <span className="wordmark-name">Vidha</span>
          <span className="wordmark-subtitle">Contingency relay</span>
        </button>
        <nav aria-label="Primary navigation">
          <button
            aria-current={view === 'overview' ? 'page' : undefined}
            className={view === 'overview' ? 'nav-item is-active' : 'nav-item'}
            onClick={() => setView('overview')}
            type="button"
          >
            <span className="nav-glyph" aria-hidden="true">
              01
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
              02
            </span>
            <span>Envelopes</span>
          </button>
          <button
            aria-current={view === 'guide' ? 'page' : undefined}
            className={view === 'guide' ? 'nav-item is-active' : 'nav-item'}
            onClick={() => setView('guide')}
            type="button"
          >
            <span className="nav-glyph" aria-hidden="true">
              03
            </span>
            <span>Guide</span>
          </button>
        </nav>
        <div className="rail-footnote">
          <span className="demo-pulse" aria-hidden="true" />
          <span>Local demo</span>
        </div>
      </aside>

      <div className="app-surface">
        <header className="topbar">
          <div className="build-label-wrap">
            <span className="build-label">
              Pre-alpha prototype · synthetic data
            </span>
            <span className="topbar-motto">
              Brief the handoff. Rehearse the relay.
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

        <RehearsalPeerNotice {...rehearsalPeers} />

        <main id="main-content">
          <div hidden={view !== 'overview'}>
            <Overview
              actionIssue={actionIssue}
              actionPending={pendingAction !== null}
              envelopes={envelopes}
              key={`overview-${sessionRevision}`}
              onArm={armPlan}
              onAdvance={advanceStage}
              onCheckIn={checkIn}
              onDisable={() => changeLifecycle('disabled')}
              onPause={() => changeLifecycle('paused')}
              onOpenEnvelope={(envelopeId) => {
                setSelectedEnvelopeId(envelopeId);
                setView('workspace');
              }}
              onRehearse={rehearsePlan}
              onRestart={restartLocalRehearsal}
              onResume={() => changeLifecycle('armed')}
              otherTabBlocksSessionReset={otherTabBlocksDestructiveAction}
              plan={plan}
            />
          </div>
          <div hidden={view !== 'workspace'}>
            <DocumentWorkspace
              envelopes={envelopes}
              key={`workspace-${sessionRevision}-${plan.lifecycle === 'disabled' ? 'ended' : 'active'}`}
              onSessionWork={() => setHasSessionWork(true)}
              onSelectEnvelope={setSelectedEnvelopeId}
              selectedEnvelopeId={selectedEnvelopeId}
              sessionEnded={plan.lifecycle === 'disabled'}
              setEnvelopes={setEnvelopes}
            />
          </div>
          <div hidden={view !== 'guide'}>
            <OwnerGuide />
          </div>
        </main>
      </div>

      <p className="visually-hidden" aria-live="polite">
        {announcement}
      </p>
      <UpdateNotice
        actionPending={pendingAction !== null}
        hasSessionWork={hasSessionWork}
        otherTabBlocksUpdate={otherTabBlocksDestructiveAction}
      />
    </div>
  );
}
