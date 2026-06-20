-- 0058: Flag estimated (derived) GST on bills.
--
-- Part of EPIC B (fill the books). When OCR captures a total but the supplier
-- didn't itemise GST, bills-extract now derives GST (AU 1/11 of the inclusive
-- total) so the books and BAS fill. `gst_estimated` marks those rows so the
-- BAS coverage gate (0059) and human review can correct GST-free exceptions
-- (fresh food, some services, overseas supplies) before lodgement.
--
-- GST read verbatim off the document → gst_estimated = false.
-- GST inferred from total (or total − subtotal) → gst_estimated = true.

ALTER TABLE public.bills
  ADD COLUMN IF NOT EXISTS gst_estimated boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.bills.gst_estimated IS
  'true when gst_cents was derived (1/11 of total, or total − subtotal) rather than read off the document. Surfaced for BAS review before lodgement.';
