import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';
import { SkeletonCard } from '@/components/Skeleton';
import { formatLoadError } from '@/lib/errorMessages';

interface XeroIntegration {
  id: string;
  xero_tenant_id: string;
  xero_tenant_name: string;
  is_enabled: boolean;
  status: string;
  last_synced_at: string | null;
  last_error: string | null;
  token_expires_at: string;
}

export function XeroConnect() {
  const { currentOrg } = useOrg();
  const [integration, setIntegration] = useState<XeroIntegration | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);
    setError(null);
    try {
      const { data, error: queryError } = await supabase
        .from('xero_integrations')
        .select(
          'id, xero_tenant_id, xero_tenant_name, is_enabled, status, last_synced_at, last_error, token_expires_at',
        )
        .eq('organization_id', currentOrg.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (queryError) throw new Error(queryError.message);
      setIntegration(data as XeroIntegration | null);
    } catch (e) {
      setError(formatLoadError('Xero integration', e instanceof Error ? e.message : String(e)));
      setIntegration(null);
    } finally {
      setLoading(false);
    }
  }, [currentOrg]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Read success flash from hash (set by XeroCallbackPage after redirect)
  useEffect(() => {
    if (window.location.hash === '#xero-connected') {
      setSuccessMessage('Xero connected successfully.');
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, []);

  if (!currentOrg) return null;

  const handleConnect = async () => {
    setError(null);
    setConnecting(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in');

      const redirect_uri =
        import.meta.env.VITE_XERO_REDIRECT_URI ||
        `${window.location.origin}/settings/xero-callback`;
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/xero-oauth-start`;
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

      // Store state for CSRF validation in the callback
      sessionStorage.setItem('xero_oauth_state', body.state);
      window.location.href = body.auth_url;
    } catch (e) {
      setError(`Could not start Xero connection. ${e instanceof Error ? e.message : String(e)}`);
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    if (!integration) return;
    if (
      !confirm(
        `Disconnect Xero (${integration.xero_tenant_name})?\n\nAlready-synced bills and invoices keep their Xero IDs. You can reconnect at any time.`,
      )
    )
      return;
    await supabase
      .from('xero_integrations')
      .update({ is_enabled: false, status: 'disconnected' })
      .eq('id', integration.id);
    await refresh();
  };

  const handleSyncAccounts = async () => {
    if (!currentOrg) return;
    setSyncing(true);
    setError(null);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in');
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/xero-sync-accounts`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ organization_id: currentOrg.id }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) throw new Error(body.error ?? `${res.status}`);
      setSuccessMessage(`Synced ${body.accounts_upserted} accounts from Xero.`);
      await refresh();
    } catch (e) {
      setError(`Could not sync Xero accounts. ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSyncing(false);
    }
  };

  const handleSyncPayments = async () => {
    if (!currentOrg) return;
    setSyncing(true);
    setError(null);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in');
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/xero-sync-payments`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ organization_id: currentOrg.id }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) throw new Error(body.error ?? `${res.status}`);
      setSuccessMessage(`Pulled ${body.payments_processed} payments from Xero.`);
      await refresh();
    } catch (e) {
      setError(`Could not sync Xero payments. ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div style={{ marginTop: '2rem' }}>
      <h2 style={{ fontSize: 18, marginBottom: '0.5rem' }}>Xero</h2>
      <p style={{ color: '#888', fontSize: 13, marginBottom: '1rem', maxWidth: 720 }}>
        Connect your Xero organisation to push bills as ACCPAY and invoices as ACCREC. Payments
        recorded in Xero sync back nightly. Account codes and tax types are mapped per
        supplier/customer via intake rules.
      </p>

      {loading ? (
        <div aria-busy="true" aria-label="Loading Xero integration">
          <SkeletonCard />
        </div>
      ) : !integration || !integration.is_enabled ? (
        <button onClick={handleConnect} disabled={connecting} style={btnPrimXero}>
          {connecting ? 'Redirecting to Xero…' : '+ Connect Xero'}
        </button>
      ) : (
        <div className="settings-xero-card" style={card}>
          <div className="settings-xero-card__content">
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <span style={{ fontSize: 15, fontWeight: 600 }}>
                  {integration.xero_tenant_name}
                </span>
                <StatusPill status={integration.status} />
              </div>
              <div style={metaRow}>
                <span style={metaLabel}>Tenant ID</span>
                <code style={metaValue}>{integration.xero_tenant_id}</code>
              </div>
              <div style={metaRow}>
                <span style={metaLabel}>Last synced</span>
                <span style={metaValue}>
                  {integration.last_synced_at
                    ? integration.last_synced_at.slice(0, 16).replace('T', ' ') + ' UTC'
                    : 'never'}
                </span>
              </div>
              <div style={metaRow}>
                <span style={metaLabel}>Token expires</span>
                <span style={metaValue}>
                  {integration.token_expires_at?.slice(0, 16).replace('T', ' ') + ' UTC'}
                </span>
              </div>
              {integration.last_error && (
                <div
                  style={{
                    marginTop: 8,
                    padding: '6px 10px',
                    background: '#3d1818',
                    borderRadius: 4,
                    fontSize: 12,
                    color: '#e9a3a3',
                    maxWidth: 520,
                  }}
                >
                  {integration.last_error}
                </div>
              )}
            </div>

            <div className="settings-xero-card__actions">
              <button onClick={handleSyncAccounts} disabled={syncing} style={btnSmall}>
                {syncing ? 'Syncing…' : 'Sync accounts'}
              </button>
              <button onClick={handleSyncPayments} disabled={syncing} style={btnSmall}>
                {syncing ? 'Syncing…' : 'Sync payments'}
              </button>
              <button onClick={handleDisconnect} style={btnDanger}>
                Disconnect
              </button>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="badge badge-danger"
          style={{
            display: 'block',
            width: 'fit-content',
            maxWidth: 720,
            padding: '0.625rem 0.75rem',
            marginTop: '0.75rem',
            textTransform: 'none',
          }}
        >
          {error}
        </div>
      )}
      {successMessage && (
        <p style={{ color: '#86c7a3', fontSize: 12, marginTop: '0.5rem' }}>{successMessage}</p>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const colour =
    status === 'active'
      ? '#86c7a3'
      : status === 'expired' || status === 'error'
        ? '#e9a3a3'
        : '#888';
  const bg =
    status === 'active'
      ? '#0d2f1f'
      : status === 'expired' || status === 'error'
        ? '#3d1818'
        : '#2a2a2a';
  return (
    <span
      style={{
        padding: '0.15rem 0.5rem',
        fontSize: 11,
        borderRadius: 3,
        background: bg,
        color: colour,
        textTransform: 'uppercase',
      }}
    >
      {status}
    </span>
  );
}

const card: React.CSSProperties = {
  padding: 16,
  background: '#0e0e0e',
  border: '1px solid #2a2a2a',
  borderRadius: 6,
  maxWidth: 720,
};

const metaRow: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  fontSize: 12,
  marginBottom: 4,
};

const metaLabel: React.CSSProperties = { color: '#888', minWidth: 100 };
const metaValue: React.CSSProperties = { color: '#ccc' };

const btnPrimXero: React.CSSProperties = {
  padding: '0.5rem 1rem',
  background: '#1a3d6b',
  color: '#fff',
  border: '1px solid #1ab4d7',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 600,
};

const btnSmall: React.CSSProperties = {
  padding: '0.25rem 0.75rem',
  background: 'transparent',
  color: '#aaa',
  border: '1px solid #2a2a2a',
  borderRadius: 3,
  cursor: 'pointer',
  fontSize: 12,
};

const btnDanger: React.CSSProperties = {
  ...btnSmall,
  color: '#e9a3a3',
  border: '1px solid #4a2828',
};
