import { useEffect, useState, useCallback } from 'react';
import { Link, useParams } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/contexts/OrgContext';
import { formatMoney } from '@/lib/money';
import { MoveToOrgButton } from '@/components/MoveToOrgButton';

interface Debt {
  id: string;
  organization_id: string;
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
  notes: string | null;
}

const DEBT_KINDS = ['credit_card', 'personal_loan', 'mortgage', 'business_loan', 'overdraft', 'tax_debt', 'other'];

export function DebtDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { currentOrg } = useOrg();
  const [debt, setDebt] = useState<Debt | null>(null);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Partial<Debt>>({});
  const [saving, setSaving] = useState(false);
  const [showRecord, setShowRecord] = useState(false);

  const refresh = useCallback(async () => {
    if (!currentOrg || !id) return;
    setLoading(true);
    setError(null);
    const [debtRes, payRes] = await Promise.all([
      supabase.from('debts').select('*').eq('id', id).eq('organization_id', currentOrg.id).maybeSingle(),
      supabase.from('debt_payments').select('*').eq('debt_id', id).eq('organization_id', currentOrg.id).order('paid_at', { ascending: false }),
    ]);
    if (debtRes.error) {
      setError(debtRes.error.message);
      setLoading(false);
      return;
    }
    setDebt((debtRes.data ?? null) as Debt | null);
    setPayments((payRes.data ?? []) as Payment[]);
    setLoading(false);
  }, [currentOrg, id]);

  useEffect(() => void refresh(), [refresh]);

  const startEdit = () => {
    if (!debt) return;
    setDraft({
      lender_name: debt.lender_name ?? '',
      account_number_last4: debt.account_number_last4 ?? '',
      current_balance_cents: debt.current_balance_cents,
      interest_rate_pct: debt.interest_rate_pct,
      minimum_payment_cents: debt.minimum_payment_cents,
      payment_due_day: debt.payment_due_day,
      is_personal: debt.is_personal,
      notes: debt.notes ?? '',
      kind: debt.kind,
    });
    setEditing(true);
  };

  const save = async () => {
    if (!debt) return;
    setSaving(true);
    setError(null);
    const payload: Partial<Debt> = {
      kind: draft.kind ?? debt.kind,
      lender_name: draft.lender_name?.toString().trim() || null,
      account_number_last4: draft.account_number_last4?.toString().trim() || null,
      current_balance_cents: Number(draft.current_balance_cents ?? debt.current_balance_cents),
      interest_rate_pct: draft.interest_rate_pct == null ? null : Number(draft.interest_rate_pct),
      minimum_payment_cents: draft.minimum_payment_cents == null ? null : Number(draft.minimum_payment_cents),
      payment_due_day: draft.payment_due_day == null ? null : Number(draft.payment_due_day),
      is_personal: !!draft.is_personal,
      notes: draft.notes?.toString().trim() || null,
    };
    const { error: e } = await supabase.from('debts').update(payload).eq('id', debt.id);
    setSaving(false);
    if (e) {
      setError(e.message);
      return;
    }
    setEditing(false);
    void refresh();
  };

  const deletePayment = async (pid: string) => {
    if (!debt) return;
    if (!confirm('Delete this payment? Balance will be reverted by the principal portion.')) return;
    const p = payments.find((x) => x.id === pid);
    const { error: e } = await supabase.from('debt_payments').delete().eq('id', pid);
    if (e) {
      setError(e.message);
      return;
    }
    if (p && p.principal_cents) {
      // Revert principal back onto the balance.
      await supabase
        .from('debts')
        .update({ current_balance_cents: debt.current_balance_cents + p.principal_cents })
        .eq('id', debt.id);
    }
    void refresh();
  };

  if (!currentOrg) return null;
  if (loading) return <section><h1>Debt</h1><p style={{ color: '#888' }}>Loading…</p></section>;
  if (!debt)
    return (
      <section>
        <h1>Debt not found</h1>
        <Link to="/debts" style={{ color: '#86c7a3' }}>&larr; Back to debts</Link>
      </section>
    );

  const original = debt.original_balance_cents ?? debt.current_balance_cents;
  const paidDown = Math.max(0, original - debt.current_balance_cents);

  // Amortisation projection.
  const projection = computePayoffMonths({
    balance_cents: debt.current_balance_cents,
    interest_rate_pct: debt.interest_rate_pct,
    minimum_payment_cents: debt.minimum_payment_cents,
  });

  return (
    <section>
      <Link to="/debts" style={{ color: '#86c7a3', fontSize: 13 }}>&larr; All debts</Link>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: '0.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
          <h1 style={{ margin: 0 }}>{debt.name}</h1>
          <KindPill kind={debt.kind} />
          {debt.is_personal ? <KindPill kind="personal" colour="#f0c47a" /> : <KindPill kind="business" colour="#86c7a3" />}
        </div>
        {!editing && (
          <span style={{ display: 'inline-flex', gap: 8 }}>
            <button onClick={() => setShowRecord(true)} style={btnPrim}>+ Record payment</button>
            <MoveToOrgButton
              // The MoveToOrgButton type union doesn't yet list 'debts' — narrow assertion to keep
              // this page self-contained per the work order ("DO NOT touch any other files").
              table={'debts' as 'subscriptions'}
              rowId={debt.id}
              currentOrgId={currentOrg.id}
              onMoved={() => { window.location.href = '/debts'; }}
            />
            <button onClick={startEdit} style={btnGhost}>✎ Edit</button>
          </span>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginTop: 16, maxWidth: 1100 }}>
        <KpiCard label="Current balance" value={formatMoney(debt.current_balance_cents)} colour="#e9a3a3" />
        <KpiCard label="Original balance" value={formatMoney(original)} colour="#aaa" />
        <KpiCard label="Paid down" value={formatMoney(paidDown)} colour="#86c7a3" {...(original > 0 ? { sub: `${((paidDown / original) * 100).toFixed(1)}%` } : {})} />
        <KpiCard label="Interest rate" value={debt.interest_rate_pct != null ? `${Number(debt.interest_rate_pct).toFixed(2)}%` : '—'} colour="#d2c886" />
        <KpiCard label="Min payment" value={debt.minimum_payment_cents != null ? formatMoney(debt.minimum_payment_cents) : '—'} colour="#aaa" {...(debt.payment_due_day != null ? { sub: `due day ${debt.payment_due_day}` } : {})} />
        <KpiCard
          label="Months to payoff"
          value={projection.kind === 'ok' ? `${projection.months}` : projection.kind === 'never' ? 'never' : '—'}
          colour={projection.kind === 'ok' ? '#5096d8' : projection.kind === 'never' ? '#e9a3a3' : '#666'}
          {...(projection.note ? { sub: projection.note } : {})}
        />
      </div>

      {editing ? (
        <div style={card}>
          <div style={grid2}>
            <Field label="Kind">
              <select value={String(draft.kind ?? debt.kind)} onChange={(e) => setDraft({ ...draft, kind: e.target.value })} style={inp}>
                {DEBT_KINDS.map((k) => <option key={k} value={k}>{k.replace(/_/g, ' ')}</option>)}
              </select>
            </Field>
            <Field label="Lender">
              <input value={String(draft.lender_name ?? '')} onChange={(e) => setDraft({ ...draft, lender_name: e.target.value })} style={inp} />
            </Field>
          </div>
          <div style={grid2}>
            <Field label="Account # (last 4)">
              <input value={String(draft.account_number_last4 ?? '')} onChange={(e) => setDraft({ ...draft, account_number_last4: e.target.value })} style={inp} maxLength={4} />
            </Field>
            <Field label="Personal?">
              <select value={draft.is_personal ? 'true' : 'false'} onChange={(e) => setDraft({ ...draft, is_personal: e.target.value === 'true' })} style={inp}>
                <option value="false">Business</option>
                <option value="true">Personal</option>
              </select>
            </Field>
          </div>
          <div style={grid2}>
            <Field label="Current balance ($)">
              <input
                type="number" step="0.01"
                value={(Number(draft.current_balance_cents ?? debt.current_balance_cents) / 100).toString()}
                onChange={(e) => setDraft({ ...draft, current_balance_cents: Math.round(parseFloat(e.target.value || '0') * 100) })}
                style={inp}
              />
            </Field>
            <Field label="Interest rate %">
              <input
                type="number" step="0.01"
                value={draft.interest_rate_pct == null ? '' : String(draft.interest_rate_pct)}
                onChange={(e) => setDraft({ ...draft, interest_rate_pct: e.target.value === '' ? null : Number(e.target.value) })}
                style={inp}
              />
            </Field>
          </div>
          <div style={grid2}>
            <Field label="Min monthly payment ($)">
              <input
                type="number" step="0.01"
                value={draft.minimum_payment_cents == null ? '' : (Number(draft.minimum_payment_cents) / 100).toString()}
                onChange={(e) => setDraft({ ...draft, minimum_payment_cents: e.target.value === '' ? null : Math.round(parseFloat(e.target.value) * 100) })}
                style={inp}
              />
            </Field>
            <Field label="Payment due day (1-31)">
              <input
                type="number" min={1} max={31}
                value={draft.payment_due_day == null ? '' : String(draft.payment_due_day)}
                onChange={(e) => setDraft({ ...draft, payment_due_day: e.target.value === '' ? null : Number(e.target.value) })}
                style={inp}
              />
            </Field>
          </div>
          <Field label="Notes">
            <textarea rows={3} value={String(draft.notes ?? '')} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} style={inp} />
          </Field>
          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <button onClick={save} disabled={saving} style={btnPrim}>{saving ? 'Saving…' : 'Save'}</button>
            <button onClick={() => setEditing(false)} disabled={saving} style={btnGhost}>Cancel</button>
          </div>
          {error && <p style={{ color: 'salmon', fontSize: 12, marginTop: 8 }}>{error}</p>}
        </div>
      ) : (
        <div style={{ ...card, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
          <Stat label="Lender" value={debt.lender_name ?? '—'} />
          <Stat label="Account" value={debt.account_number_last4 ? `···${debt.account_number_last4}` : '—'} mono />
          <Stat label="Kind" value={debt.kind.replace(/_/g, ' ')} />
          <Stat label="Start date" value={debt.start_date?.slice(0, 10) ?? '—'} />
          <Stat label="End date" value={debt.end_date?.slice(0, 10) ?? '—'} />
          <Stat label="Tag" value={debt.is_personal ? 'Personal' : 'Business'} />
          <Stat label="Notes" value={debt.notes ?? '—'} />
        </div>
      )}

      {showRecord && (
        <RecordPaymentModal
          debt={debt}
          onClose={() => setShowRecord(false)}
          onRecorded={() => { setShowRecord(false); void refresh(); }}
        />
      )}

      <h2 style={h2}>Payment history</h2>
      {payments.length === 0 ? (
        <p style={{ color: '#888', fontSize: 13 }}>No payments recorded yet.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #2a2a2a' }}>
              <th style={th}>Date</th>
              <th style={thRight}>Total</th>
              <th style={thRight}>Principal</th>
              <th style={thRight}>Interest</th>
              <th style={thRight}>Fees</th>
              <th style={th}>Notes</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {payments.map((p) => (
              <tr key={p.id} style={{ borderBottom: '1px solid #1a1a1a' }}>
                <td style={td}>{p.paid_at.slice(0, 10)}</td>
                <td style={tdRight}><strong>{formatMoney(p.total_cents)}</strong></td>
                <td style={tdRight}>{p.principal_cents != null ? formatMoney(p.principal_cents) : '—'}</td>
                <td style={tdRight}>{p.interest_cents != null ? formatMoney(p.interest_cents) : '—'}</td>
                <td style={tdRight}>{p.fees_cents != null ? formatMoney(p.fees_cents) : '—'}</td>
                <td style={td}><span style={{ color: '#888', fontSize: 12 }}>{p.notes ?? ''}</span></td>
                <td style={td}>
                  <button onClick={() => void deletePayment(p.id)} style={btnTiny}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p style={{ marginTop: 32, padding: 10, background: '#0e0e0e', border: '1px dashed #2a2a2a', borderRadius: 4, fontSize: 12, color: '#666' }}>
        Future: snowball/avalanche planner, payment auto-match against bank_transactions, reminders before payment_due_day.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Record-payment modal — inserts into debt_payments and decrements balance.
// ---------------------------------------------------------------------------
function RecordPaymentModal({ debt, onClose, onRecorded }: { debt: Debt; onClose: () => void; onRecorded: () => void }) {
  const { currentOrg } = useOrg();
  const [paidAt, setPaidAt] = useState(new Date().toISOString().slice(0, 10));
  const [total, setTotal] = useState((debt.minimum_payment_cents ?? 0) / 100);
  const [principal, setPrincipal] = useState(0);
  const [interest, setInterest] = useState(0);
  const [fees, setFees] = useState(0);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!currentOrg) return;
    setBusy(true);
    setErr(null);
    const totalC = Math.round(total * 100);
    const principalC = Math.round(principal * 100);
    const interestC = Math.round(interest * 100);
    const feesC = Math.round(fees * 100);
    const { error: insertErr } = await supabase.from('debt_payments').insert({
      organization_id: currentOrg.id,
      debt_id: debt.id,
      paid_at: paidAt,
      total_cents: totalC,
      principal_cents: principalC || null,
      interest_cents: interestC || null,
      fees_cents: feesC || null,
      notes: notes.trim() || null,
    });
    if (insertErr) { setBusy(false); setErr(insertErr.message); return; }
    if (principalC > 0) {
      const { error: updErr } = await supabase
        .from('debts')
        .update({ current_balance_cents: Math.max(0, debt.current_balance_cents - principalC) })
        .eq('id', debt.id);
      if (updErr) { setBusy(false); setErr(updErr.message); return; }
    }
    setBusy(false);
    onRecorded();
  };

  return (
    <div style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h3 style={{ fontSize: 14, margin: 0 }}>Record payment — {debt.name}</h3>
        <button onClick={onClose} style={closeBtn}>×</button>
      </div>
      <div style={grid2}>
        <Field label="Paid on"><input type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} style={inp} /></Field>
        <Field label="Total ($)"><input type="number" step="0.01" value={total} onChange={(e) => setTotal(parseFloat(e.target.value) || 0)} style={inp} /></Field>
      </div>
      <div style={grid2}>
        <Field label="Principal ($)"><input type="number" step="0.01" value={principal} onChange={(e) => setPrincipal(parseFloat(e.target.value) || 0)} style={inp} /></Field>
        <Field label="Interest ($)"><input type="number" step="0.01" value={interest} onChange={(e) => setInterest(parseFloat(e.target.value) || 0)} style={inp} /></Field>
      </div>
      <Field label="Fees ($)"><input type="number" step="0.01" value={fees} onChange={(e) => setFees(parseFloat(e.target.value) || 0)} style={inp} /></Field>
      <Field label="Notes"><input value={notes} onChange={(e) => setNotes(e.target.value)} style={inp} /></Field>
      <p style={{ marginTop: 8, fontSize: 12, color: '#86c7a3' }}>
        Principal portion (<strong>{formatMoney(Math.round(principal * 100))}</strong>) will be deducted from the current balance.
      </p>
      <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
        <button onClick={submit} disabled={busy || total <= 0} style={btnPrim}>{busy ? 'Recording…' : 'Record payment'}</button>
        <button onClick={onClose} disabled={busy} style={btnGhost}>Cancel</button>
      </div>
      {err && <p style={{ color: 'salmon', fontSize: 12, marginTop: 8 }}>{err}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Amortisation projection — months to payoff under min payment.
// ---------------------------------------------------------------------------
type Projection =
  | { kind: 'ok'; months: number; note?: string }
  | { kind: 'never'; note?: string }
  | { kind: 'unknown'; note?: string };

function computePayoffMonths(input: { balance_cents: number; interest_rate_pct: number | null; minimum_payment_cents: number | null }): Projection {
  if (input.balance_cents <= 0) return { kind: 'ok', months: 0, note: 'already paid off' };
  if (input.interest_rate_pct == null || input.minimum_payment_cents == null || input.minimum_payment_cents <= 0) {
    return { kind: 'unknown', note: 'set interest rate + min payment for projection' };
  }
  const monthlyRate = Number(input.interest_rate_pct) / 100 / 12;
  const minPayment = input.minimum_payment_cents;
  const balance = input.balance_cents;
  const monthlyInterestAccrued = balance * monthlyRate;

  if (monthlyRate === 0) {
    const months = Math.ceil(balance / minPayment);
    return { kind: 'ok', months, note: `flat-rate (${formatMoney(minPayment)}/mo)` };
  }
  if (minPayment <= monthlyInterestAccrued) {
    return { kind: 'never', note: `min payment ≤ ${formatMoney(Math.round(monthlyInterestAccrued))}/mo interest accrual` };
  }
  // months = ln(P / (P - B*r)) / ln(1 + r)
  const numerator = Math.log(minPayment / (minPayment - balance * monthlyRate));
  const denominator = Math.log(1 + monthlyRate);
  const months = Math.ceil(numerator / denominator);
  return { kind: 'ok', months, note: `at ${formatMoney(minPayment)}/mo · ${(monthlyRate * 12 * 100).toFixed(2)}% APR` };
}

// ---------------------------------------------------------------------------
// Shared chrome.
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

function KindPill({ kind, colour }: { kind: string; colour?: string }) {
  return (
    <span style={{
      padding: '0.15rem 0.5rem', fontSize: 11, borderRadius: 3,
      background: '#222', color: colour ?? '#5096d8', textTransform: 'uppercase',
    }}>{kind.replace(/_/g, ' ')}</span>
  );
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
const btnTiny: React.CSSProperties = { padding: '0.2rem 0.6rem', background: 'transparent', color: '#e9a3a3', border: '1px solid #333', borderRadius: 3, fontSize: 11, cursor: 'pointer' };
const closeBtn: React.CSSProperties = { background: 'transparent', color: '#888', border: 'none', fontSize: 18, cursor: 'pointer', padding: 0 };
