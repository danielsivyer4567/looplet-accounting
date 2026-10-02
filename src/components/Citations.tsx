import { useState, type CSSProperties, type ReactNode } from 'react';
import { ScrollText, ExternalLink } from 'lucide-react';

/**
 * Citations.tsx — NotebookLM-style cited-law rendering for Ask answers (SC-LC.D.02).
 *
 * Consumes the additive `citations[]` the cited ask-bot returns (SC-LC.D.01).
 * The answer text carries inline [n] markers; when corpus citations are present
 * each marker is a clickable superscript that opens a panel showing that exact
 * section's quoted text + a link to the source ("click to the line"). When no
 * corpus was retrieved it falls back to ask-bot's pre-corpus behaviour — [n]
 * markers link straight to the Sonar source URL. An uncited legal claim the
 * model flagged "(model assertion — verify)" is rendered as a distinct warning
 * chip so it never reads like settled, cited law.
 */

export interface LegalCitation {
  n: number;
  doc_ref: string;
  section_ref: string;
  quoted_text: string;
  citation_url: string | null;
  chunk_id: string;
}

// Split the answer into text / [n] marker / model-assertion flag / **bold** tokens
// in one pass; the per-token regexes below (no /g) classify each captured piece.
const TOKEN_RE = /(\[\d+\]|\(model assertion\s*[—-]\s*verify\)|\*\*[^*]+\*\*)/gi;
const MARKER_RE = /^\[(\d+)\]$/;
// Prose contract with the D.01 synthesizer, which is prompted to append this exact
// phrase to any legal claim it could NOT ground in a retrieved section. (A future
// hardening carries this as a structured response flag instead of prose — see ledger.)
const ASSERTION_RE = /^\(model assertion\s*[—-]\s*verify\)$/i;
const BOLD_RE = /^\*\*([^*]+)\*\*$/;

// Shared superscript-marker styling; the corpus button and Sonar link differ only
// in tag + active/colour, so they spread this base to avoid drift.
const MARKER_STYLE: CSSProperties = {
  fontSize: '0.72rem',
  verticalAlign: 'super',
  lineHeight: 1,
  padding: '1px 5px',
  border: '1px solid var(--border-subtle)',
  borderRadius: '3px',
  marginLeft: '2px',
  fontWeight: 700,
};

export function CitedAnswer({
  answer,
  citations,
  sonarCitations,
}: {
  answer: string;
  citations: LegalCitation[];
  sonarCitations: string[];
}) {
  const [active, setActive] = useState<number | null>(null);
  const hasCorpus = citations.length > 0;
  const byN = new Map(citations.map((c) => [c.n, c]));
  const toggle = (n: number) => setActive((cur) => (cur === n ? null : n));

  // Classify one split token → its rendered node. The backend guarantees only ONE of
  // {corpus, Sonar} populates the [n] space per answer (D.01 demotes Sonar markers when
  // corpus is present), so the hasCorpus branch is an exclusive switch, not a merge.
  const renderPart = (part: string, i: number): ReactNode => {
    if (!part) return null;

    const marker = MARKER_RE.exec(part);
    if (marker?.[1]) {
      const n = parseInt(marker[1], 10);
      if (hasCorpus) {
        return byN.has(n) ? (
          <CitationMarker key={i} n={n} active={active === n} onClick={() => toggle(n)} />
        ) : (
          <sup key={i} style={{ color: 'var(--text-muted)' }}>
            {part}
          </sup>
        );
      }
      const url = sonarCitations[n - 1];
      return url ? (
        <SonarMarker key={i} n={n} url={url} />
      ) : (
        <sup key={i} style={{ color: 'var(--text-muted)' }}>
          {part}
        </sup>
      );
    }

    if (ASSERTION_RE.test(part)) return <ModelAssertionChip key={i} />;

    const bold = BOLD_RE.exec(part);
    if (bold?.[1])
      return (
        <strong key={i} style={{ color: 'var(--text-title)', fontWeight: 700 }}>
          {bold[1]}
        </strong>
      );

    return <span key={i}>{part}</span>;
  };

  return (
    <>
      <div style={{ color: 'var(--text-body)', whiteSpace: 'pre-wrap' }}>
        {answer.split(TOKEN_RE).map(renderPart)}
      </div>
      {hasCorpus && <CitedLawPanel citations={citations} active={active} onSelect={toggle} />}
    </>
  );
}

function CitationMarker({
  n,
  active,
  onClick,
}: {
  n: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={`Show cited section [${n}]`}
      style={{
        ...MARKER_STYLE,
        color: active ? '#fff' : 'var(--accent-info)',
        background: active ? 'var(--accent-info)' : 'var(--bg-hover)',
        cursor: 'pointer',
      }}
    >
      {n}
    </button>
  );
}

function SonarMarker({ n, url }: { n: number; url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={url}
      style={{
        ...MARKER_STYLE,
        color: 'var(--accent-info)',
        background: 'var(--bg-hover)',
        textDecoration: 'none',
      }}
    >
      {n}
    </a>
  );
}

function ModelAssertionChip() {
  return (
    <span
      title="This legal claim is the model's assertion — it is NOT backed by a retrieved law section. Verify it before relying on it."
      style={{
        fontSize: '0.68rem',
        fontWeight: 700,
        color: 'var(--text-warning)',
        background: 'color-mix(in srgb, var(--accent-warning) 16%, transparent)',
        border: '1px dashed var(--accent-warning)',
        borderRadius: '4px',
        padding: '0 0.35rem',
        margin: '0 0.15rem',
        textTransform: 'uppercase',
        letterSpacing: '0.03em',
        whiteSpace: 'nowrap',
      }}
    >
      model assertion — verify
    </span>
  );
}

function CitedLawPanel({
  citations,
  active,
  onSelect,
}: {
  citations: LegalCitation[];
  active: number | null;
  onSelect: (n: number) => void;
}) {
  const activeCite = active != null ? (citations.find((c) => c.n === active) ?? null) : null;
  return (
    <div
      style={{
        marginTop: '1.5rem',
        padding: '1rem',
        background: 'var(--bg-app)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-md)',
      }}
    >
      <div
        style={{
          fontSize: '0.75rem',
          fontWeight: 700,
          color: 'var(--accent-info)',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          marginBottom: '0.6rem',
          display: 'flex',
          alignItems: 'center',
          gap: '0.35rem',
        }}
      >
        <ScrollText size={13} /> Cited law ({citations.length})
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
        {citations.map((c) => (
          <button
            key={c.chunk_id}
            type="button"
            onClick={() => onSelect(c.n)}
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: '0.5rem',
              textAlign: 'left',
              padding: '0.35rem 0.5rem',
              fontSize: '0.8rem',
              color: 'var(--text-body)',
              background: active === c.n ? 'var(--bg-hover)' : 'transparent',
              border: `1px solid ${active === c.n ? 'var(--accent-info)' : 'transparent'}`,
              borderRadius: 'var(--radius-sm)',
              cursor: 'pointer',
            }}
          >
            <span style={{ color: 'var(--accent-info)', fontWeight: 700 }}>[{c.n}]</span>
            <span>
              {c.doc_ref} <strong style={{ color: 'var(--text-title)' }}>{c.section_ref}</strong>
            </span>
          </button>
        ))}
      </div>

      {activeCite && (
        <div style={{ marginTop: '0.75rem' }}>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '0.3rem' }}>
            {activeCite.doc_ref} · {activeCite.section_ref}
          </div>
          <blockquote
            style={{
              margin: 0,
              padding: '0.6rem 0.85rem',
              borderLeft: '3px solid var(--accent-info)',
              background: 'var(--bg-card)',
              borderRadius: '0 var(--radius-sm) var(--radius-sm) 0',
              color: 'var(--text-body)',
              fontSize: '0.83rem',
              lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
            }}
          >
            {activeCite.quoted_text}
          </blockquote>
          {activeCite.citation_url && (
            <a
              href={activeCite.citation_url}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.3rem',
                marginTop: '0.5rem',
                fontSize: '0.78rem',
                color: 'var(--text-link)',
                textDecoration: 'none',
              }}
            >
              <ExternalLink size={12} /> View the section on the source
            </a>
          )}
        </div>
      )}
    </div>
  );
}
