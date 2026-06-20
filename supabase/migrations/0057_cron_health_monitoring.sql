-- 0057_cron_health_monitoring.sql
-- EPIC A / A3 — cron observability (AUDIT.md §3a).
-- Applied live on 2026-06-20 via MCP; idempotent.
--
-- WHY: pg_cron records an http_post job as "succeeded" the moment the request is
-- ENQUEUED, not when it returns — so a cron that 401/403s every run still shows
-- green in cron.job_run_details. The real HTTP status lives in net._http_response.
-- This function joins the two so failing background jobs are actually visible.
--
-- Ops-only: revoked from anon/authenticated/public. Surface it to an admin UI via
-- a service-role edge function, never directly to tenant roles.

create or replace function public.cron_health_summary()
returns jsonb
language sql
security definer
set search_path = ''
as $func$
  select jsonb_build_object(
    'generated_at', now(),
    'jobs', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'job', j.jobname, 'schedule', j.schedule, 'active', j.active,
        'last_run', d.last_start, 'last_run_pg_status', d.last_status
      ) order by j.jobname), '[]'::jsonb)
      from cron.job j
      left join lateral (
        select start_time as last_start, status as last_status
        from cron.job_run_details r
        where r.jobid = j.jobid
        order by start_time desc
        limit 1
      ) d on true
    ),
    -- pg_net stores the real HTTP outcome here; counts of non-2xx in last 24h
    'http_failures_24h', (
      select count(*) from net._http_response
      where created > now() - interval '24 hours' and status_code >= 400
    ),
    'http_failures_by_code_24h', (
      select coalesce(jsonb_object_agg(status_code, c), '{}'::jsonb)
      from (
        select status_code, count(*) c
        from net._http_response
        where created > now() - interval '24 hours' and status_code >= 400
        group by status_code
      ) s
    )
  );
$func$;

revoke all on function public.cron_health_summary() from anon, authenticated, public;
