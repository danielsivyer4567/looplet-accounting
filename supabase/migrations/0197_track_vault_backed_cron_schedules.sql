-- 0197: Track the live Vault-backed pg_cron schedules for core autopilot jobs.
--
-- These jobs are driven by pg_net against Edge Functions deployed with
-- verify_jwt=false. The functions self-authenticate with exact scoped cron
-- secrets or the exact service-role bearer. Do not embed secret values in
-- cron.job.command; store scoped secrets in Supabase Vault and read them at run
-- time through vault.decrypted_secrets.
--
-- Required Vault secret names:
--   - bank_sync_all_cron_secret
--   - notifications_cron_secret
--   - accountant_session_digest_cron_secret

do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null
     or to_regprocedure('cron.unschedule(text)') is null
     or to_regclass('vault.decrypted_secrets') is null then
    raise notice 'pg_cron or Vault not available; skipping live cron schedule tracking';
    return;
  end if;

  -- bank-sync-all: every 6 hours.
  if exists (
    select 1
    from vault.decrypted_secrets
    where name = 'bank_sync_all_cron_secret'
      and decrypted_secret is not null
    limit 1
  ) then
    if exists (select 1 from cron.job where jobname = 'bank-sync-all') then
      perform cron.unschedule('bank-sync-all');
    end if;

    perform cron.schedule(
      'bank-sync-all',
      '0 0,6,12,18 * * *',
      $cron$
        select net.http_post(
          url := 'https://dxoikltymmknxqpkpyhi.supabase.co/functions/v1/bank-sync-all?secret='
            || (select decrypted_secret from vault.decrypted_secrets where name = 'bank_sync_all_cron_secret' limit 1),
          headers := jsonb_build_object('Content-Type', 'application/json')
        );
      $cron$
    );
  else
    raise notice 'Vault secret bank_sync_all_cron_secret missing; leaving bank-sync-all schedule unchanged';
  end if;

  -- notifications-cron: nightly at 02:30 server time.
  if exists (
    select 1
    from vault.decrypted_secrets
    where name = 'notifications_cron_secret'
      and decrypted_secret is not null
    limit 1
  ) then
    if exists (select 1 from cron.job where jobname = 'notifications-cron-nightly') then
      perform cron.unschedule('notifications-cron-nightly');
    end if;
    if exists (select 1 from cron.job where jobname = 'notifications-cron-daily') then
      perform cron.unschedule('notifications-cron-daily');
    end if;

    perform cron.schedule(
      'notifications-cron-nightly',
      '30 2 * * *',
      $cron$
        select net.http_post(
          url := 'https://dxoikltymmknxqpkpyhi.supabase.co/functions/v1/notifications-cron?secret='
            || (select decrypted_secret from vault.decrypted_secrets where name = 'notifications_cron_secret' limit 1),
          headers := jsonb_build_object('Content-Type', 'application/json'),
          body := '{}'::jsonb
        );
      $cron$
    );
  else
    raise notice 'Vault secret notifications_cron_secret missing; leaving notifications cron schedule unchanged';
  end if;

  -- accountant-session-digest: every 10 minutes.
  if exists (
    select 1
    from vault.decrypted_secrets
    where name = 'accountant_session_digest_cron_secret'
      and decrypted_secret is not null
    limit 1
  ) then
    if exists (select 1 from cron.job where jobname = 'accountant-digest-cron') then
      perform cron.unschedule('accountant-digest-cron');
    end if;

    perform cron.schedule(
      'accountant-digest-cron',
      '*/10 * * * *',
      $cron$
        select net.http_post(
          url := 'https://dxoikltymmknxqpkpyhi.supabase.co/functions/v1/accountant-session-digest?secret='
            || (select decrypted_secret from vault.decrypted_secrets where name = 'accountant_session_digest_cron_secret' limit 1),
          headers := jsonb_build_object('Content-Type', 'application/json'),
          body := '{}'::jsonb
        );
      $cron$
    );
  else
    raise notice 'Vault secret accountant_session_digest_cron_secret missing; leaving accountant digest schedule unchanged';
  end if;
end $$;
