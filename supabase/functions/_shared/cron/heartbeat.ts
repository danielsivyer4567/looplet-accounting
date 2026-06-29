/**
 * _shared/cron/heartbeat.ts — P1-01.
 *
 * recordHeartbeat() lets a cron edge function write a DURABLE, body-level
 * heartbeat at the end of its run. The whole point is the `ok` flag: a cron can
 * return HTTP-200 yet have failed (caught its own error, processed 0 orgs, etc.).
 * That soft failure is invisible to transport-level monitoring (0057 /
 * net._http_response) but recorded here as success=false, which
 * cron_no_success_windows() then surfaces.
 *
 * INFRASTRUCTURE ONLY in this slice: this helper exists for edge functions to
 * import, but it is intentionally NOT wired into any existing cron function here.
 * Adopting it (calling recordHeartbeat at the end of each cron run) is a later
 * slice — each function must opt in deliberately so a failing heartbeat write can
 * never break the job it is monitoring.
 *
 * Design: recordHeartbeat NEVER throws. A monitoring write must not be able to
 * fail the run it is observing, so all errors are swallowed and returned in the
 * result for optional logging.
 *
 * Usage (in a later adoption slice):
 *
 *   import { recordHeartbeat } from '../_shared/cron/heartbeat.ts';
 *   // ... at the end of the run, with the service-role admin client:
 *   await recordHeartbeat(admin, 'notifications-cron', {
 *     ok: result.errors.length === 0,
 *     httpStatus: 200,
 *     detail: { orgs: result.orgCount, errors: result.errors.length },
 *   });
 */

// Minimal structural type for the supabase-js client so this helper does not pull
// the SDK import into the module graph of callers that already have it. Any client
// exposing `.rpc(name, args)` satisfies it (the real SupabaseClient does).
export interface HeartbeatClient {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): Promise<{ data: unknown; error: { message: string } | null }>;
}

export interface HeartbeatOptions {
  /** Body-level outcome the job reports about itself. true => success. */
  ok: boolean;
  /** Transport HTTP status, kept for correlation only (NOT the success signal). */
  httpStatus?: number;
  /** Arbitrary structured context (counts, error summaries, ...). */
  detail?: Record<string, unknown>;
  /**
   * Optional cadence used only when this job is recording its FIRST heartbeat and
   * self-registers in cron_heartbeat_jobs. Postgres interval text, e.g. '1 day',
   * '6 hours', '10 minutes'. Ignored once the job row exists (ops curates cadence).
   */
  expectedInterval?: string;
}

export interface HeartbeatResult {
  /** Whether the heartbeat row was written. */
  recorded: boolean;
  /** Error message if the write failed (swallowed, never thrown). */
  error?: string;
}

/**
 * Record a single cron heartbeat run. Resolves to a result; never rejects.
 *
 * @param client A supabase-js client authenticated as service_role (the
 *   record_cron_heartbeat fn is service_role-only).
 * @param jobName Stable job identifier, e.g. 'notifications-cron'.
 */
export async function recordHeartbeat(
  client: HeartbeatClient,
  jobName: string,
  opts: HeartbeatOptions,
): Promise<HeartbeatResult> {
  const name = (jobName ?? '').trim();
  if (!name) {
    return { recorded: false, error: 'recordHeartbeat: jobName is required' };
  }
  if (typeof opts?.ok !== 'boolean') {
    return { recorded: false, error: 'recordHeartbeat: opts.ok must be a boolean' };
  }

  try {
    const { error } = await client.rpc('record_cron_heartbeat', {
      p_job_name: name,
      p_success: opts.ok,
      p_http_status: opts.httpStatus ?? null,
      p_detail: opts.detail ?? {},
      p_expected_interval: opts.expectedInterval ?? null,
    });
    if (error) {
      return { recorded: false, error: error.message };
    }
    return { recorded: true };
  } catch (e) {
    // A monitoring write must never break the job it observes.
    return { recorded: false, error: e instanceof Error ? e.message : String(e) };
  }
}
