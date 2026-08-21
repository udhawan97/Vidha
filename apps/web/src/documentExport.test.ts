import { describe, expect, it } from 'vitest';

import { buildPortableHtml, exportFilename } from './documentExport';

describe('document exports', () => {
  it('creates stable filenames for each portable format', () => {
    expect(exportFilename('  A Home & A Plan  ', 'md')).toBe(
      'a-home-a-plan.md',
    );
    expect(exportFilename('***', 'html')).toBe('vidha-draft.html');
  });

  it('escapes imported markup in the standalone HTML copy', () => {
    const html = buildPortableHtml({
      body: '<script>alert("unsafe")</script> & still text',
      recipient: 'Mira <Chen>',
      title: 'A "careful" note',
    });

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(&quot;unsafe&quot;)');
    expect(html).toContain('Mira &lt;Chen&gt;');
    expect(html).toContain('<meta name="viewport"');
  });
});
