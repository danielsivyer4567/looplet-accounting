-- 20260701191500: Register the live pg_cron schedule for automation-watchdog.
--
-- J1 (automation-watchdog / 10 scanners) has been RED for the same reason as B1:
-- 0213 shipped as an intentionally inert placeholder. This migration follows the
-- guarded Vault-backed pattern from 0197_track_vault_backed_cron_schedules.sql — a
-- no-op unless the required Vault secret already exists.
--
-- Required Vault secret name:
--   - automation_watchdog_cron_secret
--
-- Before this schedule can do anything useful:
--   1. supabase functions deploy automation-watchdog --no-verify-jwt
--   2. supabase secrets set AUTOMATION_WATCHDOG_SECRET=<random-32-char>
--      (the Edge Function reads this env var; it must match the Vault secret value below)
--   3. Store the same value in Vault as 'automation_watchdog_cron_secret'
--   4. Re-run this migration (or `db push`) once the secret exists.
--
-- Runs every 15 minutes. Should run after automation-worker has had a chance to drain
-- (worker every 2 min) so the watchdog mostly finds genuinely stuck work, not jobs the
-- worker just hasn't gotten to on this cycle.

do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null
     or to_regprocedure('cron.unschedule(text)') is null
     or to_regclass('vault.decrypted_secrets') is null then
    raise notice 'pg_cron or Vault not available; skipping automation-watchdog cron schedule';
    return;
  end if;

  if exists (
    select 1
    from vault.decrypted_secrets
    where name = 'automation_watchdog_cron_secret'
      and decrypted_secret is not null
    limit 1
  ) then
    if exists (select 1 from cron.job where jobname = 'automation-watchdog-every-15min') then
      perform cron.unschedule('automation-watchdog-every-15min');
    end if;

    perform cron.schedule(
      'automation-watchdog-every-15min',
      '*/15 * * * *',
      $cron$
        select net.http_post(
          url := 'https://dxoikltymmknxqpkpyhi.supabase.co/functions/v1/automation-watchdog?secret='
            || (select decrypted_secret from vault.decrypted_secrets where name = 'automation_watchdog_cron_secret' limit 1),
          headers := jsonb_build_object('Content-Type', 'application/json'),
          body := '{}'::jsonb
        );
      $cron$
    );
  else
    raise notice 'Vault secret automation_watchdog_cron_secret missing; automation-watchdog cron left unscheduled';
  end if;
end $$;

-- To inspect after activation:
--   select * from cron.job where jobname = 'automation-watchdog-every-15min';
--   select * from cron.job_run_details
--    where jobid = (select jobid from cron.job where jobname = 'automation-watchdog-every-15min')
--    order by start_time desc limit 20;
--
-- To pause without unscheduling:
--   update cron.job set active = false where jobname = 'automation-watchdog-every-15min';
