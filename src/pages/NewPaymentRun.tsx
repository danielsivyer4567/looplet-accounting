import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';
import { useUnpaidBillsForRun, type UnpaidBillForRun } from '@/hooks/usePaymentRuns';
import { formatLoadError } from '@/lib/errorMessages';
import { formatMoney } from '@/lib/money';
import { addDays, orgTimeZone, todayLocal, weekdayOf } from '@/lib/localDates';
import { SkeletonTable } from '@/components/Skeleton';
import { ChevronLeft, Layers, CheckCircle, AlertTriangle } from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';

export function NewPaymentRunPage() {
  const { currentOrg } = useOrg();
  const { bills, loading, error } = useUnpaidBillsForRun();
  const navigate = useNavigate();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [payDate, setPayDate] = useState<string>(() => {
    // Next Friday (a week out when today is Friday), in the organisation's time zone.
    const today = todayLocal(orgTimeZone(currentOrg));
    const daysUntilFriday = (5 - weekdayOf(today) + 7) % 7 || 7;
    return addDays(today, daysUntilFriday);
  });
  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr] = useState<string | null>(null);

  if (!currentOrg) {
    return (
      <section className="animated-fade-in">
        <h1>New Payment Run</h1>
        <p style={{ color: 'var(--text-muted)' }}>Pick an organisation first.</p>
      </section>
    );
  }

  const toggleAll = () => {
    if (selected.size === bills.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(bills.map((b) => b.bill_id)));
    }
  };

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectedBills = bills.filter((b) => selected.has(b.bill_id));
  const totalCents = selectedBills.reduce((s, b) => s + (b.total_inc_gst_cents ?? 0), 0);
  const missingBank = selectedBills.filter((b) => !b.has_bank_details);

  const handleCreate = async () => {
    if (selected.size === 0) {
      setSubmitErr('Select at least one bill.');
      return;
    }
    if (!payDate) {
      setSubmitErr('Set a payment date.');
      return;
    }
    setSubmitErr(null);
    setSubmitting(true);

    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) {
      setSubmitErr('Not authenticated.');
      setSubmitting(false);
      return;
    }

    const resp = await fetch(
      `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/payment-runs-create`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
          apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({
          organization_id: currentOrg.id,
          pay_date: payDate,
          bill_ids: [...selected],
        }),
      },
    );

    const result = (await resp.json()) as { ok: boolean; payment_run_id?: string; error?: string };
    setSubmitting(false);

    if (!result.ok) {
      setSubmitErr(result.error ?? 'Unknown error');
      return;
    }

    navigate(`/payment-runs/${result.payment_run_id}`);
  };

  return (
    <section className="animated-fade-in">
      {/* Back button */}
      <Link
        to="/payment-runs"
        style={{
          color: 'var(--text-muted)',
          fontSize: '0.825rem',
          display: 'inline-flex',
          alignItems: 'center',
          gap: '0.25rem',
          marginBottom: '1rem',
        }}
      >
        <ChevronLeft size={14} />
        <span>Payment runs</span>
      </Link>

      <PageHeader title={<><Layers size={24} style={{ color: 'var(--text-link)' }} /> New Payment Run</>} />
      <p
        style={{
          color: 'var(--text-muted)',
          fontSize: '0.875rem',
          marginTop: '0.25rem',
          marginBottom: '1.5rem',
          lineHeight: '1.5',
        }}
      >
        Select bills to pay, set the payment date, and create the run. Then download the ABA file
        and upload it to your internet banking.
      </p>

      {/* Header controls card */}
      <div
        className="card"
        style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginBottom: '1.5rem' }}
      >
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <Field label="Payment Date">
            <input
              type="date"
              value={payDate}
              onChange={(e) => setPayDate(e.target.value)}
              className="form-input"
              style={{ width: '160px', marginTop: '0.25rem' }}
            />
          </Field>

          {selected.size > 0 && (
            <div
              style={{
                fontSize: '0.875rem',
                color: 'var(--text-title)',
                fontWeight: 600,
                paddingBottom: '0.5rem',
              }}
            >
              {selected.size} bill{selected.size !== 1 ? 's' : ''} selected —{' '}
              <span style={{ color: 'var(--text-link)' }}>{formatMoney(totalCents)}</span>
              {missingBank.length > 0 && (
                <span
                  className="badge badge-warning"
                  style={{ marginLeft: '0.5rem', textTransform: 'none', padding: '0.25rem 0.5rem' }}
                >
                  <AlertTriangle size={12} style={{ marginRight: '0.25rem' }} />
                  {missingBank.length} missing bank details
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {loading ? (
        <SkeletonTable rows={8} cols={7} />
      ) : error ? (
        <div
          className="badge badge-danger"
          style={{ display: 'block', padding: '1rem', textTransform: 'none' }}
        >
          {formatLoadError('unpaid bills', error)}
        </div>
      ) : bills.length === 0 ? (
        <EmptyState>No unpaid bills ready for payment (status "attached", not yet in a run).</EmptyState>
      ) : (
        <div className="table-premium-container">
          <table className="table-premium">
            <thead>
              <tr>
                <th style={{ width: 40 }}>
                  <input
                    type="checkbox"
                    checked={selected.size === bills.length && bills.length > 0}
                    onChange={toggleAll}
                    style={{ cursor: 'pointer' }}
                  />
                </th>
                <th>Invoice #</th>
                <th>Supplier</th>
                <th>Due date</th>
                <th style={{ textAlign: 'right' }}>Amount</th>
                <th>Payee BSB</th>
                <th>Payee account</th>
              </tr>
            </thead>
            <tbody>
              {bills.map((b) => (
                <BillRow
                  key={b.bill_id}
                  bill={b}
                  checked={selected.has(b.bill_id)}
                  onToggle={() => toggle(b.bill_id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Footer trigger bar */}
      <div
        style={{
          marginTop: '1.5rem',
          display: 'flex',
          gap: '1rem',
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        <button
          onClick={() => void handleCreate()}
          disabled={submitting || selected.size === 0}
          className="btn btn-primary"
          style={{ padding: '0.625rem 1.25rem' }}
        >
          <CheckCircle size={16} />
          <span>{submitting ? 'Creating…' : `Create payment run (${selected.size} bills)`}</span>
        </button>

        {submitErr && (
          <div
            className="badge badge-danger"
            style={{ padding: '0.625rem 1rem', textTransform: 'none' }}
          >
            {submitErr}
          </div>
        )}

        {missingBank.length > 0 && selected.size > 0 && (
          <div
            className="badge badge-warning"
            style={{
              textTransform: 'none',
              padding: '0.5rem 1rem',
              display: 'flex',
              alignItems: 'center',
              gap: '0.35rem',
            }}
          >
            <AlertTriangle size={14} style={{ flexShrink: 0 }} />
            <span>
              Warning: {missingBank.length} payee(s) have no bank details. ABA file account fields
              will be blank. Add details via Suppliers before downloading ABA.
            </span>
          </div>
        )}
      </div>
    </section>
  );
}

function BillRow({
  bill,
  checked,
  onToggle,
}: {
  bill: UnpaidBillForRun;
  checked: boolean;
  onToggle: () => void;
}) {
  const isBillOverdue = isOverdue(bill.due_date);
  return (
    <tr
      style={{
        background: checked ? 'var(--bg-success-subtle)' : 'transparent',
        cursor: 'pointer',
      }}
      onClick={onToggle}
    >
      <td onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          style={{ cursor: 'pointer' }}
        />
      </td>
      <td style={{ fontWeight: 600 }}>
        {bill.invoice_number ?? <span style={{ color: 'var(--text-muted)' }}>—</span>}
      </td>
      <td style={{ color: 'var(--text-title)', fontWeight: 600 }}>
        {bill.supplier_name ?? bill.supplier_name_raw ?? (
          <span style={{ color: 'var(--text-muted)' }}>Unknown</span>
        )}
      </td>
      <td
        style={{
          color: isBillOverdue ? 'var(--text-danger)' : 'var(--text-body)',
          fontWeight: isBillOverdue ? 600 : 'normal',
        }}
      >
        {bill.due_date ?? <span style={{ color: 'var(--text-muted)' }}>—</span>}
        {isBillOverdue && (
          <span style={{ fontSize: '0.75rem', marginLeft: '0.25rem' }}>(overdue)</span>
        )}
      </td>
      <td style={{ textAlign: 'right', fontWeight: 600 }}>
        {formatMoney(bill.total_inc_gst_cents)}
      </td>
      <td>
        {bill.payee_bsb ? (
          bill.payee_bsb
        ) : (
          <span
            className="badge badge-warning"
            style={{ textTransform: 'none', fontSize: '0.75rem' }}
          >
            missing
          </span>
        )}
      </td>
      <td>
        {bill.payee_account_number ? (
          maskAccount(bill.payee_account_number)
        ) : (
          <span
            className="badge badge-warning"
            style={{ textTransform: 'none', fontSize: '0.75rem' }}
          >
            missing
          </span>
        )}
      </td>
    </tr>
  );
}

function isOverdue(dueDate: string | null): boolean {
  if (!dueDate) return false;
  return new Date(dueDate) < new Date();
}

function maskAccount(acct: string): string {
  if (acct.length <= 4) return acct;
  return '****' + acct.slice(-4);
}
