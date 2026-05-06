-- Schedule xero-sync-payments via pg_cron.
--
-- Run this ONCE manually after:
--   1. supabase functions deploy xero-sync-payments --no-verify-jwt
--   2. supabase secrets set XERO_CRON_SECRET=<random-32-char-string>
--      (same secret used by xero-sync-accounts)
--
-- Replace <PROJECT_REF> and <XERO_CRON_SECRET> with the real values.

SELECT cron.schedule(
  'xero-sync-payments-daily',
  '30 3 * * *',  -- 03:30 UTC daily (30 min after accounts sync)
  $$
    SELECT net.http_post(
      url := 'https://<PROJECT_REF>.supabase.co/functions/v1/xero-sync-payments?secret=<XERO_CRON_SECRET>',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := '{}'::jsonb
    );
  $$
);

-- To inspect:
--   SELECT * FROM cron.job WHERE jobname = 'xero-sync-payments-daily';
--   SELECT * FROM cron.job_run_details
--    WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'xero-sync-payments-daily')
--    ORDER BY start_time DESC LIMIT 10;

-- To unschedule:
--   SELECT cron.unschedule('xero-sync-payments-daily');
