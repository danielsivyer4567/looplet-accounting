/**
 * citations.ts — pure mapping from match_legal_corpus rows (SC-LC.B.01) to the
 * cited-answer contract the Ask surface renders (SC-LC.D.01/D.02).
 *
 * Two pure, deterministic, dependency-free functions so the citation shape and
 * the prompt-grounding block are unit-testable without an LLM, a DB, or secrets:
 *   - buildCitations()    — RPC rows → the `citations[]` payload the response returns
 *   - renderRetrievedLaw() — that payload → the "[n]-numbered" block injected into
 *                            the synthesizer prompt, so the model grounds legal
 *                            claims in real corpus text via markers that line up
 *                            with the returned citations (NotebookLM click-to-line).
 */

/** A row as match_legal_corpus returns it (the columns this layer consumes). */
export interface LegalMatchRow {
  chunk_id: string;
  doc_ref: string;
  section_ref: string;
  heading: string | null;
  text: string;
  citation_url: string | null;
  similarity: number;
}

/** The citation shape returned to the client + rendered as a click-to-line marker. */
export interface LegalCitation {
  n: number;
  doc_ref: string;
  section_ref: string;
  quoted_text: string;
  citation_url: string | null;
  chunk_id: string;
}

// Chars of the chunk surfaced as the click-to-the-line quote. A whole section can
// be long; the panel shows the quote, the citation_url links to the full text.
const QUOTE_MAX = 600;

function quote(text: string): string {
  const t = text.trim();
  return t.length <= QUOTE_MAX ? t : `${t.slice(0, QUOTE_MAX).trimEnd()}…`;
}

/**
 * Map retrieved rows to the citation payload, numbered [1..k] in retrieval order
 * (match_legal_corpus already returns them most-relevant-first).
 */
export function buildCitations(rows: LegalMatchRow[]): LegalCitation[] {
  return rows.map((r, i) => ({
    n: i + 1,
    doc_ref: r.doc_ref,
    section_ref: r.section_ref,
    quoted_text: quote(r.text),
    citation_url: r.citation_url,
    chunk_id: r.chunk_id,
  }));
}

/**
 * The RETRIEVED AU LAW block for the synthesizer prompt. Each item is tagged [n]
 * to match the returned citations[], so a [n] the model writes resolves to a real
 * corpus section. Empty string when nothing was retrieved — the caller then tells
 * the model it has no corpus to cite, so any legal claim must be flagged.
 */
export function renderRetrievedLaw(citations: LegalCitation[]): string {
  if (citations.length === 0) return '';
  const items = citations.map((c) => `[${c.n}] ${c.doc_ref} ${c.section_ref}: ${c.quoted_text}`);
  return `=== RETRIEVED AU LAW (verbatim corpus — cite these as [n]) ===\n${items.join('\n\n')}`;
}
