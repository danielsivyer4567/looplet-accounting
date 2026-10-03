import { useCallback, useEffect, useMemo, useState } from 'react';
import { Copy, KeyRound, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { SkeletonLine } from '@/components/Skeleton';

type Scope = 'read:financials' | 'write:bills' | 'write:bank' | 'write:invoices' | 'write:receipts';

const SCOPE_OPTIONS: Scope[] = [
  'read:financials',
  'write:bills',
  'write:bank',
  'write:invoices',
  'write:receipts',
];

interface ApiKeyRow {
  id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
  rate_limit_per_min: number | null;
}

interface ApiLogRow {
  id: number;
  key_prefix: string | null;
  endpoint: string;
  method: string | null;
  ingest_type: string | null;
  status: number;
  ts: string;
}

interface IssueApiKeyRow {
  id: string;
  api_key: string;
  key_prefix: string;
}

interface ConnectorApiKeysProps {
  organizationId: string | null | undefined;
}

const KEY_COLUMNS =
  'id,name,key_prefix,scopes,last_used_at,expires_at,revoked_at,created_at,rate_limit_per_min';
const LOG_COLUMNS = 'id,key_prefix,endpoint,method,ingest_type,status,ts';

function formatDate(value: string | null | undefined): string {
  if (!value) return 'Never';
  return new Date(value).toLocaleString();
}

function asApiKeyRows(data: unknown): ApiKeyRow[] {
  return Array.isArray(data) ? (data as ApiKeyRow[]) : [];
}

function asApiLogRows(data: unknown): ApiLogRow[] {
  return Array.isArray(data) ? (data as ApiLogRow[]) : [];
}

function asIssuedKey(data: unknown): IssueApiKeyRow | null {
  if (Array.isArray(data)) return (data[0] as IssueApiKeyRow | undefined) ?? null;
  return (data as IssueApiKeyRow | null) ?? null;
}

export function ConnectorApiKeys({ organizationId }: ConnectorApiKeysProps) {
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [logs, setLogs] = useState<ApiLogRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issuedSecret, setIssuedSecret] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState('Connector key');
  const [selectedScopes, setSelectedScopes] = useState<Scope[]>(['read:financials']);
  const [rateLimit, setRateLimit] = useState(120);

  const activeKeys = useMemo(() => keys.filter((key) => !key.revoked_at), [keys]);

  const load = useCallback(async () => {
    if (!organizationId) return;
    setLoading(true);
    setError(null);
    try {
      const [keyRes, logRes] = await Promise.all([
        supabase
          .from('api_keys')
          .select(KEY_COLUMNS)
          .eq('organization_id', organizationId)
          .order('created_at', { ascending: false }),
        supabase
          .from('api_request_log')
          .select(LOG_COLUMNS)
          .eq('organization_id', organizationId)
          .order('ts', { ascending: false })
          .limit(10),
      ]);
      if (keyRes.error) throw new Error(keyRes.error.message);
      if (logRes.error) throw new Error(logRes.error.message);
      setKeys(asApiKeyRows(keyRes.data));
      setLogs(asApiLogRows(logRes.data));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function issueKey() {
    if (!organizationId || issuing) return;
    setIssuing(true);
    setError(null);
    setIssuedSecret(null);
    try {
      const { data, error: rpcError } = await supabase.rpc('issue_api_key', {
        p_organization_id: organizationId,
        p_name: name.trim() || 'Connector key',
        p_scopes: selectedScopes,
        p_expires_at: null,
        p_rate_limit_per_min: rateLimit,
      });
      if (rpcError) throw new Error(rpcError.message);
      const issued = asIssuedKey(data);
      if (!issued?.api_key) throw new Error('API key was not returned.');
      setIssuedSecret(issued.api_key);
      setFormOpen(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIssuing(false);
    }
  }

  async function revokeKey(id: string) {
    if (!organizationId) return;
    setError(null);
    try {
      const { error: rpcError } = await supabase.rpc('revoke_api_key', { p_key_id: id });
      if (rpcError) throw new Error(rpcError.message);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function toggleScope(scope: Scope) {
    setSelectedScopes((current) =>
      current.includes(scope) ? current.filter((s) => s !== scope) : [...current, scope],
    );
  }

  async function copyIssuedSecret() {
    if (!issuedSecret || !navigator.clipboard) return;
    await navigator.clipboard.writeText(issuedSecret);
  }

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          gap: '1rem',
          alignItems: 'center',
        }}
      >
        <div>
          <h2
            style={{
              fontSize: '1.15rem',
              margin: 0,
              display: 'flex',
              alignItems: 'center',
              gap: '0.35rem',
            }}
          >
            <KeyRound size={18} style={{ color: 'var(--text-muted)' }} />
            Connector API keys
          </h2>
          <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
            {activeKeys.length} active · {logs.length} recent calls
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <button
            type="button"
            onClick={() => void load()}
            title="Refresh connector API keys"
            aria-label="Refresh connector API keys"
            disabled={loading}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              padding: '0.45rem',
              background: 'transparent',
              border: '1px solid var(--border-subtle)',
              borderRadius: '6px',
              color: 'var(--text-muted)',
              cursor: loading ? 'not-allowed' : 'pointer',
            }}
          >
            <RefreshCw size={15} />
          </button>
          <button
            type="button"
            onClick={() => setFormOpen((open) => !open)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.4rem',
              padding: '0.45rem 0.85rem',
              background: 'var(--accent-primary)',
              border: 'none',
              borderRadius: '6px',
              color: 'var(--text-on-accent)',
              fontWeight: 700,
              fontSize: '0.8rem',
              cursor: 'pointer',
            }}
          >
            <Plus size={14} />
            Issue key
          </button>
        </div>
      </div>

      {error && (
        <div style={{ color: 'var(--color-error, var(--text-danger))', fontSize: '0.8rem' }}>{error}</div>
      )}

      {issuedSecret && (
        <div
          className="card"
          style={{
            padding: '1rem',
            display: 'grid',
            gap: '0.75rem',
            borderColor: 'var(--accent-primary)',
          }}
        >
          <div style={{ fontWeight: 700, color: 'var(--text-title)', fontSize: '0.85rem' }}>
            New key shown once
          </div>
          <code
            style={{
              display: 'block',
              wordBreak: 'break-all',
              padding: '0.75rem',
              borderRadius: '6px',
              background: 'var(--bg-input)',
              border: '1px solid var(--border-subtle)',
              color: 'var(--text-title)',
              fontSize: '0.8rem',
            }}
          >
            {issuedSecret}
          </code>
          <button
            type="button"
            onClick={() => void copyIssuedSecret()}
            style={{
              justifySelf: 'start',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.35rem',
              padding: '0.45rem 0.8rem',
              background: 'transparent',
              border: '1px solid var(--border-subtle)',
              borderRadius: '6px',
              color: 'var(--text-title)',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            <Copy size={14} />
            Copy key
          </button>
        </div>
      )}

      {formOpen && (
        <div className="card" style={{ padding: '1rem', display: 'grid', gap: '0.85rem' }}>
          <label
            style={{
              display: 'grid',
              gap: '0.3rem',
              fontSize: '0.78rem',
              color: 'var(--text-muted)',
            }}
          >
            Name
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              style={{
                padding: '0.55rem 0.65rem',
                background: 'var(--bg-input)',
                border: '1px solid var(--border-subtle)',
                borderRadius: '6px',
                color: 'var(--text-title)',
              }}
            />
          </label>
          <div style={{ display: 'grid', gap: '0.45rem' }}>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Scopes</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.45rem' }}>
              {SCOPE_OPTIONS.map((scope) => (
                <label
                  key={scope}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.35rem',
                    padding: '0.35rem 0.55rem',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: '6px',
                    color: 'var(--text-title)',
                    fontSize: '0.78rem',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={selectedScopes.includes(scope)}
                    onChange={() => toggleScope(scope)}
                  />
                  {scope}
                </label>
              ))}
            </div>
          </div>
          <label
            style={{
              display: 'grid',
              gap: '0.3rem',
              fontSize: '0.78rem',
              color: 'var(--text-muted)',
            }}
          >
            Rate limit per minute
            <input
              type="number"
              min={1}
              max={1000}
              value={rateLimit}
              onChange={(event) => setRateLimit(Math.max(1, Number(event.target.value) || 1))}
              style={{
                width: '10rem',
                padding: '0.55rem 0.65rem',
                background: 'var(--bg-input)',
                border: '1px solid var(--border-subtle)',
                borderRadius: '6px',
                color: 'var(--text-title)',
              }}
            />
          </label>
          <button
            type="button"
            onClick={() => void issueKey()}
            disabled={issuing || selectedScopes.length === 0}
            style={{
              justifySelf: 'start',
              padding: '0.5rem 0.9rem',
              background: 'var(--accent-primary)',
              border: 'none',
              borderRadius: '6px',
              color: 'var(--text-on-accent)',
              fontWeight: 700,
              cursor: issuing || selectedScopes.length === 0 ? 'not-allowed' : 'pointer',
            }}
          >
            {issuing ? 'Issuing...' : 'Create key'}
          </button>
        </div>
      )}

      <div className="card" style={{ padding: '0.5rem 0' }}>
        {loading ? (
          <div
            style={{ padding: '1rem', display: 'grid', gap: '0.65rem' }}
            aria-busy="true"
            aria-label="Loading connector API keys"
          >
            <SkeletonLine width="45%" height={14} />
            <SkeletonLine width="70%" height={12} />
            <SkeletonLine width="55%" height={12} />
          </div>
        ) : keys.length === 0 ? (
          <div style={{ padding: '1rem', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
            No connector API keys.
          </div>
        ) : (
          keys.map((key) => (
            <div key={key.id} className="settings-row">
              <div>
                <div style={{ fontWeight: 700, fontSize: '0.86rem', color: 'var(--text-title)' }}>
                  {key.name} · {key.key_prefix}
                </div>
                <div
                  style={{ fontSize: '0.74rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}
                >
                  {key.scopes.join(', ') || 'no scopes'} · {key.rate_limit_per_min ?? 120}/min ·
                  last used {formatDate(key.last_used_at)}
                  {key.revoked_at ? ` · revoked ${formatDate(key.revoked_at)}` : ''}
                </div>
              </div>
              {!key.revoked_at && (
                <button
                  type="button"
                  onClick={() => void revokeKey(key.id)}
                  title="Revoke key"
                  aria-label={`Revoke ${key.name}`}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    color: 'var(--text-muted)',
                    padding: '0.25rem',
                  }}
                >
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          ))
        )}
      </div>

      {logs.length > 0 && (
        <div className="card" style={{ padding: '0.5rem 0' }}>
          {logs.map((row) => (
            <div key={row.id} className="settings-row">
              <div>
                <div style={{ fontWeight: 700, color: 'var(--text-title)', fontSize: '0.82rem' }}>
                  {row.endpoint} · {row.status}
                </div>
                <div
                  style={{ color: 'var(--text-muted)', fontSize: '0.74rem', marginTop: '0.2rem' }}
                >
                  {row.key_prefix ?? 'anonymous'} · {row.method ?? 'POST'} ·{' '}
                  {row.ingest_type ?? 'auth'} · {formatDate(row.ts)}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
