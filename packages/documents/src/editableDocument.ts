export const EDITABLE_DOCUMENT_SCHEMA = 'vidha.editable-document';
export const EDITABLE_DOCUMENT_SCHEMA_VERSION = 1 as const;

export type PortableDocumentFormat = 'html' | 'markdown' | 'text';

export interface EditableDocumentV1 {
  readonly schema: typeof EDITABLE_DOCUMENT_SCHEMA;
  readonly schemaVersion: typeof EDITABLE_DOCUMENT_SCHEMA_VERSION;
  readonly title: string;
  readonly recipientLabel: string;
  readonly markdown: string;
}

export interface PortableDocumentCopy {
  readonly content: string;
  readonly filename: string;
  readonly format: PortableDocumentFormat;
  readonly mediaType: 'text/html' | 'text/markdown' | 'text/plain';
  readonly schemaVersion: typeof EDITABLE_DOCUMENT_SCHEMA_VERSION;
}

export class EditableDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EditableDocumentError';
  }
}

const MAX_LABEL_LENGTH = 200;
const MAX_MARKDOWN_LENGTH = 1_000_000;

export function createEditableDocument(input: {
  readonly markdown: string;
  readonly recipientLabel: string;
  readonly title: string;
}): EditableDocumentV1 {
  return validateDocument({
    schema: EDITABLE_DOCUMENT_SCHEMA,
    schemaVersion: EDITABLE_DOCUMENT_SCHEMA_VERSION,
    title: normalizeLabel(input.title, 'title'),
    recipientLabel: normalizeLabel(input.recipientLabel, 'Recipient label'),
    markdown: normalizeMarkdown(input.markdown),
  });
}

export function serializeEditableDocument(
  document: EditableDocumentV1,
): string {
  const valid = validateDocument(document);
  return JSON.stringify({
    schema: valid.schema,
    schemaVersion: valid.schemaVersion,
    title: valid.title,
    recipientLabel: valid.recipientLabel,
    markdown: valid.markdown,
  });
}

export function parseEditableDocument(serialized: string): EditableDocumentV1 {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new EditableDocumentError(
      'The Editable Document is not valid canonical JSON.',
    );
  }
  return validateDocument(value);
}

export function exportEditableDocument(
  document: EditableDocumentV1,
  format: PortableDocumentFormat,
): PortableDocumentCopy {
  if (format !== 'markdown' && format !== 'text' && format !== 'html') {
    throw new EditableDocumentError(
      'The requested portable document format is unsupported.',
    );
  }
  const valid = validateDocument(document);
  const extension =
    format === 'markdown' ? 'md' : format === 'text' ? 'txt' : 'html';
  const mediaType =
    format === 'markdown'
      ? 'text/markdown'
      : format === 'text'
        ? 'text/plain'
        : 'text/html';
  return {
    content: format === 'html' ? renderPortableHtml(valid) : valid.markdown,
    filename: `${filenameStem(valid.title)}.${extension}`,
    format,
    mediaType,
    schemaVersion: EDITABLE_DOCUMENT_SCHEMA_VERSION,
  };
}

function validateDocument(value: unknown): EditableDocumentV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new EditableDocumentError(
      'The Editable Document must be a versioned object.',
    );
  }
  const candidate = value as Record<string, unknown>;
  const fields = Object.keys(candidate).sort();
  const expected = [
    'markdown',
    'recipientLabel',
    'schema',
    'schemaVersion',
    'title',
  ];
  if (
    fields.length !== expected.length ||
    fields.some((field, index) => field !== expected[index]) ||
    candidate.schema !== EDITABLE_DOCUMENT_SCHEMA ||
    candidate.schemaVersion !== EDITABLE_DOCUMENT_SCHEMA_VERSION ||
    typeof candidate.title !== 'string' ||
    typeof candidate.recipientLabel !== 'string' ||
    typeof candidate.markdown !== 'string'
  ) {
    throw new EditableDocumentError(
      'The Editable Document schema or version is unsupported.',
    );
  }
  const document = {
    schema: EDITABLE_DOCUMENT_SCHEMA,
    schemaVersion: EDITABLE_DOCUMENT_SCHEMA_VERSION,
    title: normalizeLabel(candidate.title, 'title'),
    recipientLabel: normalizeLabel(candidate.recipientLabel, 'Recipient label'),
    markdown: normalizeMarkdown(candidate.markdown),
  } satisfies EditableDocumentV1;
  return { ...document };
}

function normalizeLabel(value: string, label: string): string {
  const normalized = value.trim().replaceAll(/\s+/gu, ' ');
  if (
    normalized.length === 0 ||
    normalized.length > MAX_LABEL_LENGTH ||
    containsDisallowedControl(normalized)
  ) {
    throw new EditableDocumentError(
      `The Editable Document ${label} must be 1-${MAX_LABEL_LENGTH} visible characters.`,
    );
  }
  return normalized;
}

function normalizeMarkdown(value: string): string {
  const normalized = value.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  if (
    normalized.length > MAX_MARKDOWN_LENGTH ||
    containsDisallowedControl(normalized)
  ) {
    throw new EditableDocumentError(
      `Editable Document Markdown must be at most ${MAX_MARKDOWN_LENGTH} characters and contain no control bytes.`,
    );
  }
  return normalized;
}

function containsDisallowedControl(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      (codePoint < 32 && codePoint !== 9 && codePoint !== 10) ||
      codePoint === 127
    );
  });
}

function filenameStem(title: string): string {
  return (
    title
      .toLowerCase()
      .normalize('NFKD')
      .replaceAll(/[\u0300-\u036f]/gu, '')
      .replaceAll(/[^a-z0-9]+/gu, '-')
      .replaceAll(/^-|-$/gu, '') || 'vidha-draft'
  );
}

function renderPortableHtml(document: EditableDocumentV1): string {
  const body = renderMarkdownBody(document.markdown);
  const title = escapeHtml(document.title);
  const recipient = escapeHtml(document.recipientLabel);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title}</title>
    <style>
      :root { color-scheme: light dark; font-family: ui-serif, Georgia, serif; line-height: 1.65; }
      body { margin: 0 auto; max-width: 48rem; padding: 3rem 1.5rem; }
      header { border-bottom: 1px solid currentColor; margin-bottom: 2rem; padding-bottom: 1rem; }
      h1 { font-size: clamp(2rem, 6vw, 3.5rem); line-height: 1.05; margin: 0 0 0.75rem; }
      h2, h3, h4 { line-height: 1.2; margin-top: 1.8em; }
      p, ul { margin: 0 0 1em; }
      li + li { margin-top: 0.35em; }
    </style>
  </head>
  <body>
    <header>
      <h1>${title}</h1>
      <p>Prepared for ${recipient}</p>
    </header>
    <main data-vidha-schema="${EDITABLE_DOCUMENT_SCHEMA}@${EDITABLE_DOCUMENT_SCHEMA_VERSION}">${body}</main>
  </body>
</html>
`;
}

function renderMarkdownBody(markdown: string): string {
  const output: string[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    output.push(`<p>${paragraph.map(renderInline).join('<br>')}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list.length === 0) return;
    output.push(
      `<ul>${list.map((item) => `<li>${renderInline(item)}</li>`).join('')}</ul>`,
    );
    list = [];
  };

  for (const line of markdown.split('\n')) {
    const heading = line.match(/^(#{1,3})\s+(.+)$/u);
    const item = line.match(/^[-*]\s+(.+)$/u);
    if (heading !== null) {
      flushParagraph();
      flushList();
      const level = (heading[1]?.length ?? 1) + 1;
      output.push(`<h${level}>${renderInline(heading[2] ?? '')}</h${level}>`);
    } else if (item !== null) {
      flushParagraph();
      list.push(item[1] ?? '');
    } else if (line.trim().length === 0) {
      flushParagraph();
      flushList();
    } else {
      flushList();
      paragraph.push(line);
    }
  }
  flushParagraph();
  flushList();
  return output.join('\n');
}

function renderInline(value: string): string {
  const tokens = value.split(/(\*\*[^*\n]+\*\*|_[^_\n]+_)/gu);
  return tokens
    .map((token) => {
      if (token.startsWith('**') && token.endsWith('**')) {
        return `<strong>${escapeHtml(token.slice(2, -2))}</strong>`;
      }
      if (token.startsWith('_') && token.endsWith('_')) {
        return `<em>${escapeHtml(token.slice(1, -1))}</em>`;
      }
      return escapeHtml(token);
    })
    .join('');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
