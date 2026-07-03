-- 20260702173000_bill_code_jobs.sql
--
-- Durable bill coding enqueue loop.
--
-- Gmail/OCR already creates bills and the extractor chains into
-- intake-routing-apply, but there was no first-class worker job for "code this
-- bill now" when a bill is already extracted or a handoff needs repair. This
-- migration adds a DB-side enqueue function plus pg_cron schedule. The cron does
-- not call Edge Functions or embed secrets; it writes durable automation_jobs
-- rows. automation-worker owns dispatch/retry/dead-letter evidence for
-- job_kind='bill_code'.

create or replace function public.enqueue_bill_code_jobs(
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
    select
      b.id,
      b.organization_id
    from public.bills b
    where b.deleted_at is null
      and b.status <> 'void'
      and coalesce(b.is_probable_bill, true) = true
      and b.total_inc_gst_cents is not null
      and not exists (
        select 1
        from public.coding_suggestions cs
        where cs.bill_id = b.id
          and cs.deleted_at is null
      )
      and not exists (
        select 1
        from public.automation_jobs aj
        where aj.organization_id = b.organization_id
          and aj.job_kind = 'bill_code'
          and aj.source_kind = 'bill'
          and aj.source_id = b.id
          and aj.status in ('pending', 'claimed')
      )
    order by b.created_at asc
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
      c.organization_id,
      'bill_code',
      'bill',
      c.id,
      35,
      now(),
      3,
      jsonb_build_object(
        'bill_id', c.id,
        'source', 'bill_code_cron',
        'reason', 'extracted_bill_missing_live_coding_suggestion'
      ),
      null
    from candidates c
    returning 1
  )
  select count(*) into v_count from inserted;

  return v_count;
end;
$$;

comment on function public.enqueue_bill_code_jobs(integer) is
  'Enqueues bill_code jobs for extracted probable bills that do not have a live '
  'coding_suggestions row. Cron-safe SECURITY DEFINER; automation-worker dispatches '
  'each job to intake-routing-apply so routing, coding, and the >=0.9 GL post gate '
  'run through the durable queue.';

revoke all on function public.enqueue_bill_code_jobs(integer)
  from public, anon, authenticated;
grant execute on function public.enqueue_bill_code_jobs(integer)
  to service_role;

do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null
     or to_regprocedure('cron.unschedule(text)') is null
     or to_regprocedure('public.enqueue_bill_code_jobs(integer)') is null then
    raise notice 'pg_cron or enqueue_bill_code_jobs missing; skipping bill-code queue cron';
    return;
  end if;

  if exists (select 1 from cron.job where jobname = 'bill-code-enqueue-every-5min') then
    perform cron.unschedule('bill-code-enqueue-every-5min');
  end if;

  perform cron.schedule(
    'bill-code-enqueue-every-5min',
    '*/5 * * * *',
    $cron$
      select public.enqueue_bill_code_jobs(100);
    $cron$
  );
  raise notice 'Scheduled bill-code-enqueue-every-5min to enqueue bill_code automation jobs';
end $$;

notify pgrst, 'reload schema';
