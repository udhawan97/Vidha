import type { DemoEnvelope } from './demo';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function filenameStem(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'vidha-draft'
  );
}

export function exportFilename(
  title: string,
  extension: 'html' | 'md' | 'txt',
): string {
  return `${filenameStem(title)}.${extension}`;
}

export function buildPortableHtml(
  envelope: Pick<DemoEnvelope, 'body' | 'recipient' | 'title'>,
): string {
  const title = escapeHtml(envelope.title);
  const recipient = escapeHtml(envelope.recipient);
  const body = escapeHtml(envelope.body);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title}</title>
    <style>
      :root { color-scheme: light dark; font-family: ui-serif, Georgia, serif; line-height: 1.6; }
      body { margin: 0 auto; max-width: 48rem; padding: 3rem 1.5rem; }
      header { border-bottom: 1px solid currentColor; margin-bottom: 2rem; padding-bottom: 1rem; }
      h1 { font-size: clamp(2rem, 6vw, 3.5rem); line-height: 1.05; margin: 0 0 0.75rem; }
      p { margin: 0; }
      pre { font: inherit; margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
    </style>
  </head>
  <body>
    <header>
      <h1>${title}</h1>
      <p>Prepared for ${recipient}</p>
    </header>
    <main><pre>${body}</pre></main>
  </body>
</html>
`;
}
