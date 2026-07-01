-- 20260701161000_gmail_mine_refresh_cron.sql  (Lane A / A6)
--
-- Wires up an autonomous RECENT-WINDOW re-mine for gmail-mine so the triage /
-- deep-profile surface (staged_entities) stays populated without a human running
-- the Auto Setup wizard. Today gmail-mine is only frontend-invoked, so a mailbox
-- that connected via OAuth but never finished the wizard yields an empty triage
-- and the deep-profile engine has nothing to work with.
--
-- SCOPE (important): this is a LIGHT, recent-window refresh — the full 6-month
-- first-scrape stays onboarding/frontend-driven. gmail-mine paginates via a
-- caller-held page_token; a stateless fire-and-forget cron cannot persist that
-- cursor, so it would only ever re-fetch page 1. A recent window (days=14, one
-- page) is therefore the honest autonomous slice; deep history remains the wizard's
-- job. gmail-mine upserts staged_entities by canonical_key, so re-mining the same
-- window is idempotent (no duplicate entities).
--   PREFERRED FOLLOW-UP (recommended to the worker owner lane): add a `gmail_mine`
--   job_kind to automation-worker (it already dispatches gmail_backfill the same
--   way) so mining runs through the queue with cursor state + retry, instead of a
--   direct cron. That is out of Lane A's scope (automation-worker is frozen).
--
-- AUTH / VAULT / SELF-GUARDING: identical to the gmail-backfill catch-up cron
-- (20260701160500) — gmail-mine is frozen and accepts a bearer as its user JWT;
-- the service-role bearer is read from the Vault `service_role_key` secret at run
-- time (never embedded in cron.job.command, per 0197). Safe to apply now; no-ops
-- with a NOTICE until pg_cron + Vault + `service_role_key` are present and
-- gmail-mine is deployed.

do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null
     or to_regprocedure('cron.unschedule(text)') is null
     or to_regclass('vault.decrypted_secrets') is null then
    raise notice 'pg_cron or Vault not available; skipping gmail-mine refresh cron';
    return;
  end if;

  if exists (
    select 1 from vault.decrypted_secrets
    where name = 'service_role_key' and decrypted_secret is not null
    limit 1
  ) then
    if exists (select 1 from cron.job where jobname = 'gmail-mine-refresh') then
      perform cron.unschedule('gmail-mine-refresh');
    end if;

    perform cron.schedule(
      'gmail-mine-refresh',
      '30 4 * * *',   -- daily at 04:30 (after watch-renew at 03:00)
      $cron$
        select net.http_post(
          url := 'https://dxoikltymmknxqpkpyhi.supabase.co/functions/v1/gmail-mine',
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' ||
              (select decrypted_secret from vault.decrypted_secrets
               where name = 'service_role_key' limit 1)
          ),
          body := jsonb_build_object(
            'integration_id', gi.id, 'days', 14, 'max', 100, 'folder', 'inbox'
          )
        )
        from public.gmail_integrations gi
        where gi.is_active = true;
      $cron$
    );
    raise notice 'Scheduled gmail-mine-refresh';
  else
    raise notice 'Vault secret service_role_key missing; leaving gmail-mine refresh schedule unchanged';
  end if;
end $$;

-- Inspect:
--   SELECT * FROM cron.job WHERE jobname = 'gmail-mine-refresh';
--   SELECT * FROM cron.job_run_details
--    WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'gmail-mine-refresh')
--    ORDER BY start_time DESC LIMIT 10;
-- Pause:      UPDATE cron.job SET active = false WHERE jobname = 'gmail-mine-refresh';
-- Unschedule: SELECT cron.unschedule('gmail-mine-refresh');
