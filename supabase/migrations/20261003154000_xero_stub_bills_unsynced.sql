-- ============================================================================
-- 20261003154000_xero_stub_bills_unsynced.sql  (XERO-01)
--
-- Until XERO-01, pushing a bill when Xero was not set up or not connected wrote
-- xero_status='synced' with a made-up xero_invoice_id 'STUB-xxxxxxxx', and
-- Receipt Hub sync jobs recorded the push as synced. Nothing was ever sent to
-- Xero. The edge functions no longer do this; this migration corrects the rows
-- already written:
--   * bills with a STUB- id go back to xero_status='pending' with no Xero id or
--     synced time (bills in a locked period are left alone: the period-lock
--     trigger forbids the update, and the count is reported for the owner);
--   * Receipt Hub Xero jobs recorded as synced with is_stub=true become
--     'skipped' with a plain explanation.
-- xero_sync_log is append-only, so its old STUB 'success' rows stay as history.
-- ============================================================================

BEGIN;

DO $$
DECLARE
  v_reset integer;
  v_locked integer;
  v_jobs integer;
BEGIN
  SELECT count(*) INTO v_locked
    FROM public.bills b
   WHERE b.xero_invoice_id LIKE 'STUB-%'
     AND EXISTS (
       SELECT 1 FROM public.period_locks pl
        WHERE pl.organization_id = b.organization_id
          AND b.invoice_date BETWEEN pl.period_start AND pl.period_end
          AND pl.unlocked_at IS NULL
     );

  UPDATE public.bills b
     SET xero_status = 'pending',
         xero_invoice_id = NULL,
         xero_synced_at = NULL
   WHERE b.xero_invoice_id LIKE 'STUB-%'
     AND NOT EXISTS (
       SELECT 1 FROM public.period_locks pl
        WHERE pl.organization_id = b.organization_id
          AND b.invoice_date BETWEEN pl.period_start AND pl.period_end
          AND pl.unlocked_at IS NULL
     );
  GET DIAGNOSTICS v_reset = ROW_COUNT;

  UPDATE public.receipt_sync_jobs j
     SET status = 'skipped',
         last_error = 'Not sent to Xero: Xero was not connected, but the job was recorded as synced '
                      'with a placeholder id. Connect Xero, then sync this receipt again.',
         next_attempt_at = NULL
   WHERE j.provider = 'xero'
     AND j.status = 'synced'
     AND (j.payload #>> '{dispatch_result,is_stub}') = 'true';
  GET DIAGNOSTICS v_jobs = ROW_COUNT;

  RAISE NOTICE 'XERO-01: % STUB bills set back to pending, % left in locked periods, % receipt sync jobs set to skipped',
    v_reset, v_locked, v_jobs;
END $$;

COMMIT;
