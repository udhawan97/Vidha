import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { InspectedImport, QuarantinedImport } from './importIntake';
import {
  createClamdInstreamScanner,
  createExecutableImportScanner,
  createPandocJsonConverter,
  type IsolationProcessExecutor,
} from './executablePipeline';

const START = Date.parse('2026-08-21T12:00:00.000Z');
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
});
