import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useState,
  type ReactNode,
} from 'react';
import { Link, useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';
import { formatMoney } from '@/lib/money';
import { enqueueJob } from '@/lib/automationJobs';
import { MoveToOrgButton } from '@/components/MoveToOrgButton';
import { XeroStatusPill } from '@/components/XeroStatusPill';
import { DetailPageSkeleton } from '@/components/Skeleton';
import { ArchiveButton } from '@/components/ArchiveButton';
import {
  ChevronLeft,
  Save,
  X,
  Mail,
  CreditCard,
  Edit3,
  Trash2,
  Plus,
  AlertCircle,
  FileSpreadsheet,
} from 'lucide-react';

interface Customer {
  id: string;
  name: string;
  email: string | null;
}
interface Job {
  id: string;
  job_number: string;
  name: string;
  customer_id: string | null;
}
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
  xero_status: string | null;
  xero_invoice_id: string | null;
  xero_synced_at: string | null;
  metadata: Record<string, unknown>;
  deleted_at: string | null;
  customer: Customer | null;
  job: Job | null;
}
interface LineItem {
  id?: string;
  line_number: number;
  description: string;
  quantity: number;
  unit_price_cents: number;
  gst_treatment: 'inc' | 'ex' | 'free' | 'zero';
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

const GST_TREATMENT_LABELS: Record<string, string> = {
  ex: '+ GST',
  inc: 'inc GST',
  free: 'GST free',
  zero: 'Zero-rated',
};

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
  const [xeroBusy, setXeroBusy] = useState(false);

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
      supabase
        .from('customers')
        .select('id, name, email')
        .eq('organization_id', currentOrg.id)
        .is('deleted_at', null)
        .order('name'),
      supabase
        .from('jobs')
        .select('id, job_number, name, customer_id')
        .eq('organization_id', currentOrg.id)
        .is('deleted_at', null)
        .order('job_number'),
    ]);
    setCustomers((custRes.data ?? []) as Customer[]);
    setJobs((jobsRes.data ?? []) as Job[]);

    if (!isNew && id) {
      const [invRes, linesRes, paysRes] = await Promise.all([
        supabase
          .from('invoices')
          .select(
            `
          *,
          customer:customers!invoices_customer_id_fkey(id, name, email),
          job:jobs!invoices_job_id_fkey(id, job_number, name, customer_id)
        `,
          )
          .eq('id', id)
          .eq('organization_id', currentOrg.id)
          .maybeSingle(),
        supabase.from('invoice_line_items').select('*').eq('invoice_id', id).order('line_number'),
        supabase
          .from('invoice_payments')
          .select('*')
          .eq('invoice_id', id)
          .order('paid_at', { ascending: false }),
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
      const jid = searchParams.get('job_id');
      if (jid) {
        const j = (jobsRes.data ?? []).find((x: Job) => x.id === jid);
        if (j?.customer_id) setCustomerId(j.customer_id);
      }
    }
    setLoading(false);
  }, [currentOrg, id, isNew, searchParams]);

  useEffect(() => void refresh(), [refresh]);

  const updateLine = (idx: number, patch: Partial<LineItem>) => {
    setLines((prev) => {
      const copy = [...prev];
      const existing = copy[idx];
      if (!existing) return prev;
      const next: LineItem = { ...existing, ...patch };
      const ex = Math.round(next.quantity * next.unit_price_cents);
      let gst = 0;
      let inc = ex;
      if (next.gst_treatment === 'ex') {
        gst = Math.round(ex * 0.1);
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
    setLines((prev) =>
      prev.filter((_, i) => i !== idx).map((l, i) => ({ ...l, line_number: i + 1 })),
    );
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
    if (!customerId) {
      setError('Pick a customer');
      return;
    }
    if (lines.length === 0 || lines.every((l) => !l.description.trim())) {
      setError('Add at least one line item');
      return;
    }

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
            invoice_number: '',
          })
          .select('id')
          .single();
        if (createErr) throw createErr;
        invId = created.id;
      } else if (invId) {
        const { error: upErr } = await supabase
          .from('invoices')
          .update({
            customer_id: customerId,
            job_id: jobId || null,
            issue_date: issueDate,
            due_date: dueDate,
            terms_days: termsDays,
            notes: notes || null,
          })
          .eq('id', invId);
        if (upErr) throw upErr;
        await supabase.from('invoice_line_items').delete().eq('invoice_id', invId);
      }

      if (invId) {
        const validLines = lines.filter(
          (l) => l.description.trim() && l.line_total_inc_gst_cents > 0,
        );
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
    if (!invoice || !currentOrg) return;
    setBusy(true);
    setError(null);
    try {
      const { error: sentErr } = await supabase
        .from('invoices')
        .update({ status: 'sent', sent_at: new Date().toISOString() })
        .eq('id', invoice.id);
      if (sentErr) throw sentErr;

      await queueInvoiceXeroPush(invoice.id, currentOrg.id, 'invoice_sent');
      void refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const queueInvoiceXeroPush = async (invoiceId: string, orgId: string, source: string) => {
    await enqueueJob({
      organizationId: orgId,
      jobKind: 'xero_push',
      sourceKind: 'invoice',
      sourceId: invoiceId,
      priority: 4,
      payload: { invoice_id: invoiceId, source },
    });
  };

  const handleXeroRepush = async () => {
    if (!invoice || !currentOrg) return;
    setXeroBusy(true);
    setError(null);
    try {
      await queueInvoiceXeroPush(invoice.id, currentOrg.id, 'invoice_repush');
      void refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setXeroBusy(false);
    }
  };

  const recordPayment = async () => {
    if (!currentOrg || !invoice) return;
    const amtStr = window.prompt(
      `Record payment for ${invoice.invoice_number}.\nBalance due: ${formatMoney(invoice.balance_due_cents)}\nAmount in dollars (e.g. 1234.56):`,
      (invoice.balance_due_cents / 100).toFixed(2),
    );
    if (!amtStr) return;
    const amount = parseFloat(amtStr);
    if (!Number.isFinite(amount) || amount <= 0) return;
    setBusy(true);
    const { error: payErr } = await supabase.from('invoice_payments').insert({
      organization_id: currentOrg.id,
      invoice_id: invoice.id,
      amount_cents: Math.round(amount * 100),
      method: window.prompt('Payment method (eft / cash / card / cheque)?', 'eft') ?? null,
      paid_at: new Date().toISOString(),
    });
    setBusy(false);
    if (payErr) {
      setError(payErr.message);
      return;
    }
    void refresh();
  };

  const voidInvoice = async () => {
    if (!invoice) return;
    if (
      !confirm(`Void ${invoice.invoice_number}? It stays in the list but is excluded from totals.`)
    )
      return;
    await supabase.from('invoices').update({ status: 'void' }).eq('id', invoice.id);
    void refresh();
  };

  if (!currentOrg) return null;
  if (loading) {
    return <DetailPageSkeleton tableCols={6} />;
  }
  if (!isNew && !invoice) {
    return (
      <section className="animated-fade-in" style={{ padding: '2rem 0', textAlign: 'center' }}>
        <AlertCircle size={48} style={{ color: 'var(--accent-danger)', marginBottom: '1rem' }} />
        <h2>Invoice not found</h2>
        <p style={{ color: 'var(--text-muted)' }}>
          No invoice details were found under this organization.
        </p>
        <Link to="/invoices" className="btn btn-secondary" style={{ marginTop: '1rem' }}>
          <ChevronLeft size={16} /> Back to invoices
        </Link>
      </section>
    );
  }

  return (
    <section className="animated-fade-in">
      {/* Top back navigation */}
      <Link
        to="/invoices"
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
        <span>All invoices</span>
      </Link>

      {/* Title + Action controls */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '1.5rem',
          flexWrap: 'wrap',
          gap: '1rem',
        }}
      >
        <h1 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <FileSpreadsheet size={24} style={{ color: 'var(--accent-primary)' }} />
          {isNew ? 'New invoice' : <code>{invoice?.invoice_number}</code>}
        </h1>

        {!isNew && invoice && (
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <StatusPill status={invoice.status} />

            {invoice.status === 'draft' && (
              <button onClick={markSent} disabled={busy} className="btn btn-primary">
                <Mail size={14} />
                <span>Mark sent</span>
              </button>
            )}

            {(invoice.status === 'sent' ||
              invoice.status === 'partially_paid' ||
              invoice.status === 'overdue') && (
              <button onClick={recordPayment} disabled={busy} className="btn btn-primary">
                <CreditCard size={14} />
                <span>Record payment</span>
              </button>
            )}

            {!editing && invoice.status !== 'paid' && invoice.status !== 'void' && (
              <button onClick={() => setEditing(true)} className="btn btn-secondary">
                <Edit3 size={14} />
                <span>Edit</span>
              </button>
            )}

            {invoice.status !== 'paid' && invoice.status !== 'void' && (
              <button
                onClick={voidInvoice}
                className="btn btn-secondary"
                style={{ color: 'var(--text-danger)' }}
              >
                <Trash2 size={14} />
                <span>Void</span>
              </button>
            )}

            <MoveToOrgButton
              table="invoices"
              rowId={invoice.id}
              currentOrgId={currentOrg.id}
              fkColumnsToNull={['customer_id', 'job_id']}
              onMoved={() => {
                window.location.href = '/invoices';
              }}
            />

            <ArchiveButton
              table="invoices"
              rowId={invoice.id}
              isArchived={!!invoice.deleted_at}
              onChange={(nowArchived) => {
                if (nowArchived) {
                  window.location.href = '/invoices';
                } else {
                  void refresh();
                }
              }}
            />
          </div>
        )}
      </div>

      {error && (
        <div
          className="badge badge-danger"
          style={{
            display: 'block',
            padding: '0.75rem',
            marginBottom: '1.5rem',
            textTransform: 'none',
          }}
        >
          {error}
        </div>
      )}

      {/* Details Card Panel */}
      <div className="card" style={{ marginBottom: '1.5rem' }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
            gap: '1.25rem',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <Field label="Customer">
              {editing ? (
                <select
                  value={customerId}
                  onChange={(e) => setCustomerId(e.target.value)}
                  className="form-select"
                >
                  <option value="">— pick customer —</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              ) : (
                <span style={{ fontWeight: 600, color: 'var(--text-title)', fontSize: '0.9rem' }}>
                  {invoice?.customer?.name ?? '—'}
                </span>
              )}
            </Field>

            <Field label="Job (optional)">
              {editing ? (
                <select
                  value={jobId}
                  onChange={(e) => setJobId(e.target.value)}
                  className="form-select"
                >
                  <option value="">— no job —</option>
                  {jobs.map((j) => (
                    <option key={j.id} value={j.id}>
                      {j.job_number} · {j.name}
                    </option>
                  ))}
                </select>
              ) : (
                <span style={{ fontSize: '0.9rem' }}>
                  {invoice?.job ? (
                    <Link to={`/jobs/${invoice.job.id}`} style={{ fontWeight: 600 }}>
                      {invoice.job.job_number} · {invoice.job.name}
                    </Link>
                  ) : (
                    '—'
                  )}
                </span>
              )}
            </Field>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <Field label="Issue date">
              {editing ? (
                <input
                  type="date"
                  value={issueDate}
                  onChange={(e) => setIssueDate(e.target.value)}
                  className="form-input"
                />
              ) : (
                <span style={{ fontSize: '0.9rem', color: 'var(--text-title)' }}>
                  {invoice?.issue_date}
                </span>
              )}
            </Field>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
              <Field label="Terms (days)">
                {editing ? (
                  <input
                    type="number"
                    min={0}
                    value={termsDays}
                    onChange={(e) => setTermsDays(Number(e.target.value))}
                    className="form-input"
                  />
                ) : (
                  <span style={{ fontSize: '0.9rem' }}>{invoice?.terms_days} days</span>
                )}
              </Field>

              <Field label="Due date">
                <span
                  style={{
                    fontSize: '0.9rem',
                    fontWeight: 600,
                    color: 'var(--text-title)',
                    display: 'inline-block',
                    paddingTop: '0.5rem',
                  }}
                >
                  {editing ? dueDate : invoice?.due_date}
                </span>
              </Field>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <Field label="Notes (visible on invoice)">
              {editing ? (
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Thanks for your business"
                  className="form-textarea"
                  style={{ minHeight: '80px' }}
                />
              ) : (
                <p
                  style={{
                    fontSize: '0.875rem',
                    color: 'var(--text-body)',
                    margin: 0,
                    whiteSpace: 'pre-wrap',
                    lineHeight: '1.4',
                  }}
                >
                  {invoice?.notes ?? '—'}
                </p>
              )}
            </Field>
          </div>
        </div>
      </div>

      {/* Line Items block */}
      <h2 style={{ fontSize: '1.25rem', marginBottom: '0.75rem' }}>Line Items</h2>
      <div className="table-premium-container" style={{ marginBottom: '1.5rem' }}>
        <table className="table-premium">
          <thead>
            <tr>
              <th style={{ width: '50px' }}>#</th>
              <th>Description</th>
              <th style={{ textAlign: 'right', width: '100px' }}>Qty</th>
              <th style={{ textAlign: 'right', width: '130px' }}>Unit price (ex)</th>
              <th style={{ width: '150px' }}>GST</th>
              <th style={{ textAlign: 'right', width: '150px' }}>Line total inc</th>
              {editing && <th style={{ width: '50px' }}></th>}
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td>{l.line_number}</td>
                <td>
                  {editing ? (
                    <input
                      aria-label={`Line ${l.line_number} description`}
                      value={l.description}
                      onChange={(e) => updateLine(i, { description: e.target.value })}
                      placeholder="e.g. Fence install — 30m"
                      className="form-input"
                      style={{ padding: '0.4rem 0.6rem' }}
                    />
                  ) : (
                    l.description
                  )}
                </td>
                <td style={{ textAlign: 'right' }}>
                  {editing ? (
                    <input
                      aria-label={`Line ${l.line_number} quantity`}
                      type="number"
                      step="0.01"
                      value={l.quantity}
                      onChange={(e) => updateLine(i, { quantity: parseFloat(e.target.value) || 0 })}
                      className="form-input"
                      style={{ textAlign: 'right', padding: '0.4rem 0.6rem' }}
                    />
                  ) : (
                    l.quantity
                  )}
                </td>
                <td style={{ textAlign: 'right' }}>
                  {editing ? (
                    <input
                      aria-label={`Line ${l.line_number} unit price excluding GST`}
                      type="number"
                      step="0.01"
                      value={(l.unit_price_cents / 100).toFixed(2)}
                      onChange={(e) =>
                        updateLine(i, {
                          unit_price_cents: Math.round((parseFloat(e.target.value) || 0) * 100),
                        })
                      }
                      className="form-input"
                      style={{ textAlign: 'right', padding: '0.4rem 0.6rem' }}
                    />
                  ) : (
                    formatMoney(l.unit_price_cents)
                  )}
                </td>
                <td>
                  {editing ? (
                    <select
                      aria-label={`Line ${l.line_number} GST treatment`}
                      value={l.gst_treatment}
                      onChange={(e) =>
                        updateLine(i, {
                          gst_treatment: e.target.value as LineItem['gst_treatment'],
                        })
                      }
                      className="form-select"
                      style={{ padding: '0.4rem 0.6rem' }}
                    >
                      <option value="ex">+ GST</option>
                      <option value="inc">inc GST</option>
                      <option value="free">GST free</option>
                      <option value="zero">Zero-rated (free)</option>
                    </select>
                  ) : (
                    (GST_TREATMENT_LABELS[l.gst_treatment] ?? l.gst_treatment)
                  )}
                </td>
                <td style={{ textAlign: 'right', fontWeight: 600 }}>
                  {formatMoney(l.line_total_inc_gst_cents)}
                </td>
                {editing && (
                  <td style={{ textAlign: 'right' }}>
                    <button
                      aria-label={`Remove line ${l.line_number}`}
                      onClick={() => removeLine(i)}
                      className="btn btn-ghost"
                      style={{ color: 'var(--text-danger)', padding: '0.2rem 0.4rem' }}
                    >
                      <X size={16} />
                    </button>
                  </td>
                )}
              </tr>
            ))}
            {editing && (
              <tr>
                <td colSpan={7} style={{ padding: '0.75rem' }}>
                  <button
                    onClick={addLine}
                    className="btn btn-secondary"
                    style={{
                      display: 'inline-flex',
                      padding: '0.4rem 0.75rem',
                      fontSize: '0.825rem',
                    }}
                  >
                    <Plus size={14} />
                    <span>Add line item</span>
                  </button>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Totals panel */}
      <div
        style={{
          marginTop: '1.5rem',
          marginLeft: 'auto',
          maxWidth: '360px',
          background: 'var(--bg-panel)',
          padding: '1.25rem',
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--border-subtle)',
          boxShadow: 'var(--shadow-sm)',
        }}
      >
        <Total label="Subtotal ex GST" value={formatMoney(totals.sub)} />
        <Total label="GST (10%)" value={formatMoney(totals.gst)} />
        <Total label="Total inc GST" value={formatMoney(totals.total)} bold />
        {!isNew && invoice && invoice.amount_paid_cents > 0 && (
          <>
            <div
              style={{
                height: '8px',
                borderBottom: '1px solid var(--border-subtle)',
                marginBottom: '8px',
              }}
            />
            <Total label="Amount Paid" value={formatMoney(invoice.amount_paid_cents)} />
            <Total
              label="Balance due"
              value={formatMoney(invoice.balance_due_cents)}
              bold
              highlight
            />
          </>
        )}
      </div>

      {/* Save / Cancel action panel */}
      {editing && (
        <div style={{ marginTop: '1.5rem', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <button
            onClick={save}
            disabled={busy}
            className="btn btn-primary"
            style={{ padding: '0.625rem 1.25rem' }}
          >
            <Save size={16} />
            <span>{busy ? 'Saving…' : isNew ? 'Create invoice' : 'Save changes'}</span>
          </button>
          <button
            onClick={() => (isNew ? navigate('/invoices') : setEditing(false))}
            disabled={busy}
            className="btn btn-secondary"
            style={{ padding: '0.625rem 1.25rem' }}
          >
            <span>Cancel</span>
          </button>
        </div>
      )}

      {/* Payments history */}
      {!isNew && payments.length > 0 && (
        <div style={{ marginTop: '2.5rem' }}>
          <h2 style={{ fontSize: '1.25rem', marginBottom: '0.75rem' }}>Payments Log</h2>
          <div className="table-premium-container">
            <table className="table-premium">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Method</th>
                  <th>Reference</th>
                  <th style={{ textAlign: 'right' }}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => (
                  <tr key={p.id}>
                    <td>{p.paid_at.slice(0, 10)}</td>
                    <td style={{ textTransform: 'uppercase', fontSize: '0.8rem', fontWeight: 600 }}>
                      {p.method ?? '—'}
                    </td>
                    <td>
                      <code>{p.reference ?? '—'}</code>
                    </td>
                    <td
                      style={{ textAlign: 'right', fontWeight: 600, color: 'var(--text-success)' }}
                    >
                      {formatMoney(p.amount_cents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Xero integration drawer */}
      {!isNew && invoice && (
        <div
          className="card"
          style={{
            marginTop: '2.5rem',
            display: 'flex',
            alignItems: 'center',
            gap: '1rem',
            flexWrap: 'wrap',
            padding: '1rem 1.25rem',
          }}
        >
          <span
            style={{
              fontSize: '0.825rem',
              color: 'var(--text-muted)',
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}
          >
            Xero Status
          </span>
          <XeroStatusPill
            xeroStatus={invoice.xero_status}
            lastError={(invoice.metadata?.last_xero_error as string | null) ?? null}
            onRepush={handleXeroRepush}
            repushBusy={xeroBusy}
          />
          {invoice.xero_invoice_id && (
            <code style={{ fontSize: '0.775rem' }}>ID: {invoice.xero_invoice_id}</code>
          )}
          {invoice.xero_synced_at && (
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              Last pushed: {new Date(invoice.xero_synced_at).toLocaleString('en-AU')}
            </span>
          )}
        </div>
      )}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  const generatedId = useId();
  const child = isValidElement<{ id?: string }>(children) ? children : null;
  const labelable =
    child && typeof child.type === 'string' && ['input', 'select', 'textarea'].includes(child.type);
  const controlId =
    labelable && child ? (child.props.id ?? `invoice-field-${generatedId}`) : undefined;
  const labelledChild =
    labelable && child && controlId ? cloneElement(child, { id: controlId }) : children;

  return (
    <div className="form-group">
      <label className="form-label" htmlFor={controlId} style={{ fontSize: '0.725rem' }}>
        {label}
      </label>
      <div style={{ marginTop: '0.25rem' }}>{labelledChild}</div>
    </div>
  );
}

function Total({
  label,
  value,
  bold,
  highlight,
}: {
  label: string;
  value: string;
  bold?: boolean;
  highlight?: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        padding: '0.5rem 0',
        fontSize: '0.875rem',
        borderBottom: '1px solid var(--border-subtle)',
        fontWeight: bold ? 700 : 500,
        color: highlight ? 'var(--text-warning)' : bold ? 'var(--text-title)' : 'var(--text-body)',
      }}
    >
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span>{value}</span>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  let badgeClass = 'badge-neutral';
  if (status === 'paid') badgeClass = 'badge-success';
  else if (status === 'sent') badgeClass = 'badge-info';
  else if (status === 'partially_paid') badgeClass = 'badge-warning';
  else if (status === 'overdue') badgeClass = 'badge-danger';

  return (
    <span className={`badge ${badgeClass}`} style={{ alignSelf: 'center' }}>
      {status.replace('_', ' ')}
    </span>
  );
}
