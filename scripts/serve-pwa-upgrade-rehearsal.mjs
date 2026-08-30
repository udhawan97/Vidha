#!/usr/bin/env node
/* global Buffer, URL, console, process, setTimeout */

import { spawn } from 'node:child_process';
import {
  createReadStream,
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, relative, resolve, sep } from 'node:path';

const HOST = '127.0.0.1';
const PORT = Number.parseInt(process.env.VIDHA_PWA_UPGRADE_PORT ?? '4179', 10);
const REHEARSAL_HEADER = 'x-vidha-pwa-upgrade-rehearsal';
const REHEARSAL_TOKEN = 'phase-3o';
const SOURCE_BUILD_IDENTITY = 'phase-3o-source';
const TARGET_BUILD_IDENTITY = 'phase-3o-target';
const repositoryRoot = resolve(import.meta.dirname, '..');
const temporaryRoot = mkdtempSync(join(tmpdir(), 'vidha-pwa-upgrade-'));
const buildRoots = {
  source: join(temporaryRoot, 'source'),
  target: join(temporaryRoot, 'target'),
};

process.once('exit', () => {
  rmSync(temporaryRoot, { force: true, recursive: true });
});

if (!Number.isSafeInteger(PORT) || PORT < 1 || PORT > 65_535) {
  throw new Error('VIDHA_PWA_UPGRADE_PORT must be a valid TCP port.');
}

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.woff2', 'font/woff2'],
]);

function run(command, args, environment = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: { ...process.env, ...environment },
      stdio: 'inherit',
    });
    child.once('error', rejectPromise);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(
        new Error(
          `${command} exited before the rehearsal server started (${signal ?? code ?? 'unknown'}).`,
        ),
      );
    });
  });
}

async function build(buildIdentity, outputDirectory) {
  await run(
    'pnpm',
    [
      '--filter',
      '@vidha/web',
      'exec',
      'vite',
      'build',
      '--outDir',
      outputDirectory,
      '--emptyOutDir',
    ],
    { VIDHA_BUILD_ID: buildIdentity },
  );
  for (const required of ['index.html', 'sw.js']) {
    if (!existsSync(join(outputDirectory, required))) {
      throw new Error(
        `Build ${buildIdentity} did not produce the required ${required}.`,
      );
    }
  }
}

function writeJson(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(body);
}

function rehearsalAuthorized(request) {
  return request.headers[REHEARSAL_HEADER] === REHEARSAL_TOKEN;
}

function fileForRequest(root, pathname, acceptsHtml) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decodedPath.includes('\0')) return null;
  const requested = decodedPath === '/' ? 'index.html' : decodedPath.slice(1);
  const candidate = resolve(root, requested);
  const candidateRelative = relative(root, candidate);
  const escapesRoot =
    candidateRelative === '..' || candidateRelative.startsWith(`..${sep}`);
  if (escapesRoot) return null;
  if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  return acceptsHtml ? join(root, 'index.html') : null;
}

await build(SOURCE_BUILD_IDENTITY, buildRoots.source);
await build(TARGET_BUILD_IDENTITY, buildRoots.target);

let activeBuild = 'source';
const server = createServer((request, response) => {
  const requestUrl = new URL(request.url ?? '/', `http://${HOST}:${PORT}`);

  if (requestUrl.pathname === '/__vidha_pwa_upgrade/status') {
    if (request.method !== 'GET') {
      writeJson(response, 404, { error: 'not-found' });
      return;
    }
    writeJson(response, 200, {
      activeBuild,
      sourceBuildIdentity: SOURCE_BUILD_IDENTITY,
      targetBuildIdentity: TARGET_BUILD_IDENTITY,
    });
    return;
  }

  const switchMatch = /^\/__vidha_pwa_upgrade\/(source|target)$/u.exec(
    requestUrl.pathname,
  );
  if (switchMatch !== null) {
    if (request.method !== 'POST' || !rehearsalAuthorized(request)) {
      writeJson(response, 404, { error: 'not-found' });
      return;
    }
    activeBuild = switchMatch[1];
    writeJson(response, 200, { activeBuild });
    return;
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    writeJson(response, 405, { error: 'method-not-allowed' });
    return;
  }

  const acceptsHtml = request.headers.accept?.includes('text/html') ?? false;
  const filePath = fileForRequest(
    buildRoots[activeBuild],
    requestUrl.pathname,
    acceptsHtml,
  );
  if (filePath === null) {
    writeJson(response, 404, { error: 'not-found' });
    return;
  }

  const headers = {
    'cache-control': 'no-store',
    'content-length': statSync(filePath).size,
    'content-type':
      contentTypes.get(extname(filePath)) ?? 'application/octet-stream',
  };
  if (filePath.endsWith(`${sep}sw.js`)) {
    headers['service-worker-allowed'] = '/';
  }
  response.writeHead(200, headers);
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  createReadStream(filePath).pipe(response);
});

let cleaningUp = false;
function cleanup(exitCode = 0) {
  if (cleaningUp) return;
  cleaningUp = true;
  server.close(() => {
    process.exit(exitCode);
  });
  setTimeout(() => {
    process.exit(exitCode);
  }, 2_000).unref();
}

server.on('error', (error) => {
  console.error(error);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  console.log(`Phase 3O PWA upgrade rehearsal ready at http://${HOST}:${PORT}`);
});

process.once('SIGINT', () => cleanup(0));
process.once('SIGTERM', () => cleanup(0));
