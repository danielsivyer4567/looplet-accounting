import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useOrg } from '@/hooks/useOrg';
import { useRealtimePnl } from '@/hooks/useRealtimePnl';
import { useAdviceNotes, type AdviceNote, type AdviceNoteKind } from '@/hooks/useAdviceNotes';
import { useTaxCalendar, type TaxObligation } from '@/hooks/useTaxCalendar';
import { useOnboardingProgress } from '@/hooks/onboarding/useStagedEntities';
import { useWorkstreamTasks, type WorkstreamTask, type TaskKind } from '@/hooks/useWorkstreamTasks';
import { useRecentActivity } from '@/hooks/useRecentActivity';
import { supabase } from '@/lib/supabase';
import { IntentLauncher } from '@/components/IntentLauncher';
import { AdviceCard } from '@/components/AdviceCard';
import { AdviceNoteView } from '@/components/AdviceNoteView';
import { SkeletonCard } from '@/components/Skeleton';
import { InsightAreaChart, InsightBarList, InsightPanel } from '@/components/InsightCharts';
import { formatLoadError } from '@/lib/errorMessages';
import { currentFyLabel } from '@/lib/formatting';
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
  Clock,
  AlertTriangle,
  FileWarning,
  Banknote,
  Receipt,
  ArrowLeftRight,
  FileSearch,
  UserCheck,
  ShieldAlert,
  CalendarClock,
} from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { EmptyState } from '@/components/ui/EmptyState';

const FEED_COLORS = [1, 2, 3, 4, 5, 6, 7].map((n) => `var(--palette-${n})`);

/** Stable colour per label so the same supplier/customer always gets the same badge. */
function feedColor(label: string): string {
  let hash = 0;
  for (let i = 0; i < label.length; i++) hash = (hash * 31 + label.charCodeAt(i)) | 0;
  return FEED_COLORS[Math.abs(hash) % FEED_COLORS.length] as string;
}

const YEAR_END_PRIORITY: Partial<Record<AdviceNoteKind, number>> = {
  year_end: 0,
  structuring: 1,
  forecast: 2,
  profit_extraction: 3,
  cgt: 4,
  fbt: 5,
};

const STANDARD_PRIORITY: Partial<Record<AdviceNoteKind, number>> = {
  forecast: 0,
  profit_extraction: 1,
  structuring: 2,
  year_end: 3,
  cgt: 4,
  fbt: 5,
};

function AdviceCardsSection({
  notes,
  loading,
  error,
  onOpen,
}: {
  notes: AdviceNote[];
  loading: boolean;
  error: string | null;
  onOpen: (id: string) => void;
}) {
  if (loading) {
    return (
      <section style={{ display: 'grid', gap: '1rem' }} aria-label="Advice cards loading">
        <SkeletonCard />
      </section>
    );
  }

  if (error) {
    return (
      <section
        className="badge badge-danger"
        style={{ display: 'block', padding: '0.75rem', textAlign: 'center' }}
        aria-label="Advice cards error"
      >
        {error}
      </section>
    );
  }

  if (notes.length === 0) return null;

  return (
    <section
      style={{
        gridColumn: '1 / -1',
        display: 'grid',
        gap: '0.75rem',
      }}
      aria-label="Proactive advice"
    >
      <h2 style={{ margin: 0, color: 'var(--text-title)', fontSize: '1rem', letterSpacing: 0 }}>
        Proactive advice
      </h2>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
          gap: '1rem',
        }}
      >
        {notes.map((note) => (
          <AdviceCard key={note.id} note={note} onOpen={onOpen} />
        ))}
      </div>
    </section>
  );
}

function OnboardingTriagePrompt({ remaining }: { remaining: number }) {
  if (remaining <= 0) return null;

  const senderLabel = remaining === 1 ? 'sender' : 'senders';
  return (
    <section
      aria-label="Onboarding triage prompt"
      style={{
        gridColumn: '1 / -1',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '1rem',
        padding: '1rem',
        background: 'var(--bg-panel)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-md)',
        boxShadow: 'var(--shadow-sm)',
        flexWrap: 'wrap',
      }}
    >
      <div>
        <h2 style={{ margin: 0, color: 'var(--text-title)', fontSize: '1rem', letterSpacing: 0 }}>
          Onboarding triage
        </h2>
        <p style={{ margin: '0.25rem 0 0', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
          {remaining} staged {senderLabel} need approval before future emails auto-route.
        </p>
      </div>
      <Link to="/onboarding/triage" className="btn btn-primary">
        <span>
          Review {remaining} staged {senderLabel}
        </span>
        <ChevronRight size={16} />
      </Link>
    </section>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function orderAdviceNotesForSeason(
  notes: AdviceNote[],
  obligations: TaxObligation[],
  asAt: Date = new Date(),
): AdviceNote[] {
  const yearEndSeason = isYearEndSeason(obligations, asAt);
  const priority = yearEndSeason ? YEAR_END_PRIORITY : STANDARD_PRIORITY;
  return notes
    .filter((note) => note.status === 'draft' || note.status === 'issued')
    .slice()
    .sort((a, b) => {
      const priorityDiff = priorityFor(a.kind, priority) - priorityFor(b.kind, priority);
      if (priorityDiff !== 0) return priorityDiff;
      return timestamp(b.updated_at) - timestamp(a.updated_at);
    });
}

function isYearEndSeason(obligations: TaxObligation[], asAt: Date): boolean {
  const month = asAt.getMonth();
  const day = asAt.getDate();
  if (month === 5 && day <= 30) return true;
  return obligations.some((obligation) => {
    const due = new Date(`${obligation.due_date}T00:00:00`);
    if (Number.isNaN(due.getTime())) return false;
    const dueIsJune30 = due.getMonth() === 5 && due.getDate() === 30;
    return dueIsJune30 && obligation.days_until_due >= -7 && obligation.days_until_due <= 45;
  });
}

function priorityFor(
  kind: AdviceNoteKind,
  priority: Partial<Record<AdviceNoteKind, number>>,
): number {
  return priority[kind] ?? 99;
}

function timestamp(value: string): number {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

export function DashboardPage() {
  const { currentOrg } = useOrg();
  const { pnl, loading, error } = useRealtimePnl();
  const {
    notes: adviceNotes,
    loading: adviceLoading,
    actionBusy: adviceActionBusy,
    error: adviceError,
    signOff,
    dismiss,
  } = useAdviceNotes();
  const { obligations } = useTaxCalendar();
  const { progress: onboardingProgress, loading: onboardingProgressLoading } =
    useOnboardingProgress();
  const { tasks: todayTasks, loading: todayLoading } = useWorkstreamTasks();
  const { items: activityItems, loading: activityLoading } = useRecentActivity();
  const [payerDetails, setPayerDetails] = useState<{
    name: string;
    bsb: string;
    account: string;
  } | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'local' | 'international'>('local');
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [selectedAdviceNoteId, setSelectedAdviceNoteId] = useState<string | null>(null);
  const seasonalAdviceNotes = useMemo(
    () => orderAdviceNotesForSeason(adviceNotes, obligations).slice(0, 3),
    [adviceNotes, obligations],
  );
  const selectedAdviceNote =
    selectedAdviceNoteId != null
      ? (adviceNotes.find((note) => note.id === selectedAdviceNoteId) ?? null)
      : null;
  const onboardingRemaining =
    onboardingProgressLoading || onboardingProgress == null
      ? 0
      : onboardingProgress.pending_count + onboardingProgress.needs_review_count;

  useEffect(() => {
    if (!currentOrg) {
      setPayerDetails(null);
      return;
    }
    let cancelled = false;
    void supabase
      .from('organizations')
      .select('settings')
      .eq('id', currentOrg.id)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        const s = (data?.settings ?? {}) as Record<string, unknown>;
        const bsb = typeof s['payer_bsb'] === 'string' ? s['payer_bsb'] : '';
        const account = typeof s['payer_account'] === 'string' ? s['payer_account'] : '';
        const name = typeof s['payer_name'] === 'string' ? s['payer_name'] : '';
        setPayerDetails(bsb && account ? { name: name || currentOrg.name, bsb, account } : null);
      });
    return () => {
      cancelled = true;
    };
  }, [currentOrg]);

  useEffect(() => {
    if (selectedAdviceNoteId && !adviceNotes.some((note) => note.id === selectedAdviceNoteId)) {
      setSelectedAdviceNoteId(null);
    }
  }, [adviceNotes, selectedAdviceNoteId]);

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
        <PageHeader title="Welcome to Looplet" style={{ marginBottom: '1rem' }} />
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
        {formatLoadError('dashboard', error)}
      </p>
    );
  }

  const balanceCents = pnl?.really_yours_cents ?? 0;
  const feedChronological = activityItems.slice().reverse();
  const transactionTotalCents = feedChronological.reduce((sum, tx) => sum + tx.amountCents, 0);
  let runningPulseCents = balanceCents - transactionTotalCents;
  const cashPulseItems = feedChronological.length
    ? feedChronological.map((tx) => {
        runningPulseCents += tx.amountCents;
        return { label: tx.sub.split('•')[0]?.trim() ?? tx.sub, value: runningPulseCents };
      })
    : [{ label: 'No activity yet', value: balanceCents }];
  let runningSpendCents = 0;
  let runningIncomeCents = 0;
  const spendPulseItems = feedChronological.map((tx) => {
    if (tx.amountCents < 0) runningSpendCents += Math.abs(tx.amountCents);
    return { label: tx.sub.split('•')[0]?.trim() ?? tx.sub, value: runningSpendCents };
  });
  const incomePulseItems = feedChronological.map((tx) => {
    if (tx.amountCents > 0) runningIncomeCents += tx.amountCents;
    return { label: tx.sub.split('•')[0]?.trim() ?? tx.sub, value: runningIncomeCents };
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
            <span>Take-home this {currentFyLabel()} • AUD</span>
          </div>
        </div>

        {/* Action Pill Buttons */}
        <div className="dashboard-action-pills" style={{ display: 'flex', gap: '0.5rem' }}>
          <Link to="/payment-runs" className="revolut-pill-btn">
            <Shuffle size={14} />
            <span>Move</span>
          </Link>
          <Link to="/reports" className="revolut-pill-btn">
            <FileText size={14} />
            <span>Statement</span>
          </Link>
          <button onClick={() => setDrawerOpen(true)} className="revolut-pill-btn">
            <Building2 size={14} />
            <span>Account details</span>
          </button>
        </div>
      </div>

      {/* Owner intent launchers */}
      <div style={{ marginBottom: '1.5rem' }}>
        <IntentLauncher />
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          gap: '1rem',
          marginBottom: '1.5rem',
        }}
      >
        <OnboardingTriagePrompt remaining={onboardingRemaining} />
        <AdviceCardsSection
          notes={seasonalAdviceNotes}
          loading={adviceLoading}
          error={adviceError}
          onOpen={setSelectedAdviceNoteId}
        />
        {selectedAdviceNote && (
          <section
            style={{
              gridColumn: '1 / -1',
              display: 'grid',
              gap: '0.75rem',
              padding: '1rem',
              background: 'var(--bg-panel)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-md)',
              boxShadow: 'var(--shadow-sm)',
            }}
            aria-label="Selected advice note"
          >
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setSelectedAdviceNoteId(null)}
                aria-label="Close advice note"
              >
                <X size={14} />
                Close
              </button>
            </div>
            <AdviceNoteView
              note={selectedAdviceNote}
              actionBusy={adviceActionBusy}
              onSignOff={(id) => void signOff(id)}
              onDismiss={(id) => void dismiss(id)}
            />
          </section>
        )}
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

      {/* Today — owner-first workstream feed */}
      <TodayFeed tasks={todayTasks} loading={todayLoading} />

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
        {activityLoading && activityItems.length === 0 && (
          <div style={{ padding: '1rem 1.25rem' }}>
            <SkeletonCard />
          </div>
        )}
        {!activityLoading && activityItems.length === 0 && (
          <EmptyState>
            No money activity yet — upload a bill, raise an invoice, or import a bank statement and
            it shows up here.
          </EmptyState>
        )}
        {activityItems.map((tx, idx) => (
          <div
            key={tx.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              padding: '0.85rem 1.25rem',
              borderBottom:
                idx === activityItems.length - 1 ? 'none' : '1px solid var(--border-subtle)',
              gap: '1rem',
              transition: 'var(--transition-smooth)',
            }}
            className="transaction-row"
          >
            {/* Counterparty Initial Badge */}
            <div
              className="merchant-icon"
              style={{
                backgroundColor: feedColor(tx.label),
                overflow: 'hidden',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {tx.label.charAt(0).toUpperCase()}
            </div>

            {/* Counterparty Details */}
            <div style={{ flex: 1 }}>
              <div
                style={{
                  fontWeight: 600,
                  color: 'var(--text-title)',
                  fontSize: '0.875rem',
                }}
              >
                {tx.label}
              </div>
              <div
                style={{
                  fontSize: '0.75rem',
                  color: 'var(--text-muted)',
                  marginTop: '0.15rem',
                }}
              >
                {tx.sub}
              </div>
            </div>

            {/* Transaction Amount */}
            <div
              style={{
                fontWeight: 700,
                fontSize: '0.875rem',
                color: tx.amountCents > 0 ? 'var(--text-success)' : 'var(--text-title)',
              }}
            >
              {tx.amountCents > 0 ? '+' : '-'}A$
              {(Math.abs(tx.amountCents) / 100).toLocaleString('en-AU', {
                minimumFractionDigits: 2,
              })}
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
          <Link
            to="/reconciliation"
            style={{
              fontSize: '0.8rem',
              color: 'var(--text-link)',
              fontWeight: 600,
            }}
          >
            See all
          </Link>
        </div>
      </div>

      <p
        className="dashboard-formula"
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
                aria-label="Close"
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

                {payerDetails ? (
                  <>
                    <DetailRow
                      label="Beneficiary"
                      value={payerDetails.name}
                      onCopy={() => handleCopy(payerDetails.name, 'beneficiary')}
                      isCopied={copiedField === 'beneficiary'}
                    />
                    <DetailRow
                      label="Account"
                      value={payerDetails.account}
                      onCopy={() => handleCopy(payerDetails.account, 'account')}
                      isCopied={copiedField === 'account'}
                    />
                    <DetailRow
                      label="BSB Number"
                      value={payerDetails.bsb}
                      onCopy={() => handleCopy(payerDetails.bsb, 'bsb')}
                      isCopied={copiedField === 'bsb'}
                    />
                    <button
                      onClick={() =>
                        handleCopy(
                          `BSB: ${payerDetails.bsb}, Account: ${payerDetails.account}, Beneficiary: ${payerDetails.name}`,
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
                  </>
                ) : (
                  <div
                    style={{
                      backgroundColor: 'var(--bg-app)',
                      border: '1px solid var(--border-subtle)',
                      borderRadius: '8px',
                      padding: '1rem',
                      fontSize: '0.85rem',
                      color: 'var(--text-muted)',
                      lineHeight: 1.5,
                    }}
                  >
                    Add your organisation&apos;s bank details in{' '}
                    <Link to="/settings" style={{ color: 'var(--text-link)', fontWeight: 600 }}>
                      Settings → Payments
                    </Link>{' '}
                    to show and share your receiving account here.
                  </div>
                )}

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
                    icon="💡"
                    text="These are your organisation's receiving details from Settings — put them on invoices so customers can pay you"
                  />
                  <AdvisoryItem
                    icon="🇦🇺"
                    text="Australian BSB + account transfers only — payments usually land the same or next business day"
                  />
                  <AdvisoryItem
                    icon="🔄"
                    text="Payment runs and ABA files generated by Looplet draw on the payer details saved in Settings"
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
                  <Link
                    to="/reports"
                    onClick={() => setDrawerOpen(false)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      backgroundColor: 'var(--bg-app)',
                      padding: '0.75rem 1rem',
                      borderRadius: '8px',
                      textDecoration: 'none',
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
                  </Link>
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
                  Looplet tracks AUD accounts. To receive from overseas, use your bank&apos;s own
                  SWIFT details — the payment lands in your AUD account and imports here like any
                  other transaction.
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
              label.includes('BSB') || label.includes('Account')
                ? 'var(--accent-primary)'
                : 'var(--text-title)',
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

const TASK_ICONS: Record<TaskKind, typeof Clock> = {
  onboarding_triage: UserCheck,
  tax_obligation: FileWarning,
  bas_blocker: ShieldAlert,
  unapproved_bill: Receipt,
  overdue_invoice: Banknote,
  unmatched_bank_item: ArrowLeftRight,
  missing_document: FileSearch,
  pending_approval: Clock,
  advisor_proof_reminder: AlertTriangle,
  duplicate_bill: Copy,
  low_confidence_bill: FileSearch,
  bas_coverage_gap: AlertTriangle,
  period_close: CalendarClock,
  month_end_close: CalendarClock,
};

const CONFIDENCE_COLORS: Record<string, string> = {
  auto_post: 'var(--accent-success)',
  quick_confirm: 'var(--accent-primary)',
  review_needed: 'var(--accent-warning)',
  advisor_required: 'var(--accent-danger)',
  blocked_external: 'var(--accent-danger)',
};

function taskRoute(task: WorkstreamTask): string {
  switch (task.task_kind) {
    case 'onboarding_triage':
      return '/onboarding/triage';
    case 'tax_obligation':
      return '/reports';
    case 'bas_blocker':
    case 'bas_coverage_gap':
      return '/reports/bas';
    case 'unapproved_bill':
    case 'duplicate_bill':
    case 'low_confidence_bill':
      return '/bills';
    case 'overdue_invoice':
      return '/invoices';
    case 'unmatched_bank_item':
      return '/reconciliation';
    case 'pending_approval':
      return '/approvals';
    case 'missing_document':
      return '/receipt-hub';
    case 'advisor_proof_reminder':
      return '/my-activity';
    case 'period_close':
    case 'month_end_close':
      return '/reports';
    default:
      return '/';
  }
}

function TodayFeed({ tasks, loading }: { tasks: WorkstreamTask[]; loading: boolean }) {
  if (loading) {
    return (
      <section
        style={{ gridColumn: '1 / -1', marginBottom: '1.5rem' }}
        aria-label="Today feed loading"
      >
        <h2 style={{ margin: '0 0 0.75rem', color: 'var(--text-title)', fontSize: '1rem' }}>
          Today
        </h2>
        <SkeletonCard />
      </section>
    );
  }
  if (tasks.length === 0) return null;

  return (
    <section
      style={{
        gridColumn: '1 / -1',
        marginBottom: '1.5rem',
      }}
      aria-label="Today"
    >
      <h2 style={{ margin: '0 0 0.75rem', color: 'var(--text-title)', fontSize: '1rem' }}>
        Today
        <span
          style={{
            marginLeft: '0.5rem',
            fontSize: '0.75rem',
            color: 'var(--text-muted)',
            fontWeight: 400,
          }}
        >
          {tasks.length} {tasks.length === 1 ? 'task' : 'tasks'}
        </span>
      </h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        {tasks.map((task) => {
          const Icon = TASK_ICONS[task.task_kind] ?? Clock;
          return (
            <Link
              key={task.id}
              to={taskRoute(task)}
              style={{ textDecoration: 'none', color: 'inherit' }}
            >
              <div
                style={{
                  display: 'flex',
                  gap: '0.75rem',
                  padding: '0.75rem 1rem',
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-md)',
                  boxShadow: 'var(--shadow-sm)',
                  alignItems: 'flex-start',
                  transition: 'box-shadow 0.15s',
                  cursor: 'pointer',
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLElement).style.boxShadow = 'var(--shadow-md)';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.boxShadow = 'var(--shadow-sm)';
                }}
              >
                <div
                  style={{
                    width: '36px',
                    height: '36px',
                    borderRadius: 'var(--radius-sm)',
                    background: 'var(--bg-app)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                    color: 'var(--text-muted)',
                  }}
                >
                  <Icon size={18} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.5rem',
                      flexWrap: 'wrap',
                    }}
                  >
                    <span
                      style={{
                        fontWeight: 600,
                        color: 'var(--text-title)',
                        fontSize: '0.85rem',
                      }}
                    >
                      {task.owner_label}
                    </span>
                    <span
                      style={{
                        fontSize: '0.6875rem',
                        padding: '0.1rem 0.4rem',
                        borderRadius: 'var(--radius-sm)',
                        background: CONFIDENCE_COLORS[task.confidence] ?? 'var(--text-muted)',
                        color: 'var(--text-title)',
                        fontWeight: 600,
                        textTransform: 'uppercase',
                        letterSpacing: '0.04em',
                      }}
                    >
                      {task.confidence === 'auto_post'
                        ? 'Auto'
                        : task.confidence === 'quick_confirm'
                          ? 'Quick'
                          : task.confidence === 'review_needed'
                            ? 'Review'
                            : task.confidence === 'advisor_required'
                              ? 'Advisor'
                              : task.confidence === 'blocked_external'
                                ? 'Blocked'
                                : task.confidence}
                    </span>
                    {task.blocking_reason && (
                      <span
                        style={{
                          fontSize: '0.6875rem',
                          padding: '0.1rem 0.4rem',
                          borderRadius: 'var(--radius-sm)',
                          background: 'var(--bg-danger-subtle)',
                          color: 'var(--text-danger)',
                          fontWeight: 600,
                        }}
                      >
                        BLOCKING
                      </span>
                    )}
                  </div>
                  <p
                    style={{
                      margin: '0.2rem 0 0',
                      fontSize: '0.75rem',
                      color: 'var(--text-muted)',
                      lineHeight: 1.4,
                    }}
                  >
                    {task.why_now}
                  </p>
                  <div
                    style={{
                      marginTop: '0.35rem',
                      display: 'flex',
                      gap: '0.5rem',
                      flexWrap: 'wrap',
                      alignItems: 'center',
                    }}
                  >
                    <span
                      style={{ fontSize: '0.75rem', color: 'var(--text-link)', fontWeight: 600 }}
                    >
                      {task.suggested_action}
                    </span>
                    {task.impact_cents != null && task.impact_cents !== 0 && (
                      <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                        $
                        {(Math.abs(task.impact_cents) / 100).toLocaleString('en-AU', {
                          minimumFractionDigits: 2,
                        })}
                      </span>
                    )}
                    {task.due_at && (
                      <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                        Due {new Date(task.due_at).toLocaleDateString('en-AU')}
                      </span>
                    )}
                  </div>
                </div>
                <ChevronRight
                  size={16}
                  style={{ color: 'var(--text-muted)', flexShrink: 0, marginTop: '0.3rem' }}
                />
              </div>
            </Link>
          );
        })}
      </div>
    </section>
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
            <span style={{ color: 'var(--text-link)', cursor: 'pointer', fontWeight: 600 }}>
              {link}
            </span>
          </>
        ) : (
          text
        )}
      </span>
    </div>
  );
}
