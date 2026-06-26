/**
 * Tests for src/components/Citations.tsx (SC-LC.D.02).
 *
 * CitedAnswer is a pure presentational component — no Supabase / router / org
 * context — so these render it directly and assert the NotebookLM-style cited-law
 * behaviour: inline [n] superscripts open a panel with the cited section's quoted
 * text + a source link; "(model assertion — verify)" renders as a distinct chip;
 * and with no corpus the markers fall back to Sonar source links.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CitedAnswer, type LegalCitation } from '@/components/Citations';

const CITATIONS: LegalCitation[] = [
  {
    n: 1,
    doc_ref: 'ITAA 1997',
    section_ref: 's 8-1',
    quoted_text: 'You can deduct a loss or outgoing incurred in gaining your assessable income.',
    citation_url: 'https://www.legislation.gov.au/C2004A05138#s8-1',
    chunk_id: 'c1',
  },
  {
    n: 2,
    doc_ref: 'ITAA 1997',
    section_ref: 's 25-10',
    quoted_text: 'You can deduct the cost of repairs to premises held for producing income.',
    citation_url: 'https://www.legislation.gov.au/C2004A05138#s25-10',
    chunk_id: 'c2',
  },
];

describe('CitedAnswer', () => {
  it('renders inline corpus markers and opens the quote panel on click (click-to-the-line)', () => {
    render(
      <CitedAnswer
        answer="**Yes.** You can deduct it under [1]; repairs fall under [2]."
        citations={CITATIONS}
        sonarCitations={[]}
      />,
    );

    // the bold direct answer + the cited-law panel listing both sections
    expect(screen.getByText('Yes.')).toBeInTheDocument();
    expect(screen.getByText(/Cited law \(2\)/)).toBeInTheDocument();

    // the quoted section text is hidden until a marker is clicked
    expect(screen.queryByText(/You can deduct a loss or outgoing/)).not.toBeInTheDocument();

    // click the inline [1] superscript → the exact section text + a source link appear
    fireEvent.click(screen.getByTitle('Show cited section [1]'));
    expect(screen.getByText(/You can deduct a loss or outgoing/)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /View the section/ });
    expect(link).toHaveAttribute('href', CITATIONS[0]?.citation_url);
  });

  it('flags an uncited legal claim as a distinct "model assertion — verify" chip', () => {
    render(
      <CitedAnswer
        answer="The withholding rate is 15% (model assertion — verify)."
        citations={[]}
        sonarCitations={[]}
      />,
    );
    const chip = screen.getByText('model assertion — verify');
    expect(chip).toBeInTheDocument();
    // the chip carries the warning explanation, marking it as NOT settled cited law
    expect(chip.getAttribute('title')).toContain('NOT backed by a retrieved law section');
  });

  it('falls back to Sonar source links when no corpus was retrieved', () => {
    render(
      <CitedAnswer
        answer="See the ATO guidance [1]."
        citations={[]}
        sonarCitations={['https://ato.gov.au/guidance']}
      />,
    );
    // no NotebookLM cited-law panel without corpus citations
    expect(screen.queryByText(/Cited law/)).not.toBeInTheDocument();
    // [1] is a direct external link to the Sonar source (pre-corpus behaviour)
    expect(screen.getByRole('link', { name: '1' })).toHaveAttribute(
      'href',
      'https://ato.gov.au/guidance',
    );
  });

  it('renders a plain data answer with no markers and no panel', () => {
    render(<CitedAnswer answer="You have 12 unpaid bills." citations={[]} sonarCitations={[]} />);
    expect(screen.getByText('You have 12 unpaid bills.')).toBeInTheDocument();
    expect(screen.queryByText(/Cited law/)).not.toBeInTheDocument();
  });
});
