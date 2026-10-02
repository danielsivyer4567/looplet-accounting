import {
  useLegalHorizon,
  type LegalHorizonRow,
  type LegalChangeStage,
} from '@/hooks/useLegalHorizon';
import { SkeletonCard } from '@/components/Skeleton';
import { CalendarClock, RefreshCw } from 'lucide-react';

const MUTED = 'var(--text-muted, #6b7280)';

// The legislative lifecycle, rendered for humans. Open items can sit at any stage
// (an 'enacted' open item = law just landed, not yet reconciled to the corpus).
const STAGE_LABELS: Record<LegalChangeStage, string> = {
  announced: 'Announced',
  exposure_draft: 'Exposure draft',
  before_parliament: 'Before Parliament',
  passed_pending_assent: 'Passed — awaiting assent',
  enacted: 'Enacted (very recent)',
  abandoned: 'Abandoned',
};

function ErrorBadge({ message }: { message: string }) {
  return (
    <div
      className="badge badge-danger"
      style={{ display: 'block', padding: '0.75rem', textTransform: 'none', marginTop: '0.5rem' }}
    >
      {message}
    </div>
  );
}

function formatDate(d: string | null): string {
  if (!d) return 'Effective date TBC';
  const parsed = new Date(d);
  return Number.isNaN(parsed.getTime())
    ? 'Effective date TBC'
    : parsed.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}

function HorizonCard({ item }: { item: LegalHorizonRow }) {
  const pct = Math.round(item.confidence * 100);
  const lowConfidence = item.confidence < 0.5;
  return (
    <div className="card" style={{ padding: '1rem', marginBottom: '0.75rem' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          gap: '1rem',
          alignItems: 'flex-start',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap' }}>
          {/* The forward-looking guard: this is a proposal, NOT settled law. */}
          <span className="badge badge-warning">Proposed · not yet law</span>
          <span
            style={{
              fontSize: '0.7rem',
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
              padding: '2px 8px',
              borderRadius: 'var(--radius-sm, 6px)',
              background: 'var(--bg-hover, var(--bg-hover))',
              color: 'var(--text-body, var(--text-body))',
            }}
          >
            {STAGE_LABELS[item.stage]}
          </span>
        </div>
        <div style={{ fontSize: '0.8rem', color: MUTED, whiteSpace: 'nowrap' }}>
          Proposed effect: {formatDate(item.proposed_effective_from)}
        </div>
      </div>

      <div style={{ fontWeight: 600, marginTop: '0.6rem' }}>{item.title}</div>
      {item.topic && (
        <div style={{ fontSize: '0.75rem', color: MUTED, marginTop: '0.15rem' }}>{item.topic}</div>
      )}
      {item.summary && (
        <p style={{ fontSize: '0.9rem', marginTop: '0.5rem', marginBottom: 0 }}>{item.summary}</p>
      )}
      {item.source_excerpt && (
        <p
          style={{
            fontSize: '0.8rem',
            color: MUTED,
            fontStyle: 'italic',
            marginTop: '0.5rem',
            marginBottom: 0,
          }}
        >
          “{item.source_excerpt}”
        </p>
      )}

      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '0.75rem',
          marginTop: '0.65rem',
          flexWrap: 'wrap',
        }}
      >
        <span
          style={{
            fontSize: '0.75rem',
            color: lowConfidence ? 'var(--text-warning, #b45309)' : MUTED,
          }}
        >
          Confidence {pct}%{lowConfidence ? ' · low — treat with caution' : ''}
        </span>
        {item.source_url && (
          <a
            href={item.source_url}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontSize: '0.8rem',
              color: 'var(--accent-primary, var(--accent-primary))',
              fontWeight: 600,
              textDecoration: 'none',
            }}
          >
            View source ↗
          </a>
        )}
      </div>
    </div>
  );
}

export function LegalHorizonPage() {
  const { items, loading, error, scanBusy, scanStatus, refresh, runSonarScan } = useLegalHorizon();

  return (
    <section className="animated-fade-in">
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: '1rem',
          flexWrap: 'wrap',
          marginBottom: '0.75rem',
        }}
      >
        <div style={{ minWidth: 0, flex: '1 1 24rem' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              marginBottom: '0.25rem',
            }}
          >
            <CalendarClock size={22} />
            <h1 style={{ margin: 0 }}>Upcoming changes</h1>
          </div>
          <p style={{ color: MUTED, margin: 0 }}>
            Proposed and in-progress Australian tax and super changes detected from official
            sources, so you can plan ahead. These are <strong>not settled law</strong> — each is
            stage-labelled and confidence-scored until it’s enacted and confirmed against the law.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => void refresh()}
            disabled={loading || scanBusy}
            title="Refresh upcoming changes"
          >
            <RefreshCw size={15} />
            Refresh
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void runSonarScan()}
            disabled={loading || scanBusy}
            title="Run a Sonar scan of Australian tax and super changes"
          >
            <RefreshCw size={15} />
            {scanBusy ? 'Scanning...' : 'Scan with Sonar'}
          </button>
        </div>
      </div>

      {error && <ErrorBadge message={error} />}
      {scanStatus && !error && (
        <div
          className="badge badge-success"
          style={{
            display: 'block',
            padding: '0.75rem',
            textTransform: 'none',
            marginTop: '0.5rem',
          }}
        >
          {scanStatus}
        </div>
      )}

      {loading ? (
        <div aria-busy="true" aria-label="Loading legal horizon">
          <SkeletonCard />
        </div>
      ) : items.length === 0 ? (
        <div className="card" style={{ padding: '1.5rem', textAlign: 'center', color: MUTED }}>
          No upcoming changes on the radar right now. Run a Sonar scan to sweep official sources
          now. Proposed measures (budget announcements, exposure drafts, bills before Parliament)
          appear here as they’re detected.
        </div>
      ) : (
        items.map((item) => <HorizonCard key={item.id} item={item} />)
      )}
    </section>
  );
}
