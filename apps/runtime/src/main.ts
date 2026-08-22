import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { hostname } from 'node:os';

import type { SafetyJob } from '@vidha/operations';
import {
  createPostgresPlatform,
  type PlatformMode,
  type PostgresOperationsStore,
} from '@vidha/platform';

const role = required('VIDHA_ROLE');
if (role !== 'api' && role !== 'worker' && role !== 'migrate') {
  throw new Error('VIDHA_ROLE must be api, worker, or migrate.');
}
const mode = required('VIDHA_MODE');
if (mode !== 'live' && mode !== 'restore_safe') {
  throw new Error('VIDHA_MODE must be live or restore_safe.');
}
const platform = await createPostgresPlatform({
  connectionString: required('DATABASE_URL'),
  environmentId: required('VIDHA_ENVIRONMENT_ID'),
  installationId: required('VIDHA_INSTALLATION_ID'),
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
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.setHeader('cache-control', 'no-store');
    if (request.method !== 'GET') {
      response
        .writeHead(405)
        .end(JSON.stringify({ status: 'method_not_allowed' }));
      return;
    }
    if (request.url === '/healthz') {
      response.writeHead(200).end(JSON.stringify({ status: 'ok', role, mode }));
      return;
    }
    if (request.url === '/readyz') {
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
    response.writeHead(404).end(JSON.stringify({ status: 'not_found' }));
  });
  server.listen(port, '0.0.0.0');
  const close = async () => {
    server.close();
    await platform.close();
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

function startWorker(): void {
  const store = platform.operationsStore;
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
        limit: 10,
      });
      for (const claim of claims)
        await executeFixture(store, claim.job, claim.leaseId);
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

async function executeFixture(
  store: PostgresOperationsStore,
  job: SafetyJob,
  leaseId: string,
): Promise<void> {
  if (job.kind === 'synthetic_notice') {
    const payloadDigest = sha256(
      JSON.stringify({
        jobId: job.jobId,
        kind: job.kind,
        template: job.template,
      }),
    );
    await store.acceptSyntheticSink({ jobId: job.jobId, payloadDigest });
    await store.complete({ jobId: job.jobId, leaseId, at: Date.now() });
    return;
  }
  await store.fail({
    jobId: job.jobId,
    leaseId,
    at: Date.now(),
    failureCode: 'application_adapter_unavailable',
    retryAt: Date.now() + 60_000,
  });
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
