-- 0088: Receipt Hub first-stage app spine.
--
-- Adds a tokenized receipt identity layer, structured receipt events, immutable
-- audit package storage, and provider sync jobs. The phone/pass token is
-- returned once by issue_receipt_identity(); only a hash is stored.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.receipt_identities (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  label            text NOT NULL DEFAULT 'Receipt pass',
  channel          text NOT NULL DEFAULT 'phone-pass',
  token_prefix     text NOT NULL UNIQUE,
  token_hash       text NOT NULL,
  status           text NOT NULL DEFAULT 'active',
  last_used_at     timestamptz,
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES auth.users(id),
  revoked_at       timestamptz,
  CONSTRAINT receipt_identities_channel_check
    CHECK (channel IN ('phone-pass', 'tag', 'pos', 'epost')),
  CONSTRAINT receipt_identities_status_check
    CHECK (status IN ('active', 'revoked', 'expired'))
);

CREATE INDEX IF NOT EXISTS receipt_identities_org_idx
  ON public.receipt_identities (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS receipt_identities_active_token_idx
  ON public.receipt_identities (token_prefix)
  WHERE status = 'active' AND revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS public.receipt_events (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  receipt_identity_id   uuid REFERENCES public.receipt_identities(id) ON DELETE SET NULL,
  bill_id               uuid REFERENCES public.bills(id) ON DELETE SET NULL,
  job_id                uuid REFERENCES public.jobs(id) ON DELETE SET NULL,
  source_channel        text NOT NULL DEFAULT 'pos',
  status                text NOT NULL DEFAULT 'received',
  merchant_name         text NOT NULL,
  merchant_abn          text,
  merchant_external_id  text,
  receipt_number        text,
  purchase_at           timestamptz NOT NULL DEFAULT now(),
  location              jsonb NOT NULL DEFAULT '{}'::jsonb,
  subtotal_ex_gst_cents bigint,
  gst_cents             bigint,
  total_inc_gst_cents   bigint NOT NULL CHECK (total_inc_gst_cents >= 0),
  currency_code         char(3) NOT NULL DEFAULT 'AUD',
  payment_method        text,
  payment_last4         text,
  business_use          text NOT NULL DEFAULT 'review',
  deductibility_status  text NOT NULL DEFAULT 'requires_review',
  job_reference_raw     text,
  raw_payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
  classification        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT receipt_events_source_check
    CHECK (source_channel IN ('phone-pass', 'tag', 'pos', 'epost', 'email', 'photo', 'manual')),
  CONSTRAINT receipt_events_status_check
    CHECK (status IN ('received', 'processed', 'flagged', 'personal', 'failed')),
  CONSTRAINT receipt_events_business_use_check
    CHECK (business_use IN ('business', 'personal', 'mixed', 'review')),
  CONSTRAINT receipt_events_deductibility_check
    CHECK (deductibility_status IN ('deductible', 'non_deductible', 'requires_review', 'personal'))
);

CREATE UNIQUE INDEX IF NOT EXISTS receipt_events_org_merchant_receipt_uniq
  ON public.receipt_events (organization_id, merchant_name, receipt_number)
  WHERE receipt_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS receipt_events_org_time_idx
  ON public.receipt_events (organization_id, purchase_at DESC);
CREATE INDEX IF NOT EXISTS receipt_events_bill_idx
  ON public.receipt_events (bill_id)
  WHERE bill_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.receipt_event_line_items (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  receipt_event_id         uuid NOT NULL REFERENCES public.receipt_events(id) ON DELETE CASCADE,
  line_number              integer NOT NULL,
  description              text NOT NULL,
  quantity                 numeric(12,3) NOT NULL DEFAULT 1,
  unit_price_cents         bigint NOT NULL DEFAULT 0,
  total_inc_gst_cents      bigint NOT NULL DEFAULT 0,
  gst_cents                bigint NOT NULL DEFAULT 0,
  category                 text,
  metadata                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (receipt_event_id, line_number)
);

CREATE INDEX IF NOT EXISTS receipt_event_line_items_event_idx
  ON public.receipt_event_line_items (receipt_event_id);

CREATE TABLE IF NOT EXISTS public.receipt_audit_packages (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  receipt_event_id      uuid NOT NULL REFERENCES public.receipt_events(id) ON DELETE CASCADE,
  bill_id               uuid REFERENCES public.bills(id) ON DELETE SET NULL,
  storage_key           text NOT NULL,
  evidence              jsonb NOT NULL DEFAULT '{}'::jsonb,
  decision_path         jsonb NOT NULL DEFAULT '{}'::jsonb,
  gst_status            text NOT NULL DEFAULT 'estimated',
  deductibility_status  text NOT NULL DEFAULT 'requires_review',
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT receipt_audit_gst_status_check
    CHECK (gst_status IN ('supplied', 'estimated', 'none', 'review')),
  CONSTRAINT receipt_audit_deductibility_check
    CHECK (deductibility_status IN ('deductible', 'non_deductible', 'requires_review', 'personal'))
);

CREATE INDEX IF NOT EXISTS receipt_audit_packages_org_idx
  ON public.receipt_audit_packages (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.receipt_sync_jobs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  receipt_event_id  uuid NOT NULL REFERENCES public.receipt_events(id) ON DELETE CASCADE,
  bill_id           uuid REFERENCES public.bills(id) ON DELETE SET NULL,
  provider          text NOT NULL,
  status            text NOT NULL DEFAULT 'pending',
  attempts          integer NOT NULL DEFAULT 0,
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error        text,
  next_attempt_at   timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT receipt_sync_jobs_provider_check
    CHECK (provider IN ('xero', 'myob', 'quickbooks', 'generic_api')),
  CONSTRAINT receipt_sync_jobs_status_check
    CHECK (status IN ('pending', 'queued', 'synced', 'failed', 'skipped'))
);

CREATE UNIQUE INDEX IF NOT EXISTS receipt_sync_jobs_event_provider_uniq
  ON public.receipt_sync_jobs (receipt_event_id, provider);
CREATE INDEX IF NOT EXISTS receipt_sync_jobs_org_status_idx
  ON public.receipt_sync_jobs (organization_id, status, created_at DESC);

ALTER TABLE public.receipt_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.receipt_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.receipt_event_line_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.receipt_audit_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.receipt_sync_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS receipt_identities_select ON public.receipt_identities;
CREATE POLICY receipt_identities_select ON public.receipt_identities
  FOR SELECT TO authenticated
  USING (organization_id IN (SELECT public.get_accessible_org_ids()));

DROP POLICY IF EXISTS receipt_identities_update ON public.receipt_identities;
CREATE POLICY receipt_identities_update ON public.receipt_identities
  FOR UPDATE TO authenticated
  USING (organization_id IN (SELECT public.get_accessible_org_ids()))
  WITH CHECK (organization_id IN (SELECT public.get_accessible_org_ids()));

DROP POLICY IF EXISTS receipt_events_select ON public.receipt_events;
CREATE POLICY receipt_events_select ON public.receipt_events
  FOR SELECT TO authenticated
  USING (organization_id IN (SELECT public.get_accessible_org_ids()));

DROP POLICY IF EXISTS receipt_event_line_items_select ON public.receipt_event_line_items;
CREATE POLICY receipt_event_line_items_select ON public.receipt_event_line_items
  FOR SELECT TO authenticated
  USING (organization_id IN (SELECT public.get_accessible_org_ids()));

DROP POLICY IF EXISTS receipt_audit_packages_select ON public.receipt_audit_packages;
CREATE POLICY receipt_audit_packages_select ON public.receipt_audit_packages
  FOR SELECT TO authenticated
  USING (organization_id IN (SELECT public.get_accessible_org_ids()));

DROP POLICY IF EXISTS receipt_sync_jobs_select ON public.receipt_sync_jobs;
CREATE POLICY receipt_sync_jobs_select ON public.receipt_sync_jobs
  FOR SELECT TO authenticated
  USING (organization_id IN (SELECT public.get_accessible_org_ids()));

GRANT SELECT ON public.receipt_identities TO authenticated;
GRANT SELECT ON public.receipt_events TO authenticated;
GRANT SELECT ON public.receipt_event_line_items TO authenticated;
GRANT SELECT ON public.receipt_audit_packages TO authenticated;
GRANT SELECT ON public.receipt_sync_jobs TO authenticated;

DROP TRIGGER IF EXISTS trg_receipt_identities_updated_at ON public.receipt_identities;
CREATE TRIGGER trg_receipt_identities_updated_at
  BEFORE UPDATE ON public.receipt_identities
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_receipt_events_updated_at ON public.receipt_events;
CREATE TRIGGER trg_receipt_events_updated_at
  BEFORE UPDATE ON public.receipt_events
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_receipt_sync_jobs_updated_at ON public.receipt_sync_jobs;
CREATE TRIGGER trg_receipt_sync_jobs_updated_at
  BEFORE UPDATE ON public.receipt_sync_jobs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_receipt_identities_audit ON public.receipt_identities;
CREATE TRIGGER trg_receipt_identities_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.receipt_identities
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_trigger_v2();

DROP TRIGGER IF EXISTS trg_receipt_events_audit ON public.receipt_events;
CREATE TRIGGER trg_receipt_events_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.receipt_events
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_trigger_v2();

DROP TRIGGER IF EXISTS trg_receipt_event_line_items_audit ON public.receipt_event_line_items;
CREATE TRIGGER trg_receipt_event_line_items_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.receipt_event_line_items
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_trigger_v2();

DROP TRIGGER IF EXISTS trg_receipt_audit_packages_audit ON public.receipt_audit_packages;
CREATE TRIGGER trg_receipt_audit_packages_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.receipt_audit_packages
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_trigger_v2();

DROP TRIGGER IF EXISTS trg_receipt_sync_jobs_audit ON public.receipt_sync_jobs;
CREATE TRIGGER trg_receipt_sync_jobs_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.receipt_sync_jobs
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_trigger_v2();

CREATE OR REPLACE FUNCTION public.issue_receipt_identity(
  p_organization_id uuid,
  p_label text DEFAULT 'Phone pass',
  p_channel text DEFAULT 'phone-pass'
) RETURNS TABLE(id uuid, receipt_token text, token_prefix text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prefix text;
  v_secret text;
  v_hash text;
  v_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF p_organization_id NOT IN (SELECT public.get_accessible_org_ids()) THEN
    RAISE EXCEPTION 'organization not accessible';
  END IF;
  IF p_channel NOT IN ('phone-pass', 'tag', 'pos', 'epost') THEN
    RAISE EXCEPTION 'unsupported receipt identity channel';
  END IF;

  v_prefix := 'rhp_' || substr(encode(gen_random_bytes(8), 'hex'), 1, 8);
  v_secret := encode(gen_random_bytes(18), 'hex');
  v_hash := encode(digest(v_secret, 'sha256'), 'hex');

  INSERT INTO public.receipt_identities (
    organization_id, label, channel, token_prefix, token_hash, created_by
  ) VALUES (
    p_organization_id, COALESCE(NULLIF(trim(p_label), ''), 'Receipt pass'), p_channel,
    v_prefix, v_hash, auth.uid()
  ) RETURNING receipt_identities.id INTO v_id;

  RETURN QUERY SELECT v_id, (v_prefix || '.' || v_secret), v_prefix;
END;
$$;

GRANT EXECUTE ON FUNCTION public.issue_receipt_identity(uuid, text, text) TO authenticated;

-- Make PostgREST pick up the new RPC immediately after deployment.
NOTIFY pgrst, 'reload schema';
