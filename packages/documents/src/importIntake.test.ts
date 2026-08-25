import { describe, expect, it } from 'vitest';

import {
  createImportIntake,
  utf8TextConverter,
  type InspectedImport,
  type ImportScanner,
  type QuarantinedImport,
  type ReviewableTextImport,
  type ScanVerdict,
} from './importIntake';
import { createEditableDocument } from './editableDocument';

const encoder = new TextEncoder();
const SIGNATURE_SET_IDENTITY = `sha256-${'1'.repeat(64)}`;

function scanner(verdict: ScanVerdict = 'clean'): ImportScanner {
  return {
    async scan(source) {
      return {
        scannerId: 'synthetic-scanner',
        engineVersion: 'fixture-v1',
        signatureSetIdentity: SIGNATURE_SET_IDENTITY,
        signatureSetVersion: 'fixture-signatures-v1',
        sourceId: source.sourceId,
        scannedBytes: source.sizeBytes,
        startedAt: 100,
        completedAt: 101,
        isolationProfile: 'synthetic_fixture',
        verdict,
      };
    },
  };
}

function intake(verdict: ScanVerdict = 'clean') {
  return createImportIntake({
    converter: utf8TextConverter,
    inspectionPolicy: {
      acceptedIsolationProfiles: ['synthetic_fixture'],
      maxScanDurationMs: 1_000,
    },
    limits: { maxBytes: 128, maxLines: 4 },
    scanner: scanner(verdict),
  });
}

describe('untrusted import intake', () => {
  it('preserves exact source bytes through quarantine, inspection, and approval', async () => {
    const workflow = intake();
    const bytes = encoder.encode('# Synthetic note\n\nNothing was sent.');
    const prepared = await workflow.prepare({
      bytes,
      declaredMediaType: 'text/markdown; charset=utf-8',
      filename: '../synthetic-note.md',
    });
    expect(prepared.state).toBe('quarantined');
    expect(prepared.filename).toBe('synthetic-note.md');
    expect(prepared.sourceId).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(prepared.originalBytes).toEqual(bytes);

    const inspected = await workflow.inspect(prepared);
    const reviewable = await workflow.review(inspected);
    expect(reviewable.state).toBe('reviewable');
    expect(reviewable.converterId).toBe('vidha-utf8-text-v1');
    expect(reviewable.conversionWarnings).toEqual([
      'Markdown formatting will remain editable source text.',
    ]);
    const approved = await workflow.approve(reviewable);
    expect(approved.state).toBe('approved');
    expect(approved.text).toBe('# Synthetic note\n\nNothing was sent.');
    expect(approved.originalBytes).toEqual(bytes);
  });

  it('records declared-versus-classified type mismatches', async () => {
    const prepared = await intake().prepare({
      bytes: encoder.encode('plain text'),
      declaredMediaType: 'application/octet-stream',
      filename: 'note.txt',
    });
    expect(prepared.detectedMediaType).toBe('text/plain');
    expect(prepared.warnings).toEqual([
      'Declared type application/octet-stream does not match supported classification text/plain.',
    ]);
  });

  it('keeps same-byte intake metadata isolated by preparation identity', async () => {
    const workflow = intake();
    const bytes = encoder.encode('same bounded bytes');
    const plainPrepared = await workflow.prepare({
      bytes,
      declaredMediaType: 'text/plain',
      filename: 'first.txt',
    });
    const markdownPrepared = await workflow.prepare({
      bytes,
      declaredMediaType: 'text/markdown',
      filename: 'second.md',
    });

    expect(plainPrepared.sourceId).toBe(markdownPrepared.sourceId);
    expect(plainPrepared.intakeId).not.toBe(markdownPrepared.intakeId);

    const plainApproved = await workflow.approve(
      await workflow.review(await workflow.inspect(plainPrepared)),
    );
    const markdownApproved = await workflow.approve(
      await workflow.review(await workflow.inspect(markdownPrepared)),
    );

    expect(plainApproved).toMatchObject({
      filename: 'first.txt',
      detectedMediaType: 'text/plain',
      conversionWarnings: [
        'Plain text has no formatting metadata; line breaks will be preserved.',
      ],
    });
    expect(markdownApproved).toMatchObject({
      filename: 'second.md',
      detectedMediaType: 'text/markdown',
      conversionWarnings: [
        'Markdown formatting will remain editable source text.',
      ],
    });
  });

  it('reviews CRLF source exactly before canonical newline normalization', async () => {
    const workflow = intake();
    const prepared = await workflow.prepare({
      bytes: encoder.encode('First line\r\nSecond line\r\n'),
      declaredMediaType: 'text/plain',
      filename: 'windows-note.txt',
    });
    const approved = await workflow.approve(
      await workflow.review(await workflow.inspect(prepared)),
    );
    const document = createEditableDocument({
      title: 'Windows note',
      recipientLabel: 'Mira Chen',
      markdown: approved.text,
    });

    expect(approved.text).toBe('First line\r\nSecond line\r\n');
    expect(document.markdown).toBe('First line\nSecond line\n');
  });

  it('binds inspection to an intake-owned clone when caller bytes mutate', async () => {
    let releaseScan: (() => void) | undefined;
    const scanGate = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    const workflow = createImportIntake({
      converter: utf8TextConverter,
      inspectionPolicy: {
        acceptedIsolationProfiles: ['synthetic_fixture'],
        maxScanDurationMs: 1_000,
      },
      limits: { maxBytes: 128, maxLines: 4 },
      scanner: {
        async scan(source) {
          await scanGate;
          return {
            scannerId: 'deferred-scanner',
            engineVersion: 'fixture-v1',
            signatureSetIdentity: SIGNATURE_SET_IDENTITY,
            signatureSetVersion: 'fixture-signatures-v1',
            sourceId: source.sourceId,
            scannedBytes: source.sizeBytes,
            startedAt: 100,
            completedAt: 101,
            isolationProfile: 'synthetic_fixture',
            verdict: 'clean',
          };
        },
      },
    });
    const prepared = await workflow.prepare({
      bytes: encoder.encode('original bytes'),
      declaredMediaType: 'text/plain',
      filename: 'original.txt',
    });

    const inspection = workflow.inspect(prepared);
    prepared.originalBytes.fill(0x78);
    releaseScan?.();
    const reviewable = await workflow.review(await inspection);
    const approved = await workflow.approve(reviewable);

    expect(approved.text).toBe('original bytes');
  });

  it('rejects a structurally forged inspection result', async () => {
    const workflow = intake();
    const prepared = await workflow.prepare({
      bytes: encoder.encode('bounded text'),
      declaredMediaType: 'text/plain',
      filename: 'bounded.txt',
    });
    const forged = {
      ...prepared,
      state: 'inspected',
      scan: { scannerId: 'forged-scanner', verdict: 'clean' },
    } as InspectedImport;

    await expect(workflow.review(forged)).rejects.toMatchObject({
      code: 'INSPECTION_MISMATCH',
    });
  });

  it.each(['text', 'warnings', 'converter'] as const)(
    'rejects approval when reviewed %s is changed',
    async (changedField) => {
      const workflow = intake();
      const prepared = await workflow.prepare({
        bytes: encoder.encode('bounded text'),
        declaredMediaType: 'text/plain',
        filename: 'bounded.txt',
      });
      const reviewable = await workflow.review(
        await workflow.inspect(prepared),
      );
      const changed = {
        ...reviewable,
        ...(changedField === 'text' ? { text: 'different text' } : {}),
        ...(changedField === 'warnings'
          ? { conversionWarnings: ['Different warning.'] }
          : {}),
        ...(changedField === 'converter'
          ? { converterId: 'different-converter-v1' }
          : {}),
      } satisfies ReviewableTextImport;

      await expect(workflow.approve(changed)).rejects.toMatchObject({
        code: 'INSPECTION_MISMATCH',
      });
    },
  );

  it.each([
    {
      name: 'invalid converter identity',
      converterId: 'INVALID CONVERTER',
      text: 'bounded',
      warnings: [] as string[],
    },
    {
      name: 'oversized text',
      converterId: 'bounded-converter-v1',
      text: 'x'.repeat(129),
      warnings: [] as string[],
    },
    {
      name: 'too many lines',
      converterId: 'bounded-converter-v1',
      text: '1\n2\n3\n4\n5',
      warnings: [] as string[],
    },
    {
      name: 'control character',
      converterId: 'bounded-converter-v1',
      text: 'bounded\u007ftext',
      warnings: [] as string[],
    },
    {
      name: 'too many warnings',
      converterId: 'bounded-converter-v1',
      text: 'bounded',
      warnings: Array.from({ length: 17 }, (_, index) => `Warning ${index}`),
    },
    {
      name: 'invalid warning',
      converterId: 'bounded-converter-v1',
      text: 'bounded',
      warnings: ['Invalid\u0000warning'],
    },
    {
      name: 'empty warning',
      converterId: 'bounded-converter-v1',
      text: 'bounded',
      warnings: [''],
    },
    {
      name: 'oversized warning',
      converterId: 'bounded-converter-v1',
      text: 'bounded',
      warnings: ['x'.repeat(501)],
    },
    {
      name: 'non-string warning',
      converterId: 'bounded-converter-v1',
      text: 'bounded',
      warnings: [42] as unknown as string[],
    },
  ])('rejects $name from a converter', async (fixture) => {
    const boundedWorkflow = createImportIntake({
      converter: {
        converterId: fixture.converterId,
        async convert() {
          return { text: fixture.text, warnings: fixture.warnings };
        },
      },
      inspectionPolicy: {
        acceptedIsolationProfiles: ['synthetic_fixture'],
        maxScanDurationMs: 1_000,
      },
      limits: { maxBytes: 128, maxLines: 4 },
      scanner: scanner(),
    });
    const prepared = await boundedWorkflow.prepare({
      bytes: encoder.encode('bounded text'),
      declaredMediaType: 'text/plain',
      filename: 'bounded.txt',
    });
    await expect(
      boundedWorkflow.review(await boundedWorkflow.inspect(prepared)),
    ).rejects.toMatchObject({
      code: 'CONVERSION_OUTPUT_INVALID',
    });
  });

  it('stores one validated snapshot from accessor-backed converter output', async () => {
    let converterIdReads = 0;
    let textReads = 0;
    let warningReads = 0;
    const workflow = createImportIntake({
      converter: {
        get converterId() {
          converterIdReads += 1;
          return converterIdReads === 1
            ? 'bounded-converter-v1'
            : 'INVALID CONVERTER';
        },
        async convert() {
          return Object.defineProperties(
            {},
            {
              text: {
                get() {
                  textReads += 1;
                  return textReads === 1 ? 'safe text' : 'bad\u007ftext';
                },
              },
              warnings: {
                get() {
                  warningReads += 1;
                  return warningReads === 1
                    ? ['Bounded warning.']
                    : ['bad\u0000warning'];
                },
              },
            },
          ) as { readonly text: string; readonly warnings: readonly string[] };
        },
      },
      inspectionPolicy: {
        acceptedIsolationProfiles: ['synthetic_fixture'],
        maxScanDurationMs: 1_000,
      },
      limits: { maxBytes: 128, maxLines: 4 },
      scanner: scanner(),
    });
    const prepared = await workflow.prepare({
      bytes: encoder.encode('bounded text'),
      declaredMediaType: 'text/plain',
      filename: 'bounded.txt',
    });
    const reviewable = await workflow.review(await workflow.inspect(prepared));

    expect(reviewable).toMatchObject({
      converterId: 'bounded-converter-v1',
      text: 'safe text',
      conversionWarnings: ['Bounded warning.'],
    });
    expect({ converterIdReads, textReads, warningReads }).toEqual({
      converterIdReads: 1,
      textReads: 1,
      warningReads: 1,
    });
  });

  it('rejects a forged quarantine that skipped bounded preparation', async () => {
    const workflow = createImportIntake({
      converter: utf8TextConverter,
      inspectionPolicy: {
        acceptedIsolationProfiles: ['synthetic_fixture'],
        maxScanDurationMs: 1_000,
      },
      limits: { maxBytes: 1, maxLines: 1 },
      scanner: scanner(),
    });
    const originalBytes = encoder.encode('<script>forged()</script>');
    const digest = await globalThis.crypto.subtle.digest(
      'SHA-256',
      originalBytes,
    );
    const forged = {
      state: 'quarantined',
      intakeId: 'forged-intake',
      sourceId: `sha256:${[...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')}`,
      filename: 'forged.txt',
      declaredMediaType: 'text/plain',
      detectedMediaType: 'text/plain',
      sizeBytes: originalBytes.byteLength,
      originalBytes,
      warnings: [],
    } satisfies QuarantinedImport;

    await expect(workflow.inspect(forged)).rejects.toMatchObject({
      code: 'INSPECTION_MISMATCH',
    });
  });

  it.each([
    ['page.html', '<p>HTML</p>'],
    ['document.docx', 'not a DOCX'],
    ['archive.zip', 'not an archive'],
  ])('keeps unsupported source %s unconvertible', async (filename, text) => {
    await expect(
      intake().prepare({
        bytes: encoder.encode(text),
        declaredMediaType: 'application/octet-stream',
        filename,
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_TYPE' });
  });

  it.each([
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '[click](javascript:alert(1))',
  ])('blocks active content before conversion: %s', async (text) => {
    await expect(
      intake().prepare({
        bytes: encoder.encode(text),
        declaredMediaType: 'text/markdown',
        filename: 'unsafe.md',
      }),
    ).rejects.toMatchObject({ code: 'ACTIVE_CONTENT' });
  });

  it('enforces byte, line, NUL, and UTF-8 limits', async () => {
    await expect(
      intake().prepare({
        bytes: new Uint8Array(129),
        declaredMediaType: 'text/plain',
        filename: 'large.txt',
      }),
    ).rejects.toMatchObject({ code: 'SIZE_LIMIT_EXCEEDED' });
    await expect(
      intake().prepare({
        bytes: encoder.encode('1\n2\n3\n4\n5'),
        declaredMediaType: 'text/plain',
        filename: 'lines.txt',
      }),
    ).rejects.toMatchObject({ code: 'LINE_LIMIT_EXCEEDED' });
    await expect(
      intake().prepare({
        bytes: encoder.encode('a\u0000b'),
        declaredMediaType: 'text/plain',
        filename: 'nul.txt',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_UTF8' });
    await expect(
      intake().prepare({
        bytes: Uint8Array.from([0xc3, 0x28]),
        declaredMediaType: 'text/plain',
        filename: 'invalid.txt',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_UTF8' });
  });

  it.each(['malicious', 'unavailable'] as const)(
    'blocks approval when the scanner reports %s',
    async (verdict) => {
      const workflow = intake(verdict);
      const prepared = await workflow.prepare({
        bytes: encoder.encode('bounded text'),
        declaredMediaType: 'text/plain',
        filename: 'bounded.txt',
      });
      const inspected = await workflow.inspect(prepared);
      await expect(workflow.review(inspected)).rejects.toMatchObject({
        code: 'SCAN_BLOCKED',
      });
    },
  );

  it.each(['source', 'duration', 'profile'] as const)(
    'rejects scan evidence with an invalid %s binding',
    async (invalidField) => {
      const workflow = createImportIntake({
        converter: utf8TextConverter,
        inspectionPolicy: {
          acceptedIsolationProfiles: ['synthetic_fixture'],
          maxScanDurationMs: 50,
        },
        limits: { maxBytes: 128, maxLines: 4 },
        scanner: {
          async scan(source) {
            return {
              scannerId: 'fixture-scanner',
              engineVersion: 'fixture-v1',
              signatureSetIdentity: SIGNATURE_SET_IDENTITY,
              signatureSetVersion: 'fixture-signatures-v1',
              sourceId:
                invalidField === 'source'
                  ? `sha256:${'0'.repeat(64)}`
                  : source.sourceId,
              scannedBytes: source.sizeBytes,
              startedAt: 100,
              completedAt: invalidField === 'duration' ? 151 : 101,
              isolationProfile:
                invalidField === 'profile'
                  ? ('isolated_process_no_network' as const)
                  : ('synthetic_fixture' as const),
              verdict: 'clean' as const,
            };
          },
        },
      });
      const prepared = await workflow.prepare({
        bytes: encoder.encode('bounded text'),
        declaredMediaType: 'text/plain',
        filename: 'bounded.txt',
      });

      await expect(workflow.inspect(prepared)).rejects.toMatchObject({
        code: 'INSPECTION_EVIDENCE_INVALID',
      });
    },
  );
});
