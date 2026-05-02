import { useEffect, useState, useCallback } from 'react';
import { Link, useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/contexts/OrgContext';
import { formatMoney } from '@/lib/money';

interface Customer { id: string; name: string; email: string | null }
interface Job { id: string; job_number: string; name: string; customer_id: string | null }
interface Invoice {
  id: string;
  invoice_number: string;
  customer_id: string;
  job_id: string | null;
  issue_date: string;
  due_date: string;
  terms_days: number;
  subtotal_ex_gst_cents: number;
  gst_cents: number;
  total_inc_gst_cents: number;
  amount_paid_cents: number;
  balance_due_cents: number;
  status: string;
  notes: string | null;
  internal_notes: string | null;
  sent_at: string | null;
  paid_at: string | null;
  customer: Customer | null;
  job: Job | null;
}
interface LineItem {
  id?: string;
  line_number: number;
  description: string;
  quantity: number;
  unit_price_cents: number;
  gst_treatment: 'inc' | 'ex' | 'free';
  line_total_ex_gst_cents: number;
  line_gst_cents: number;
  line_total_inc_gst_cents: number;
}
interface Payment {
  id: string;
  paid_at: string;
  amount_cents: number;
  method: string | null;
  reference: string | null;
  notes: string | null;
}

const NEW_LINE: Omit<LineItem, 'line_number'> = {
  description: '',
  quantity: 1,
  unit_price_cents: 0,
  gst_treatment: 'ex',
  line_total_ex_gst_cents: 0,
  line_gst_cents: 0,
  line_total_inc_gst_cents: 0,
};

export function InvoiceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const isNew = !id || id === 'new';
  const [searchParams] = useSearchParams();
  const { currentOrg } = useOrg();
  const navigate = useNavigate();

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [lines, setLines] = useState<LineItem[]>([{ line_number: 1, ...NEW_LINE }]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(isNew);

  // Header form state (for new + edit)
  const [customerId, setCustomerId] = useState<string>(searchParams.get('customer_id') ?? '');
  const [jobId, setJobId] = useState<string>(searchParams.get('job_id') ?? '');
  const [issueDate, setIssueDate] = useState(new Date().toISOString().slice(0, 10));
  const [termsDays, setTermsDays] = useState(14);
  const [notes, setNotes] = useState('');

  const dueDate = (() => {
    const d = new Date(issueDate);
    d.setDate(d.getDate() + termsDays);
    return d.toISOString().slice(0, 10);
  })();

  const refresh = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);
    setError(null);

    const [custRes, jobsRes] = await Promise.all([
      supabase.from('customers').select('id, name, email').eq('organization_id', currentOrg.id).is('deleted_at', null).order('name'),
      supabase.from('jobs').select('id, job_number, name, customer_id').eq('organization_id', currentOrg.id).is('deleted_at', null).order('job_number'),
    ]);
    setCustomers((custRes.data ?? []) as Customer[]);
    setJobs((jobsRes.data ?? []) as Job[]);

    if (!isNew && id) {
      const [invRes, linesRes, paysRes] = await Promise.all([
        supabase.from('invoices').select(`
          *,
          customer:customers!invoices_customer_id_fkey(id, name, email),
          job:jobs!invoices_job_id_fkey(id, job_number, name, customer_id)
        `).eq('id', id).maybeSingle(),
        supabase.from('invoice_line_items').select('*').eq('invoice_id', id).order('line_number'),
        supabase.from('invoice_payments').select('*').eq('invoice_id', id).order('paid_at', { ascending: false }),
      ]);
      if (invRes.error) setError(invRes.error.message);
      const inv = (invRes.data as unknown as Invoice | null) ?? null;
      setInvoice(inv);
      setLines(((linesRes.data ?? []) as LineItem[]).map((l) => ({ ...l })));
      setPayments((paysRes.data ?? []) as Payment[]);
      if (inv) {
        setCustomerId(inv.customer_id);
        setJobId(inv.job_id ?? '');
        setIssueDate(inv.issue_date);
        setTermsDays(inv.terms_days);
        setNotes(inv.notes ?? '');
      }
    } else {
      // Pre-fill customer from job if job_id was passed
      const jid = searchParams.get('job_id');
      if (jid) {
        const j = (jobsRes.data ?? []).find((x: Job) => x.id === jid);
        if (j?.customer_id) setCustomerId(j.customer_id);
      }
    }
    setLoading(false);
  }, [currentOrg, id, isNew, searchParams]);

  useEffect(() => void refresh(), [refresh]);

  // Recompute line totals on line edit
  const updateLine = (idx: number, patch: Partial<LineItem>) => {
    setLines((prev) => {
      const copy = [...prev];
      const next = { ...copy[idx], ...patch };
      const ex = Math.round(next.quantity * next.unit_price_cents);
      let gst = 0;
      let inc = ex;
      if (next.gst_treatment === 'ex') {
        gst = Math.round(ex * 0.10);
        inc = ex + gst;
      } else if (next.gst_treatment === 'inc') {
        gst = Math.round(ex / 11);
        inc = ex;
      }
      next.line_total_ex_gst_cents = ex;
      next.line_gst_cents = gst;
      next.line_total_inc_gst_cents = inc;
      copy[idx] = next;
      return copy;
    });
  };

  const addLine = () => {
    setLines((prev) => [...prev, { line_number: prev.length + 1, ...NEW_LINE }]);
  };

  const removeLine = (idx: number) => {
    setLines((prev) => prev.filter((_, i) => i !== idx).map((l, i) => ({ ...l, line_number: i + 1 })));
  };

  const totals = lines.reduce(
    (acc, l) => ({
      sub: acc.sub + l.line_total_ex_gst_cents,
      gst: acc.gst + l.line_gst_cents,
      total: acc.total + l.line_total_inc_gst_cents,
    }),
    { sub: 0, gst: 0, total: 0 },
  );

  const save = async () => {
    if (!currentOrg) return;
    if (!customerId) { setError('Pick a customer'); return; }
    if (lines.length === 0 || lines.every((l) => !l.description.trim())) { setError('Add at least one line item'); return; }

    setBusy(true);
    try {
      let invId = invoice?.id;
      if (isNew) {
        const { data: created, error: createErr } = await supabase
          .from('invoices')
          .insert({
            organization_id: currentOrg.id,
            customer_id: customerId,
            job_id: jobId || null,
            issue_date: issueDate,
            due_date: dueDate,
            terms_days: termsDays,
            notes: notes || null,
            invoice_number: '',  // trigger fills this
          })
          .select('id')
          .single();
        if (createErr) throw createErr;
        invId = created.id;
      } else if (invId) {
        const { error: upErr } = await supabase.from('invoices').update({
          customer_id: customerId,
          job_id: jobId || null,
          issue_date: issueDate,
          due_date: dueDate,
          terms_days: termsDays,
          notes: notes || null,
        }).eq('id', invId);
        if (upErr) throw upErr;
        // Wipe + reinsert line items to keep this simple
        await supabase.from('invoice_line_items').delete().eq('invoice_id', invId);
      }

      if (invId) {
        const validLines = lines.filter((l) => l.description.trim() && l.line_total_inc_gst_cents > 0);
        if (validLines.length > 0) {
          const { error: lineErr } = await supabase.from('invoice_line_items').insert(
            validLines.map((l, i) => ({
              invoice_id: invId,
              organization_id: currentOrg.id,
              line_number: i + 1,
              description: l.description.trim(),
              quantity: l.quantity,
              unit_price_cents: l.unit_price_cents,
              gst_treatment: l.gst_treatment,
              line_total_ex_gst_cents: l.line_total_ex_gst_cents,
              line_gst_cents: l.line_gst_cents,
              line_total_inc_gst_cents: l.line_total_inc_gst_cents,
            })),
          );
          if (lineErr) throw lineErr;
        }
      }

      navigate(`/invoices/${invId}`);
      setEditing(false);
      void refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const markSent = async () => {
    if (!invoice) return;
    setBusy(true);
    await supabase.from('invoices').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', invoice.id);
    setBusy(false);
    void refresh();
  };

  const recordPayment = async () => {
    if (!invoice) return;
    const amtStr = window.prompt(
      `Record payment for ${invoice.invoice_number}.\nBalance due: ${formatMoney(invoice.balance_due_cents)}\nAmount in dollars (e.g. 1234.56):`,
      (invoice.balance_due_cents / 100).toFixed(2),
    );
    if (!amtStr) return;
    const amount = parseFloat(amtStr);
    if (!Number.isFinite(amount) || amount <= 0) return;
    setBusy(true);
    const { error: payErr } = await supabase.from('invoice_payments').insert({
      organization_id: invoice.id ? (await supabase.from('invoices').select('organization_id').eq('id', invoice.id).single()).data?.organization_id : null,
      invoice_id: invoice.id,
      amount_cents: Math.round(amount * 100),
      method: window.prompt('Payment method (eft / cash / card / cheque)?', 'eft') ?? null,
      paid_at: new Date().toISOString(),
    });
    setBusy(false);
    if (payErr) { setError(payErr.message); return; }
    void refresh();
  };

  const voidInvoice = async () => {
    if (!invoice) return;
    if (!confirm(`Void ${invoice.invoice_number}? It stays in the list but is excluded from totals.`)) return;
    await supabase.from('invoices').update({ status: 'void' }).eq('id', invoice.id);
    void refresh();
  };

  if (!currentOrg) return null;
  if (loading) return <section><h1>Invoice</h1><p style={{ color: '#888' }}>Loading…</p></section>;
  if (!isNew && !invoice) return (
    <section>
      <h1>Invoice not found</h1>
      <Link to="/invoices" style={{ color: '#86c7a3' }}>&larr; Back to invoices</Link>
    </section>
  );

  return (
    <section>
      <Link to="/invoices" style={{ color: '#86c7a3', fontSize: 13 }}>&larr; All invoices</Link>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: '0.5rem' }}>
        <h1 style={{ margin: 0 }}>
          {isNew ? 'New invoice' : <code>{invoice?.invoice_number}</code>}
        </h1>
        {!isNew && invoice && (
          <div style={{ display: 'flex', gap: 8 }}>
            <StatusPill status={invoice.status} />
            {invoice.status === 'draft' && (
              <button onClick={markSent} disabled={busy} style={btnPrim}>Mark sent</button>
            )}
            {(invoice.status === 'sent' || invoice.status === 'partially_paid' || invoice.status === 'overdue') && (
              <button onClick={recordPayment} disabled={busy} style={btnPrim}>Record payment</button>
            )}
            {!editing && invoice.status !== 'paid' && invoice.status !== 'void' && (
              <button onClick={() => setEditing(true)} style={btnGhost}>Edit</button>
            )}
            {invoice.status !== 'paid' && invoice.status !== 'void' && (
              <button onClick={voidInvoice} style={btnGhost}>Void</button>
            )}
          </div>
        )}
      </div>

      {error && <p style={{ color: 'salmon', fontSize: 12, marginTop: 8 }}>{error}</p>}

      <div style={card}>
        <div style={grid3}>
          <Field label="Customer">
            {editing ? (
              <select value={customerId} onChange={(e) => setCustomerId(e.target.value)} style={inp}>
                <option value="">— pick customer —</option>
                {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            ) : (
              <span style={{ fontSize: 13 }}>{invoice?.customer?.name ?? '—'}</span>
            )}
          </Field>
          <Field label="Job (optional)">
            {editing ? (
              <select value={jobId} onChange={(e) => setJobId(e.target.value)} style={inp}>
                <option value="">— no job —</option>
                {jobs.map((j) => <option key={j.id} value={j.id}>{j.job_number} · {j.name}</option>)}
              </select>
            ) : (
              <span style={{ fontSize: 13 }}>{invoice?.job ? `${invoice.job.job_number} · ${invoice.job.name}` : '—'}</span>
            )}
          </Field>
          <Field label="Issue date">
            {editing ? <input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} style={inp} /> : <span style={{ fontSize: 13 }}>{invoice?.issue_date}</span>}
          </Field>
        </div>
        <div style={grid3}>
          <Field label="Terms (days)">
            {editing ? <input type="number" min={0} value={termsDays} onChange={(e) => setTermsDays(Number(e.target.value))} style={inp} /> : <span style={{ fontSize: 13 }}>{invoice?.terms_days} days</span>}
          </Field>
          <Field label="Due date">
            <span style={{ fontSize: 13, color: '#aaa' }}>{editing ? dueDate : invoice?.due_date}</span>
          </Field>
          <Field label="Notes (visible on invoice)">
            {editing ? <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Thanks for your business" style={inp} /> : <span style={{ fontSize: 13 }}>{invoice?.notes ?? '—'}</span>}
          </Field>
        </div>
      </div>

      <h2 style={h2}>Line items</h2>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ borderBottom: '1px solid #2a2a2a' }}>
            <th style={th}>#</th>
            <th style={th}>Description</th>
            <th style={thRight}>Qty</th>
            <th style={thRight}>Unit price (ex)</th>
            <th style={th}>GST</th>
            <th style={thRight}>Line total inc</th>
            {editing && <th style={th}></th>}
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i} style={{ borderBottom: '1px solid #1a1a1a' }}>
              <td style={td}>{l.line_number}</td>
              <td style={td}>
                {editing
                  ? <input value={l.description} onChange={(e) => updateLine(i, { description: e.target.value })} placeholder="e.g. Fence install — 30m" style={inp} />
                  : l.description}
              </td>
              <td style={tdRight}>
                {editing
                  ? <input type="number" step="0.01" value={l.quantity} onChange={(e) => updateLine(i, { quantity: parseFloat(e.target.value) || 0 })} style={{ ...inp, width: 80, textAlign: 'right' }} />
                  : l.quantity}
              </td>
              <td style={tdRight}>
                {editing
                  ? <input type="number" step="0.01" value={(l.unit_price_cents / 100).toFixed(2)} onChange={(e) => updateLine(i, { unit_price_cents: Math.round((parseFloat(e.target.value) || 0) * 100) })} style={{ ...inp, width: 110, textAlign: 'right' }} />
                  : formatMoney(l.unit_price_cents)}
              </td>
              <td style={td}>
                {editing
                  ? <select value={l.gst_treatment} onChange={(e) => updateLine(i, { gst_treatment: e.target.value as LineItem['gst_treatment'] })} style={inp}>
                      <option value="ex">+ GST</option>
                      <option value="inc">inc GST</option>
                      <option value="free">GST free</option>
                    </select>
                  : l.gst_treatment}
              </td>
              <td style={tdRight}>{formatMoney(l.line_total_inc_gst_cents)}</td>
              {editing && (
                <td style={{ ...td, textAlign: 'right' }}>
                  <button onClick={() => removeLine(i)} style={btnGhostSm}>×</button>
                </td>
              )}
            </tr>
          ))}
          {editing && (
            <tr>
              <td colSpan={editing ? 7 : 6} style={{ padding: '0.5rem' }}>
                <button onClick={addLine} style={btnGhost}>+ Add line</button>
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <div style={{ marginTop: 12, marginLeft: 'auto', maxWidth: 320 }}>
        <Total label="Subtotal ex GST" value={formatMoney(totals.sub)} />
        <Total label="GST (10%)" value={formatMoney(totals.gst)} />
        <Total label="Total inc GST" value={formatMoney(totals.total)} bold />
        {!isNew && invoice && invoice.amount_paid_cents > 0 && (
          <>
            <Total label="Paid" value={formatMoney(invoice.amount_paid_cents)} />
            <Total label="Balance due" value={formatMoney(invoice.balance_due_cents)} bold />
          </>
        )}
      </div>

      {editing ? (
        <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
          <button onClick={save} disabled={busy} style={btnPrim}>{busy ? 'Saving…' : (isNew ? 'Create invoice' : 'Save changes')}</button>
          <button onClick={() => isNew ? navigate('/invoices') : setEditing(false)} disabled={busy} style={btnGhost}>Cancel</button>
        </div>
      ) : null}

      {!isNew && payments.length > 0 && (
        <>
          <h2 style={h2}>Payments</h2>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #2a2a2a' }}>
                <th style={th}>Date</th>
                <th style={th}>Method</th>
                <th style={th}>Reference</th>
                <th style={thRight}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id} style={{ borderBottom: '1px solid #1a1a1a' }}>
                  <td style={td}>{p.paid_at.slice(0, 10)}</td>
                  <td style={td}>{p.method ?? '—'}</td>
                  <td style={td}>{p.reference ?? '—'}</td>
                  <td style={tdRight}>{formatMoney(p.amount_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <p style={{ marginTop: 32, padding: 10, background: '#0e0e0e', border: '1px dashed #2a2a2a', borderRadius: 4, fontSize: 12, color: '#666' }}>
        Future: PDF render, email send via Gmail integration, public payment page (uses public_token), Xero ACCREC sync, auto-overdue cron.
      </p>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block', fontSize: 11, color: '#888', marginTop: 6 }}>
      <div style={{ marginBottom: 3 }}>{label}</div>
      {children}
    </label>
  );
}

function Total({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 13, borderBottom: '1px solid #1a1a1a', fontWeight: bold ? 700 : 400 }}>
      <span style={{ color: '#888' }}>{label}</span>
      <span>{value}</span>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const c = status === 'paid' ? '#86c7a3' : status === 'sent' ? '#5096d8' : status === 'partially_paid' ? '#d2c886' : status === 'overdue' ? '#e9a3a3' : status === 'void' ? '#666' : '#888';
  return <span style={{ padding: '0.2rem 0.6rem', fontSize: 11, borderRadius: 3, background: '#222', color: c, textTransform: 'uppercase', alignSelf: 'center' }}>{status}</span>;
}

const card: React.CSSProperties = { marginTop: 12, padding: 16, background: '#0e0e0e', border: '1px solid #2a2a2a', borderRadius: 6, maxWidth: 1100 };
const grid3: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 };
const inp: React.CSSProperties = { width: '100%', padding: '6px 8px', background: '#000', color: '#ddd', border: '1px solid #333', borderRadius: 3, fontSize: 12 };
const h2: React.CSSProperties = { fontSize: 14, marginTop: 24, marginBottom: 8 };
const th: React.CSSProperties = { padding: '0.4rem 0.5rem', textAlign: 'left', fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 500 };
const thRight: React.CSSProperties = { ...th, textAlign: 'right' };
const td: React.CSSProperties = { padding: '0.5rem' };
const tdRight: React.CSSProperties = { ...td, textAlign: 'right' };
const btnPrim: React.CSSProperties = { padding: '0.4rem 1rem', background: '#1c4868', color: '#fff', border: '1px solid #5096d8', borderRadius: 4, fontSize: 12, fontWeight: 600, cursor: 'pointer' };
const btnGhost: React.CSSProperties = { padding: '0.4rem 1rem', background: 'transparent', color: '#aaa', border: '1px solid #333', borderRadius: 4, fontSize: 12, cursor: 'pointer' };
const btnGhostSm: React.CSSProperties = { ...btnGhost, padding: '0.15rem 0.4rem', fontSize: 14, lineHeight: 1 };
