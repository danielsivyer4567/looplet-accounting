import { useEffect, useState, useCallback } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';
import { formatMoney } from '@/lib/money';
import { formatLoadError, formatActionError } from '@/lib/errorMessages';
import { MoveToOrgButton } from '@/components/MoveToOrgButton';
import { DetailPageSkeleton } from '@/components/Skeleton';
import { ArchiveButton } from '@/components/ArchiveButton';
import { orgTimeZone, todayLocal } from '@/lib/localDates';
import {
  ArrowLeft,
  Plus,
  Trash2,
  Edit2,
  X,
  Info,
  TrendingDown,
  DollarSign,
  Calendar,
  Clock,
  AlertCircle,
} from 'lucide-react';

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
  deleted_at: string | null;
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

const DEBT_KINDS = [
  'credit_card',
  'personal_loan',
  'mortgage',
  'business_loan',
  'overdraft',
  'tax_debt',
  'other',
];

export function DebtDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { currentOrg } = useOrg();
  const navigate = useNavigate();
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
      supabase
        .from('debts')
        .select('*')
        .eq('id', id)
        .eq('organization_id', currentOrg.id)
        .maybeSingle(),
      supabase
        .from('debt_payments')
        .select('*')
        .eq('debt_id', id)
        .eq('organization_id', currentOrg.id)
        .order('paid_at', { ascending: false }),
    ]);
    if (debtRes.error) {
      setError(formatLoadError('this debt', debtRes.error.message));
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
      minimum_payment_cents:
        draft.minimum_payment_cents == null ? null : Number(draft.minimum_payment_cents),
      payment_due_day: draft.payment_due_day == null ? null : Number(draft.payment_due_day),
      is_personal: !!draft.is_personal,
      notes: draft.notes?.toString().trim() || null,
    };
    const { error: e } = await supabase.from('debts').update(payload).eq('id', debt.id);
    setSaving(false);
    if (e) {
      setError(formatActionError('save this debt', e.message));
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
      setError(formatActionError('delete this payment', e.message));
      return;
    }
    if (p && p.principal_cents) {
      await supabase
        .from('debts')
        .update({ current_balance_cents: debt.current_balance_cents + p.principal_cents })
        .eq('id', debt.id);
    }
    void refresh();
  };

  if (!currentOrg) return null;
  if (loading) {
    return <DetailPageSkeleton tableCols={4} />;
  }

  if (!debt) {
    return (
      <section
        className="animated-fade-in"
        style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}
      >
        <h1>Debt Account Not Found</h1>
        <Link to="/debts" className="btn btn-secondary" style={{ width: 'fit-content' }}>
          <ArrowLeft className="w-4 h-4" /> Back to Debts
        </Link>
      </section>
    );
  }

  const original = debt.original_balance_cents ?? debt.current_balance_cents;
  const paidDown = Math.max(0, original - debt.current_balance_cents);

  const projection = computePayoffMonths({
    balance_cents: debt.current_balance_cents,
    interest_rate_pct: debt.interest_rate_pct,
    minimum_payment_cents: debt.minimum_payment_cents,
  });

  return (
    <section
      className="animated-fade-in"
      style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}
    >
      <div>
        <Link
          to="/debts"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.25rem',
            fontSize: '0.875rem',
            color: 'var(--text-muted)',
            marginBottom: '1rem',
          }}
        >
          <ArrowLeft className="w-4 h-4" /> Back to all debts
        </Link>

        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '1rem',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
            <h1 style={{ margin: 0 }}>{debt.name}</h1>
            <span className="badge badge-info" style={{ textTransform: 'capitalize' }}>
              {debt.kind.replace(/_/g, ' ')}
            </span>
            {debt.is_personal ? (
              <span className="badge badge-warning">Personal Liability</span>
            ) : (
              <span className="badge badge-success">Business Liability</span>
            )}
          </div>

          {!editing && (
            <div style={{ display: 'inline-flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <button className="btn btn-primary" onClick={() => setShowRecord(true)}>
                <Plus className="w-4 h-4" /> Record Payment
              </button>
              <MoveToOrgButton
                table="debts"
                rowId={debt.id}
                currentOrgId={currentOrg.id}
                onMoved={() => navigate('/debts')}
              />
              <ArchiveButton
                table="debts"
                rowId={debt.id}
                isArchived={!!debt.deleted_at}
                onChange={(nowArchived) => {
                  if (nowArchived) {
                    navigate('/debts');
                  } else {
                    void refresh();
                  }
                }}
              />
              <button className="btn btn-secondary" onClick={startEdit}>
                <Edit2 className="w-4 h-4" /> Edit Account
              </button>
            </div>
          )}
        </div>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          gap: '1rem',
        }}
      >
        <KpiCard
          label="Current Balance"
          value={formatMoney(debt.current_balance_cents)}
          accentColor="var(--accent-danger)"
          icon={<TrendingDown className="w-5 h-5" style={{ color: 'var(--accent-danger)' }} />}
        />
        <KpiCard
          label="Original Balance"
          value={formatMoney(original)}
          accentColor="var(--text-muted)"
          icon={<DollarSign className="w-5 h-5" style={{ color: 'var(--text-muted)' }} />}
        />
        <KpiCard
          label="Total Paid Down"
          value={formatMoney(paidDown)}
          accentColor="var(--accent-success)"
          icon={
            <TrendingDown
              className="w-5 h-5"
              style={{ color: 'var(--accent-success)', transform: 'rotate(180deg)' }}
            />
          }
          sub={
            original > 0
              ? `${((paidDown / original) * 100).toFixed(1)}% Principal Cleared`
              : undefined
          }
        />
        <KpiCard
          label="Interest Rate (APR)"
          value={
            debt.interest_rate_pct != null ? `${Number(debt.interest_rate_pct).toFixed(2)}%` : '—'
          }
          accentColor="var(--accent-warning)"
          icon={<Clock className="w-5 h-5" style={{ color: 'var(--accent-warning)' }} />}
        />
        <KpiCard
          label="Min Monthly Payment"
          value={debt.minimum_payment_cents != null ? formatMoney(debt.minimum_payment_cents) : '—'}
          accentColor="var(--text-muted)"
          icon={<Calendar className="w-5 h-5" style={{ color: 'var(--text-muted)' }} />}
          sub={
            debt.payment_due_day != null ? `Due monthly on day ${debt.payment_due_day}` : undefined
          }
        />
        <KpiCard
          label="Payoff Projection"
          value={
            projection.kind === 'ok'
              ? `${projection.months} months`
              : projection.kind === 'never'
                ? 'Never'
                : '—'
          }
          accentColor={projection.kind === 'ok' ? 'var(--accent-info)' : 'var(--accent-danger)'}
          icon={
            <Clock
              className="w-5 h-5"
              style={{
                color: projection.kind === 'ok' ? 'var(--accent-info)' : 'var(--accent-danger)',
              }}
            />
          }
          sub={projection.note}
        />
      </div>

      {editing ? (
        <div className="card-gradient">
          <h3
            style={{
              marginTop: 0,
              marginBottom: '1.5rem',
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
            }}
          >
            <Edit2 className="w-5 h-5" /> Edit Account Settings
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                gap: '1rem',
              }}
            >
              <div className="form-group">
                <label className="form-label">Debt Type</label>
                <select
                  className="form-select"
                  value={String(draft.kind ?? debt.kind)}
                  onChange={(e) => setDraft({ ...draft, kind: e.target.value })}
                >
                  {DEBT_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {k.replace(/_/g, ' ')}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Lender</label>
                <input
                  className="form-input"
                  value={String(draft.lender_name ?? '')}
                  onChange={(e) => setDraft({ ...draft, lender_name: e.target.value })}
                />
              </div>
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                gap: '1rem',
              }}
            >
              <div className="form-group">
                <label className="form-label">Account # (Last 4 digits)</label>
                <input
                  className="form-input"
                  value={String(draft.account_number_last4 ?? '')}
                  onChange={(e) => setDraft({ ...draft, account_number_last4: e.target.value })}
                  maxLength={4}
                />
              </div>
              <div className="form-group">
                <label className="form-label">Liability Classification</label>
                <select
                  className="form-select"
                  value={draft.is_personal ? 'true' : 'false'}
                  onChange={(e) => setDraft({ ...draft, is_personal: e.target.value === 'true' })}
                >
                  <option value="false">Business Liability</option>
                  <option value="true">Personal Liability</option>
                </select>
              </div>
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                gap: '1rem',
              }}
            >
              <div className="form-group">
                <label className="form-label">Current Balance ($)</label>
                <input
                  className="form-input"
                  type="number"
                  step="0.01"
                  value={(
                    Number(draft.current_balance_cents ?? debt.current_balance_cents) / 100
                  ).toString()}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      current_balance_cents: Math.round(parseFloat(e.target.value || '0') * 100),
                    })
                  }
                />
              </div>
              <div className="form-group">
                <label className="form-label">Interest Rate (APR %)</label>
                <input
                  className="form-input"
                  type="number"
                  step="0.01"
                  value={draft.interest_rate_pct == null ? '' : String(draft.interest_rate_pct)}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      interest_rate_pct: e.target.value === '' ? null : Number(e.target.value),
                    })
                  }
                />
              </div>
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                gap: '1rem',
              }}
            >
              <div className="form-group">
                <label className="form-label">Minimum Monthly Payment ($)</label>
                <input
                  className="form-input"
                  type="number"
                  step="0.01"
                  value={
                    draft.minimum_payment_cents == null
                      ? ''
                      : (Number(draft.minimum_payment_cents) / 100).toString()
                  }
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      minimum_payment_cents:
                        e.target.value === '' ? null : Math.round(parseFloat(e.target.value) * 100),
                    })
                  }
                />
              </div>
              <div className="form-group">
                <label className="form-label">Payment Due Day (1-31)</label>
                <input
                  className="form-input"
                  type="number"
                  min={1}
                  max={31}
                  value={draft.payment_due_day == null ? '' : String(draft.payment_due_day)}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      payment_due_day: e.target.value === '' ? null : Number(e.target.value),
                    })
                  }
                />
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Internal Notes</label>
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
              <button
                className="btn btn-secondary"
                onClick={() => setEditing(false)}
                disabled={saving}
              >
                Cancel
              </button>
            </div>
            {error && (
              <div
                className="badge badge-danger"
                style={{ display: 'block', padding: '0.5rem 1rem', textTransform: 'none' }}
              >
                {error}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div
          className="card"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: '1.5rem',
          }}
        >
          <StatField label="Lender / Institution" value={debt.lender_name ?? '—'} />
          <StatField
            label="Account Number"
            value={debt.account_number_last4 ? `•••• •••• •••• ${debt.account_number_last4}` : '—'}
          />
          <StatField
            label="Debt Account Type"
            value={debt.kind.replace(/_/g, ' ')}
            style={{ textTransform: 'capitalize' }}
          />
          <StatField label="Origination Date" value={debt.start_date?.slice(0, 10) ?? '—'} />
          <StatField label="Target Payoff Date" value={debt.end_date?.slice(0, 10) ?? '—'} />
          <StatField
            label="Liability Classification"
            value={debt.is_personal ? 'Personal Liability' : 'Business Liability'}
          />
          <div style={{ gridColumn: '1 / -1' }}>
            <StatField label="Notes / Terms" value={debt.notes ?? 'No notes recorded.'} />
          </div>
        </div>
      )}

      {showRecord && (
        <RecordPaymentModal
          debt={debt}
          onClose={() => setShowRecord(false)}
          onRecorded={() => {
            setShowRecord(false);
            void refresh();
          }}
        />
      )}

      <div>
        <h2 style={{ fontSize: '1.25rem', marginBottom: '1rem' }}>Payment Ledger</h2>
        {payments.length === 0 ? (
          <div
            className="card"
            style={{ padding: '1.5rem', color: 'var(--text-muted)', fontSize: '0.875rem' }}
          >
            No payments have been recorded for this account.
          </div>
        ) : (
          <div className="table-premium-container">
            <table className="table-premium">
              <thead>
                <tr>
                  <th>Date</th>
                  <th style={{ textAlign: 'right' }}>Total Paid</th>
                  <th style={{ textAlign: 'right' }}>Principal Reduction</th>
                  <th style={{ textAlign: 'right' }}>Interest Paid</th>
                  <th style={{ textAlign: 'right' }}>Fees Paid</th>
                  <th>Notes</th>
                  <th style={{ width: '80px', textAlign: 'center' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => (
                  <tr key={p.id}>
                    <td>{p.paid_at.slice(0, 10)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--text-title)' }}>
                      {formatMoney(p.total_cents)}
                    </td>
                    <td
                      style={{ textAlign: 'right', color: 'var(--text-success)', fontWeight: 500 }}
                    >
                      {p.principal_cents != null ? formatMoney(p.principal_cents) : '—'}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {p.interest_cents != null ? formatMoney(p.interest_cents) : '—'}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {p.fees_cents != null ? formatMoney(p.fees_cents) : '—'}
                    </td>
                    <td style={{ color: 'var(--text-muted)', fontSize: '0.825rem' }}>
                      {p.notes ?? ''}
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <button
                        onClick={() => void deletePayment(p.id)}
                        className="btn btn-ghost"
                        style={{ padding: '0.25rem', color: 'var(--accent-danger)' }}
                        title="Delete payment"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
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
          borderStyle: 'dashed',
        }}
      >
        <Info
          className="w-5 h-5 text-accent-primary"
          style={{ flexShrink: 0, marginTop: '0.1rem', color: 'var(--text-link)' }}
        />
        <div>
          <strong style={{ color: 'var(--text-title)', display: 'block', marginBottom: '0.25rem' }}>
            Amortisation Planner:
          </strong>
          We are building a calculator to simulate interest savings by applying the Avalanche
          (highest interest first) or Snowball (smallest balance first) paydown methods.
        </div>
      </div>
    </section>
  );
}

function RecordPaymentModal({
  debt,
  onClose,
  onRecorded,
}: {
  debt: Debt;
  onClose: () => void;
  onRecorded: () => void;
}) {
  const { currentOrg } = useOrg();
  const [paidAt, setPaidAt] = useState(() => todayLocal(orgTimeZone(currentOrg)));
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
    if (insertErr) {
      setBusy(false);
      setErr(formatActionError('record this payment', insertErr.message));
      return;
    }
    if (principalC > 0) {
      const { error: updErr } = await supabase
        .from('debts')
        .update({ current_balance_cents: Math.max(0, debt.current_balance_cents - principalC) })
        .eq('id', debt.id);
      if (updErr) {
        setBusy(false);
        setErr(formatActionError('update the debt balance', updErr.message));
        return;
      }
    }
    setBusy(false);
    onRecorded();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Record debt payment"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'var(--bg-scrim)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 50,
        padding: '1rem',
      }}
    >
      <div
        className="card animated-fade-in"
        style={{
          width: '100%',
          maxWidth: '540px',
          maxHeight: '90vh',
          overflowY: 'auto',
          border: '1px solid var(--accent-primary)',
          boxShadow: 'var(--shadow-lg)',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '1.5rem',
          }}
        >
          <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Plus
              className="w-5 h-5 text-accent-success"
              style={{ color: 'var(--accent-success)' }}
            />
            Record Payment
          </h3>
          <button className="btn btn-ghost" onClick={onClose} style={{ padding: '0.25rem' }}>
            <X className="w-5 h-5" />
          </button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            <div className="form-group">
              <label className="form-label" htmlFor="debt-payment-date">
                Payment Date
              </label>
              <input
                id="debt-payment-date"
                type="date"
                className="form-input"
                value={paidAt}
                onChange={(e) => setPaidAt(e.target.value)}
              />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="debt-payment-total">
                Total Amount ($)
              </label>
              <input
                id="debt-payment-total"
                type="number"
                step="0.01"
                className="form-input"
                value={total || ''}
                onChange={(e) => setTotal(parseFloat(e.target.value) || 0)}
                placeholder="0.00"
              />
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            <div className="form-group">
              <label className="form-label" htmlFor="debt-payment-principal">
                Principal portion ($)
              </label>
              <input
                id="debt-payment-principal"
                type="number"
                step="0.01"
                className="form-input"
                value={principal || ''}
                onChange={(e) => setPrincipal(parseFloat(e.target.value) || 0)}
                placeholder="0.00"
              />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="debt-payment-interest">
                Interest portion ($)
              </label>
              <input
                id="debt-payment-interest"
                type="number"
                step="0.01"
                className="form-input"
                value={interest || ''}
                onChange={(e) => setInterest(parseFloat(e.target.value) || 0)}
                placeholder="0.00"
              />
            </div>
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="debt-payment-fees">
              Fees portion ($)
            </label>
            <input
              id="debt-payment-fees"
              type="number"
              step="0.01"
              className="form-input"
              value={fees || ''}
              onChange={(e) => setFees(parseFloat(e.target.value) || 0)}
              placeholder="0.00"
            />
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="debt-payment-notes">
              Notes / Description
            </label>
            <input
              id="debt-payment-notes"
              className="form-input"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. Regular monthly payoff"
            />
          </div>

          <div
            className="glass-panel"
            style={{
              padding: '0.75rem 1rem',
              display: 'flex',
              gap: '0.5rem',
              alignItems: 'center',
              fontSize: '0.8rem',
              color: 'var(--text-muted)',
            }}
          >
            <AlertCircle
              className="w-4 h-4 text-accent-success"
              style={{ flexShrink: 0, color: 'var(--accent-success)' }}
            />
            <span>
              Principal portion (<strong>{formatMoney(Math.round(principal * 100))}</strong>) will
              automatically reduce the current outstanding balance.
            </span>
          </div>

          <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.5rem' }}>
            <button className="btn btn-primary" onClick={submit} disabled={busy || total <= 0}>
              {busy ? 'Recording Payment…' : 'Record Payment'}
            </button>
            <button className="btn btn-secondary" onClick={onClose} disabled={busy}>
              Cancel
            </button>
          </div>
          {err && (
            <div
              className="badge badge-danger"
              style={{ display: 'block', padding: '0.5rem 1rem', textTransform: 'none' }}
            >
              {err}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

type Projection =
  | { kind: 'ok'; months: number; note?: string }
  | { kind: 'never'; note?: string }
  | { kind: 'unknown'; note?: string };

function computePayoffMonths(input: {
  balance_cents: number;
  interest_rate_pct: number | null;
  minimum_payment_cents: number | null;
}): Projection {
  if (input.balance_cents <= 0) return { kind: 'ok', months: 0, note: 'Account fully settled.' };
  if (
    input.interest_rate_pct == null ||
    input.minimum_payment_cents == null ||
    input.minimum_payment_cents <= 0
  ) {
    return { kind: 'unknown', note: 'Specify APR + min payment to calculate projection.' };
  }
  const monthlyRate = Number(input.interest_rate_pct) / 100 / 12;
  const minPayment = input.minimum_payment_cents;
  const balance = input.balance_cents;
  const monthlyInterestAccrued = balance * monthlyRate;

  if (monthlyRate === 0) {
    const months = Math.ceil(balance / minPayment);
    return { kind: 'ok', months, note: `Flat-rate payoff (${formatMoney(minPayment)}/mo)` };
  }
  if (minPayment <= monthlyInterestAccrued) {
    return {
      kind: 'never',
      note: `Payment is less than monthly interest accrual (${formatMoney(Math.round(monthlyInterestAccrued))}/mo)`,
    };
  }
  const numerator = Math.log(minPayment / (minPayment - balance * monthlyRate));
  const denominator = Math.log(1 + monthlyRate);
  const months = Math.ceil(numerator / denominator);
  return {
    kind: 'ok',
    months,
    note: `At ${formatMoney(minPayment)}/mo · ${(monthlyRate * 12 * 100).toFixed(2)}% APR`,
  };
}

function StatField({
  label,
  value,
  mono,
  style,
}: {
  label: string;
  value: string;
  mono?: boolean;
  style?: React.CSSProperties;
}) {
  return (
    <div style={style}>
      <div
        style={{
          fontSize: '0.75rem',
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          fontWeight: 600,
          marginBottom: '0.25rem',
        }}
      >
        {label}
      </div>
      <div
        style={{
          color: 'var(--text-title)',
          fontSize: '0.95rem',
          fontWeight: 500,
          fontFamily: mono ? 'monospace' : 'inherit',
        }}
      >
        {value}
      </div>
    </div>
  );
}

function KpiCard({
  label,
  value,
  accentColor,
  icon,
  sub,
}: {
  label: string;
  value: string;
  accentColor: string;
  icon: React.ReactNode;
  sub?: string | undefined;
}) {
  return (
    <div
      className="card"
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        borderLeft: `4px solid ${accentColor}`,
      }}
    >
      <div>
        <div
          style={{
            fontSize: '0.75rem',
            color: 'var(--text-muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            fontWeight: 600,
            marginBottom: '0.35rem',
          }}
        >
          {label}
        </div>
        <div
          style={{
            fontSize: '1.65rem',
            color: 'var(--text-title)',
            fontWeight: 700,
            fontFamily: 'var(--font-title)',
          }}
        >
          {value}
        </div>
        {sub && (
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
            {sub}
          </div>
        )}
      </div>
      <div
        style={{
          padding: '0.5rem',
          background: 'var(--bg-hover)',
          borderRadius: 'var(--radius-sm)',
        }}
      >
        {icon}
      </div>
    </div>
  );
}
