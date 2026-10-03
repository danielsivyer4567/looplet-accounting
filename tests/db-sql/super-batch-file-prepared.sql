-- LODGE-01: a super batch whose clearing-house file was generated is file_prepared, not sent.
-- Run with: node scripts/db/run-pg-sql-tests.mjs tests/db-sql/super-batch-file-prepared.sql
--
-- Setup runs as postgres. Checks the enum order, that a prepared quarter cannot be rebuilt by
-- generate_super_batch (its file may already be with a clearing house), and that a draft quarter still
-- can be.

BEGIN;

DO $$
DECLARE
  labels text[];
BEGIN
  SELECT array_agg(e.enumlabel ORDER BY e.enumsortorder) INTO labels
    FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
   WHERE t.typname = 'super_batch_status';
  IF labels IS DISTINCT FROM ARRAY['draft', 'approved', 'file_prepared', 'sent', 'confirmed'] THEN
    RAISE EXCEPTION 'super_batch_status labels: %', labels;
  END IF;
END $$;

INSERT INTO public.organizations (id, name)
VALUES ('0d000000-0000-4000-8000-000000000001', 'Super Org');

INSERT INTO public.super_batches (id, organization_id, fy_start_year, quarter, status, line_count, total_super_cents,
                                  transport_mode, transport_response)
VALUES ('92d00000-0000-4000-8000-000000000001', '0d000000-0000-4000-8000-000000000001', 2030, 1, 'file_prepared',
        1, 12000, 'clearing_house_file', '{"live_dispatch_enabled": false, "manual_upload_required": true}');

DO $$
DECLARE
  refused boolean := false;
  draft_id uuid;
BEGIN
  BEGIN
    PERFORM public.generate_super_batch('0d000000-0000-4000-8000-000000000001', 2030, 1);
  EXCEPTION WHEN raise_exception THEN
    refused := SQLERRM LIKE '%already has a prepared clearing-house file%';
  END;
  IF NOT refused THEN
    RAISE EXCEPTION 'generate_super_batch rebuilt a quarter whose clearing-house file was already prepared';
  END IF;
  IF (SELECT status FROM public.super_batches WHERE id = '92d00000-0000-4000-8000-000000000001') <> 'file_prepared' THEN
    RAISE EXCEPTION 'the prepared batch was changed';
  END IF;

  -- Another quarter with nothing prepared still builds a draft.
  draft_id := public.generate_super_batch('0d000000-0000-4000-8000-000000000001', 2030, 2);
  IF (SELECT status FROM public.super_batches WHERE id = draft_id) <> 'draft' THEN
    RAISE EXCEPTION 'a new quarter did not build as draft';
  END IF;

  RAISE NOTICE 'super-batch-file-prepared: enum order, prepared-quarter lock and draft build all hold';
END $$;

ROLLBACK;
