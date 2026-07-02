import { useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';
import { useGmailIntegrations } from '@/hooks/useGmailIntegrations';
import { SkeletonTable } from '@/components/Skeleton';

export function GmailConnect() {
  const { currentOrg } = useOrg();
  const { integrations, loading, refresh } = useGmailIntegrations();
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [backfilling, setBackfilling] = useState<string | null>(null);
  const [backfillStatus, setBackfillStatus] = useState<string>('');

  if (!currentOrg) return null;

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

  return (
    <div style={{ marginTop: '2rem' }}>
      <h2 style={{ fontSize: 18, marginBottom: '0.5rem' }}>Gmail intake</h2>
      <p style={{ color: '#888', fontSize: 13, marginBottom: '1rem' }}>
        Connect a mailbox so supplier invoices arrive automatically. We watch the INBOX label only
        and pull PDF / image attachments. You can list specific senders below to filter further.
      </p>

      {loading ? (
        <div aria-busy="true" aria-label="Loading Gmail integrations">
          <SkeletonTable rows={3} cols={5} />
        </div>
      ) : integrations.length === 0 ? (
        <button
          onClick={handleConnect}
          disabled={connecting}
          style={{
            padding: '0.5rem 1rem',
            background: '#1c5135',
            color: '#fff',
            border: '1px solid #2da565',
            borderRadius: 4,
            cursor: connecting ? 'wait' : 'pointer',
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          {connecting ? 'Connecting…' : '+ Connect Gmail'}
        </button>
      ) : (
        <>
          <table className="settings-responsive-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #2a2a2a' }}>
                <th style={th}>Mailbox</th>
                <th style={th}>Last synced</th>
                <th style={th}>Watch expires</th>
                <th style={th}>Status</th>
                <th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {integrations.map((g) => (
                <tr key={g.id} style={{ borderBottom: '1px solid #1a1a1a' }}>
                  <td style={td}>{g.gmail_address}</td>
                  <td style={td}>{g.last_synced_at?.slice(0, 16).replace('T', ' ') ?? '—'}</td>
                  <td style={td}>{g.watch_expires_at?.slice(0, 16).replace('T', ' ') ?? '—'}</td>
                  <td style={td}>
                    <GmailStatus integration={g} />
                  </td>
                  <td style={td}>
                    <GmailActions
                      integration={g}
                      backfilling={backfilling}
                      onBackfill={handleBackfill}
                      onDisconnect={handleDisconnect}
                    />
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
                  <GmailStatus integration={g} />
                </div>
                <div className="settings-mobile-card__row">
                  <span>Last synced</span>
                  <strong>{g.last_synced_at?.slice(0, 16).replace('T', ' ') ?? '—'}</strong>
                </div>
                <div className="settings-mobile-card__row">
                  <span>Watch expires</span>
                  <strong>{g.watch_expires_at?.slice(0, 16).replace('T', ' ') ?? '—'}</strong>
                </div>
                <GmailActions
                  integration={g}
                  backfilling={backfilling}
                  onBackfill={handleBackfill}
                  onDisconnect={handleDisconnect}
                />
              </div>
            ))}
          </div>
        </>
      )}

      {error && <p style={{ color: 'salmon', fontSize: 12, marginTop: '0.5rem' }}>{error}</p>}
      {backfillStatus && (
        <p style={{ color: '#86c7a3', fontSize: 12, marginTop: '0.5rem' }}>{backfillStatus}</p>
      )}
    </div>
  );
}

type GmailIntegration = ReturnType<typeof useGmailIntegrations>['integrations'][number];

function GmailStatus({ integration }: { integration: GmailIntegration }) {
  return (
    <>
      <span
        style={{
          padding: '0.15rem 0.5rem',
          fontSize: 11,
          borderRadius: 3,
          background: integration.is_active ? '#0d2f1f' : '#2a2a2a',
          color: integration.is_active ? '#86c7a3' : '#888',
          textTransform: 'uppercase',
        }}
      >
        {integration.is_active ? 'active' : 'disabled'}
      </span>
      {integration.last_error && (
        <div style={{ color: '#e9a3a3', fontSize: 11, marginTop: 4 }}>{integration.last_error}</div>
      )}
    </>
  );
}

function GmailActions({
  integration,
  backfilling,
  onBackfill,
  onDisconnect,
}: {
  integration: GmailIntegration;
  backfilling: string | null;
  onBackfill: (id: string, gmail: string) => Promise<void>;
  onDisconnect: (id: string, gmail: string) => Promise<void>;
}) {
  if (!integration.is_active) return null;

  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      <button
        onClick={() => void onBackfill(integration.id, integration.gmail_address)}
        disabled={backfilling === integration.id}
        style={{
          background: '#1c5135',
          color: '#86c7a3',
          border: '1px solid #2da565',
          borderRadius: 3,
          fontSize: 11,
          padding: '0.2rem 0.5rem',
          cursor: backfilling === integration.id ? 'wait' : 'pointer',
        }}
      >
        {backfilling === integration.id ? 'Scanning…' : 'Backfill 6 months'}
      </button>
      <button
        onClick={() => void onDisconnect(integration.id, integration.gmail_address)}
        style={{
          background: 'transparent',
          color: '#e9a3a3',
          border: '1px solid #2a2a2a',
          borderRadius: 3,
          fontSize: 11,
          padding: '0.2rem 0.5rem',
          cursor: 'pointer',
        }}
      >
        Disconnect
      </button>
    </div>
  );
}

const th: React.CSSProperties = {
  padding: '0.4rem 0.5rem',
  textAlign: 'left',
  fontSize: 11,
  color: '#888',
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  fontWeight: 500,
};
const td: React.CSSProperties = { padding: '0.5rem' };
