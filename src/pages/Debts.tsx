import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/contexts/OrgContext';
import { formatMoney } from '@/lib/money';
import { SkeletonTable } from '@/components/Skeleton';

interface Debt {
  id: string;
  name: string;
  kind: string;
  lender_name: string | null;
  account_number_last4: string | null;
  original_balance_cents: number | null;
  current_balance_cents: number;
  interest_rate_pct: number | null;
  minimum_payment_cents: number | null;
  payment_due_day: number | null;
  start_date: string | null;
  end_date: string | null;
  is_personal: boolean;
  notes: string | null;
}

interface Payment {
  id: string;
  debt_id: string;
  paid_at: string;
  total_cents: number;
  principal_cents: number | null;
  interest_cents: number | null;
  fees_cents: number | null;
}

const DEBT_KINDS = ['credit_card', 'personal_loan', 'mortgage', 'business_loan', 'overdraft', 'tax_debt', 'other'];

export function DebtsPage() {
  const { currentOrg } = useOrg();
  const navigate = useNavigate();
  const [debts, setDebts] = useState<Debt[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);

  const refresh = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);
    const [debtsRes, paysRes] = await Promise.all([
      supabase.from('debts').select('*').eq('organization_id', currentOrg.id).order('current_balance_cents', { ascending: false }),
      supabase.from('debt_payments').select('*').eq('organization_id', currentOrg.id).order('paid_at', { ascending: false }).limit(20),
    ]);
    setDebts((debtsRes.data ?? []) as Debt[]);
    setPayments((paysRes.data ?? []) as Payment[]);
    setLoading(false);
  }, [currentOrg]);

  useEffect(() => void refresh(), [refresh]);

  if (!currentOrg) return null;

  const businessDebt = debts.filter((d) => !d.is_personal).reduce((a, d) => a + d.current_balance_cents, 0);
  const personalDebt = debts.filter((d) => d.is_personal).reduce((a, d) => a + d.current_balance_cents, 0);
  const totalMinPayments = debts.reduce((a, d) => a + (d.minimum_payment_cents ?? 0), 0);

  return (
    <section>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
        <h1 style={{ margin: 0 }}>Debts</h1>
        <button onClick={() => setShowAdd(true)} style={btnPrim}>+ Add debt</button>
      </div>
      <p style={{ color: '#888', fontSize: 13 }}>
        Loans, credit cards, overdrafts. Tracks balance, interest rate, and monthly minimum so you know what's eating cash.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, maxWidth: 900, marginTop: 16 }}>
        <Kpi label="Business debt" value={formatMoney(businessDebt)} colour="#e9a3a3" />
        <Kpi label="Personal debt" value={formatMoney(personalDebt)} colour="#f0c47a" />
        <Kpi label="Min monthly payments" value={formatMoney(totalMinPayments)} colour="#aaa" sub="all debts combined" />
      </div>

      {showAdd && <AddDebtForm onClose={() => setShowAdd(false)} onAdded={() => { setShowAdd(false); void refresh(); }} />}

      <h2 style={h2}>Debts</h2>
      {loading ? <SkeletonTable rows={4} cols={7} /> : debts.length === 0 ? (
        <p style={{ color: '#888', fontSize: 13 }}>No debts tracked yet. Add one to start watching the cash bleed.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead><tr style={{ borderBottom: '1px solid #2a2a2a' }}>
              <th style={th}>Name</th><th style={th}>Kind</th><th style={th}>Lender</th>
              <th style={thRight}>Balance</th><th style={thRight}>Interest %</th>
              <th style={thRight}>Min payment</th><th style={th}>Tag</th>
            </tr></thead>
            <tbody>
              {debts.map((d) => (
                <tr
                  key={d.id}
                  style={{ borderBottom: '1px solid #1a1a1a', cursor: 'pointer' }}
                  onClick={() => navigate(`/debts/${d.id}`)}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLTableRowElement).style.background = '#202020'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLTableRowElement).style.background = ''; }}
                >
                  <td style={td}><strong>{d.name}</strong></td>
                  <td style={td}>{d.kind.replace(/_/g, ' ')}</td>
                  <td style={td}>{d.lender_name ?? '—'}{d.account_number_last4 ? <span style={{ color: '#666' }}> ···{d.account_number_last4}</span> : null}</td>
                  <td style={tdRight}><strong>{formatMoney(d.current_balance_cents)}</strong></td>
                  <td style={tdRight}>{d.interest_rate_pct != null ? `${Number(d.interest_rate_pct).toFixed(2)}%` : '—'}</td>
                  <td style={tdRight}>{d.minimum_payment_cents != null ? formatMoney(d.minimum_payment_cents) : '—'}</td>
                  <td style={td}>{d.is_personal ? <Pill colour="#f0c47a">Personal</Pill> : <Pill colour="#86c7a3">Business</Pill>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 style={h2}>Recent payments</h2>
      {payments.length === 0 ? (
        <p style={{ color: '#888', fontSize: 13 }}>No payments recorded yet.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead><tr style={{ borderBottom: '1px solid #2a2a2a' }}>
              <th style={th}>Date</th><th style={th}>Debt</th>
              <th style={thRight}>Total</th><th style={thRight}>Principal</th><th style={thRight}>Interest</th>
            </tr></thead>
            <tbody>
              {payments.map((p) => {
                const debt = debts.find((d) => d.id === p.debt_id);
                return (
                  <tr key={p.id} style={{ borderBottom: '1px solid #1a1a1a' }}>
                    <td style={td}>{p.paid_at.slice(0, 10)}</td>
                    <td style={td}>{debt?.name ?? '—'}</td>
                    <td style={tdRight}>{formatMoney(p.total_cents)}</td>
                    <td style={tdRight}>{p.principal_cents != null ? formatMoney(p.principal_cents) : '—'}</td>
                    <td style={tdRight}>{p.interest_cents != null ? formatMoney(p.interest_cents) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p style={{ marginTop: 32, padding: 10, background: '#0e0e0e', border: '1px dashed #2a2a2a', borderRadius: 4, fontSize: 12, color: '#666' }}>
        Future: amortisation schedule, "snowball vs avalanche" payoff strategies, payment auto-match from bank_transactions, alerts when payment due.
      </p>
    </section>
  );
}

function AddDebtForm({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const { currentOrg } = useOrg();
  const [name, setName] = useState('');
  const [kind, setKind] = useState('credit_card');
  const [lender, setLender] = useState('');
  const [balance, setBalance] = useState(0);
  const [interestPct, setInterestPct] = useState(20);
  const [minPayment, setMinPayment] = useState(0);
  const [isPersonal, setIsPersonal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!currentOrg) return;
    setBusy(true);
    const { error } = await supabase.from('debts').insert({
      organization_id: currentOrg.id,
      name: name.trim(),
      kind,
      lender_name: lender.trim() || null,
      original_balance_cents: Math.round(balance * 100),
      current_balance_cents: Math.round(balance * 100),
      interest_rate_pct: interestPct,
      minimum_payment_cents: Math.round(minPayment * 100),
      is_personal: isPersonal,
    });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    onAdded();
  };

  return (
    <div style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h3 style={{ fontSize: 14, margin: 0 }}>Add debt</h3>
        <button onClick={onClose} style={closeBtn}>×</button>
      </div>
      <div style={grid2}>
        <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. CommBank Visa" style={inp} /></Field>
        <Field label="Kind">
          <select value={kind} onChange={(e) => setKind(e.target.value)} style={inp}>
            {DEBT_KINDS.map((k) => <option key={k} value={k}>{k.replace(/_/g, ' ')}</option>)}
          </select>
        </Field>
      </div>
      <div style={grid2}>
        <Field label="Lender"><input value={lender} onChange={(e) => setLender(e.target.value)} style={inp} /></Field>
        <Field label="Personal?">
          <select value={isPersonal ? 'true' : 'false'} onChange={(e) => setIsPersonal(e.target.value === 'true')} style={inp}>
            <option value="false">Business</option>
            <option value="true">Personal</option>
          </select>
        </Field>
      </div>
      <div style={grid2}>
        <Field label="Current balance ($)"><input type="number" step="0.01" value={balance} onChange={(e) => setBalance(parseFloat(e.target.value) || 0)} style={inp} /></Field>
        <Field label="Interest rate %"><input type="number" step="0.01" value={interestPct} onChange={(e) => setInterestPct(parseFloat(e.target.value) || 0)} style={inp} /></Field>
      </div>
      <Field label="Min monthly payment ($)"><input type="number" step="0.01" value={minPayment} onChange={(e) => setMinPayment(parseFloat(e.target.value) || 0)} style={inp} /></Field>
      <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
        <button onClick={submit} disabled={busy || !name.trim() || balance <= 0} style={btnPrim}>{busy ? 'Adding…' : 'Add debt'}</button>
        <button onClick={onClose} disabled={busy} style={btnGhost}>Cancel</button>
      </div>
      {err && <p style={{ color: 'salmon', fontSize: 12, marginTop: 8 }}>{err}</p>}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label style={{ display: 'block', fontSize: 11, color: '#888', marginTop: 6 }}><div style={{ marginBottom: 3 }}>{label}</div>{children}</label>;
}
function Kpi({ label, value, colour, sub }: { label: string; value: string; colour: string; sub?: string }) {
  return (
    <div style={{ padding: 12, background: '#1a1a1a', border: '1px solid #2a2a2a', borderRadius: 6 }}>
      <div style={{ fontSize: 10, color: '#666', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ marginTop: 4, fontSize: 18, color: colour, fontWeight: 600 }}>{value}</div>
      {sub && <div style={{ marginTop: 3, fontSize: 11, color: '#888' }}>{sub}</div>}
    </div>
  );
}
function Pill({ children, colour }: { children: React.ReactNode; colour: string }) {
  return <span style={{ padding: '0.15rem 0.5rem', fontSize: 11, borderRadius: 3, background: '#222', color: colour, textTransform: 'uppercase' }}>{children}</span>;
}
const card: React.CSSProperties = { marginTop: 16, padding: 16, background: '#0e0e0e', border: '1px solid #2a2a2a', borderRadius: 6, maxWidth: 720 };
const grid2: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 };
const inp: React.CSSProperties = { width: '100%', padding: '6px 8px', background: '#000', color: '#ddd', border: '1px solid #333', borderRadius: 3, fontSize: 12 };
const h2: React.CSSProperties = { fontSize: 14, marginTop: 24, marginBottom: 8 };
const th: React.CSSProperties = { padding: '0.4rem 0.5rem', textAlign: 'left', fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 500 };
const thRight: React.CSSProperties = { ...th, textAlign: 'right' };
const td: React.CSSProperties = { padding: '0.5rem' };
const tdRight: React.CSSProperties = { ...td, textAlign: 'right' };
const btnPrim: React.CSSProperties = { padding: '0.4rem 1rem', background: '#1c4868', color: '#fff', border: '1px solid #5096d8', borderRadius: 4, fontSize: 12, fontWeight: 600, cursor: 'pointer' };
const btnGhost: React.CSSProperties = { padding: '0.4rem 1rem', background: 'transparent', color: '#aaa', border: '1px solid #333', borderRadius: 4, fontSize: 12, cursor: 'pointer' };
const closeBtn: React.CSSProperties = { background: 'transparent', color: '#888', border: 'none', fontSize: 18, cursor: 'pointer', padding: 0 };
