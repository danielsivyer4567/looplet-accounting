import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/contexts/OrgContext';
import { BankCsvImport } from './BankCsvImport';
import { BankStatementImport } from './BankStatementImport';

interface BankConnectionRow {
  id: string;
  provider: 'plaid' | 'basiq' | 'manual';
  institution_name: string | null;
  status: 'pending' | 'active' | 'error' | 'expired' | 'revoked';
  last_synced_at: string | null;
  last_error: string | null;
  metadata: Record<string, unknown>;
}

export function BankConnect() {
  const { currentOrg } = useOrg();
  const [connections, setConnections] = useState<BankConnectionRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);
    const { data } = await supabase
      .from('bank_connections')
      .select('id, provider, institution_name, status, last_synced_at, last_error, metadata')
      .eq('organization_id', currentOrg.id)
      .order('created_at', { ascending: false });
    setConnections((data ?? []) as BankConnectionRow[]);
    setLoading(false);
  }, [currentOrg]);

  useEffect(() => void refresh(), [refresh]);

  if (!currentOrg) return null;

  const handleConnect = async () => {
    setError(null);
    const mobile = window.prompt(
      'Australian mobile number (Basiq requires this to start the Connect flow):',
      '04',
    );
    if (!mobile) return;
    setConnecting(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in');
      const redirect_uri = `${window.location.origin}/settings/bank-callback`;
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/bank-link-token`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ organization_id: currentOrg.id, redirect_uri, mobile }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) throw new Error(body.error ?? `${res.status}`);
      // Open Basiq's hosted Connect UI
      window.location.href = body.url;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setConnecting(false);
    }
  };

  const handleSync = async (id: string) => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;
    const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/bank-sync`;
    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ organization_id: currentOrg.id, bank_connection_id: id }),
    });
    await refresh();
  };

  return (
    <div style={{ marginTop: '2rem' }}>
      <h2 style={{ fontSize: 18, marginBottom: '0.5rem' }}>Bank accounts</h2>
      <p style={{ color: '#888', fontSize: 13, marginBottom: '1rem', maxWidth: 720 }}>
        Connect your business bank accounts via Basiq (CommBank, NAB, Westpac, ANZ + 100s of others).
        Transactions sync automatically every 6 hours and auto-reconcile against your bills + invoices.
      </p>

      {loading ? (
        <p style={{ color: '#888' }}>Loading…</p>
      ) : connections.length === 0 ? (
        <div>
          <button
            onClick={handleConnect}
            disabled={connecting}
            style={{
              padding: '0.5rem 1rem',
              background: '#1c4868',
              color: '#fff',
              border: '1px solid #5096d8',
              borderRadius: 4,
              cursor: connecting ? 'wait' : 'pointer',
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            {connecting ? 'Opening Basiq…' : '+ Connect bank account (Basiq)'}
          </button>
          <BankCsvImport onImported={refresh} />
          <BankStatementImport onImported={refresh} />
        </div>
      ) : (
        <>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #2a2a2a' }}>
                <th style={th}>Bank</th>
                <th style={th}>Provider</th>
                <th style={th}>Status</th>
                <th style={th}>Last sync</th>
                <th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {connections.map((c) => (
                <tr key={c.id} style={{ borderBottom: '1px solid #1a1a1a' }}>
                  <td style={td}>{c.institution_name ?? '—'}</td>
                  <td style={td}>
                    <code style={{ color: '#888', fontSize: 11 }}>{c.provider}</code>
                  </td>
                  <td style={td}>
                    <StatusPill status={c.status} />
                    {c.last_error && (
                      <div style={{ color: '#e9a3a3', fontSize: 10, marginTop: 4 }}>
                        {c.last_error}
                      </div>
                    )}
                  </td>
                  <td style={td}>
                    {c.last_synced_at?.slice(0, 16).replace('T', ' ') ?? 'never'}
                  </td>
                  <td style={td}>
                    <button
                      onClick={() => handleSync(c.id)}
                      style={smallBtn}
                    >
                      ↻ Sync
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button
            onClick={handleConnect}
            disabled={connecting}
            style={{
              marginTop: 12,
              padding: '0.4rem 1rem',
              background: 'transparent',
              color: '#86c7a3',
              border: '1px solid #2da565',
              borderRadius: 3,
              cursor: connecting ? 'wait' : 'pointer',
              fontSize: 12,
            }}
          >
            {connecting ? 'Opening…' : '+ Connect another account (Basiq)'}
          </button>
          <BankCsvImport onImported={refresh} />
          <BankStatementImport onImported={refresh} />
        </>
      )}

      {error && (
        <p style={{ color: 'salmon', fontSize: 12, marginTop: '0.5rem' }}>
          {error}
          {error.includes('BASIQ_API_KEY') && (
            <> — set up Basiq via <code>SETUP_BANK_FEEDS.md</code> first.</>
          )}
        </p>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: BankConnectionRow['status'] }) {
  const colour = status === 'active' ? '#86c7a3'
    : status === 'expired' || status === 'revoked' ? '#e9a3a3'
    : status === 'error' ? '#e9a3a3'
    : '#888';
  return (
    <span style={{
      padding: '0.15rem 0.5rem',
      fontSize: 11,
      borderRadius: 3,
      background: '#222',
      color: colour,
      textTransform: 'uppercase',
    }}>{status}</span>
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
const smallBtn: React.CSSProperties = {
  background: 'transparent',
  color: '#aaa',
  border: '1px solid #2a2a2a',
  borderRadius: 3,
  fontSize: 11,
  padding: '0.2rem 0.5rem',
  cursor: 'pointer',
};
