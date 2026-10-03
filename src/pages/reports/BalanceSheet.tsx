import { useEffect, useState, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';
import { formatMoney } from '@/lib/money';
import { downloadCsv } from '@/lib/csv';
import { formatDateAu, orgTimeZone, todayLocal } from '@/lib/localDates';
import { SkeletonTable } from '@/components/Skeleton';
import {
  ChevronLeft,
  Download,
  DollarSign,
  Wallet,
  TrendingUp,
  Info,
  type LucideIcon,
} from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { EmptyState } from '@/components/ui/EmptyState';

interface BalanceSheetRow {
  organization_id: string;
  as_of_date: string;
  category: 'asset' | 'liability' | 'equity';
  line_item: string;
  amount_cents: number;
}

export function BalanceSheetPage() {
  const { currentOrg } = useOrg();
  const [rows, setRows] = useState<BalanceSheetRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // v_balance_sheet reflects the live ledger, so the report is always "as at today".
  const asOfDate = todayLocal(orgTimeZone(currentOrg));

  const refresh = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);
    setError(null);
    const { data, error: e } = await supabase
      .from('v_balance_sheet')
      .select('*')
      .eq('organization_id', currentOrg.id);
    if (e) setError(e.message);
    setRows((data ?? []) as BalanceSheetRow[]);
    setLoading(false);
  }, [currentOrg]);

  useEffect(() => void refresh(), [refresh]);

  const { assets, liabilities, equity, totalAssets, totalLiabilities, netEquity } = useMemo(() => {
    const assets = rows.filter((r) => r.category === 'asset');
    const liabilities = rows.filter((r) => r.category === 'liability');
    const equity = rows.filter((r) => r.category === 'equity');
    const totalAssets = assets.reduce((acc, r) => acc + Number(r.amount_cents ?? 0), 0);
    const totalLiabilities = liabilities.reduce((acc, r) => acc + Number(r.amount_cents ?? 0), 0);
    const netEquity = totalAssets - totalLiabilities;
    return { assets, liabilities, equity, totalAssets, totalLiabilities, netEquity };
  }, [rows]);

  const handleExport = () => {
    if (rows.length === 0) return;
    const filename = `balance-sheet-${asOfDate}.csv`;
    const exportRows = rows.map((r) => ({
      'As of': r.as_of_date,
      Category: r.category,
      'Line item': r.line_item,
      'Amount (AUD)': (Number(r.amount_cents) / 100).toFixed(2),
    }));
    exportRows.push({
      'As of': asOfDate,
      Category: 'asset',
      'Line item': 'TOTAL ASSETS',
      'Amount (AUD)': (totalAssets / 100).toFixed(2),
    });
    exportRows.push({
      'As of': asOfDate,
      Category: 'liability',
      'Line item': 'TOTAL LIABILITIES',
      'Amount (AUD)': (totalLiabilities / 100).toFixed(2),
    });
    exportRows.push({
      'As of': asOfDate,
      Category: 'equity',
      'Line item': 'NET EQUITY',
      'Amount (AUD)': (netEquity / 100).toFixed(2),
    });
    downloadCsv(filename, exportRows);
  };

  if (!currentOrg) return null;

  return (
    <section className="animated-fade-in">
      {/* Back & Export Bar */}
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
            aria-label="Export balance sheet as CSV"
          >
            <Download size={14} />
            <span>Export CSV</span>
          </button>
        )}
      </div>

      <PageHeader title="Balance Sheet" />
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
        Snapshot of what the business owns vs owes. Unsettled GST is based on processed
        invoices/bills, not a traditional general-ledger journal. Personal-flagged items are
        excluded.
      </p>

      {/* Date filter block */}
      <div
        style={{
          display: 'flex',
          gap: '0.75rem',
          alignItems: 'center',
          marginBottom: '1.5rem',
          flexWrap: 'wrap',
        }}
      >
        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
          As at{' '}
          {formatDateAu(asOfDate)}{' '}
          — live position from your current ledger
        </span>
      </div>

      {/* Net Worth Summary Panel */}
      <div
        className="card-gradient"
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '1.5rem',
          flexWrap: 'wrap',
          marginBottom: '2rem',
        }}
      >
        <div>
          <div
            style={{
              fontSize: '0.675rem',
              color: 'var(--text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              fontWeight: 700,
            }}
          >
            Net Worth (Assets &minus; Liabilities)
          </div>
          <div
            style={{
              marginTop: '0.35rem',
              fontSize: '2rem',
              fontWeight: 800,
              fontFamily: 'var(--font-title)',
              color: netEquity >= 0 ? 'var(--text-success)' : 'var(--text-danger)',
            }}
          >
            {formatMoney(netEquity)}
          </div>
        </div>

        <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
          <MiniCard
            label="Total Assets"
            value={formatMoney(totalAssets)}
            type="success"
            icon={Wallet}
          />
          <MiniCard
            label="Total Liabilities"
            value={formatMoney(totalLiabilities)}
            type="danger"
            icon={DollarSign}
          />
        </div>
      </div>

      {loading ? (
        <SkeletonTable rows={4} cols={3} />
      ) : error ? (
        <div
          className="badge badge-danger"
          style={{ display: 'block', padding: '1rem', textTransform: 'none' }}
        >
          {error}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState>No balance sheet data yet. Add bank accounts, bills, invoices, and debts.</EmptyState>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
            gap: '1.5rem',
            alignItems: 'start',
          }}
        >
          <Column
            title="Assets"
            type="success"
            rows={assets}
            totalCents={totalAssets}
            icon={Wallet}
          />
          <Column
            title="Liabilities"
            type="danger"
            rows={liabilities}
            totalCents={totalLiabilities}
            icon={DollarSign}
          />
          <Column
            title="Equity"
            type={netEquity >= 0 ? 'success' : 'danger'}
            rows={
              equity.length > 0
                ? equity
                : [
                    {
                      organization_id: currentOrg.id,
                      as_of_date: asOfDate,
                      category: 'equity' as const,
                      line_item: 'Net Equity (Assets − Liabilities)',
                      amount_cents: netEquity,
                    },
                  ]
            }
            totalCents={netEquity}
            icon={TrendingUp}
          />
        </div>
      )}

      {/* ATO Disclaimer / Note */}
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
            Balance Sheet Details
          </span>
          Future versions will support a complete double-entry general ledger, historical snapshot
          comparisons, asset depreciation schedules, and automated retained-earnings splits.
        </div>
      </div>
    </section>
  );
}

function Column({
  title,
  type,
  rows,
  totalCents,
  icon: Icon,
}: {
  title: string;
  type: 'success' | 'danger';
  rows: BalanceSheetRow[];
  totalCents: number;
  icon: LucideIcon;
}) {
  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', minHeight: '300px' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          borderBottom: '1px solid var(--border-subtle)',
          paddingBottom: '0.75rem',
          marginBottom: '0.75rem',
        }}
      >
        <h2
          style={{
            fontSize: '1.05rem',
            margin: 0,
            color: `var(--text-${type})`,
            display: 'flex',
            alignItems: 'center',
            gap: '0.35rem',
          }}
        >
          {title}
        </h2>
        <div style={{ color: `var(--accent-${type})` }}>
          <Icon size={16} />
        </div>
      </div>

      <ul style={{ listStyle: 'none', padding: 0, margin: 0, flex: 1 }}>
        {rows.length === 0 ? (
          <li style={{ fontSize: '0.875rem', color: 'var(--text-muted)', padding: '0.5rem 0' }}>
            —
          </li>
        ) : (
          rows.map((r, i) => (
            <li
              key={`${r.line_item}-${i}`}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: '0.5rem',
                fontSize: '0.875rem',
                padding: '0.5rem 0',
                borderBottom: '1px dotted var(--border-subtle)',
              }}
            >
              <span style={{ color: 'var(--text-body)' }}>{r.line_item}</span>
              <span
                style={{
                  color: 'var(--text-title)',
                  fontWeight: 600,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {formatMoney(Number(r.amount_cents))}
              </span>
            </li>
          ))
        )}
      </ul>

      <div
        style={{
          marginTop: '1rem',
          paddingTop: '0.75rem',
          borderTop: '2px solid var(--border-subtle)',
          display: 'flex',
          justifyContent: 'space-between',
          fontWeight: 700,
          fontSize: '0.95rem',
        }}
      >
        <span style={{ color: 'var(--text-title)' }}>Total {title}</span>
        <span style={{ color: `var(--text-${type})`, fontVariantNumeric: 'tabular-nums' }}>
          {formatMoney(totalCents)}
        </span>
      </div>
    </div>
  );
}

function MiniCard({
  label,
  value,
  type,
  icon: Icon,
}: {
  label: string;
  value: string;
  type: 'success' | 'danger';
  icon: LucideIcon;
}) {
  return (
    <div
      className="card"
      style={{
        padding: '0.75rem 1rem',
        display: 'flex',
        alignItems: 'center',
        gap: '0.75rem',
        minWidth: '150px',
        background: 'var(--bg-app)',
        borderColor: 'var(--border-subtle)',
      }}
    >
      <div style={{ color: `var(--accent-${type})` }}>
        <Icon size={18} />
      </div>
      <div>
        <div
          style={{
            fontSize: '0.625rem',
            color: 'var(--text-muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}
        >
          {label}
        </div>
        <div
          style={{
            fontSize: '1rem',
            fontWeight: 700,
            color: 'var(--text-title)',
            marginTop: '0.15rem',
          }}
        >
          {value}
        </div>
      </div>
    </div>
  );
}
