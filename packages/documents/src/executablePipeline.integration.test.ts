import { describe, expect, it } from 'vitest';

import { createImportIntake } from './importIntake';
import {
  createClamdInstreamScanner,
  createExecutableImportScanner,
  createHostProcessExecutor,
  createPandocJsonConverter,
} from './executablePipeline';

const required = process.env.VIDHA_REQUIRE_SCANNER === '1';
const fileExecutable = process.env.VIDHA_FILE_BIN;
const pandocExecutable = process.env.VIDHA_PANDOC_BIN;
const clamdSocket = process.env.VIDHA_CLAMD_SOCKET;
const clamdHost = process.env.VIDHA_CLAMD_HOST;
const clamdPort = process.env.VIDHA_CLAMD_PORT;
if (
  required &&
  (fileExecutable === undefined ||
    pandocExecutable === undefined ||
    (clamdSocket === undefined &&
      (clamdHost === undefined || clamdPort === undefined)))
) {
  throw new Error(
    'VIDHA_FILE_BIN, VIDHA_PANDOC_BIN, and either a clamd socket or host/port are required.',
  );
}

const suite =
  fileExecutable === undefined ||
  pandocExecutable === undefined ||
  (clamdSocket === undefined &&
    (clamdHost === undefined || clamdPort === undefined))
    ? describe.skip
    : describe;

suite('pinned executable import tools', () => {
  it('classifies, streams, and converts benign disposable Markdown', async () => {
    const executor = createHostProcessExecutor();
    const clam = createClamdInstreamScanner({
      ...(clamdHost === undefined ? {} : { host: clamdHost }),
      maxBytes: 1_048_576,
      ...(clamdPort === undefined ? {} : { port: Number(clamdPort) }),
      ...(clamdSocket === undefined ? {} : { socketPath: clamdSocket }),
      timeoutMs: 10_000,
    });
    const intake = createImportIntake({
      converter: createPandocJsonConverter({
        executable: pandocExecutable ?? '',
        executor,
        maxOutputBytes: 65_536,
        timeoutMs: 10_000,
      }),
      inspectionPolicy: {
        acceptedIsolationProfiles: ['synthetic_fixture'],
        maxScanDurationMs: 10_000,
      },
      limits: { maxBytes: 1_048_576, maxLines: 10_000 },
      scanner: createExecutableImportScanner({
        classifierExecutable: fileExecutable ?? '',
        clock: { now: () => Date.now() },
        executor,
        maxDurationMs: 10_000,
        scanner: clam,
      }),
    });
    const prepared = await intake.prepare({
      bytes: new TextEncoder().encode(
        '# Synthetic\n\nDisposable evidence only.',
      ),
      declaredMediaType: 'text/markdown',
      filename: 'fixture.md',
    });
    const inspected = await intake.inspect(prepared);
    expect(inspected.scan.verdict).toBe('clean');
    expect(inspected.scan.engineVersion).not.toBe('unavailable');
    expect(inspected.scan.signatureSetVersion).toMatch(/^clamav-db-[0-9]+$/u);
    await expect(intake.approve(inspected)).resolves.toMatchObject({
      text: 'SyntheticDisposable evidence only.',
    });
  });

  it('detects the EICAR test string without handling real malware', async () => {
    const clam = createClamdInstreamScanner({
      ...(clamdHost === undefined ? {} : { host: clamdHost }),
      maxBytes: 1_048_576,
      ...(clamdPort === undefined ? {} : { port: Number(clamdPort) }),
      ...(clamdSocket === undefined ? {} : { socketPath: clamdSocket }),
      timeoutMs: 10_000,
    });
    const eicar = new TextEncoder().encode(
      'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
    );
    await expect(clam.scan(eicar)).resolves.toMatchObject({
      verdict: 'malicious',
    });
  });
});
