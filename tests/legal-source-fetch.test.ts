import { describe, expect, it } from 'vitest';
import {
  fetchLegalSourceText,
  htmlToPlainLegalText,
  type FetchLike,
  type LegalSourceFetchRow,
} from '../supabase/functions/_shared/legal/sourceFetch.ts';
import { chunkLegalText } from '../supabase/functions/_shared/legal/chunk.ts';

const FRL_SOURCE: LegalSourceFetchRow = {
  name: 'Income Tax Assessment Act 1997',
  kind: 'act',
  canonical_url: 'https://www.legislation.gov.au/C2004A05138',
  check_method: 'frl_api',
};

function html(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

describe('legal source fetching', () => {
  it('resolves FRL latest text EPUB documents and extracts chunkable plain text', async () => {
    const calls: string[] = [];
    const fakeFetch: FetchLike = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url === 'https://www.legislation.gov.au/C2004A05138/latest/text') {
        return html(`
          <html>
            <body>
              <span class="item-id small fw-bold">C2026C00218 C264</span>
              <span class="date-effective-start">21 May 2026</span>
              <a href="https://www.legislation.gov.au/C2004A05138/2026-05-21/2026-05-21/text/original/epub/OEBPS/document_2/document_2.html#x">part 2</a>
              <a href="https://www.legislation.gov.au/C2004A05138/2026-05-21/2026-05-21/text/original/epub/OEBPS/document_1/document_1.html#x">part 1</a>
              <a href="https://www.legislation.gov.au/C2004A05138/2026-05-21/2026-05-21/text/original/epub/OEBPS/document_1/document_1.html#duplicate">part 1 duplicate</a>
            </body>
          </html>
        `);
      }
      if (url.endsWith('/document_1/document_1.html')) {
        return html(`
          <html>
            <head><script>window.rawMarkup = true;</script></head>
            <body>
              <p class="TofSectsHeading"><span>Table of sections</span></p>
              <p class="TofSectsSection"><span>8</span><span>&#x2011;</span><span>1</span><span>&#xa0; </span><span>General deductions</span></p>
              <p class="ActHead5"><span>8</span><span>&#x2011;</span><span>1</span><span>&#xa0; </span><span>General deductions</span></p>
              <p class="subsection"><span>(1)</span><span>&#xa0; </span><span>You can deduct from your assessable income any loss or outgoing.</span></p>
            </body>
          </html>
        `);
      }
      if (url.endsWith('/document_2/document_2.html')) {
        return html(`
          <html>
            <body>
              <p class="ActHead5"><span>8</span><span>&#x2011;</span><span>5</span><span>&#xa0; </span><span>Specific deductions</span></p>
              <p><span>Summary text for specific deductions.</span></p>
            </body>
          </html>
        `);
      }
      return new Response('not found', { status: 404 });
    };

    const result = await fetchLegalSourceText(FRL_SOURCE, fakeFetch);

    expect(calls).toEqual([
      'https://www.legislation.gov.au/C2004A05138/latest/text',
      'https://www.legislation.gov.au/C2004A05138/2026-05-21/2026-05-21/text/original/epub/OEBPS/document_1/document_1.html',
      'https://www.legislation.gov.au/C2004A05138/2026-05-21/2026-05-21/text/original/epub/OEBPS/document_2/document_2.html',
    ]);
    expect(result.effective_from).toBe('2026-05-21');
    expect(result.version_ref).toBe('C2026C00218 C264');
    expect(result.citation_url).toBe('https://www.legislation.gov.au/C2004A05138/latest/text');
    expect(result.text).toContain('8-1  General deductions');
    expect(result.text).toContain('8-5  Specific deductions');
    expect(result.text).not.toContain('Table of sections');
    expect(result.text).not.toContain('<script>');

    const chunks = chunkLegalText(result.text, { doc_ref: FRL_SOURCE.name });
    expect(chunks.map((chunk) => chunk.section_ref)).toEqual(['s 8-1', 's 8-5']);
  });

  it('converts generic HTML to text without scripts, styles, or tags', () => {
    const text = htmlToPlainLegalText(`
      <html>
        <head><style>.x { color: red; }</style></head>
        <body>
          <main>
            <h1>Taxation ruling</h1>
            <p>Paragraph&nbsp;one<br>line two.</p>
            <script>alert("noise")</script>
          </main>
        </body>
      </html>
    `);

    expect(text).toBe(['Taxation ruling', '', 'Paragraph one', 'line two.'].join('\n'));
  });

  it('refuses the generic ATO legal database landing page', async () => {
    const source: LegalSourceFetchRow = {
      name: 'ATO Legal Database (rulings & determinations)',
      kind: 'ato_ruling',
      canonical_url: 'https://www.ato.gov.au/law/',
      check_method: 'ato_feed',
    };

    await expect(fetchLegalSourceText(source, async () => html('<html></html>'))).rejects.toThrow(
      /search surface/,
    );
  });
});
