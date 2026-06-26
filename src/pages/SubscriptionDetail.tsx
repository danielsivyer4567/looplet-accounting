import { useEffect, useMemo, useState, useCallback } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';
import { formatMoney, formatMoneyCompact } from '@/lib/money';
import { MoveToOrgButton } from '@/components/MoveToOrgButton';
import { AllocationSplitButton } from '@/components/AllocationSplitButton';
import {
  ArrowLeft,
  RefreshCw,
  Edit2,
  Info,
  Calendar,
  DollarSign,
  Clock,
  TrendingUp,
  History,
  CreditCard
} from 'lucide-react';

interface Subscription {
  id: string;
  organization_id: string;
  merchant_canonical_key: string | null;
  merchant_name: string;
  cadence: string;
  amount_cents: number;
  currency_code: string | null;
  status: string;
  confidence: number | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  next_expected_at: string | null;
  observed_count: number;
  total_spent_cents: number;
  detection_reason: string | null;
  is_personal: boolean;
  is_business: boolean;
  notes: string | null;
}

interface BankTxn {
  id: string;
  posted_at: string;
  description: string;
  amount_cents: number;
}

const STATUS_OPTIONS = ['detected', 'confirmed', 'cancelled', 'paused'];
const CADENCE_OPTIONS = ['weekly', 'fortnightly', 'monthly', 'quarterly', 'yearly'];

function canonicaliseDescription(d: string): string {
  return d
    .toLowerCase()
    .replace(/\d{4,}/g, '')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\b(au|aus|australia|pty|ltd|llc|inc)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 32);
}

function monthlyEquivalent(amount_cents: number, cadence: string): number {
  if (cadence === 'monthly') return amount_cents;
  if (cadence === 'yearly' || cadence === 'annual') return Math.round(amount_cents / 12);
  if (cadence === 'weekly') return Math.round(amount_cents * 4.33);
  if (cadence === 'fortnightly') return Math.round(amount_cents * 2.17);
  if (cadence === 'quarterly') return Math.round(amount_cents / 3);
  return amount_cents;
}

export function SubscriptionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { currentOrg } = useOrg();
  const navigate = useNavigate();
  const [sub, setSub] = useState<Subscription | null>(null);
  const [txns, setTxns] = useState<BankTxn[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Partial<Subscription>>({});
  const [saving, setSaving] = useState(false);
  const [redetecting, setRedetecting] = useState(false);
  const [redetectMsg, setRedetectMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!currentOrg || !id) return;
    setLoading(true);
    setError(null);
    const subRes = await supabase
      .from('subscriptions')
      .select('*')
      .eq('id', id)
      .eq('organization_id', currentOrg.id)
      .maybeSingle();
    if (subRes.error) {
      setError(subRes.error.message);
      setLoading(false);
      return;
    }
    const s = (subRes.data ?? null) as Subscription | null;
    setSub(s);

    if (s && s.merchant_canonical_key) {
      const cutoff = new Date();
      cutoff.setMonth(cutoff.getMonth() - 24);
      const txnRes = await supabase
        .from('bank_transactions')
        .select('id, posted_at, description, amount_cents')
        .eq('organization_id', currentOrg.id)
        .lt('amount_cents', 0)
        .gte('posted_at', cutoff.toISOString())
        .order('posted_at', { ascending: false })
        .limit(500);
      if (!txnRes.error) {
        const all = (txnRes.data ?? []) as BankTxn[];
        const filtered = all.filter(
          (t) => canonicaliseDescription(t.description) === s.merchant_canonical_key,
        );
        setTxns(filtered);
      }
    } else {
      setTxns([]);
    }
    setLoading(false);
  }, [currentOrg, id]);

  useEffect(() => void refresh(), [refresh]);

  const startEdit = () => {
    if (!sub) return;
    setDraft({
      status: sub.status,
      cadence: sub.cadence,
      is_personal: sub.is_personal,
      is_business: sub.is_business,
      notes: sub.notes ?? '',
    });
    setEditing(true);
  };

  const save = async () => {
    if (!sub) return;
    setSaving(true);
    setError(null);
    const isPersonal = !!draft.is_personal;
    let isBusiness = !!draft.is_business;
    if (isPersonal && isBusiness) isBusiness = false;
    const payload: Partial<Subscription> = {
      status: draft.status ?? sub.status,
      cadence: draft.cadence ?? sub.cadence,
      is_personal: isPersonal,
      is_business: isBusiness,
      notes: draft.notes?.toString().trim() || null,
    };
    const { error: e } = await supabase.from('subscriptions').update(payload).eq('id', sub.id);
    setSaving(false);
    if (e) {
      setError(e.message);
      return;
    }
    setEditing(false);
    void refresh();
  };

  const redetect = async () => {
    if (!currentOrg) return;
    setRedetecting(true);
    setRedetectMsg(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in');
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/subscriptions-detect`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ organization_id: currentOrg.id }),
        },
      );
      const body = await res.json();
      if (!res.ok || !body.ok) throw new Error(body.error ?? `${res.status}`);
      setRedetectMsg(`Scanned ${body.scanned_txns} txns · ${body.upserted} new + ${body.updated} updated`);
      void refresh();
    } catch (e) {
      setRedetectMsg('Detection error: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setRedetecting(false);
    }
  };

  const monthlyBars = useMemo(() => {
    const now = new Date();
    const buckets: { label: string; value: number }[] = [];
    for (let i = 7; i >= 0; i -= 1) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const next = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
      const total = txns
        .filter((t) => {
          const ts = new Date(t.posted_at).getTime();
          return ts >= d.getTime() && ts < next.getTime();
        })
        .reduce((acc, t) => acc + Math.abs(t.amount_cents), 0);
      buckets.push({
        label: d.toLocaleDateString('en-AU', { month: 'short' }),
        value: total,
      });
    }
    return buckets;
  }, [txns]);

  if (!currentOrg) return null;
  if (loading) {
    return (
      <section className="animated-fade-in" style={{ padding: '2rem 0' }}>
        <p style={{ color: 'var(--text-muted)' }}>Loading subscription detail...</p>
      </section>
    );
  }

  if (!sub) {
    return (
      <section className="animated-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <h1>Subscription Not Found</h1>
        <Link to="/subscriptions" className="btn btn-secondary" style={{ width: 'fit-content' }}>
          <ArrowLeft className="w-4 h-4" /> Back to Subscriptions
        </Link>
      </section>
    );
  }

  const monthly = monthlyEquivalent(sub.amount_cents, sub.cadence);
  const annual = monthly * 12;

  return (
    <section className="animated-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      <div>
        <Link to="/subscriptions" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.875rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
          <ArrowLeft className="w-4 h-4" /> Back to all subscriptions
        </Link>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
            <h1 style={{ margin: 0 }}>{sub.merchant_name}</h1>
            <StatusPill status={sub.status} />
          </div>

          {!editing && (
            <div style={{ display: 'inline-flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <button className="btn btn-secondary" onClick={redetect} disabled={redetecting}>
                <RefreshCw className={`w-4 h-4 ${redetecting ? 'animate-spin' : ''}`} />
                {redetecting ? 'Detecting…' : 'Re-scan feed'}
              </button>
              <AllocationSplitButton
                resourceType="subscription"
                resourceId={sub.id}
                hostOrgId={currentOrg.id}
                onSaved={() => void refresh()}
              />
              <MoveToOrgButton
                table="subscriptions"
                rowId={sub.id}
                currentOrgId={currentOrg.id}
                fkColumnsToNull={['supplier_id']}
                onMoved={() => navigate('/subscriptions')}
              />
              <button className="btn btn-secondary" onClick={startEdit}>
                <Edit2 className="w-4 h-4" /> Edit Details
              </button>
            </div>
          )}
        </div>
      </div>

      {redetectMsg && (
        <div className={`badge ${redetectMsg.startsWith('Detection error') ? 'badge-danger' : 'badge-success'}`} style={{ display: 'block', padding: '0.625rem 1rem', textTransform: 'none', width: 'fit-content' }}>
          {redetectMsg}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1rem' }}>
        <KpiCard
          label="Recurring Amount"
          value={formatMoney(sub.amount_cents)}
          accentColor="var(--accent-warning)"
          icon={<CreditCard className="w-5 h-5" style={{ color: 'var(--accent-warning)' }} />}
          sub={sub.cadence}
        />
        <KpiCard
          label="Monthly Run Rate"
          value={formatMoney(monthly)}
          accentColor="var(--accent-info)"
          icon={<Calendar className="w-5 h-5" style={{ color: 'var(--accent-info)' }} />}
        />
        <KpiCard
          label="Annual Cost Equivalent"
          value={formatMoney(annual)}
          accentColor="var(--accent-success)"
          icon={<TrendingUp className="w-5 h-5" style={{ color: 'var(--accent-success)' }} />}
        />
        <KpiCard
          label="Next Billing Cycle"
          value={sub.next_expected_at ?? '—'}
          accentColor="var(--text-muted)"
          icon={<Clock className="w-5 h-5" style={{ color: 'var(--text-muted)' }} />}
        />
        <KpiCard
          label="Observed Count"
          value={String(sub.observed_count)}
          accentColor="var(--text-muted)"
          icon={<History className="w-5 h-5" style={{ color: 'var(--text-muted)' }} />}
          sub="bank matches"
        />
        <KpiCard
          label="Lifetime Spend to Date"
          value={formatMoney(sub.total_spent_cents)}
          accentColor="var(--accent-danger)"
          icon={<DollarSign className="w-5 h-5" style={{ color: 'var(--accent-danger)' }} />}
        />
      </div>

      {editing ? (
        <div className="card-gradient">
          <h3 style={{ marginTop: 0, marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Edit2 className="w-5 h-5" /> Edit Subscription Settings
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem' }}>
              <div className="form-group">
                <label className="form-label">Subscription Status</label>
                <select
                  className="form-select"
                  value={String(draft.status ?? sub.status)}
                  onChange={(e) => setDraft({ ...draft, status: e.target.value })}
                >
                  {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Cadence Override</label>
                <select
                  className="form-select"
                  value={String(draft.cadence ?? sub.cadence)}
                  onChange={(e) => setDraft({ ...draft, cadence: e.target.value })}
                >
                  {CADENCE_OPTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Account Classification</label>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button
                  type="button"
                  onClick={() => setDraft({ ...draft, is_business: !draft.is_business, is_personal: false })}
                  className="btn"
                  style={{
                    backgroundColor: draft.is_business && !draft.is_personal ? 'var(--bg-success-subtle)' : 'var(--bg-hover)',
                    color: draft.is_business && !draft.is_personal ? 'var(--text-success)' : 'var(--text-muted)',
                    border: `1px solid ${draft.is_business && !draft.is_personal ? 'rgba(16, 185, 129, 0.2)' : 'var(--border-subtle)'}`
                  }}
                >
                  Business (Deductible)
                </button>
                <button
                  type="button"
                  onClick={() => setDraft({ ...draft, is_personal: !draft.is_personal, is_business: false })}
                  className="btn"
                  style={{
                    backgroundColor: draft.is_personal ? 'var(--bg-warning-subtle)' : 'var(--bg-hover)',
                    color: draft.is_personal ? 'var(--text-warning)' : 'var(--text-muted)',
                    border: `1px solid ${draft.is_personal ? 'rgba(245, 158, 11, 0.2)' : 'var(--border-subtle)'}`
                  }}
                >
                  Personal (Non-Deductible)
                </button>
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Notes</label>
              <textarea
                className="form-textarea"
                rows={3}
                value={String(draft.notes ?? '')}
                onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
              />
            </div>

            <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.5rem' }}>
              <button className="btn btn-primary" onClick={save} disabled={saving}>
                {saving ? 'Saving Changes…' : 'Save Changes'}
              </button>
              <button className="btn btn-secondary" onClick={() => setEditing(false)} disabled={saving}>
                Cancel
              </button>
            </div>
            {error && (
              <div className="badge badge-danger" style={{ display: 'block', padding: '0.5rem 1rem', textTransform: 'none' }}>
                {error}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="card" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1.5rem' }}>
          <StatField label="Billing Cadence" value={sub.cadence} style={{ textTransform: 'capitalize' }} />
          <StatField label="Currency Setting" value={sub.currency_code ?? 'AUD'} />
          <StatField label="Confidence Rating" value={sub.confidence != null ? `${(sub.confidence * 100).toFixed(0)}%` : '—'} />
          <StatField label="Detection Origin" value={sub.detection_reason ?? 'Auto-scanned description match'} />
          <StatField label="Classification" value={sub.is_business ? 'Business Account' : sub.is_personal ? 'Personal Account' : 'Unclassified'} />
          <StatField label="Canonical Merchant Key" value={sub.merchant_canonical_key ?? '—'} mono />
          <StatField label="First Billing Match" value={sub.first_seen_at?.slice(0, 10) ?? '—'} />
          <StatField label="Last Billing Match" value={sub.last_seen_at?.slice(0, 10) ?? '—'} />
          <div style={{ gridColumn: '1 / -1' }}>
            <StatField label="Notes / Memo" value={sub.notes ?? 'No internal notes recorded.'} />
          </div>
        </div>
      )}

      <div>
        <h2 style={{ fontSize: '1.25rem', marginBottom: '1rem' }}>Monthly History (Last 8 Months)</h2>
        {monthlyBars.every((b) => b.value === 0) ? (
          <div className="card" style={{ padding: '1.5rem', color: 'var(--text-muted)', fontSize: '0.875rem' }}>
            No matching transactions were observed in the last 8 months.
          </div>
        ) : (
          <div className="card" style={{ display: 'flex', justifyContent: 'center', padding: '2rem 1.5rem', overflowX: 'auto' }}>
            <MonthlyBars bars={monthlyBars} />
          </div>
        )}
      </div>

      <div>
        <h2 style={{ fontSize: '1.25rem', marginBottom: '1rem' }}>Matching Bank Transactions (Last 24 Months)</h2>
        {txns.length === 0 ? (
          <div className="card" style={{ padding: '1.5rem', color: 'var(--text-muted)', fontSize: '0.875rem' }}>
            No matching bank transactions found for canonical key <code style={{ color: 'var(--text-title)', fontSize: '0.85rem' }}>{sub.merchant_canonical_key ?? '—'}</code>.
          </div>
        ) : (
          <div className="table-premium-container">
            <table className="table-premium">
              <thead>
                <tr>
                  <th>Posting Date</th>
                  <th>Raw Statement Description</th>
                  <th style={{ textAlign: 'right' }}>Debit Amount</th>
                </tr>
              </thead>
              <tbody>
                {txns.map((t) => (
                  <tr key={t.id}>
                    <td>{t.posted_at.slice(0, 10)}</td>
                    <td>
                      <code style={{ fontSize: '0.8rem', color: 'var(--text-title)', backgroundColor: 'var(--bg-hover)', padding: '0.2rem 0.4rem', borderRadius: 'var(--radius-sm)' }}>
                        {t.description}
                      </code>
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--text-title)' }}>
                      {formatMoney(Math.abs(t.amount_cents))}
                    </td>
                  </tr>
                ))}
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
          <strong style={{ color: 'var(--text-title)', display: 'block', marginBottom: '0.25rem' }}>Subscription Optimization:</strong>
          Looplet scans these historical transactions to verify pricing changes. We will warn you when a bill goes up or has double-accrued.
        </div>
      </div>
    </section>
  );
}

function MonthlyBars({ bars }: { bars: { label: string; value: number }[] }) {
  const BAR_W = 48;
  const GAP = 18;
  const HEIGHT = 140;
  const LABEL_H = 36;
  const max = Math.max(1, ...bars.map((b) => b.value));
  const totalW = bars.length * (BAR_W + GAP);
  return (
    <svg width={totalW} height={HEIGHT + LABEL_H} role="img" aria-label="Monthly subscription spend, last 8 months">
      {bars.map((b, i) => {
        const x = i * (BAR_W + GAP);
        const h = max > 0 ? (b.value / max) * HEIGHT : 0;
        const y = HEIGHT - h;
        return (
          <g key={i}>
            <rect x={x} y={0} width={BAR_W} height={HEIGHT} fill="var(--bg-hover)" rx={4} />
            {b.value > 0 && (
              <rect x={x} y={y} width={BAR_W} height={h} fill="var(--accent-primary)" rx={4} />
            )}
            <text x={x + BAR_W / 2} y={HEIGHT + 16} textAnchor="middle" fill="var(--text-muted)" fontSize={11}>
              {b.label}
            </text>
            <text x={x + BAR_W / 2} y={HEIGHT + 30} textAnchor="middle" fill="var(--accent-primary)" fontSize={10} fontWeight={600}>
              {b.value > 0 ? formatMoneyCompact(b.value) : ''}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function StatField({ label, value, mono, style }: { label: string; value: string; mono?: boolean; style?: React.CSSProperties }) {
  return (
    <div style={style}>
      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600, marginBottom: '0.25rem' }}>
        {label}
      </div>
      <div style={{ color: 'var(--text-title)', fontSize: '0.95rem', fontWeight: 500, fontFamily: mono ? 'monospace' : 'inherit' }}>
        {value}
      </div>
    </div>
  );
}

function KpiCard({ label, value, accentColor, icon, sub }: { label: string; value: string; accentColor: string; icon: React.ReactNode; sub?: string }) {
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

function StatusPill({ status }: { status: string }) {
  switch (status) {
    case 'confirmed':
      return <span className="badge badge-success">Confirmed</span>;
    case 'detected':
      return <span className="badge badge-info">Detected</span>;
    case 'cancelled':
      return <span className="badge badge-neutral">Cancelled</span>;
    case 'paused':
      return <span className="badge badge-warning">Paused</span>;
    default:
      return <span className="badge badge-neutral">{status}</span>;
  }
}
