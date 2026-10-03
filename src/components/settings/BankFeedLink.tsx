import { useState } from 'react';
import { supabase } from '@/lib/supabase';
import { enqueueJob } from '@/lib/automationJobs';
import { formatActionError, formatLoadError } from '@/lib/errorMessages';
import { SkeletonTable } from '@/components/Skeleton';
import { defaultImportFrom, todayAest } from '@/lib/bankFeedDates';

// Lists the accounts on the server's Redbark login (bank-feed-accounts) and links each one to this organisation with
// an import-from date (bank-feed-link). Both functions need an admin or owner of an organisation allowed to use the
// feed; anyone else sees the server's refusal. Linking queues the first import; it does not import anything itself.

export interface FeedAccountView {
  account_id: string;
  connection_id: string;
  name: string;
  institution: string | null;
  account_last4: string | null;
  account_type: string | null;
  currency: string | null;
  status: 'linked' | 'available' | 'linked_elsewhere' | 'not_aud';
  link: {
    bank_connection_id: string;
    bank_account_id: string;
    sync_from: string | null;
    covered_through: string | null;
  } | null;
}

interface LinkResponse {
  bank_connection_id: string;
  bank_account_id: string;
  sync_from: string;
}

const EARLIEST_IMPORT_FROM = '2000-01-01';

/** A refusal the function explained itself (4xx), shown in its own words rather than as a connection failure. */
class FunctionRefusal extends Error {}

function describeError(action: string, e: unknown, format: (action: string, detail: string) => string): string {
  if (e instanceof FunctionRefusal) return `Could not ${action}: ${e.message}`;
  return format(action, e instanceof Error ? e.message : String(e));
}

async function callFunction<T>(name: string, body: Record<string, unknown>): Promise<T> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new Error('Not signed in');
  const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string } & T;
  if (res.status >= 400 && res.status < 500 && json.error) throw new FunctionRefusal(json.error);
  if (!res.ok || !json.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

export function BankFeedLink({
  organizationId,
  onLinked,
}: {
  organizationId: string;
  onLinked?: () => void | Promise<void>;
}) {
  const [accounts, setAccounts] = useState<FeedAccountView[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dates, setDates] = useState<Record<string, string>>({});
  const [linkingId, setLinkingId] = useState<string | null>(null);
  const today = todayAest();

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await callFunction<{ accounts: FeedAccountView[] }>('bank-feed-accounts', {
        organization_id: organizationId,
      });
      setAccounts(result.accounts);
    } catch (e) {
      setError(describeError('load Redbark accounts', e, (_action, detail) => formatLoadError('Redbark accounts', detail)));
    } finally {
      setLoading(false);
    }
  };

  const link = async (account: FeedAccountView) => {
    const syncFrom = dates[account.account_id] ?? defaultImportFrom();
    setLinkingId(account.account_id);
    setError(null);
    setNotice(null);
    try {
      const result = await callFunction<LinkResponse>('bank-feed-link', {
        organization_id: organizationId,
        connection_id: account.connection_id,
        account_id: account.account_id,
        sync_from: syncFrom,
      });
      try {
        await enqueueJob({
          organizationId,
          jobKind: 'bank_sync',
          sourceKind: 'bank_connection',
          sourceId: result.bank_connection_id,
          priority: 3,
          payload: { bank_connection_id: result.bank_connection_id, source: 'bank_feed_link' },
        });
        setNotice(
          `Linked ${account.name}. Its first import, from ${result.sync_from}, is queued; transactions appear once it has run.`,
        );
      } catch (e) {
        setNotice(
          `Linked ${account.name}, but its first import could not be queued (${e instanceof Error ? e.message : String(e)}). Use Sync on the connection to start it.`,
        );
      }
      await load();
      await onLinked?.();
    } catch (e) {
      setError(describeError(`link ${account.name}`, e, formatActionError));
    } finally {
      setLinkingId(null);
    }
  };

  return (
    <section aria-labelledby="bank-feed-heading" style={panel}>
      <h3 id="bank-feed-heading" style={{ fontSize: 14, margin: 0 }}>
        Bank feed (Redbark)
      </h3>
      <p style={muted}>
        Link accounts from the Redbark login set up for this business. Looplet imports posted
        transactions dated on or after the date you choose; pending transactions are left until
        they post. Only admins and owners can link accounts.
      </p>

      {accounts === null && !loading && (
        <button type="button" onClick={() => void load()} style={primaryBtn}>
          Show Redbark accounts
        </button>
      )}

      {loading && (
        <div aria-busy="true" aria-label="Loading Redbark accounts">
          <SkeletonTable rows={2} cols={3} />
        </div>
      )}

      {error && (
        <div role="alert" style={alertBox}>
          {error}
        </div>
      )}
      {notice && (
        <div role="status" style={noticeBox}>
          {notice}
        </div>
      )}

      {accounts && !loading && accounts.length === 0 && (
        <p style={muted}>
          Redbark lists no accounts on an active banking connection. Connect your bank in Redbark
          first, then show the accounts again.
        </p>
      )}

      {accounts && !loading && accounts.length > 0 && (
        <ul aria-label="Redbark accounts" style={list}>
          {accounts.map((account) => {
            const inputId = `import-from-${account.account_id}`;
            const label = [account.institution, account.name].filter(Boolean).join(' · ');
            return (
              <li key={account.account_id} style={card}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                  <strong>{label}</strong>
                  {account.account_last4 && <span style={muted}>•••• {account.account_last4}</span>}
                </div>
                <FeedAccountState
                  account={account}
                  inputId={inputId}
                  value={dates[account.account_id] ?? defaultImportFrom()}
                  max={today}
                  linking={linkingId === account.account_id}
                  disabled={linkingId !== null}
                  onDate={(value) => setDates((prev) => ({ ...prev, [account.account_id]: value }))}
                  onLink={() => void link(account)}
                />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function FeedAccountState({
  account,
  inputId,
  value,
  max,
  linking,
  disabled,
  onDate,
  onLink,
}: {
  account: FeedAccountView;
  inputId: string;
  value: string;
  max: string;
  linking: boolean;
  disabled: boolean;
  onDate: (value: string) => void;
  onLink: () => void;
}) {
  if (account.status === 'linked' && account.link) {
    const progress = account.link.covered_through
      ? `history imported through ${account.link.covered_through}`
      : 'first import not finished yet';
    return (
      <p style={statusLine}>
        Linked · importing from {account.link.sync_from ?? 'its import-from date'} · {progress}
      </p>
    );
  }
  if (account.status === 'linked_elsewhere') {
    return <p style={statusLine}>Linked to another organisation, so it cannot be linked here.</p>;
  }
  if (account.status === 'not_aud') {
    return <p style={statusLine}>Not an Australian dollar account, so it cannot be linked.</p>;
  }
  return (
    <div style={{ display: 'grid', gap: 6, marginTop: 6 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <label htmlFor={inputId} style={{ fontSize: 12 }}>
          Import from
        </label>
        <input
          id={inputId}
          type="date"
          value={value}
          min={EARLIEST_IMPORT_FROM}
          max={max}
          onChange={(e) => onDate(e.target.value)}
          style={dateInput}
        />
        <button
          type="button"
          onClick={onLink}
          disabled={disabled || !value}
          aria-label={`Link ${account.name}`}
          style={primaryBtn}
        >
          {linking ? 'Linking…' : 'Link'}
        </button>
      </div>
      <p style={{ ...muted, margin: 0 }}>
        If you have already imported statements for this account, choose the day after the last
        one so nothing is imported twice.
      </p>
    </div>
  );
}

const panel: React.CSSProperties = {
  display: 'grid',
  gap: 8,
  border: '1px solid var(--border-subtle)',
  borderRadius: 4,
  padding: '0.75rem',
  margin: '1rem 0',
  background: 'var(--bg-panel)',
  maxWidth: 720,
};
const muted: React.CSSProperties = { color: 'var(--text-muted)', fontSize: 12, margin: 0 };
const statusLine: React.CSSProperties = { color: 'var(--text-body)', fontSize: 12, margin: '6px 0 0' };
const list: React.CSSProperties = { listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 };
const card: React.CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 4,
  padding: '0.55rem 0.65rem',
};
const primaryBtn: React.CSSProperties = {
  justifySelf: 'start',
  padding: '0.35rem 0.9rem',
  background: 'var(--bg-info-subtle)',
  color: 'var(--text-title)',
  border: '1px solid var(--accent-info)',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 600,
};
const dateInput: React.CSSProperties = {
  fontSize: 12,
  padding: '0.2rem 0.4rem',
  border: '1px solid var(--border-subtle)',
  borderRadius: 3,
  background: 'var(--bg-panel)',
  color: 'var(--text-body)',
};
const alertBox: React.CSSProperties = {
  padding: '0.6rem',
  background: 'var(--bg-danger-subtle)',
  color: 'var(--text-danger)',
  borderRadius: 4,
  fontSize: 12,
};
const noticeBox: React.CSSProperties = {
  padding: '0.6rem',
  background: 'var(--bg-info-subtle)',
  color: 'var(--text-body)',
  borderRadius: 4,
  fontSize: 12,
};
