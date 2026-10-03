import { useState } from 'react';
import { supabase } from '@/lib/supabase';
import { rememberOAuthState } from '@/lib/oauthState';
import { useOrg } from '@/hooks/useOrg';
import { useGmailIntegrations } from '@/hooks/useGmailIntegrations';
import { SkeletonTable } from '@/components/Skeleton';

interface GmailConnectProps {
  title?: string;
  description?: string;
  connectLabel?: string;
  reconnectLabel?: string;
  showContainerSpacing?: boolean;
}

export function GmailConnect({
  title = 'Gmail intake',
  description = 'Connect a mailbox so supplier invoices arrive automatically. We watch the INBOX label only and pull PDF / image attachments. You can list specific senders below to filter further.',
  connectLabel = '+ Connect Gmail',
  reconnectLabel = 'Reconnect',
  showContainerSpacing = true,
}: GmailConnectProps) {
  const { currentOrg } = useOrg();
  const { integrations, loading, refresh } = useGmailIntegrations();
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [backfilling, setBackfilling] = useState<string | null>(null);
  const [backfillStatus, setBackfillStatus] = useState<string>('');

  if (!currentOrg) return null;

  // Starts the Google OAuth flow. Used both for the first connect and to
  // reconnect a mailbox whose grant was revoked/expired: the OAuth callback
  // upserts on (organization_id, gmail_address) and flips is_active back to
  // true + clears last_error, so reconnecting the SAME mailbox revives the
  // disabled row in place (no duplicate, no orphaned bills).
  const handleConnect = async () => {
    setError(null);
    setConnecting(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in');

      const redirect_uri = `${window.location.origin}/settings/gmail-callback`;
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/gmail-oauth-start`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ organization_id: currentOrg.id, redirect_uri }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) throw new Error(body.error ?? `${res.status}`);

      // The callback page only finishes a connection whose state this tab stored.
      rememberOAuthState('gmail_oauth_state', body.state);
      window.location.href = body.url;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setConnecting(false);
    }
  };

  const handleDisconnect = async (id: string, gmail: string) => {
    if (!confirm(`Disconnect ${gmail}? Already-imported bills are kept.`)) return;
    await supabase.from('gmail_integrations').update({ is_active: false }).eq('id', id);
    await refresh();
  };

  const handleBackfill = async (id: string, gmail: string) => {
    if (
      !confirm(
        `Scan last 6 months of ${gmail} for invoices? Each PDF/image attachment becomes a bill and runs OCR.`,
      )
    )
      return;
    setBackfilling(id);
    setBackfillStatus('Starting…');
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in');
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/gmail-backfill`;

      interface BackfillResp {
        ok: boolean;
        error?: string;
        stats: {
          fetched: number;
          bills_created: number;
          duplicates_skipped: number;
          rejected: number;
          errors: number;
        };
        next_page_token: string | null;
      }

      let pageToken: string | null | undefined = undefined;
      const totals = {
        fetched: 0,
        bills_created: 0,
        duplicates_skipped: 0,
        rejected: 0,
        errors: 0,
      };
      let pages = 0;

      do {
        const res: Response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ integration_id: id, days: 180, page_token: pageToken, max: 50 }),
        });
        const body: BackfillResp = await res.json();
        if (!res.ok || !body.ok) throw new Error(body.error ?? `${res.status}`);
        totals.fetched += body.stats.fetched;
        totals.bills_created += body.stats.bills_created;
        totals.duplicates_skipped += body.stats.duplicates_skipped;
        totals.rejected += body.stats.rejected;
        totals.errors += body.stats.errors;
        pages += 1;
        setBackfillStatus(
          `Page ${pages}: ${totals.bills_created} bills · ${totals.duplicates_skipped} dupes · ${totals.rejected} skipped`,
        );
        pageToken = body.next_page_token;
      } while (pageToken);

      setBackfillStatus(
        `✓ Done. ${totals.fetched} messages scanned → ${totals.bills_created} bills created (${totals.duplicates_skipped} already imported, ${totals.rejected} no attachment).`,
      );
      await refresh();
    } catch (e) {
      setBackfillStatus(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBackfilling(null);
    }
  };

  const disconnected = integrations.filter((g) => !g.is_active);
  const formatDate = (value: string | null | undefined) =>
    value?.slice(0, 16).replace('T', ' ') ?? '—';

  return (
    <div style={{ marginTop: showContainerSpacing ? '2rem' : 0 }}>
      <h2 style={{ fontSize: 18, marginBottom: '0.5rem' }}>{title}</h2>
      <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: '1rem' }}>{description}</p>

      {disconnected.length > 0 && (
        <div
          role="alert"
          style={{
            border: '1px solid var(--accent-warning)',
            background: 'var(--bg-warning-subtle)',
            color: 'var(--text-warning)',
            borderRadius: 4,
            padding: '0.6rem 0.75rem',
            fontSize: 13,
            marginBottom: '1rem',
          }}
        >
          {disconnected.length === 1
            ? `${disconnected[0]?.gmail_address ?? 'That mailbox'} was disconnected — invoice intake from it has stopped. `
            : `${disconnected.length} Gmail mailboxes were disconnected — invoice intake from them has stopped. `}
          Use the <strong>Reconnect</strong> button below to restore it.
        </div>
      )}

      {loading ? (
        <div aria-busy="true" aria-label="Loading Gmail integrations">
          <SkeletonTable rows={2} cols={5} />
        </div>
      ) : integrations.length === 0 ? (
        <button
          onClick={handleConnect}
          disabled={connecting}
          style={{
            padding: '0.5rem 1rem',
            background: 'var(--bg-success-subtle)',
            color: 'var(--text-title)',
            border: '1px solid var(--accent-success)',
            borderRadius: 4,
            cursor: connecting ? 'wait' : 'pointer',
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          {connecting ? 'Connecting…' : connectLabel}
        </button>
      ) : (
        <>
          <table
            className="settings-responsive-table"
            style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}
          >
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                <th style={th}>Mailbox</th>
                <th style={th}>Last synced</th>
                <th style={th}>Watch expires</th>
                <th style={th}>Status</th>
                <th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {integrations.map((g) => (
                <tr key={g.id} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                  <td style={td}>{g.gmail_address}</td>
                  <td style={td}>{formatDate(g.last_synced_at)}</td>
                  <td style={td}>{formatDate(g.watch_expires_at)}</td>
                  <td style={td}>
                    <span
                      style={{
                        padding: '0.15rem 0.5rem',
                        fontSize: 11,
                        borderRadius: 3,
                        background: g.is_active ? 'var(--bg-success-subtle)' : 'var(--bg-hover)',
                        color: g.is_active ? 'var(--text-success)' : 'var(--text-muted)',
                        textTransform: 'uppercase',
                      }}
                    >
                      {g.is_active ? 'active' : 'disabled'}
                    </span>
                    {g.last_error && (
                      <div style={{ color: 'var(--text-danger)', fontSize: 11, marginTop: 4 }}>
                        {g.last_error}
                      </div>
                    )}
                  </td>
                  <td style={td}>
                    {g.is_active ? (
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <button
                          onClick={() => handleBackfill(g.id, g.gmail_address)}
                          disabled={backfilling === g.id}
                          style={{
                            background: 'var(--bg-success-subtle)',
                            color: 'var(--text-success)',
                            border: '1px solid var(--accent-success)',
                            borderRadius: 3,
                            fontSize: 11,
                            padding: '0.2rem 0.5rem',
                            cursor: backfilling === g.id ? 'wait' : 'pointer',
                          }}
                        >
                          {backfilling === g.id ? 'Scanning…' : 'Backfill 6 months'}
                        </button>
                        <button
                          onClick={() => handleDisconnect(g.id, g.gmail_address)}
                          style={{
                            background: 'transparent',
                            color: 'var(--text-danger)',
                            border: '1px solid var(--border-subtle)',
                            borderRadius: 3,
                            fontSize: 11,
                            padding: '0.2rem 0.5rem',
                            cursor: 'pointer',
                          }}
                        >
                          Disconnect
                        </button>
                      </div>
                    ) : (
                      // Disabled row: offer a one-click reconnect. Reconnecting the
                      // same Google account upserts this row back to active.
                      <button
                        onClick={handleConnect}
                        disabled={connecting}
                        title={`Reconnect ${g.gmail_address} via Google`}
                        style={{
                          background: 'var(--bg-warning-subtle)',
                          color: 'var(--text-warning)',
                          border: '1px solid var(--accent-warning)',
                          borderRadius: 3,
                          fontSize: 11,
                          fontWeight: 600,
                          padding: '0.2rem 0.5rem',
                          cursor: connecting ? 'wait' : 'pointer',
                        }}
                      >
                        {connecting ? 'Reconnecting…' : reconnectLabel}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="settings-card-view" aria-label="Gmail integrations mobile cards">
            {integrations.map((g) => (
              <div key={g.id} className="settings-mobile-card">
                <div className="settings-mobile-card__header">
                  <strong>{g.gmail_address}</strong>
                  <span
                    style={{
                      padding: '0.15rem 0.5rem',
                      fontSize: 11,
                      borderRadius: 3,
                      background: g.is_active ? 'var(--bg-success-subtle)' : 'var(--bg-hover)',
                      color: g.is_active ? 'var(--text-success)' : 'var(--text-muted)',
                      textTransform: 'uppercase',
                    }}
                  >
                    {g.is_active ? 'active' : 'disabled'}
                  </span>
                </div>
                <div className="settings-mobile-card__row">
                  <span>Last synced</span>
                  <strong>{formatDate(g.last_synced_at)}</strong>
                </div>
                <div className="settings-mobile-card__row">
                  <span>Watch expires</span>
                  <strong>{formatDate(g.watch_expires_at)}</strong>
                </div>
                {g.last_error && (
                  <div style={{ color: 'var(--text-danger)', fontSize: 11, marginTop: 4 }}>{g.last_error}</div>
                )}
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                  {g.is_active ? (
                    <>
                      <button
                        onClick={() => handleBackfill(g.id, g.gmail_address)}
                        disabled={backfilling === g.id}
                        style={{
                          background: 'var(--bg-success-subtle)',
                          color: 'var(--text-success)',
                          border: '1px solid var(--accent-success)',
                          borderRadius: 3,
                          fontSize: 11,
                          padding: '0.2rem 0.5rem',
                          cursor: backfilling === g.id ? 'wait' : 'pointer',
                        }}
                      >
                        {backfilling === g.id ? 'Scanning…' : 'Backfill 6 months'}
                      </button>
                      <button
                        onClick={() => handleDisconnect(g.id, g.gmail_address)}
                        style={{
                          background: 'transparent',
                          color: 'var(--text-danger)',
                          border: '1px solid var(--border-subtle)',
                          borderRadius: 3,
                          fontSize: 11,
                          padding: '0.2rem 0.5rem',
                          cursor: 'pointer',
                        }}
                      >
                        Disconnect
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={handleConnect}
                      disabled={connecting}
                      title={`Reconnect ${g.gmail_address} via Google`}
                      style={{
                        background: 'var(--bg-warning-subtle)',
                        color: 'var(--text-warning)',
                        border: '1px solid var(--accent-warning)',
                        borderRadius: 3,
                        fontSize: 11,
                        fontWeight: 600,
                        padding: '0.2rem 0.5rem',
                        cursor: connecting ? 'wait' : 'pointer',
                      }}
                    >
                      {connecting ? 'Reconnecting…' : reconnectLabel}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {error && <p style={{ color: 'var(--text-danger)', fontSize: 12, marginTop: '0.5rem' }}>{error}</p>}
      {backfillStatus && (
        <p style={{ color: 'var(--text-success)', fontSize: 12, marginTop: '0.5rem' }}>{backfillStatus}</p>
      )}
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
