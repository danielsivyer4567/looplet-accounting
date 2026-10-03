import { useCallback, useEffect, useMemo, useState } from 'react';
import { Ban, CheckCircle2, Copy, KeyRound, RefreshCw, ShieldCheck } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';

const API_KEY_COLUMNS =
  'id, name, key_prefix, scopes, created_at, last_used_at, expires_at, revoked_at, rate_limit_per_min';
const AUDIT_COLUMNS = 'id, api_key_id, key_prefix, endpoint, method, ingest_type, status, ts';

const SCOPES = [
  {
    value: 'read:financials',
    label: 'Read financials',
    note: 'Full-org read through the read-only connector role.',
  },
  { value: 'write:bills', label: 'Write bills', note: 'Create bills through ingest.' },
  { value: 'write:bank', label: 'Write bank', note: 'Create bank transactions through ingest.' },
  {
    value: 'write:invoices',
    label: 'Write invoices',
    note: 'Create invoices through ingest.',
  },
  {
    value: 'write:receipts',
    label: 'Write receipts',
    note: 'Accept POS receipt webhooks.',
  },
  { value: 'admin:keys', label: 'Admin keys', note: 'Reserved for trusted operators.' },
] as const;

type ApiScope = (typeof SCOPES)[number]['value'];

interface ApiKeyRow {
  id: string;
  name: string;
  key_prefix: string;
  scopes: string[] | null;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  rate_limit_per_min: number | null;
}

interface ApiRequestLogRow {
  id: string;
  api_key_id: string | null;
  key_prefix: string | null;
  endpoint: string;
  method: string;
  ingest_type: string | null;
  status: number | null;
  ts: string;
}

interface IssuedApiKeyRow {
  id: string;
  key_prefix: string;
  api_key: string;
}

type KeyStatus = 'active' | 'expired' | 'revoked';

export function ApiKeys() {
  const { currentOrg } = useOrg();
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [auditRows, setAuditRows] = useState<ApiRequestLogRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [issuedKey, setIssuedKey] = useState<IssuedApiKeyRow | null>(null);
  const [name, setName] = useState('');
  const [selectedScopes, setSelectedScopes] = useState<ApiScope[]>(['read:financials']);
  const [expiresAt, setExpiresAt] = useState('');
  const [rateLimit, setRateLimit] = useState(120);

  const refresh = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);
    setError(null);
    try {
      const [keyResult, auditResult] = await Promise.all([
        supabase
          .from('api_keys')
          .select(API_KEY_COLUMNS)
          .eq('organization_id', currentOrg.id)
          .order('created_at', { ascending: false }),
        supabase
          .from('api_request_log')
          .select(AUDIT_COLUMNS)
          .eq('organization_id', currentOrg.id)
          .order('ts', { ascending: false })
          .limit(12),
      ]);

      if (keyResult.error) throw new Error(keyResult.error.message);
      if (auditResult.error) throw new Error(auditResult.error.message);

      setKeys((keyResult.data ?? []) as ApiKeyRow[]);
      setAuditRows((auditResult.data ?? []) as ApiRequestLogRow[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [currentOrg]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const activeCount = useMemo(
    () => keys.filter((key) => keyStatus(key) === 'active').length,
    [keys],
  );

  if (!currentOrg) return null;

  const toggleScope = (scope: ApiScope) => {
    setSelectedScopes((prev) =>
      prev.includes(scope) ? prev.filter((item) => item !== scope) : [...prev, scope],
    );
  };

  const issueKey = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (selectedScopes.length === 0) {
      setError('Pick at least one scope.');
      return;
    }
    setIssuing(true);
    setError(null);
    setNotice(null);
    setIssuedKey(null);
    try {
      const { data, error: rpcError } = await supabase.rpc('issue_api_key', {
        p_organization_id: currentOrg.id,
        p_name: name.trim() || 'Connector key',
        p_scopes: selectedScopes,
        p_expires_at: expiresAt ? `${expiresAt}T23:59:59.999Z` : null,
        p_rate_limit_per_min: Math.max(1, Math.trunc(rateLimit || 1)),
      });

      if (rpcError) throw new Error(rpcError.message);
      const rows = Array.isArray(data) ? data : data ? [data] : [];
      const first = rows[0] as IssuedApiKeyRow | undefined;
      if (!first?.api_key || !first.key_prefix || !first.id) {
        throw new Error('The API key RPC did not return a one-time secret.');
      }

      setIssuedKey(first);
      setName('');
      setExpiresAt('');
      setNotice('Connector key issued. Store the secret now; it cannot be recovered later.');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIssuing(false);
    }
  };

  const revokeKey = async (key: ApiKeyRow) => {
    if (key.revoked_at) return;
    if (!window.confirm(`Revoke ${key.name}? Existing integrations using this key will fail.`)) {
      return;
    }

    setRevokingId(key.id);
    setError(null);
    setNotice(null);
    try {
      const { error: rpcError } = await supabase.rpc('revoke_api_key', { p_key_id: key.id });
      if (rpcError) throw new Error(rpcError.message);
      setNotice(`${key.name} revoked.`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRevokingId(null);
    }
  };

  const copyIssuedKey = async () => {
    if (!issuedKey) return;
    await navigator.clipboard?.writeText(issuedKey.api_key);
    setNotice('Secret copied.');
  };

  return (
    <section aria-labelledby="connector-api-heading" style={{ marginTop: '2rem' }}>
      <div style={headerRow}>
        <div>
          <h2 id="connector-api-heading" style={heading}>
            <ShieldCheck size={18} style={{ color: 'var(--text-muted)' }} />
            Connector API keys
          </h2>
          <p style={intro}>
            Issue scoped connector keys for POS, importers, and reporting integrations. The secret
            is shown once; key usage is read from the connector audit log.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          style={iconButton}
          title="Refresh connector keys and audit log"
          aria-label="Refresh connector keys and audit log"
        >
          <RefreshCw size={15} />
        </button>
      </div>

      <div style={summaryRow} aria-label="Connector key summary">
        <SummaryStat label="Active keys" value={activeCount} />
        <SummaryStat label="Total keys" value={keys.length} />
        <SummaryStat label="Audit rows" value={auditRows.length} />
      </div>

      {error && (
        <div role="alert" style={alertStyle}>
          {error}
        </div>
      )}
      {notice && (
        <div role="status" style={successStyle}>
          {notice}
        </div>
      )}

      {issuedKey && (
        <div style={secretPanel}>
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-warning)', fontWeight: 700 }}>One-time secret</div>
            <code style={secretCode}>{issuedKey.api_key}</code>
          </div>
          <button type="button" onClick={() => void copyIssuedKey()} style={smallButton}>
            <Copy size={14} />
            Copy
          </button>
        </div>
      )}

      <form onSubmit={(event) => void issueKey(event)} style={formGrid}>
        <label style={fieldStyle}>
          <span style={labelStyle}>Key name</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="POS connector"
            style={inputStyle}
          />
        </label>
        <label style={fieldStyle}>
          <span style={labelStyle}>Expires</span>
          <input
            type="date"
            value={expiresAt}
            onChange={(event) => setExpiresAt(event.target.value)}
            style={inputStyle}
          />
        </label>
        <label style={fieldStyle}>
          <span style={labelStyle}>Rate/min</span>
          <input
            type="number"
            min={1}
            max={1000}
            value={rateLimit}
            onChange={(event) => setRateLimit(Number(event.target.value))}
            style={inputStyle}
          />
        </label>

        <fieldset style={scopeFieldset}>
          <legend style={labelStyle}>Scopes</legend>
          <div style={scopeGrid}>
            {SCOPES.map((scope) => (
              <label key={scope.value} style={scopeOption}>
                <input
                  type="checkbox"
                  checked={selectedScopes.includes(scope.value)}
                  onChange={() => toggleScope(scope.value)}
                />
                <span>
                  <span style={{ color: 'var(--text-title)', fontWeight: 700 }}>{scope.label}</span>
                  <span style={scopeNote}>{scope.note}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button type="submit" disabled={issuing} style={primaryButton}>
            <KeyRound size={15} />
            {issuing ? 'Issuing...' : 'Issue key'}
          </button>
        </div>
      </form>

      <div style={tableWrap}>
        <h3 style={subheading}>Keys</h3>
        {loading ? (
          <p style={muted}>Loading connector keys...</p>
        ) : keys.length === 0 ? (
          <p style={muted}>No connector keys issued yet.</p>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Prefix</Th>
                <Th>Scopes</Th>
                <Th>Status</Th>
                <Th>Last used</Th>
                <Th>Rate</Th>
                <Th>Action</Th>
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <tr key={key.id} style={tableRow}>
                  <Td>{key.name}</Td>
                  <Td>
                    <code>{key.key_prefix}</code>
                  </Td>
                  <Td>{(key.scopes ?? []).join(', ') || 'none'}</Td>
                  <Td>
                    <StatusBadge status={keyStatus(key)} />
                  </Td>
                  <Td>{formatDate(key.last_used_at)}</Td>
                  <Td>{key.rate_limit_per_min ?? 120}/min</Td>
                  <Td>
                    <button
                      type="button"
                      onClick={() => void revokeKey(key)}
                      disabled={Boolean(key.revoked_at) || revokingId === key.id}
                      style={dangerButton}
                    >
                      <Ban size={13} />
                      {revokingId === key.id ? 'Revoking...' : 'Revoke'}
                    </button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div style={tableWrap}>
        <h3 style={subheading}>Recent connector audit</h3>
        {auditRows.length === 0 ? (
          <p style={muted}>No connector calls logged yet.</p>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <Th>Time</Th>
                <Th>Key</Th>
                <Th>Endpoint</Th>
                <Th>Method</Th>
                <Th>Type</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {auditRows.map((row) => (
                <tr key={row.id} style={tableRow}>
                  <Td>{formatDate(row.ts)}</Td>
                  <Td>
                    <code>{row.key_prefix ?? 'anonymous'}</code>
                  </Td>
                  <Td>{row.endpoint}</Td>
                  <Td>{row.method}</Td>
                  <Td>{row.ingest_type ?? '-'}</Td>
                  <Td>{row.status ?? '-'}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function SummaryStat({ label, value }: { label: string; value: number }) {
  return (
    <div style={summaryStat}>
      <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{label}</span>
      <strong style={{ color: 'var(--text-title)', fontSize: 18 }}>{value}</strong>
    </div>
  );
}

function StatusBadge({ status }: { status: KeyStatus }) {
  const tone =
    status === 'active'
      ? { color: 'var(--text-success)', bg: 'var(--bg-success-subtle)' }
      : status === 'expired'
        ? { color: 'var(--text-warning)', bg: 'var(--bg-warning-subtle)' }
        : { color: 'var(--text-danger)', bg: 'var(--bg-danger-subtle)' };
  return (
    <span style={{ ...badgeStyle, color: tone.color, background: tone.bg }}>
      {status === 'active' && <CheckCircle2 size={12} />}
      {status}
    </span>
  );
}

function keyStatus(key: ApiKeyRow): KeyStatus {
  if (key.revoked_at) return 'revoked';
  if (key.expires_at && new Date(key.expires_at).getTime() <= Date.now()) return 'expired';
  return 'active';
}

function formatDate(value: string | null): string {
  if (!value) return 'never';
  return value.slice(0, 16).replace('T', ' ');
}

function Th({ children }: { children: React.ReactNode }) {
  return <th style={thStyle}>{children}</th>;
}

function Td({ children }: { children: React.ReactNode }) {
  return <td style={tdStyle}>{children}</td>;
}

const headerRow: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: '1rem',
  alignItems: 'flex-start',
};

const heading: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.35rem',
  fontSize: '1.15rem',
  margin: 0,
};

const intro: React.CSSProperties = {
  color: 'var(--text-muted)',
  fontSize: 13,
  lineHeight: 1.5,
  margin: '0.35rem 0 0',
  maxWidth: 760,
};

const summaryRow: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
  gap: '0.75rem',
  marginTop: '1rem',
};

const summaryStat: React.CSSProperties = {
  border: '1px solid var(--border-subtle)',
  background: 'var(--bg-card)',
  borderRadius: 8,
  padding: '0.75rem',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.2rem',
};

const formGrid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
  gap: '0.85rem',
  marginTop: '1rem',
  padding: '1rem',
  border: '1px solid var(--border-subtle)',
  borderRadius: 8,
  background: 'var(--bg-card)',
};

const fieldStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.35rem',
};

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--text-muted)',
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: 0.4,
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  minHeight: 36,
  background: 'var(--bg-panel)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 6,
  color: 'var(--text-title)',
  padding: '0.45rem 0.6rem',
  fontSize: 13,
};

const scopeFieldset: React.CSSProperties = {
  gridColumn: '1 / -1',
  border: 0,
  padding: 0,
  margin: 0,
};

const scopeGrid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
  gap: '0.65rem',
  marginTop: '0.45rem',
};

const scopeOption: React.CSSProperties = {
  display: 'flex',
  gap: '0.5rem',
  alignItems: 'flex-start',
  border: '1px solid var(--border-subtle)',
  borderRadius: 6,
  padding: '0.65rem',
  fontSize: 12,
};

const scopeNote: React.CSSProperties = {
  display: 'block',
  color: 'var(--text-muted)',
  fontSize: 11,
  lineHeight: 1.35,
  marginTop: 2,
};

const iconButton: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 34,
  height: 34,
  borderRadius: 8,
  border: '1px solid var(--border-subtle)',
  color: 'var(--text-title)',
  background: 'var(--bg-card)',
  cursor: 'pointer',
};

const primaryButton: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.4rem',
  justifyContent: 'center',
  padding: '0.55rem 0.85rem',
  background: 'var(--bg-success-subtle)',
  color: 'var(--text-title)',
  border: '1px solid var(--accent-success)',
  borderRadius: 6,
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 700,
};

const smallButton: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.35rem',
  padding: '0.35rem 0.65rem',
  background: 'transparent',
  color: 'var(--text-warning)',
  border: '1px solid var(--accent-warning)',
  borderRadius: 5,
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 700,
};

const dangerButton: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.3rem',
  padding: '0.3rem 0.55rem',
  background: 'transparent',
  color: 'var(--text-danger)',
  border: '1px solid var(--accent-danger)',
  borderRadius: 5,
  cursor: 'pointer',
  fontSize: 12,
};

const secretPanel: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: '0.75rem',
  alignItems: 'center',
  marginTop: '1rem',
  padding: '0.85rem',
  border: '1px solid var(--accent-warning)',
  borderRadius: 8,
  background: 'var(--bg-warning-subtle)',
};

const secretCode: React.CSSProperties = {
  display: 'block',
  marginTop: '0.35rem',
  color: 'var(--text-warning)',
  wordBreak: 'break-all',
  fontSize: 12,
};

const alertStyle: React.CSSProperties = {
  marginTop: '1rem',
  padding: '0.7rem 0.85rem',
  border: '1px solid var(--accent-danger)',
  background: 'var(--bg-danger-subtle)',
  color: 'var(--text-danger)',
  borderRadius: 8,
  fontSize: 13,
};

const successStyle: React.CSSProperties = {
  marginTop: '1rem',
  padding: '0.7rem 0.85rem',
  border: '1px solid var(--accent-success)',
  background: 'var(--bg-success-subtle)',
  color: 'var(--text-success)',
  borderRadius: 8,
  fontSize: 13,
};

const tableWrap: React.CSSProperties = {
  marginTop: '1.25rem',
  overflowX: 'auto',
};

const subheading: React.CSSProperties = {
  margin: '0 0 0.5rem',
  fontSize: 14,
  color: 'var(--text-title)',
};

const tableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 12,
};

const tableRow: React.CSSProperties = {
  borderBottom: '1px solid var(--border-subtle)',
};

const thStyle: React.CSSProperties = {
  padding: '0.45rem 0.5rem',
  textAlign: 'left',
  fontSize: 11,
  color: 'var(--text-muted)',
  textTransform: 'uppercase',
  letterSpacing: 0.4,
  fontWeight: 700,
  whiteSpace: 'nowrap',
};

const tdStyle: React.CSSProperties = {
  padding: '0.55rem 0.5rem',
  color: 'var(--text-title)',
  verticalAlign: 'top',
};

const badgeStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.25rem',
  padding: '0.15rem 0.5rem',
  fontSize: 11,
  borderRadius: 999,
  textTransform: 'uppercase',
};

const muted: React.CSSProperties = {
  color: 'var(--text-muted)',
  fontSize: 13,
  margin: 0,
};
