import { useEffect, useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/contexts/OrgContext';
import { formatMoney } from '@/lib/money';
import { MoveToOrgButton } from '@/components/MoveToOrgButton';
import { AllocationSplitButton } from '@/components/AllocationSplitButton';
import { SkeletonCard, SkeletonTable } from '@/components/Skeleton';

interface Subscription {
  id: string;
  organization_id: string;
  merchant_name: string;
  merchant_canonical_key: string | null;
  cadence: string;
  amount_cents: number;
  status: string;
  confidence: number | null;
  first_seen_at: string;
  last_seen_at: string;
  next_expected_at: string | null;
  observed_count: number;
  total_spent_cents: number;
  detection_reason: string | null;
  is_personal: boolean;
  is_business: boolean;
  notes: string | null;
}

const STATUS_FILTERS = ['all', 'candidate', 'confirmed', 'cancelled', 'dismissed'] as const;

export function SubscriptionsPage() {
  const { currentOrg } = useOrg();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<typeof STATUS_FILTERS[number]>('all');
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [loading, setLoading] = useState(true);
  const [detecting, setDetecting] = useState(false);
  const [detectMsg, setDetectMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);
    let q = supabase
      .from('subscriptions')
      .select('*')
      .eq('organization_id', currentOrg.id)
      .order('merchant_name', { ascending: true })
      .order('amount_cents', { ascending: false });
    if (filter !== 'all') q = q.eq('status', filter);
    const { data, error: e } = await q;
    if (e) setError(e.message);
    setSubs((data ?? []) as Subscription[]);
    setLoading(false);
  }, [currentOrg, filter]);

  useEffect(() => void refresh(), [refresh]);

  if (!currentOrg) return null;

  const monthlyEquivalent = (s: Subscription): number => {
    if (s.cadence === 'monthly') return s.amount_cents;
    if (s.cadence === 'yearly' || s.cadence === 'annual') return Math.round(s.amount_cents / 12);
    if (s.cadence === 'weekly') return Math.round(s.amount_cents * 4.33);
    if (s.cadence === 'fortnightly') return Math.round(s.amount_cents * 2.17);
    if (s.cadence === 'quarterly') return Math.round(s.amount_cents / 3);
    return s.amount_cents;
  };

  // Group by merchant_name (lowercased + trimmed) so duplicates collapse
  const grouped = useMemo(() => {
    const m = new Map<string, { name: string; rows: Subscription[] }>();
    for (const s of subs) {
      const key = s.merchant_name.trim().toLowerCase();
      if (!m.has(key)) m.set(key, { name: s.merchant_name, rows: [] });
      m.get(key)!.rows.push(s);
    }
    return Array.from(m.values());
  }, [subs]);

  const totalMonthly = subs.filter((s) => s.status !== 'cancelled' && s.status !== 'dismissed').reduce((a, s) => a + monthlyEquivalent(s), 0);
  const businessOnly = subs.filter((s) => s.is_business && !s.is_personal && s.status !== 'dismissed').reduce((a, s) => a + monthlyEquivalent(s) * 12, 0);
  const personalOnly = subs.filter((s) => s.is_personal && s.status !== 'dismissed').reduce((a, s) => a + monthlyEquivalent(s) * 12, 0);

  const setFlag = async (id: string, patch: Partial<Subscription>) => {
    const { error: e } = await supabase.from('subscriptions').update(patch).eq('id', id);
    if (e) { setError(`Failed to update: ${e.message}`); return; }
    void refresh();
  };

  const setStatus = async (id: string, status: 'confirmed' | 'dismissed' | 'candidate') => {
    const { error: e } = await supabase
      .from('subscriptions')
      .update({ status, reviewed_at: new Date().toISOString() })
      .eq('id', id);
    if (e) { setError(`Failed to set status=${status}: ${e.message}`); return; }
    void refresh();
  };

  const toggleExpanded = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const detect = async () => {
    if (!currentOrg) return;
    setDetecting(true);
    setDetectMsg(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in');
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/subscriptions-detect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ organization_id: currentOrg.id }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) throw new Error(body.error ?? `${res.status}`);
      setDetectMsg(`Scanned ${body.scanned_txns} txns · ${body.upserted} new + ${body.updated} updated subscriptions`);
      void refresh();
    } catch (e) {
      setDetectMsg('Detection error: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setDetecting(false);
    }
  };

  return (
    <section>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
        <h1 style={{ margin: 0 }}>Subscriptions</h1>
        <button onClick={detect} disabled={detecting} style={{ padding: '0.4rem 1rem', background: '#1c4868', color: '#fff', border: '1px solid #5096d8', borderRadius: 4, fontSize: 12, fontWeight: 600, cursor: detecting ? 'wait' : 'pointer' }}>
          {detecting ? 'Detecting…' : '↻ Re-detect from bank feed'}
        </button>
      </div>
      <p style={{ color: '#888', fontSize: 13 }}>
        Recurring payments detected from bank transactions and email senders.
        Tag each as business or personal so they roll up correctly in your P&L.
        Multiple variants of the same merchant (different sender domains) are grouped — click to expand.
      </p>
      {detectMsg && <p style={{ marginTop: 4, fontSize: 12, color: detectMsg.startsWith('Detection error') ? 'salmon' : '#86c7a3' }}>{detectMsg}</p>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, maxWidth: 1100, marginTop: 16 }}>
        <Kpi label="Active subscriptions" value={String(subs.filter((s) => s.status !== 'cancelled' && s.status !== 'dismissed').length)} colour="#aaa" />
        <Kpi label="Monthly total" value={formatMoney(totalMonthly)} colour="#d2c886" sub="all active" />
        <Kpi label="Annual: business" value={formatMoney(businessOnly)} colour="#86c7a3" sub="deductible" />
        <Kpi label="Annual: personal" value={formatMoney(personalOnly)} colour="#f0c47a" sub="non-deductible" />
      </div>

      <div style={{ marginTop: 20, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {STATUS_FILTERS.map((s) => (
          <button key={s} onClick={() => setFilter(s)} style={{
            padding: '0.3rem 0.75rem',
            background: filter === s ? '#1c4868' : 'transparent',
            color: filter === s ? '#fff' : '#aaa',
            border: '1px solid ' + (filter === s ? '#5096d8' : '#333'),
            borderRadius: 3, fontSize: 12, cursor: 'pointer',
          }}>{s}</button>
        ))}
      </div>

      {error && <p style={{ color: 'salmon', marginTop: 8, fontSize: 12 }}>{error}</p>}

      {loading ? (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, maxWidth: 1100, marginTop: 16 }}>
            {Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)}
          </div>
          <div style={{ marginTop: 20 }}>
            <SkeletonTable rows={6} cols={10} />
          </div>
        </>
      ) :
        subs.length === 0 ? (
          <div style={{ marginTop: 24, padding: 16, background: '#0e0e0e', border: '1px dashed #2a2a2a', borderRadius: 4, color: '#888', fontSize: 13 }}>
            No subscriptions detected yet. Run Auto Setup to scan your email, or sync your bank feed.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 16 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #2a2a2a' }}>
                  <th style={{ ...th, width: 24 }}></th>
                  <th style={th}>Merchant</th>
                  <th style={th}>Cadence</th>
                  <th style={thRight}>Amount</th>
                  <th style={thRight}>Monthly</th>
                  <th style={thRight}>Annual</th>
                  <th style={th}>Status</th>
                  <th style={th}>Tag</th>
                  <th style={th}>Confidence</th>
                  <th style={th}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {grouped.map((g) => {
                  const groupKey = g.name.toLowerCase();
                  const isGroup = g.rows.length > 1;
                  const isOpen = expanded.has(groupKey);

                  if (!isGroup) {
                    const s = g.rows[0]!;
                    return (
                      <SubRow
                        key={s.id}
                        s={s}
                        monthly={monthlyEquivalent(s)}
                        indent={false}
                        navigate={navigate}
                        setFlag={setFlag}
                        setStatus={setStatus}
                        refresh={refresh}
                      />
                    );
                  }

                  // Grouped header
                  const groupMonthly = g.rows.reduce((a, s) => a + monthlyEquivalent(s), 0);
                  const groupAnnual = groupMonthly * 12;
                  const distinctStatuses = new Set(g.rows.map((s) => s.status));
                  return (
                    <>
                      <tr
                        key={`g:${groupKey}`}
                        style={{ borderBottom: '1px solid #2a2a2a', background: '#141414', cursor: 'pointer' }}
                        onClick={() => toggleExpanded(groupKey)}
                      >
                        <td style={{ ...td, color: '#888', fontFamily: 'monospace' }}>{isOpen ? '▾' : '▸'}</td>
                        <td style={td}>
                          <strong style={{ color: '#e3e3e3' }}>{g.name}</strong>
                          <span style={{ marginLeft: 6, fontSize: 11, color: '#888' }}>({g.rows.length} variants)</span>
                        </td>
                        <td style={td}>—</td>
                        <td style={tdRight}>—</td>
                        <td style={tdRight}>{formatMoney(groupMonthly)}</td>
                        <td style={tdRight}>{formatMoney(groupAnnual)}</td>
                        <td style={td}>
                          {Array.from(distinctStatuses).map((s) => <Pill key={s} status={s} />)}
                        </td>
                        <td style={td}></td>
                        <td style={td}></td>
                        <td style={td} onClick={(e) => e.stopPropagation()}>
                          <span style={{ fontSize: 11, color: '#666' }}>click to expand</span>
                        </td>
                      </tr>
                      {isOpen && g.rows.map((s) => (
                        <SubRow
                          key={s.id}
                          s={s}
                          monthly={monthlyEquivalent(s)}
                          indent={true}
                          navigate={navigate}
                          setFlag={setFlag}
                          setStatus={setStatus}
                          refresh={refresh}
                        />
                      ))}
                    </>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      <p style={{ marginTop: 32, padding: 10, background: '#0e0e0e', border: '1px dashed #2a2a2a', borderRadius: 4, fontSize: 12, color: '#666' }}>
        Future: alerts for unexpected charges (price increase, double-charge), cancellation tracking, vendor links to manage subscription, ROI per subscription against the job/customer it powers.
      </p>
    </section>
  );
}

function SubRow({
  s, monthly, indent, navigate, setFlag, setStatus, refresh,
}: {
  s: Subscription;
  monthly: number;
  indent: boolean;
  navigate: ReturnType<typeof useNavigate>;
  setFlag: (id: string, patch: Partial<Subscription>) => Promise<void>;
  setStatus: (id: string, status: 'confirmed' | 'dismissed' | 'candidate') => Promise<void>;
  refresh: () => void;
}) {
  const annual = monthly * 12;
  const sourceHint = s.merchant_canonical_key
    ? s.merchant_canonical_key.replace(/^domain:/, '@').replace(/^email:/, '')
    : '—';
  return (
    <tr style={{ borderBottom: '1px solid #1a1a1a', opacity: s.status === 'dismissed' ? 0.5 : 1 }}>
      <td style={td}></td>
      <td style={{ ...td, paddingLeft: indent ? 28 : undefined }}>
        <a
          onClick={(e) => { e.preventDefault(); navigate(`/subscriptions/${s.id}`); }}
          href={`/subscriptions/${s.id}`}
          style={{ color: '#86c7a3', textDecoration: 'none', cursor: 'pointer' }}
        >
          {indent ? <span style={{ color: '#666' }}>↳ </span> : null}
          <strong>{s.merchant_name}</strong>
        </a>
        <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>{sourceHint}</div>
      </td>
      <td style={td}>{s.cadence}</td>
      <td style={tdRight}>{s.amount_cents > 0 ? formatMoney(s.amount_cents) : '—'}</td>
      <td style={tdRight}>{monthly > 0 ? formatMoney(monthly) : '—'}</td>
      <td style={tdRight}>{annual > 0 ? formatMoney(annual) : '—'}</td>
      <td style={td}><Pill status={s.status} /></td>
      <td style={td}>
        <div style={{ display: 'flex', gap: 4 }}>
          <button
            onClick={() => setFlag(s.id, { is_business: !s.is_business, is_personal: false } as Partial<Subscription>)}
            style={tagBtn(s.is_business && !s.is_personal, '#86c7a3')}
          >Biz</button>
          <button
            onClick={() => setFlag(s.id, { is_personal: !s.is_personal, is_business: false } as Partial<Subscription>)}
            style={tagBtn(s.is_personal, '#f0c47a')}
          >Personal</button>
        </div>
      </td>
      <td style={td}>{s.confidence != null ? `${(s.confidence * 100).toFixed(0)}%` : '—'}</td>
      <td style={td}>
        <div style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
          {s.status !== 'confirmed' && (
            <button
              onClick={() => void setStatus(s.id, 'confirmed')}
              style={{ ...actionBtn, background: '#0d2f1f', color: '#86c7a3', border: '1px solid #1c5135' }}
              title="Confirm this is a real subscription"
            >✓ Keep</button>
          )}
          {s.status !== 'dismissed' && (
            <button
              onClick={() => void setStatus(s.id, 'dismissed')}
              style={{ ...actionBtn, background: '#3d1818', color: '#e9a3a3', border: '1px solid #5d2828' }}
              title="Dismiss — not a real subscription / wrong / duplicate"
            >✕ Dismiss</button>
          )}
          {s.status === 'dismissed' && (
            <button
              onClick={() => void setStatus(s.id, 'candidate')}
              style={{ ...actionBtn, background: 'transparent', color: '#888', border: '1px solid #333' }}
            >↺ Restore</button>
          )}
          <AllocationSplitButton
            resourceType="subscription"
            resourceId={s.id}
            hostOrgId={s.organization_id}
            label="⊟ Split"
            onSaved={() => refresh()}
          />
          <MoveToOrgButton
            table="subscriptions"
            rowId={s.id}
            currentOrgId={s.organization_id}
            fkColumnsToNull={['supplier_id']}
            label="⇄ Move"
            onMoved={() => refresh()}
          />
        </div>
      </td>
    </tr>
  );
}

function Kpi({ label, value, colour, sub }: { label: string; value: string; colour: string; sub?: string | undefined }) {
  return (
    <div style={{ padding: 12, background: '#1a1a1a', border: '1px solid #2a2a2a', borderRadius: 6 }}>
      <div style={{ fontSize: 10, color: '#666', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ marginTop: 4, fontSize: 18, color: colour, fontWeight: 600 }}>{value}</div>
      {sub && <div style={{ marginTop: 3, fontSize: 11, color: '#888' }}>{sub}</div>}
    </div>
  );
}
function Pill({ status }: { status: string }) {
  const c = status === 'confirmed' ? '#86c7a3'
    : status === 'candidate' ? '#5096d8'
    : status === 'cancelled' ? '#666'
    : status === 'dismissed' ? '#d2c886' : '#888';
  return <span style={{ padding: '0.15rem 0.5rem', fontSize: 11, borderRadius: 3, background: '#222', color: c, textTransform: 'uppercase', marginRight: 4 }}>{status}</span>;
}
function tagBtn(active: boolean, colour: string): React.CSSProperties {
  return {
    padding: '0.15rem 0.5rem',
    background: active ? '#222' : 'transparent',
    color: active ? colour : '#666',
    border: '1px solid ' + (active ? colour : '#333'),
    borderRadius: 3, fontSize: 10, cursor: 'pointer', fontWeight: active ? 600 : 400,
  };
}

const th: React.CSSProperties = { padding: '0.4rem 0.5rem', textAlign: 'left', fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 500 };
const thRight: React.CSSProperties = { ...th, textAlign: 'right' };
const td: React.CSSProperties = { padding: '0.5rem' };
const tdRight: React.CSSProperties = { ...td, textAlign: 'right' };
const actionBtn: React.CSSProperties = {
  padding: '0.15rem 0.5rem',
  borderRadius: 3,
  fontSize: 10,
  cursor: 'pointer',
  fontWeight: 500,
};
