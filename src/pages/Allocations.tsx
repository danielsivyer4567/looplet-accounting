import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useOrg } from '@/contexts/OrgContext';
import { useAllocationQueue, type QueueBill } from '@/hooks/useAllocationQueue';
import { supabase } from '@/lib/supabase';
import { formatMoney } from '@/lib/money';

export function AllocationsPage() {
  const { currentOrg } = useOrg();
  const { bills, loading, error, refresh } = useAllocationQueue();
  const [busyId, setBusyId] = useState<string | null>(null);

  if (!currentOrg) {
    return (
      <section>
        <h1>Allocations</h1>
        <p style={{ color: '#888' }}>Pick an organisation to see the allocation queue.</p>
      </section>
    );
  }
  if (loading) return <p style={{ color: '#888' }}>Loading queue…</p>;
  if (error) return <p style={{ color: 'salmon' }}>Failed to load: {error}</p>;

  if (bills.length === 0) {
    return (
      <section>
        <h1>Allocations</h1>
        <p style={{ color: '#888' }}>Inbox zero. Every bill is attached to a job.</p>
        <p style={{ color: '#666', fontSize: 14 }}>
          Bills land here when they're extracted but couldn't auto-attach. Either no exact{' '}
          <code>job_reference</code> match, low extraction confidence, or no job ref on the bill at
          all.
        </p>
      </section>
    );
  }

  const confirmAttach = async (bill: QueueBill, jobId: string) => {
    setBusyId(bill.id);
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) {
      setBusyId(null);
      return;
    }
    try {
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/bills-attach`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ bill_id: bill.id, job_id: jobId }),
      });
      if (!res.ok) {
        const body = await res.text();
        // eslint-disable-next-line no-alert
        alert(`Attach failed: ${body}`);
        return;
      }
      await refresh();
    } finally {
      setBusyId(null);
    }
  };

  const rejectSuggestion = async (billId: string) => {
    setBusyId(billId);
    await supabase
      .from('bills')
      .update({ suggested_job_id: null, suggested_match_score: null })
      .eq('id', billId);
    await refresh();
    setBusyId(null);
  };

  return (
    <section>
      <h1>Allocations</h1>
      <p style={{ color: '#888', fontSize: 14 }}>
        {bills.length} bill{bills.length === 1 ? '' : 's'} waiting for a job. Suggested matches at
        the top, no-suggestion at the bottom.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '1.5rem' }}>
        {bills.map((b) => (
          <BillCard
            key={b.id}
            bill={b}
            busy={busyId === b.id}
            onConfirm={(jobId) => confirmAttach(b, jobId)}
            onReject={() => rejectSuggestion(b.id)}
          />
        ))}
      </div>
    </section>
  );
}

function BillCard({
  bill,
  busy,
  onConfirm,
  onReject,
}: {
  bill: QueueBill;
  busy: boolean;
  onConfirm: (jobId: string) => void;
  onReject: () => void;
}) {
  const score = bill.suggested_match_score ?? 0;
  const sugg = bill.suggested_job;
  const scoreColour = score >= 0.85 ? '#86c7a3' : score >= 0.65 ? '#d2c886' : '#888';

  return (
    <div
      style={{
        padding: '1rem',
        background: '#1a1a1a',
        border: '1px solid #2a2a2a',
        borderRadius: 6,
        display: 'grid',
        gridTemplateColumns: '1fr auto',
        gap: '1rem',
        alignItems: 'center',
      }}
    >
      <div>
        <div style={{ fontSize: 14, fontWeight: 600 }}>
          {bill.supplier_name_raw ?? <span style={{ color: '#888' }}>No supplier</span>}
        </div>
        <div style={{ fontSize: 12, color: '#888', marginTop: '0.25rem' }}>
          {formatMoney(bill.total_inc_gst_cents)} ·{' '}
          <code>{bill.invoice_number ?? '—'}</code> · {bill.invoice_date ?? '—'} · OCR:{' '}
          {bill.ocr_provider ?? '—'} ({bill.ocr_confidence ?? '—'})
        </div>
        <div style={{ fontSize: 12, color: '#888', marginTop: '0.25rem' }}>
          Job ref on bill:{' '}
          {bill.job_reference_raw ? (
            <code style={{ color: '#d2c886' }}>{bill.job_reference_raw}</code>
          ) : (
            <span style={{ color: '#666' }}>none extracted</span>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', minWidth: 240 }}>
        {sugg ? (
          <>
            <div style={{ fontSize: 12, color: '#aaa' }}>
              Suggested:{' '}
              <strong style={{ color: '#fff' }}>{sugg.job_number}</strong>{' '}
              <span style={{ color: scoreColour }}>({(score * 100).toFixed(0)}% match)</span>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button
                onClick={() => onConfirm(sugg.id)}
                disabled={busy}
                style={{
                  padding: '0.4rem 0.75rem',
                  background: '#1c5135',
                  color: '#fff',
                  border: '1px solid #2da565',
                  borderRadius: 4,
                  cursor: busy ? 'wait' : 'pointer',
                  fontSize: 13,
                }}
              >
                {busy ? 'Attaching…' : `Attach to ${sugg.job_number}`}
              </button>
              <button
                onClick={onReject}
                disabled={busy}
                style={{
                  padding: '0.4rem 0.75rem',
                  background: 'transparent',
                  color: '#aaa',
                  border: '1px solid #444',
                  borderRadius: 4,
                  cursor: busy ? 'wait' : 'pointer',
                  fontSize: 13,
                }}
              >
                Wrong
              </button>
            </div>
          </>
        ) : (
          <div style={{ fontSize: 13 }}>
            <Link
              to={`/bills/${bill.id}`}
              style={{
                display: 'inline-block',
                padding: '0.4rem 0.75rem',
                background: '#2a2a2a',
                color: '#fff',
                border: '1px solid #444',
                borderRadius: 4,
                textDecoration: 'none',
                fontSize: 13,
              }}
            >
              Open & attach manually →
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
