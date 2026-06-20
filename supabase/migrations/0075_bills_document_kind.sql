-- 0075: Classify ingested documents; keep non-invoices off the active surface.
--
-- Part of EPIC D (intake classifier). Verified from live data: ~217 of 247
-- rows in `bills` are NOT invoices — they're supplier logos, "Pay Now" UI
-- buttons, app/scan icons, email-signature images, and (this is a fencing
-- business) photos of completed fences / job sites that intake mis-filed as
-- bills. The OCR already recognises these (MiniMax returns confidence='low'
-- with notes like "not a financial document", "pure logo", "photo of a fence").
--
-- This adds two columns, persisted by bills-extract's persistExtraction:
--   document_kind     — what the model thinks the document is (enum-as-text)
--   is_probable_bill  — false for non-financial kinds (logo/photo/ui_screenshot/
--                       other) OR a low-confidence empty extraction (no total
--                       AND no supplier). Defaults true so existing rows and
--                       any uncertain extraction stay visible until reviewed.
--
-- Nothing is deleted. is_probable_bill=false simply defaults a row out of the
-- active bills list (0076 also takes it out of BAS scope); a "Show non-invoices"
-- toggle can still surface it.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.

ALTER TABLE public.bills
  ADD COLUMN IF NOT EXISTS document_kind text,
  ADD COLUMN IF NOT EXISTS is_probable_bill boolean NOT NULL DEFAULT true;

-- Constrain document_kind to the classifier's vocabulary (NULL allowed for
-- rows ingested before classification ran). Drop-then-add keeps it idempotent.
ALTER TABLE public.bills
  DROP CONSTRAINT IF EXISTS bills_document_kind_check;
ALTER TABLE public.bills
  ADD CONSTRAINT bills_document_kind_check
  CHECK (
    document_kind IS NULL OR document_kind IN (
      'invoice', 'quote', 'receipt', 'statement', 'order',
      'logo', 'photo', 'ui_screenshot', 'other'
    )
  );

COMMENT ON COLUMN public.bills.document_kind IS
  'What the OCR classifier thinks this document is: invoice|quote|receipt|statement|order (financial) or logo|photo|ui_screenshot|other (noise). NULL = ingested before classification.';
COMMENT ON COLUMN public.bills.is_probable_bill IS
  'false when document_kind is non-financial (logo/photo/ui_screenshot/other) OR a low-confidence extraction with no total and no supplier. Such rows are hidden from the active bills list and excluded from BAS scope; nothing is deleted.';

-- Partial index for the default list query, which filters is_probable_bill=true.
CREATE INDEX IF NOT EXISTS bills_probable_idx
  ON public.bills (organization_id, created_at DESC)
  WHERE is_probable_bill = true AND deleted_at IS NULL;
