-- 0034: Quality / data-hygiene views.
-- v_duplicate_bills      — rows likely to be duplicate uploads (same supplier + invoice_date + amount)
-- v_low_confidence_bills — bills needing manual review (low OCR confidence, missing fields, future-dated)

CREATE OR REPLACE VIEW public.v_duplicate_bills AS
WITH grouped AS (
  SELECT organization_id, supplier_id, invoice_date, total_inc_gst_cents,
         array_agg(id ORDER BY created_at) AS bill_ids,
         COUNT(*) AS dup_count
  FROM public.bills
  WHERE deleted_at IS NULL
    AND supplier_id IS NOT NULL
    AND invoice_date IS NOT NULL
    AND total_inc_gst_cents IS NOT NULL
    AND total_inc_gst_cents > 0
  GROUP BY organization_id, supplier_id, invoice_date, total_inc_gst_cents
  HAVING COUNT(*) > 1
)
SELECT * FROM grouped;

CREATE OR REPLACE VIEW public.v_low_confidence_bills AS
SELECT
  id, organization_id, supplier_name_raw, invoice_number, invoice_date,
  total_inc_gst_cents, ocr_provider, ocr_confidence, status, created_at
FROM public.bills
WHERE deleted_at IS NULL
  AND status NOT IN ('paid', 'void')
  AND (
    ocr_confidence IS NOT NULL AND ocr_confidence < 0.6
    OR supplier_name_raw IS NULL
    OR total_inc_gst_cents IS NULL
    OR (total_inc_gst_cents = 0 AND status != 'void')
    OR (invoice_date IS NOT NULL AND invoice_date > CURRENT_DATE + interval '7 days')
  );
