import { describe, expect, it } from 'vitest';

import {
  createOwnerIdentityCoordinator,
  type CredentialProofVerifier,
  type IdentityCommand,
} from './identity';

const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;
const START = Date.parse('2026-01-01T12:00:00.000Z');

function hex(label: string): string {
  let hash = 2_166_136_261;
  for (const character of label) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0').repeat(8);
}

const OWNER_ID = `owner_${hex('owner')}`;
const OTHER_OWNER_ID = `owner_${hex('other-owner')}`;
const FIRST_CREDENTIAL = `credential_${hex('first')}`;
const SECOND_CREDENTIAL = `credential_${hex('second')}`;
const RECOVERED_CREDENTIAL = `credential_${hex('recovered')}`;
const OTHER_CREDENTIAL = `credential_${hex('other-credential')}`;
const CHANNEL = `channel_${hex('old-channel')}`;
const NEXT_CHANNEL = `channel_${hex('next-channel')}`;
const OTHER_CHANNEL = `channel_${hex('other-channel')}`;
const SESSION = `session_${hex('session')}`;
const SECOND_SESSION = `session_${hex('second-session')}`;

type CommandInput<T> = T extends IdentityCommand
  ? Omit<T, 'expectedSecurityRevision' | 'idempotencyKey'>
  : never;
type UncontrolledIdentityCommand = CommandInput<IdentityCommand>;

const verifier: CredentialProofVerifier = {
  async verifyAuthentication({ assertion }) {
    return {
      verified: assertion === 'verified-assertion',
      userPresent: assertion === 'verified-assertion',
      userVerified: assertion === 'verified-assertion',
    };
  },
  async verifyRecovery({ factor, proof }) {
    return proof === `verified-${factor}`;
  },
  async verifyRegistration({ proof }) {
    return proof === 'verified-registration';
  },
  async verifyChannel({ proof }) {
    return proof === 'verified-channel';
  },
};

function setup(sessionGenerator?: () => string) {
  let now = START;
  let commandOrdinal = 0;
  const queuedSessionIds: string[] = [];
  const rawCoordinator = createOwnerIdentityCoordinator({
    clock: { now: () => now },
    policy: {
      channelChangeCoolingOffMs: DAY,
      recentAuthenticationWindowMs: 5 * 60 * 1_000,
      recoveryCoolingOffMs: 2 * DAY,
      sessionLifetimeMs: HOUR,
    },
    sessionIdGenerator:
      sessionGenerator ??
      (() => {
        const sessionId = queuedSessionIds.shift();
        if (sessionId === undefined) {
          throw new Error('A deterministic session fixture was not queued.');
        }
        return sessionId;
      }),
    verifier,
  });
  const coordinator = {
    ...rawCoordinator,
    async execute(command: UncontrolledIdentityCommand) {
      const state = await rawCoordinator.read(command.ownerId);
      if (state === null) {
        throw new Error('Expected initialized Owner Identity fixture.');
      }
      commandOrdinal += 1;
      return await rawCoordinator.execute({
        ...command,
        expectedSecurityRevision: state.securityRevision,
        idempotencyKey: `identity-test-${commandOrdinal}`,
      } as IdentityCommand);
    },
  };
  return {
    coordinator,
    rawCoordinator,
    now: () => now,
    queueSessionId(sessionId: string) {
      queuedSessionIds.push(sessionId);
    },
    setNow(value: number) {
      now = value;
    },
  };
}

async function initialized() {
  const runtime = setup();
  await runtime.coordinator.initialize({
    credentialId: FIRST_CREDENTIAL,
    ownerId: OWNER_ID,
    verifiedChannelRef: CHANNEL,
  });
  return runtime;
}

async function authenticate(
  runtime: Awaited<ReturnType<typeof initialized>>,
  sessionId = SESSION,
  credentialId = FIRST_CREDENTIAL,
) {
  runtime.queueSessionId(sessionId);
  return await runtime.coordinator.authenticate({
    assertion: 'verified-assertion',
    credentialId,
    ownerId: OWNER_ID,
  });
}

describe('Owner Identity coordinator', () => {
  it('issues a canonical Owner session while retaining only its digest', async () => {
    const runtime = await initialized();
    const session = await authenticate(runtime);
    const state = await runtime.coordinator.read(OWNER_ID);

    expect(session).toEqual({
      sessionId: SESSION,
      principal: { principalId: OWNER_ID, role: 'owner' },
      authenticatedAt: START,
      expiresAt: START + HOUR,
    });
    expect(JSON.stringify(state)).not.toContain(SESSION);
    await expect(
      runtime.coordinator.verify(SESSION, START + HOUR),
    ).resolves.toEqual(session);
    await expect(
      runtime.coordinator.verify(SESSION, START + HOUR + 1),
    ).resolves.toBeNull();
  });

  it('fails closed when the server session generator collides across Owners', async () => {
    const runtime = setup(() => SESSION);
    await runtime.rawCoordinator.initialize({
      credentialId: FIRST_CREDENTIAL,
      ownerId: OWNER_ID,
      verifiedChannelRef: CHANNEL,
    });
    await runtime.rawCoordinator.initialize({
      credentialId: OTHER_CREDENTIAL,
      ownerId: OTHER_OWNER_ID,
      verifiedChannelRef: OTHER_CHANNEL,
    });
    await runtime.rawCoordinator.authenticate({
      assertion: 'verified-assertion',
      credentialId: FIRST_CREDENTIAL,
      ownerId: OWNER_ID,
    });

    await expect(
      runtime.rawCoordinator.authenticate({
        assertion: 'verified-assertion',
        credentialId: OTHER_CREDENTIAL,
        ownerId: OTHER_OWNER_ID,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_COMMAND' });
    await expect(
      runtime.rawCoordinator.verify(SESSION, START),
    ).resolves.toMatchObject({
      principal: { principalId: OWNER_ID, role: 'owner' },
    });
  });

  it('rejects assertions without verified user presence', async () => {
    const runtime = await initialized();
    await expect(
      runtime.coordinator.authenticate({
        assertion: 'unverified',
        credentialId: FIRST_CREDENTIAL,
        ownerId: OWNER_ID,
      }),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_DENIED' });
  });

  it('adds a second credential only after recent authentication and proof', async () => {
    const runtime = await initialized();
    await authenticate(runtime);
    const added = await runtime.coordinator.execute({
      type: 'ADD_CREDENTIAL',
      actorSessionId: SESSION,
      newCredentialId: SECOND_CREDENTIAL,
      ownerId: OWNER_ID,
      registrationProof: 'verified-registration',
    });
    expect(
      added.state.credentials.filter((item) => item.status === 'active'),
    ).toHaveLength(2);
    expect(added.noticeIntents).toEqual([
      { channelRef: CHANNEL, template: 'credential_added' },
    ]);

    runtime.setNow(START + 6 * 60 * 1_000);
    await expect(
      runtime.coordinator.execute({
        type: 'ADD_CREDENTIAL',
        actorSessionId: SESSION,
        newCredentialId: RECOVERED_CREDENTIAL,
        ownerId: OWNER_ID,
        registrationProof: 'verified-registration',
      }),
    ).rejects.toMatchObject({ code: 'RECENT_AUTHENTICATION_REQUIRED' });
  });

  it('revokes one session without exposing its raw token in state', async () => {
    const runtime = await initialized();
    await authenticate(runtime);
    await authenticate(runtime, SECOND_SESSION);
    await runtime.coordinator.execute({
      type: 'REVOKE_SESSION',
      actorSessionId: SESSION,
      ownerId: OWNER_ID,
      targetSessionId: SECOND_SESSION,
    });

    await expect(
      runtime.coordinator.verify(SECOND_SESSION, runtime.now()),
    ).resolves.toBeNull();
    await expect(
      runtime.coordinator.verify(SESSION, runtime.now()),
    ).resolves.not.toBeNull();
    expect(
      JSON.stringify(await runtime.coordinator.read(OWNER_ID)),
    ).not.toContain(SECOND_SESSION);
  });

  it('deduplicates session and credential revocation retries', async () => {
    const runtime = await initialized();
    await authenticate(runtime);
    await authenticate(runtime, SECOND_SESSION);
    const revokeSession: IdentityCommand = {
      type: 'REVOKE_SESSION',
      actorSessionId: SESSION,
      ownerId: OWNER_ID,
      targetSessionId: SECOND_SESSION,
      expectedSecurityRevision: 1,
      idempotencyKey: 'session-revocation-retry',
    };
    await runtime.rawCoordinator.execute(revokeSession);
    await expect(
      runtime.rawCoordinator.execute(revokeSession),
    ).resolves.toMatchObject({ duplicate: true, noticeIntents: [] });

    await runtime.coordinator.execute({
      type: 'ADD_CREDENTIAL',
      actorSessionId: SESSION,
      newCredentialId: SECOND_CREDENTIAL,
      ownerId: OWNER_ID,
      registrationProof: 'verified-registration',
    });
    const revokeCredential: IdentityCommand = {
      type: 'REVOKE_CREDENTIAL',
      actorSessionId: SESSION,
      ownerId: OWNER_ID,
      targetCredentialId: SECOND_CREDENTIAL,
      expectedSecurityRevision: 3,
      idempotencyKey: 'credential-revocation-retry',
    };
    await runtime.rawCoordinator.execute(revokeCredential);
    await expect(
      runtime.rawCoordinator.execute(revokeCredential),
    ).resolves.toMatchObject({ duplicate: true, noticeIntents: [] });
  });

  it('revoking a credential invalidates sessions issued through that credential', async () => {
    const runtime = await initialized();
    await authenticate(runtime);
    await runtime.coordinator.execute({
      type: 'ADD_CREDENTIAL',
      actorSessionId: SESSION,
      newCredentialId: SECOND_CREDENTIAL,
      ownerId: OWNER_ID,
      registrationProof: 'verified-registration',
    });
    await authenticate(runtime, SECOND_SESSION, SECOND_CREDENTIAL);
    const result = await runtime.coordinator.execute({
      type: 'REVOKE_CREDENTIAL',
      actorSessionId: SESSION,
      ownerId: OWNER_ID,
      targetCredentialId: SECOND_CREDENTIAL,
    });

    expect(result.noticeIntents).toEqual([
      { channelRef: CHANNEL, template: 'credential_revoked' },
    ]);
    await expect(
      runtime.coordinator.verify(SECOND_SESSION, START),
    ).resolves.toBeNull();
    await expect(
      runtime.coordinator.verify(SESSION, START),
    ).resolves.not.toBeNull();
  });

  it('will not revoke the last active credential outside recovery', async () => {
    const runtime = await initialized();
    await authenticate(runtime);
    await expect(
      runtime.coordinator.execute({
        type: 'REVOKE_CREDENTIAL',
        actorSessionId: SESSION,
        ownerId: OWNER_ID,
        targetCredentialId: FIRST_CREDENTIAL,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_COMMAND' });
  });

  it('serializes concurrent identity mutations against one expected revision', async () => {
    const runtime = await initialized();
    await authenticate(runtime);
    const commands: readonly IdentityCommand[] = [
      {
        type: 'ADD_CREDENTIAL',
        actorSessionId: SESSION,
        newCredentialId: SECOND_CREDENTIAL,
        ownerId: OWNER_ID,
        registrationProof: 'verified-registration',
        expectedSecurityRevision: 1,
        idempotencyKey: 'concurrent-first',
      },
      {
        type: 'ADD_CREDENTIAL',
        actorSessionId: SESSION,
        newCredentialId: RECOVERED_CREDENTIAL,
        ownerId: OWNER_ID,
        registrationProof: 'verified-registration',
        expectedSecurityRevision: 1,
        idempotencyKey: 'concurrent-second',
      },
    ];

    const settled = await Promise.allSettled(
      commands.map(
        async (command) => await runtime.rawCoordinator.execute(command),
      ),
    );
    expect(settled.filter((item) => item.status === 'fulfilled')).toHaveLength(
      1,
    );
    expect(settled.filter((item) => item.status === 'rejected')).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({ code: 'STALE_SECURITY_REVISION' }),
      }),
    ]);
    const state = await runtime.rawCoordinator.read(OWNER_ID);
    expect(state?.securityRevision).toBe(2);
    expect(state?.credentials).toHaveLength(2);
  });

  it('deduplicates semantic identity retries and rejects key reuse conflicts', async () => {
    const runtime = await initialized();
    await authenticate(runtime);
    const command: IdentityCommand = {
      type: 'ADD_CREDENTIAL',
      actorSessionId: SESSION,
      newCredentialId: SECOND_CREDENTIAL,
      ownerId: OWNER_ID,
      registrationProof: 'verified-registration',
      expectedSecurityRevision: 1,
      idempotencyKey: 'credential-add-retry',
    };

    await expect(
      runtime.rawCoordinator.execute(command),
    ).resolves.toMatchObject({
      duplicate: false,
      state: { securityRevision: 2 },
    });
    await expect(
      runtime.rawCoordinator.execute(command),
    ).resolves.toMatchObject({
      duplicate: true,
      noticeIntents: [],
      state: { securityRevision: 2 },
    });
    await expect(
      runtime.rawCoordinator.execute({
        ...command,
        actorSessionId: SECOND_SESSION,
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(
      JSON.stringify(await runtime.rawCoordinator.read(OWNER_ID)),
    ).not.toContain(command.idempotencyKey);
    await expect(
      runtime.rawCoordinator.execute({
        ...command,
        newCredentialId: RECOVERED_CREDENTIAL,
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    await runtime.rawCoordinator.execute({
      type: 'REVOKE_SESSION',
      actorSessionId: SESSION,
      ownerId: OWNER_ID,
      targetSessionId: SESSION,
      expectedSecurityRevision: 2,
      idempotencyKey: 'advance-identity-revision',
    });
    await expect(runtime.rawCoordinator.execute(command)).rejects.toMatchObject(
      { code: 'STALE_SECURITY_REVISION' },
    );
  });

  it('rejects a new identity command against a stale security revision', async () => {
    const runtime = await initialized();
    await authenticate(runtime);
    await expect(
      runtime.rawCoordinator.execute({
        type: 'ADD_CREDENTIAL',
        actorSessionId: SESSION,
        newCredentialId: SECOND_CREDENTIAL,
        ownerId: OWNER_ID,
        registrationProof: 'verified-registration',
        expectedSecurityRevision: 2,
        idempotencyKey: 'stale-revision',
      }),
    ).rejects.toMatchObject({ code: 'STALE_SECURITY_REVISION' });
  });

  it('starts recovery with a cancellation path and enforces the full cooling-off', async () => {
    const runtime = await initialized();
    await authenticate(runtime);
    const attemptId = `recovery_${hex('attempt')}`;
    const started = await runtime.coordinator.execute({
      type: 'BEGIN_RECOVERY',
      attemptId,
      issuedChannelProof: 'verified-issued_channel',
      ownerId: OWNER_ID,
      savedCodeProof: 'verified-saved_code',
    });
    expect(started.state.recovery?.readyAt).toBe(START + 2 * DAY);
    expect(started.noticeIntents).toEqual([
      { channelRef: CHANNEL, template: 'recovery_started' },
    ]);
    await expect(
      runtime.coordinator.verify(SESSION, START),
    ).resolves.not.toBeNull();

    runtime.setNow(START + 2 * DAY - 1);
    await expect(
      runtime.coordinator.execute({
        type: 'COMPLETE_RECOVERY',
        attemptId,
        issuedChannelProof: 'verified-issued_channel',
        newCredentialId: RECOVERED_CREDENTIAL,
        ownerId: OWNER_ID,
        savedCodeProof: 'verified-saved_code',
        registrationProof: 'verified-registration',
      }),
    ).rejects.toMatchObject({ code: 'COOLING_OFF' });
  });

  it('will not start recovery when either independently modeled proof fails', async () => {
    const runtime = await initialized();
    await expect(
      runtime.coordinator.execute({
        type: 'BEGIN_RECOVERY',
        attemptId: `recovery_${hex('incomplete-proof')}`,
        issuedChannelProof: 'unverified',
        ownerId: OWNER_ID,
        savedCodeProof: 'verified-saved_code',
      }),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_DENIED' });
    expect((await runtime.coordinator.read(OWNER_ID))?.recovery).toBeNull();
  });

  it('completes recovery by replacing old credentials without issuing a session', async () => {
    const runtime = await initialized();
    const attemptId = `recovery_${hex('complete-attempt')}`;
    await runtime.coordinator.execute({
      type: 'BEGIN_RECOVERY',
      attemptId,
      issuedChannelProof: 'verified-issued_channel',
      ownerId: OWNER_ID,
      savedCodeProof: 'verified-saved_code',
    });
    runtime.setNow(START + 2 * DAY);
    const completed = await runtime.coordinator.execute({
      type: 'COMPLETE_RECOVERY',
      attemptId,
      issuedChannelProof: 'verified-issued_channel',
      newCredentialId: RECOVERED_CREDENTIAL,
      ownerId: OWNER_ID,
      savedCodeProof: 'verified-saved_code',
      registrationProof: 'verified-registration',
    });

    expect(completed.state.recovery).toBeNull();
    expect(completed.state.credentials).toEqual([
      expect.objectContaining({
        credentialId: FIRST_CREDENTIAL,
        status: 'revoked',
      }),
      expect.objectContaining({
        credentialId: RECOVERED_CREDENTIAL,
        status: 'active',
      }),
    ]);
    expect(completed.state.sessions).toHaveLength(0);
    expect(completed.noticeIntents).toEqual([
      { channelRef: CHANNEL, template: 'recovery_completed' },
    ]);
  });

  it('lets a still-controlled credential cancel a hostile recovery attempt', async () => {
    const runtime = await initialized();
    const attemptId = `recovery_${hex('hostile-attempt')}`;
    await runtime.coordinator.execute({
      type: 'BEGIN_RECOVERY',
      attemptId,
      issuedChannelProof: 'verified-issued_channel',
      ownerId: OWNER_ID,
      savedCodeProof: 'verified-saved_code',
    });
    await authenticate(runtime);
    const cancelled = await runtime.coordinator.execute({
      type: 'CANCEL_RECOVERY',
      actorSessionId: SESSION,
      ownerId: OWNER_ID,
    });
    expect(cancelled.state.recovery).toBeNull();
    expect(cancelled.noticeIntents[0]?.template).toBe('recovery_cancelled');
  });

  it('replays recovery completion without reissuing authority or notices', async () => {
    const runtime = await initialized();
    const attemptId = `recovery_${hex('retry-completion')}`;
    await runtime.coordinator.execute({
      type: 'BEGIN_RECOVERY',
      attemptId,
      issuedChannelProof: 'verified-issued_channel',
      ownerId: OWNER_ID,
      savedCodeProof: 'verified-saved_code',
    });
    runtime.setNow(START + 2 * DAY);
    const command: IdentityCommand = {
      type: 'COMPLETE_RECOVERY',
      attemptId,
      issuedChannelProof: 'verified-issued_channel',
      newCredentialId: RECOVERED_CREDENTIAL,
      ownerId: OWNER_ID,
      savedCodeProof: 'verified-saved_code',
      registrationProof: 'verified-registration',
      expectedSecurityRevision: 2,
      idempotencyKey: 'recovery-completion-retry',
    };
    await expect(
      runtime.rawCoordinator.execute(command),
    ).resolves.toMatchObject({
      duplicate: false,
      state: { securityRevision: 3 },
    });
    await expect(
      runtime.rawCoordinator.execute(command),
    ).resolves.toMatchObject({
      duplicate: true,
      noticeIntents: [],
      state: { securityRevision: 3 },
    });
  });

  it('requires cooling-off and fresh authentication to change a verified channel', async () => {
    const runtime = await initialized();
    await authenticate(runtime);
    const changeId = `change_${hex('channel-change')}`;
    const started = await runtime.coordinator.execute({
      type: 'BEGIN_VERIFIED_CHANNEL_CHANGE',
      actorSessionId: SESSION,
      changeId,
      nextChannelRef: NEXT_CHANNEL,
      nextChannelVerificationProof: 'verified-channel',
      ownerId: OWNER_ID,
    });
    expect(started.noticeIntents).toEqual([
      { channelRef: CHANNEL, template: 'verified_channel_change_started' },
      {
        channelRef: NEXT_CHANNEL,
        template: 'verified_channel_change_started',
      },
    ]);

    runtime.setNow(START + DAY);
    await expect(
      runtime.coordinator.execute({
        type: 'COMPLETE_VERIFIED_CHANNEL_CHANGE',
        actorSessionId: SESSION,
        changeId,
        ownerId: OWNER_ID,
      }),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_DENIED' });

    await authenticate(runtime, SECOND_SESSION);
    const completed = await runtime.coordinator.execute({
      type: 'COMPLETE_VERIFIED_CHANNEL_CHANGE',
      actorSessionId: SECOND_SESSION,
      changeId,
      ownerId: OWNER_ID,
    });
    expect(completed.state.verifiedChannelRef).toBe(NEXT_CHANNEL);
    expect(completed.noticeIntents).toEqual([
      { channelRef: CHANNEL, template: 'verified_channel_changed' },
      { channelRef: NEXT_CHANNEL, template: 'verified_channel_changed' },
    ]);
    await expect(
      runtime.coordinator.verify(SECOND_SESSION, runtime.now()),
    ).resolves.toBeNull();
  });

  it('will not start a channel change without proof for the next channel', async () => {
    const runtime = await initialized();
    await authenticate(runtime);
    await expect(
      runtime.coordinator.execute({
        type: 'BEGIN_VERIFIED_CHANNEL_CHANGE',
        actorSessionId: SESSION,
        changeId: `change_${hex('unverified-channel')}`,
        nextChannelRef: NEXT_CHANNEL,
        nextChannelVerificationProof: 'unverified',
        ownerId: OWNER_ID,
      }),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_DENIED' });
  });

  it('lets a still-controlled Owner cancel a pending channel change', async () => {
    const runtime = await initialized();
    await authenticate(runtime);
    const changeId = `change_${hex('cancel-channel')}`;
    await runtime.coordinator.execute({
      type: 'BEGIN_VERIFIED_CHANNEL_CHANGE',
      actorSessionId: SESSION,
      changeId,
      nextChannelRef: NEXT_CHANNEL,
      nextChannelVerificationProof: 'verified-channel',
      ownerId: OWNER_ID,
    });
    const cancelled = await runtime.coordinator.execute({
      type: 'CANCEL_VERIFIED_CHANNEL_CHANGE',
      actorSessionId: SESSION,
      changeId,
      ownerId: OWNER_ID,
    });

    expect(cancelled.state.verifiedChannelChange).toBeNull();
    expect(cancelled.state.verifiedChannelRef).toBe(CHANNEL);
    expect(cancelled.noticeIntents).toEqual([
      {
        channelRef: CHANNEL,
        template: 'verified_channel_change_cancelled',
      },
      {
        channelRef: NEXT_CHANNEL,
        template: 'verified_channel_change_cancelled',
      },
    ]);
  });

  it('replays channel completion after its first result revoked the actor session', async () => {
    const runtime = await initialized();
    await authenticate(runtime);
    const changeId = `change_${hex('retry-channel')}`;
    await runtime.coordinator.execute({
      type: 'BEGIN_VERIFIED_CHANNEL_CHANGE',
      actorSessionId: SESSION,
      changeId,
      nextChannelRef: NEXT_CHANNEL,
      nextChannelVerificationProof: 'verified-channel',
      ownerId: OWNER_ID,
    });
    runtime.setNow(START + DAY);
    await authenticate(runtime, SECOND_SESSION);
    const command: IdentityCommand = {
      type: 'COMPLETE_VERIFIED_CHANNEL_CHANGE',
      actorSessionId: SECOND_SESSION,
      changeId,
      ownerId: OWNER_ID,
      expectedSecurityRevision: 2,
      idempotencyKey: 'channel-completion-retry',
    };

    await expect(
      runtime.rawCoordinator.execute(command),
    ).resolves.toMatchObject({
      duplicate: false,
      state: { securityRevision: 3 },
    });
    await expect(
      runtime.rawCoordinator.execute(command),
    ).resolves.toMatchObject({
      duplicate: true,
      noticeIntents: [],
      state: { securityRevision: 3 },
    });
  });
});
