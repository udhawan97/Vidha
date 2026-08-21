import { describe, expect, it } from 'vitest';

import {
  createImportIntake,
  utf8TextConverter,
  type ImportScanner,
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
    const bytes = encoder.encode('# Synthetic note\n\nNothing was sent.');
    const prepared = await intake().prepare({
      bytes,
      declaredMediaType: 'text/markdown; charset=utf-8',
      filename: '../synthetic-note.md',
    });
    expect(prepared.state).toBe('quarantined');
    expect(prepared.filename).toBe('synthetic-note.md');
    expect(prepared.sourceId).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(prepared.originalBytes).toEqual(bytes);

    const inspected = await intake().inspect(prepared);
    const approved = await intake().approve(inspected);
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
