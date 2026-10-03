import {
  useCallback,
  useEffect,
  useState,
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
import { addDays, isIsoDate, orgTimeZone, todayLocal } from '@/lib/localDates';
import {
  invoiceDocumentTitle,
  invoiceIssueProblems,
  renderInvoicePdf,
  type InvoiceDocumentInput,
} from '@/lib/taxInvoice';
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
  Download,
  Share2,
} from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { Field } from '@/components/ui/Field';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { EmptyState } from '@/components/ui/EmptyState';

interface Customer {
  id: string;
  name: string;
  email: string | null;
  abn?: string | null;
}
interface Seller {
  name: string;
  abn: string | null;
  gstRegistered: boolean;
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

/** Registered only when at least one setting says so and none says it isn't; unknown counts as not registered. */
function isGstRegistered(flags: (boolean | null | undefined)[]): boolean {
  return flags.some((f) => f === true) && !flags.some((f) => f === false);
}

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
  const [seller, setSeller] = useState<Seller | null>(null);

  const [customerId, setCustomerId] = useState<string>(searchParams.get('customer_id') ?? '');
  const [jobId, setJobId] = useState<string>(searchParams.get('job_id') ?? '');
  const [issueDate, setIssueDate] = useState(() => todayLocal(orgTimeZone(currentOrg)));
  const [termsDays, setTermsDays] = useState(14);
  const [notes, setNotes] = useState('');

  // Calendar arithmetic on the date string: no UTC round trip, and no crash when the
  // issue-date input has been cleared.
  const dueDate = isIsoDate(issueDate) ? addDays(issueDate, termsDays) : '';

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
      const [invRes, linesRes, paysRes, orgRes, profileRes] = await Promise.all([
        supabase
          .from('invoices')
          .select(
            `
          *,
          customer:customers!invoices_customer_id_fkey(id, name, email, abn),
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
        // The seller on the tax invoice: business name, ABN and GST registration.
        supabase
          .from('organizations')
          .select('name, abn, settings')
          .eq('id', currentOrg.id)
          .maybeSingle(),
        supabase
          .from('business_profile')
          .select('is_gst_registered')
          .eq('organization_id', currentOrg.id)
          .maybeSingle(),
      ]);
      const org = orgRes.data as {
        name: string | null;
        abn: string | null;
        settings: { gst_registered?: boolean } | null;
      } | null;
      const profile = profileRes.data as { is_gst_registered: boolean | null } | null;
      setSeller({
        name: org?.name ?? currentOrg.name,
        abn: org?.abn ?? null,
        // A tax invoice needs an explicit "registered" setting, and no setting saying otherwise. Unknown is
        // treated as not registered, so a business that never set its status gets a plain invoice with no GST,
        // never a wrong tax invoice.
        gstRegistered: isGstRegistered([org?.settings?.gst_registered, profile?.is_gst_registered]),
      });
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
      // For a GST-inclusive price the ex-GST amount is the price less its GST (it was stored as the
      // full price, so subtotal + GST overstated the invoice total).
      next.line_total_ex_gst_cents = inc - gst;
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
      <section className="animated-fade-in">
        <EmptyState icon={AlertCircle} title="Invoice not found" action={<Link to="/invoices" className="btn btn-secondary"> <ChevronLeft size={16} /> Back to invoices </Link>}>
          No invoice details were found under this organization.
        </EmptyState>
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
        <PageHeader title={<><FileSpreadsheet size={24} style={{ color: 'var(--text-link)' }} /> {isNew ? 'New invoice' : <code>{invoice?.invoice_number}</code>}</>} />

        {!isNew && invoice && (
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <StatusBadge status={invoice.status} />

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

      {!isNew && invoice && !editing && seller && (
        <TaxInvoicePanel
          input={{
            invoiceNumber: invoice.invoice_number,
            issueDate: invoice.issue_date,
            dueDate: invoice.due_date,
            seller,
            buyer: {
              name: invoice.customer?.name ?? null,
              abn: invoice.customer?.abn ?? null,
              email: invoice.customer?.email ?? null,
            },
            lines: lines.map((line) => ({
              description: line.description,
              quantity: line.quantity,
              unitPriceCents: line.unit_price_cents,
              gstTreatment: line.gst_treatment,
              totalIncGstCents: line.line_total_inc_gst_cents,
              gstCents: line.line_gst_cents,
            })),
            notes: invoice.notes,
            amountPaidCents: invoice.amount_paid_cents,
          }}
          status={invoice.status}
        />
      )}

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

/**
 * Issues the invoice as a PDF: "Tax invoice" with the seller's ABN and GST for a GST-registered
 * business, or a plain "Invoice" otherwise. Looplet doesn't email it: the owner downloads it (or
 * shares it from a phone) and sends it, then marks the invoice sent.
 */
function TaxInvoicePanel({ input, status }: { input: InvoiceDocumentInput; status: string }) {
  const [message, setMessage] = useState<string | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);
  const problems = invoiceIssueProblems(input);
  const title = invoiceDocumentTitle(input);
  const fileName = `${title.replace(/\s+/g, '-')}-${input.invoiceNumber || 'draft'}.pdf`;

  const pdfFile = () => new File([renderInvoicePdf(input)], fileName, { type: 'application/pdf' });

  const download = () => {
    const url = URL.createObjectURL(pdfFile());
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setMessage(
      status === 'draft'
        ? `${title} downloaded. Send it to your customer, then click Mark sent.`
        : `${title} downloaded.`,
    );
  };

  const canShareFiles =
    typeof navigator !== 'undefined' &&
    typeof navigator.canShare === 'function' &&
    typeof navigator.share === 'function';

  const share = async () => {
    setShareError(null);
    const file = pdfFile();
    if (!navigator.canShare({ files: [file] })) {
      setShareError('This device can’t share files. Download the PDF instead.');
      return;
    }
    try {
      await navigator.share({ files: [file], title: `${title} ${input.invoiceNumber}` });
      setMessage(status === 'draft' ? 'Shared. Click Mark sent once your customer has it.' : null);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setShareError(err instanceof Error ? err.message : String(err));
    }
  };

  const mailto = input.buyer.email
    ? `mailto:${encodeURIComponent(input.buyer.email)}?subject=${encodeURIComponent(
        `${title} ${input.invoiceNumber} from ${input.seller.name}`,
      )}&body=${encodeURIComponent(
        `Hi,\n\nPlease find attached ${title.toLowerCase()} ${input.invoiceNumber}.\n\nThanks,\n${input.seller.name}`,
      )}`
    : null;

  return (
    <section
      className="card"
      aria-labelledby="tax-invoice-heading"
      style={{ marginTop: '1.5rem', display: 'grid', gap: '0.75rem' }}
    >
      <h2 id="tax-invoice-heading" style={{ margin: 0, fontSize: '1.1rem' }}>
        Issue {title.toLowerCase()}
      </h2>
      <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '0.85rem' }}>
        {input.seller.gstRegistered
          ? 'The PDF is headed “Tax invoice” and shows your business name and ABN, the date, each item with its quantity, price and GST, which items are taxable, the customer, and the GST and total payable.'
          : 'Your business is set as not registered for GST, so this is a plain invoice: it does not say “Tax invoice” and charges no GST.'}{' '}
        Looplet doesn’t email invoices for you: send the PDF yourself, then click Mark sent.
      </p>
      {problems.length > 0 ? (
        <div role="alert" style={{ color: 'var(--text-danger)', fontSize: '0.85rem' }}>
          <strong>Before you can issue it:</strong>
          <ul style={{ margin: '0.35rem 0 0', paddingLeft: '1.1rem' }}>
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        <button
          type="button"
          className="btn btn-primary"
          onClick={download}
          disabled={problems.length > 0}
        >
          <Download size={14} />
          <span>Download {title.toLowerCase()} (PDF)</span>
        </button>
        {canShareFiles ? (
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => void share()}
            disabled={problems.length > 0}
          >
            <Share2 size={14} />
            <span>Share PDF</span>
          </button>
        ) : null}
        {mailto && problems.length === 0 ? (
          <a className="btn btn-secondary" href={mailto}>
            <Mail size={14} />
            <span>Email customer (attach the PDF)</span>
          </a>
        ) : null}
      </div>
      {message ? (
        <p role="status" style={{ margin: 0, color: 'var(--text-success)', fontSize: '0.85rem' }}>
          {message}
        </p>
      ) : null}
      {shareError ? (
        <p role="alert" style={{ margin: 0, color: 'var(--text-danger)', fontSize: '0.85rem' }}>
          {shareError}
        </p>
      ) : null}
    </section>
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
