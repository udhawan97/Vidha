import { describe, expect, it } from 'vitest';

import { MemoryOperationsStore } from './memory';
import {
  OperationsError,
  createOperationsFoundation,
  createWebCryptoMetadataCipher,
  validateDeploymentManifest,
  type OperationsStore,
  type SafetyJobIntent,
  type StoreMode,
} from './operations';
import { PgliteOperationsStore, createPgliteOperationsStore } from './pglite';

const START = Date.parse('2026-01-01T12:00:00.000Z');

function hex(label: string): string {
  let hash = 2_166_136_261;
  for (const character of label) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0').repeat(8);
}

const RECORD_ID = `metadata_${hex('record')}`;
const JOB_ID = `job_${hex('job')}`;
const COMMAND_KEY = `cmd_${hex('command')}`;
const PLAN_REF = `plan_${hex('plan')}`;
const CHANNEL_REF = `channel_${hex('channel')}`;

function createCipher(randomBytes?: (length: number) => Uint8Array) {
  return createWebCryptoMetadataCipher({
    currentKeyVersion: 'key_fixture_1',
    keys: { key_fixture_1: new Uint8Array(32).fill(7) },
    ...(randomBytes === undefined ? {} : { randomBytes }),
  });
}

function setup(store: OperationsStore = new MemoryOperationsStore()) {
  let now = START;
  const cipher = createCipher();
  const foundation = createOperationsFoundation({
    cipher,
    clock: { now: () => now },
    store,
  });
  return {
    cipher,
    foundation,
    setNow(value: number) {
      now = value;
    },
  };
}

function planJob(overrides: Partial<SafetyJobIntent> = {}): SafetyJobIntent {
  return {
    kind: 'advance_plan_stage',
    jobId: JOB_ID,
    planRef: PLAN_REF,
    commandKey: COMMAND_KEY,
    dueAt: START,
    maxAttempts: 2,
    ...overrides,
  } as SafetyJobIntent;
}

function noticeJob(
  overrides: Partial<SafetyJobIntent> = {},
): SafetyJobIntent & { readonly kind: 'synthetic_notice' } {
  return {
    kind: 'synthetic_notice',
    jobId: JOB_ID,
    channelRef: CHANNEL_REF,
    template: 'owner_security_notice',
    commandKey: COMMAND_KEY,
    dueAt: START,
    maxAttempts: 2,
    ...overrides,
  } as SafetyJobIntent & { readonly kind: 'synthetic_notice' };
}

async function closeStore(store: OperationsStore): Promise<void> {
  if (store instanceof PgliteOperationsStore) {
    await store.close();
  }
}

describe('encrypted metadata foundation', () => {
  it('round-trips bounded metadata while snapshots retain ciphertext only', async () => {
    const runtime = setup();
    await runtime.foundation.writeMetadata({
      recordId: RECORD_ID,
      schemaVersion: 1,
      metadata: {
        fixture_label: 'synthetic-private-marker',
        enabled: true,
        count: 3,
      },
    });

    await expect(runtime.foundation.readMetadata(RECORD_ID)).resolves.toEqual({
      fixture_label: 'synthetic-private-marker',
      enabled: true,
      count: 3,
    });
    const snapshot = await runtime.foundation.exportSnapshot();
    expect(JSON.stringify(snapshot)).not.toContain('synthetic-private-marker');
    expect(snapshot.metadata[0]).toMatchObject({
      recordId: RECORD_ID,
      keyVersion: 'key_fixture_1',
    });
  });

  it('fails closed when authenticated metadata context is changed', async () => {
    const runtime = setup();
    await runtime.foundation.writeMetadata({
      recordId: RECORD_ID,
      schemaVersion: 1,
      metadata: { state: 'synthetic' },
    });
    const record = (await runtime.foundation.exportSnapshot()).metadata[0];
    if (record === undefined) {
      throw new Error('Expected encrypted metadata fixture.');
    }

    await expect(
      runtime.cipher.decrypt({ ...record, schemaVersion: 2 }),
    ).rejects.toMatchObject({ code: 'INVALID_SNAPSHOT' });
  });

  it('rejects initialization-vector reuse from a faulty random source', async () => {
    const cipher = createCipher((length) => new Uint8Array(length).fill(1));
    const plaintext = new TextEncoder().encode('{"state":"synthetic"}');
    await cipher.encrypt({
      recordId: RECORD_ID,
      schemaVersion: 1,
      plaintext,
    });

    await expect(
      cipher.encrypt({
        recordId: `metadata_${hex('another-record')}`,
        schemaVersion: 1,
        plaintext,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' });
  });

  it('purges retention records at the exact boundary', async () => {
    const runtime = setup();
    await runtime.foundation.writeMetadata({
      recordId: RECORD_ID,
      schemaVersion: 1,
      metadata: { state: 'synthetic' },
      retainUntil: START + 100,
    });
    runtime.setNow(START + 99);
    await expect(runtime.foundation.purgeExpiredMetadata()).resolves.toBe(0);
    runtime.setNow(START + 100);
    await expect(runtime.foundation.purgeExpiredMetadata()).resolves.toBe(1);
    await expect(
      runtime.foundation.readMetadata(RECORD_ID),
    ).resolves.toBeNull();
  });

  it('restores into read-only safe mode and rejects all writer work', async () => {
    const live = setup();
    await live.foundation.writeMetadata({
      recordId: RECORD_ID,
      schemaVersion: 1,
      metadata: { state: 'synthetic' },
    });
    await live.foundation.schedule(planJob());

    const safe = createOperationsFoundation({
      cipher: live.cipher,
      clock: { now: () => START },
      store: new MemoryOperationsStore('restore_safe'),
    });
    await safe.restoreSnapshot(await live.foundation.exportSnapshot());
    await expect(safe.readMetadata(RECORD_ID)).resolves.toEqual({
      state: 'synthetic',
    });
    await expect(safe.schedule(planJob())).rejects.toMatchObject({
      code: 'RESTORE_SAFE_MODE',
    });
    await expect(
      safe.runDue({
        executor: { execute: async () => ({ outcome: 'completed' }) },
        leaseMs: 100,
        limit: 1,
        retryDelayMs: 10,
        workerId: 'worker_restore_safe',
      }),
    ).rejects.toMatchObject({ code: 'RESTORE_SAFE_MODE' });
  });
});

describe('durable safety jobs', () => {
  it('deduplicates identical intent and rejects semantic key reuse', async () => {
    const runtime = setup();
    await expect(runtime.foundation.schedule(planJob())).resolves.toMatchObject(
      {
        duplicate: false,
      },
    );
    await expect(runtime.foundation.schedule(planJob())).resolves.toMatchObject(
      {
        duplicate: true,
      },
    );
    await expect(
      runtime.foundation.schedule(planJob({ dueAt: START + 1 })),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('retries deterministically and dead-letters at the configured maximum', async () => {
    const runtime = setup();
    await runtime.foundation.schedule(planJob());
    const executor = {
      execute: async () =>
        ({ outcome: 'retry', failureCode: 'synthetic_failure' }) as const,
    };

    const first = await runtime.foundation.runDue({
      executor,
      leaseMs: 100,
      limit: 1,
      retryDelayMs: 10,
      workerId: 'worker_primary',
    });
    expect(first[0]).toMatchObject({ status: 'pending', attempts: 1 });
    runtime.setNow(START + 10);
    const second = await runtime.foundation.runDue({
      executor,
      leaseMs: 100,
      limit: 1,
      retryDelayMs: 10,
      workerId: 'worker_primary',
    });
    expect(second[0]).toMatchObject({
      status: 'dead_letter',
      attempts: 2,
      lastFailureCode: 'synthetic_failure',
    });
  });

  it('rejects unsupported job kinds and notification templates at runtime', async () => {
    const runtime = setup();
    await expect(
      runtime.foundation.schedule({
        ...planJob(),
        kind: 'release_envelope',
      } as unknown as SafetyJobIntent),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      runtime.foundation.schedule({
        kind: 'synthetic_notice',
        jobId: JOB_ID,
        channelRef: `channel_${hex('channel')}`,
        template: 'private_content',
        commandKey: COMMAND_KEY,
        dueAt: START,
        maxAttempts: 2,
      } as unknown as SafetyJobIntent),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it.each(['completed', 'retry'] as const)(
    'rejects %s settlement when execution reaches the exact lease boundary',
    async (outcome) => {
      const runtime = setup();
      await runtime.foundation.schedule(planJob());
      await expect(
        runtime.foundation.runDue({
          executor: {
            execute: async () => {
              runtime.setNow(START + 100);
              return outcome === 'completed'
                ? ({ outcome: 'completed' } as const)
                : ({ outcome: 'retry', failureCode: 'late_fixture' } as const);
            },
          },
          leaseMs: 100,
          limit: 1,
          retryDelayMs: 10,
          workerId: 'worker_slow_fixture',
        }),
      ).rejects.toMatchObject({ code: 'INVALID_LEASE' });
      await expect(runtime.foundation.inspectJobs()).resolves.toEqual([
        expect.objectContaining({ status: 'leased', attempts: 1 }),
      ]);
    },
  );
});

describe.each([
  [
    'memory',
    async (mode: StoreMode = 'live') =>
      new MemoryOperationsStore(mode) as OperationsStore,
  ],
  [
    'PGlite',
    async (mode: StoreMode = 'live') =>
      await createPgliteOperationsStore({ mode }),
  ],
])('%s operations-store contract', (_name, createStore) => {
  it('grants a due job to only one concurrent worker', async () => {
    const store = await createStore();
    try {
      await store.enqueue(planJob());
      const [first, second] = await Promise.all([
        store.claimDue({
          workerId: 'worker_first',
          at: START,
          leaseMs: 100,
          limit: 1,
        }),
        store.claimDue({
          workerId: 'worker_second',
          at: START,
          leaseMs: 100,
          limit: 1,
        }),
      ]);
      expect(first.length + second.length).toBe(1);
    } finally {
      await closeStore(store);
    }
  });

  it('reclaims an expired lease and fences the stale worker', async () => {
    const store = await createStore();
    try {
      await store.enqueue(planJob());
      const first = (
        await store.claimDue({
          workerId: 'worker_first',
          at: START,
          leaseMs: 100,
          limit: 1,
        })
      )[0];
      if (first === undefined) {
        throw new Error('Expected first safety-job lease.');
      }
      await expect(
        store.complete({
          jobId: JOB_ID,
          leaseId: first.leaseId,
          at: START + 100,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_LEASE' });

      const second = (
        await store.claimDue({
          workerId: 'worker_second',
          at: START + 100,
          leaseMs: 100,
          limit: 1,
        })
      )[0];
      if (second === undefined) {
        throw new Error('Expected reclaimed safety-job lease.');
      }
      expect(second.leaseId).not.toBe(first.leaseId);
      await expect(
        store.complete({
          jobId: JOB_ID,
          leaseId: first.leaseId,
          at: START + 101,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_LEASE' });
      await expect(
        store.complete({
          jobId: JOB_ID,
          leaseId: second.leaseId,
          at: START + 101,
        }),
      ).resolves.toMatchObject({ status: 'completed' });
    } finally {
      await closeStore(store);
    }
  });

  it('dead-letters an expired final-attempt lease instead of reclaiming it', async () => {
    const store = await createStore();
    try {
      await store.enqueue(planJob({ maxAttempts: 1 }));
      await store.claimDue({
        workerId: 'worker_final_attempt',
        at: START,
        leaseMs: 100,
        limit: 1,
      });
      await expect(
        store.claimDue({
          workerId: 'worker_reclaimer',
          at: START + 100,
          leaseMs: 100,
          limit: 1,
        }),
      ).resolves.toEqual([]);
      await expect(store.inspectJobs()).resolves.toEqual([
        expect.objectContaining({
          attempts: 1,
          lastFailureCode: 'lease_expired',
          status: 'dead_letter',
        }),
      ]);
    } finally {
      await closeStore(store);
    }
  });

  it('exports and restores one validated snapshot', async () => {
    const source = await createStore();
    const target = await createStore('restore_safe');
    try {
      await source.enqueue(planJob());
      const snapshot = await source.exportSnapshot();
      await target.restoreSnapshot(snapshot);
      await expect(target.inspectJobs()).resolves.toEqual(snapshot.jobs);
      await expect(
        target.claimDue({
          workerId: 'worker_restore_attempt',
          at: START,
          leaseMs: 100,
          limit: 1,
        }),
      ).rejects.toMatchObject({ code: 'RESTORE_SAFE_MODE' });
      await expect(
        target.complete({
          jobId: JOB_ID,
          leaseId: `lease_${hex('job')}_1`,
          at: START,
        }),
      ).rejects.toMatchObject({ code: 'RESTORE_SAFE_MODE' });
      await expect(target.restoreSnapshot(snapshot)).rejects.toMatchObject({
        code: 'ALREADY_EXISTS',
      });
    } finally {
      await closeStore(source);
      await closeStore(target);
    }
  });

  it('rejects restore into live mode', async () => {
    const source = await createStore();
    const target = await createStore();
    try {
      await source.enqueue(planJob());
      await expect(
        target.restoreSnapshot(await source.exportSnapshot()),
      ).rejects.toMatchObject({ code: 'RESTORE_SAFE_MODE' });
    } finally {
      await closeStore(source);
      await closeStore(target);
    }
  });

  it('commits encrypted state and outbox atomically on success or conflict', async () => {
    const store = await createStore();
    try {
      const runtime = setup(store);
      await runtime.foundation.commitMetadataWithOutbox({
        recordId: RECORD_ID,
        schemaVersion: 1,
        metadata: { revision: 1 },
        outbox: [noticeJob()],
      });
      await expect(runtime.foundation.readMetadata(RECORD_ID)).resolves.toEqual(
        { revision: 1 },
      );
      await expect(runtime.foundation.inspectJobs()).resolves.toHaveLength(1);

      await expect(
        runtime.foundation.commitMetadataWithOutbox({
          recordId: RECORD_ID,
          schemaVersion: 1,
          metadata: { revision: 2 },
          outbox: [noticeJob({ template: 'synthetic_rehearsal' })],
        }),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
      await expect(runtime.foundation.readMetadata(RECORD_ID)).resolves.toEqual(
        { revision: 1 },
      );
    } finally {
      await closeStore(store);
    }
  });
});

describe('deployment topology contract', () => {
  it('requires API and worker roles, PostgreSQL, safe restore, and a read-only watchdog', () => {
    expect(
      validateDeploymentManifest({
        applicationRoles: ['api', 'worker'],
        database: 'postgresql',
        identityAdapter: 'webauthn_fixture',
        notificationAdapter: 'notification_fixture',
        objectStorageAdapter: 'object_storage_fixture',
        restoreStartsSafe: true,
        watchdogCanMutateState: false,
      }),
    ).toMatchObject({ watchdogCanMutateState: false });
  });

  it('rejects a topology that grants the watchdog mutation authority', () => {
    expect(() =>
      validateDeploymentManifest({
        applicationRoles: ['api', 'worker'],
        database: 'postgresql',
        identityAdapter: 'webauthn_fixture',
        notificationAdapter: 'notification_fixture',
        objectStorageAdapter: 'object_storage_fixture',
        restoreStartsSafe: true,
        watchdogCanMutateState: true,
      } as never),
    ).toThrowError(OperationsError);
  });
});
