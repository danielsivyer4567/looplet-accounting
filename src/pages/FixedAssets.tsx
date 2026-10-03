import { Fragment, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useOrg } from '@/hooks/useOrg';
import {
  useFixedAssets,
  type FixedAsset,
  type DepreciationMethod,
  type DepreciationSchedule,
} from '@/hooks/useFixedAssets';
import { formatLoadError } from '@/lib/errorMessages';
import { formatMoney } from '@/lib/money';
import { SkeletonTable } from '@/components/Skeleton';
import {
  Boxes,
  Sparkles,
  CheckCircle2,
  X,
  ChevronDown,
  ChevronRight,
  TrendingDown,
} from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { EmptyState } from '@/components/ui/EmptyState';

// 0093 depreciation_method enum -> human label.
function methodLabel(method: DepreciationMethod): string {
  return method === 'prime_cost' ? 'Prime cost' : 'Diminishing value';
}

// 0093 fixed_asset_status enum -> badge class (matches the house badge palette).
function statusBadgeClass(status: FixedAsset['status']): string {
  if (status === 'active') return 'badge-success';
  if (status === 'disposed') return 'badge-neutral';
  return 'badge-warning'; // proposed
}

// How an asset depreciates, derived from its live schedule (0093: one live schedule
// per asset). Assets with no schedule are either instant-write-off / low-value-pool
// (deliberately schedule-less per 0093) or not yet scheduled.
function depreciationSummary(
  asset: FixedAsset,
  schedule: DepreciationSchedule | undefined,
): string {
  if (schedule) return `${methodLabel(schedule.method)} · ${schedule.effective_life_years} yr`;
  if (asset.instant_write_off) return 'Instant write-off';
  if (asset.pool_eligible) return 'Low-value pool';
  return '—';
}

export function FixedAssetsPage() {
  const { currentOrg } = useOrg();
  const { assets, proposals, schedules, loading, error, confirm, reject } = useFixedAssets();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorById, setErrorById] = useState<Record<string, string>>({});

  // One live schedule per asset (0093 partial unique on fixed_asset_id) — index by
  // asset id so each register row and proposal card can find its own schedule.
  const scheduleByAsset = useMemo(() => {
    const map = new Map<string, DepreciationSchedule>();
    for (const s of schedules) map.set(s.fixed_asset_id, s);
    return map;
  }, [schedules]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Run a proposal decision (confirm/reject); both refetch on success so the resolved
  // proposal leaves the list. Surfaces the thrown reason against the asset row.
  const decide = async (assetId: string, fn: () => Promise<void>) => {
    setBusyId(assetId);
    setErrorById((prev) => ({ ...prev, [assetId]: '' }));
    try {
      await fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Action failed';
      setErrorById((prev) => ({ ...prev, [assetId]: msg }));
    } finally {
      setBusyId(null);
    }
  };

  if (!currentOrg) {
    return (
      <section className="animated-fade-in">
        <h1>Fixed Assets</h1>
        <p style={{ color: 'var(--text-muted)' }}>
          Pick an organisation to see its asset register.
        </p>
      </section>
    );
  }

  if (loading) {
    return (
      <section className="animated-fade-in">
        <h1>Fixed Assets</h1>
        <div style={{ marginTop: '1rem' }}>
          <SkeletonTable />
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section className="animated-fade-in">
        <h1>Fixed Assets</h1>
        <div
          className="badge badge-danger"
          style={{ display: 'block', padding: '0.75rem', textTransform: 'none', marginTop: '1rem' }}
        >
          {formatLoadError('fixed assets', error)}
        </div>
      </section>
    );
  }

  const totalCostBase = assets.reduce((sum, a) => sum + a.cost_base_cents, 0);

  return (
    <section
      className="animated-fade-in"
      style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}
    >
      <div>
        <PageHeader title={<><Boxes size={24} style={{ color: 'var(--text-link)' }} /> Fixed Assets</>} style={{ marginBottom: '0.25rem' }} />
        <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem', margin: 0 }}>
          {assets.length} asset{assets.length === 1 ? '' : 's'} on the register
          {assets.length > 0 && <> · {formatMoney(totalCostBase)} total cost base</>}
          {proposals.length > 0 && <> · {proposals.length} awaiting review</>}
        </p>
      </div>

      {/* Capitalisation proposals — machine-proposed assets (propose_capitalisation,
          0094) the classifier flagged as capital. A human confirms (proposed -> active,
          starts depreciation) or rejects (soft-delete). */}
      {proposals.length > 0 && (
        <div>
          <h2
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              fontSize: '1.05rem',
              marginBottom: '0.75rem',
            }}
          >
            <Sparkles size={18} style={{ color: 'var(--accent-warning)' }} />
            Capitalisation proposals
            <span className="badge badge-warning" style={{ fontSize: '11px' }}>
              {proposals.length}
            </span>
          </h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {proposals.map((p) => (
              <ProposalCard
                key={p.id}
                asset={p}
                schedule={scheduleByAsset.get(p.id)}
                busy={busyId === p.id}
                actionError={errorById[p.id]}
                onConfirm={() => decide(p.id, () => confirm(p.id))}
                onReject={() => decide(p.id, () => reject(p.id))}
              />
            ))}
          </div>
        </div>
      )}

      {/* Asset register — confirmed assets (active/disposed). Each row expands to its
          per-asset depreciation schedule. */}
      <div>
        {proposals.length > 0 && (
          <h2 style={{ fontSize: '1.05rem', marginBottom: '0.75rem' }}>Asset register</h2>
        )}
        {assets.length === 0 ? (
          <EmptyState icon={Boxes} title="No assets on the register yet.">
          Capital purchases the classifier detects appear above as proposals to confirm.
        </EmptyState>
        ) : (
          <div className="table-premium-container">
            <table className="table-premium">
              <thead>
                <tr>
                  <th style={{ width: '40px' }}></th>
                  <th>Asset</th>
                  <th>Acquired</th>
                  <th style={{ textAlign: 'right' }}>Cost base</th>
                  <th>Depreciation</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {assets.map((a) => {
                  const schedule = scheduleByAsset.get(a.id);
                  const isOpen = expanded.has(a.id);
                  return (
                    <Fragment key={a.id}>
                      <tr
                        style={{
                          borderBottom: '1px solid var(--border-subtle)',
                          cursor: 'pointer',
                        }}
                        onClick={() => toggle(a.id)}
                      >
                        <td style={{ textAlign: 'center' }}>
                          {isOpen ? (
                            <ChevronDown className="w-4 h-4 text-muted" />
                          ) : (
                            <ChevronRight className="w-4 h-4 text-muted" />
                          )}
                        </td>
                        <td>
                          <div style={{ fontWeight: 600, color: 'var(--text-title)' }}>
                            {a.name}
                          </div>
                          <div
                            style={{
                              fontSize: '0.75rem',
                              color: 'var(--text-muted)',
                              display: 'flex',
                              gap: '0.4rem',
                              alignItems: 'center',
                              marginTop: '0.15rem',
                            }}
                          >
                            {a.asset_account_code && <code>{a.asset_account_code}</code>}
                            {a.source_bill_id && (
                              <Link
                                to={`/bills/${a.source_bill_id}`}
                                onClick={(e) => e.stopPropagation()}
                                style={{ color: 'var(--text-link)', fontWeight: 600 }}
                              >
                                Source bill &rarr;
                              </Link>
                            )}
                          </div>
                        </td>
                        <td style={{ color: 'var(--text-muted)' }}>{a.acquisition_date}</td>
                        <td
                          style={{
                            textAlign: 'right',
                            fontWeight: 600,
                            color: 'var(--text-title)',
                          }}
                        >
                          {formatMoney(a.cost_base_cents)}
                        </td>
                        <td>{depreciationSummary(a, schedule)}</td>
                        <td>
                          <span
                            className={`badge ${statusBadgeClass(a.status)}`}
                            style={{ fontSize: '11px', textTransform: 'capitalize' }}
                          >
                            {a.status}
                          </span>
                        </td>
                      </tr>
                      {isOpen && (
                        <tr style={{ backgroundColor: 'var(--bg-hover)' }}>
                          <td></td>
                          <td colSpan={5} style={{ padding: '0.75rem 1rem' }}>
                            <ScheduleDetail asset={a} schedule={schedule} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

// The per-asset depreciation schedule, shown when a register row is expanded.
function ScheduleDetail({
  asset,
  schedule,
}: {
  asset: FixedAsset;
  schedule: DepreciationSchedule | undefined;
}) {
  if (!schedule) {
    return (
      <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
        {asset.instant_write_off
          ? 'Instant write-off — fully expensed on acquisition, no depreciation schedule.'
          : asset.pool_eligible
            ? 'Low-value pool — depreciated as part of the pool, no individual schedule.'
            : 'No depreciation schedule for this asset.'}
      </div>
    );
  }
  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.4rem',
          fontSize: '0.75rem',
          fontWeight: 700,
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          marginBottom: '0.5rem',
        }}
      >
        <TrendingDown size={14} />
        Depreciation schedule
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
          gap: '0.75rem 1.5rem',
        }}
      >
        <ScheduleField label="Method" value={methodLabel(schedule.method)} />
        <ScheduleField label="Effective life" value={`${schedule.effective_life_years} years`} />
        <ScheduleField label="Start date" value={schedule.start_date} />
        <ScheduleField
          label="Opening cost base"
          value={formatMoney(schedule.opening_cost_base_cents)}
        />
      </div>
    </div>
  );
}

function ScheduleField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{label}</div>
      <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-title)' }}>
        {value}
      </div>
    </div>
  );
}

function ProposalCard({
  asset,
  schedule,
  busy,
  actionError,
  onConfirm,
  onReject,
}: {
  asset: FixedAsset;
  schedule: DepreciationSchedule | undefined;
  busy: boolean;
  actionError: string | undefined;
  onConfirm: () => void;
  onReject: () => void;
}) {
  return (
    <div
      className="card"
      style={{
        padding: '1.25rem',
        borderLeft: '4px solid var(--accent-warning)',
        display: 'flex',
        flexWrap: 'wrap',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        gap: '1rem',
      }}
    >
      <div style={{ flex: 1, minWidth: '300px' }}>
        <div style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--text-title)' }}>
          {asset.name}
        </div>
        <div
          style={{
            fontSize: '0.8rem',
            color: 'var(--text-muted)',
            marginTop: '0.25rem',
            display: 'flex',
            flexWrap: 'wrap',
            gap: '0.5rem',
            alignItems: 'center',
          }}
        >
          <span style={{ fontWeight: 600, color: 'var(--text-body)' }}>
            {formatMoney(asset.cost_base_cents)}
          </span>
          <span>·</span>
          <span>Acquired {asset.acquisition_date}</span>
          {asset.asset_account_code && (
            <>
              <span>·</span>
              <code style={{ color: 'var(--text-link)', fontWeight: 600 }}>
                {asset.asset_account_code}
              </code>
            </>
          )}
        </div>
        <div style={{ fontSize: '0.8rem', color: 'var(--text-body)', marginTop: '0.5rem' }}>
          <span style={{ color: 'var(--text-muted)' }}>Proposed depreciation: </span>
          {depreciationSummary(asset, schedule)}
        </div>
        {asset.source_bill_id && (
          <Link
            to={`/bills/${asset.source_bill_id}`}
            style={{
              display: 'inline-block',
              marginTop: '0.5rem',
              color: 'var(--text-link)',
              fontSize: '0.75rem',
              fontWeight: 600,
            }}
          >
            View source bill &rarr;
          </Link>
        )}
        {actionError && (
          <div
            className="badge badge-danger"
            style={{
              display: 'block',
              marginTop: '0.5rem',
              padding: '0.4rem 0.6rem',
              textTransform: 'none',
              fontSize: '0.75rem',
            }}
          >
            {actionError}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: '0.35rem', flexShrink: 0 }}>
        <button
          onClick={onConfirm}
          disabled={busy}
          className="btn btn-primary"
          style={{
            padding: '0.35rem 0.75rem',
            fontSize: '0.75rem',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.25rem',
          }}
        >
          <CheckCircle2 size={14} /> {busy ? 'Working…' : 'Confirm'}
        </button>
        <button
          onClick={onReject}
          disabled={busy}
          className="btn btn-secondary"
          style={{
            padding: '0.35rem 0.75rem',
            fontSize: '0.75rem',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.25rem',
          }}
        >
          <X size={14} /> Reject
        </button>
      </div>
    </div>
  );
}
