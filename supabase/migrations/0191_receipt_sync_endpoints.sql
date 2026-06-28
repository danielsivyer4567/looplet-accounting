-- 0191_receipt_sync_endpoints.sql
-- Org-scoped destination config for the generic_api receipt sync adapter.
-- Holds the endpoint URL + an HMAC signing secret used by receipt-sync-dispatch
-- to deliver a signed bill payload. The signing secret is sensitive, so this
-- table is SERVICE-ROLE-ONLY: RLS grants no access to authenticated/anon and the
-- table grants are revoked from them explicitly (default privileges would
-- otherwise grant authenticated SELECT/INSERT/etc per [[definer-fn-grant-gotcha]]).
-- receipt-sync-dispatch runs as service_role and reads it directly. A future
-- slice can add a secret-safe management surface (view of non-secret columns +
-- a SECURITY DEFINER setter) if org self-service is wanted.

CREATE TABLE IF NOT EXISTS public.receipt_sync_endpoints (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  provider         text NOT NULL DEFAULT 'generic_api',
  endpoint_url     text NOT NULL,
  signing_secret   text NOT NULL,
  is_enabled       boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT receipt_sync_endpoints_provider_check
    CHECK (provider IN ('generic_api')),
  CONSTRAINT receipt_sync_endpoints_url_check
    CHECK (endpoint_url ~* '^https://'),
  UNIQUE (organization_id, provider)
);

CREATE INDEX IF NOT EXISTS receipt_sync_endpoints_org_idx
  ON public.receipt_sync_endpoints (organization_id)
  WHERE is_enabled;

ALTER TABLE public.receipt_sync_endpoints ENABLE ROW LEVEL SECURITY;

-- No RLS policies = no authenticated/anon access. service_role bypasses RLS.
-- Belt-and-braces: revoke the default table privileges from the client roles so
-- the secret column can never be selected by a logged-in user.
REVOKE ALL ON public.receipt_sync_endpoints FROM authenticated;
REVOKE ALL ON public.receipt_sync_endpoints FROM anon;

DROP TRIGGER IF EXISTS trg_receipt_sync_endpoints_updated_at ON public.receipt_sync_endpoints;
CREATE TRIGGER trg_receipt_sync_endpoints_updated_at
  BEFORE UPDATE ON public.receipt_sync_endpoints
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
