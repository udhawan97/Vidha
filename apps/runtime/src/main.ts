import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { hostname } from 'node:os';

import {
  createSyntheticConcernOutboxPlanner,
  createPostgresPlatform,
  type PlatformMode,
} from '@vidha/platform';

import { createIdentityRehearsalHandler } from './identityApi';
import {
  WORKER_CLAIM_LIMIT,
  runWorkerClaim,
  serializeWorkerTelemetry,
} from './worker';

const role = required('VIDHA_ROLE');
if (role !== 'api' && role !== 'worker' && role !== 'migrate') {
  throw new Error('VIDHA_ROLE must be api, worker, or migrate.');
}
const mode = required('VIDHA_MODE');
if (mode !== 'live' && mode !== 'restore_safe') {
  throw new Error('VIDHA_MODE must be live or restore_safe.');
}
const installationId = required('VIDHA_INSTALLATION_ID');
const platform = await createPostgresPlatform({
  connectionString: required('DATABASE_URL'),
  environmentId: required('VIDHA_ENVIRONMENT_ID'),
  installationId,
  manageSchema: role === 'migrate',
  mode: mode as PlatformMode,
  onPoolError: reportPostgresPoolError,
});

if (role === 'migrate') {
  process.stdout.write('{"event":"schema_ready"}\n');
  await platform.close();
} else if (role === 'api') {
  startApi();
} else {
  startWorker();
}

function startApi(): void {
  const port = Number(process.env.PORT ?? '8080');
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT is invalid.');
  }
  const identityRehearsal =
    process.env.VIDHA_ENABLE_IDENTITY_REHEARSAL === '1'
      ? createIdentityRehearsalHandler({
          bootstrapCapabilityDigest: required(
            'VIDHA_BOOTSTRAP_CAPABILITY_DIGEST',
          ),
          csrfSecret: required('VIDHA_CSRF_SECRET'),
          identityRepository: platform.identityRepository,
          publicOrigin: required('VIDHA_PUBLIC_ORIGIN'),
          rpId: required('VIDHA_RP_ID'),
          verifiedChannelRef: required('VIDHA_VERIFIED_CHANNEL_REF'),
          webAuthnStore: platform.webAuthnStore,
        })
      : null;
  const bindHost = process.env.VIDHA_BIND_HOST ?? '0.0.0.0';
  if (identityRehearsal !== null && bindHost !== '127.0.0.1') {
    throw new Error(
      'The disposable identity rehearsal must bind only to 127.0.0.1.',
    );
  }
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.setHeader('cache-control', 'no-store');
    if (request.method === 'GET' && request.url === '/healthz') {
      response.writeHead(200).end(JSON.stringify({ status: 'ok', role, mode }));
      return;
    }
    if (request.method === 'GET' && request.url === '/readyz') {
      try {
        const readiness = await platform.readiness();
        response.writeHead(200).end(
          JSON.stringify({
            status: 'ready',
            role,
            mode: readiness.mode,
            databaseMajor: readiness.databaseMajor,
            schemaVersion: readiness.schemaVersion,
          }),
        );
      } catch {
        response.writeHead(503).end(JSON.stringify({ status: 'not_ready' }));
      }
      return;
    }
    if (
      identityRehearsal !== null &&
      (await identityRehearsal.handle(request, response))
    ) {
      return;
    }
    if (request.method !== 'GET') {
      response
        .writeHead(405)
        .end(JSON.stringify({ status: 'method_not_allowed' }));
      return;
    }
    response.writeHead(404).end(JSON.stringify({ status: 'not_found' }));
  });
  server.listen(port, bindHost);
  const close = async () => {
    server.close();
    await platform.close();
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

function startWorker(): void {
  const store = platform.operationsStore;
  const scheduledPlans = platform.createPlanStore(
    createSyntheticConcernOutboxPlanner({
      channelRef: `channel_${sha256(`synthetic-channel:${installationId}`)}`,
    }),
  );
  const workerId = `worker_${sha256(`${hostname()}:${role}`).slice(0, 57)}`;
  let running = false;
  const poll = async () => {
    if (running || mode === 'restore_safe') return;
    running = true;
    try {
      const claims = await store.claimDue({
        workerId,
        at: Date.now(),
        leaseMs: 30_000,
        limit: WORKER_CLAIM_LIMIT,
      });
      for (const claim of claims) {
        await runWorkerClaim({
          claim,
          clock: { now: () => Date.now() },
          operations: store,
          report: (event) =>
            process.stderr.write(`${serializeWorkerTelemetry(event)}\n`),
          retryDelayMs: 60_000,
          scheduledPlans,
        });
      }
    } catch {
      process.stderr.write('{"event":"worker_poll_failed"}\n');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(poll, 1_000);
  void poll();
  const close = async () => {
    clearInterval(timer);
    await platform.close();
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function reportPostgresPoolError(error: Error): void {
  const code = (error as Error & { readonly code?: unknown }).code;
  process.stderr.write(
    `${JSON.stringify({
      code: typeof code === 'string' ? code : 'connection_error',
      event: 'postgres_pool_error',
    })}\n`,
  );
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
