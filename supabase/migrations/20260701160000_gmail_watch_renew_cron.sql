-- 20260701160000_gmail_watch_renew_cron.sql  (Lane A / A5)
--
-- Wires up the DAILY trigger for gmail-watch-renew. Gmail users.watch() grants
-- expire after 7 days; without a renewal cron every watched mailbox silently
-- stops delivering Pub/Sub push (A1) after a week. The function itself is green
-- (auth-gated, fatal-disable + "Reconnect Gmail" notify) but its cron only ever
-- existed as a doc comment in the function header — never committed. This commits
-- it, following the 0197 Vault-guarded live-cron pattern.
--
-- SELF-GUARDING: safe to apply in ANY environment. If pg_cron or Vault is absent,
-- or the scoped secret is not set, it RAISES NOTICE and leaves the schedule
-- unchanged (no placeholder failures). It becomes live automatically once:
--   1. supabase functions deploy gmail-watch-renew --no-verify-jwt
--   2. supabase secrets set GMAIL_WATCH_RENEW_CRON_SECRET=<random-32-char>
--   3. Vault secret `gmail_watch_renew_cron_secret` = the SAME value
--      (the function checks ?secret= against GMAIL_WATCH_RENEW_CRON_SECRET)
--   4. re-run this migration (or the cron.schedule block) once
--
-- The function is deployed --no-verify-jwt (pg_cron sends no Supabase JWT); the
-- ?secret= query param is the constant-time auth gate. It also accepts the exact
-- service-role bearer, but we use the scoped cron secret here so the service-role
-- key never rides in cron.job.command.

do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null
     or to_regprocedure('cron.unschedule(text)') is null
     or to_regclass('vault.decrypted_secrets') is null then
    raise notice 'pg_cron or Vault not available; skipping gmail-watch-renew cron';
    return;
  end if;

  if exists (
    select 1 from vault.decrypted_secrets
    where name = 'gmail_watch_renew_cron_secret'
      and decrypted_secret is not null
    limit 1
  ) then
    if exists (select 1 from cron.job where jobname = 'gmail-watch-renew-daily') then
      perform cron.unschedule('gmail-watch-renew-daily');
    end if;

    perform cron.schedule(
      'gmail-watch-renew-daily',
      '0 3 * * *',   -- daily at 03:00 (watches renewed >=24h before 7-day expiry)
      $cron$
        select net.http_post(
          url := 'https://dxoikltymmknxqpkpyhi.supabase.co/functions/v1/gmail-watch-renew?secret='
            || (select decrypted_secret from vault.decrypted_secrets
                where name = 'gmail_watch_renew_cron_secret' limit 1),
          headers := jsonb_build_object('Content-Type', 'application/json')
        );
      $cron$
    );
    raise notice 'Scheduled gmail-watch-renew-daily';
  else
    raise notice 'Vault secret gmail_watch_renew_cron_secret missing; leaving gmail-watch-renew schedule unchanged';
  end if;
end $$;

-- Inspect:
--   SELECT * FROM cron.job WHERE jobname = 'gmail-watch-renew-daily';
--   SELECT * FROM cron.job_run_details
--    WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'gmail-watch-renew-daily')
--    ORDER BY start_time DESC LIMIT 10;
-- Pause:      UPDATE cron.job SET active = false WHERE jobname = 'gmail-watch-renew-daily';
-- Unschedule: SELECT cron.unschedule('gmail-watch-renew-daily');
