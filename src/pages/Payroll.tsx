import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';
import { useSuperBatch } from '@/hooks/useSuperBatch';
import { formatMoney, formatMoneyCompact } from '@/lib/money';
import { SkeletonTable } from '@/components/Skeleton';
import { InsightAreaChart, InsightBarList, InsightPanel } from '@/components/InsightCharts';
import {
  addDays,
  financialYearQuarter,
  orgTimeZone,
  startOfFinancialYear,
  todayLocal,
  weekdayOf,
} from '@/lib/localDates';
import {
  Plus,
  DollarSign,
  Wallet,
  FileText,
  Layers,
  X,
  Info,
  Send,
  CheckCircle2,
  Loader2,
} from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { Field } from '@/components/ui/Field';
import { Stat } from '@/components/ui/Stat';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { EmptyState } from '@/components/ui/EmptyState';

interface PayRun {
  id: string;
  period_start: string;
  period_end: string;
  pay_date: string;
  status: 'draft' | 'approved' | 'paid' | 'cancelled' | 'reversed';
  total_gross_cents: number;
  total_tax_cents: number;
  total_super_cents: number;
  total_net_cents: number;
  created_at: string;
}

interface Employee {
  id: string;
  full_name: string;
  is_active: boolean;
}

/** Row of v_pay_run_super_due: when the fund must receive the super guarantee for a pay run. */
interface PayRunSuperDue {
  pay_run_id: string;
  super_due_rule: 'payday_super' | 'quarterly';
  super_due_date: string;
}

export function PayrollPage() {
  const { currentOrg } = useOrg();
  const [runs, setRuns] = useState<PayRun[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [superDue, setSuperDue] = useState<Record<string, PayRunSuperDue>>({});
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);

  const refresh = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);
    const [runsRes, empRes, dueRes] = await Promise.all([
      supabase
        .from('pay_runs')
        .select('*')
        .eq('organization_id', currentOrg.id)
        .order('period_start', { ascending: false }),
      supabase
        .from('employees')
        .select('id, full_name, is_active')
        .eq('organization_id', currentOrg.id)
        .is('deleted_at', null)
        .order('full_name'),
      supabase
        .from('v_pay_run_super_due')
        .select('pay_run_id, super_due_rule, super_due_date')
        .eq('organization_id', currentOrg.id),
    ]);
    setRuns((runsRes.data ?? []) as PayRun[]);
    setEmployees((empRes.data ?? []) as Employee[]);
    // Best-effort: without the view (migration 20261003130200 not applied) the column shows a dash.
    const dueRows = dueRes.error ? [] : ((dueRes.data ?? []) as PayRunSuperDue[]);
    setSuperDue(Object.fromEntries(dueRows.map((d) => [d.pay_run_id, d])));
    setLoading(false);
  }, [currentOrg]);

  useEffect(() => void refresh(), [refresh]);

  if (!currentOrg) return null;

  const ytdTotals = runs
    .filter((r) => r.status === 'paid' && r.pay_date >= fyStart(orgTimeZone(currentOrg)))
    .reduce(
      (acc, r) => ({
        gross: acc.gross + Number(r.total_gross_cents),
        tax: acc.tax + Number(r.total_tax_cents),
        sup: acc.sup + Number(r.total_super_cents),
        net: acc.net + Number(r.total_net_cents),
      }),
      { gross: 0, tax: 0, sup: 0, net: 0 },
    );

  // Wage Component Breakdown (Top 3 allocations)
  const paidRuns = runs.filter((r) => r.status === 'paid');
  const sumNet = paidRuns.reduce((a, r) => a + Number(r.total_net_cents), 0);
  const sumTax = paidRuns.reduce((a, r) => a + Number(r.total_tax_cents), 0);
  const sumSuper = paidRuns.reduce((a, r) => a + Number(r.total_super_cents), 0);
  const payrollSplitItems = [
    {
      label: 'Net Wages Paid',
      value: sumNet,
      displayValue: formatMoneyCompact(sumNet),
      tone: 'success' as const,
    },
    {
      label: 'PAYG Tax Withheld',
      value: sumTax,
      displayValue: formatMoneyCompact(sumTax),
      tone: 'warning' as const,
    },
    {
      label: 'Superannuation Guarantee',
      value: sumSuper,
      displayValue: formatMoneyCompact(sumSuper),
      tone: 'info' as const,
    },
  ];

  // Wage Trend (chronological paid runs)
  let runningNetCents = 0;
  let runningGrossCents = 0;
  let runningSuperCents = 0;

  const runsChronological = paidRuns.slice().sort((a, b) => a.pay_date.localeCompare(b.pay_date));

  const netWagesTrend = runsChronological.length
    ? runsChronological.map((r) => {
        runningNetCents += Number(r.total_net_cents);
        return {
          label: new Date(r.pay_date).toLocaleDateString('en-AU', {
            day: '2-digit',
            month: 'short',
          }),
          value: runningNetCents,
        };
      })
    : [{ label: 'No pay runs', value: 0 }];

  const grossWagesTrend = runsChronological.map((r) => {
    runningGrossCents += Number(r.total_gross_cents);
    return {
      label: new Date(r.pay_date).toLocaleDateString('en-AU', { day: '2-digit', month: 'short' }),
      value: runningGrossCents,
    };
  });

  const superTrend = runsChronological.map((r) => {
    runningSuperCents += Number(r.total_super_cents);
    return {
      label: new Date(r.pay_date).toLocaleDateString('en-AU', { day: '2-digit', month: 'short' }),
      value: runningSuperCents,
    };
  });

  // Current AU FY quarter for the super-batch section.
  const { fyStart: superFyStart, quarter: superQuarter } = currentAuFyQuarter(
    orgTimeZone(currentOrg),
  );

  return (
    <section className="animated-fade-in">
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
        <PageHeader title={<><Layers size={24} style={{ color: 'var(--text-link)' }} /> Payroll</>} />
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <button
            onClick={() => setShowCreate(true)}
            disabled={employees.filter((e) => e.is_active).length === 0}
            className="btn btn-primary"
          >
            <Plus size={16} />
            <span>New pay run</span>
          </button>
        </div>
      </div>

      {/* YTD Stats */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: '1rem',
          marginBottom: '1.5rem',
        }}
      >
        <Stat
          label="YTD Gross Paid"
          value={ytdTotals.gross}
          formatter={formatMoney}
          tone="neutral"
          icon={DollarSign}
        />
        <Stat
          label="YTD PAYG Withheld"
          value={ytdTotals.tax}
          formatter={formatMoney}
          tone="danger"
          icon={DollarSign}
        />
        <Stat
          label="YTD Super Guarantee"
          value={ytdTotals.sup}
          formatter={formatMoney}
          tone="info"
          icon={Wallet}
        />
        <Stat
          label="YTD Net Paid"
          value={ytdTotals.net}
          formatter={formatMoney}
          tone="success"
          icon={Wallet}
        />
      </div>

      {/* Charts Section */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          gap: '1rem',
          marginBottom: '2rem',
        }}
      >
        <InsightPanel title="Wages pulse" eyebrow="Cumulative payroll velocity">
          <InsightAreaChart
            title="Net paid"
            items={netWagesTrend}
            tone="success"
            series={[
              { label: 'Gross', items: grossWagesTrend, tone: 'info' },
              { label: 'Super', items: superTrend, tone: 'neutral' },
            ]}
            markerLabel="Net Wages"
            formatValue={formatMoneyCompact}
          />
        </InsightPanel>
        <InsightPanel title="Payroll split" eyebrow="Wage expense allocation">
          {paidRuns.length === 0 ? (
            <div style={{ color: 'var(--text-muted)', fontSize: '0.875rem', padding: '1rem 0' }}>
              No wage allocations to display.
            </div>
          ) : (
            <InsightBarList items={payrollSplitItems} formatValue={formatMoneyCompact} />
          )}
        </InsightPanel>
      </div>

      {showCreate && (
        <div
          className="card"
          style={{
            marginBottom: '1.5rem',
            border: '1px solid var(--accent-primary)',
            position: 'relative',
          }}
        >
          <button aria-label="Close"
            onClick={() => setShowCreate(false)}
            style={{
              position: 'absolute',
              right: '1rem',
              top: '1rem',
              background: 'none',
              border: 'none',
              color: 'var(--text-muted)',
              cursor: 'pointer',
            }}
          >
            <X size={20} />
          </button>
          <CreatePayRunForm
            employees={employees.filter((e) => e.is_active)}
            onClose={() => setShowCreate(false)}
            onCreated={() => {
              setShowCreate(false);
              void refresh();
            }}
          />
        </div>
      )}

      <h2
        style={{
          fontSize: '1.25rem',
          marginBottom: '0.75rem',
          display: 'flex',
          alignItems: 'center',
          gap: '0.35rem',
        }}
      >
        <FileText size={16} style={{ color: 'var(--text-muted)' }} />
        Pay runs
      </h2>

      {loading ? (
        <SkeletonTable rows={3} cols={8} />
      ) : runs.length === 0 ? (
        <EmptyState>
          No pay runs yet. Approve some timesheets and click <strong>New pay run</strong> to start.
        </EmptyState>
      ) : (
        <div className="table-premium-container">
          <table className="table-premium">
            <thead>
              <tr>
                <th>Period</th>
                <th>Pay date</th>
                <th>Status</th>
                <th style={{ textAlign: 'right' }}>Gross</th>
                <th style={{ textAlign: 'right' }}>PAYG</th>
                <th style={{ textAlign: 'right' }}>Super</th>
                <th>Super due</th>
                <th style={{ textAlign: 'right' }}>Net</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link to={`/payroll/${r.id}`} style={{ fontWeight: 600 }}>
                      {r.period_start} → {r.period_end}
                    </Link>
                  </td>
                  <td>{r.pay_date}</td>
                  <td>
                    <StatusBadge status={r.status} />
                  </td>
                  <td style={{ textAlign: 'right' }}>{formatMoney(Number(r.total_gross_cents))}</td>
                  <td style={{ textAlign: 'right' }}>{formatMoney(Number(r.total_tax_cents))}</td>
                  <td style={{ textAlign: 'right' }}>{formatMoney(Number(r.total_super_cents))}</td>
                  <td>
                    <SuperDueCell due={superDue[r.id]} />
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>
                    {formatMoney(Number(r.total_net_cents))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p
            style={{
              margin: '0.75rem 1rem',
              fontSize: '0.75rem',
              color: 'var(--text-muted)',
              lineHeight: 1.5,
            }}
          >
            Super due is the date the employee&apos;s fund must receive the super guarantee. For pay
            dates from 1 July 2026 (Payday Super) that is 7 business days after payday, or 20 for a
            new employee&apos;s first contribution to a fund. Before then it was 28 days after the end
            of the quarter. Public holidays are only counted once recorded in Looplet, so a date can
            be earlier than the legal deadline but never later.
          </p>
        </div>
      )}
      <SuperBatchSection fy={superFyStart} quarter={superQuarter} />
    </section>
  );
}

function SuperDueCell({ due }: { due: PayRunSuperDue | undefined }) {
  if (!due) return <span style={{ color: 'var(--text-muted)' }}>—</span>;
  return (
    <span>
      {due.super_due_date}
      <span style={{ display: 'block', fontSize: '0.7rem', color: 'var(--text-muted)' }}>
        {due.super_due_rule === 'payday_super' ? 'Payday Super' : 'Quarterly'}
      </span>
    </span>
  );
}

export function SuperBatchSection({ fy, quarter }: { fy: number; quarter: number }) {
  const { batch, loading, error, generate, send } = useSuperBatch(fy, quarter);
  const [busy, setBusy] = useState<null | 'generate' | 'send'>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const fyLabel = `Q${quarter} FY${fy}-${String((fy + 1) % 100).padStart(2, '0')}`;
  const isSent = batch !== null && (batch.status === 'sent' || batch.status === 'confirmed');
  // file_prepared: the clearing-house file exists, but nothing has been sent to a fund or paid.
  const isPrepared = batch?.status === 'file_prepared';

  const downloadPayload = (payload: Record<string, unknown>, filename: string) => {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleGenerate = async (): Promise<void> => {
    setBusy('generate');
    setMsg(null);
    setActionError(null);
    try {
      await generate();
      setMsg('Draft batch generated.');
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const handleSend = async (): Promise<void> => {
    setBusy('send');
    setMsg(null);
    setActionError(null);
    try {
      const r = await send();
      if (r.file_prepared || r.already_prepared || r.already_sent) {
        if (r.payload) {
          downloadPayload(r.payload, `superstream-${fyLabel.replace(/\s+/g, '-')}.json`);
        }
        setMsg(
          r.already_sent
            ? 'This batch is already recorded as sent.'
            : r.already_prepared
              ? 'Clearing-house file downloaded again. Looplet has not sent or paid anything.'
              : 'Clearing-house file prepared and downloaded for manual upload. Looplet has not sent it or paid anything: upload it to your clearing house and pay the contributions there.',
        );
      } else if (r.approval_id) {
        setMsg('Approval requested - pending Tier-2 approval before this batch can export.');
      } else {
        setActionError(r.error ?? 'Send was refused.');
      }
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="card" style={{ padding: '1.5rem', marginTop: '2rem' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '1rem',
          flexWrap: 'wrap',
          marginBottom: '0.25rem',
        }}
      >
        <h2
          style={{
            fontSize: '1.25rem',
            margin: 0,
            display: 'flex',
            alignItems: 'center',
            gap: '0.35rem',
          }}
        >
          <Wallet size={16} style={{ color: 'var(--text-muted)' }} />
          Super batch - {fyLabel}
        </h2>
        <button className="btn btn-secondary" onClick={handleGenerate} disabled={busy !== null}>
          {busy === 'generate' ? <Loader2 size={14} /> : <Plus size={14} />}
          <span>{batch ? 'Regenerate' : 'Generate batch'}</span>
        </button>
      </div>
      <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', margin: '0 0 1rem' }}>
        Quarterly super guarantee per employee from finalised pay runs. Export is Tier-2 gated and
        prepares a clearing-house upload file. Looplet does not send contributions to funds or pay
        them: you upload the file to your clearing house and pay there.
      </p>

      {loading ? (
        <div aria-busy="true" aria-label="Loading super batch">
          <SkeletonTable rows={3} cols={5} />
        </div>
      ) : error ? (
        <div
          className="badge badge-warning"
          style={{ display: 'block', textTransform: 'none', padding: '0.75rem' }}
        >
          Super batch unavailable: {error}. (Apply migration 0124 + deploy super-batch-send.)
        </div>
      ) : !batch ? (
        <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
          No batch for this quarter yet. Click <strong>Generate batch</strong> to build one from
          finalised pay runs.
        </div>
      ) : (
        <>
          <div className="table-premium-container">
            <table className="table-premium">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Fund</th>
                  <th>Member</th>
                  <th style={{ textAlign: 'right' }}>Super guarantee</th>
                </tr>
              </thead>
              <tbody>
                {batch.lines.map((l) => (
                  <tr key={l.id}>
                    <td>{l.employee_name}</td>
                    <td>
                      {l.fund_usi ? (
                        <>
                          {l.fund_name ?? 'Super fund'} · <code>{l.fund_usi}</code>
                        </>
                      ) : (
                        <span className="badge badge-warning">Missing fund</span>
                      )}
                    </td>
                    <td>
                      {l.member_number ?? (
                        <span className="badge badge-warning">Missing member</span>
                      )}
                    </td>
                    <td style={{ textAlign: 'right' }}>{formatMoney(l.super_cents)}</td>
                  </tr>
                ))}
                <tr style={{ fontWeight: 700 }}>
                  <td colSpan={3}>
                    Total ({batch.line_count} {batch.line_count === 1 ? 'employee' : 'employees'})
                  </td>
                  <td style={{ textAlign: 'right' }}>{formatMoney(batch.total_super_cents)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.75rem',
              flexWrap: 'wrap',
              marginTop: '1rem',
            }}
          >
            <span
              className={`badge ${isSent ? 'badge-success' : isPrepared ? 'badge-info' : 'badge-warning'}`}
              style={{
                textTransform: 'none',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.25rem',
              }}
            >
              {isSent ? <CheckCircle2 size={13} /> : null}
              {superBatchStatusLabel(batch.status)}
            </span>
            <button
              className="btn btn-primary"
              onClick={handleSend}
              disabled={busy !== null || isSent || batch.line_count === 0}
              title={
                isSent
                  ? 'Already recorded as sent'
                  : isPrepared
                    ? 'Download the prepared clearing-house file again'
                    : 'Open a Tier-2 approval and prepare the clearing-house file'
              }
            >
              {busy === 'send' ? <Loader2 size={14} /> : <Send size={14} />}
              <span>{isPrepared ? 'Download file again' : 'Approve & export'}</span>
            </button>
          </div>
          {msg && (
            <p style={{ color: 'var(--text-success)', fontSize: '0.8rem', marginTop: '0.75rem' }}>
              {msg}
            </p>
          )}
          {actionError && (
            <p style={{ color: 'var(--text-danger)', fontSize: '0.8rem', marginTop: '0.75rem' }}>
              {actionError}
            </p>
          )}
        </>
      )}
    </div>
  );
}

function superBatchStatusLabel(status: string): string {
  if (status === 'file_prepared') return 'File prepared, not paid';
  if (status === 'sent') return 'Recorded as sent';
  return status.replace(/_/g, ' ');
}

function CreatePayRunForm({
  employees,
  onClose,
  onCreated,
}: {
  employees: Employee[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const { currentOrg } = useOrg();
  const [frequency, setFrequency] = useState<'weekly' | 'fortnightly' | 'monthly'>('weekly');
  // Default to last week (Monday to Sunday), paid the Wednesday after, as dates in the
  // organisation's time zone.
  const today = todayLocal(orgTimeZone(currentOrg));
  const day = weekdayOf(today);
  const diffToMon = day === 0 ? -6 : 1 - day;
  const monday = addDays(today, diffToMon - 7);
  const sunday = addDays(monday, 6);
  const payDate = addDays(sunday, 3);

  const [periodStart, setPeriodStart] = useState(monday);
  const [periodEnd, setPeriodEnd] = useState(sunday);
  const [payDateStr, setPayDateStr] = useState(payDate);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set(employees.map((e) => e.id)));
  const [claimsThreshold, setClaimsThreshold] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const toggle = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  };

  const submit = async () => {
    if (!currentOrg) return;
    setBusy(true);
    setErr(null);
    const { data, error } = await supabase.functions.invoke('payroll-create-pay-run', {
      body: {
        organization_id: currentOrg.id,
        period_start: periodStart,
        period_end: periodEnd,
        pay_date: payDateStr,
        employee_ids: Array.from(selectedIds),
        frequency,
        claims_threshold: claimsThreshold,
      },
    });
    setBusy(false);
    if (error) {
      setErr(error.message);
      return;
    }
    if (!(data as { ok?: boolean })?.ok) {
      setErr((data as { error?: string })?.error ?? 'Failed to create pay run');
      return;
    }
    onCreated();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', padding: '0.5rem' }}>
      <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <Plus size={18} style={{ color: 'var(--text-link)' }} />
        Create New Pay Run
      </h3>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: '1rem',
        }}
      >
        <Field label="Frequency">
          <select
            value={frequency}
            onChange={(e) => setFrequency(e.target.value as typeof frequency)}
            className="form-select"
          >
            <option value="weekly">Weekly</option>
            <option value="fortnightly">Fortnightly</option>
            <option value="monthly">Monthly</option>
          </select>
        </Field>
        <Field label="Period start">
          <input
            type="date"
            value={periodStart}
            onChange={(e) => setPeriodStart(e.target.value)}
            className="form-input"
          />
        </Field>
        <Field label="Period end">
          <input
            type="date"
            value={periodEnd}
            onChange={(e) => setPeriodEnd(e.target.value)}
            className="form-input"
          />
        </Field>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: '1rem',
        }}
      >
        <Field label="Pay date">
          <input
            type="date"
            value={payDateStr}
            onChange={(e) => setPayDateStr(e.target.value)}
            className="form-input"
          />
        </Field>
        <Field label="Tax-free threshold">
          <select
            value={claimsThreshold ? 'yes' : 'no'}
            onChange={(e) => setClaimsThreshold(e.target.value === 'yes')}
            className="form-select"
          >
            <option value="yes">Claimed (Scale 2 — most employees)</option>
            <option value="no">Not claimed (Scale 1 — second job / non-resident)</option>
          </select>
        </Field>
      </div>

      <h4
        style={{
          fontSize: '0.825rem',
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          marginTop: '0.5rem',
          marginBottom: '0.25rem',
        }}
      >
        Employees ({selectedIds.size}/{employees.length})
      </h4>
      <div
        style={{
          maxHeight: '160px',
          overflowY: 'auto',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-sm)',
          padding: '0.5rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.25rem',
        }}
      >
        {employees.length === 0 ? (
          <p style={{ color: 'var(--text-muted)', fontSize: '0.825rem', margin: '0.5rem 0' }}>
            No active employees.
          </p>
        ) : (
          employees.map((e) => (
            <label
              key={e.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                fontSize: '0.875rem',
                cursor: 'pointer',
                padding: '0.25rem 0',
              }}
            >
              <input
                type="checkbox"
                checked={selectedIds.has(e.id)}
                onChange={() => toggle(e.id)}
                style={{ cursor: 'pointer' }}
              />
              <span style={{ color: 'var(--text-body)' }}>{e.full_name}</span>
            </label>
          ))
        )}
      </div>

      <div
        style={{
          background: 'var(--bg-hover)',
          padding: '0.75rem',
          borderRadius: 'var(--radius-sm)',
          fontSize: '0.75rem',
          color: 'var(--text-muted)',
          display: 'flex',
          gap: '0.5rem',
          alignItems: 'flex-start',
        }}
      >
        <Info
          size={14}
          style={{ flexShrink: 0, marginTop: '2px', color: 'var(--text-link)' }}
        />
        <span>
          The run will pull <strong>approved</strong> timesheets in [{periodStart} → {periodEnd}],
          split into ordinary / overtime / leave hours by <code>entry_type</code>, and compute PAYG
          + super.
        </span>
      </div>

      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
        <button
          onClick={submit}
          disabled={busy || selectedIds.size === 0}
          className="btn btn-primary"
          style={{ padding: '0.625rem 1.25rem' }}
        >
          <span>{busy ? 'Creating…' : 'Create draft pay run'}</span>
        </button>
        <button
          onClick={onClose}
          disabled={busy}
          className="btn btn-secondary"
          style={{ padding: '0.625rem 1.25rem' }}
        >
          <span>Cancel</span>
        </button>
      </div>
      {err && (
        <div
          className="badge badge-danger"
          style={{ display: 'block', padding: '0.625rem', textTransform: 'none' }}
        >
          {err}
        </div>
      )}
    </div>
  );
}

/** 1 July of the current AU financial year, judged on today's date in the org's time zone. */
function fyStart(timeZone: string): string {
  return startOfFinancialYear(todayLocal(timeZone));
}

/** Current AU FY quarter (FY starts 1 Jul) in the org's time zone. */
function currentAuFyQuarter(timeZone: string): { fyStart: number; quarter: number } {
  const { fyStartYear, quarter } = financialYearQuarter(todayLocal(timeZone));
  return { fyStart: fyStartYear, quarter };
}
