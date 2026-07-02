-- 20260702124500_gmail_mine_refresh_jobs.sql
--
-- Move A6 gmail-mine refresh behind the durable automation queue.
--
-- 20260701161000 scheduled a direct HTTP call to gmail-mine. That kept staged
-- entity triage fresh, but it bypassed B1 automation-worker, so failures had no
-- queue retry/dead-letter trail. This forward migration replaces the cron body
-- with a DB-side enqueue function. automation-worker now owns job_kind
-- `gmail_mine` and dispatches each job to the gmail-mine edge function.

create or replace function public.enqueue_gmail_mine_refresh_jobs(
  p_days integer default 14,
  p_max integer default 100
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer := 0;
begin
  insert into public.automation_jobs (
    organization_id,
    job_kind,
    source_kind,
    source_id,
    priority,
    run_after,
    max_attempts,
    payload,
    enqueued_by
  )
  select
    gi.organization_id,
    'gmail_mine',
    null,
    null,
    40,
    now(),
    3,
    jsonb_build_object(
      'integration_id', gi.id,
      'days', greatest(1, least(coalesce(p_days, 14), 365)),
      'max', greatest(1, least(coalesce(p_max, 100), 200)),
      'folder', 'inbox'
    ),
    null
  from public.gmail_integrations gi
  where gi.is_active = true;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function public.enqueue_gmail_mine_refresh_jobs(integer, integer) is
  'Enqueues one gmail_mine automation job per active Gmail integration for the '
  'recent-window A6 refresh. Cron-safe SECURITY DEFINER; jobs are claimed by '
  'automation-worker and retain retry/dead-letter evidence.';

revoke all on function public.enqueue_gmail_mine_refresh_jobs(integer, integer)
  from public, anon, authenticated;
grant execute on function public.enqueue_gmail_mine_refresh_jobs(integer, integer)
  to service_role;

do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null
     or to_regprocedure('cron.unschedule(text)') is null
     or to_regprocedure('public.enqueue_gmail_mine_refresh_jobs(integer, integer)') is null then
    raise notice 'pg_cron or enqueue_gmail_mine_refresh_jobs missing; skipping gmail-mine queue cron';
    return;
  end if;

  if exists (select 1 from cron.job where jobname = 'gmail-mine-refresh') then
    perform cron.unschedule('gmail-mine-refresh');
  end if;

  perform cron.schedule(
    'gmail-mine-refresh',
    '30 4 * * *',
    $cron$
      select public.enqueue_gmail_mine_refresh_jobs(14, 100);
    $cron$
  );
  raise notice 'Scheduled gmail-mine-refresh to enqueue gmail_mine automation jobs';
end $$;

notify pgrst, 'reload schema';
