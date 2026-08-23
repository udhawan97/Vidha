import { describe, expect, it } from 'vitest';

import {
  AttachmentIntakeError,
  SUPPORTED_ATTACHMENT_FORMATS,
  prepareAttachmentCandidate,
} from './attachmentIntake';

const encoder = new TextEncoder();

describe('synthetic Attachment intake', () => {
  it('stages every allowlisted extension as an exact-byte candidate', async () => {
    for (const format of SUPPORTED_ATTACHMENT_FORMATS) {
      const bytes = encoder.encode(`synthetic-${format.extension}`);
      const candidate = await prepareAttachmentCandidate(
        {
          bytes,
          declaredMediaType: format.mediaType,
          filename: `../handoff.${format.extension}`,
        },
        { maxBytes: 128 },
      );

      expect(candidate.filename).toBe(`handoff.${format.extension}`);
      expect(candidate.kind).toBe(format.kind);
      expect(candidate.mediaType).toBe(format.mediaType);
      expect(candidate.originalBytes).toEqual(bytes);
      expect(candidate.originalBytes).not.toBe(bytes);
      expect(candidate.sourceId).toMatch(/^sha256:[a-f0-9]{64}$/u);
    }
  });

  it('records browser media-type disagreement without claiming byte detection', async () => {
    const candidate = await prepareAttachmentCandidate(
      {
        bytes: encoder.encode('synthetic PDF fixture'),
        declaredMediaType: 'application/octet-stream',
        filename: 'handoff.pdf',
      },
      { maxBytes: 128 },
    );

    expect(candidate.warnings).toEqual([
      'The browser reported application/octet-stream; this synthetic fixture classified the file by its .pdf extension.',
    ]);
  });

  it.each([
    ['empty PDF', new Uint8Array(), 'empty.pdf', 4, 'EMPTY_ATTACHMENT'],
    [
      'oversized PDF',
      encoder.encode('too large'),
      'large.pdf',
      4,
      'SIZE_LIMIT_EXCEEDED',
    ],
    [
      'active SVG',
      encoder.encode('<svg onload="run()"/>'),
      'active.svg',
      128,
      'UNSUPPORTED_TYPE',
    ],
    [
      'executable',
      encoder.encode('binary'),
      'program.exe',
      128,
      'UNSUPPORTED_TYPE',
    ],
  ])('rejects %s', async (_label, bytes, filename, maxBytes, code) => {
    await expect(
      prepareAttachmentCandidate(
        { bytes, declaredMediaType: '', filename },
        { maxBytes },
      ),
    ).rejects.toMatchObject({ code });
  });

  it('rejects an invalid intake limit', async () => {
    await expect(
      prepareAttachmentCandidate(
        {
          bytes: encoder.encode('bounded'),
          declaredMediaType: 'application/pdf',
          filename: 'bounded.pdf',
        },
        { maxBytes: 0 },
      ),
    ).rejects.toBeInstanceOf(AttachmentIntakeError);
  });
});
