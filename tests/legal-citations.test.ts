import { describe, it, expect } from 'vitest';
import {
  buildCitations,
  renderRetrievedLaw,
  type LegalMatchRow,
} from '../supabase/functions/_shared/legal/citations.ts';

/**
 * Unit test for the pure citation mapping (SC-LC.D.01).
 *
 * No env, no DB, no LLM — asserts the deterministic contract D.02 renders and
 * the synthesizer grounds on: match rows → numbered citations[] (NotebookLM
 * click-to-line), and citations[] → the "[n]-numbered" prompt block.
 */

function row(over: Partial<LegalMatchRow>): LegalMatchRow {
  return {
    chunk_id: 'c0',
    doc_ref: 'ITAA 1997',
    section_ref: 's 8-1',
    heading: 'General deductions',
    text: 'You can deduct a loss or outgoing to the extent it is incurred in gaining assessable income.',
    citation_url: 'https://www.legislation.gov.au/C2004A05138',
    similarity: 0.9,
    ...over,
  };
}

describe('buildCitations', () => {
  it('maps rows to the citation contract, numbered [1..k] in retrieval order', () => {
    const cites = buildCitations([
      row({ chunk_id: 'a', section_ref: 's 8-1' }),
      row({ chunk_id: 'b', section_ref: 's 328-180', citation_url: null }),
    ]);
    expect(cites).toHaveLength(2);
    expect(cites[0]).toMatchObject({
      n: 1,
      doc_ref: 'ITAA 1997',
      section_ref: 's 8-1',
      chunk_id: 'a',
      citation_url: 'https://www.legislation.gov.au/C2004A05138',
    });
    expect(cites[0]?.quoted_text).toContain('You can deduct');
    // a null citation_url is preserved (the section_ref still anchors the cite)
    expect(cites[1]).toMatchObject({ n: 2, section_ref: 's 328-180', citation_url: null });
  });

  it('truncates a long chunk to a quote with an ellipsis; leaves a short one intact', () => {
    const long = 'x'.repeat(5000);
    const [c] = buildCitations([row({ text: long })]);
    expect(c?.quoted_text.length).toBeLessThanOrEqual(601); // 600 + the ellipsis
    expect(c?.quoted_text.endsWith('…')).toBe(true);

    const short = 'A short section.';
    const [d] = buildCitations([row({ text: `  ${short}  ` })]);
    expect(d?.quoted_text).toBe(short); // trimmed, no ellipsis
  });

  it('returns an empty array for no rows', () => {
    expect(buildCitations([])).toEqual([]);
  });
});

describe('renderRetrievedLaw', () => {
  it('renders an empty string when nothing was retrieved', () => {
    expect(renderRetrievedLaw([])).toBe('');
  });

  it('renders a [n]-numbered block whose markers line up with the citations', () => {
    const cites = buildCitations([
      row({ section_ref: 's 8-1', text: 'General deductions rule.' }),
      row({ section_ref: 's 25-10', text: 'Repairs deduction rule.' }),
    ]);
    const block = renderRetrievedLaw(cites);
    expect(block).toContain('[1] ITAA 1997 s 8-1: General deductions rule.');
    expect(block).toContain('[2] ITAA 1997 s 25-10: Repairs deduction rule.');
    // marker count == citation count (the model can't reference a non-existent [n])
    expect(block.match(/\[\d+\]/g)).toHaveLength(cites.length);
  });

  it('is deterministic', () => {
    const cites = buildCitations([row({}), row({ section_ref: 's 40-25' })]);
    expect(renderRetrievedLaw(cites)).toBe(renderRetrievedLaw(cites));
  });
});
