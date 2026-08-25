import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import {
  lstat,
  mkdtemp,
  open,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

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
    readonly inputPath?: string;
    readonly maxOutputBytes: number;
    readonly timeoutMs: number;
  }): Promise<IsolationProcessResult>;
}

export interface RootlessOciProcessExecutorInput {
  readonly imageReference: string;
  readonly readonlyPaths: readonly string[];
  readonly role: 'classifier' | 'converter' | 'isolation-probe';
  readonly runId: string;
  readonly runtimeEnvironment?: Readonly<Record<string, string>>;
  readonly runtimeExecutable: string;
}

export type ImportIsolationFailureCode =
  | 'malformed_output'
  | 'output_exceeded'
  | 'timeout'
  | 'tool_failed'
  | 'unsupported_output';

export interface ImportIsolationFailureEvent {
  readonly code: ImportIsolationFailureCode;
  readonly event: 'import_isolation_failure';
  readonly phase: 'conversion';
}

export interface ImportIsolationTelemetry {
  record(event: ImportIsolationFailureEvent): void;
}

export interface ClamStreamScanner {
  readonly signatureSetIdentity: string;
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
  validateSignatureSetIdentity(input.scanner.signatureSetIdentity);
  return {
    async scan(source) {
      const startedAt = validNow(input.clock);
      const directory = await mkdtemp(join(tmpdir(), 'vidha-import-'));
      const sourcePath = join(directory, 'source.bin');
      try {
        await writeFile(sourcePath, source.originalBytes, { mode: 0o400 });
        const classification = await input.executor.run({
          executable: input.classifierExecutable,
          args: ['--brief', '--mime-type', '--no-pad'],
          inputPath: sourcePath,
          maxOutputBytes: 256,
          timeoutMs: input.maxDurationMs,
        });
        if (
          classification.timedOut ||
          classification.outputExceeded ||
          classification.exitCode !== 0
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
  readonly telemetry?: ImportIsolationTelemetry;
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
          args: ['--sandbox', `--from=${reader}`, '--to=json'],
          inputPath: sourcePath,
          maxOutputBytes: input.maxOutputBytes,
          timeoutMs: input.timeoutMs,
        });
        if (result.timedOut) {
          reportConversionFailure(input.telemetry, 'timeout');
          blocked('Pandoc conversion failed or exceeded its time limit.');
        }
        if (result.outputExceeded) {
          reportConversionFailure(input.telemetry, 'output_exceeded');
          blocked('Pandoc output exceeded the bounded output limit.');
        }
        if (result.exitCode !== 0) {
          reportConversionFailure(input.telemetry, 'tool_failed');
          blocked('Pandoc conversion failed or exceeded its time limit.');
        }
        const output = result.stdout;
        if (output.byteLength > input.maxOutputBytes) {
          reportConversionFailure(input.telemetry, 'output_exceeded');
          blocked('Pandoc output exceeded the bounded output limit.');
        }
        let document: unknown;
        try {
          document = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(output),
          );
        } catch {
          reportConversionFailure(input.telemetry, 'malformed_output');
          blocked('Pandoc output was unavailable or malformed.');
        }
        try {
          validatePandocDocument(document);
        } catch (error) {
          reportConversionFailure(input.telemetry, 'unsupported_output');
          throw error;
        }
        return {
          text: extractPlainText(document),
          warnings: [
            'Converted through a bounded Pandoc JSON fixture; compare against the preserved original.',
          ],
        };
      } catch (error) {
        if (error instanceof ImportIntakeError) throw error;
        reportConversionFailure(input.telemetry, 'tool_failed');
        blocked('Pandoc output was unavailable or malformed.');
      } finally {
        await rm(directory, { force: true, recursive: true });
      }
    },
  };
}

export function serializeImportIsolationFailure(
  event: ImportIsolationFailureEvent,
): string {
  const allowedCodes: readonly ImportIsolationFailureCode[] = [
    'malformed_output',
    'output_exceeded',
    'timeout',
    'tool_failed',
    'unsupported_output',
  ];
  if (
    event.event !== 'import_isolation_failure' ||
    event.phase !== 'conversion' ||
    !allowedCodes.includes(event.code)
  ) {
    throw new ImportIntakeError(
      'INVALID_LIMITS',
      'Import-isolation telemetry must use the content-free allowlist.',
    );
  }
  return JSON.stringify({
    event: 'import_isolation_failure',
    phase: 'conversion',
    code: event.code,
  });
}

function reportConversionFailure(
  telemetry: ImportIsolationTelemetry | undefined,
  code: ImportIsolationFailureCode,
): void {
  try {
    telemetry?.record({
      code,
      event: 'import_isolation_failure',
      phase: 'conversion',
    });
  } catch {
    // Observability cannot change the fail-closed import decision.
  }
}

export function createHostProcessExecutor(): IsolationProcessExecutor {
  return {
    isolationProfile: 'synthetic_fixture',
    async run(input) {
      return await runBoundedProcess({
        args: [
          ...input.args,
          ...(input.inputPath === undefined ? [] : [input.inputPath]),
        ],
        environment: {
          LANG: 'C',
          PATH: '/usr/bin:/bin:/opt/homebrew/bin',
        },
        executable: input.executable,
        maxOutputBytes: input.maxOutputBytes,
        timeoutMs: input.timeoutMs,
      });
    },
  };
}

export function createRootlessOciProcessExecutor(
  input: RootlessOciProcessExecutorInput,
): IsolationProcessExecutor {
  validateRootlessOciInput(input);
  let sequence = 0;
  let rootlessProof: Promise<void> | undefined;
  const environment = rootlessRuntimeEnvironment(input.runtimeEnvironment);

  async function requireRootlessRuntime(): Promise<void> {
    rootlessProof ??= (async () => {
      const result = await runBoundedProcess({
        args: ['info', '--format={{.Host.Security.Rootless}}'],
        environment,
        executable: input.runtimeExecutable,
        maxOutputBytes: 256,
        timeoutMs: 10_000,
      });
      if (
        result.exitCode !== 0 ||
        result.timedOut ||
        result.outputExceeded ||
        decodeProcessOutput(result.stdout).trim() !== 'true'
      ) {
        blocked('The configured OCI runtime did not prove rootless mode.');
      }
    })();
    await rootlessProof;
  }

  return {
    isolationProfile: 'isolated_process_no_network',
    async run(command) {
      validateProcessCommand(command);
      await requireRootlessRuntime();
      const stagedInput =
        command.inputPath === undefined
          ? undefined
          : await stageRootlessInput(command.inputPath);
      try {
        const { containerInputPath, mounts } = await readonlyMounts(
          input.readonlyPaths,
          stagedInput?.path,
        );
        const containerName = `${input.runId}-${input.role}-${String(++sequence)}`;
        const durationSeconds = Math.max(command.timeoutMs / 1_000, 0.001);
        try {
          const result = await runBoundedProcess({
            args: [
              'run',
              '--name',
              containerName,
              '--rm',
              '--pull=never',
              '--label',
              `vidha.import.run=${input.runId}`,
              '--label',
              `vidha.import.role=${input.role}`,
              '--network=none',
              '--read-only',
              '--read-only-tmpfs=false',
              '--cap-drop=all',
              '--security-opt=no-new-privileges',
              '--pids-limit=64',
              '--memory=256m',
              '--cpus=1',
              '--stop-timeout=0',
              '--userns=keep-id',
              '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=16777216',
              ...mounts.flatMap((mount) => [
                '--mount',
                `type=bind,source=${mount.source},destination=${mount.destination},ro=true`,
              ]),
              input.imageReference,
              '/usr/bin/timeout',
              '--signal=KILL',
              `${durationSeconds}s`,
              command.executable,
              ...command.args,
              ...(containerInputPath === undefined ? [] : [containerInputPath]),
            ],
            environment,
            executable: input.runtimeExecutable,
            maxOutputBytes: command.maxOutputBytes,
            timeoutMs: command.timeoutMs + 5_000,
          });
          return {
            ...result,
            timedOut:
              result.timedOut ||
              result.exitCode === 124 ||
              result.exitCode === 137,
          };
        } finally {
          await removeContainer(
            input.runtimeExecutable,
            environment,
            containerName,
          );
        }
      } finally {
        if (stagedInput !== undefined) {
          await rm(stagedInput.directory, { force: true, recursive: true });
        }
      }
    },
  };
}

export function createClamdInstreamScanner(input: {
  readonly host?: string;
  readonly maxBytes: number;
  readonly maxResponseBytes?: number;
  readonly port?: number;
  readonly socketPath?: string;
  readonly signatureSetIdentity: string;
  readonly timeoutMs: number;
}): ClamStreamScanner {
  validateSignatureSetIdentity(input.signatureSetIdentity);
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
    signatureSetIdentity: input.signatureSetIdentity,
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
    signatureSetIdentity: input.scanner.signatureSetIdentity,
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

interface BoundedProcessInput {
  readonly args: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly executable: string;
  readonly maxOutputBytes: number;
  readonly timeoutMs: number;
}

interface ReadonlyMount {
  readonly destination: string;
  readonly source: string;
}

interface StagedRootlessInput {
  readonly directory: string;
  readonly path: string;
}

function validateRootlessOciInput(
  input: RootlessOciProcessExecutorInput,
): void {
  const digestPinnedImage =
    /^[a-z0-9][a-z0-9._/-]*(?::[a-z0-9._-]+)?@sha256:[a-f0-9]{64}$/u;
  const boundedRunId = /^[a-z0-9][a-z0-9-]{0,47}$/u;
  if (
    !digestPinnedImage.test(input.imageReference) ||
    !boundedRunId.test(input.runId) ||
    !isAbsolute(input.runtimeExecutable) ||
    input.readonlyPaths.length > 8 ||
    input.readonlyPaths.some((path) => !isAbsolute(path))
  ) {
    throw new ImportIntakeError(
      'INVALID_LIMITS',
      'Rootless OCI execution requires a digest-pinned image, bounded run identity, absolute runtime, and bounded read-only mounts.',
    );
  }
  rootlessRuntimeEnvironment(input.runtimeEnvironment);
}

function validateProcessCommand(input: {
  readonly args: readonly string[];
  readonly executable: string;
  readonly inputPath?: string;
  readonly maxOutputBytes: number;
  readonly timeoutMs: number;
}): void {
  if (
    !isAbsolute(input.executable) ||
    input.args.some((argument) => argument.includes('\0')) ||
    (input.inputPath !== undefined && !isAbsolute(input.inputPath)) ||
    !Number.isSafeInteger(input.maxOutputBytes) ||
    input.maxOutputBytes <= 0 ||
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs <= 0
  ) {
    throw new ImportIntakeError(
      'INVALID_LIMITS',
      'The isolated process command is not bounded.',
    );
  }
}

function rootlessRuntimeEnvironment(
  configured: Readonly<Record<string, string>> | undefined,
): NodeJS.ProcessEnv {
  const allowed = new Set([
    'CONTAINERS_STORAGE_CONF',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_RUNTIME_DIR',
  ]);
  for (const [name, value] of Object.entries(configured ?? {})) {
    if (!allowed.has(name) || value.includes('\0')) {
      throw new ImportIntakeError(
        'INVALID_LIMITS',
        'The rootless OCI runtime environment contains an unapproved setting.',
      );
    }
  }
  return {
    HOME: process.env.HOME,
    LANG: 'C',
    PATH: '/usr/bin:/bin',
    USER: process.env.USER,
    ...configured,
  };
}

async function readonlyMounts(
  configured: readonly string[],
  inputPath: string | undefined,
): Promise<{
  readonly containerInputPath?: string;
  readonly mounts: readonly ReadonlyMount[];
}> {
  const mounts: ReadonlyMount[] = [];
  for (const destination of configured) {
    const source = await realpath(destination);
    validateMountPath(source);
    validateMountPath(destination);
    mounts.push({ destination, source });
  }
  if (inputPath === undefined) return { mounts };
  const status = await lstat(inputPath);
  if (!status.isFile() || status.isSymbolicLink()) {
    blocked('The isolated process input must be one regular non-symlink file.');
  }
  const source = await realpath(inputPath);
  validateMountPath(source);
  mounts.push({ destination: '/vidha-input/source', source });
  return { containerInputPath: '/vidha-input/source', mounts };
}

async function stageRootlessInput(
  inputPath: string,
): Promise<StagedRootlessInput> {
  const directory = await mkdtemp(join(tmpdir(), 'vidha-oci-input-'));
  const stagedPath = join(directory, 'source');
  let source: Awaited<ReturnType<typeof open>> | undefined;
  let destination: Awaited<ReturnType<typeof open>> | undefined;
  try {
    source = await open(inputPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await source.stat();
    if (!before.isFile()) {
      blocked(
        'The isolated process input must be one regular non-symlink file.',
      );
    }
    destination = await open(
      stagedPath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW |
        constants.O_WRONLY,
      0o400,
    );
    const buffer = Buffer.allocUnsafe(64 * 1_024);
    let offset = 0;
    while (true) {
      const { bytesRead } = await source.read(
        buffer,
        0,
        buffer.byteLength,
        offset,
      );
      if (bytesRead === 0) break;
      let written = 0;
      while (written < bytesRead) {
        const result = await destination.write(
          buffer,
          written,
          bytesRead - written,
          offset + written,
        );
        written += result.bytesWritten;
      }
      offset += bytesRead;
    }
    await destination.sync();
    const after = await source.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      blocked('The isolated process input changed while it was staged.');
    }
    return { directory, path: stagedPath };
  } catch (error) {
    await rm(directory, { force: true, recursive: true });
    if (
      error instanceof ImportIntakeError ||
      (typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ELOOP')
    ) {
      blocked(
        'The isolated process input must be one regular non-symlink file.',
      );
    }
    throw error;
  } finally {
    await Promise.allSettled([source?.close(), destination?.close()]);
  }
}

function validateMountPath(path: string): void {
  if (path.includes(',') || path.includes('\0') || path.includes('\n')) {
    throw new ImportIntakeError(
      'INVALID_LIMITS',
      'The rootless OCI mount path is not representable by the bounded profile.',
    );
  }
}

async function removeContainer(
  runtimeExecutable: string,
  environment: NodeJS.ProcessEnv,
  containerName: string,
): Promise<void> {
  const result = await runBoundedProcess({
    args: ['rm', '--force', '--ignore', containerName],
    environment,
    executable: runtimeExecutable,
    maxOutputBytes: 1_024,
    timeoutMs: 10_000,
  });
  if (result.exitCode !== 0 || result.timedOut || result.outputExceeded) {
    blocked('The rootless OCI process could not prove container cleanup.');
  }
}

async function runBoundedProcess(
  input: BoundedProcessInput,
): Promise<IsolationProcessResult> {
  return await new Promise((resolve) => {
    const child = spawn(input.executable, [...input.args], {
      env: input.environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let outputExceeded = false;
    let settled = false;
    let timedOut = false;
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        outputExceeded,
        stderr: Uint8Array.from(Buffer.concat(stderr)),
        stdout: Uint8Array.from(Buffer.concat(stdout)),
        timedOut,
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, input.timeoutMs);
    const append = (target: Buffer[], chunk: Buffer) => {
      if (outputExceeded) return;
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
    child.once('error', () => finish(null));
    child.once('close', (exitCode) => finish(exitCode));
  });
}

function decodeProcessOutput(output: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(output);
}

function validateSignatureSetIdentity(identity: string): void {
  if (!validSignatureSetIdentity(identity)) {
    throw new ImportIntakeError(
      'INVALID_LIMITS',
      'The scanner requires an immutable SHA-256 signature-set identity.',
    );
  }
}

function validSignatureSetIdentity(identity: string): boolean {
  return /^sha256-[a-f0-9]{64}$/u.test(identity);
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
