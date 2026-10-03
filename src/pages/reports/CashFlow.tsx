import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';
import { formatMoney } from '@/lib/money';
import { downloadCsv } from '@/lib/csv';
import { formatLoadError } from '@/lib/errorMessages';
import { SkeletonTable } from '@/components/Skeleton';
import {
  ChevronLeft,
  Download,
  TrendingUp,
  DollarSign,
  Wallet,
  Info,
} from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { Stat } from '@/components/ui/Stat';

interface FlowRow {
  week_start: string;
  source_type: 'invoice' | 'bill';
  amount_cents: number;
}

interface AggRow {
  week_start: string;
  inflow: number;
  outflow: number;
  net: number;
  running?: number;
}

export function CashFlowPage() {
  const { currentOrg } = useOrg();
  const [rows, setRows] = useState<AggRow[]>([]);
  const [openingBalance, setOpeningBalance] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);
    setError(null);

    const [flowRes, bankRes] = await Promise.all([
      supabase
        .from('v_cash_flow_weekly')
        .select('*')
        .eq('organization_id', currentOrg.id)
        .order('week_start', { ascending: true }),
      supabase
        .from('bank_accounts')
        .select('current_balance_cents')
        .eq('organization_id', currentOrg.id)
        .is('deleted_at', null),
    ]);

    const loadError = flowRes.error?.message ?? bankRes.error?.message;
    if (loadError) {
      setRows([]);
      setOpeningBalance(0);
      setError(loadError);
      setLoading(false);
      return;
    }

    const opening = ((bankRes.data ?? []) as { current_balance_cents: number | null }[]).reduce(
      (sum, acct) => sum + (acct.current_balance_cents ?? 0),
      0,
    );
    setOpeningBalance(opening);

    const agg = new Map<string, AggRow>();
    for (const r of (flowRes.data ?? []) as FlowRow[]) {
      const cur = agg.get(r.week_start) ?? {
        week_start: r.week_start,
        inflow: 0,
        outflow: 0,
        net: 0,
      };
      if (r.source_type === 'invoice') cur.inflow += r.amount_cents;
      else cur.outflow += Math.abs(r.amount_cents);
      cur.net = cur.inflow - cur.outflow;
      agg.set(r.week_start, cur);
    }
    const sorted = Array.from(agg.values()).sort((a, b) =>
      a.week_start.localeCompare(b.week_start),
    );

    let running = opening;
    const withRunning = sorted.map((r) => {
      running += r.net;
      return { ...r, running };
    });
    setRows(withRunning);
    setLoading(false);
  }, [currentOrg]);

  useEffect(() => void refresh(), [refresh]);

  if (!currentOrg) return null;

  const totalIn = rows.reduce((a, r) => a + r.inflow, 0);
  const totalOut = rows.reduce((a, r) => a + r.outflow, 0);
  const finalRunning =
    rows.length > 0
      ? (rows[rows.length - 1] as AggRow & { running: number }).running
      : openingBalance;
  const max = Math.max(...rows.map((r) => Math.max(r.inflow, r.outflow)), 1);

  const handleExport = () => {
    const first = rows[0];
    const last = rows[rows.length - 1];
    if (!first || !last) return;
    const firstWeek = first.week_start.replace(/-/g, '').slice(0, 6);
    const lastWeek = last.week_start.replace(/-/g, '').slice(0, 6);
    const filename = `cash-flow-${firstWeek}-to-${lastWeek}.csv`;
    const exportRows = rows.map((r) => ({
      'Week start': r.week_start,
      'Inflow (AUD)': (r.inflow / 100).toFixed(2),
      'Outflow (AUD)': (r.outflow / 100).toFixed(2),
      'Net (AUD)': (r.net / 100).toFixed(2),
      'Running balance (AUD)': (
        ((r as unknown as Record<string, unknown>).running as number) / 100
      ).toFixed(2),
    }));
    downloadCsv(filename, exportRows);
  };

  return (
    <section className="animated-fade-in">
      {/* Navigation & Export Action */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '1rem',
          flexWrap: 'wrap',
          gap: '1rem',
        }}
      >
        <Link
          to="/reports"
          style={{
            color: 'var(--text-muted)',
            fontSize: '0.825rem',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.25rem',
          }}
        >
          <ChevronLeft size={14} />
          <span>Reports</span>
        </Link>

        {rows.length > 0 && (
          <button
            onClick={handleExport}
            className="btn btn-secondary"
            aria-label="Export cash flow data as CSV"
          >
            <Download size={14} />
            <span>Export CSV</span>
          </button>
        )}
      </div>

      <PageHeader title="Cash Flow Forecast" />
      <p
        style={{
          color: 'var(--text-muted)',
          fontSize: '0.875rem',
          marginTop: '0.25rem',
          marginBottom: '1.5rem',
          maxWidth: '800px',
          lineHeight: '1.5',
        }}
      >
        Weekly buckets of unpaid invoices (expected receipts) and unpaid bills (expected payments).
        Personal-flagged bills are excluded.
      </p>

      {/* KPI Cards */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: '1rem',
          marginBottom: '2rem',
        }}
      >
        <Stat
          label="Opening Balance"
          value={formatMoney(openingBalance)}
          tone="neutral"
          icon={DollarSign}
        />
        <Stat
          label="Expected Receipts"
          value={formatMoney(totalIn)}
          tone="success"
          icon={Wallet}
        />
        <Stat
          label="Expected Payments"
          value={formatMoney(totalOut)}
          tone="danger"
          icon={DollarSign}
        />
        <Stat
          label="Projected Closing"
          value={formatMoney(finalRunning)}
          tone={finalRunning >= 0 ? 'success' : 'danger'}
          icon={TrendingUp}
        />
      </div>

      {loading ? (
        <SkeletonTable rows={6} cols={6} />
      ) : error ? (
        <div
          role="alert"
          className="badge badge-danger"
          style={{ display: 'block', padding: '0.75rem', textTransform: 'none' }}
        >
          {formatLoadError('cash flow forecast', error)}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState>Nothing committed yet. Issue invoices and bills (with due dates) to populate the forecast.</EmptyState>
      ) : (
        <>
          <div className="cashflow-table-view table-premium-container">
            <table className="table-premium">
              <thead>
                <tr>
                  <th>Week Starting</th>
                  <th style={{ textAlign: 'right' }}>Inflow (Invoices)</th>
                  <th style={{ textAlign: 'right' }}>Outflow (Bills)</th>
                  <th style={{ textAlign: 'right' }}>Net</th>
                  <th style={{ textAlign: 'right' }}>Projected Running</th>
                  <th>Distribution (In vs Out)</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const inWidth = (r.inflow / max) * 100;
                  const outWidth = (r.outflow / max) * 100;
                  const rRunning = (r as AggRow & { running: number }).running;
                  return (
                    <tr key={r.week_start}>
                      <td style={{ fontWeight: 600 }}>{r.week_start}</td>
                      <td style={{ textAlign: 'right', color: 'var(--text-success)' }}>
                        {r.inflow > 0 ? formatMoney(r.inflow) : '—'}
                      </td>
                      <td style={{ textAlign: 'right', color: 'var(--text-danger)' }}>
                        {r.outflow > 0 ? formatMoney(-r.outflow) : '—'}
                      </td>
                      <td
                        style={{
                          textAlign: 'right',
                          fontWeight: 700,
                          color: r.net >= 0 ? 'var(--text-success)' : 'var(--text-danger)',
                        }}
                      >
                        {formatMoney(r.net)}
                      </td>
                      <td
                        style={{
                          textAlign: 'right',
                          fontWeight: 600,
                          color: rRunning >= 0 ? 'var(--text-title)' : 'var(--text-danger)',
                        }}
                      >
                        {formatMoney(rRunning)}
                      </td>
                      <td>
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            height: '14px',
                            background: 'var(--bg-hover)',
                            borderRadius: 'var(--radius-full)',
                            overflow: 'hidden',
                            padding: '2px',
                            width: '120px',
                          }}
                        >
                          {r.inflow > 0 && (
                            <div
                              style={{
                                width: `${Math.max(inWidth, 5)}%`,
                                height: '100%',
                                background: 'var(--accent-success)',
                                borderRadius:
                                  r.outflow > 0
                                    ? 'var(--radius-full) 0 0 var(--radius-full)'
                                    : 'var(--radius-full)',
                              }}
                            />
                          )}
                          {r.outflow > 0 && (
                            <div
                              style={{
                                width: `${Math.max(outWidth, 5)}%`,
                                height: '100%',
                                background: 'var(--accent-danger)',
                                borderRadius:
                                  r.inflow > 0
                                    ? '0 var(--radius-full) var(--radius-full) 0'
                                    : 'var(--radius-full)',
                              }}
                            />
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="cashflow-card-view" aria-label="Cash flow week cards">
            {rows.map((r) => {
              const rRunning = (r as AggRow & { running: number }).running;
              return (
                <article
                  key={`card-${r.week_start}`}
                  className="cashflow-mobile-card card"
                  aria-label={`Cash flow week ${r.week_start}`}
                >
                  <div className="cashflow-mobile-card__header">
                    <strong style={{ color: 'var(--text-title)' }}>Week {r.week_start}</strong>
                    <strong
                      style={{ color: r.net >= 0 ? 'var(--text-success)' : 'var(--text-danger)' }}
                    >
                      {formatMoney(r.net)}
                    </strong>
                  </div>
                  <div className="cashflow-mobile-card__metrics">
                    <div>
                      <span>Inflow</span>
                      <strong style={{ color: 'var(--text-success)' }}>
                        {r.inflow > 0 ? formatMoney(r.inflow) : '—'}
                      </strong>
                    </div>
                    <div>
                      <span>Outflow</span>
                      <strong style={{ color: 'var(--text-danger)' }}>
                        {r.outflow > 0 ? formatMoney(-r.outflow) : '—'}
                      </strong>
                    </div>
                    <div>
                      <span>Projected running</span>
                      <strong
                        style={{
                          color: rRunning >= 0 ? 'var(--text-title)' : 'var(--text-danger)',
                        }}
                      >
                        {formatMoney(rRunning)}
                      </strong>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </>
      )}

      {/* Info Disclaimer */}
      <div
        className="card"
        style={{
          marginTop: '2.5rem',
          background: 'var(--bg-hover)',
          border: '1px dashed var(--border-subtle)',
          padding: '1.25rem',
          display: 'flex',
          gap: '0.75rem',
          alignItems: 'flex-start',
        }}
      >
        <Info
          size={16}
          style={{ flexShrink: 0, color: 'var(--text-link)', marginTop: '2px' }}
        />
        <div style={{ fontSize: '0.825rem', color: 'var(--text-muted)', lineHeight: '1.5' }}>
          <span
            style={{
              fontWeight: 600,
              color: 'var(--text-title)',
              display: 'block',
              marginBottom: '0.25rem',
            }}
          >
            Cash Flow Details
          </span>
          Future forecasts will factor in historical payment behavior profiles (e.g. average days
          late per customer) and allow hypothetical what-if scenario planning.
        </div>
      </div>
    </section>
  );
}
