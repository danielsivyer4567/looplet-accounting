import { useEffect, useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';
import { formatMoney } from '@/lib/money';
import { formatLoadError, formatActionError } from '@/lib/errorMessages';
import { MoveToOrgButton } from '@/components/MoveToOrgButton';
import { AllocationSplitButton } from '@/components/AllocationSplitButton';
import { SkeletonCard, SkeletonTable } from '@/components/Skeleton';
import {
  RefreshCw,
  Info,
  ChevronDown,
  ChevronRight,
  Check,
  X,
  Briefcase,
  User,
  Calendar,
  LayoutGrid,
} from 'lucide-react';
import { Stat, type Tone } from '@/components/ui/Stat';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { PageHeader } from '@/components/ui/PageHeader';
import { EmptyState } from '@/components/ui/EmptyState';

const SUBSCRIPTION_TONES: Partial<Record<string, Tone>> = {
  confirmed: 'success',
  candidate: 'info',
  detected: 'info',
  cancelled: 'neutral',
  dismissed: 'warning',
  paused: 'warning',
};
const SUBSCRIPTION_LABELS: Record<string, string> = {
  confirmed: 'Confirmed',
  candidate: 'Candidate',
  detected: 'Candidate',
  cancelled: 'Cancelled',
  dismissed: 'Dismissed',
  paused: 'Dismissed',
};

interface Subscription {
  id: string;
  organization_id: string;
  merchant_name: string;
  merchant_canonical_key: string | null;
  cadence: string;
  amount_cents: number;
  status: string;
  confidence: number | null;
  first_seen_at: string;
  last_seen_at: string;
  next_expected_at: string | null;
  observed_count: number;
  total_spent_cents: number;
  detection_reason: string | null;
  is_personal: boolean;
  is_business: boolean;
  notes: string | null;
}

const STATUS_FILTERS = ['all', 'candidate', 'confirmed', 'cancelled', 'dismissed'] as const;

export function SubscriptionsPage() {
  const { currentOrg } = useOrg();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<(typeof STATUS_FILTERS)[number]>('all');
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [loading, setLoading] = useState(true);
  const [detecting, setDetecting] = useState(false);
  const [detectMsg, setDetectMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);
    setError(null);
    let q = supabase
      .from('subscriptions')
      .select('*')
      .eq('organization_id', currentOrg.id)
      .order('merchant_name', { ascending: true })
      .order('amount_cents', { ascending: false });
    if (filter !== 'all') q = q.eq('status', filter);
    const { data, error: e } = await q;
    if (e) setError(formatLoadError('subscriptions', e.message));
    setSubs((data ?? []) as Subscription[]);
    setLoading(false);
  }, [currentOrg, filter]);

  useEffect(() => void refresh(), [refresh]);

  const grouped = useMemo(() => {
    const m = new Map<string, { name: string; rows: Subscription[] }>();
    for (const s of subs) {
      const key = s.merchant_name.trim().toLowerCase();
      let entry = m.get(key);
      if (!entry) {
        entry = { name: s.merchant_name, rows: [] };
        m.set(key, entry);
      }
      entry.rows.push(s);
    }
    return Array.from(m.values());
  }, [subs]);

  if (!currentOrg) return null;

  const monthlyEquivalent = (s: Subscription): number => {
    if (s.cadence === 'monthly') return s.amount_cents;
    if (s.cadence === 'yearly' || s.cadence === 'annual') return Math.round(s.amount_cents / 12);
    if (s.cadence === 'weekly') return Math.round(s.amount_cents * 4.33);
    if (s.cadence === 'fortnightly') return Math.round(s.amount_cents * 2.17);
    if (s.cadence === 'quarterly') return Math.round(s.amount_cents / 3);
    return s.amount_cents;
  };

  const totalMonthly = subs
    .filter((s) => s.status !== 'cancelled' && s.status !== 'dismissed')
    .reduce((a, s) => a + monthlyEquivalent(s), 0);
  const businessOnly = subs
    .filter((s) => s.is_business && !s.is_personal && s.status !== 'dismissed')
    .reduce((a, s) => a + monthlyEquivalent(s) * 12, 0);
  const personalOnly = subs
    .filter((s) => s.is_personal && s.status !== 'dismissed')
    .reduce((a, s) => a + monthlyEquivalent(s) * 12, 0);

  const setFlag = async (id: string, patch: Partial<Subscription>) => {
    const { error: e } = await supabase.from('subscriptions').update(patch).eq('id', id);
    if (e) {
      setError(formatActionError('update this subscription', e.message));
      return;
    }
    void refresh();
  };

  const setStatus = async (id: string, status: 'confirmed' | 'dismissed' | 'candidate') => {
    const { error: e } = await supabase
      .from('subscriptions')
      .update({ status, reviewed_at: new Date().toISOString() })
      .eq('id', id);
    if (e) {
      setError(formatActionError(`set this subscription to ${status}`, e.message));
      return;
    }
    void refresh();
  };

  const toggleExpanded = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const detect = async () => {
    if (!currentOrg) return;
    setDetecting(true);
    setDetectMsg(null);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in');
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/subscriptions-detect`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ organization_id: currentOrg.id }),
        },
      );
      const body = await res.json();
      if (!res.ok || !body.ok) throw new Error(body.error ?? `${res.status}`);
      setDetectMsg(
        `Scanned ${body.scanned_txns} txns · ${body.upserted} new + ${body.updated} updated subscriptions`,
      );
      void refresh();
    } catch (e) {
      setDetectMsg('Detection error: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setDetecting(false);
    }
  };

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
          <PageHeader title="Subscriptions" />
          <button className="btn btn-primary" onClick={detect} disabled={detecting}>
            <RefreshCw className={`w-4 h-4 ${detecting ? 'animate-spin' : ''}`} />
            {detecting ? 'Detecting…' : 'Sync Subscription Feeds'}
          </button>
        </div>
        <p
          style={{ color: 'var(--text-muted)', fontSize: '0.925rem', maxWidth: '600px', margin: 0 }}
        >
          Recurring payments auto-detected from bank transactions and email receipts. Categorise
          each as business or personal to roll them into your reports.
        </p>
      </div>

      {detectMsg && (
        <div
          className={`badge ${detectMsg.startsWith('Detection error') ? 'badge-danger' : 'badge-success'}`}
          style={{
            display: 'block',
            padding: '0.625rem 1rem',
            textTransform: 'none',
            width: 'fit-content',
          }}
        >
          {detectMsg}
        </div>
      )}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: '1rem',
        }}
      >
        <Stat
          label="Active Subscriptions"
          value={String(
            subs.filter((s) => s.status !== 'cancelled' && s.status !== 'dismissed').length,
          )}
          accentColor="var(--accent-info)"
          icon={<LayoutGrid className="w-5 h-5" style={{ color: 'var(--accent-info)' }} />}
        />
        <Stat
          label="Monthly Run Rate"
          value={formatMoney(totalMonthly)}
          accentColor="var(--accent-warning)"
          icon={<Calendar className="w-5 h-5" style={{ color: 'var(--accent-warning)' }} />}
          sub="consolidated monthly total"
        />
        <Stat
          label="Annual Business Spend"
          value={formatMoney(businessOnly)}
          accentColor="var(--accent-success)"
          icon={<Briefcase className="w-5 h-5" style={{ color: 'var(--accent-success)' }} />}
          sub="tax deductible items"
        />
        <Stat
          label="Annual Personal Spend"
          value={formatMoney(personalOnly)}
          accentColor="var(--text-muted)"
          icon={<User className="w-5 h-5" style={{ color: 'var(--text-muted)' }} />}
          sub="non-deductible items"
        />
      </div>

      <div>
        <div
          style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap', marginBottom: '1.25rem' }}
        >
          {STATUS_FILTERS.map((s) => (
            <button
              key={s}
              onClick={() => setFilter(s)}
              className={`btn ${filter === s ? 'btn-primary' : 'btn-secondary'}`}
              style={{
                padding: '0.375rem 0.75rem',
                textTransform: 'capitalize',
                fontSize: '0.8rem',
              }}
            >
              {s}
            </button>
          ))}
        </div>

        {error && (
          <div
            className="badge badge-danger"
            style={{
              display: 'block',
              padding: '0.5rem 1rem',
              textTransform: 'none',
              marginBottom: '1rem',
            }}
          >
            {error}
          </div>
        )}

        {loading ? (
          <>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                gap: '1rem',
                marginBottom: '1rem',
              }}
            >
              {Array.from({ length: 4 }).map((_, i) => (
                <SkeletonCard key={i} />
              ))}
            </div>
            <SkeletonTable rows={6} cols={10} />
          </>
        ) : subs.length === 0 ? (
          <EmptyState
            icon={Calendar}
            title="No subscriptions detected matching the status filter. Run a scan or sync your bank feeds to detect payments."
          />
        ) : (
          <>
            <div className="subscriptions-table-view table-premium-container">
              <table className="table-premium">
                <thead>
                  <tr>
                    <th style={{ width: '40px' }}></th>
                    <th>Merchant / Vendor</th>
                    <th>Cadence</th>
                    <th style={{ textAlign: 'right' }}>Amount</th>
                    <th style={{ textAlign: 'right' }}>Monthly Eq.</th>
                    <th style={{ textAlign: 'right' }}>Annual Eq.</th>
                    <th>Status</th>
                    <th>Classification</th>
                    <th>Confidence</th>
                    <th style={{ width: '220px' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {grouped.map((g) => {
                    const groupKey = g.name.toLowerCase();
                    const isGroup = g.rows.length > 1;
                    const isOpen = expanded.has(groupKey);

                    if (!isGroup) {
                      const s = g.rows[0];
                      if (!s) return null;
                      return (
                        <SubRow
                          key={s.id}
                          s={s}
                          monthly={monthlyEquivalent(s)}
                          indent={false}
                          navigate={navigate}
                          setFlag={setFlag}
                          setStatus={setStatus}
                          refresh={refresh}
                        />
                      );
                    }

                    const groupMonthly = g.rows.reduce((a, s) => a + monthlyEquivalent(s), 0);
                    const groupAnnual = groupMonthly * 12;
                    const distinctStatuses = new Set(g.rows.map((s) => s.status));
                    return (
                      <g key={`group-wrapper:${groupKey}`}>
                        <tr
                          style={{
                            borderBottom: '1px solid var(--border-subtle)',
                            backgroundColor: 'var(--bg-hover)',
                            cursor: 'pointer',
                          }}
                          onClick={() => toggleExpanded(groupKey)}
                        >
                          <td style={{ textAlign: 'center' }}>
                            {isOpen ? (
                              <ChevronDown className="w-4 h-4 text-muted" />
                            ) : (
                              <ChevronRight className="w-4 h-4 text-muted" />
                            )}
                          </td>
                          <td>
                            <div
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.5rem',
                                fontWeight: 600,
                                color: 'var(--text-title)',
                              }}
                            >
                              {g.name}
                              <span
                                style={{
                                  fontSize: '0.75rem',
                                  fontWeight: 400,
                                  color: 'var(--text-muted)',
                                  backgroundColor: 'var(--bg-card)',
                                  padding: '0.1rem 0.4rem',
                                  borderRadius: 'var(--radius-sm)',
                                }}
                              >
                                {g.rows.length} variants
                              </span>
                            </div>
                          </td>
                          <td style={{ color: 'var(--text-muted)' }}>—</td>
                          <td style={{ textAlign: 'right', color: 'var(--text-muted)' }}>—</td>
                          <td
                            style={{
                              textAlign: 'right',
                              fontWeight: 600,
                              color: 'var(--text-title)',
                            }}
                          >
                            {formatMoney(groupMonthly)}
                          </td>
                          <td style={{ textAlign: 'right', color: 'var(--text-muted)' }}>
                            {formatMoney(groupAnnual)}
                          </td>
                          <td>
                            <div style={{ display: 'flex', gap: '0.25rem' }}>
                              {Array.from(distinctStatuses).map((s) => (
                                <StatusBadge
                                  key={s}
                                  status={s}
                                  tones={SUBSCRIPTION_TONES}
                                  label={SUBSCRIPTION_LABELS[s]}
                                />
                              ))}
                            </div>
                          </td>
                          <td></td>
                          <td></td>
                          <td onClick={(e) => e.stopPropagation()}>
                            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                              Click to view details
                            </span>
                          </td>
                        </tr>
                        {isOpen &&
                          g.rows.map((s) => (
                            <SubRow
                              key={s.id}
                              s={s}
                              monthly={monthlyEquivalent(s)}
                              indent={true}
                              navigate={navigate}
                              setFlag={setFlag}
                              setStatus={setStatus}
                              refresh={refresh}
                            />
                          ))}
                      </g>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="subscriptions-card-view" aria-label="Subscription cards">
              {subs.map((s) => (
                <SubscriptionCard
                  key={s.id}
                  s={s}
                  monthly={monthlyEquivalent(s)}
                  navigate={navigate}
                  setFlag={setFlag}
                  setStatus={setStatus}
                  refresh={refresh}
                />
              ))}
            </div>
          </>
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
          style={{ flexShrink: 0, marginTop: '0.1rem', color: 'var(--text-link)' }}
        />
        <div>
          <strong style={{ color: 'var(--text-title)', display: 'block', marginBottom: '0.25rem' }}>
            Future Features:
          </strong>
          Double-charge and price hike alerts, visual subscription comparison charts, direct cancel
          links, and project/job allocation tracking.
        </div>
      </div>
    </section>
  );
}

function SubRow({
  s,
  monthly,
  indent,
  navigate,
  setFlag,
  setStatus,
  refresh,
}: {
  s: Subscription;
  monthly: number;
  indent: boolean;
  navigate: ReturnType<typeof useNavigate>;
  setFlag: (id: string, patch: Partial<Subscription>) => Promise<void>;
  setStatus: (id: string, status: 'confirmed' | 'dismissed' | 'candidate') => Promise<void>;
  refresh: () => void;
}) {
  const annual = monthly * 12;
  const sourceHint = s.merchant_canonical_key
    ? s.merchant_canonical_key.replace(/^domain:/, '@').replace(/^email:/, '')
    : '—';
  return (
    <tr style={{ opacity: s.status === 'dismissed' ? 0.6 : 1 }}>
      <td></td>
      <td style={{ paddingLeft: indent ? '2rem' : undefined }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          {indent && <span style={{ color: 'var(--text-muted)', userSelect: 'none' }}>↳</span>}
          <a
            onClick={(e) => {
              e.preventDefault();
              navigate(`/subscriptions/${s.id}`);
            }}
            href={`/subscriptions/${s.id}`}
            style={{ fontWeight: 600, color: 'var(--text-link)', textDecoration: 'none' }}
          >
            {s.merchant_name}
          </a>
        </div>
        <div
          style={{
            fontSize: '0.75rem',
            color: 'var(--text-muted)',
            marginTop: '0.15rem',
            paddingLeft: indent ? '1rem' : undefined,
          }}
        >
          {sourceHint}
        </div>
      </td>
      <td style={{ textTransform: 'capitalize' }}>{s.cadence}</td>
      <td style={{ textAlign: 'right', fontWeight: 500, color: 'var(--text-title)' }}>
        {s.amount_cents > 0 ? formatMoney(s.amount_cents) : '—'}
      </td>
      <td style={{ textAlign: 'right' }}>{monthly > 0 ? formatMoney(monthly) : '—'}</td>
      <td style={{ textAlign: 'right' }}>{annual > 0 ? formatMoney(annual) : '—'}</td>
      <td>
        <StatusBadge
          status={s.status}
          tones={SUBSCRIPTION_TONES}
          label={SUBSCRIPTION_LABELS[s.status]}
        />
      </td>
      <td>
        <ClassificationControls s={s} setFlag={setFlag} />
      </td>
      <td>
        <ConfidenceIndicator confidence={s.confidence} />
      </td>
      <td>
        <SubscriptionActions s={s} setStatus={setStatus} refresh={refresh} />
      </td>
    </tr>
  );
}

function SubscriptionCard({
  s,
  monthly,
  navigate,
  setFlag,
  setStatus,
  refresh,
}: {
  s: Subscription;
  monthly: number;
  navigate: ReturnType<typeof useNavigate>;
  setFlag: (id: string, patch: Partial<Subscription>) => Promise<void>;
  setStatus: (id: string, status: 'confirmed' | 'dismissed' | 'candidate') => Promise<void>;
  refresh: () => void;
}) {
  const annual = monthly * 12;
  const sourceHint = s.merchant_canonical_key
    ? s.merchant_canonical_key.replace(/^domain:/, '@').replace(/^email:/, '')
    : '—';

  return (
    <article
      className="subscription-mobile-card card"
      aria-label={`Subscription ${s.merchant_name}`}
      style={{ opacity: s.status === 'dismissed' ? 0.6 : 1 }}
    >
      <div className="subscription-mobile-card__header">
        <div>
          <a
            onClick={(e) => {
              e.preventDefault();
              navigate(`/subscriptions/${s.id}`);
            }}
            href={`/subscriptions/${s.id}`}
            style={{
              fontWeight: 700,
              color: 'var(--text-link)',
              textDecoration: 'none',
            }}
          >
            {s.merchant_name}
          </a>
          <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem', marginTop: '0.15rem' }}>
            {sourceHint}
          </div>
        </div>
        <StatusBadge
          status={s.status}
          tones={SUBSCRIPTION_TONES}
          label={SUBSCRIPTION_LABELS[s.status]}
        />
      </div>

      <div className="subscription-mobile-card__metrics">
        <Stat variant="inline" label="Cadence" value={s.cadence} />
        <Stat
          variant="inline"
          label="Amount"
          value={s.amount_cents > 0 ? formatMoney(s.amount_cents) : '—'}
        />
        <Stat
          variant="inline"
          label="Monthly Eq."
          value={monthly > 0 ? formatMoney(monthly) : '—'}
        />
        <Stat variant="inline" label="Annual Eq." value={annual > 0 ? formatMoney(annual) : '—'} />
      </div>

      <div className="subscription-mobile-card__row">
        <span>Classification</span>
        <ClassificationControls s={s} setFlag={setFlag} />
      </div>
      <div className="subscription-mobile-card__row">
        <span>Confidence</span>
        <ConfidenceIndicator confidence={s.confidence} />
      </div>
      <div className="subscription-mobile-card__actions">
        <SubscriptionActions s={s} setStatus={setStatus} refresh={refresh} />
      </div>
    </article>
  );
}

function ClassificationControls({
  s,
  setFlag,
}: {
  s: Subscription;
  setFlag: (id: string, patch: Partial<Subscription>) => Promise<void>;
}) {
  return (
    <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
      <button
        onClick={() =>
          void setFlag(s.id, {
            is_business: !s.is_business,
            is_personal: false,
          } as Partial<Subscription>)
        }
        className="btn"
        style={{
          padding: '0.2rem 0.5rem',
          fontSize: '0.7rem',
          backgroundColor:
            s.is_business && !s.is_personal ? 'var(--bg-success-subtle)' : 'var(--bg-hover)',
          color: s.is_business && !s.is_personal ? 'var(--text-success)' : 'var(--text-muted)',
          border: `1px solid ${s.is_business && !s.is_personal ? 'var(--border-success)' : 'var(--border-subtle)'}`,
        }}
      >
        Biz
      </button>
      <button
        onClick={() =>
          void setFlag(s.id, {
            is_personal: !s.is_personal,
            is_business: false,
          } as Partial<Subscription>)
        }
        className="btn"
        style={{
          padding: '0.2rem 0.5rem',
          fontSize: '0.7rem',
          backgroundColor: s.is_personal ? 'var(--bg-warning-subtle)' : 'var(--bg-hover)',
          color: s.is_personal ? 'var(--text-warning)' : 'var(--text-muted)',
          border: `1px solid ${s.is_personal ? 'var(--border-warning)' : 'var(--border-subtle)'}`,
        }}
      >
        Personal
      </button>
    </div>
  );
}

function ConfidenceIndicator({ confidence }: { confidence: number | null }) {
  if (confidence == null) return <>—</>;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
      <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>{(confidence * 100).toFixed(0)}%</span>
      <div
        style={{
          width: '40px',
          height: '4px',
          backgroundColor: 'var(--border-subtle)',
          borderRadius: '2px',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${confidence * 100}%`,
            height: '100%',
            backgroundColor:
              confidence > 0.8
                ? 'var(--accent-success)'
                : confidence > 0.5
                  ? 'var(--accent-warning)'
                  : 'var(--accent-danger)',
          }}
        ></div>
      </div>
    </div>
  );
}

function SubscriptionActions({
  s,
  setStatus,
  refresh,
}: {
  s: Subscription;
  setStatus: (id: string, status: 'confirmed' | 'dismissed' | 'candidate') => Promise<void>;
  refresh: () => void;
}) {
  return (
    <div style={{ display: 'inline-flex', gap: '0.25rem', flexWrap: 'wrap' }}>
      {s.status !== 'confirmed' && (
        <button
          onClick={() => void setStatus(s.id, 'confirmed')}
          className="btn btn-secondary"
          style={{ padding: '0.2rem 0.4rem', fontSize: '0.7rem', color: 'var(--text-success)' }}
          title="Confirm this subscription"
        >
          <Check className="w-3 h-3" />
        </button>
      )}
      {s.status !== 'dismissed' && (
        <button
          onClick={() => void setStatus(s.id, 'dismissed')}
          className="btn btn-secondary"
          style={{ padding: '0.2rem 0.4rem', fontSize: '0.7rem', color: 'var(--text-danger)' }}
          title="Dismiss"
        >
          <X className="w-3 h-3" />
        </button>
      )}
      {s.status === 'dismissed' && (
        <button
          onClick={() => void setStatus(s.id, 'candidate')}
          className="btn btn-secondary"
          style={{ padding: '0.2rem 0.4rem', fontSize: '0.7rem' }}
        >
          Restore
        </button>
      )}
      <AllocationSplitButton
        resourceType="subscription"
        resourceId={s.id}
        hostOrgId={s.organization_id}
        label="Split"
        onSaved={() => refresh()}
      />
      <MoveToOrgButton
        table="subscriptions"
        rowId={s.id}
        currentOrgId={s.organization_id}
        fkColumnsToNull={['supplier_id']}
        label="Move"
        onMoved={() => refresh()}
      />
    </div>
  );
}
