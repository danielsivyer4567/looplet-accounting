import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/contexts/OrgContext';
import { useUnpaidBillsForRun, type UnpaidBillForRun } from '@/hooks/usePaymentRuns';
import { formatMoney } from '@/lib/money';
import { SkeletonTable } from '@/components/Skeleton';

export function NewPaymentRunPage() {
  const { currentOrg } = useOrg();
  const { bills, loading, error } = useUnpaidBillsForRun();
  const navigate = useNavigate();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [payDate, setPayDate] = useState<string>(() => {
    // Default: next Friday
    const d = new Date();
    const day = d.getDay(); // 0=Sun, 5=Fri
    const daysUntilFriday = (5 - day + 7) % 7 || 7;
    d.setDate(d.getDate() + daysUntilFriday);
    return d.toISOString().split('T')[0] ?? '';
  });
  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr] = useState<string | null>(null);

  if (!currentOrg) {
    return (
      <section>
        <h1>New Payment Run</h1>
        <p style={{ color: '#888' }}>Pick an organisation first.</p>
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

    const { data: { session } } = await supabase.auth.getSession();
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

    const result = await resp.json() as { ok: boolean; payment_run_id?: string; error?: string };
    setSubmitting(false);

    if (!result.ok) {
      setSubmitErr(result.error ?? 'Unknown error');
      return;
    }

    navigate(`/payment-runs/${result.payment_run_id}`);
  };

  return (
    <section>
      <h1>New Payment Run</h1>
      <p style={{ color: '#888', fontSize: 13 }}>
        Select bills to pay, set the payment date, and create the run. Then download the ABA file
        and upload it to your internet banking.
      </p>

      {/* Header controls */}
      <div
        style={{
          display: 'flex',
          gap: 12,
          alignItems: 'flex-end',
          margin: '1.5rem 0 1rem',
          flexWrap: 'wrap',
        }}
      >
        <label style={{ fontSize: 12, color: '#888' }}>
          <div style={{ marginBottom: 3 }}>Payment date</div>
          <input
            type="date"
            value={payDate}
            onChange={(e) => setPayDate(e.target.value)}
            style={inp}
          />
        </label>

        {selected.size > 0 && (
          <div style={{ fontSize: 13, color: '#ccc', alignSelf: 'flex-end', paddingBottom: 6 }}>
            {selected.size} bill{selected.size !== 1 ? 's' : ''} selected — {formatMoney(totalCents)}
            {missingBank.length > 0 && (
              <span style={{ color: '#f4a261', marginLeft: 8 }}>
                {missingBank.length} missing bank details
              </span>
            )}
          </div>
        )}
      </div>

      {loading ? (
        <SkeletonTable rows={8} cols={6} />
      ) : error ? (
        <p style={{ color: 'salmon' }}>Failed: {error}</p>
      ) : bills.length === 0 ? (
        <p style={{ color: '#888' }}>
          No unpaid bills ready for payment (status "attached", not yet in a run).
        </p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #2a2a2a' }}>
                <th style={{ ...th, width: 32 }}>
                  <input
                    type="checkbox"
                    checked={selected.size === bills.length && bills.length > 0}
                    onChange={toggleAll}
                  />
                </th>
                <th style={th}>Invoice #</th>
                <th style={th}>Supplier</th>
                <th style={th}>Due date</th>
                <th style={thRight}>Amount</th>
                <th style={th}>Payee BSB</th>
                <th style={th}>Payee account</th>
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

      <div style={{ marginTop: 24, display: 'flex', gap: 12, alignItems: 'center' }}>
        <button
          onClick={() => void handleCreate()}
          disabled={submitting || selected.size === 0}
          style={btnPrim}
        >
          {submitting ? 'Creating…' : `Create payment run (${selected.size} bills)`}
        </button>
        {submitErr && <span style={{ color: 'salmon', fontSize: 12 }}>{submitErr}</span>}
        {missingBank.length > 0 && selected.size > 0 && (
          <span style={{ color: '#f4a261', fontSize: 12 }}>
            Warning: {missingBank.length} payee(s) have no bank details — the ABA file will
            have blank account fields. Add them via Suppliers before downloading.
          </span>
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
  return (
    <tr
      style={{
        borderBottom: '1px solid #1a1a1a',
        background: checked ? '#1a2a1a' : 'transparent',
        cursor: 'pointer',
      }}
      onClick={onToggle}
    >
      <td style={td}>
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          onClick={(e) => e.stopPropagation()}
        />
      </td>
      <td style={td}>{bill.invoice_number ?? <span style={{ color: '#555' }}>—</span>}</td>
      <td style={td}>{bill.supplier_name ?? bill.supplier_name_raw ?? <span style={{ color: '#555' }}>Unknown</span>}</td>
      <td style={{ ...td, color: isOverdue(bill.due_date) ? '#f4a261' : '#ccc' }}>
        {bill.due_date ?? <span style={{ color: '#555' }}>—</span>}
      </td>
      <td style={{ ...td, textAlign: 'right' }}>{formatMoney(bill.total_inc_gst_cents)}</td>
      <td style={td}>
        {bill.payee_bsb ? (
          bill.payee_bsb
        ) : (
          <span title="Missing — add via Suppliers" style={{ color: '#f4a261' }}>
            ⚠ missing
          </span>
        )}
      </td>
      <td style={td}>
        {bill.payee_account_number ? (
          maskAccount(bill.payee_account_number)
        ) : (
          <span title="Missing — add via Suppliers" style={{ color: '#f4a261' }}>
            ⚠ missing
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

/** Show last 4 digits of account number, rest as stars. */
function maskAccount(acct: string): string {
  if (acct.length <= 4) return acct;
  return '****' + acct.slice(-4);
}

const inp: React.CSSProperties = {
  padding: '6px 8px',
  background: '#000',
  color: '#ddd',
  border: '1px solid #333',
  borderRadius: 3,
  fontSize: 13,
};
const th: React.CSSProperties = {
  textAlign: 'left',
  padding: '0.5rem 0.75rem',
  fontSize: 11,
  color: '#666',
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
};
const thRight: React.CSSProperties = { ...th, textAlign: 'right' };
const td: React.CSSProperties = {
  padding: '0.6rem 0.75rem',
  fontSize: 13,
  color: '#ccc',
};
const btnPrim: React.CSSProperties = {
  padding: '0.5rem 1rem',
  background: '#1c5135',
  color: '#fff',
  border: '1px solid #2da565',
  borderRadius: 4,
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
};
