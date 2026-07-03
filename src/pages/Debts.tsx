import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';
import { formatMoney, formatMoneyCompact } from '@/lib/money';
import { formatLoadError, formatActionError } from '@/lib/errorMessages';
import { SkeletonTable } from '@/components/Skeleton';
import { InsightAreaChart, InsightBarList, InsightPanel } from '@/components/InsightCharts';
import { AnimatedNumber } from '@/components/AnimatedNumber';
import {
  Plus,
  CreditCard,
  Landmark,
  Receipt,
  HelpCircle,
  Briefcase,
  User,
  Calendar,
  Info,
  ChevronRight,
  TrendingDown,
  X,
} from 'lucide-react';

interface Debt {
  id: string;
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
}

interface Payment {
  id: string;
  debt_id: string;
  paid_at: string;
  total_cents: number;
  principal_cents: number | null;
  interest_cents: number | null;
  fees_cents: number | null;
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

function getDebtIcon(kind: string) {
  switch (kind) {
    case 'credit_card':
      return (
        <CreditCard className="w-4 h-4 text-accent-info" style={{ color: 'var(--accent-info)' }} />
      );
    case 'personal_loan':
    case 'business_loan':
      return (
        <Landmark
          className="w-4 h-4 text-accent-primary"
          style={{ color: 'var(--accent-primary)' }}
        />
      );
    case 'mortgage':
      return (
        <Landmark
          className="w-4 h-4 text-accent-success"
          style={{ color: 'var(--accent-success)' }}
        />
      );
    case 'overdraft':
    case 'tax_debt':
      return (
        <Receipt className="w-4 h-4 text-accent-danger" style={{ color: 'var(--accent-danger)' }} />
      );
    default:
      return <HelpCircle className="w-4 h-4 text-muted" style={{ color: 'var(--text-muted)' }} />;
  }
}

export function DebtsPage() {
  const { currentOrg } = useOrg();
  const navigate = useNavigate();
  const [debts, setDebts] = useState<Debt[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);
    setLoadError(null);
    const [debtsRes, paysRes] = await Promise.all([
      supabase
        .from('debts')
        .select('*')
        .eq('organization_id', currentOrg.id)
        .is('deleted_at', null)
        .order('current_balance_cents', { ascending: false }),
      supabase
        .from('debt_payments')
        .select('*')
        .eq('organization_id', currentOrg.id)
        .order('paid_at', { ascending: false })
        .limit(20),
    ]);
    const loadErr = debtsRes.error ?? paysRes.error;
    if (loadErr) {
      // A failed load must not masquerade as "no debts tracked yet".
      setLoadError(formatLoadError('debts', loadErr.message));
      setDebts([]);
      setPayments([]);
      setLoading(false);
      return;
    }
    setDebts((debtsRes.data ?? []) as Debt[]);
    setPayments((paysRes.data ?? []) as Payment[]);
    setLoading(false);
  }, [currentOrg]);

  useEffect(() => void refresh(), [refresh]);

  if (!currentOrg) return null;

  const businessDebt = debts
    .filter((d) => !d.is_personal)
    .reduce((a, d) => a + d.current_balance_cents, 0);
  const personalDebt = debts
    .filter((d) => d.is_personal)
    .reduce((a, d) => a + d.current_balance_cents, 0);
  const totalMinPayments = debts.reduce((a, d) => a + (d.minimum_payment_cents ?? 0), 0);

  // Debt Mix (all active debts)
  const debtMixItems = debts
    .map((d) => ({
      label: `${d.name} (${d.interest_rate_pct != null ? `${Number(d.interest_rate_pct).toFixed(1)}%` : 'no APR'})`,
      value: d.current_balance_cents,
      displayValue: formatMoneyCompact(d.current_balance_cents),
      tone: d.is_personal ? ('warning' as const) : ('danger' as const),
    }))
    .sort((a, b) => b.value - a.value);

  // Repayment trends (chronological payments)
  let runningPaidCents = 0;
  let runningPrincipalCents = 0;
  let runningInterestCents = 0;

  const paymentsChronological = payments.slice().sort((a, b) => a.paid_at.localeCompare(b.paid_at));

  const totalPaymentsTrend = paymentsChronological.length
    ? paymentsChronological.map((p) => {
        runningPaidCents += p.total_cents;
        return {
          label: new Date(p.paid_at).toLocaleDateString('en-AU', {
            day: '2-digit',
            month: 'short',
          }),
          value: runningPaidCents,
        };
      })
    : [{ label: 'No payments', value: 0 }];

  const principalTrend = paymentsChronological.map((p) => {
    runningPrincipalCents += p.principal_cents ?? 0;
    return {
      label: new Date(p.paid_at).toLocaleDateString('en-AU', { day: '2-digit', month: 'short' }),
      value: runningPrincipalCents,
    };
  });

  const interestTrend = paymentsChronological.map((p) => {
    runningInterestCents += p.interest_cents ?? 0;
    return {
      label: new Date(p.paid_at).toLocaleDateString('en-AU', { day: '2-digit', month: 'short' }),
      value: runningInterestCents,
    };
  });

  return (
    <section
      className="animated-fade-in"
      style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}
    >
      <div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '1rem',
            marginBottom: '0.5rem',
          }}
        >
          <h1 style={{ margin: 0 }}>Debts Tracker</h1>
          <button className="btn btn-primary" onClick={() => setShowAdd(true)}>
            <Plus className="w-4 h-4" /> Add Debt
          </button>
        </div>
        <p
          style={{ color: 'var(--text-muted)', fontSize: '0.925rem', maxWidth: '600px', margin: 0 }}
        >
          Loans, credit cards, overdrafts. Tracks balance, interest rate, and monthly minimum so you
          know what's eating cash.
        </p>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
          gap: '1rem',
        }}
      >
        <KpiCard
          label="Business Debt"
          value={businessDebt}
          formatter={formatMoney}
          icon={<Briefcase className="w-5 h-5" style={{ color: 'var(--accent-danger)' }} />}
          accentColor="var(--accent-danger)"
        />
        <KpiCard
          label="Personal Debt"
          value={personalDebt}
          formatter={formatMoney}
          icon={<User className="w-5 h-5" style={{ color: 'var(--accent-warning)' }} />}
          accentColor="var(--accent-warning)"
        />
        <KpiCard
          label="Min Monthly Payments"
          value={totalMinPayments}
          formatter={formatMoney}
          icon={<Calendar className="w-5 h-5" style={{ color: 'var(--accent-primary)' }} />}
          accentColor="var(--accent-primary)"
          sub="all debts combined"
        />
      </div>

      {/* Charts Section */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          gap: '1rem',
          marginBottom: '0.5rem',
        }}
      >
        <InsightPanel title="Repayment velocity" eyebrow="Cumulative paydown trend">
          <InsightAreaChart
            title="Total paid"
            items={totalPaymentsTrend}
            tone="success"
            series={[
              { label: 'Principal', items: principalTrend, tone: 'success' },
              { label: 'Interest & Fees', items: interestTrend, tone: 'danger' },
            ]}
            markerLabel="Paid YTD"
            formatValue={formatMoneyCompact}
          />
        </InsightPanel>
        <InsightPanel title="Debt allocation" eyebrow="Portfolio balance mix">
          {debtMixItems.length === 0 ? (
            <div style={{ color: 'var(--text-muted)', fontSize: '0.875rem', padding: '1rem 0' }}>
              No debt allocations to display.
            </div>
          ) : (
            <InsightBarList items={debtMixItems} formatValue={formatMoneyCompact} />
          )}
        </InsightPanel>
      </div>

      {showAdd && (
        <div className="card-gradient" style={{ animation: 'fadeIn 0.2s ease-out' }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '1.25rem',
            }}
          >
            <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <TrendingDown
                className="w-5 h-5 text-accent-primary"
                style={{ color: 'var(--accent-primary)' }}
              />
              Add New Debt Account
            </h3>
            <button
              className="btn btn-ghost"
              onClick={() => setShowAdd(false)}
              style={{ padding: '0.25rem' }}
            >
              <X className="w-5 h-5" />
            </button>
          </div>
          <AddDebtForm
            onClose={() => setShowAdd(false)}
            onAdded={() => {
              setShowAdd(false);
              void refresh();
            }}
          />
        </div>
      )}

      <div>
        <h2 style={{ fontSize: '1.25rem', marginBottom: '1rem' }}>Active Debt Accounts</h2>
        {loading ? (
          <SkeletonTable rows={4} cols={7} />
        ) : loadError ? (
          <div
            role="alert"
            className="badge badge-danger"
            style={{ display: 'block', padding: '0.75rem', textTransform: 'none' }}
          >
            {loadError}
          </div>
        ) : debts.length === 0 ? (
          <div
            className="card"
            style={{ textAlign: 'center', padding: '2.5rem', color: 'var(--text-muted)' }}
          >
            <Landmark
              className="w-12 h-12 text-muted"
              style={{ margin: '0 auto 1rem', opacity: 0.4 }}
            />
            <p style={{ margin: 0, fontSize: '0.925rem' }}>
              No debts tracked yet. Add one to start watching the cash bleed.
            </p>
          </div>
        ) : (
          <>
            <div className="debts-table-view table-premium-container">
              <table className="table-premium">
                <thead>
                  <tr>
                    <th>Account Name</th>
                    <th>Kind</th>
                    <th>Lender</th>
                    <th style={{ textAlign: 'right' }}>Balance</th>
                    <th style={{ textAlign: 'right' }}>Interest %</th>
                    <th style={{ textAlign: 'right' }}>Min Payment</th>
                    <th>Type</th>
                    <th style={{ width: '40px' }}></th>
                  </tr>
                </thead>
                <tbody>
                  {debts.map((d) => (
                    <tr
                      key={d.id}
                      style={{ cursor: 'pointer' }}
                      onClick={() => navigate(`/debts/${d.id}`)}
                    >
                      <td>
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.75rem',
                            fontWeight: 600,
                            color: 'var(--text-title)',
                          }}
                        >
                          {getDebtIcon(d.kind)}
                          {d.name}
                        </div>
                      </td>
                      <td style={{ textTransform: 'capitalize' }}>{d.kind.replace(/_/g, ' ')}</td>
                      <td>
                        {d.lender_name ?? '—'}
                        {d.account_number_last4 && (
                          <span
                            style={{
                              color: 'var(--text-muted)',
                              fontSize: '0.8rem',
                              marginLeft: '0.25rem',
                            }}
                          >
                            •••• {d.account_number_last4}
                          </span>
                        )}
                      </td>
                      <td
                        style={{ textAlign: 'right', fontWeight: 600, color: 'var(--text-title)' }}
                      >
                        {formatMoney(d.current_balance_cents)}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {d.interest_rate_pct != null
                          ? `${Number(d.interest_rate_pct).toFixed(2)}%`
                          : '—'}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {d.minimum_payment_cents != null
                          ? formatMoney(d.minimum_payment_cents)
                          : '—'}
                      </td>
                      <td>
                        {d.is_personal ? (
                          <span className="badge badge-warning">Personal</span>
                        ) : (
                          <span className="badge badge-success">Business</span>
                        )}
                      </td>
                      <td>
                        <ChevronRight className="w-4 h-4 text-muted" style={{ opacity: 0.5 }} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="debts-card-view" aria-label="Debt account cards">
              {debts.map((d) => (
                <article
                  key={`card-${d.id}`}
                  className="debt-mobile-card card"
                  aria-label={`Debt ${d.name}`}
                >
                  <div className="debt-mobile-card__header">
                    <div>
                      <a
                        href={`/debts/${d.id}`}
                        onClick={(e) => {
                          e.preventDefault();
                          navigate(`/debts/${d.id}`);
                        }}
                        style={{
                          fontWeight: 700,
                          color: 'var(--accent-primary)',
                          textDecoration: 'none',
                        }}
                      >
                        {d.name}
                      </a>
                      <div
                        style={{
                          color: 'var(--text-muted)',
                          fontSize: '0.75rem',
                          marginTop: '0.15rem',
                          textTransform: 'capitalize',
                        }}
                      >
                        {d.kind.replace(/_/g, ' ')} · {d.lender_name ?? 'No lender'}
                        {d.account_number_last4 ? ` ·••• ${d.account_number_last4}` : ''}
                      </div>
                    </div>
                    {d.is_personal ? (
                      <span className="badge badge-warning">Personal</span>
                    ) : (
                      <span className="badge badge-success">Business</span>
                    )}
                  </div>
                  <div className="debt-mobile-card__metrics">
                    <div>
                      <span>Balance</span>
                      <strong>{formatMoney(d.current_balance_cents)}</strong>
                    </div>
                    <div>
                      <span>Interest</span>
                      <strong>
                        {d.interest_rate_pct != null
                          ? `${Number(d.interest_rate_pct).toFixed(2)}%`
                          : '—'}
                      </strong>
                    </div>
                    <div>
                      <span>Min payment</span>
                      <strong>
                        {d.minimum_payment_cents != null
                          ? formatMoney(d.minimum_payment_cents)
                          : '—'}
                      </strong>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </>
        )}
      </div>

      <div>
        <h2 style={{ fontSize: '1.25rem', marginBottom: '1rem' }}>Recent Payments</h2>
        {payments.length === 0 ? (
          <div
            className="card"
            style={{ padding: '1.5rem', color: 'var(--text-muted)', fontSize: '0.875rem' }}
          >
            No payments recorded yet.
          </div>
        ) : (
          <div className="table-premium-container">
            <table className="table-premium">
              <thead>
                <tr>
                  <th>Payment Date</th>
                  <th>Debt Account</th>
                  <th style={{ textAlign: 'right' }}>Total Paid</th>
                  <th style={{ textAlign: 'right' }}>Principal</th>
                  <th style={{ textAlign: 'right' }}>Interest</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => {
                  const debt = debts.find((d) => d.id === p.debt_id);
                  return (
                    <tr key={p.id}>
                      <td>{p.paid_at.slice(0, 10)}</td>
                      <td style={{ fontWeight: 500, color: 'var(--text-title)' }}>
                        {debt?.name ?? '—'}
                      </td>
                      <td
                        style={{ textAlign: 'right', fontWeight: 600, color: 'var(--text-title)' }}
                      >
                        {formatMoney(p.total_cents)}
                      </td>
                      <td style={{ textAlign: 'right', color: 'var(--text-success)' }}>
                        {p.principal_cents != null ? formatMoney(p.principal_cents) : '—'}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {p.interest_cents != null ? formatMoney(p.interest_cents) : '—'}
                      </td>
                    </tr>
                  );
                })}
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
          style={{ flexShrink: 0, marginTop: '0.1rem', color: 'var(--accent-primary)' }}
        />
        <div>
          <strong style={{ color: 'var(--text-title)', display: 'block', marginBottom: '0.25rem' }}>
            Future Features:
          </strong>
          Amortisation schedule tables, "snowball vs avalanche" payoff planner/strategy simulator,
          transaction auto-matching, and SMS/Email payment alerts before due dates.
        </div>
      </div>
    </section>
  );
}

function AddDebtForm({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const { currentOrg } = useOrg();
  const [name, setName] = useState('');
  const [kind, setKind] = useState('credit_card');
  const [lender, setLender] = useState('');
  const [balance, setBalance] = useState(0);
  const [interestPct, setInterestPct] = useState(20);
  const [minPayment, setMinPayment] = useState(0);
  const [isPersonal, setIsPersonal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!currentOrg) return;
    setBusy(true);
    const { error } = await supabase.from('debts').insert({
      organization_id: currentOrg.id,
      name: name.trim(),
      kind,
      lender_name: lender.trim() || null,
      original_balance_cents: Math.round(balance * 100),
      current_balance_cents: Math.round(balance * 100),
      interest_rate_pct: interestPct,
      minimum_payment_cents: Math.round(minPayment * 100),
      is_personal: isPersonal,
    });
    setBusy(false);
    if (error) {
      setErr(formatActionError('add the debt', error.message));
      return;
    }
    onAdded();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: '1rem',
        }}
      >
        <div className="form-group">
          <label className="form-label">Account Name</label>
          <input
            className="form-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. CommBank Visa"
          />
        </div>
        <div className="form-group">
          <label className="form-label">Debt Type</label>
          <select className="form-select" value={kind} onChange={(e) => setKind(e.target.value)}>
            {DEBT_KINDS.map((k) => (
              <option key={k} value={k}>
                {k.replace(/_/g, ' ')}
              </option>
            ))}
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
          <label className="form-label">Lender Name</label>
          <input
            className="form-input"
            value={lender}
            onChange={(e) => setLender(e.target.value)}
            placeholder="e.g. Commonwealth Bank"
          />
        </div>
        <div className="form-group">
          <label className="form-label">Liability Classification</label>
          <select
            className="form-select"
            value={isPersonal ? 'true' : 'false'}
            onChange={(e) => setIsPersonal(e.target.value === 'true')}
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
            value={balance || ''}
            onChange={(e) => setBalance(parseFloat(e.target.value) || 0)}
            placeholder="0.00"
          />
        </div>
        <div className="form-group">
          <label className="form-label">Interest Rate (APR %)</label>
          <input
            className="form-input"
            type="number"
            step="0.01"
            value={interestPct || ''}
            onChange={(e) => setInterestPct(parseFloat(e.target.value) || 0)}
            placeholder="0.00"
          />
        </div>
      </div>

      <div className="form-group">
        <label className="form-label">Minimum Monthly Payment ($)</label>
        <input
          className="form-input"
          type="number"
          step="0.01"
          value={minPayment || ''}
          onChange={(e) => setMinPayment(parseFloat(e.target.value) || 0)}
          placeholder="0.00"
        />
      </div>

      <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.5rem' }}>
        <button
          className="btn btn-primary"
          onClick={submit}
          disabled={busy || !name.trim() || balance <= 0}
        >
          {busy ? 'Adding Account…' : 'Add Debt Account'}
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
  );
}

function KpiCard({
  label,
  value,
  icon,
  accentColor,
  sub,
  formatter,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  accentColor: string;
  sub?: string;
  formatter?: (val: number) => string;
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
          <AnimatedNumber value={value} formatter={formatter} />
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
