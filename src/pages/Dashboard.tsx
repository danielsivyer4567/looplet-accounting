import { useState } from 'react';
import { useOrg } from '@/hooks/useOrg';
import { useRealtimePnl } from '@/hooks/useRealtimePnl';
import { SkeletonCard } from '@/components/Skeleton';
import { InsightAreaChart, InsightBarList, InsightPanel } from '@/components/InsightCharts';
import { formatMoneyCompact } from '@/lib/money';
import { AnimatedNumber } from '@/components/AnimatedNumber';
import {
  ChevronDown,
  Building2,
  FileText,
  Copy,
  Check,
  X,
  ChevronRight,
  Shuffle,
} from 'lucide-react';

interface MockTransaction {
  id: string;
  merchant: string;
  date: string;
  amount: number;
  type: 'incoming' | 'outgoing';
  status?: 'declined' | 'completed';
  initial: string;
  color: string;
  iconUrl?: string;
}

const mockTransactions: MockTransaction[] = [
  {
    id: '1',
    merchant: 'Uber Eats',
    date: 'Jun 20, 9:41 PM',
    amount: -42.78,
    type: 'outgoing',
    initial: 'U',
    color: '#10b981',
    iconUrl: '/images/merchants/ubereats.png',
  },
  {
    id: '2',
    merchant: 'Nandos Coomera Bp',
    date: 'Jun 20, 10:51 AM',
    amount: -40.75,
    type: 'outgoing',
    initial: 'N',
    color: '#f97316',
    iconUrl: '/images/merchants/nandos.png',
  },
  {
    id: '3',
    merchant: 'Nandos Coomera Bp',
    date: 'Declined • Jun 20, 10:50 AM',
    amount: -40.75,
    type: 'outgoing',
    status: 'declined',
    initial: 'N',
    color: '#f97316',
    iconUrl: '/images/merchants/nandos.png',
  },
  {
    id: '4',
    merchant: 'Uber',
    date: 'Declined • Jun 19, 11:00 PM',
    amount: -9.99,
    type: 'outgoing',
    status: 'declined',
    initial: 'U',
    color: '#000000',
    iconUrl: '/images/merchants/uber.png',
  },
  {
    id: '5',
    merchant: 'Uber',
    date: 'Declined • Jun 19, 11:00 PM',
    amount: -9.99,
    type: 'outgoing',
    status: 'declined',
    initial: 'U',
    color: '#000000',
    iconUrl: '/images/merchants/uber.png',
  },
  {
    id: '6',
    merchant: 'Erdene B',
    date: 'Jun 19, 6:51 PM • Inv29',
    amount: -1038.0,
    type: 'outgoing',
    initial: 'E',
    color: '#6366f1',
    iconUrl: '/images/merchants/erdene.png',
  },
  {
    id: '7',
    merchant: 'Money added via ••9815',
    date: 'Jun 19, 6:50 PM',
    amount: 1000.0,
    type: 'incoming',
    initial: 'M',
    color: '#eab308',
    iconUrl: '/images/merchants/topup.png',
  },
  {
    id: '8',
    merchant: "McDonald's",
    date: 'Jun 19, 4:00 PM',
    amount: -53.1,
    type: 'outgoing',
    initial: 'M',
    color: '#ef4444',
    iconUrl: '/images/merchants/mcdonalds.png',
  },
  {
    id: '9',
    merchant: 'Kfc',
    date: 'Jun 18, 8:08 PM',
    amount: -35.85,
    type: 'outgoing',
    initial: 'K',
    color: '#ef4444',
    iconUrl: '/images/merchants/kfc.png',
  },
  {
    id: '10',
    merchant: 'Money added via ••9815',
    date: 'Jun 18, 8:05 PM',
    amount: 250.0,
    type: 'incoming',
    initial: 'M',
    color: '#eab308',
    iconUrl: '/images/merchants/topup.png',
  },
  {
    id: '11',
    merchant: 'Paymonade',
    date: 'Jun 17, 7:26 PM',
    amount: -420.0,
    type: 'outgoing',
    initial: 'P',
    color: '#84cc16',
    iconUrl: '/images/merchants/paymonade.png',
  },
  {
    id: '12',
    merchant: 'Money added via ••9815',
    date: 'Jun 17, 7:25 PM',
    amount: 420.0,
    type: 'incoming',
    initial: 'M',
    color: '#eab308',
    iconUrl: '/images/merchants/topup.png',
  },
  {
    id: '13',
    merchant: "McDonald's",
    date: 'Jun 15, 9:42 PM',
    amount: -28.9,
    type: 'outgoing',
    initial: 'M',
    color: '#ef4444',
    iconUrl: '/images/merchants/mcdonalds.png',
  },
  {
    id: '14',
    merchant: 'Highland Reserve Conve',
    date: 'Jun 15, 7:34 AM',
    amount: -225.0,
    type: 'outgoing',
    initial: 'H',
    color: '#22c55e',
    iconUrl: '/images/merchants/highland.png',
  },
  {
    id: '15',
    merchant: 'Highland Reserve Conve',
    date: 'Jun 15, 7:33 AM',
    amount: -22.47,
    type: 'outgoing',
    initial: 'H',
    color: '#22c55e',
    iconUrl: '/images/merchants/highland.png',
  },
  {
    id: '16',
    merchant: 'Erdene B',
    date: 'Jun 12, 6:36 PM • Inv28',
    amount: -1038.0,
    type: 'outgoing',
    initial: 'E',
    color: '#6366f1',
    iconUrl: '/images/merchants/erdene.png',
  },
  {
    id: '17',
    merchant: 'Money added via ••9815',
    date: 'Jun 12, 6:34 PM',
    amount: 1200.0,
    type: 'incoming',
    initial: 'M',
    color: '#eab308',
    iconUrl: '/images/merchants/topup.png',
  },
];

export function DashboardPage() {
  const { currentOrg } = useOrg();
  const { pnl, loading, error } = useRealtimePnl();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'local' | 'international'>('local');
  const [copiedField, setCopiedField] = useState<string | null>(null);

  if (!currentOrg) {
    return (
      <section
        className="animated-fade-in"
        style={{
          padding: '2rem 1.5rem',
          textAlign: 'center',
          maxWidth: '600px',
          margin: '4rem auto',
        }}
      >
        <div
          style={{
            width: '64px',
            height: '64px',
            borderRadius: 'var(--radius-lg)',
            background: 'var(--bg-success-subtle)',
            color: 'var(--accent-success)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '32px',
            marginBottom: '1.5rem',
          }}
        >
          👋
        </div>
        <h1 style={{ marginBottom: '1rem' }}>Welcome to Looplet</h1>
        <p style={{ color: 'var(--text-muted)', lineHeight: '1.6', marginBottom: '2rem' }}>
          Create or select your first organisation in the header to get started. Each organisation
          is fully isolated — bills, jobs, employees, and Xero connection are yours alone.
        </p>
      </section>
    );
  }

  if (loading) {
    return (
      <section className="animated-fade-in">
        <div
          style={{
            height: '32px',
            width: '200px',
            backgroundColor: 'var(--border-subtle)',
            borderRadius: 'var(--radius-sm)',
            marginBottom: '1.5rem',
          }}
        />
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
            gap: '1.5rem',
            marginBottom: '2rem',
          }}
        >
          {Array.from({ length: 8 }).map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <p
        className="badge badge-danger"
        style={{ padding: '1rem', width: '100%', justifyContent: 'center' }}
      >
        Failed to load: {error}
      </p>
    );
  }

  const balanceCents = pnl?.really_yours_cents ?? 0;
  const transactionTotalCents = mockTransactions.reduce(
    (sum, tx) => sum + Math.round(tx.amount * 100),
    0,
  );
  let runningPulseCents = balanceCents - transactionTotalCents;
  const cashPulseItems = mockTransactions
    .slice()
    .reverse()
    .map((tx) => {
      runningPulseCents += Math.round(tx.amount * 100);
      return {
        label: tx.date.split('•')[0]?.trim() ?? tx.date,
        value: runningPulseCents,
      };
    });
  let runningSpendCents = 0;
  let runningIncomeCents = 0;
  const spendPulseItems = mockTransactions
    .slice()
    .reverse()
    .map((tx) => {
      if (tx.amount < 0) runningSpendCents += Math.abs(Math.round(tx.amount * 100));
      return { label: tx.date.split('•')[0]?.trim() ?? tx.date, value: runningSpendCents };
    });
  const incomePulseItems = mockTransactions
    .slice()
    .reverse()
    .map((tx) => {
      if (tx.amount > 0) runningIncomeCents += Math.round(tx.amount * 100);
      return { label: tx.date.split('•')[0]?.trim() ?? tx.date, value: runningIncomeCents };
    });
  const costMixItems = [
    {
      label: 'Bills',
      value: pnl?.cost_bills_cents ?? 0,
      tone: 'danger' as const,
      detail: 'Supplier and materials pressure',
    },
    {
      label: 'Wages',
      value: pnl?.cost_wages_cents ?? 0,
      tone: 'warning' as const,
      detail: 'Loaded labour cost captured so far',
    },
    {
      label: 'Overhead',
      value: pnl?.cost_overhead_cents ?? 0,
      tone: 'info' as const,
      detail: 'Shared fixed-cost allocation',
    },
    {
      label: 'Take-home signal',
      value: pnl?.really_yours_cents ?? 0,
      tone: 'success' as const,
      detail: 'After GST and tax set-aside',
    },
  ];

  const handleCopy = (text: string, fieldName: string) => {
    void navigator.clipboard.writeText(text);
    setCopiedField(fieldName);
    setTimeout(() => setCopiedField(null), 2000);
  };

  return (
    <section className="animated-fade-in" style={{ paddingBottom: '3rem' }}>
      {/* Revolut style Account Header */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          marginBottom: '2rem',
          flexWrap: 'wrap',
          gap: '1rem',
        }}
      >
        <div>
          {/* Balance Display */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              fontSize: '2.5rem',
              fontWeight: 800,
              color: 'var(--text-title)',
              letterSpacing: '-0.02em',
              fontFamily: 'var(--font-title)',
              cursor: 'pointer',
            }}
          >
            <span>
              AUD{' '}
              <AnimatedNumber
                value={balanceCents}
                formatter={(v) =>
                  (v / 100).toLocaleString('en-AU', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })
                }
              />
            </span>
            <ChevronDown size={28} style={{ color: 'var(--text-muted)' }} />
          </div>
          {/* Profile Currency Sub-label */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.35rem',
              marginTop: '0.25rem',
              fontSize: '0.8rem',
              color: 'var(--text-muted)',
            }}
          >
            <span>🇦🇺</span>
            <span>Personal • AUD</span>
          </div>
        </div>

        {/* Action Pill Buttons */}
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button className="revolut-pill-btn">
            <Shuffle size={14} />
            <span>Move</span>
          </button>
          <button className="revolut-pill-btn">
            <FileText size={14} />
            <span>Statement</span>
          </button>
          <button onClick={() => setDrawerOpen(true)} className="revolut-pill-btn">
            <Building2 size={14} />
            <span>Account details</span>
          </button>
        </div>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          gap: '1rem',
          marginBottom: '1.5rem',
        }}
      >
        <InsightPanel title="Cash pulse" eyebrow="Live ledger">
          <InsightAreaChart
            title="Transaction drift"
            items={cashPulseItems}
            tone="success"
            series={[
              { label: 'Spend', items: spendPulseItems, tone: 'danger' },
              { label: 'Income', items: incomePulseItems, tone: 'info' },
            ]}
            markerLabel="Now"
            formatValue={formatMoneyCompact}
          />
        </InsightPanel>
        <InsightPanel title="Cost pressure" eyebrow="Job margin lens">
          <InsightBarList items={costMixItems} formatValue={formatMoneyCompact} />
        </InsightPanel>
      </div>

      {/* Transactions Container */}
      <div
        className="card"
        style={{
          padding: '0.5rem 0',
          backgroundColor: 'var(--bg-card)',
          border: '1px solid var(--border-subtle)',
          boxShadow: 'var(--shadow-sm)',
        }}
      >
        {mockTransactions.map((tx, idx) => (
          <div
            key={tx.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              padding: '0.85rem 1.25rem',
              borderBottom:
                idx === mockTransactions.length - 1 ? 'none' : '1px solid var(--border-subtle)',
              gap: '1rem',
              transition: 'var(--transition-smooth)',
            }}
            className="transaction-row"
          >
            {/* Merchant Brand Icon or Initial Badge */}
            <div
              className="merchant-icon"
              style={{
                backgroundColor: tx.iconUrl ? 'transparent' : tx.color,
                overflow: 'hidden',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {tx.iconUrl ? (
                <img
                  src={tx.iconUrl}
                  alt={tx.merchant}
                  style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                />
              ) : (
                tx.initial
              )}
            </div>

            {/* Merchant Details */}
            <div style={{ flex: 1 }}>
              <div
                style={{
                  fontWeight: 600,
                  color: 'var(--text-title)',
                  fontSize: '0.875rem',
                }}
              >
                {tx.merchant}
              </div>
              <div
                style={{
                  fontSize: '0.75rem',
                  color: 'var(--text-muted)',
                  marginTop: '0.15rem',
                }}
              >
                {tx.date}
              </div>
            </div>

            {/* Transaction Amount */}
            <div
              style={{
                fontWeight: 700,
                fontSize: '0.875rem',
                color:
                  tx.status === 'declined'
                    ? 'var(--text-muted)'
                    : tx.type === 'incoming'
                      ? 'var(--text-success)'
                      : 'var(--text-title)',
                textDecoration: tx.status === 'declined' ? 'line-through' : 'none',
              }}
            >
              {tx.type === 'incoming' ? '+' : '-'}A$
              {Math.abs(tx.amount).toLocaleString('en-AU', { minimumFractionDigits: 2 })}
            </div>
          </div>
        ))}

        {/* See All link */}
        <div
          style={{
            padding: '1rem 0',
            textAlign: 'center',
            borderTop: '1px solid var(--border-subtle)',
          }}
        >
          <span
            style={{
              fontSize: '0.8rem',
              color: 'var(--accent-primary)',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            See all
          </span>
        </div>
      </div>

      <p
        style={{
          color: 'var(--text-muted)',
          fontSize: '0.75rem',
          marginTop: '2.5rem',
          display: 'flex',
          alignItems: 'center',
          gap: '0.35rem',
          justifyContent: 'center',
        }}
      >
        <span>⚡ PnL Real-time Estimate:</span>
        <code>really_yours = gross_profit - gst_set_aside - tax_set_aside</code>
      </p>

      {/* Account Details sliding Side Drawer */}
      {drawerOpen && (
        <>
          {/* Overlay */}
          <div onClick={() => setDrawerOpen(false)} className="drawer-overlay" />

          {/* Drawer Sheet */}
          <div className="drawer-sheet" style={{ padding: '1.5rem' }}>
            {/* Header */}
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'flex-start',
                marginBottom: '1.25rem',
              }}
            >
              <div>
                <h3 style={{ margin: 0, fontSize: '1.35rem', fontWeight: 800 }}>Account details</h3>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.35rem',
                    marginTop: '0.25rem',
                    fontSize: '0.8rem',
                    color: 'var(--text-muted)',
                  }}
                >
                  <span>🇦🇺</span>
                  <span>Australian dollar</span>
                </div>
              </div>
              <button
                onClick={() => setDrawerOpen(false)}
                style={{
                  background: 'var(--bg-hover)',
                  border: 'none',
                  borderRadius: '50%',
                  padding: '0.4rem',
                  cursor: 'pointer',
                  color: 'var(--text-title)',
                }}
              >
                <X size={16} />
              </button>
            </div>

            {/* Tab Selector Segmented Control */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                backgroundColor: 'var(--bg-app)',
                padding: '3px',
                borderRadius: '8px',
                marginBottom: '1.5rem',
              }}
            >
              <button
                onClick={() => setActiveTab('local')}
                style={{
                  padding: '0.5rem',
                  border: 'none',
                  borderRadius: '6px',
                  fontWeight: 600,
                  fontSize: '0.8rem',
                  cursor: 'pointer',
                  backgroundColor: activeTab === 'local' ? 'var(--bg-panel)' : 'transparent',
                  color: activeTab === 'local' ? 'var(--text-title)' : 'var(--text-muted)',
                  transition: 'var(--transition-smooth)',
                }}
              >
                Local
              </button>
              <button
                onClick={() => setActiveTab('international')}
                style={{
                  padding: '0.5rem',
                  border: 'none',
                  borderRadius: '6px',
                  fontWeight: 600,
                  fontSize: '0.8rem',
                  cursor: 'pointer',
                  backgroundColor:
                    activeTab === 'international' ? 'var(--bg-panel)' : 'transparent',
                  color: activeTab === 'international' ? 'var(--text-title)' : 'var(--text-muted)',
                  transition: 'var(--transition-smooth)',
                }}
              >
                International
              </button>
            </div>

            {activeTab === 'local' ? (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                <p
                  style={{
                    margin: '0 0 0.25rem 0',
                    fontSize: '0.75rem',
                    color: 'var(--text-muted)',
                    fontWeight: 600,
                  }}
                >
                  For domestic transfers only
                </p>

                {/* Beneficiary */}
                <DetailRow
                  label="Beneficiary"
                  value="Daniel Sivyer"
                  onCopy={() => handleCopy('Daniel Sivyer', 'beneficiary')}
                  isCopied={copiedField === 'beneficiary'}
                />

                {/* Account */}
                <DetailRow
                  label="Account"
                  value="100554161"
                  onCopy={() => handleCopy('100554161', 'account')}
                  isCopied={copiedField === 'account'}
                />

                {/* BSB Number */}
                <DetailRow
                  label="BSB Number"
                  value="772772"
                  onCopy={() => handleCopy('772772', 'bsb')}
                  isCopied={copiedField === 'bsb'}
                />

                {/* Bank Name & Address */}
                <DetailRow
                  label="Bank name and address"
                  value="Revolut Payments Australia Pty Ltd Level 28, 161 Castlereagh Street, 2000, Sydney, NSW, Australia"
                  onCopy={() =>
                    handleCopy(
                      'Revolut Payments Australia Pty Ltd Level 28, 161 Castlereagh Street, 2000, Sydney, NSW, Australia',
                      'bank',
                    )
                  }
                  isCopied={copiedField === 'bank'}
                />

                {/* Share Button */}
                <button
                  onClick={() =>
                    handleCopy(
                      'BSB: 772772, Account: 100554161, Beneficiary: Daniel Sivyer',
                      'share',
                    )
                  }
                  className="btn btn-primary"
                  style={{
                    width: '100%',
                    borderRadius: '9999px',
                    marginTop: '0.5rem',
                    fontWeight: 600,
                  }}
                >
                  {copiedField === 'share' ? 'Copied details!' : 'Share details'}
                </button>

                {/* Advisory lists */}
                <div
                  style={{
                    marginTop: '1.25rem',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '1rem',
                    borderTop: '1px solid var(--border-subtle)',
                    paddingTop: '1.25rem',
                  }}
                >
                  <AdvisoryItem
                    icon="🏦"
                    text="Your money is protected by bank guarantee. Learn more"
                    link="Learn more"
                  />
                  <AdvisoryItem
                    icon="⚡"
                    text="Transfers usually arrive in minutes. In some cases, it may take 1 business day"
                  />
                  <AdvisoryItem
                    icon="🇦🇺"
                    text="Only local transfers are accepted. For international transfers, please use the SWIFT details found above"
                  />
                  <AdvisoryItem
                    icon="💡"
                    text="Use these details to receive transfers from an Australian dollar bank account"
                  />
                  <AdvisoryItem
                    icon="🔄"
                    text="Give these details to merchants to set up Direct Debits or PayTo agreements and automatically pay off your recurring bills"
                  />
                </div>

                {/* Documents statement */}
                <div
                  style={{
                    marginTop: 'auto',
                    borderTop: '1px solid var(--border-subtle)',
                    paddingTop: '1rem',
                  }}
                >
                  <div
                    style={{
                      fontSize: '0.75rem',
                      color: 'var(--text-muted)',
                      fontWeight: 600,
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                      marginBottom: '0.5rem',
                    }}
                  >
                    Documents
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      backgroundColor: 'var(--bg-app)',
                      padding: '0.75rem 1rem',
                      borderRadius: '8px',
                      cursor: 'pointer',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.5rem',
                        fontSize: '0.8rem',
                        color: 'var(--text-title)',
                        fontWeight: 600,
                      }}
                    >
                      <span>📄</span>
                      <span>Account statement</span>
                    </div>
                    <ChevronRight size={14} style={{ color: 'var(--text-muted)' }} />
                  </div>
                </div>
              </div>
            ) : (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '1.25rem',
                  alignItems: 'center',
                  padding: '2rem 1rem',
                  textAlign: 'center',
                }}
              >
                <span style={{ fontSize: '2.5rem' }}>🌐</span>
                <h4 style={{ margin: '0.5rem 0 0.25rem 0' }}>International transfers</h4>
                <p
                  style={{
                    margin: 0,
                    fontSize: '0.8rem',
                    color: 'var(--text-muted)',
                    lineHeight: 1.5,
                  }}
                >
                  Upgrade account settings or check standard SWIFT routing to deposit funds from
                  foreign accounts.
                </p>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function DetailRow({
  label,
  value,
  onCopy,
  isCopied,
}: {
  label: string;
  value: string;
  onCopy: () => void;
  isCopied: boolean;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
      <span
        style={{
          fontSize: '0.725rem',
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          fontWeight: 600,
        }}
      >
        {label}
      </span>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: '1rem',
          backgroundColor: 'var(--bg-app)',
          padding: '0.6rem 0.85rem',
          borderRadius: '8px',
          border: '1px solid var(--border-subtle)',
        }}
      >
        <span
          style={{
            fontSize: '0.85rem',
            color:
              label.includes('BSB') || label.includes('Account') ? '#0075ff' : 'var(--text-title)',
            fontWeight: 600,
            lineHeight: 1.4,
            wordBreak: 'break-word',
            flex: 1,
          }}
        >
          {value}
        </span>
        <button
          onClick={onCopy}
          style={{
            background: 'transparent',
            border: 'none',
            padding: '0.2rem',
            cursor: 'pointer',
            color: isCopied ? 'var(--accent-success)' : 'var(--text-muted)',
            transition: 'var(--transition-smooth)',
            flexShrink: 0,
          }}
          title="Copy to clipboard"
        >
          {isCopied ? <Check size={16} /> : <Copy size={16} />}
        </button>
      </div>
    </div>
  );
}

function AdvisoryItem({ icon, text, link }: { icon: string; text: string; link?: string }) {
  return (
    <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-start' }}>
      <span style={{ fontSize: '1rem', flexShrink: 0 }}>{icon}</span>
      <span style={{ fontSize: '0.75rem', color: 'var(--text-body)', lineHeight: 1.4 }}>
        {link ? (
          <>
            {text.replace(link, '')}
            <span style={{ color: '#0075ff', cursor: 'pointer', fontWeight: 600 }}>{link}</span>
          </>
        ) : (
          text
        )}
      </span>
    </div>
  );
}
