-- Schedule notifications-cron via pg_cron.
--
-- Run this once, manually, AFTER:
--   1. supabase functions deploy notifications-cron --no-verify-jwt
--   2. supabase secrets set NOTIFICATIONS_CRON_SECRET=<random-32-char-string>
--
-- The schedule call uses pg_net.http_post against the public functions URL
-- with ?secret=<…> for the auth gate (mirrors bank-sync-all pattern).
--
-- 02:30 daily is sufficiently after midnight to catch newly-overdue items but
-- before users start checking their morning numbers.

-- IMPORTANT: replace <PROJECT_REF> and <NOTIFICATIONS_CRON_SECRET> with the
-- real values before running. The secret should match the env var on the
-- deployed function.

SELECT cron.schedule(
  'notifications-cron-daily',
  '30 2 * * *',  -- 02:30 every day
  $$
    SELECT net.http_post(
      url := 'https://<PROJECT_REF>.supabase.co/functions/v1/notifications-cron?secret=<NOTIFICATIONS_CRON_SECRET>',
      headers := jsonb_build_object('Content-Type', 'application/json')
    );
  $$
);

-- To inspect:
--   SELECT * FROM cron.job WHERE jobname = 'notifications-cron-daily';
--   SELECT * FROM cron.job_run_details
--    WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'notifications-cron-daily')
--    ORDER BY start_time DESC LIMIT 10;

-- To unschedule:
--   SELECT cron.unschedule('notifications-cron-daily');
