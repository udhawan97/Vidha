import { describe, expect, it } from 'vitest';

import {
  createImportIntake,
  utf8TextConverter,
  type InspectedImport,
  type ImportScanner,
  type QuarantinedImport,
  type ScanVerdict,
} from './importIntake';

const encoder = new TextEncoder();

function scanner(verdict: ScanVerdict = 'clean'): ImportScanner {
  return {
    async scan() {
      return { scannerId: 'synthetic-scanner', verdict };
    },
  };
}

function intake(verdict: ScanVerdict = 'clean') {
  return createImportIntake({
    converter: utf8TextConverter,
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
    const approved = await workflow.approve(inspected);
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

  it('binds inspection to an intake-owned clone when caller bytes mutate', async () => {
    let releaseScan: (() => void) | undefined;
    const scanGate = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    const workflow = createImportIntake({
      converter: utf8TextConverter,
      limits: { maxBytes: 128, maxLines: 4 },
      scanner: {
        async scan() {
          await scanGate;
          return { scannerId: 'deferred-scanner', verdict: 'clean' };
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
    const approved = await workflow.approve(await inspection);

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

    await expect(workflow.approve(forged)).rejects.toMatchObject({
      code: 'INSPECTION_MISMATCH',
    });
  });

  it('rejects a forged quarantine that skipped bounded preparation', async () => {
    const workflow = createImportIntake({
      converter: utf8TextConverter,
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
      await expect(workflow.approve(inspected)).rejects.toMatchObject({
        code: 'SCAN_BLOCKED',
      });
    },
  );
});
