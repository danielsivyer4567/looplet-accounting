-- 0215_document_extraction_versions.sql
-- Append-only log of every OCR/extraction run on a bill.
-- bills-extract writes one row per run; rows are never updated or deleted.
-- RLS: org members read-only via get_accessible_org_ids(); service_role writes.

CREATE TABLE IF NOT EXISTS public.document_extraction_versions (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id          uuid        NOT NULL REFERENCES public.bills(id) ON DELETE CASCADE,
  organization_id  uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  provider         text        NOT NULL,
  model            text,
  method           text        NOT NULL CHECK (method IN ('cache', 'text', 'vision')),
  confidence       numeric(4,3),
  extracted_json   jsonb       NOT NULL DEFAULT '{}',
  field_confidence jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.document_extraction_versions IS
  'Append-only extraction history for bills. Each row preserves raw extracted '
  'JSON and provider/confidence so confidence improvements can be audited.';

ALTER TABLE public.document_extraction_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org members read own extraction versions"
  ON public.document_extraction_versions
  FOR SELECT
  TO authenticated
  USING (organization_id IN (SELECT public.get_accessible_org_ids()));

-- service_role bypasses RLS — bills-extract writes via service_role client.

CREATE INDEX IF NOT EXISTS idx_dev_bill_id_created
  ON public.document_extraction_versions (bill_id, created_at DESC);
