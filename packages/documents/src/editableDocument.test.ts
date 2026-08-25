import { describe, expect, it } from 'vitest';

import {
  EDITABLE_DOCUMENT_SCHEMA,
  EditableDocumentError,
  createEditableDocument,
  exportEditableDocument,
  parseEditableDocument,
  serializeEditableDocument,
  type PortableDocumentFormat,
} from './editableDocument';
import { createImportIntake, utf8TextConverter } from './importIntake';

describe('versioned Editable Documents', () => {
  it('normalizes and deterministically round-trips the canonical schema', () => {
    const document = createEditableDocument({
      markdown: '# First\r\n\r\nA careful note.\r\n',
      recipientLabel: '  Mira   Chen ',
      title: '  A Home Plan  ',
    });
    const serialized = serializeEditableDocument(document);

    expect(document).toEqual({
      schema: EDITABLE_DOCUMENT_SCHEMA,
      schemaVersion: 1,
      title: 'A Home Plan',
      recipientLabel: 'Mira Chen',
      markdown: '# First\n\nA careful note.\n',
    });
    expect(serializeEditableDocument(parseEditableDocument(serialized))).toBe(
      serialized,
    );
  });

  it('exports exact Markdown and a semantic, escaped standalone HTML copy', () => {
    const document = createEditableDocument({
      markdown:
        '# First steps\n\nUse **copies**, not originals.\n\n- Call Mira\n- Ignore <script>alert(1)</script>',
      recipientLabel: 'Mira <Chen>',
      title: 'A "careful" note',
    });

    const markdown = exportEditableDocument(document, 'markdown');
    const html = exportEditableDocument(document, 'html');

    expect(markdown).toMatchObject({
      content: document.markdown,
      filename: 'a-careful-note.md',
      mediaType: 'text/markdown',
      schemaVersion: 1,
    });
    expect(html.filename).toBe('a-careful-note.html');
    expect(html.content).toContain(
      'data-vidha-schema="vidha.editable-document@1"',
    );
    expect(html.content).toContain('<h2>First steps</h2>');
    expect(html.content).toContain('<strong>copies</strong>');
    expect(html.content).toContain('<ul><li>Call Mira</li>');
    expect(html.content).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html.content).not.toContain('<script>alert(1)</script>');
    expect(html.content).toContain('Mira &lt;Chen&gt;');
  });

  it('keeps the plain-text copy honest about its Markdown-compatible source', () => {
    const document = createEditableDocument({
      markdown: 'A **marked** line.',
      recipientLabel: 'Sam Rivera',
      title: 'Synthetic note',
    });

    expect(exportEditableDocument(document, 'text')).toMatchObject({
      content: 'A **marked** line.',
      filename: 'synthetic-note.txt',
      mediaType: 'text/plain',
    });
  });

  it('fails closed when a caller bypasses the portable format type', () => {
    const document = createEditableDocument({
      markdown: '<script>remains source text</script>',
      recipientLabel: 'Sam Rivera',
      title: 'Synthetic note',
    });

    expect(() =>
      exportEditableDocument(document, 'pdf' as PortableDocumentFormat),
    ).toThrow(EditableDocumentError);
  });

  it('round-trips a representative Markdown copy through reviewed intake', async () => {
    const original = createEditableDocument({
      markdown: '# Calls\n\n- Mira\n- Sam\n\nUse **copies**.',
      recipientLabel: 'Mira Chen',
      title: 'Call order',
    });
    const copy = exportEditableDocument(original, 'markdown');
    const intake = createImportIntake({
      converter: utf8TextConverter,
      inspectionPolicy: {
        acceptedIsolationProfiles: ['synthetic_fixture'],
        maxScanDurationMs: 1_000,
      },
      limits: { maxBytes: 4_096, maxLines: 100 },
      scanner: {
        async scan(source) {
          return {
            scannerId: 'synthetic-scanner',
            engineVersion: 'fixture-v1',
            signatureSetIdentity: `sha256-${'1'.repeat(64)}`,
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
    const prepared = await intake.prepare({
      bytes: new TextEncoder().encode(copy.content),
      declaredMediaType: copy.mediaType,
      filename: copy.filename,
    });
    const approved = await intake.approve(
      await intake.review(await intake.inspect(prepared)),
    );
    const roundTripped = createEditableDocument({
      markdown: approved.text,
      recipientLabel: original.recipientLabel,
      title: original.title,
    });

    expect(roundTripped).toEqual(original);
    expect(approved.originalBytes).toEqual(
      new TextEncoder().encode(original.markdown),
    );
  });

  it.each([
    '{',
    JSON.stringify({
      schema: EDITABLE_DOCUMENT_SCHEMA,
      schemaVersion: 2,
      title: 'Unknown version',
      recipientLabel: 'Synthetic recipient',
      markdown: '',
    }),
    JSON.stringify({
      schema: EDITABLE_DOCUMENT_SCHEMA,
      schemaVersion: 1,
      title: 'Unexpected field',
      recipientLabel: 'Synthetic recipient',
      markdown: '',
      hidden: true,
    }),
  ])('fails closed for malformed or unsupported schema input', (serialized) => {
    expect(() => parseEditableDocument(serialized)).toThrow(
      EditableDocumentError,
    );
  });

  it('rejects control characters and content beyond the schema bound', () => {
    expect(() =>
      createEditableDocument({
        markdown: 'bounded\u0000content',
        recipientLabel: 'Mira Chen',
        title: 'Synthetic note',
      }),
    ).toThrow(EditableDocumentError);
    expect(() =>
      createEditableDocument({
        markdown: 'x'.repeat(1_000_001),
        recipientLabel: 'Mira Chen',
        title: 'Synthetic note',
      }),
    ).toThrow(EditableDocumentError);
    expect(() =>
      createEditableDocument({
        markdown: 'bounded',
        recipientLabel: 'Mira Chen',
        title: 'Synthetic\u007fnote',
      }),
    ).toThrow(EditableDocumentError);
  });
});
