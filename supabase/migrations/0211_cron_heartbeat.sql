-- 0211_cron_heartbeat.sql — P1-01: durable cron heartbeat + no-success-window monitor.
--
-- WHY (builds on 0057_cron_health_monitoring):
--   0057's cron_health_summary() reads cron.job_run_details + net._http_response.
--   That tells us "did the HTTP request get made / what status code came back" but
--   it has TWO blind spots that let a silently-broken background job look green:
--
--     1. pg_cron marks an http_post job 'succeeded' the moment the request is
--        ENQUEUED. net._http_response then records the *transport* status.
--     2. CRITICAL — a job can be HTTP-200 yet have done nothing useful: an edge fn
--        that catches its own error and returns `{ ok:false }` with status 200, or
--        a sweep that processed 0 orgs because of a config issue. Transport-level
--        monitoring (0057) calls that a success. It is not.
--
--   So this migration adds a DURABLE, application-level heartbeat that each cron
--   edge function can write at the END of its run, recording an explicit
--   success boolean parsed from its own body/outcome — independent of HTTP status.
--   A run row therefore has BOTH `http_status` (transport) and `success` (body-level
--   outcome). cron_no_success_windows() then surfaces any registered job that has
--   had NO success=true run inside its expected window.
--
--   This slice ships INFRASTRUCTURE ONLY: the tables, the recording fns, and the
--   monitor fn. Wiring recordHeartbeat() into the existing cron edge functions is a
--   deliberate later slice (each fn must opt in at the end of its run), exactly like
--   0185 / 0114 keep their cron.schedule() inert until a separate deploy step.
--
-- Ops-only surface. The monitor fn is revoked from anon/authenticated/public and
-- granted only to service_role; an admin edge fn (or the standalone OperatorHealth
-- component over a service-role fn) reads it. The write fn is service_role-only too,
-- per the recurring DEFINER-grant gotcha (default privileges grant EXECUTE on new
-- public functions to authenticated + anon directly, so REVOKE FROM PUBLIC alone is
-- NOT enough — we revoke from authenticated + anon explicitly).
--
-- These objects are GLOBAL (not org-scoped): cron health is a platform concern, the
-- same for every tenant, and tenant roles must never see operational job state.

-- ----------------------------------------------------------------------------
-- 1. Registry of monitored cron jobs + their expected cadence
-- ----------------------------------------------------------------------------
-- One row per cron job we want a freshness SLA on. `expected_interval` is how often
-- the job is expected to succeed (e.g. notifications-cron nightly => '1 day'); the
-- monitor flags the job stale when now() - last successful run > expected_interval
-- + grace_period. `enabled=false` mutes a job (e.g. an inert / not-yet-deployed cron)
-- without losing its history.
create table if not exists public.cron_heartbeat_jobs (
  id                uuid primary key default gen_random_uuid(),
  job_name          text not null unique,
  description       text,
  expected_interval interval not null,
  -- slack added on top of expected_interval before a job is called stale, so a job
  -- that runs a few minutes late on a busy scheduler is not falsely flagged.
  grace_period      interval not null default interval '1 hour',
  enabled           boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table public.cron_heartbeat_jobs is
  'P1-01: registry of cron jobs with a freshness SLA. One row per monitored job; expected_interval + grace_period define the no-success window.';
comment on column public.cron_heartbeat_jobs.expected_interval is
  'How often this job is expected to record a success=true run.';
comment on column public.cron_heartbeat_jobs.grace_period is
  'Slack added to expected_interval before the job is flagged stale.';

-- ----------------------------------------------------------------------------
-- 2. Append-only log of heartbeat runs
-- ----------------------------------------------------------------------------
-- `success` is the BODY-LEVEL outcome the edge fn reports about itself (a run can
-- be HTTP-200 yet success=false). `http_status` is the transport status, kept for
-- correlation with 0057 / net._http_response but never used as the success signal.
create table if not exists public.cron_heartbeat_runs (
  id           uuid primary key default gen_random_uuid(),
  job_name     text not null,
  -- explicit body-level success — the whole point of this table.
  success      boolean not null,
  http_status  integer,
  detail       jsonb not null default '{}'::jsonb,
  ran_at       timestamptz not null default now()
);

comment on table public.cron_heartbeat_runs is
  'P1-01: append-only heartbeat log. success is the body-level outcome (a run can be HTTP-200 yet success=false); http_status is transport only.';
comment on column public.cron_heartbeat_runs.success is
  'Body-level success the job reports about itself — NOT the HTTP status. A 200 response with success=false is a soft failure.';

-- Hot path is "latest successful run for a job", so index (job_name, ran_at) and a
-- partial index over successes.
create index if not exists cron_heartbeat_runs_job_ran_idx
  on public.cron_heartbeat_runs (job_name, ran_at desc);
create index if not exists cron_heartbeat_runs_job_success_idx
  on public.cron_heartbeat_runs (job_name, ran_at desc)
  where success;

-- ----------------------------------------------------------------------------
-- 3. Recorder fn — what recordHeartbeat() (_shared/cron/heartbeat.ts) calls.
-- ----------------------------------------------------------------------------
-- Inserts a heartbeat run and (best-effort) upserts the job into the registry so a
-- first heartbeat self-registers with a sane default cadence. Returns the run id.
-- service_role only: cron edge fns invoke it via the service-role client.
create or replace function public.record_cron_heartbeat(
  p_job_name          text,
  p_success           boolean,
  p_http_status       integer default null,
  p_detail            jsonb   default '{}'::jsonb,
  p_expected_interval interval default null
) returns uuid
language plpgsql
security definer
set search_path = ''
as $func$
declare
  v_id uuid;
begin
  if p_job_name is null or length(trim(p_job_name)) = 0 then
    raise exception 'record_cron_heartbeat: job_name is required';
  end if;
  if p_success is null then
    raise exception 'record_cron_heartbeat: success is required (a run is either ok or not)';
  end if;

  -- Self-register the job on first heartbeat. Only set expected_interval from the
  -- caller when the row is new — never silently overwrite an ops-curated cadence.
  insert into public.cron_heartbeat_jobs (job_name, expected_interval)
  values (p_job_name, coalesce(p_expected_interval, interval '1 day'))
  on conflict (job_name) do nothing;

  insert into public.cron_heartbeat_runs (job_name, success, http_status, detail)
  values (p_job_name, p_success, p_http_status, coalesce(p_detail, '{}'::jsonb))
  returning id into v_id;

  return v_id;
end;
$func$;

-- Default privileges on new public functions grant EXECUTE to authenticated + anon
-- directly, so REVOKE FROM PUBLIC alone leaves them open. Revoke explicitly.
revoke all on function
  public.record_cron_heartbeat(text, boolean, integer, jsonb, interval)
  from public, authenticated, anon;
grant execute on function
  public.record_cron_heartbeat(text, boolean, integer, jsonb, interval)
  to service_role;

-- ----------------------------------------------------------------------------
-- 4. The monitor — jobs with NO successful run inside their expected window.
-- ----------------------------------------------------------------------------
-- Returns one row per enabled, stale job: a job that has had no success=true run
-- within (expected_interval + grace_period). Includes jobs that have NEVER had a
-- successful run (last_success is null), and reports the most-recent run regardless
-- of success so an operator can see "it ran but reported failure".
create or replace function public.cron_no_success_windows()
returns table (
  job_name            text,
  description         text,
  expected_interval   interval,
  grace_period        interval,
  last_success_at     timestamptz,
  last_run_at         timestamptz,
  last_run_success    boolean,
  last_run_http_status integer,
  last_run_detail     jsonb,
  seconds_overdue     numeric
)
language sql
security definer
set search_path = ''
as $func$
  select
    j.job_name,
    j.description,
    j.expected_interval,
    j.grace_period,
    s.last_success_at,
    r.last_run_at,
    r.last_run_success,
    r.last_run_http_status,
    r.last_run_detail,
    -- how long past the allowed window the job is; from now() when never-succeeded.
    extract(epoch from (
      now() - coalesce(s.last_success_at, 'epoch'::timestamptz)
            - (j.expected_interval + j.grace_period)
    ))::numeric as seconds_overdue
  from public.cron_heartbeat_jobs j
  -- latest success
  left join lateral (
    select max(ran_at) as last_success_at
    from public.cron_heartbeat_runs cr
    where cr.job_name = j.job_name and cr.success
  ) s on true
  -- most recent run of any kind (to surface a "ran but failed" state)
  left join lateral (
    select cr.ran_at as last_run_at,
           cr.success as last_run_success,
           cr.http_status as last_run_http_status,
           cr.detail as last_run_detail
    from public.cron_heartbeat_runs cr
    where cr.job_name = j.job_name
    order by cr.ran_at desc
    limit 1
  ) r on true
  where j.enabled
    and (
      s.last_success_at is null
      or s.last_success_at < now() - (j.expected_interval + j.grace_period)
    )
  order by seconds_overdue desc nulls last, j.job_name;
$func$;

revoke all on function public.cron_no_success_windows() from public, authenticated, anon;
grant execute on function public.cron_no_success_windows() to service_role;

-- Surface the monitor to the PostgREST schema cache so a service-role edge fn / the
-- OperatorHealth component (over a service-role fn) can call it by name.
notify pgrst, 'reload schema';
