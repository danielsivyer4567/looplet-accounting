import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Download,
  FileCheck2,
  Mail,
  RefreshCw,
  Save,
  X,
} from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { downloadBlob } from '@/lib/download';
import { useAuth } from '@/hooks/useAuth';
import { useOrg } from '@/hooks/useOrg';
import { Stat } from '@/components/ui/Stat';

interface SessionRow {
  id: string;
  started_at: string;
  ended_at: string | null;
  end_reason: string | null;
  pageview_count: number | null;
  action_count: number | null;
  total_seconds: number | null;
}

interface ActivityRow {
  id: string;
  occurred_at: string;
  event_type: string;
  path: string | null;
  description: string | null;
  duration_ms: number | null;
  resource_type?: string | null;
  resource_id?: string | null;
}

interface AuditRow {
  id: string;
  occurred_at: string;
  action: string | null;
  operation: string;
  resource_type: string | null;
  resource_id: string | null;
  table_name: string;
  record_id: string | null;
  changes: Record<string, unknown> | null;
}

interface FinishProofResponse {
  ok?: boolean;
  proof_id?: string;
  snapshot_hash?: string;
  summary?: Record<string, unknown>;
  snapshot?: Record<string, unknown>;
  error?: string;
}

type BusyAction = 'load' | 'save' | 'email' | null;

function canUseFinish(role: unknown): boolean {
  const value = String(role ?? '');
  return ['accountant', 'bookkeeper', 'admin', 'owner'].includes(value);
}

function toInputValue(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function toIso(value: string): string {
  return new Date(value).toISOString();
}

function formatTime(value: string): string {
  return new Date(value).toLocaleString('en-AU', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function summarizeDuration(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return '-';
  const minutes = ms / 60_000;
  if (minutes < 1) return `${Math.round(ms / 1000)}s`;
  if (minutes < 60) return `${minutes.toFixed(1)}m`;
  return `${Math.floor(minutes / 60)}h ${Math.round(minutes % 60)}m`;
}

function countUnique<T>(rows: T[], pick: (row: T) => string | null | undefined): number {
  return new Set(rows.map(pick).filter(Boolean)).size;
}

function proofFilename(start: string, end: string): string {
  return `advisor-work-proof-${start.slice(0, 10)}-${end.slice(0, 10)}.json`;
}

function previewInvoiceSeed(
  activityCount: number,
  auditCount: number,
  startIso: string,
  endIso: string,
): Record<string, unknown> {
  return {
    evidence_kind: 'advisor_work_proof',
    period_start: startIso,
    period_end: endIso,
    description: `Advisor work proof ${startIso.slice(0, 10)} to ${endIso.slice(0, 10)}: ${activityCount} activity events, ${auditCount} audited write events`,
    activity_count: activityCount,
    audit_event_count: auditCount,
    suggested_reference: 'advisor-work-proof',
  };
}

export function AdvisorFinishButton() {
  const { currentOrg } = useOrg();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [startValue, setStartValue] = useState(() =>
    toInputValue(new Date(Date.now() - 8 * 60 * 60 * 1000)),
  );
  const [endValue, setEndValue] = useState(() => toInputValue(new Date()));
  const [note, setNote] = useState('');
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [activity, setActivity] = useState<ActivityRow[]>([]);
  const [auditRows, setAuditRows] = useState<AuditRow[]>([]);
  const [savedProof, setSavedProof] = useState<FinishProofResponse | null>(null);

  const visible = Boolean(currentOrg && user && canUseFinish(currentOrg.role_enum));

  const summary = useMemo(
    () => ({
      sessions: sessions.length,
      pageviews: activity.filter((row) => row.event_type === 'pageview').length,
      actions: activity.filter((row) => ['action', 'comment', 'export'].includes(row.event_type))
        .length,
      writes: auditRows.length,
      resources: countUnique(auditRows, (row) => row.resource_id ?? row.record_id),
    }),
    [activity, auditRows, sessions],
  );

  const invoiceSeed = useMemo(() => {
    const savedSeed = savedProof?.summary?.invoice_seed;
    if (savedSeed && typeof savedSeed === 'object') return savedSeed as Record<string, unknown>;
    return previewInvoiceSeed(
      activity.length,
      auditRows.length,
      toIso(startValue),
      toIso(endValue),
    );
  }, [activity.length, auditRows.length, endValue, savedProof, startValue]);

  const loadRows = useCallback(
    async (startIso: string, endIso: string) => {
      if (!currentOrg || !user) return;
      setBusy('load');
      setError(null);
      setMessage(null);

      const [activityRes, auditRes] = await Promise.all([
        supabase
          .from('accountant_activity_log')
          .select(
            'id, occurred_at, event_type, path, description, duration_ms, resource_type, resource_id',
          )
          .eq('organization_id', currentOrg.id)
          .eq('user_id', user.id)
          .gte('occurred_at', startIso)
          .lte('occurred_at', endIso)
          .order('occurred_at', { ascending: true })
          .limit(250),
        supabase
          .from('audit_log')
          .select(
            'id, occurred_at, action, operation, resource_type, resource_id, table_name, record_id, changes',
          )
          .eq('organization_id', currentOrg.id)
          .eq('actor_user_id', user.id)
          .gte('occurred_at', startIso)
          .lte('occurred_at', endIso)
          .order('occurred_at', { ascending: true })
          .limit(250),
      ]);

      setBusy(null);
      if (activityRes.error || auditRes.error) {
        setError(activityRes.error?.message ?? auditRes.error?.message ?? 'Could not load proof.');
        return;
      }
      setActivity((activityRes.data ?? []) as ActivityRow[]);
      setAuditRows((auditRes.data ?? []) as AuditRow[]);
    },
    [currentOrg, user],
  );

  const loadWindow = useCallback(async () => {
    if (!currentOrg || !user) return;
    setBusy('load');
    setError(null);
    setMessage(null);
    setSavedProof(null);

    const sessionsRes = await supabase
      .from('accountant_sessions')
      .select('id, started_at, ended_at, end_reason, pageview_count, action_count, total_seconds')
      .eq('organization_id', currentOrg.id)
      .eq('user_id', user.id)
      .order('started_at', { ascending: false })
      .limit(5);

    if (sessionsRes.error) {
      setBusy(null);
      setError(sessionsRes.error.message);
      return;
    }

    const loadedSessions = (sessionsRes.data ?? []) as SessionRow[];
    setSessions(loadedSessions);
    const openSession = loadedSessions.find((row) => !row.ended_at);
    const latest = openSession ?? loadedSessions[0];
    const end = new Date();
    const start = latest?.started_at
      ? new Date(latest.started_at)
      : new Date(Date.now() - 8 * 60 * 60 * 1000);

    const startInput = toInputValue(start);
    const endInput = toInputValue(end);
    setStartValue(startInput);
    setEndValue(endInput);
    setBusy(null);
    await loadRows(start.toISOString(), end.toISOString());
  }, [currentOrg, loadRows, user]);

  useEffect(() => {
    if (!open) return;
    void loadWindow();
  }, [loadWindow, open]);

  if (!visible) return null;

  async function refreshSelectedWindow() {
    try {
      await loadRows(toIso(startValue), toIso(endValue));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  }

  function buildPreviewPayload(): Record<string, unknown> {
    return {
      kind: 'advisor_work_proof_preview',
      organization_id: currentOrg?.id,
      organization_name: currentOrg?.name,
      user_id: user?.id,
      user_email: user?.email,
      period_start: toIso(startValue),
      period_end: toIso(endValue),
      note: note.trim() || null,
      summary,
      invoice_seed: invoiceSeed,
      sessions,
      activity,
      audit_log: auditRows,
      saved_proof: savedProof
        ? {
            proof_id: savedProof.proof_id,
            snapshot_hash: savedProof.snapshot_hash,
          }
        : null,
    };
  }

  async function saveProof(action: BusyAction = 'save'): Promise<FinishProofResponse | null> {
    if (!currentOrg) return null;
    setBusy(action);
    setError(null);
    setMessage(null);

    const { data, error: rpcError } = await supabase.rpc('finish_advisor_work_session', {
      p_organization_id: currentOrg.id,
      p_period_start: toIso(startValue),
      p_period_end: toIso(endValue),
      p_note: note.trim() || null,
    });

    if (rpcError) {
      setBusy(null);
      setError(rpcError.message);
      return null;
    }

    const result = (data ?? {}) as FinishProofResponse;
    if (!result.ok || !result.proof_id) {
      setBusy(null);
      setError(result.error ?? 'The proof was not saved.');
      return null;
    }

    setSavedProof(result);
    setBusy(null);
    setMessage(`Saved proof ${result.proof_id}.`);
    return result;
  }

  function downloadProof() {
    const payload = savedProof?.snapshot
      ? {
          proof_id: savedProof.proof_id,
          snapshot_hash: savedProof.snapshot_hash,
          snapshot: savedProof.snapshot,
        }
      : buildPreviewPayload();
    downloadBlob(
      new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' }),
      proofFilename(toIso(startValue), toIso(endValue)),
    );
  }

  async function emailProof() {
    const proof = savedProof ?? (await saveProof('email'));
    if (!proof?.proof_id) return;
    setBusy('email');
    setError(null);
    setMessage(null);

    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) {
      setBusy(null);
      setError('Not signed in.');
      return;
    }

    try {
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/accountant-session-digest`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ proof_id: proof.proof_id }),
        },
      );
      const body = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        recipient?: string;
      };
      setBusy(null);
      if (!response.ok || !body.ok) {
        setError(body.error ?? `Email failed with HTTP ${response.status}.`);
        return;
      }
      setMessage(`Emailed proof to ${body.recipient ?? user?.email ?? 'your account'}.`);
    } catch (err) {
      setBusy(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="btn btn-primary"
        style={{
          height: 34,
          padding: '0 0.75rem',
          fontSize: '0.8rem',
          whiteSpace: 'nowrap',
        }}
      >
        <FileCheck2 size={15} />
        <span>Finish</span>
      </button>

      {open && (
        <div
          role="presentation"
          onClick={() => setOpen(false)}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1000,
            background: 'var(--bg-scrim)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '1rem',
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="advisor-finish-title"
            onClick={(event) => event.stopPropagation()}
            style={{
              width: 'min(980px, 96vw)',
              maxHeight: '92vh',
              overflow: 'hidden',
              background: 'var(--bg-card)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 8,
              boxShadow: 'var(--shadow-lg)',
              color: 'var(--text-body)',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <div
              style={{
                padding: '1rem 1.1rem',
                borderBottom: '1px solid var(--border-subtle)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '0.75rem',
              }}
            >
              <div style={{ minWidth: 0 }}>
                <h2
                  id="advisor-finish-title"
                  style={{
                    margin: 0,
                    color: 'var(--text-title)',
                    fontSize: '1.05rem',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.45rem',
                  }}
                >
                  <FileCheck2 size={18} style={{ color: 'var(--text-link)' }} />
                  Finish work proof
                </h2>
                <p
                  style={{ margin: '0.25rem 0 0', color: 'var(--text-muted)', fontSize: '0.8rem' }}
                >
                  {currentOrg?.name}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="theme-toggle-btn"
                aria-label="Close finish work proof"
              >
                <X size={16} />
              </button>
            </div>

            <div style={{ overflow: 'auto', padding: '1rem 1.1rem' }}>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                  gap: '0.75rem',
                  marginBottom: '1rem',
                }}
              >
                <Stat variant="tile" label="Sessions" value={summary.sessions} />
                <Stat variant="tile" label="Pageviews" value={summary.pageviews} />
                <Stat variant="tile" label="Actions" value={summary.actions} />
                <Stat variant="tile" label="Write events" value={summary.writes} />
                <Stat variant="tile" label="Resources" value={summary.resources} />
              </div>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
                  gap: '0.75rem',
                  marginBottom: '1rem',
                }}
              >
                <label style={{ display: 'grid', gap: '0.35rem', fontSize: '0.75rem' }}>
                  <span style={{ color: 'var(--text-muted)' }}>From</span>
                  <input
                    type="datetime-local"
                    value={startValue}
                    onChange={(event) => setStartValue(event.target.value)}
                    className="form-input"
                  />
                </label>
                <label style={{ display: 'grid', gap: '0.35rem', fontSize: '0.75rem' }}>
                  <span style={{ color: 'var(--text-muted)' }}>To</span>
                  <input
                    type="datetime-local"
                    value={endValue}
                    onChange={(event) => setEndValue(event.target.value)}
                    className="form-input"
                  />
                </label>
                <label
                  style={{
                    display: 'grid',
                    gap: '0.35rem',
                    fontSize: '0.75rem',
                    gridColumn: '1 / -1',
                  }}
                >
                  <span style={{ color: 'var(--text-muted)' }}>Note</span>
                  <input
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    placeholder="Optional note for the proof"
                    className="form-input"
                  />
                </label>
              </div>

              <div
                style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '1rem' }}
              >
                <button
                  type="button"
                  onClick={() => void refreshSelectedWindow()}
                  disabled={busy !== null}
                  className="btn btn-secondary"
                >
                  <RefreshCw size={14} />
                  <span>{busy === 'load' ? 'Loading...' : 'Refresh'}</span>
                </button>
                <button
                  type="button"
                  onClick={() => void saveProof()}
                  disabled={busy !== null}
                  className="btn btn-primary"
                >
                  <Save size={14} />
                  <span>{busy === 'save' ? 'Saving...' : 'Save in Looplet'}</span>
                </button>
                <button type="button" onClick={downloadProof} className="btn btn-secondary">
                  <Download size={14} />
                  <span>Download proof</span>
                </button>
                <button
                  type="button"
                  onClick={() => void emailProof()}
                  disabled={busy !== null}
                  className="btn btn-secondary"
                >
                  <Mail size={14} />
                  <span>{busy === 'email' ? 'Sending...' : 'Email me'}</span>
                </button>
              </div>

              {message && (
                <Status tone="success" icon={<CheckCircle2 size={14} />}>
                  {message}
                  {savedProof?.snapshot_hash ? (
                    <span style={{ display: 'block', marginTop: 4, fontFamily: 'monospace' }}>
                      {savedProof.snapshot_hash}
                    </span>
                  ) : null}
                </Status>
              )}
              {error && (
                <Status tone="danger" icon={<AlertCircle size={14} />}>
                  {error}
                </Status>
              )}

              <div
                style={{
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 8,
                  padding: '0.85rem',
                  marginBottom: '1rem',
                  background: 'var(--bg-hover)',
                  display: 'grid',
                  gap: '0.25rem',
                }}
              >
                <span style={{ color: 'var(--text-muted)', fontSize: '0.72rem', fontWeight: 700 }}>
                  Billing proof line
                </span>
                <span style={{ color: 'var(--text-title)', fontWeight: 700 }}>
                  {String(invoiceSeed.description ?? 'Advisor work proof')}
                </span>
                {savedProof?.snapshot_hash ? (
                  <span style={{ color: 'var(--text-muted)', fontSize: '0.78rem' }}>
                    Evidence hash {savedProof.snapshot_hash}
                  </span>
                ) : null}
              </div>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
                  gap: '1rem',
                  marginTop: '1rem',
                }}
              >
                <TrailPanel title="Path trail" empty="No pageviews in this window.">
                  {activity.slice(0, 80).map((row) => (
                    <TimelineRow
                      key={row.id}
                      when={row.occurred_at}
                      label={row.path ?? row.event_type}
                      detail={row.description ?? summarizeDuration(row.duration_ms)}
                    />
                  ))}
                </TrailPanel>
                <TrailPanel title="Write audit" empty="No write events in this window.">
                  {auditRows.slice(0, 80).map((row) => (
                    <TimelineRow
                      key={row.id}
                      when={row.occurred_at}
                      label={`${row.action ?? row.operation} ${row.resource_type ?? row.table_name}`}
                      detail={row.resource_id ?? row.record_id ?? undefined}
                    />
                  ))}
                </TrailPanel>
              </div>
            </div>
          </section>
        </div>
      )}
    </>
  );
}

function Status({
  tone,
  icon,
  children,
}: {
  tone: 'success' | 'danger';
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className={`badge ${tone === 'success' ? 'badge-success' : 'badge-danger'}`}
      style={{
        display: 'block',
        padding: '0.75rem',
        marginBottom: '0.75rem',
        textTransform: 'none',
        whiteSpace: 'normal',
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
        {icon}
        {children}
      </span>
    </div>
  );
}

function TrailPanel({
  title,
  empty,
  children,
}: {
  title: string;
  empty: string;
  children: ReactNode;
}) {
  const rows = Array.isArray(children) ? children.filter(Boolean) : children ? [children] : [];
  return (
    <div
      style={{
        border: '1px solid var(--border-subtle)',
        borderRadius: 8,
        overflow: 'hidden',
        minHeight: 260,
      }}
    >
      <div
        style={{
          padding: '0.75rem 0.85rem',
          borderBottom: '1px solid var(--border-subtle)',
          color: 'var(--text-title)',
          fontWeight: 700,
        }}
      >
        {title}
      </div>
      <div style={{ maxHeight: 360, overflow: 'auto' }}>
        {rows.length > 0 ? (
          rows
        ) : (
          <div style={{ padding: '1rem', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
            {empty}
          </div>
        )}
      </div>
    </div>
  );
}

function TimelineRow({
  when,
  label,
  detail,
}: {
  when: string;
  label: string;
  detail?: string | undefined;
}) {
  return (
    <div
      style={{
        padding: '0.75rem 0.85rem',
        borderBottom: '1px solid var(--border-subtle)',
        display: 'grid',
        gap: '0.25rem',
      }}
    >
      <span style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>{formatTime(when)}</span>
      <span style={{ color: 'var(--text-title)', fontWeight: 650, wordBreak: 'break-word' }}>
        {label}
      </span>
      {detail ? (
        <span style={{ color: 'var(--text-muted)', fontSize: '0.78rem', wordBreak: 'break-word' }}>
          {detail}
        </span>
      ) : null}
    </div>
  );
}
