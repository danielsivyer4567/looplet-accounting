-- Schedule xero-sync-accounts via pg_cron.
--
-- Run this ONCE manually after:
--   1. supabase functions deploy xero-sync-accounts --no-verify-jwt
--   2. supabase secrets set XERO_CRON_SECRET=<random-32-char-string>
--
-- Replace <PROJECT_REF> and <XERO_CRON_SECRET> with the real values.
-- XERO_CRON_SECRET must match the value set as a Supabase secret.

SELECT cron.schedule(
  'xero-sync-accounts-daily',
  '0 3 * * *',  -- 03:00 UTC daily (~13:00 AEST / 15:00 AEDT)
  $$
    SELECT net.http_post(
      url := 'https://<PROJECT_REF>.supabase.co/functions/v1/xero-sync-accounts?secret=<XERO_CRON_SECRET>',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := '{}'::jsonb
    );
  $$
);

-- To inspect:
--   SELECT * FROM cron.job WHERE jobname = 'xero-sync-accounts-daily';
--   SELECT * FROM cron.job_run_details
--    WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'xero-sync-accounts-daily')
--    ORDER BY start_time DESC LIMIT 10;

-- To unschedule:
--   SELECT cron.unschedule('xero-sync-accounts-daily');
