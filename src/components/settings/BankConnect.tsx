import { Fragment, useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';
import { enqueueJob } from '@/lib/automationJobs';
import { formatLoadError, formatActionError } from '@/lib/errorMessages';
import { formatMoney } from '@/lib/money';
import { SkeletonTable } from '@/components/Skeleton';
import { BankCsvImport } from './BankCsvImport';
import { BankFeedLink } from './BankFeedLink';
import { BankStatementImport } from './BankStatementImport';

interface BankConnectionRow {
  id: string;
  provider: 'manual' | 'redbark' | 'plaid';
  institution_name: string | null;
  status: 'pending' | 'active' | 'error' | 'expired' | 'revoked';
  last_synced_at: string | null;
  last_error: string | null;
  metadata: Record<string, unknown>;
}

interface BankAccountRow {
  id: string;
  bank_connection_id: string;
  name: string;
  account_number_last4: string | null;
  bsb: string | null;
  account_type: 'checking' | 'savings' | 'credit_card' | 'loan' | 'investment' | 'other';
  current_balance_cents: number | null;
  available_balance_cents: number | null;
  currency_code: string;
  is_primary: boolean;
  is_active: boolean;
  updated_at: string | null;
}

export function BankConnect() {
  const { currentOrg } = useOrg();
  const [connections, setConnections] = useState<BankConnectionRow[]>([]);
  const [accountsByConnectionId, setAccountsByConnectionId] = useState<
    Record<string, BankAccountRow[]>
  >({});
  const [loading, setLoading] = useState(false);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [disablingId, setDisablingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Distinct from action `error`: a failed load must not masquerade as
  // "no bank connected yet" (which would hide the failure behind the connect CTA).
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);
    setLoadError(null);
    const [connectionResult, accountResult] = await Promise.all([
      supabase
        .from('bank_connections')
        .select('id, provider, institution_name, status, last_synced_at, last_error, metadata')
        .eq('organization_id', currentOrg.id)
        .order('created_at', { ascending: false }),
      supabase
        .from('bank_accounts')
        .select(
          'id, bank_connection_id, name, account_number_last4, bsb, account_type, current_balance_cents, available_balance_cents, currency_code, is_primary, is_active, updated_at',
        )
        .eq('organization_id', currentOrg.id)
        .order('is_primary', { ascending: false })
        .order('name', { ascending: true }),
    ]);

    const loadErr = connectionResult.error ?? accountResult.error;
    if (loadErr) {
      setLoadError(formatLoadError('bank connections', loadErr.message));
      setConnections([]);
      setAccountsByConnectionId({});
      setLoading(false);
      return;
    }

    setConnections((connectionResult.data ?? []) as BankConnectionRow[]);

    const accounts = (accountResult.data ?? []) as BankAccountRow[];
    const grouped = accounts.reduce<Record<string, BankAccountRow[]>>((acc, account) => {
      const bucket = acc[account.bank_connection_id] ?? [];
      bucket.push(account);
      acc[account.bank_connection_id] = bucket;
      return acc;
    }, {});
    setAccountsByConnectionId(grouped);
    setLoading(false);
  }, [currentOrg]);

  useEffect(() => void refresh(), [refresh]);

  if (!currentOrg) return null;

  const handleSync = async (id: string) => {
    setError(null);
    setSyncingId(id);
    try {
      await enqueueJob({
        organizationId: currentOrg.id,
        jobKind: 'bank_sync',
        sourceKind: 'bank_connection',
        sourceId: id,
        priority: 3,
        payload: { bank_connection_id: id, source: 'manual_bank_sync' },
      });
      await refresh();
    } catch (e) {
      setError(
        formatActionError('queue the bank sync', e instanceof Error ? e.message : String(e)),
      );
    } finally {
      setSyncingId(null);
    }
  };

  const handleDisable = async (connection: BankConnectionRow) => {
    const ok = window.confirm(
      `Stop the bank feed for ${connection.institution_name ?? 'this bank connection'}? Looplet stops importing from it and keeps the transactions already imported. Your bank connection in Redbark is not changed; manage or remove it in your Redbark account. To start the feed again, link its accounts again.`,
    );
    if (!ok) return;

    setError(null);
    setDisablingId(connection.id);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in');

      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/bank-disconnect`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          organization_id: currentOrg.id,
          bank_connection_id: connection.id,
        }),
      });
      const resBody = await res.json();
      if (!res.ok || !resBody.ok) throw new Error(resBody.error ?? `${res.status}`);

      await refresh();
    } catch (e) {
      setError(
        formatActionError('disable this bank feed', e instanceof Error ? e.message : String(e)),
      );
    } finally {
      setDisablingId(null);
    }
  };

  return (
    <div style={{ marginTop: '2rem' }}>
      <h2 style={{ fontSize: 18, marginBottom: '0.5rem' }}>Bank accounts</h2>
      <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: '1rem', maxWidth: 720 }}>
        Link your business bank accounts through a Redbark bank feed, or import CSV and PDF
        statements. Transactions are matched against your bills and invoices, ready for you to
        review and reconcile on the Reconciliation page.{' '}
        <Link to="/data-sharing">How your data is shared and managed</Link>.
      </p>

      {loading ? (
        <div aria-busy="true" aria-label="Loading bank connections">
          <SkeletonTable rows={3} cols={5} />
        </div>
      ) : loadError ? (
        <div
          role="alert"
          style={{
            padding: '0.75rem',
            background: 'var(--bg-danger-subtle)',
            color: 'var(--text-danger)',
            borderRadius: 4,
            fontSize: 13,
          }}
        >
          {loadError}
        </div>
      ) : connections.length === 0 ? (
        <div>
          <BankFeedLink organizationId={currentOrg.id} onLinked={refresh} />
          <BankCsvImport onImported={refresh} />
          <BankStatementImport onImported={refresh} />
        </div>
      ) : (
        <>
          <table
            className="settings-responsive-table"
            style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}
          >
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                <th style={th}>Bank</th>
                <th style={th}>Provider</th>
                <th style={th}>Status</th>
                <th style={th}>Last sync</th>
                <th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {connections.map((c) => (
                <Fragment key={c.id}>
                  <tr style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                    <td style={td}>{c.institution_name ?? '—'}</td>
                    <td style={td}>
                      <code style={{ color: 'var(--text-muted)', fontSize: 11 }}>{c.provider}</code>
                    </td>
                    <td style={td}>
                      <BankConnectionStatus connection={c} />
                    </td>
                    <td style={td}>
                      {c.last_synced_at?.slice(0, 16).replace('T', ' ') ?? 'never'}
                    </td>
                    <td style={td}>
                      <BankConnectionAction
                        connection={c}
                        syncingId={syncingId}
                        disablingId={disablingId}
                        onSync={handleSync}
                        onDisable={handleDisable}
                      />
                    </td>
                  </tr>
                  <tr>
                    <td colSpan={5} style={{ ...td, paddingTop: 0 }}>
                      <BankAccountDetails accounts={accountsByConnectionId[c.id] ?? []} />
                    </td>
                  </tr>
                </Fragment>
              ))}
            </tbody>
          </table>

          <div className="settings-card-view" aria-label="Bank connections mobile cards">
            {connections.map((c) => (
              <div key={c.id} className="settings-mobile-card">
                <div className="settings-mobile-card__header">
                  <strong>{c.institution_name ?? 'Bank connection'}</strong>
                  <BankConnectionStatus connection={c} />
                </div>
                <div className="settings-mobile-card__row">
                  <span>Provider</span>
                  <strong>{c.provider}</strong>
                </div>
                <div className="settings-mobile-card__row">
                  <span>Last sync</span>
                  <strong>{c.last_synced_at?.slice(0, 16).replace('T', ' ') ?? 'never'}</strong>
                </div>
                <BankConnectionAction
                  connection={c}
                  syncingId={syncingId}
                  disablingId={disablingId}
                  onSync={handleSync}
                  onDisable={handleDisable}
                />
                <BankAccountDetails accounts={accountsByConnectionId[c.id] ?? []} compact />
              </div>
            ))}
          </div>

          <BankFeedLink organizationId={currentOrg.id} onLinked={refresh} />
          <BankCsvImport onImported={refresh} />
          <BankStatementImport onImported={refresh} />
        </>
      )}

      {error && (
        <p style={{ color: 'var(--text-danger)', fontSize: 12, marginTop: '0.5rem' }}>{error}</p>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: BankConnectionRow['status'] }) {
  const colour =
    status === 'active'
      ? '#86c7a3'
      : status === 'expired' || status === 'revoked'
        ? '#e9a3a3'
        : status === 'error'
          ? '#e9a3a3'
          : '#888';
  return (
    <span
      style={{
        padding: '0.15rem 0.5rem',
        fontSize: 11,
        borderRadius: 3,
        background: 'var(--bg-hover)',
        color: colour,
        textTransform: 'uppercase',
      }}
    >
      {status}
    </span>
  );
}

function BankConnectionStatus({ connection }: { connection: BankConnectionRow }) {
  return (
    <>
      <StatusPill status={connection.status} />
      {connection.last_error && (
        <div style={{ color: 'var(--text-danger)', fontSize: 10, marginTop: 4 }}>{connection.last_error}</div>
      )}
    </>
  );
}

function BankConnectionAction({
  connection,
  syncingId,
  disablingId,
  onSync,
  onDisable,
}: {
  connection: BankConnectionRow;
  syncingId: string | null;
  disablingId?: string | null;
  onSync: (id: string) => Promise<void>;
  onDisable?: (connection: BankConnectionRow) => Promise<void>;
}) {
  if (connection.provider === 'redbark') {
    return (
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        <button
          onClick={() => void onSync(connection.id)}
          disabled={syncingId === connection.id || connection.status !== 'active'}
          style={smallBtn}
        >
          {syncingId === connection.id ? 'Queueing…' : '↻ Sync'}
        </button>
        {onDisable && connection.status === 'active' && (
          <button
            onClick={() => void onDisable(connection)}
            disabled={disablingId === connection.id}
            style={dangerBtn}
          >
            {disablingId === connection.id ? 'Stopping…' : 'Disable feed'}
          </button>
        )}
      </div>
    );
  }

  return (
    <span
      style={{ color: 'var(--text-muted)', fontSize: 11, fontStyle: 'italic' }}
      title="Imported from a CSV or PDF statement, not a live bank feed. Link a Redbark account above for automatic imports."
    >
      imported (no live feed)
    </span>
  );
}

function BankAccountDetails({
  accounts,
  compact = false,
}: {
  accounts: BankAccountRow[];
  compact?: boolean;
}) {
  if (accounts.length === 0) {
    return <div style={accountEmpty}>No account details imported yet.</div>;
  }

  return (
    <div style={compact ? accountListCompact : accountList} aria-label="Linked bank accounts">
      {accounts.map((account) => (
        <div key={account.id} style={accountCard}>
          <div
            style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}
          >
            <strong>{account.name}</strong>
            <span style={{ color: account.is_active ? '#86c7a3' : '#aaa', fontSize: 11 }}>
              {account.is_active ? 'active' : 'inactive'}
              {account.is_primary ? ' · primary' : ''}
            </span>
          </div>
          <div style={accountMeta}>
            <span>{account.account_type.replace('_', ' ')}</span>
            {account.bsb && <span>BSB {account.bsb}</span>}
            {account.account_number_last4 && <span>•••• {account.account_number_last4}</span>}
            <span>{account.currency_code}</span>
          </div>
          <div style={accountBalances}>
            <span>Balance {formatMoney(account.current_balance_cents)}</span>
            <span>Available {formatMoney(account.available_balance_cents)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

const th: React.CSSProperties = {
  padding: '0.4rem 0.5rem',
  textAlign: 'left',
  fontSize: 11,
  color: 'var(--text-muted)',
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  fontWeight: 500,
};
const td: React.CSSProperties = { padding: '0.5rem' };
const smallBtn: React.CSSProperties = {
  background: 'transparent',
  color: 'var(--text-muted)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 3,
  fontSize: 11,
  padding: '0.2rem 0.5rem',
  cursor: 'pointer',
};
const dangerBtn: React.CSSProperties = {
  ...smallBtn,
  color: 'var(--text-danger)',
  borderColor: 'var(--accent-danger)',
};
const accountEmpty: React.CSSProperties = {
  color: 'var(--text-muted)',
  fontSize: 11,
  padding: '0.4rem 0.6rem',
  borderLeft: '2px solid var(--border-subtle)',
};
const accountList: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
  gap: 8,
  padding: '0.35rem 0 0.55rem',
};
const accountListCompact: React.CSSProperties = {
  ...accountList,
  gridTemplateColumns: '1fr',
  paddingTop: 8,
};
const accountCard: React.CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 4,
  padding: '0.55rem 0.65rem',
  background: 'var(--bg-panel)',
};
const accountMeta: React.CSSProperties = {
  display: 'flex',
  gap: 10,
  flexWrap: 'wrap',
  color: 'var(--text-muted)',
  fontSize: 11,
  marginTop: 4,
  textTransform: 'capitalize',
};
const accountBalances: React.CSSProperties = {
  display: 'flex',
  gap: 14,
  flexWrap: 'wrap',
  color: 'var(--text-body)',
  fontSize: 12,
  marginTop: 6,
};
