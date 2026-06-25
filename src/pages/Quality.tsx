import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';
import { useBooksHealth } from '@/hooks/useBooksHealth';
import { formatMoney } from '@/lib/money';
import {
  Activity,
  AlertTriangle,
  Copy,
  CheckCircle2,
  ChevronRight,
  FileText,
  Info,
  ShieldAlert
} from 'lucide-react';

interface DupGroup {
  organization_id: string;
  supplier_id: string;
  invoice_date: string;
  total_inc_gst_cents: number;
  bill_ids: string[];
  dup_count: number;
}

interface LowConfBill {
  id: string;
  supplier_name_raw: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  total_inc_gst_cents: number | null;
  ocr_provider: string | null;
  ocr_confidence: number | null;
  status: string;
  created_at: string;
}

export function QualityPage() {
  const { currentOrg } = useOrg();
  const [duplicates, setDuplicates] = useState<DupGroup[]>([]);
  const [lowConf, setLowConf] = useState<LowConfBill[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);
    const [dupRes, lowRes] = await Promise.all([
      supabase.from('v_duplicate_bills').select('*').eq('organization_id', currentOrg.id),
      supabase.from('v_low_confidence_bills').select('*').eq('organization_id', currentOrg.id).order('created_at', { ascending: false }).limit(100),
    ]);
    setDuplicates((dupRes.data ?? []) as DupGroup[]);
    setLowConf((lowRes.data ?? []) as LowConfBill[]);
    setLoading(false);
  }, [currentOrg]);

  useEffect(() => void refresh(), [refresh]);

  if (!currentOrg) return null;

  return (
    <section className="animated-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      <div>
        <h1 style={{ margin: 0 }}>Data Quality</h1>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.925rem', maxWidth: '600px', margin: 0, marginTop: '0.5rem' }}>
          Bills that look like duplicates, or where OCR couldn't confidently extract key fields. Resolve these issues to keep your P&L and BAS reports clean and accurate.
        </p>
      </div>

      <BooksHealthHeader />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '1rem' }}>
        <KpiCard
          label="Duplicate Groups"
          value={String(duplicates.length)}
          accentColor={duplicates.length > 0 ? 'var(--accent-danger)' : 'var(--accent-success)'}
          icon={duplicates.length > 0 ? <Copy className="w-5 h-5" style={{ color: 'var(--accent-danger)' }} /> : <CheckCircle2 className="w-5 h-5" style={{ color: 'var(--accent-success)' }} />}
          sub={`${duplicates.reduce((a, d) => a + d.dup_count, 0)} bills involved`}
        />
        <KpiCard
          label="Needs OCR Review"
          value={String(lowConf.length)}
          accentColor={lowConf.length > 0 ? 'var(--accent-warning)' : 'var(--accent-success)'}
          icon={lowConf.length > 0 ? <ShieldAlert className="w-5 h-5" style={{ color: 'var(--accent-warning)' }} /> : <CheckCircle2 className="w-5 h-5" style={{ color: 'var(--accent-success)' }} />}
          sub="low confidence or missing fields"
        />
      </div>

      <div>
        <h2 style={{ fontSize: '1.25rem', marginBottom: '1rem' }}>Possible Duplicates</h2>
        {loading ? (
          <p style={{ color: 'var(--text-muted)' }}>Checking duplicates...</p>
        ) : duplicates.length === 0 ? (
          <div className="card" style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '1.25rem' }}>
            <CheckCircle2 className="w-5 h-5 text-accent-success" style={{ color: 'var(--accent-success)' }} />
            <span style={{ fontSize: '0.925rem', color: 'var(--text-body)' }}>No duplicate bills detected. Your ledger is clean.</span>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {duplicates.map((d, i) => (
              <div key={i} className="card-gradient" style={{ padding: '1rem 1.25rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
                  <div>
                    <div style={{ fontSize: '0.925rem', fontWeight: 600, color: 'var(--text-title)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <AlertTriangle className="w-4 h-4 text-accent-danger" style={{ color: 'var(--accent-danger)' }} />
                      {d.dup_count} duplicate bills flagged
                    </div>
                    <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
                      Same supplier & invoice date (<span style={{ color: 'var(--text-title)' }}>{d.invoice_date}</span>), totaling <strong style={{ color: 'var(--accent-danger)' }}>{formatMoney(d.total_inc_gst_cents)}</strong>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                    {d.bill_ids.map((bid) => (
                      <Link
                        key={bid}
                        to={`/bills/${bid}`}
                        className="btn btn-secondary"
                        style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}
                      >
                        Bill {bid.slice(0, 8)}
                        <ChevronRight className="w-3.5 h-3.5" />
                      </Link>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <h2 style={{ fontSize: '1.25rem', marginBottom: '1rem' }}>Needs Manual Review</h2>
        {lowConf.length === 0 ? (
          <div className="card" style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '1.25rem' }}>
            <CheckCircle2 className="w-5 h-5 text-accent-success" style={{ color: 'var(--accent-success)' }} />
            <span style={{ fontSize: '0.925rem', color: 'var(--text-body)' }}>All uploaded bills look clean. No manual review needed.</span>
          </div>
        ) : (
          <div className="table-premium-container">
            <table className="table-premium">
              <thead>
                <tr>
                  <th>Supplier Raw Name</th>
                  <th>Invoice #</th>
                  <th>Invoice Date</th>
                  <th style={{ textAlign: 'right' }}>Total amount</th>
                  <th>OCR Engine</th>
                  <th>Status</th>
                  <th>Flagged Issues</th>
                </tr>
              </thead>
              <tbody>
                {lowConf.map((b) => {
                  const issues: string[] = [];
                  if (!b.supplier_name_raw) issues.push('missing supplier');
                  if (b.total_inc_gst_cents == null) issues.push('missing total');
                  if (b.total_inc_gst_cents === 0) issues.push('$0.00 amount');
                  if (b.ocr_confidence != null && b.ocr_confidence < 0.6) issues.push(`${(b.ocr_confidence * 100).toFixed(0)}% OCR confidence`);
                  if (b.invoice_date && new Date(b.invoice_date) > new Date(Date.now() + 7 * 86400000)) issues.push('future date');

                  return (
                    <tr key={b.id}>
                      <td>
                        <Link to={`/bills/${b.id}`} style={{ fontWeight: 600, color: 'var(--accent-primary)', display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
                          <FileText className="w-4 h-4 text-muted" />
                          {b.supplier_name_raw ?? <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>—</span>}
                        </Link>
                      </td>
                      <td>
                        <code style={{ fontSize: '0.8rem', color: 'var(--text-title)' }}>{b.invoice_number ?? '—'}</code>
                      </td>
                      <td>{b.invoice_date ?? '—'}</td>
                      <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--text-title)' }}>
                        {b.total_inc_gst_cents != null ? formatMoney(b.total_inc_gst_cents) : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                      </td>
                      <td>
                        <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontFamily: 'monospace' }}>{b.ocr_provider ?? '—'}</span>
                      </td>
                      <td>
                        <span className="badge badge-neutral" style={{ textTransform: 'capitalize' }}>{b.status}</span>
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
                          {issues.map((iss) => (
                            <span key={iss} className="badge badge-danger" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.2rem', textTransform: 'none' }}>
                              <AlertTriangle className="w-3.5 h-3.5" />
                              {iss}
                            </span>
                          ))}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div
        className="glass-panel"
        style={{
          padding: '1rem 1.25rem',
          display: 'flex',
          gap: '0.75rem',
          alignItems: 'flex-start',
          fontSize: '0.825rem',
          color: 'var(--text-muted)',
          borderStyle: 'dashed'
        }}
      >
        <Info className="w-5 h-5 text-accent-primary" style={{ flexShrink: 0, marginTop: '0.1rem', color: 'var(--accent-primary)' }} />
        <div>
          <strong style={{ color: 'var(--text-title)', display: 'block', marginBottom: '0.25rem' }}>Data Quality Shield:</strong>
          Resolving duplicate bills ensures that you do not double-deduct expenses or pay suppliers twice. Reviewing low confidence OCR records guarantees correctness for tax season.
        </div>
      </div>
    </section>
  );
}

function BooksHealthHeader() {
  const { score, components, blocking, loading, error } = useBooksHealth();

  const scoreColor =
    score == null
      ? 'var(--text-muted)'
      : blocking
        ? 'var(--accent-warning)'
        : 'var(--accent-success)';

  return (
    <div className="card-gradient" style={{ padding: '1.25rem 1.5rem', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '1.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', minWidth: '210px' }}>
        <div style={{ padding: '0.6rem', background: 'var(--bg-hover)', borderRadius: 'var(--radius-sm)' }}>
          <Activity className="w-6 h-6" style={{ color: scoreColor }} />
        </div>
        <div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>
            Books Health
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.4rem' }}>
            <span style={{ fontSize: '2.25rem', fontWeight: 700, color: scoreColor, fontFamily: 'var(--font-title)', lineHeight: 1 }}>
              {loading ? '—' : score ?? '—'}
            </span>
            <span style={{ fontSize: '1rem', color: 'var(--text-muted)' }}>/ 100</span>
          </div>
          {error ? (
            <span className="badge badge-danger" style={{ marginTop: '0.3rem', display: 'inline-block' }}>
              Failed to load: {error}
            </span>
          ) : (
            <div style={{ fontSize: '0.8rem', color: scoreColor, marginTop: '0.3rem', fontWeight: 600 }}>
              {loading
                ? 'Calculating…'
                : score == null
                  ? 'No data yet'
                  : blocking
                    ? 'Needs attention before tax engines run'
                    : 'Healthy — clear to run'}
            </div>
          )}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '0.75rem', flex: 1, minWidth: '280px' }}>
        <HealthMetric label="Uncoded" value={components ? String(components.uncoded_count) : '—'} warn={(components?.uncoded_count ?? 0) > 0} />
        <HealthMetric label="Unreconciled" value={components ? String(components.unreconciled_count) : '—'} warn={(components?.unreconciled_count ?? 0) > 0} />
        <HealthMetric label="Open Periods" value={components ? String(components.open_period_count) : '—'} warn={(components?.open_period_count ?? 0) > 0} />
        <HealthMetric label="Coverage" value={components ? `${components.coverage_pct.toFixed(1)}%` : '—'} warn={(components?.coverage_pct ?? 100) < 80} />
      </div>
    </div>
  );
}

function HealthMetric({ label, value, warn }: { label: string; value: string; warn: boolean }) {
  return (
    <div style={{ background: 'var(--bg-hover)', borderRadius: 'var(--radius-sm)', padding: '0.6rem 0.75rem' }}>
      <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600 }}>
        {label}
      </div>
      <div style={{ fontSize: '1.15rem', fontWeight: 700, color: warn ? 'var(--accent-warning)' : 'var(--text-title)', marginTop: '0.15rem' }}>
        {value}
      </div>
    </div>
  );
}

function KpiCard({ label, value, icon, accentColor, sub }: { label: string; value: string; icon: React.ReactNode; accentColor: string; sub?: string }) {
  return (
    <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderLeft: `4px solid ${accentColor}` }}>
      <div>
        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600, marginBottom: '0.35rem' }}>
          {label}
        </div>
        <div style={{ fontSize: '1.65rem', color: 'var(--text-title)', fontWeight: 700, fontFamily: 'var(--font-title)' }}>
          {value}
        </div>
        {sub && <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>{sub}</div>}
      </div>
      <div style={{ padding: '0.5rem', background: 'var(--bg-hover)', borderRadius: 'var(--radius-sm)' }}>
        {icon}
      </div>
    </div>
  );
}
