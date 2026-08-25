import {
  chmod,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { afterAll, describe, expect, it } from 'vitest';

import {
  createImportIntake,
  type InspectedImport,
  type QuarantinedImport,
} from './importIntake';
import {
  createClamdInstreamScanner,
  createExecutableImportScanner,
  createPandocJsonConverter,
  createRootlessOciProcessExecutor,
  serializeImportIsolationFailure,
} from './executablePipeline';

const required = process.env.VIDHA_REQUIRE_ROOTLESS_ISOLATION === '1';
const runtimeExecutable = process.env.VIDHA_ROOTLESS_OCI_RUNTIME;
const imageReference = process.env.VIDHA_ROOTLESS_OCI_IMAGE;
const runId = process.env.VIDHA_ROOTLESS_OCI_RUN_ID;
const toolsRoot = process.env.VIDHA_SCANNER_TOOLS_ROOT;
const fileExecutable = process.env.VIDHA_FILE_BIN;
const pandocExecutable = process.env.VIDHA_PANDOC_BIN;
const clamdSocket = process.env.VIDHA_CLAMD_SOCKET;
const signatureSetIdentity = process.env.VIDHA_SIGNATURE_SET_IDENTITY;
const fixtureTemp = process.env.VIDHA_IMPORT_FIXTURE_TEMP;
const runtimeEnvironment = {
  ...(process.env.VIDHA_OCI_STORAGE_CONF === undefined
    ? {}
    : { CONTAINERS_STORAGE_CONF: process.env.VIDHA_OCI_STORAGE_CONF }),
  ...(process.env.VIDHA_OCI_XDG_CONFIG_HOME === undefined
    ? {}
    : { XDG_CONFIG_HOME: process.env.VIDHA_OCI_XDG_CONFIG_HOME }),
  ...(process.env.VIDHA_OCI_XDG_DATA_HOME === undefined
    ? {}
    : { XDG_DATA_HOME: process.env.VIDHA_OCI_XDG_DATA_HOME }),
  ...(process.env.VIDHA_OCI_XDG_RUNTIME_DIR === undefined
    ? {}
    : { XDG_RUNTIME_DIR: process.env.VIDHA_OCI_XDG_RUNTIME_DIR }),
};

const missing = [
  runtimeExecutable,
  imageReference,
  runId,
  toolsRoot,
  fileExecutable,
  pandocExecutable,
  clamdSocket,
  signatureSetIdentity,
  fixtureTemp,
].some((value) => value === undefined);
if (required && missing) {
  throw new Error(
    'The rootless isolation gate requires its OCI runtime, digest-pinned image, run identity, tool paths, ClamAV socket, signature identity, and fixture temp root.',
  );
}

const suite = missing ? describe.skip : describe;
const START = Date.parse('2026-08-25T12:00:00.000Z');
const CANARY = 'synthetic-private-content-canary';
const parentCredential = process.env.VIDHA_SYNTHETIC_PARENT_CREDENTIAL;
const resolvedRuntimeExecutable = runtimeExecutable ?? '/usr/bin/false';
const resolvedImageReference =
  imageReference ?? `node:24.13.1-bookworm-slim@sha256:${'0'.repeat(64)}`;
const resolvedRunId = runId ?? 'skipped-rootless';
const resolvedToolsRoot = toolsRoot ?? tmpdir();
const resolvedClamdSocket = clamdSocket ?? join(tmpdir(), 'missing-clamd.sock');
const resolvedSignatureSetIdentity =
  signatureSetIdentity ?? `sha256-${'0'.repeat(64)}`;
const resolvedFixtureTemp = fixtureTemp ?? tmpdir();
const eicar = new TextEncoder().encode(
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
);
const scratchDirectories: string[] = [];

suite('rootless adversarial import isolation', () => {
  const classifier = createRootlessOciProcessExecutor({
    imageReference: resolvedImageReference,
    readonlyPaths: [resolvedToolsRoot],
    role: 'classifier',
    runId: resolvedRunId,
    runtimeEnvironment,
    runtimeExecutable: resolvedRuntimeExecutable,
  });
  const converterExecutor = createRootlessOciProcessExecutor({
    imageReference: resolvedImageReference,
    readonlyPaths: [resolvedToolsRoot],
    role: 'converter',
    runId: resolvedRunId,
    runtimeEnvironment,
    runtimeExecutable: resolvedRuntimeExecutable,
  });
  const probe = createRootlessOciProcessExecutor({
    imageReference: resolvedImageReference,
    readonlyPaths: [],
    role: 'isolation-probe',
    runId: resolvedRunId,
    runtimeEnvironment,
    runtimeExecutable: resolvedRuntimeExecutable,
  });
  const clam = createClamdInstreamScanner({
    maxBytes: 1_048_576,
    signatureSetIdentity: resolvedSignatureSetIdentity,
    socketPath: resolvedClamdSocket,
    timeoutMs: 10_000,
  });

  afterAll(async () => {
    await Promise.all(
      scratchDirectories.map(async (directory) => {
        await rm(directory, { force: true, recursive: true });
      }),
    );
    expect(await readdir(resolvedFixtureTemp)).toEqual([]);
  });

  it('binds benign scan and conversion to the immutable signature set', async () => {
    const intake = createImportIntake({
      converter: createPandocJsonConverter({
        executable: pandocExecutable ?? '/usr/bin/false',
        executor: converterExecutor,
        maxOutputBytes: 65_536,
        timeoutMs: 10_000,
      }),
      inspectionPolicy: {
        acceptedIsolationProfiles: ['isolated_process_no_network'],
        maxScanDurationMs: 15_000,
      },
      limits: { maxBytes: 1_048_576, maxLines: 10_000 },
      scanner: createExecutableImportScanner({
        classifierExecutable: fileExecutable ?? '/usr/bin/false',
        clock: { now: () => Date.now() },
        executor: classifier,
        maxDurationMs: 10_000,
        scanner: clam,
      }),
    });
    const prepared = await intake.prepare({
      bytes: new TextEncoder().encode(
        '# Synthetic\n\nDisposable isolation evidence only.',
      ),
      declaredMediaType: 'text/markdown',
      filename: 'fixture.md',
    });
    const inspected = await intake.inspect(prepared);
    expect(inspected.scan).toMatchObject({
      isolationProfile: 'isolated_process_no_network',
      signatureSetIdentity,
      verdict: 'clean',
    });
    await expect(intake.approve(inspected)).resolves.toMatchObject({
      text: 'SyntheticDisposable isolation evidence only.',
    });
  });

  it('detects EICAR and rejects immutable signature identity mismatch', async () => {
    await expect(clam.scan(eicar)).resolves.toMatchObject({
      verdict: 'malicious',
    });
    expect(() =>
      createClamdInstreamScanner({
        maxBytes: 1_048_576,
        signatureSetIdentity: 'mutable-signatures',
        socketPath: resolvedClamdSocket,
        timeoutMs: 10_000,
      }),
    ).toThrow(/immutable SHA-256 signature-set identity/u);
  });

  it('rejects polyglot and high-ratio archive bytes before scanning', async () => {
    let scans = 0;
    const scanner = createExecutableImportScanner({
      classifierExecutable: fileExecutable ?? '/usr/bin/false',
      clock: { now: () => START },
      executor: classifier,
      maxDurationMs: 10_000,
      scanner: {
        signatureSetIdentity: resolvedSignatureSetIdentity,
        async scan() {
          scans += 1;
          return {
            engineVersion: 'fixture',
            signatureSetVersion: 'fixture',
            verdict: 'clean',
          };
        },
      },
    });
    await expect(
      scanner.scan(
        quarantined(
          Uint8Array.from(
            Buffer.concat([
              Buffer.from('%PDF-1.7\nsynthetic\n', 'utf8'),
              Buffer.from([0x50, 0x4b, 0x03, 0x04]),
              Buffer.from('polyglot', 'utf8'),
            ]),
          ),
          'polyglot.md',
        ),
      ),
    ).rejects.toMatchObject({ code: 'INSPECTION_MISMATCH' });
    await expect(
      scanner.scan(
        quarantined(
          Uint8Array.from(gzipSync(Buffer.alloc(2 * 1_048_576, 0x41))),
          'archive-bomb.txt',
        ),
      ),
    ).rejects.toMatchObject({ code: 'INSPECTION_MISMATCH' });
    expect(scans).toBe(0);
  });

  it('blocks remote-resource ASTs and proves the OCI network is absent', async () => {
    const source = quarantined(
      new TextEncoder().encode(
        '![synthetic](http://169.254.169.254/latest/meta-data/)',
      ),
      'remote.md',
    );
    const converter = createPandocJsonConverter({
      executable: pandocExecutable ?? '/usr/bin/false',
      executor: converterExecutor,
      maxOutputBytes: 65_536,
      timeoutMs: 10_000,
    });
    await expect(converter.convert(inspected(source))).rejects.toMatchObject({
      code: 'SCAN_BLOCKED',
    });
    const network = await probe.run({
      args: [
        '-e',
        "const n=require('node:net');const s=n.connect(80,'169.254.169.254');const t=setTimeout(()=>{s.destroy();process.exit(2)},300);s.on('connect',()=>{clearTimeout(t);process.exit(0)});s.on('error',()=>{clearTimeout(t);process.exit(3)});",
      ],
      executable: '/usr/local/bin/node',
      maxOutputBytes: 1_024,
      timeoutMs: 1_000,
    });
    expect(network.exitCode).not.toBe(0);
  });

  it('terminates time and output abuse and leaves no content in process logs', async () => {
    const timeout = await probe.run({
      args: ['-e', 'setTimeout(()=>{}, 10_000)'],
      executable: '/usr/local/bin/node',
      maxOutputBytes: 1_024,
      timeoutMs: 100,
    });
    expect(timeout.timedOut).toBe(true);
    const flood = await probe.run({
      args: ['-e', "process.stdout.write('x'.repeat(131072))"],
      executable: '/usr/local/bin/node',
      maxOutputBytes: 1_024,
      timeoutMs: 1_000,
    });
    expect(flood.outputExceeded).toBe(true);
    expect(new TextDecoder().decode(timeout.stderr)).not.toContain(CANARY);
    expect(new TextDecoder().decode(flood.stderr)).not.toContain(CANARY);
  });

  it('rejects malformed Pandoc AST output inside the same OCI boundary', async () => {
    const directory = await mkdtemp(
      join(resolvedFixtureTemp, 'malformed-ast-'),
    );
    scratchDirectories.push(directory);
    const executable = join(directory, 'malformed-pandoc');
    await writeFile(
      executable,
      `#!/usr/local/bin/node
const fs = require('node:fs');
const source = fs.readFileSync(process.argv.at(-1), 'utf8');
process.stderr.write(source);
process.stdout.write(JSON.stringify({meta:{},blocks:source}));
`,
    );
    await chmod(executable, 0o700);
    const malformedExecutor = createRootlessOciProcessExecutor({
      imageReference: resolvedImageReference,
      readonlyPaths: [directory],
      role: 'converter',
      runId: resolvedRunId,
      runtimeEnvironment,
      runtimeExecutable: resolvedRuntimeExecutable,
    });
    const telemetryLines: string[] = [];
    const converter = createPandocJsonConverter({
      executable,
      executor: malformedExecutor,
      maxOutputBytes: 4_096,
      telemetry: {
        record(event) {
          const line = serializeImportIsolationFailure(event);
          telemetryLines.push(line);
          console.info(line);
        },
      },
      timeoutMs: 2_000,
    });
    await expect(
      converter.convert(
        inspected(quarantined(new TextEncoder().encode(CANARY))),
      ),
    ).rejects.toMatchObject({ code: 'SCAN_BLOCKED' });
    expect(telemetryLines).toEqual([
      '{"event":"import_isolation_failure","phase":"conversion","code":"unsupported_output"}',
    ]);
    expect(telemetryLines.join('\n')).not.toContain(CANARY);
  });

  it('rejects symlink input and exposes no host credentials', async () => {
    expect(parentCredential).toBe(CANARY);
    const directory = await mkdtemp(join(resolvedFixtureTemp, 'symlink-'));
    scratchDirectories.push(directory);
    const target = join(directory, 'target.txt');
    const link = join(directory, 'source.txt');
    await writeFile(target, CANARY);
    await symlink(target, link);
    await expect(
      probe.run({
        args: [],
        executable: '/usr/local/bin/node',
        inputPath: link,
        maxOutputBytes: 1_024,
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({ code: 'SCAN_BLOCKED' });
    const credentials = await probe.run({
      args: [
        '-e',
        "const forbidden=['DATABASE_URL','AWS_ACCESS_KEY_ID','GITHUB_TOKEN','VIDHA_SESSION_SECRET','VIDHA_SYNTHETIC_PARENT_CREDENTIAL'];process.stdout.write(forbidden.some(k=>process.env[k])?'leak':'clean')",
      ],
      executable: '/usr/local/bin/node',
      maxOutputBytes: 64,
      timeoutMs: 1_000,
    });
    expect(new TextDecoder().decode(credentials.stdout)).toBe('clean');
  });
});

function quarantined(
  bytes: Uint8Array,
  filename = 'fixture.md',
): QuarantinedImport {
  return {
    state: 'quarantined',
    sourceId: `sha256:${'a'.repeat(64)}`,
    filename,
    declaredMediaType: 'text/markdown',
    detectedMediaType: filename.endsWith('.txt')
      ? 'text/plain'
      : 'text/markdown',
    sizeBytes: bytes.byteLength,
    originalBytes: Uint8Array.from(bytes),
    warnings: [],
  };
}

function inspected(source: QuarantinedImport): InspectedImport {
  return {
    ...source,
    state: 'inspected',
    scan: {
      scannerId: 'clamd-instream',
      engineVersion: '1.5.4',
      signatureSetIdentity: resolvedSignatureSetIdentity,
      signatureSetVersion: 'clamav-db-fixture',
      sourceId: source.sourceId,
      scannedBytes: source.sizeBytes,
      startedAt: START,
      completedAt: START,
      isolationProfile: 'isolated_process_no_network',
      verdict: 'clean',
    },
  };
}
