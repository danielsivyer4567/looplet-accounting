import { useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';
import {
  useBusinessSignals,
  type SignalKind,
  type BusinessSignal,
} from '@/hooks/useBusinessSignals';

const SIGNAL_META: Record<SignalKind, { icon: string; title: string }> = {
  regulatory_presence: { icon: '🏛️', title: 'Regulatory presence' },
  active_jobs: { icon: '🏗️', title: 'Active job sites' },
  bank_accounts: { icon: '🏦', title: 'Bank accounts' },
  insurance: { icon: '🛡️', title: 'Insurance policies' },
  business_saas: { icon: '💻', title: 'Business subscriptions' },
  vehicle_fleet: { icon: '🚙', title: 'Vehicle / fleet' },
  regular_subcontractors: { icon: '👷', title: 'Regular subcontractors' },
  recurring_utilities: { icon: '⚡', title: 'Utilities' },
  investment_property: { icon: '🏠', title: 'Investment property' },
  customer_base: { icon: '👥', title: 'Customer base' },
};

/**
 * "Detected" panel: for each signal we found in the user's email scrape,
 * show a confirm/dismiss row. Confirming bulk-approves the linked staged
 * entities → suppliers/customers + intake_rules so future intake auto-routes.
 */
export function DetectedInsights() {
  const { currentOrg } = useOrg();
  const { signals, loading, refresh } = useBusinessSignals();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<Record<string, 'confirmed' | 'skipped'>>({});

  if (!currentOrg) return null;
  if (loading) return <p style={{ color: 'var(--text-muted)' }}>Looking at your inbox patterns…</p>;
  if (signals.length === 0) {
    return (
      <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>
        Run Auto Setup mining first — once entities are staged we'll surface detected
        business-profile signals here.
      </p>
    );
  }

  const onConfirm = async (s: BusinessSignal) => {
    setError(null);
    setBusy(s.signal_kind);
    try {
      const ids = s.metadata.entity_ids ?? [];
      if (ids.length > 0) {
        // Bulk approve the linked staged_entities — picks up the predicted
        // category + creates suppliers/customers + intake_rules via the
        // standard triage flow. Fire-and-forget approval here.
        await supabase
          .from('staged_entities')
          .update({
            status: 'approved',
            reviewed_at: new Date().toISOString(),
          })
          .in('id', ids);
      }
      setDecisions((prev) => ({ ...prev, [s.signal_kind]: 'confirmed' }));
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const onSkip = (s: BusinessSignal) => {
    setDecisions((prev) => ({ ...prev, [s.signal_kind]: 'skipped' }));
  };

  return (
    <div style={{ marginTop: 24 }}>
      <h2 style={{ fontSize: 16, marginBottom: 4 }}>Detected from your inbox</h2>
      <p style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 16, maxWidth: 720 }}>
        We've read patterns in your last 6 months of email — these are educated guesses about your
        business. Confirm to auto-set-up, or skip and we'll just leave it for you to do manually.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {signals.map((s) => {
          const meta = SIGNAL_META[s.signal_kind];
          const decision = decisions[s.signal_kind];
          return (
            <div
              key={s.signal_kind}
              style={{
                padding: 12,
                background: 'var(--bg-card)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 6,
                opacity: decision ? 0.6 : 1,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  gap: 12,
                }}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>
                    <span style={{ marginRight: 8 }}>{meta?.icon}</span>
                    {meta?.title ?? s.signal_kind}
                    <span
                      style={{
                        marginLeft: 8,
                        fontSize: 11,
                        color: s.confidence >= 0.9 ? 'var(--text-success)' : 'var(--text-muted)',
                        background: 'var(--bg-panel)',
                        padding: '0.1rem 0.4rem',
                        borderRadius: 3,
                      }}
                    >
                      {Math.round(s.confidence * 100)}% confidence
                    </span>
                  </div>
                  <div
                    style={{
                      color: 'var(--text-muted)',
                      fontSize: 12,
                      marginTop: 4,
                      lineHeight: 1.4,
                    }}
                  >
                    {s.evidence}
                  </div>
                  <div style={{ color: 'var(--text-title)', fontSize: 13, marginTop: 8 }}>
                    {s.question}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {decision === 'confirmed' ? (
                    <span style={{ color: 'var(--text-success)', fontSize: 12 }}>✓ confirmed</span>
                  ) : decision === 'skipped' ? (
                    <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>skipped</span>
                  ) : (
                    <>
                      <button
                        onClick={() => onConfirm(s)}
                        disabled={busy === s.signal_kind}
                        style={{
                          background: 'var(--bg-success-subtle)',
                          color: 'var(--text-success)',
                          border: '1px solid var(--accent-success)',
                          borderRadius: 3,
                          fontSize: 12,
                          padding: '0.3rem 0.7rem',
                          cursor: busy ? 'wait' : 'pointer',
                          fontWeight: 600,
                        }}
                      >
                        {busy === s.signal_kind ? '…' : 'Confirm & set up'}
                      </button>
                      <button
                        onClick={() => onSkip(s)}
                        disabled={!!busy}
                        style={{
                          background: 'transparent',
                          color: 'var(--text-muted)',
                          border: '1px solid var(--border-subtle)',
                          borderRadius: 3,
                          fontSize: 12,
                          padding: '0.3rem 0.7rem',
                          cursor: 'pointer',
                        }}
                      >
                        Skip
                      </button>
                    </>
                  )}
                </div>
              </div>
              {s.signal_kind === 'active_jobs' && decision === 'confirmed' && (
                <div style={{ marginTop: 8 }}>
                  <Link to="/jobs" style={{ color: 'var(--text-success)', fontSize: 12 }}>
                    View {s.metadata.count} jobs →
                  </Link>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {error && <p style={{ color: 'var(--text-danger)', fontSize: 12, marginTop: 8 }}>{error}</p>}
    </div>
  );
}
