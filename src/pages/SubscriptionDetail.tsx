import { useEffect, useMemo, useState, useCallback } from 'react';
import { Link, useParams } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/contexts/OrgContext';
import { formatMoney, formatMoneyCompact } from '@/lib/money';
import { MoveToOrgButton } from '@/components/MoveToOrgButton';

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

// Mirror of supabase/functions/subscriptions-detect/index.ts:173 canonicaliseDescription.
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
      // Pull last 24 months of debit txns and filter by canonical key match.
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
    // Mutually-exclusive personal/business — guard at save time.
    let isPersonal = !!draft.is_personal;
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

  // Monthly bars (last 8 months) — built off the filtered txns.
  const monthlyBars = useMemo(() => {
    const now = new Date();
    const buckets: Array<{ label: string; value: number }> = [];
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
  if (loading) return <section><h1>Subscription</h1><p style={{ color: '#888' }}>Loading…</p></section>;
  if (!sub)
    return (
      <section>
        <h1>Subscription not found</h1>
        <Link to="/subscriptions" style={{ color: '#86c7a3' }}>&larr; Back to subscriptions</Link>
      </section>
    );

  const monthly = monthlyEquivalent(sub.amount_cents, sub.cadence);
  const annual = monthly * 12;

  return (
    <section>
      <Link to="/subscriptions" style={{ color: '#86c7a3', fontSize: 13 }}>&larr; All subscriptions</Link>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: '0.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
          <h1 style={{ margin: 0 }}>{sub.merchant_name}</h1>
          <StatusPill status={sub.status} />
        </div>
        {!editing && (
          <span style={{ display: 'inline-flex', gap: 8 }}>
            <button onClick={redetect} disabled={redetecting} style={btnPrim} title="Re-run subscription detection across the org">
              {redetecting ? 'Detecting…' : '↻ Re-detect'}
            </button>
            <MoveToOrgButton
              table="subscriptions"
              rowId={sub.id}
              currentOrgId={currentOrg.id}
              fkColumnsToNull={['supplier_id']}
              onMoved={() => { window.location.href = '/subscriptions'; }}
            />
            <button onClick={startEdit} style={btnGhost}>✎ Edit</button>
          </span>
        )}
      </div>
      {redetectMsg && (
        <p style={{ marginTop: 4, fontSize: 12, color: redetectMsg.startsWith('Detection error') ? 'salmon' : '#86c7a3' }}>
          {redetectMsg}
        </p>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginTop: 16, maxWidth: 1100 }}>
        <KpiCard label="Amount" value={formatMoney(sub.amount_cents)} colour="#d2c886" sub={sub.cadence} />
        <KpiCard label="Monthly equivalent" value={formatMoney(monthly)} colour="#5096d8" />
        <KpiCard label="Annual equivalent" value={formatMoney(annual)} colour="#86c7a3" />
        <KpiCard label="Next expected" value={sub.next_expected_at ?? '—'} colour="#aaa" />
        <KpiCard label="Observed count" value={String(sub.observed_count)} colour="#aaa" sub="bank-txn matches" />
        <KpiCard label="Total spent" value={formatMoney(sub.total_spent_cents)} colour="#e9a3a3" sub="lifetime to date" />
      </div>

      {editing ? (
        <div style={card}>
          <div style={grid2}>
            <Field label="Status">
              <select value={String(draft.status ?? sub.status)} onChange={(e) => setDraft({ ...draft, status: e.target.value })} style={inp}>
                {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </Field>
            <Field label="Cadence override">
              <select value={String(draft.cadence ?? sub.cadence)} onChange={(e) => setDraft({ ...draft, cadence: e.target.value })} style={inp}>
                {CADENCE_OPTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </Field>
          </div>
          <div style={grid2}>
            <Field label="Tag (mutually exclusive)">
              <div style={{ display: 'flex', gap: 4 }}>
                <button
                  type="button"
                  onClick={() => setDraft({ ...draft, is_business: !draft.is_business, is_personal: false })}
                  style={tagBtn(!!draft.is_business && !draft.is_personal, '#86c7a3')}
                >Business</button>
                <button
                  type="button"
                  onClick={() => setDraft({ ...draft, is_personal: !draft.is_personal, is_business: false })}
                  style={tagBtn(!!draft.is_personal, '#f0c47a')}
                >Personal</button>
              </div>
            </Field>
            <div />
          </div>
          <Field label="Notes"><textarea rows={3} value={String(draft.notes ?? '')} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} style={inp} /></Field>
          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <button onClick={save} disabled={saving} style={btnPrim}>{saving ? 'Saving…' : 'Save'}</button>
            <button onClick={() => setEditing(false)} disabled={saving} style={btnGhost}>Cancel</button>
          </div>
          {error && <p style={{ color: 'salmon', fontSize: 12, marginTop: 8 }}>{error}</p>}
        </div>
      ) : (
        <div style={{ ...card, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
          <Stat label="Cadence" value={sub.cadence} />
          <Stat label="Currency" value={sub.currency_code ?? 'AUD'} />
          <Stat label="Confidence" value={sub.confidence != null ? `${(sub.confidence * 100).toFixed(0)}%` : '—'} />
          <Stat label="First seen" value={sub.first_seen_at?.slice(0, 10) ?? '—'} />
          <Stat label="Last seen" value={sub.last_seen_at?.slice(0, 10) ?? '—'} />
          <Stat label="Tag" value={sub.is_business ? 'Business' : sub.is_personal ? 'Personal' : '—'} />
          <Stat label="Canonical key" value={sub.merchant_canonical_key ?? '—'} mono />
          <Stat label="Detection reason" value={sub.detection_reason ?? '—'} />
          <Stat label="Notes" value={sub.notes ?? '—'} />
        </div>
      )}

      <h2 style={h2}>History — last 8 months</h2>
      {monthlyBars.every((b) => b.value === 0) ? (
        <p style={{ color: '#888', fontSize: 13 }}>No matching transactions in the last 8 months.</p>
      ) : (
        <MonthlyBars bars={monthlyBars} />
      )}

      <h2 style={h2}>Recent transactions (last 24 months)</h2>
      {txns.length === 0 ? (
        <p style={{ color: '#888', fontSize: 13 }}>No matching bank transactions found for canonical key <code style={{ color: '#aaa' }}>{sub.merchant_canonical_key ?? '—'}</code>.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #2a2a2a' }}>
              <th style={th}>Date</th>
              <th style={th}>Description</th>
              <th style={thRight}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {txns.map((t) => (
              <tr key={t.id} style={{ borderBottom: '1px solid #1a1a1a' }}>
                <td style={td}>{t.posted_at.slice(0, 10)}</td>
                <td style={td}><code style={{ color: '#aaa', fontSize: 12 }}>{t.description}</code></td>
                <td style={tdRight}>{formatMoney(Math.abs(t.amount_cents))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Inline-SVG bar chart — same colour vocabulary as Suppliers HorizontalBarChart.
// ---------------------------------------------------------------------------
function MonthlyBars({ bars }: { bars: Array<{ label: string; value: number }> }) {
  const BAR_W = 40;
  const GAP = 14;
  const HEIGHT = 120;
  const LABEL_H = 32;
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
            <rect x={x} y={0} width={BAR_W} height={HEIGHT} fill="#1a1a1a" rx={3} />
            <rect x={x} y={y} width={BAR_W} height={h} fill="#2da565" rx={3} />
            <text x={x + BAR_W / 2} y={HEIGHT + 14} textAnchor="middle" fill="#aaa" fontSize={11}>{b.label}</text>
            <text x={x + BAR_W / 2} y={HEIGHT + 28} textAnchor="middle" fill="#86c7a3" fontSize={10} fontWeight={600}>
              {b.value > 0 ? formatMoneyCompact(b.value) : ''}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Shared chrome — copied from CustomerDetail / SupplierDetail.
// ---------------------------------------------------------------------------
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block', fontSize: 11, color: '#888', marginTop: 6 }}>
      <div style={{ marginBottom: 3 }}>{label}</div>
      {children}
    </label>
  );
}

function Stat({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: '#666', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ marginTop: 3, color: '#ddd', fontSize: 13, fontFamily: mono ? 'monospace' : 'inherit' }}>{value}</div>
    </div>
  );
}

function KpiCard({ label, value, colour, sub }: { label: string; value: string; colour: string; sub?: string }) {
  return (
    <div style={{ padding: 16, background: '#1a1a1a', border: '1px solid #2a2a2a', borderRadius: 6 }}>
      <div style={{ fontSize: 10, color: '#666', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ marginTop: 6, fontSize: 22, color: colour, fontWeight: 600 }}>{value}</div>
      {sub && <div style={{ marginTop: 4, fontSize: 11, color: '#888' }}>{sub}</div>}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const c = status === 'confirmed' ? '#86c7a3'
    : status === 'detected' ? '#5096d8'
    : status === 'cancelled' ? '#666'
    : status === 'paused' ? '#d2c886'
    : '#888';
  return <span style={{ padding: '0.15rem 0.5rem', fontSize: 11, borderRadius: 3, background: '#222', color: c, textTransform: 'uppercase' }}>{status}</span>;
}

function tagBtn(active: boolean, colour: string): React.CSSProperties {
  return {
    padding: '0.3rem 0.75rem',
    background: active ? '#222' : 'transparent',
    color: active ? colour : '#666',
    border: '1px solid ' + (active ? colour : '#333'),
    borderRadius: 3, fontSize: 12, cursor: 'pointer', fontWeight: active ? 600 : 400,
  };
}

const card: React.CSSProperties = { marginTop: 16, padding: 16, background: '#0e0e0e', border: '1px solid #2a2a2a', borderRadius: 6, maxWidth: 920 };
const grid2: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 };
const inp: React.CSSProperties = { width: '100%', padding: '6px 8px', background: '#000', color: '#ddd', border: '1px solid #333', borderRadius: 3, fontSize: 12 };
const h2: React.CSSProperties = { fontSize: 14, marginTop: 24, marginBottom: 8 };
const th: React.CSSProperties = { padding: '0.4rem 0.5rem', textAlign: 'left', fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 500 };
const thRight: React.CSSProperties = { ...th, textAlign: 'right' };
const td: React.CSSProperties = { padding: '0.5rem' };
const tdRight: React.CSSProperties = { ...td, textAlign: 'right' };
const btnPrim: React.CSSProperties = { padding: '0.4rem 1rem', background: '#1c4868', color: '#fff', border: '1px solid #5096d8', borderRadius: 4, fontSize: 12, fontWeight: 600, cursor: 'pointer' };
const btnGhost: React.CSSProperties = { padding: '0.4rem 1rem', background: 'transparent', color: '#aaa', border: '1px solid #333', borderRadius: 4, fontSize: 12, cursor: 'pointer' };
