-- 20260701190000: Register the live pg_cron schedule for automation-worker.
--
-- B1 (automation-worker / queue drainer) has been RED because 0212 shipped as an
-- intentionally inert placeholder (no <PROJECT_REF>/secret substituted, cron.schedule
-- commented out). This migration follows the same guarded Vault-backed pattern as
-- 0197_track_vault_backed_cron_schedules.sql: it is a no-op unless the required Vault
-- secret already exists, so it is safe to apply to any environment (including ones
-- where the worker secret has not been provisioned yet) without a manual edit.
--
-- Required Vault secret name:
--   - automation_worker_cron_secret
--
-- Before this schedule can do anything useful:
--   1. supabase functions deploy automation-worker --no-verify-jwt
--   2. supabase secrets set AUTOMATION_WORKER_SECRET=<random-32-char>
--      (the Edge Function reads this env var; it must match the Vault secret value below)
--   3. Store the same value in Vault as 'automation_worker_cron_secret'
--      (Supabase dashboard > Vault, or `select vault.create_secret('<value>', 'automation_worker_cron_secret')`)
--   4. Re-run this migration (or `db push`) once the secret exists — it will pick it up
--      automatically because the guard re-checks vault.decrypted_secrets each time.
--
-- Runs every 2 minutes, matching the worker's own claim cadence (CLAIM_LIMIT=10 per run).

do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null
     or to_regprocedure('cron.unschedule(text)') is null
     or to_regclass('vault.decrypted_secrets') is null then
    raise notice 'pg_cron or Vault not available; skipping automation-worker cron schedule';
    return;
  end if;

  if exists (
    select 1
    from vault.decrypted_secrets
    where name = 'automation_worker_cron_secret'
      and decrypted_secret is not null
    limit 1
  ) then
    if exists (select 1 from cron.job where jobname = 'automation-worker-every-2min') then
      perform cron.unschedule('automation-worker-every-2min');
    end if;

    perform cron.schedule(
      'automation-worker-every-2min',
      '*/2 * * * *',
      $cron$
        select net.http_post(
          url := 'https://dxoikltymmknxqpkpyhi.supabase.co/functions/v1/automation-worker?secret='
            || (select decrypted_secret from vault.decrypted_secrets where name = 'automation_worker_cron_secret' limit 1),
          headers := jsonb_build_object('Content-Type', 'application/json'),
          body := '{}'::jsonb
        );
      $cron$
    );
  else
    raise notice 'Vault secret automation_worker_cron_secret missing; automation-worker cron left unscheduled';
  end if;
end $$;

-- To inspect after activation:
--   select * from cron.job where jobname = 'automation-worker-every-2min';
--   select * from cron.job_run_details
--    where jobid = (select jobid from cron.job where jobname = 'automation-worker-every-2min')
--    order by start_time desc limit 20;
--
-- To pause without unscheduling:
--   update cron.job set active = false where jobname = 'automation-worker-every-2min';
