import type { CSSProperties } from 'react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useOrg } from '@/hooks/useOrg';
import { useSmsf, useSmsfFund, type SmsfFundRow, type SmsfMemberRow } from '@/hooks/useSmsf';
import { SkeletonTable } from '@/components/Skeleton';
import { titleCase, formatDay, currentFyStartYear } from '@/lib/formatting';
import { formatLoadError } from '@/lib/errorMessages';
import { formatMoney } from '@/lib/money';
import { AlertTriangle, CheckCircle2, Download, FileText, PiggyBank } from 'lucide-react';

// Shared styling for the page's dashed "notice" cards (not-an-SMSF gate + empty list).
const noticeCardStyle: CSSProperties = {
  padding: '2.5rem',
  background: 'var(--bg-card)',
  border: '1px dashed var(--border-subtle)',
  borderRadius: 'var(--radius-md)',
  color: 'var(--text-muted)',
  textAlign: 'center',
  fontSize: '0.9rem',
};

// A labelled figure for the financials strip.
function Stat({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div style={{ minWidth: '8rem' }}>
      <div
        style={{
          fontSize: '0.7rem',
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.03em',
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: '1rem',
          fontWeight: 600,
          color: strong ? 'var(--text-title)' : 'var(--text-body)',
        }}
      >
        {value}
      </div>
    </div>
  );
}

// A compliance flag chip: green when count is 0, amber when there's something to review.
function FlagChip({ label, count }: { label: string; count: number }) {
  const clear = count === 0;
  return (
    <span
      className={`badge ${clear ? 'badge-success' : 'badge-warning'}`}
      style={{
        fontSize: '11px',
        textTransform: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.3rem',
      }}
    >
      {clear ? <CheckCircle2 size={12} /> : <AlertTriangle size={12} />}
      {label}: {count}
    </span>
  );
}

/**
 * The per-fund panels (SC-5.N.02): financials (5.J), cap/Div293/drawdown flags (5.L), TBC
 * tracker (5.I.02), and the audit-pack (5.M) + return-draft (5.K) download actions + a
 * mark-lodged stub. The SMSF RPCs + edge fn deploy as a batch; until then the panel surfaces
 * the error (the data won't load against undeployed functions — by design, not a UI fault).
 */
function FundPanels({ fundId }: { fundId: string }) {
  const fy = currentFyStartYear();
  const { panels, loading, error, actionBusy, downloadAuditPack, downloadReturnDraft, markLodged } =
    useSmsfFund(fundId, fy);
  const [lodgeNote, setLodgeNote] = useState<string | null>(null);

  const { operating, financial, caps, drawdown, tbc } = panels;

  return (
    <div
      style={{
        marginTop: '1.25rem',
        borderTop: '1px solid var(--border-subtle)',
        paddingTop: '1rem',
      }}
    >
      <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
        Financials &amp; compliance — income year ended 30 June {fy + 1}
      </div>

      {loading ? (
        <SkeletonTable rows={2} cols={4} />
      ) : error ? (
        // Don't render zero figures / green "all clear" flags when the data didn't load — that
        // would masquerade as "compliant" when the truth is "unknown". Show the gap honestly.
        <div
          className="badge badge-warning"
          style={{ display: 'block', padding: '0.75rem', textTransform: 'none' }}
        >
          Financials and compliance figures are unavailable for this fund right now: {error}
        </div>
      ) : (
        <>
          {/* Financials strip (SC-5.J.01/.02) */}
          <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
            <Stat
              label="Assessable income"
              value={formatMoney(operating?.assessable_income_cents ?? 0)}
            />
            <Stat label="Income tax" value={formatMoney(operating?.income_tax_cents ?? 0)} />
            <Stat label="Net result" value={formatMoney(operating?.net_result_cents ?? 0)} />
            <Stat
              label="Total assets"
              value={formatMoney(financial?.assets?.total_assets_cents ?? 0)}
            />
            <Stat
              label="Members' funds"
              value={formatMoney(financial?.members_funds_cents ?? 0)}
              strong
            />
          </div>

          {/* Compliance flags (SC-5.L.01/.02) */}
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
            <FlagChip
              label="Over concessional cap"
              count={caps?.totals?.members_over_concessional ?? 0}
            />
            <FlagChip
              label="Over non-concessional cap"
              count={caps?.totals?.members_over_non_concessional ?? 0}
            />
            <FlagChip label="Div 293" count={caps?.totals?.members_div293 ?? 0} />
            <FlagChip
              label="Pensions under minimum"
              count={drawdown?.totals?.under_minimum_count ?? 0}
            />
          </div>

          {/* TBC tracker (SC-5.I.02) */}
          {tbc && tbc.members?.length > 0 && (
            <div style={{ marginBottom: '1rem' }}>
              <div
                style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.4rem' }}
              >
                Transfer balance cap ({formatMoney(tbc.tbc_cents)} per member)
              </div>
              <div className="table-premium-container">
                <table className="table-premium">
                  <thead>
                    <tr>
                      <th>Member</th>
                      <th style={{ textAlign: 'right' }}>TBA balance</th>
                      <th style={{ textAlign: 'right' }}>Available cap</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tbc.members.map((m) => (
                      <tr key={m.member_id}>
                        <td>{m.name}</td>
                        <td style={{ textAlign: 'right' }}>{formatMoney(m.tba_balance_cents)}</td>
                        <td style={{ textAlign: 'right' }}>{formatMoney(m.available_cap_cents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Actions (SC-5.M / 5.K + the lodge stub) */}
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <button
              className="btn btn-secondary"
              disabled={actionBusy !== null}
              onClick={() => void downloadReturnDraft()}
            >
              <FileText size={14} />{' '}
              {actionBusy === 'return' ? 'Preparing…' : 'Annual return draft'}
            </button>
            <button
              className="btn btn-secondary"
              disabled={actionBusy !== null}
              onClick={() => void downloadAuditPack()}
            >
              <Download size={14} /> {actionBusy === 'audit' ? 'Preparing…' : 'Audit pack'}
            </button>
            <button
              className="btn btn-secondary"
              disabled={actionBusy !== null}
              onClick={() => setLodgeNote(markLodged())}
              title="Lodgement is gated by the ATO gateway (Phase 7)"
            >
              Lodge return
            </button>
            {lodgeNote && (
              <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{lodgeNote}</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** One fund card: the fund's details + its members with recorded balances + the panels. */
function FundCard({ fund, members }: { fund: SmsfFundRow; members: SmsfMemberRow[] }) {
  const fundMembers = members.filter((m) => m.fund_id === fund.id);

  return (
    <div
      style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-md)',
        padding: '1.25rem',
        marginBottom: '1.25rem',
      }}
    >
      {/* Fund header */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          flexWrap: 'wrap',
          gap: '0.5rem',
          marginBottom: '1rem',
        }}
      >
        <div>
          <h2 style={{ margin: 0, fontSize: '1.05rem', color: 'var(--text-title)' }}>
            {fund.name}
          </h2>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
            {fund.abn ? <code>{fund.abn}</code> : <span>ABN not recorded</span>}
            {' · '}
            {titleCase(fund.trustee_structure)} trustee
            {fund.establishment_date ? ` · est. ${formatDay(fund.establishment_date)}` : ''}
          </div>
        </div>
        <span className="badge badge-neutral" style={{ fontSize: '11px', textTransform: 'none' }}>
          {fundMembers.length} {fundMembers.length === 1 ? 'member' : 'members'}
        </span>
      </div>

      {/* Members */}
      {fundMembers.length === 0 ? (
        <div style={{ ...noticeCardStyle, padding: '1.5rem' }}>
          No members recorded for this fund yet.
        </div>
      ) : (
        <div className="table-premium-container">
          <table className="table-premium">
            <thead>
              <tr>
                <th>Member</th>
                <th>Role</th>
                <th style={{ textAlign: 'right' }}>Tax-free</th>
                <th style={{ textAlign: 'right' }}>Taxable</th>
                <th style={{ textAlign: 'right' }}>Balance</th>
              </tr>
            </thead>
            <tbody>
              {fundMembers.map((m) => (
                <tr key={m.id}>
                  <td style={{ fontWeight: 600, color: 'var(--text-title)' }}>{m.name}</td>
                  <td>
                    <span
                      className="badge badge-neutral"
                      style={{ fontSize: '11px', textTransform: 'none' }}
                    >
                      {titleCase(m.role)}
                    </span>
                  </td>
                  <td style={{ textAlign: 'right' }}>{formatMoney(m.tax_free_component_cents)}</td>
                  <td style={{ textAlign: 'right' }}>{formatMoney(m.taxable_component_cents)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--text-title)' }}>
                    {formatMoney(m.tax_free_component_cents + m.taxable_component_cents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Financials, compliance flags, TBC tracker, and the return/audit/lodge actions. */}
      <FundPanels fundId={fund.id} />
    </div>
  );
}

export function SmsfPage() {
  const navigate = useNavigate();
  const { currentOrg } = useOrg();
  const { funds, members, isSmsfEntity, loading, error } = useSmsf();

  if (!currentOrg) return null;

  // The SMSF workspace is only relevant when the org is an SMSF entity
  // (business_profile.entity_type = 'smsf'). Show a gentle notice otherwise.
  if (!loading && !isSmsfEntity) {
    return (
      <section className="animated-fade-in">
        <h1 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <PiggyBank size={24} style={{ color: 'var(--accent-primary)' }} />
          SMSF
        </h1>
        <div style={{ ...noticeCardStyle, marginTop: '1.5rem' }}>
          The SMSF workspace applies to self-managed super funds. Set this organisation's entity
          type to <strong>SMSF</strong> in{' '}
          <span
            style={{ color: 'var(--accent-primary)', cursor: 'pointer' }}
            onClick={() => navigate('/settings')}
          >
            Business Profile
          </span>{' '}
          to manage the fund, members, financials, and the annual return.
        </div>
      </section>
    );
  }

  return (
    <section className="animated-fade-in">
      {/* Header */}
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
          <PiggyBank size={24} style={{ color: 'var(--accent-primary)' }} />
          SMSF
        </h1>
        {!loading && (
          <div
            className="badge badge-neutral"
            style={{ padding: '0.4rem 0.75rem', fontSize: '0.8rem', textTransform: 'none' }}
          >
            {funds.length} {funds.length === 1 ? 'fund' : 'funds'}
          </div>
        )}
      </div>

      {loading ? (
        <SkeletonTable rows={4} cols={5} />
      ) : error ? (
        <div
          className="badge badge-danger"
          style={{ display: 'block', padding: '0.75rem', textTransform: 'none' }}
        >
          {formatLoadError('SMSF funds', error)}
        </div>
      ) : funds.length === 0 ? (
        <div style={noticeCardStyle}>No SMSF recorded for {currentOrg.name} yet.</div>
      ) : (
        funds.map((fund) => <FundCard key={fund.id} fund={fund} members={members} />)
      )}
    </section>
  );
}
