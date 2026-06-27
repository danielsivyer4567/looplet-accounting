import type { CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { useOrg } from '@/hooks/useOrg';
import { useSmsf, type SmsfFundRow, type SmsfMemberRow } from '@/hooks/useSmsf';
import { SkeletonTable } from '@/components/Skeleton';
import { titleCase, formatDay } from '@/lib/formatting';
import { formatMoney } from '@/lib/money';
import { PiggyBank } from 'lucide-react';

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

/** One fund card: the fund's details + its members with recorded balances. */
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
          <h2 style={{ margin: 0, fontSize: '1.05rem', color: 'var(--text-title)' }}>{fund.name}</h2>
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
        <div style={{ ...noticeCardStyle, padding: '1.5rem' }}>No members recorded for this fund yet.</div>
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
                    <span className="badge badge-neutral" style={{ fontSize: '11px', textTransform: 'none' }}>
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
          The SMSF workspace applies to self-managed super funds. Set this organisation's entity type to{' '}
          <strong>SMSF</strong> in{' '}
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
          Failed to load: {error}
        </div>
      ) : funds.length === 0 ? (
        <div style={noticeCardStyle}>No SMSF recorded for {currentOrg.name} yet.</div>
      ) : (
        funds.map((fund) => <FundCard key={fund.id} fund={fund} members={members} />)
      )}
    </section>
  );
}
