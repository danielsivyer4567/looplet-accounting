-- 20260702183000_crm_pnl_sync_jobs.sql
--
-- Accounting -> CRM push mechanism for live job/org P&L. Same durable-queue
-- pattern as 20260702173000_bill_code_jobs.sql: this migration only writes
-- automation_jobs rows on a schedule; automation-worker owns HTTP dispatch
-- to the new crm-pnl-sync-push edge function (job_kind='crm_pnl_sync').
--
-- organizations.crm_organization_id existed but was unconstrained -- two
-- Accounting orgs could point at the same CRM org by accident. Add the
-- missing UNIQUE constraint (partial: only enforced when actually set, so
-- orgs with no CRM link are unaffected).

CREATE UNIQUE INDEX IF NOT EXISTS organizations_crm_organization_id_key
  ON public.organizations (crm_organization_id)
  WHERE crm_organization_id IS NOT NULL;

create or replace function public.enqueue_crm_pnl_sync_jobs(
  p_max integer default 100
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer := 0;
  v_limit integer := greatest(1, least(coalesce(p_max, 100), 500));
begin
  with candidates as (
    select o.id
    from public.organizations o
    where o.deleted_at is null
      and o.crm_organization_id is not null
      and not exists (
        select 1
        from public.automation_jobs aj
        where aj.organization_id = o.id
          and aj.job_kind = 'crm_pnl_sync'
          and aj.status in ('pending', 'claimed')
      )
    order by o.id
    limit v_limit
  ),
  inserted as (
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
      c.id,
      'crm_pnl_sync',
      'organization',
      c.id,
      40,
      now(),
      3,
      jsonb_build_object('organization_id', c.id, 'source', 'crm_pnl_sync_cron'),
      null
    from candidates c
    returning 1
  )
  select count(*) into v_count from inserted;

  return v_count;
end;
$$;

comment on function public.enqueue_crm_pnl_sync_jobs(integer) is
  'Enqueues crm_pnl_sync jobs for every org with a linked CRM org id, skipping '
  'orgs that already have one pending/claimed. Cron-safe SECURITY DEFINER; '
  'automation-worker dispatches each job to crm-pnl-sync-push, which reads '
  'v_job_pnl/v_organization_realtime_pnl and POSTs a summary to the CRM.';

revoke all on function public.enqueue_crm_pnl_sync_jobs(integer)
  from public, anon, authenticated;
grant execute on function public.enqueue_crm_pnl_sync_jobs(integer)
  to service_role;

do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null
     or to_regprocedure('cron.unschedule(text)') is null
     or to_regprocedure('public.enqueue_crm_pnl_sync_jobs(integer)') is null then
    raise notice 'pg_cron or enqueue_crm_pnl_sync_jobs missing; skipping crm-pnl-sync cron';
    return;
  end if;

  if exists (select 1 from cron.job where jobname = 'crm-pnl-sync-enqueue-every-15min') then
    perform cron.unschedule('crm-pnl-sync-enqueue-every-15min');
  end if;

  perform cron.schedule(
    'crm-pnl-sync-enqueue-every-15min',
    '*/15 * * * *',
    $cron$
      select public.enqueue_crm_pnl_sync_jobs(100);
    $cron$
  );
  raise notice 'Scheduled crm-pnl-sync-enqueue-every-15min';
end $$;

notify pgrst, 'reload schema';
