import { describe, it, expect } from 'vitest';
import { chunkLegalText, type LegalChunk } from '../supabase/functions/_shared/legal/chunk.ts';

/**
 * Unit test for the pure section-chunker (SC-LC.C.01).
 *
 * No env, no DB, no network — it asserts the deterministic chunking of
 * FRL-shaped AU tax-law text: heading boundaries land on real section starts
 * (never mid-sentence), pinpoints normalise to AGLC-ish `section_ref`s, stray
 * page-break artefacts are merged away, and header-less docs fall back to
 * paragraph chunks. Runs under vitest's Node environment like the rest of
 * tests/, but unlike the integration suites it needs nothing external.
 */

// Build a heading line with the FRL "number + gap + title" shape. Default gap
// is two spaces; pass a tab to exercise the tab branch.
function head(num: string, title: string, gap = '  '): string {
  return `${num}${gap}${title}`;
}

function refs(chunks: LegalChunk[]): string[] {
  return chunks.map((c) => c.section_ref);
}

function byRef(chunks: LegalChunk[], ref: string): LegalChunk {
  const found = chunks.find((c) => c.section_ref === ref);
  if (!found) throw new Error(`no chunk with section_ref ${ref}; got ${refs(chunks).join(', ')}`);
  return found;
}

describe('chunkLegalText — ITAA 1997 hyphenated sections', () => {
  // A bare "Division 8" container, two hyphenated sections, a tab-gap section,
  // and — crucially — two FRL page-break artefacts ("Authorised Version…" and a
  // bare page number "125") wedged BETWEEN paragraph (a) and (b) of s 8-1.
  const SAMPLE = [
    'Division 8—Deductions',
    '',
    head('8-1', 'General deductions'),
    '   (1)  You can deduct from your assessable income any loss or outgoing to the extent that:',
    '       (a)  it is incurred in gaining or producing your assessable income; or',
    'Authorised Version C2023C00282 registered 30/06/2023',
    '125',
    '       (b)  it is necessarily incurred in carrying on a *business for that purpose.',
    '   (2)  However, you cannot deduct a loss or outgoing to the extent it is capital.',
    '',
    head('8-5', 'Specific deductions'),
    '   (1)  You can also deduct an amount that another provision of this Act allows.',
    '',
    head('40-25', 'Deducting amounts for depreciating assets', '\t'),
    '   (1)  You can deduct the decline in value of a depreciating asset you held.',
  ].join('\n');

  const opts = { doc_ref: 'ITAA 1997' };

  it('emits exactly the operative sections in order; drops the bare division container', () => {
    expect(refs(chunkLegalText(SAMPLE, opts))).toEqual(['s 8-1', 's 8-5', 's 40-25']);
  });

  it('extracts the heading title separately from the pinpoint', () => {
    const chunks = chunkLegalText(SAMPLE, opts);
    expect(byRef(chunks, 's 8-1').heading).toBe('General deductions');
    expect(byRef(chunks, 's 8-5').heading).toBe('Specific deductions');
    expect(byRef(chunks, 's 40-25').heading).toBe('Deducting amounts for depreciating assets');
  });

  it('merges stray page-break artefacts so the section reads continuously', () => {
    const s81 = byRef(chunkLegalText(SAMPLE, opts), 's 8-1');
    // Both paragraphs survive, contiguous — the boundary did NOT split here.
    expect(s81.text).toContain('(a)  it is incurred in gaining');
    expect(s81.text).toContain('(b)  it is necessarily incurred');
    // …and the artefacts that interrupted them are gone.
    expect(s81.text).not.toContain('Authorised Version');
    expect(s81.text).not.toMatch(/^125$/m);
    // The boundary lands on the next real section start, not earlier.
    expect(s81.text).not.toContain('Specific deductions');
  });

  it('tags every chunk with the caller-supplied doc_ref', () => {
    for (const c of chunkLegalText(SAMPLE, opts)) expect(c.doc_ref).toBe('ITAA 1997');
  });

  it('is deterministic — same input yields identical chunks', () => {
    expect(chunkLegalText(SAMPLE, opts)).toEqual(chunkLegalText(SAMPLE, opts));
  });
});

describe('chunkLegalText — pinpoint forms', () => {
  it('parses an "s "-prefixed hyphenated heading (328-180)', () => {
    const raw = [
      head('s 328-180', 'Concessions for small business entities'),
      '   A small business entity can choose to use the simplified depreciation rules.',
    ].join('\n');
    const chunks = chunkLegalText(raw, { doc_ref: 'ITAA 1997' });
    expect(refs(chunks)).toEqual(['s 328-180']);
    expect(byRef(chunks, 's 328-180').heading).toBe('Concessions for small business entities');
  });

  it('parses a Division header into a div pinpoint and keeps it when it has guide text', () => {
    const raw = [
      'Part III—Liability to taxation',
      '',
      'Division 7A—Distributions to entities connected with a private company',
      '',
      'This Division treats certain payments and loans by private companies as assessable dividends.',
      '',
      head('109', 'Distributions treated as dividends'),
      '   A private company is taken to pay a dividend to an entity at the end of the year.',
      '',
      head('109B', 'Trustee payments and loans'),
      '   This section applies if a trustee makes a payment or loan to a shareholder.',
    ].join('\n');
    const chunks = chunkLegalText(raw, { doc_ref: 'ITAA 1936' });
    // pt III is a bare container → dropped; div 7A carries guide text → kept.
    expect(refs(chunks)).toEqual(['div 7A', 's 109', 's 109B']);
    expect(byRef(chunks, 'div 7A').heading).toBe(
      'Distributions to entities connected with a private company',
    );
    const s109 = byRef(chunks, 's 109');
    expect(s109.text).toContain('A private company is taken to pay a dividend');
    // The division line was recognised as a boundary, not folded into s 109.
    expect(s109.text).not.toContain('Division 7A');
  });

  it('disambiguates repeated structural pinpoints within one instrument', () => {
    const raw = [
      'Part II—First part',
      '',
      'Division 1—Guide to the first part',
      'This guide applies to the first part.',
      '',
      'Part III—Second part',
      '',
      'Division 1—Guide to the second part',
      'This guide applies to the second part.',
    ].join('\n');

    const chunks = chunkLegalText(raw, { doc_ref: 'FBTAA' });

    expect(refs(chunks)).toEqual(['div 1', 'div 1 #2']);
    expect(byRef(chunks, 'div 1').text).toContain('first part');
    expect(byRef(chunks, 'div 1 #2').text).toContain('second part');
  });
});

describe('chunkLegalText — false-positive guards', () => {
  it('does not treat a number-led date line as a section heading', () => {
    const raw = [
      head('6', 'Interpretation'),
      '   In this Act, unless the contrary intention appears:',
      // A line that has the heading SHAPE (number + 2-space gap + capitalised
      // text) but is a date — must fall through to body, not start "s 5".
      head('5', 'June 2021 was the relevant lodgment date for the scheme'),
    ].join('\n');
    const chunks = chunkLegalText(raw, { doc_ref: 'ITAA 1936' });
    expect(refs(chunks)).toEqual(['s 6']);
    expect(byRef(chunks, 's 6').text).toContain('June 2021 was the relevant lodgment date');
  });
});

describe('chunkLegalText — embedding bounds', () => {
  it('splits oversized sections into deterministic part anchors', () => {
    const longParagraphs = Array.from(
      { length: 8 },
      (_, i) => `Paragraph ${i + 1}: ${'deductible fringe benefit wording '.repeat(90)}`,
    );
    const raw = [head('136', 'Interpretation'), ...longParagraphs].join('\n\n');

    const chunks = chunkLegalText(raw, { doc_ref: 'FBTAA' });

    expect(chunks.length).toBeGreaterThan(1);
    expect(refs(chunks)).toEqual(chunks.map((_, i) => `s 136 [${i + 1}]`));
    expect(chunks.every((chunk) => chunk.text.length <= 6000)).toBe(true);
    expect(chunks.every((chunk) => chunk.heading.startsWith('Interpretation'))).toBe(true);
    expect(chunkLegalText(raw, { doc_ref: 'FBTAA' })).toEqual(chunks);
  });
});

describe('chunkLegalText — header-less fallback (cases / rulings)', () => {
  const CASE = [
    'Federal Commissioner of Taxation v Myer Emporium Ltd (1987) 163 CLR 199',
    '',
    'The High Court held that a profit made on an isolated transaction can be income',
    'according to ordinary concepts if the taxpayer entered it with a profit-making intention.',
    '',
    'The decision established two strands by which an isolated transaction gives rise to income.',
  ].join('\n');
  const opts = { doc_ref: 'Myer Emporium (1987) 163 CLR 199' };

  it('falls back to sequential paragraph chunks when no headings are present', () => {
    const chunks = chunkLegalText(CASE, opts);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks[0]?.section_ref).toBe('[1]');
    expect(chunks[0]?.text).toContain('The High Court held');
    expect(chunks.every((c) => c.doc_ref === opts.doc_ref)).toBe(true);
  });

  it('is deterministic in the fallback path too', () => {
    expect(chunkLegalText(CASE, opts)).toEqual(chunkLegalText(CASE, opts));
  });

  it('returns no chunks for empty or whitespace-only input', () => {
    expect(chunkLegalText('', opts)).toEqual([]);
    expect(chunkLegalText('   \n\n  \n', opts)).toEqual([]);
  });
});
