import {
  applyPlanCommand,
  createDraftPlan,
  type PlanState,
} from '@vidha/domain';
import { describe, expect, it } from 'vitest';

import {
  createPlanApplication,
  type AuthenticationSession,
  type InteractivePlanRequest,
  type PlanTransactionStore,
  type PrincipalRole,
  type SessionVerifier,
} from './application';

const DAY = 24 * 60 * 60 * 1_000;
const START = Date.parse('2026-01-01T12:00:00.000Z');

function opaqueKey(label: string): string {
  let hash = 2_166_136_261;
  for (const character of label) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16_777_619);
  }
  return `cmd_${(hash >>> 0).toString(16).padStart(8, '0').repeat(8)}`;
}

function draftPlan(): PlanState {
  return createDraftPlan({
    planId: 'plan_demo',
    ownerId: 'owner_demo',
    at: START,
    policy: {
      checkInIntervalMs: 30 * DAY,
      reminderLeadMs: 5 * DAY,
      gracePeriodMs: 7 * DAY,
    },
  });
}

function armedPlan(): PlanState {
  const rehearsed = applyPlanCommand(draftPlan(), {
    type: 'REHEARSE_PLAN',
    at: START,
    authenticated: true,
    expectedPolicyRevision: 1,
    idempotencyKey: opaqueKey('rehearse'),
  });
  return applyPlanCommand(rehearsed, {
    type: 'ARM_PLAN',
    at: START,
    authenticated: true,
    recentlyAuthenticated: true,
    expectedPolicyRevision: 1,
    idempotencyKey: opaqueKey('arm'),
  });
}

class TestStore implements PlanTransactionStore {
  state: PlanState;
  transactionCount = 0;
  private readonly commandFingerprints = new Map<string, string>();

  constructor(state = armedPlan()) {
    this.state = state;
  }

  async initialize(state: PlanState): Promise<void> {
    this.state = state;
  }

  async read(planId: string): Promise<PlanState | null> {
    return planId === this.state.planId ? this.state : null;
  }

  async transact(
    planId: string,
    commandKey: string,
    commandFingerprint: string,
    authorize: (state: PlanState) => void,
    decide: (state: PlanState) => PlanState,
  ) {
    this.transactionCount += 1;
    if (planId !== this.state.planId) {
      throw new Error('not found');
    }
    authorize(this.state);
    const existingFingerprint = this.commandFingerprints.get(commandKey);
    if (existingFingerprint !== undefined) {
      if (existingFingerprint !== commandFingerprint) {
        throw Object.assign(new Error('idempotency conflict'), {
          code: 'IDEMPOTENCY_CONFLICT',
        });
      }
      return { state: this.state, duplicate: true };
    }
    const next = decide(this.state);
    this.commandFingerprints.set(commandKey, commandFingerprint);
    this.state = next;
    return { state: next, duplicate: false };
  }
}

function session(role: PrincipalRole = 'owner'): AuthenticationSession {
  return {
    sessionId: `session_${role}`,
    principal: {
      principalId: role === 'owner' ? 'owner_demo' : `${role}_demo`,
      role,
    },
    authenticatedAt: START,
    expiresAt: START + DAY,
  };
}

function otherOwnerSession(): AuthenticationSession {
  return {
    ...session(),
    sessionId: 'session_other_owner',
    principal: { principalId: 'other_owner', role: 'owner' },
  };
}

class TestSessionVerifier implements SessionVerifier {
  private readonly sessions = new Map<string, AuthenticationSession>();

  constructor() {
    for (const role of [
      'owner',
      'guardian',
      'recipient',
      'operator',
    ] as const) {
      this.register(session(role));
    }
    this.register(otherOwnerSession());
  }

  register(value: AuthenticationSession): void {
    this.sessions.set(value.sessionId, structuredClone(value));
  }

  async verify(sessionId: string): Promise<AuthenticationSession | null> {
    const value = this.sessions.get(sessionId);
    return value === undefined ? null : structuredClone(value);
  }
}

function setup(now = START + 1_000, state = armedPlan()) {
  const store = new TestStore(state);
  const sessionVerifier = new TestSessionVerifier();
  const clock = { now: () => now };
  const application = createPlanApplication({
    clock,
    recentAuthenticationWindowMs: 5 * 60 * 1_000,
    sessionVerifier,
    store,
  });
  return { application, sessionVerifier, store };
}

describe('authentication command boundary', () => {
  it.each([0, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY])(
    'rejects a non-portable recent-authentication window: %s',
    (recentAuthenticationWindowMs) => {
      expect(() =>
        createPlanApplication({
          clock: { now: () => START },
          recentAuthenticationWindowMs,
          sessionVerifier: new TestSessionVerifier(),
          store: new TestStore(),
        }),
      ).toThrow(RangeError);
    },
  );

  it('treats reminder GET and replay as navigation-only without a transaction', () => {
    const { application, store } = setup();
    const challenge = {
      challengeId: 'challenge_demo',
      planId: 'plan_demo',
      expiresAt: START + DAY,
    };

    expect(application.inspectReminder(challenge, 'GET')).toEqual({
      challengeId: challenge.challengeId,
      navigationOnly: true,
      planId: challenge.planId,
      status: 'ready',
    });
    expect(application.inspectReminder(challenge, 'GET').status).toBe('ready');
    expect(application.inspectReminder(challenge, 'HEAD').status).toBe('ready');
    expect(application.inspectReminder(challenge, 'POST').status).toBe(
      'invalid_method',
    );
    expect(store.transactionCount).toBe(0);
  });

  it('rehearses a Draft and then arms it through the application seam', async () => {
    const { application } = setup(START + 1_000, draftPlan());
    const rehearsed = await application.execute(session(), {
      action: { type: 'REHEARSE_PLAN', expectedPolicyRevision: 1 },
      idempotencyKey: 'rehearse-through-application',
      method: 'POST',
      planId: 'plan_demo',
      userPresence: true,
    });
    expect(rehearsed.state.hasRehearsed).toBe(true);

    const armed = await application.execute(session(), {
      action: { type: 'ARM_PLAN', expectedPolicyRevision: 1 },
      idempotencyKey: 'arm-through-application',
      method: 'POST',
      planId: 'plan_demo',
      userPresence: true,
    });
    expect(armed.state.lifecycle).toBe('armed');
  });

  it('expires reminder navigation and rejects GET command mutation', async () => {
    const atBoundary = setup(START + DAY).application;
    expect(
      atBoundary.inspectReminder(
        {
          challengeId: 'at-expiry',
          planId: 'plan_demo',
          expiresAt: START + DAY,
        },
        'GET',
      ).status,
    ).toBe('ready');

    const { application, store } = setup(START + DAY + 1);
    expect(
      application.inspectReminder(
        {
          challengeId: 'expired',
          planId: 'plan_demo',
          expiresAt: START + DAY,
        },
        'GET',
      ).status,
    ).toBe('expired');

    await expect(
      application.execute(session(), {
        action: { type: 'OWNER_CHECK_IN' },
        idempotencyKey: 'scanner-get',
        method: 'GET',
        planId: 'plan_demo',
        userPresence: false,
      }),
    ).rejects.toMatchObject({
      code: 'METHOD_NOT_ALLOWED',
    });
    expect(store.transactionCount).toBe(0);
  });

  const ownerActions: readonly InteractivePlanRequest['action'][] = [
    { type: 'OWNER_CHECK_IN' },
    { type: 'REHEARSE_PLAN', expectedPolicyRevision: 1 },
    { type: 'ARM_PLAN', expectedPolicyRevision: 1 },
    { type: 'PAUSE_PLAN', expectedPolicyRevision: 1 },
    { type: 'RESUME_PLAN', expectedPolicyRevision: 1 },
    { type: 'DISABLE_PLAN', expectedPolicyRevision: 1 },
  ];

  it.each(
    (['guardian', 'recipient', 'operator'] as const).flatMap((role) =>
      ownerActions.map((action) => ({ action, role })),
    ),
  )('denies $role before evaluating $action.type', async ({ action, role }) => {
    const { application, store } = setup();
    await expect(
      application.execute(session(role), {
        action,
        idempotencyKey: `denied-${role}-${action.type}`,
        method: 'POST',
        planId: 'plan_demo',
        userPresence: true,
      }),
    ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });
    expect(store.state.events.at(-1)?.type).toBe('PLAN_ARMED');
  });

  it.each(ownerActions)(
    'denies a different Owner before evaluating $type',
    async (action) => {
      const { application, store } = setup();
      await expect(
        application.execute(
          {
            ...otherOwnerSession(),
          },
          {
            action,
            idempotencyKey: `denied-different-owner-${action.type}`,
            method: 'POST',
            planId: 'plan_demo',
            userPresence: true,
          },
        ),
      ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });
      expect(store.state.events.at(-1)?.type).toBe('PLAN_ARMED');
    },
  );

  it.each([
    session('guardian'),
    session('recipient'),
    session('operator'),
    {
      ...otherOwnerSession(),
    },
  ])(
    'authorizes before duplicate detection for $principal.role replay',
    async (actor) => {
      const { application, store } = setup();
      const request = {
        action: { type: 'OWNER_CHECK_IN' as const },
        idempotencyKey: 'owner-committed-key',
        method: 'POST',
        planId: 'plan_demo',
        userPresence: true,
      };
      await application.execute(session(), request);
      const eventCount = store.state.events.length;

      await expect(application.execute(actor, request)).rejects.toMatchObject({
        code: 'AUTHORIZATION_DENIED',
      });
      expect(store.state.events).toHaveLength(eventCount);
    },
  );

  it('denies an authenticated Owner from a different Plan', async () => {
    const { application, store } = setup();
    await expect(
      application.execute(
        {
          ...otherOwnerSession(),
        },
        {
          action: { type: 'OWNER_CHECK_IN' },
          idempotencyKey: 'wrong-owner',
          method: 'POST',
          planId: 'plan_demo',
          userPresence: true,
        },
      ),
    ).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });
    expect(store.state.events.at(-1)?.type).toBe('PLAN_ARMED');
  });

  it('requires an active session and explicit user presence', async () => {
    const { application } = setup(START + 2 * DAY);
    await expect(
      application.execute(session(), {
        action: { type: 'OWNER_CHECK_IN' },
        idempotencyKey: 'expired-session',
        method: 'POST',
        planId: 'plan_demo',
        userPresence: true,
      }),
    ).rejects.toMatchObject({
      code: 'AUTHENTICATION_EXPIRED',
    });

    const active = setup().application;
    await expect(
      active.execute(session(), {
        action: { type: 'OWNER_CHECK_IN' },
        idempotencyKey: 'no-user-presence',
        method: 'POST',
        planId: 'plan_demo',
        userPresence: false,
      }),
    ).rejects.toMatchObject({ code: 'USER_PRESENCE_REQUIRED' });
  });

  it('uses only the session identifier and ignores forged caller principal or time fields', async () => {
    const { application } = setup();
    const forgedReference = {
      ...session('guardian'),
      sessionId: session('owner').sessionId,
      authenticatedAt: Number.NEGATIVE_INFINITY,
      expiresAt: Number.POSITIVE_INFINITY,
    };

    await expect(
      application.execute(forgedReference, {
        action: { type: 'OWNER_CHECK_IN' },
        idempotencyKey: 'canonical-session-only',
        method: 'POST',
        planId: 'plan_demo',
        userPresence: true,
      }),
    ).resolves.toMatchObject({ state: { lifecycle: 'armed' } });
  });

  it('rejects an unknown session identifier before opening a transaction', async () => {
    const { application, store } = setup();
    await expect(
      application.execute(
        { sessionId: 'session_unknown' },
        {
          action: { type: 'OWNER_CHECK_IN' },
          idempotencyKey: 'unknown-session',
          method: 'POST',
          planId: 'plan_demo',
          userPresence: true,
        },
      ),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_EXPIRED' });
    expect(store.transactionCount).toBe(0);
  });

  it.each([
    { authenticatedAt: Number.NaN, expiresAt: START + DAY },
    { authenticatedAt: START, expiresAt: Number.POSITIVE_INFINITY },
    { authenticatedAt: START + 0.5, expiresAt: START + DAY },
    { authenticatedAt: START, expiresAt: Number.MAX_SAFE_INTEGER + 1 },
    { authenticatedAt: START + 2_000, expiresAt: START + DAY },
    { authenticatedAt: START + 2_000, expiresAt: START + 1_000 },
  ])(
    'rejects malformed session bounds %#',
    async ({ authenticatedAt, expiresAt }) => {
      const { application, sessionVerifier, store } = setup();
      const malformed = { ...session(), authenticatedAt, expiresAt };
      sessionVerifier.register(malformed);
      await expect(
        application.execute(malformed, {
          action: { type: 'OWNER_CHECK_IN' },
          idempotencyKey: 'malformed-session',
          method: 'POST',
          planId: 'plan_demo',
          userPresence: true,
        }),
      ).rejects.toMatchObject({ code: 'AUTHENTICATION_EXPIRED' });
      expect(store.transactionCount).toBe(0);
    },
  );

  it.each(['', 'x'.repeat(513)])(
    'rejects an invalid external idempotency key before persistence',
    async (idempotencyKey) => {
      const { application, store } = setup();
      await expect(
        application.execute(session(), {
          action: { type: 'OWNER_CHECK_IN' },
          idempotencyKey,
          method: 'POST',
          planId: 'plan_demo',
          userPresence: true,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_IDEMPOTENCY_KEY' });
      expect(store.transactionCount).toBe(0);
    },
  );

  it('requires recent authentication for lifecycle changes', async () => {
    const { application } = setup(START + 10 * 60 * 1_000);
    await expect(
      application.execute(session(), {
        action: { type: 'PAUSE_PLAN', expectedPolicyRevision: 1 },
        idempotencyKey: 'stale-pause',
        method: 'POST',
        planId: 'plan_demo',
        userPresence: true,
      }),
    ).rejects.toMatchObject({
      code: 'RECENT_AUTHENTICATION_REQUIRED',
    });
  });

  it('accepts a lifecycle command at the exact recent-auth boundary', async () => {
    const boundary = START + 5 * 60 * 1_000;
    const { application } = setup(boundary);
    const result = await application.execute(session(), {
      action: { type: 'PAUSE_PLAN', expectedPolicyRevision: 1 },
      idempotencyKey: 'at-recent-auth-boundary',
      method: 'POST',
      planId: 'plan_demo',
      userPresence: true,
    });
    expect(result.state.lifecycle).toBe('paused');
  });

  it('uses the injected clock and keeps duplicate commands idempotent', async () => {
    const at = armedPlan().cycle.reminderAt;
    const { application, store } = setup(at);

    const first = await application.advanceScheduled(
      'plan_demo',
      'scheduler-reminder',
    );
    const replay = await application.advanceScheduled(
      'plan_demo',
      'scheduler-reminder',
    );

    expect(first.state.cycle.stage).toBe('reminder');
    expect(first.state.lastCommandAt).toBe(at);
    expect(replay.duplicate).toBe(true);
    expect(
      store.state.events.filter((event) => event.type === 'REMINDER_ENTERED'),
    ).toHaveLength(1);
  });

  it('rejects cross-action reuse of an external idempotency key', async () => {
    const { application } = setup();
    const sharedKey = 'external-shared-key';
    await application.execute(session(), {
      action: { type: 'OWNER_CHECK_IN' },
      idempotencyKey: sharedKey,
      method: 'POST',
      planId: 'plan_demo',
      userPresence: true,
    });

    await expect(
      application.execute(session(), {
        action: { type: 'PAUSE_PLAN', expectedPolicyRevision: 1 },
        idempotencyKey: sharedKey,
        method: 'POST',
        planId: 'plan_demo',
        userPresence: true,
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('requires recent authentication before replaying a sensitive command', async () => {
    let now = START + 1_000;
    const store = new TestStore();
    const application = createPlanApplication({
      clock: { now: () => now },
      recentAuthenticationWindowMs: 5 * 60 * 1_000,
      sessionVerifier: new TestSessionVerifier(),
      store,
    });
    const request = {
      action: { type: 'PAUSE_PLAN' as const, expectedPolicyRevision: 1 },
      idempotencyKey: 'sensitive-replay',
      method: 'POST',
      planId: 'plan_demo',
      userPresence: true,
    };
    await application.execute(session(), request);
    now = START + 10 * 60 * 1_000;

    await expect(application.execute(session(), request)).rejects.toMatchObject(
      { code: 'RECENT_AUTHENTICATION_REQUIRED' },
    );
  });
});
