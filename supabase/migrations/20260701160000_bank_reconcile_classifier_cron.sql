-- 20260701160000: Register the live Vault-backed pg_cron schedules for the two
-- RED bank-pipeline nodes (Lane D): auto-reconcile (D5) and
-- bank-transaction-classifier (D4).
--
-- Mirrors the pattern established in 0197_track_vault_backed_cron_schedules.sql:
-- guarded by pg_cron/Vault availability, idempotent (unschedule-then-reschedule),
-- and a strict no-op if the required Vault secret is absent — so this migration
-- is safe to apply to any environment (including one where the two edge
-- functions haven't been deployed / secrets haven't been set yet).
--
-- Both functions require { organization_id } per call (no internal org fan-out,
-- unlike bank-sync-all), so each cron body loops over public.organizations
-- itself and fires one net.http_post per active org.
--
-- Required Vault secret names:
--   - auto_reconcile_cron_secret          (must match AUTO_RECONCILE_CRON_SECRET)
--   - bank_txn_classifier_cron_secret     (must match BANK_CLASSIFIER_CRON_SECRET)
--
-- Ordering: auto-reconcile runs first (03:15) so freshly-matched bills are
-- available for the classifier's Stage 1 (inherit from matched bill) when it
-- runs afterwards (03:30, then every 2 hours).
--
-- Before this migration can activate anything on a given environment:
--   1. supabase functions deploy auto-reconcile --no-verify-jwt
--   2. supabase functions deploy bank-transaction-classifier --no-verify-jwt
--   3. supabase secrets set AUTO_RECONCILE_CRON_SECRET=<random-32-char>
--   4. supabase secrets set BANK_CLASSIFIER_CRON_SECRET=<random-32-char>
--   5. Store the same two values in Supabase Vault under the names above
--      (dashboard: Project Settings → Vault, or `select vault.create_secret(...)`)
--   6. Re-run/apply this migration (or just re-run the SQL below) once the
--      secrets exist — it will then actually schedule the jobs.
--
-- To inspect after activation:
--   SELECT * FROM cron.job WHERE jobname IN ('auto-reconcile-daily', 'bank-txn-classifier-cron');
--   SELECT * FROM cron.job_run_details
--    WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'auto-reconcile-daily')
--    ORDER BY start_time DESC LIMIT 10;
--
-- To pause without unscheduling:
--   UPDATE cron.job SET active = false WHERE jobname = 'auto-reconcile-daily';
--
-- To unschedule:
--   SELECT cron.unschedule('auto-reconcile-daily');
--   SELECT cron.unschedule('bank-txn-classifier-cron');

do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null
     or to_regprocedure('cron.unschedule(text)') is null
     or to_regclass('vault.decrypted_secrets') is null then
    raise notice 'pg_cron or Vault not available; skipping live cron schedule tracking';
    return;
  end if;

  -- D5: auto-reconcile — daily at 03:15, one call per active org.
  if exists (
    select 1
    from vault.decrypted_secrets
    where name = 'auto_reconcile_cron_secret'
      and decrypted_secret is not null
    limit 1
  ) then
    if exists (select 1 from cron.job where jobname = 'auto-reconcile-daily') then
      perform cron.unschedule('auto-reconcile-daily');
    end if;

    perform cron.schedule(
      'auto-reconcile-daily',
      '15 3 * * *',
      $cron$
        select net.http_post(
          url := 'https://dxoikltymmknxqpkpyhi.supabase.co/functions/v1/auto-reconcile'
            || '?secret=' || (select decrypted_secret from vault.decrypted_secrets where name = 'auto_reconcile_cron_secret' limit 1),
          headers := jsonb_build_object('Content-Type', 'application/json'),
          body := jsonb_build_object('organization_id', o.id)
        )
        from public.organizations o
        where o.deleted_at is null;
      $cron$
    );
  else
    raise notice 'Vault secret auto_reconcile_cron_secret missing; leaving auto-reconcile schedule unchanged';
  end if;

  -- D4: bank-transaction-classifier — every 2 hours at :30, one call per active org.
  if exists (
    select 1
    from vault.decrypted_secrets
    where name = 'bank_txn_classifier_cron_secret'
      and decrypted_secret is not null
    limit 1
  ) then
    if exists (select 1 from cron.job where jobname = 'bank-txn-classifier-cron') then
      perform cron.unschedule('bank-txn-classifier-cron');
    end if;

    perform cron.schedule(
      'bank-txn-classifier-cron',
      '30 */2 * * *',
      $cron$
        select net.http_post(
          url := 'https://dxoikltymmknxqpkpyhi.supabase.co/functions/v1/bank-transaction-classifier'
            || '?secret=' || (select decrypted_secret from vault.decrypted_secrets where name = 'bank_txn_classifier_cron_secret' limit 1),
          headers := jsonb_build_object('Content-Type', 'application/json'),
          body := jsonb_build_object('organization_id', o.id)
        )
        from public.organizations o
        where o.deleted_at is null;
      $cron$
    );
  else
    raise notice 'Vault secret bank_txn_classifier_cron_secret missing; leaving bank-txn-classifier schedule unchanged';
  end if;
end $$;
