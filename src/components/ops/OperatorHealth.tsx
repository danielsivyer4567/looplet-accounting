/**
 * OperatorHealth — P1-01.
 *
 * A self-contained, READ-ONLY operator panel that lists cron jobs which have had
 * no successful run inside their expected window (the cron_no_success_windows()
 * monitor from migration 0211). It is deliberately NOT routed in this slice —
 * wiring it into an admin route comes later. Render it standalone where needed.
 *
 * cron_no_success_windows() is service_role-only, so in production this component
 * reads it through a service-role ops edge fn rather than the anon client. To keep
 * the slice self-contained we call supabase.rpc('cron_no_success_windows') directly
 * and treat a permission error like an empty/blocked result — tests mock the rpc.
 *
 * "Soft failure" is the key signal: a job can have run (last_run_at set) and even
 * returned HTTP 200 (last_run_http_status === 200) yet reported success=false. Such
 * a job shows here as "ran, reported failure", distinct from "never ran / stale".
 */

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { SkeletonTable } from '@/components/Skeleton';
import { Activity, AlertTriangle, CheckCircle2 } from 'lucide-react';

// Shape returned by public.cron_no_success_windows() (migration 0211).
export interface StaleCronJob {
  job_name: string;
  description: string | null;
  expected_interval: string; // pg interval text, e.g. "1 day"
  grace_period: string;
  last_success_at: string | null;
  last_run_at: string | null;
  last_run_success: boolean | null;
  last_run_http_status: number | null;
  last_run_detail: Record<string, unknown> | null;
  seconds_overdue: number | null;
}

function formatOverdue(seconds: number | null): string {
  if (seconds == null) return '—';
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function formatWhen(iso: string | null): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

// A job that has actually run but its latest run reported success=false (incl. the
// HTTP-200-but-failed soft failure) is a different, louder problem than "stale".
function statusLabel(job: StaleCronJob): { label: string; tone: 'danger' | 'warning' } {
  if (job.last_run_at && job.last_run_success === false) {
    const soft = job.last_run_http_status === 200;
    return { label: soft ? 'Ran, reported failure (HTTP 200)' : 'Ran, reported failure', tone: 'danger' };
  }
  if (!job.last_run_at) return { label: 'Never ran', tone: 'danger' };
  return { label: 'No success in window', tone: 'warning' };
}

export function OperatorHealth() {
  const [jobs, setJobs] = useState<StaleCronJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      const { data, error: rpcErr } = await supabase.rpc('cron_no_success_windows');
      if (cancelled) return;
      if (rpcErr) {
        setError(rpcErr.message);
        setJobs([]);
      } else {
        setJobs((data as StaleCronJob[]) ?? []);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div>
        <h2
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            fontSize: '1.05rem',
            margin: 0,
          }}
        >
          <Activity size={18} style={{ color: 'var(--accent-primary)' }} />
          Cron health
        </h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', margin: '0.25rem 0 0' }}>
          Jobs with no successful run inside their expected window. A job can be HTTP-200
          yet have failed — those appear here too.
        </p>
      </div>

      {error && (
        <div
          className="badge badge-danger"
          style={{ display: 'block', padding: '0.75rem', textTransform: 'none' }}
        >
          Failed to load cron health: {error}
        </div>
      )}

      {loading ? (
        <SkeletonTable rows={3} cols={5} />
      ) : jobs.length === 0 && !error ? (
        <div
          className="card"
          style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}
        >
          <CheckCircle2
            size={36}
            style={{ margin: '0 auto 0.75rem', opacity: 0.5, color: 'var(--accent-success, #4ade80)' }}
          />
          <p style={{ margin: 0, fontSize: '0.9rem' }}>All monitored cron jobs are healthy.</p>
          <p style={{ margin: '0.4rem 0 0', fontSize: '0.8rem' }}>
            Every registered job has a successful run inside its expected window.
          </p>
        </div>
      ) : jobs.length > 0 ? (
        <div className="table-premium-container">
          <table className="table-premium">
            <thead>
              <tr>
                <th>Job</th>
                <th>Status</th>
                <th>Last success</th>
                <th>Last run</th>
                <th style={{ textAlign: 'right' }}>Overdue by</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => {
                const status = statusLabel(job);
                return (
                  <tr key={job.job_name}>
                    <td>
                      <div style={{ fontWeight: 600, color: 'var(--text-title)' }}>
                        <code>{job.job_name}</code>
                      </div>
                      {job.description && (
                        <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>
                          {job.description}
                        </div>
                      )}
                    </td>
                    <td>
                      <span
                        className={`badge badge-${status.tone}`}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '0.3rem',
                          textTransform: 'none',
                        }}
                      >
                        <AlertTriangle size={13} />
                        {status.label}
                      </span>
                    </td>
                    <td style={{ color: 'var(--text-muted)' }}>{formatWhen(job.last_success_at)}</td>
                    <td style={{ color: 'var(--text-muted)' }}>{formatWhen(job.last_run_at)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--accent-danger)' }}>
                      {formatOverdue(job.seconds_overdue)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
