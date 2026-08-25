import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { InspectedImport, QuarantinedImport } from './importIntake';
import {
  createClamdInstreamScanner,
  createExecutableImportScanner,
  createPandocJsonConverter,
  createRootlessOciProcessExecutor,
  serializeImportIsolationFailure,
  type ImportIsolationFailureEvent,
  type IsolationProcessExecutor,
} from './executablePipeline';

const START = Date.parse('2026-08-21T12:00:00.000Z');
const SIGNATURE_SET_IDENTITY = `sha256-${'2'.repeat(64)}`;
const source: QuarantinedImport = {
  state: 'quarantined',
  sourceId: `sha256:${'a'.repeat(64)}`,
  filename: 'fixture.md',
  declaredMediaType: 'text/markdown',
  detectedMediaType: 'text/markdown',
  sizeBytes: 17,
  originalBytes: new TextEncoder().encode('# Synthetic text\n'),
  warnings: [],
};

describe('executable import pipeline', () => {
  it('binds classifier and scanner evidence to exact quarantine bytes', async () => {
    const executor: IsolationProcessExecutor = {
      isolationProfile: 'isolated_process_no_network',
      async run() {
        return {
          exitCode: 0,
          outputExceeded: false,
          stderr: new Uint8Array(),
          stdout: new TextEncoder().encode('text/plain\n'),
          timedOut: false,
        };
      },
    };
    const scanner = createExecutableImportScanner({
      classifierExecutable: '/usr/bin/file',
      clock: { now: () => START },
      executor,
      maxDurationMs: 5_000,
      scanner: {
        signatureSetIdentity: SIGNATURE_SET_IDENTITY,
        async scan(bytes) {
          return {
            engineVersion: '1.5.4',
            signatureSetVersion: 'clamav-db-27797',
            verdict:
              bytes.byteLength === source.sizeBytes ? 'clean' : 'unavailable',
          };
        },
      },
    });

    await expect(scanner.scan(source)).resolves.toEqual({
      scannerId: 'clamd-instream',
      engineVersion: '1.5.4',
      signatureSetIdentity: SIGNATURE_SET_IDENTITY,
      signatureSetVersion: 'clamav-db-27797',
      sourceId: source.sourceId,
      scannedBytes: source.sizeBytes,
      startedAt: START,
      completedAt: START,
      isolationProfile: 'isolated_process_no_network',
      verdict: 'clean',
    });
  });

  it('rejects a classifier mismatch before scanning', async () => {
    let scans = 0;
    const scanner = createExecutableImportScanner({
      classifierExecutable: '/usr/bin/file',
      clock: { now: () => START },
      executor: {
        isolationProfile: 'synthetic_fixture',
        async run() {
          return {
            exitCode: 0,
            outputExceeded: false,
            stderr: new Uint8Array(),
            stdout: new TextEncoder().encode('application/zip\n'),
            timedOut: false,
          };
        },
      },
      maxDurationMs: 5_000,
      scanner: {
        signatureSetIdentity: SIGNATURE_SET_IDENTITY,
        async scan() {
          scans += 1;
          return {
            engineVersion: '1.5.4',
            signatureSetVersion: 'clamav-db-27797',
            verdict: 'clean',
          };
        },
      },
    });
    await expect(scanner.scan(source)).rejects.toMatchObject({
      code: 'INSPECTION_MISMATCH',
    });
    expect(scans).toBe(0);
  });

  it('allows bounded Pandoc JSON and rejects raw output nodes', async () => {
    let raw = false;
    const executor: IsolationProcessExecutor = {
      isolationProfile: 'isolated_process_no_network',
      async run() {
        const output = JSON.stringify({
          'pandoc-api-version': [1, 23],
          meta: {},
          blocks: raw
            ? [{ t: 'RawBlock', c: ['html', '<script>'] }]
            : [
                {
                  t: 'Para',
                  c: [
                    { t: 'Str', c: 'Synthetic' },
                    { t: 'Space' },
                    { t: 'Str', c: 'text' },
                  ],
                },
              ],
        });
        return {
          exitCode: 0,
          outputExceeded: false,
          stderr: new Uint8Array(),
          stdout: new TextEncoder().encode(output),
          timedOut: false,
        };
      },
    };
    const converter = createPandocJsonConverter({
      executable: '/usr/bin/pandoc',
      executor,
      maxOutputBytes: 4_096,
      timeoutMs: 5_000,
    });
    const inspected: InspectedImport = {
      ...source,
      state: 'inspected',
      scan: {
        scannerId: 'clamd-instream',
        engineVersion: '1.5.4',
        signatureSetIdentity: SIGNATURE_SET_IDENTITY,
        signatureSetVersion: 'eicar-fixture-v1',
        sourceId: source.sourceId,
        scannedBytes: source.sizeBytes,
        startedAt: START,
        completedAt: START,
        isolationProfile: 'isolated_process_no_network',
        verdict: 'clean',
      },
    };
    await expect(converter.convert(inspected)).resolves.toMatchObject({
      text: 'Synthetic text',
    });
    raw = true;
    await expect(converter.convert(inspected)).rejects.toMatchObject({
      code: 'SCAN_BLOCKED',
    });
  });

  it('serializes only allowlisted content-free isolation telemetry', () => {
    const event = {
      code: 'malformed_output',
      event: 'import_isolation_failure',
      phase: 'conversion',
      sourceId: source.sourceId,
      content: 'synthetic-private-content-canary',
    } as ImportIsolationFailureEvent & {
      readonly content: string;
      readonly sourceId: string;
    };
    expect(serializeImportIsolationFailure(event)).toBe(
      '{"event":"import_isolation_failure","phase":"conversion","code":"malformed_output"}',
    );
    expect(() =>
      serializeImportIsolationFailure({
        code: 'malformed_output',
        event: 'unexpected',
        phase: 'conversion',
      } as unknown as ImportIsolationFailureEvent),
    ).toThrowError(/content-free allowlist/u);
  });

  it('streams exact bytes through the clamd INSTREAM framing protocol', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vidha-clamd-test-'));
    const socketPath = join(directory, 'clamd.sock');
    const received: Buffer[] = [];
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      const connection: Buffer[] = [];
      socket.on('data', (chunk: Buffer) => connection.push(Buffer.from(chunk)));
      socket.on('end', () => {
        const request = Buffer.concat(connection);
        if (request.equals(Buffer.from('zVERSION\0'))) {
          socket.end('ClamAV 1.5.4/27797/Thu Aug 21 00:00:00 2026\0');
        } else {
          received.push(request);
          socket.end('stream: OK\0');
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      const scanner = createClamdInstreamScanner({
        maxBytes: 1_024,
        signatureSetIdentity: SIGNATURE_SET_IDENTITY,
        socketPath,
        timeoutMs: 2_000,
      });
      await expect(scanner.scan(source.originalBytes)).resolves.toEqual({
        engineVersion: '1.5.4',
        signatureSetVersion: 'clamav-db-27797',
        verdict: 'clean',
      });
      const protocol = Buffer.concat(received);
      expect(protocol.subarray(0, 10).toString('utf8')).toBe('zINSTREAM\0');
      expect(protocol.includes(Buffer.from(source.originalBytes))).toBe(true);
      expect(protocol.readUInt32BE(protocol.byteLength - 4)).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('fails closed on spoofed or oversized clamd responses', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vidha-clamd-test-'));
    const socketPath = join(directory, 'clamd.sock');
    let connections = 0;
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      socket.resume();
      socket.on('end', () => {
        connections += 1;
        socket.end(
          connections === 1
            ? 'ClamAV 1.5.4/27797/Thu Aug 21 00:00:00 2026\0'
            : 'attacker-prefix stream: OK\0',
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      const scanner = createClamdInstreamScanner({
        maxBytes: 1_024,
        maxResponseBytes: 128,
        signatureSetIdentity: SIGNATURE_SET_IDENTITY,
        socketPath,
        timeoutMs: 2_000,
      });
      await expect(scanner.scan(source.originalBytes)).resolves.toMatchObject({
        verdict: 'unavailable',
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('builds the fixed rootless OCI profile and proves cleanup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vidha-rootless-test-'));
    const runtime = join(directory, 'podman-fixture');
    const log = join(directory, 'runtime.log');
    const sourcePath = join(directory, 'source.txt');
    await writeFile(
      runtime,
      `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
if [ "$1" = "info" ]; then
  printf 'true'
elif [ "$1" = "run" ]; then
  printf '{"meta":{},"blocks":[]}'
fi
`,
    );
    await chmod(runtime, 0o700);
    await writeFile(sourcePath, 'synthetic');
    try {
      const executor = createRootlessOciProcessExecutor({
        imageReference: `node:24.13.1-bookworm-slim@sha256:${'a'.repeat(64)}`,
        readonlyPaths: [directory],
        role: 'isolation-probe',
        runId: 'unit-rootless',
        runtimeExecutable: runtime,
      });
      await expect(
        executor.run({
          args: ['-e', 'process.stdout.write("ok")'],
          executable: '/usr/local/bin/node',
          inputPath: sourcePath,
          maxOutputBytes: 1_024,
          timeoutMs: 1_000,
        }),
      ).resolves.toMatchObject({
        exitCode: 0,
        outputExceeded: false,
        timedOut: false,
      });
      const invocations = await readFile(log, 'utf8');
      expect(invocations).toContain(
        'info --format={{.Host.Security.Rootless}}',
      );
      expect(invocations).toContain('--pull=never');
      expect(invocations).toContain('--network=none');
      expect(invocations).toContain('--read-only-tmpfs=false');
      expect(invocations).toContain('--cap-drop=all');
      expect(invocations).toContain('--security-opt=no-new-privileges');
      expect(invocations).toContain('--userns=keep-id');
      expect(invocations).toContain('destination=/vidha-input/source,ro=true');
      expect(invocations).toContain(
        'rm --force --ignore unit-rootless-isolation-probe-1',
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('rejects symlink inputs before starting a rootless OCI job', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vidha-rootless-test-'));
    const runtime = join(directory, 'podman-fixture');
    const target = join(directory, 'target.txt');
    const link = join(directory, 'source.txt');
    await writeFile(
      runtime,
      '#!/bin/sh\nif [ "$1" = "info" ]; then printf "true"; fi\n',
    );
    await chmod(runtime, 0o700);
    await writeFile(target, 'synthetic');
    await symlink(target, link);
    try {
      const executor = createRootlessOciProcessExecutor({
        imageReference: `node:24.13.1-bookworm-slim@sha256:${'b'.repeat(64)}`,
        readonlyPaths: [],
        role: 'converter',
        runId: 'unit-symlink',
        runtimeExecutable: runtime,
      });
      await expect(
        executor.run({
          args: [],
          executable: '/usr/local/bin/node',
          inputPath: link,
          maxOutputBytes: 1_024,
          timeoutMs: 1_000,
        }),
      ).rejects.toMatchObject({ code: 'SCAN_BLOCKED' });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('mounts a private descriptor-backed copy across an input path swap', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vidha-rootless-test-'));
    const runtime = join(directory, 'podman-fixture');
    const sourcePath = join(directory, 'source.txt');
    const preservedPath = join(directory, 'source-approved.txt');
    const attackerPath = join(directory, 'source-attacker.txt');
    await writeFile(sourcePath, 'approved bytes');
    await writeFile(attackerPath, 'swapped bytes');
    await writeFile(
      runtime,
      `#!/bin/sh
if [ "$1" = "info" ]; then
  printf 'true'
elif [ "$1" = "run" ]; then
  mv ${JSON.stringify(sourcePath)} ${JSON.stringify(preservedPath)}
  ln -s ${JSON.stringify(attackerPath)} ${JSON.stringify(sourcePath)}
  for argument in "$@"; do
    case "$argument" in
      *destination=/vidha-input/source*)
        staged=$(printf '%s' "$argument" | sed 's|^type=bind,source=||; s|,destination=/vidha-input/source,ro=true$||')
        cat "$staged"
        ;;
    esac
  done
fi
`,
    );
    await chmod(runtime, 0o700);
    try {
      const executor = createRootlessOciProcessExecutor({
        imageReference: `node:24.13.1-bookworm-slim@sha256:${'c'.repeat(64)}`,
        readonlyPaths: [],
        role: 'converter',
        runId: 'unit-path-swap',
        runtimeExecutable: runtime,
      });
      const result = await executor.run({
        args: [],
        executable: '/usr/local/bin/node',
        inputPath: sourcePath,
        maxOutputBytes: 1_024,
        timeoutMs: 1_000,
      });
      expect(new TextDecoder().decode(result.stderr)).toBe('');
      expect(result.exitCode).toBe(0);
      expect(new TextDecoder().decode(result.stdout)).toBe('approved bytes');
      expect((await lstat(sourcePath)).isSymbolicLink()).toBe(true);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
