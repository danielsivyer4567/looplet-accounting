-- 20260701160500_gmail_backfill_catchup_cron.sql  (Lane A / A2)
--
-- Wires up an autonomous CATCH-UP trigger for gmail-backfill. Today gmail-backfill
-- is only ever invoked by the frontend (user JWT, manual pagination), so anything
-- the real-time Pub/Sub push (A1) misses — a dropped push event, a watch that
-- lapsed before renewal, a transient ingest failure that left last_history_id
-- behind — is never recovered without a human clicking "backfill".
--
-- This cron sweeps, every 6h, only the mailboxes the push ISN'T already covering
-- (last_synced_at stale > 6h), re-scanning a short recent window. It is a BACKSTOP,
-- not a full history sweep — deep historical import stays frontend/onboarding-driven
-- (a stateless fire-and-forget cron cannot carry gmail-backfill's page_token cursor).
--
-- IDEMPOTENT: gmail-backfill dedups every message via hasExistingGmailBill
-- (bills.intake_metadata->>'gmail_message_id'), so re-scanning the same window
-- never double-ingests. days=3/max=50 fits one page, so page-1-only is complete
-- for the catch-up purpose.
--
-- AUTH: gmail-backfill is frozen (Lane A does not edit it) and has no ?secret=
-- gate — it accepts a bearer as its user JWT. The service-role bearer bypasses RLS
-- for this system-wide sweep, exactly as the automation-worker already calls it
-- (automation-worker dispatchJob → gmail_backfill). Per 0197, the key is NOT
-- embedded in cron.job.command; it is read from Vault at run time.
--   FOLLOW-UP (recommended to the gmail-backfill owner lane): add a scoped ?secret=
--   gate so this cron can use a narrow cron secret instead of the service-role key.
--
-- SELF-GUARDING: safe to apply now. No-ops with a NOTICE unless pg_cron + Vault are
-- present AND a `service_role_key` Vault secret exists. Activates once:
--   1. supabase functions deploy gmail-backfill  (already deployed? then skip)
--   2. Store the project service-role key in Vault as `service_role_key`
--      (shared with the A6 gmail-mine refresh cron — provision once).
--   3. re-run this migration (or the cron.schedule block) once.

do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null
     or to_regprocedure('cron.unschedule(text)') is null
     or to_regclass('vault.decrypted_secrets') is null then
    raise notice 'pg_cron or Vault not available; skipping gmail-backfill catch-up cron';
    return;
  end if;

  if exists (
    select 1 from vault.decrypted_secrets
    where name = 'service_role_key' and decrypted_secret is not null
    limit 1
  ) then
    if exists (select 1 from cron.job where jobname = 'gmail-backfill-catchup') then
      perform cron.unschedule('gmail-backfill-catchup');
    end if;

    perform cron.schedule(
      'gmail-backfill-catchup',
      '0 */6 * * *',   -- every 6 hours
      $cron$
        select net.http_post(
          url := 'https://dxoikltymmknxqpkpyhi.supabase.co/functions/v1/gmail-backfill',
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' ||
              (select decrypted_secret from vault.decrypted_secrets
               where name = 'service_role_key' limit 1)
          ),
          body := jsonb_build_object('integration_id', gi.id, 'days', 3, 'max', 50)
        )
        from public.gmail_integrations gi
        where gi.is_active = true
          -- Only mailboxes the real-time push isn't already keeping fresh.
          and (gi.last_synced_at is null
               or gi.last_synced_at < now() - interval '6 hours');
      $cron$
    );
    raise notice 'Scheduled gmail-backfill-catchup';
  else
    raise notice 'Vault secret service_role_key missing; leaving gmail-backfill catch-up schedule unchanged';
  end if;
end $$;

-- Inspect:
--   SELECT * FROM cron.job WHERE jobname = 'gmail-backfill-catchup';
--   SELECT * FROM cron.job_run_details
--    WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'gmail-backfill-catchup')
--    ORDER BY start_time DESC LIMIT 10;
-- Pause:      UPDATE cron.job SET active = false WHERE jobname = 'gmail-backfill-catchup';
-- Unschedule: SELECT cron.unschedule('gmail-backfill-catchup');
