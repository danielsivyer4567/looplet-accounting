-- 0011 (BACKFILL): subscriptions — recurring-spend detection.
--
-- RECONSTRUCTION NOTE: Exists in the LIVE DB but had no repo migration. Referenced by
-- the subscriptions-detect / notifications-cron edge functions and by migration 0047
-- (split_resource_type enum + v_subscription_effective_allocations view). Reconstructed
-- verbatim from the live schema (read-only MCP, 2026-06-20). Idempotent and safe.
-- See docs/MIGRATION_GAP_AUDIT.md.

DO $$ BEGIN
  CREATE TYPE public.subscription_cadence AS ENUM
    ('weekly','fortnightly','monthly','quarterly','yearly','irregular');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.subscription_status AS ENUM
    ('candidate','confirmed','dismissed','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.subscriptions (
  id                     uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id        uuid NOT NULL,
  merchant_name          text NOT NULL,
  merchant_canonical_key text,
  supplier_id            uuid,
  category_code          text,
  cadence                public.subscription_cadence NOT NULL DEFAULT 'monthly',
  amount_cents           bigint,
  amount_variance_pct    numeric(5,2),
  currency_code          char(3) NOT NULL DEFAULT 'AUD',
  status                 public.subscription_status NOT NULL DEFAULT 'candidate',
  confidence             numeric(3,2) NOT NULL DEFAULT 0.0,
  first_seen_at          timestamptz,
  last_seen_at           timestamptz,
  next_expected_at       date,
  observed_count         integer NOT NULL DEFAULT 0,
  total_spent_cents      bigint NOT NULL DEFAULT 0,
  detection_reason       text,
  is_personal            boolean NOT NULL DEFAULT false,
  is_business            boolean NOT NULL DEFAULT true,
  notes                  text,
  reviewed_at            timestamptz,
  reviewed_by            uuid,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscriptions_pkey PRIMARY KEY (id),
  CONSTRAINT subscriptions_organization_id_fkey
    FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE,
  CONSTRAINT subscriptions_supplier_id_fkey
    FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id) ON DELETE SET NULL,
  CONSTRAINT subscriptions_category_code_fkey
    FOREIGN KEY (category_code) REFERENCES public.intake_categories(code),
  CONSTRAINT subscriptions_reviewed_by_fkey
    FOREIGN KEY (reviewed_by) REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_subs_org_status
  ON public.subscriptions USING btree (organization_id, status);
CREATE INDEX IF NOT EXISTS idx_subs_merchant_key
  ON public.subscriptions USING btree (organization_id, merchant_canonical_key)
  WHERE (merchant_canonical_key IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_subs_next_expected
  ON public.subscriptions USING btree (organization_id, next_expected_at)
  WHERE (status = 'confirmed'::public.subscription_status);

ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY subs_all ON public.subscriptions
    FOR ALL TO authenticated
    USING (organization_id IN (SELECT public.get_accessible_org_ids()))
    WITH CHECK (organization_id IN (SELECT public.get_accessible_org_ids()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
