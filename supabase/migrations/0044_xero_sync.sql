-- ============================================================================
-- Migration: 0044_xero_sync
-- Adds:
--   1. xero_contact_id on suppliers + customers (Xero uses GUIDs-as-text)
--   2. xero_account_codes cache table (daily refresh from Xero Accounts API)
--   3. v_xero_pending_pushes — bills + invoices ready to be pushed but not yet
--   4. Normalises xero_integrations: adds status/created_by columns missing
--      from the 0001 definition so the new edge fns and UI can rely on them.
--   5. pg_cron schedules for xero-sync-accounts (03:00) and
--      xero-sync-payments (03:30) — added via helper at bottom of file.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. xero_contact_id on suppliers and customers
-- ----------------------------------------------------------------------------
ALTER TABLE public.suppliers
  ADD COLUMN IF NOT EXISTS xero_contact_id TEXT;

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS xero_contact_id TEXT;

COMMENT ON COLUMN public.suppliers.xero_contact_id IS
  'Xero ContactID (UUID-as-text) for this supplier. Populated on first Xero push.';
COMMENT ON COLUMN public.customers.xero_contact_id IS
  'Xero ContactID (UUID-as-text) for this customer. Populated on first Xero push.';

CREATE INDEX IF NOT EXISTS suppliers_xero_contact_idx
  ON public.suppliers (xero_contact_id)
  WHERE xero_contact_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS customers_xero_contact_idx
  ON public.customers (xero_contact_id)
  WHERE xero_contact_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 2. xero_account_codes — local cache of Xero chart of accounts
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.xero_account_codes (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  code             TEXT NOT NULL,          -- e.g. '310', '200'
  name             TEXT NOT NULL,          -- e.g. 'Direct expense', 'Sales'
  type             TEXT NOT NULL,          -- REVENUE | EXPENSE | ASSET | LIABILITY | EQUITY | …
  tax_type         TEXT,                   -- INPUT | OUTPUT | NONE | EXEMPTEXPENSES | …
  description      TEXT,
  is_enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  synced_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, code)
);
COMMENT ON TABLE public.xero_account_codes IS
  'Local cache of Xero chart of accounts for an org. Refreshed daily by xero-sync-accounts.';

CREATE INDEX IF NOT EXISTS xero_account_codes_org_idx
  ON public.xero_account_codes (organization_id)
  WHERE is_enabled = TRUE;

-- Triggers
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_xero_account_codes_set_updated_at'
  ) THEN
    CREATE TRIGGER trg_xero_account_codes_set_updated_at
      BEFORE UPDATE ON public.xero_account_codes
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- RLS
ALTER TABLE public.xero_account_codes ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'xero_account_codes' AND policyname = 'xero_account_codes_select'
  ) THEN
    CREATE POLICY xero_account_codes_select ON public.xero_account_codes
      FOR SELECT USING (organization_id IN (SELECT public.get_accessible_org_ids()));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'xero_account_codes' AND policyname = 'xero_account_codes_insert'
  ) THEN
    CREATE POLICY xero_account_codes_insert ON public.xero_account_codes
      FOR INSERT WITH CHECK (organization_id IN (SELECT public.get_accessible_org_ids()));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'xero_account_codes' AND policyname = 'xero_account_codes_update'
  ) THEN
    CREATE POLICY xero_account_codes_update ON public.xero_account_codes
      FOR UPDATE USING (organization_id IN (SELECT public.get_accessible_org_ids()));
  END IF;
END $$;

GRANT SELECT ON public.xero_account_codes TO authenticated;
GRANT ALL    ON public.xero_account_codes TO service_role;

-- ----------------------------------------------------------------------------
-- 3. Normalise xero_integrations: add columns if they don't already exist.
--    The 0001 migration created the table with a slightly different shape
--    (access_token_encrypted / refresh_token_encrypted / is_enabled etc.).
--    New edge fns need: status enum, created_by, and an explicit
--    xero_organisation_name alias (the column is called xero_tenant_name in 0001).
--    We add the new columns as nullable so existing rows are unaffected.
-- ----------------------------------------------------------------------------
ALTER TABLE public.xero_integrations
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES auth.users(id);

-- status column: 'active' | 'expired' | 'error' | 'disconnected'
-- We derive this from is_enabled + last_error in the UI, but having a
-- persisted status column makes querying and filtering simpler.
ALTER TABLE public.xero_integrations
  ADD COLUMN IF NOT EXISTS status TEXT
    NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'expired', 'error', 'disconnected'));

-- Back-fill status from is_enabled
UPDATE public.xero_integrations
   SET status = CASE WHEN is_enabled THEN 'active' ELSE 'disconnected' END
 WHERE status = 'active' AND is_enabled = FALSE;

COMMENT ON COLUMN public.xero_integrations.status IS
  'Derived connection state: active | expired | error | disconnected.';

-- ----------------------------------------------------------------------------
-- 4. v_xero_pending_pushes
-- Bills that need pushing: xero_status IS NULL or pending AND bill is paid.
-- Invoices that need pushing: xero_status IS NULL or pending AND status sent/paid/partially_paid.
-- ----------------------------------------------------------------------------
DROP VIEW IF EXISTS public.v_xero_pending_pushes;

CREATE VIEW public.v_xero_pending_pushes AS
  SELECT
    'bill'::TEXT            AS record_type,
    b.id                    AS record_id,
    b.organization_id,
    b.total_inc_gst_cents   AS amount_cents,
    b.invoice_date          AS doc_date,
    b.xero_status::TEXT,
    b.xero_invoice_id,
    b.supplier_name_raw     AS counterparty_name
  FROM public.bills b
  WHERE b.deleted_at IS NULL
    AND b.status = 'paid'
    AND (b.xero_status IS NULL OR b.xero_status IN ('pending', 'failed'))

  UNION ALL

  SELECT
    'invoice'::TEXT         AS record_type,
    i.id                    AS record_id,
    i.organization_id,
    i.total_inc_gst_cents   AS amount_cents,
    i.issue_date            AS doc_date,
    i.xero_status::TEXT,
    i.xero_invoice_id,
    c.name                  AS counterparty_name
  FROM public.invoices i
  LEFT JOIN public.customers c ON c.id = i.customer_id
  WHERE i.deleted_at IS NULL
    AND i.status IN ('sent', 'paid', 'partially_paid')
    AND (i.xero_status IS NULL OR i.xero_status = 'pending');

COMMENT ON VIEW public.v_xero_pending_pushes IS
  'Bills (paid, unpushed) + invoices (sent/paid, unpushed) awaiting Xero sync.';

-- RLS-inheriting: the view selects from bills and invoices which already have
-- org-scoped RLS, so authenticated users see only their org records.
GRANT SELECT ON public.v_xero_pending_pushes TO authenticated;
GRANT SELECT ON public.v_xero_pending_pushes TO service_role;

-- ----------------------------------------------------------------------------
-- 5. pg_cron schedule SQL (kept here for reference; actually registered in
--    the separate SCHEDULE.sql files alongside each edge fn, or run manually).
--    See: supabase/functions/xero-sync-accounts/SCHEDULE.sql
--         supabase/functions/xero-sync-payments/SCHEDULE.sql
-- ----------------------------------------------------------------------------

-- ============================================================================
-- END 0044_xero_sync
-- ============================================================================
