import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ImportIntakeError,
  type ImportScanResult,
  type ImportScanner,
  type QuarantinedImport,
  type ScanIsolationProfile,
  type TextImportConverter,
} from './importIntake';

export interface IsolationProcessResult {
  readonly exitCode: number | null;
  readonly outputExceeded: boolean;
  readonly stderr: Uint8Array;
  readonly stdout: Uint8Array;
  readonly timedOut: boolean;
}

export interface IsolationProcessExecutor {
  readonly isolationProfile: ScanIsolationProfile;
  run(input: {
    readonly args: readonly string[];
    readonly executable: string;
    readonly maxOutputBytes: number;
    readonly timeoutMs: number;
  }): Promise<IsolationProcessResult>;
}

export interface ClamStreamScanner {
  scan(bytes: Uint8Array): Promise<{
    readonly engineVersion: string;
    readonly signatureSetVersion: string;
    readonly verdict: 'clean' | 'malicious' | 'unavailable';
  }>;
}

export function createExecutableImportScanner(input: {
  readonly classifierExecutable: string;
  readonly clock: { now(): number };
  readonly executor: IsolationProcessExecutor;
  readonly maxDurationMs: number;
  readonly scanner: ClamStreamScanner;
}): ImportScanner {
  return {
    async scan(source) {
      const startedAt = validNow(input.clock);
      const directory = await mkdtemp(join(tmpdir(), 'vidha-import-'));
      const sourcePath = join(directory, 'source.bin');
      try {
        await writeFile(sourcePath, source.originalBytes, { mode: 0o400 });
        const classification = await input.executor.run({
          executable: input.classifierExecutable,
          args: ['--brief', '--mime-type', '--no-pad', sourcePath],
          maxOutputBytes: 256,
          timeoutMs: input.maxDurationMs,
        });
        if (
          classification.timedOut ||
          classification.outputExceeded ||
          classification.exitCode !== 0 ||
          classification.stderr.byteLength > 0
        ) {
          return evidence(
            source,
            input,
            startedAt,
            validNow(input.clock),
            unavailableScan,
          );
        }
        const detected = new TextDecoder('utf-8', { fatal: true })
          .decode(classification.stdout)
          .trim();
        if (detected !== 'text/plain') {
          throw new ImportIntakeError(
            'INSPECTION_MISMATCH',
            'Executable classification does not match the bounded text intake.',
          );
        }
        const scan = await input.scanner.scan(source.originalBytes);
        return evidence(source, input, startedAt, validNow(input.clock), scan);
      } catch (error) {
        if (error instanceof ImportIntakeError) throw error;
        return evidence(
          source,
          input,
          startedAt,
          validNow(input.clock),
          unavailableScan,
        );
      } finally {
        await rm(directory, { force: true, recursive: true });
      }
    },
  };
}

export function createPandocJsonConverter(input: {
  readonly executable: string;
  readonly executor: IsolationProcessExecutor;
  readonly maxOutputBytes: number;
  readonly timeoutMs: number;
}): TextImportConverter {
  return {
    converterId: 'pandoc-json-bounded-v1',
    async convert(source) {
      const directory = await mkdtemp(join(tmpdir(), 'vidha-convert-'));
      const sourcePath = join(directory, 'source.txt');
      try {
        await writeFile(sourcePath, source.originalBytes, { mode: 0o400 });
        const reader =
          source.detectedMediaType === 'text/markdown'
            ? 'commonmark_x-raw_html'
            : 'markdown_strict';
        const result = await input.executor.run({
          executable: input.executable,
          args: ['--sandbox', `--from=${reader}`, '--to=json', sourcePath],
          maxOutputBytes: input.maxOutputBytes,
          timeoutMs: input.timeoutMs,
        });
        if (result.timedOut || result.outputExceeded || result.exitCode !== 0) {
          blocked('Pandoc conversion failed or exceeded its time limit.');
        }
        const output = result.stdout;
        if (output.byteLength > input.maxOutputBytes) {
          blocked('Pandoc output exceeded the bounded output limit.');
        }
        const document: unknown = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(output),
        );
        validatePandocDocument(document);
        return {
          text: extractPlainText(document),
          warnings: [
            'Converted through a bounded Pandoc JSON fixture; compare against the preserved original.',
          ],
        };
      } catch (error) {
        if (error instanceof ImportIntakeError) throw error;
        blocked('Pandoc output was unavailable or malformed.');
      } finally {
        await rm(directory, { force: true, recursive: true });
      }
    },
  };
}

export function createHostProcessExecutor(): IsolationProcessExecutor {
  return {
    isolationProfile: 'synthetic_fixture',
    async run(input) {
      return await new Promise((resolve) => {
        const child = spawn(input.executable, [...input.args], {
          env: { LANG: 'C', PATH: '/usr/bin:/bin:/opt/homebrew/bin' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let outputBytes = 0;
        let outputExceeded = false;
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, input.timeoutMs);
        const append = (target: Buffer[], chunk: Buffer) => {
          outputBytes += chunk.byteLength;
          if (outputBytes > input.maxOutputBytes) {
            outputExceeded = true;
            child.kill('SIGKILL');
            return;
          }
          target.push(Buffer.from(chunk));
        };
        child.stdout.on('data', (chunk: Buffer) => append(stdout, chunk));
        child.stderr.on('data', (chunk: Buffer) => append(stderr, chunk));
        child.once('error', () => {
          clearTimeout(timer);
          resolve({
            exitCode: null,
            outputExceeded,
            stdout: new Uint8Array(),
            stderr: new Uint8Array(),
            timedOut,
          });
        });
        child.once('close', (exitCode) => {
          clearTimeout(timer);
          resolve({
            exitCode,
            outputExceeded,
            stdout: Uint8Array.from(Buffer.concat(stdout)),
            stderr: Uint8Array.from(Buffer.concat(stderr)),
            timedOut,
          });
        });
      });
    },
  };
}

export function createClamdInstreamScanner(input: {
  readonly host?: string;
  readonly maxBytes: number;
  readonly maxResponseBytes?: number;
  readonly port?: number;
  readonly socketPath?: string;
  readonly timeoutMs: number;
}): ClamStreamScanner {
  if (
    !Number.isSafeInteger(input.maxBytes) ||
    input.maxBytes <= 0 ||
    (input.maxResponseBytes !== undefined &&
      (!Number.isSafeInteger(input.maxResponseBytes) ||
        input.maxResponseBytes <= 0)) ||
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs <= 0 ||
    (input.socketPath === undefined) ===
      (input.host === undefined || input.port === undefined)
  ) {
    throw new ImportIntakeError(
      'INVALID_LIMITS',
      'The ClamAV INSTREAM profile is invalid.',
    );
  }
  return {
    async scan(bytes) {
      const versionResponse = await requestClamd(input, (socket) => {
        socket.end('zVERSION\0');
      });
      const version = parseClamdVersion(versionResponse);
      if (version === undefined) return unavailableScan;
      if (bytes.byteLength > input.maxBytes) {
        return { ...version, verdict: 'unavailable' };
      }
      const scanResponse = await requestClamd(input, (socket) => {
        socket.write('zINSTREAM\0');
        for (let offset = 0; offset < bytes.byteLength; offset += 64 * 1024) {
          const chunk = bytes.subarray(offset, offset + 64 * 1024);
          const length = Buffer.alloc(4);
          length.writeUInt32BE(chunk.byteLength);
          socket.write(length);
          socket.write(chunk);
        }
        socket.end(Buffer.alloc(4));
      });
      return {
        ...version,
        verdict:
          scanResponse !== undefined && /^stream: OK\0?$/u.test(scanResponse)
            ? 'clean'
            : scanResponse !== undefined &&
                /^stream: [^\0\r\n]{1,200} FOUND\0?$/u.test(scanResponse)
              ? 'malicious'
              : 'unavailable',
      };
    },
  };
}

async function requestClamd(
  input: {
    readonly host?: string;
    readonly maxResponseBytes?: number;
    readonly port?: number;
    readonly socketPath?: string;
    readonly timeoutMs: number;
  },
  send: (socket: ReturnType<typeof connect>) => void,
): Promise<string | undefined> {
  return await new Promise((resolve) => {
    const socket =
      input.socketPath === undefined
        ? connect(input.port ?? 0, input.host ?? '')
        : connect(input.socketPath);
    const chunks: Buffer[] = [];
    const maxResponseBytes = input.maxResponseBytes ?? 4_096;
    let responseBytes = 0;
    let settled = false;
    const finish = (response?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(response);
    };
    const timer = setTimeout(() => finish(), input.timeoutMs);
    socket.once('error', () => finish());
    socket.on('data', (chunk: Buffer) => {
      responseBytes += chunk.byteLength;
      if (responseBytes > maxResponseBytes) finish();
      else chunks.push(Buffer.from(chunk));
    });
    socket.once('end', () => finish(Buffer.concat(chunks).toString('utf8')));
    socket.once('connect', () => send(socket));
  });
}

function parseClamdVersion(response?: string):
  | {
      readonly engineVersion: string;
      readonly signatureSetVersion: string;
    }
  | undefined {
  const match =
    /^ClamAV ([0-9]+(?:\.[0-9]+){1,3})\/([0-9]+)\/[^\0\r\n]{1,128}\0?$/u.exec(
      response ?? '',
    );
  if (match === null) return undefined;
  return {
    engineVersion: match[1] ?? 'unavailable',
    signatureSetVersion: `clamav-db-${match[2] ?? 'unavailable'}`,
  };
}

function evidence(
  source: QuarantinedImport,
  input: {
    readonly executor: IsolationProcessExecutor;
    readonly scanner: ClamStreamScanner;
  },
  startedAt: number,
  completedAt: number,
  scan: Pick<
    ImportScanResult,
    'engineVersion' | 'signatureSetVersion' | 'verdict'
  >,
): ImportScanResult {
  return {
    scannerId: 'clamd-instream',
    engineVersion: scan.engineVersion,
    signatureSetVersion: scan.signatureSetVersion,
    sourceId: source.sourceId,
    scannedBytes: source.sizeBytes,
    startedAt,
    completedAt,
    isolationProfile: input.executor.isolationProfile,
    verdict: scan.verdict,
  };
}

function validatePandocDocument(
  value: unknown,
): asserts value is PandocDocument {
  if (typeof value !== 'object' || value === null) {
    blocked('Pandoc JSON must be an object.');
  }
  const candidate = value as { blocks?: unknown; meta?: unknown };
  if (!Array.isArray(candidate.blocks) || typeof candidate.meta !== 'object') {
    blocked('Pandoc JSON is missing its canonical fields.');
  }
  walk(candidate.blocks);
}

function walk(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  const node = value as { t?: unknown; c?: unknown };
  if (typeof node.t === 'string') {
    const allowed = new Set([
      'BlockQuote',
      'BulletList',
      'Code',
      'CodeBlock',
      'Emph',
      'Header',
      'LineBreak',
      'Link',
      'OrderedList',
      'Para',
      'Plain',
      'SoftBreak',
      'Space',
      'Str',
      'Strong',
    ]);
    if (!allowed.has(node.t)) {
      blocked('Pandoc JSON contains an unsupported or raw node.');
    }
    if (node.t === 'Link') validateLink(node.c);
  }
  for (const nested of Object.values(node)) walk(nested);
}

function validateLink(content: unknown): void {
  const target = Array.isArray(content) ? content.at(-1) : undefined;
  const href = Array.isArray(target) ? target[0] : undefined;
  if (
    typeof href !== 'string' ||
    (!href.startsWith('https://') &&
      !href.startsWith('http://') &&
      !href.startsWith('mailto:') &&
      !href.startsWith('#'))
  ) {
    blocked('Pandoc JSON contains a disallowed link scheme.');
  }
}

function extractPlainText(document: PandocDocument): string {
  const output: string[] = [];
  const collect = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) collect(item);
    } else if (typeof value === 'object' && value !== null) {
      const node = value as { t?: unknown; c?: unknown };
      if (node.t === 'Str' && typeof node.c === 'string') output.push(node.c);
      else if (node.t === 'Space' || node.t === 'SoftBreak') output.push(' ');
      else if (node.t === 'LineBreak') output.push('\n');
      else for (const nested of Object.values(node)) collect(nested);
    }
  };
  collect(document.blocks);
  return output.join('').trim();
}

interface PandocDocument {
  readonly blocks: readonly unknown[];
  readonly meta: object;
}

function validNow(clock: { now(): number }): number {
  const at = clock.now();
  if (!Number.isSafeInteger(at)) {
    throw new ImportIntakeError('INVALID_LIMITS', 'Scanner time is invalid.');
  }
  return at;
}

const unavailableScan = {
  engineVersion: 'unavailable',
  signatureSetVersion: 'unavailable',
  verdict: 'unavailable',
} as const;

function blocked(message: string): never {
  throw new ImportIntakeError('SCAN_BLOCKED', message);
}
