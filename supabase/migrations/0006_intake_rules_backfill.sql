-- 0006 (BACKFILL): intake_rules — per-org email/intake routing rules.
--
-- RECONSTRUCTION NOTE: Exists in the LIVE DB but had no repo migration. Migration
-- 0036 (intake_routing_apply) creates indexes on this table and 0036/bank_transactions
-- FK-reference intake_rules(id). Reconstructed verbatim from the live schema (read-only
-- MCP, 2026-06-20). Idempotent and safe to apply. See docs/MIGRATION_GAP_AUDIT.md.

CREATE TABLE IF NOT EXISTS public.intake_rules (
  id                         uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id            uuid NOT NULL,
  matcher_type               text NOT NULL,
  matcher_value              text NOT NULL,
  matcher_priority           integer NOT NULL DEFAULT 100,
  category_code              text,
  supplier_id                uuid,
  customer_id                uuid,
  job_id                     uuid,
  xero_account_code_override text,
  xero_tax_type_override     text,
  is_personal                boolean NOT NULL DEFAULT false,
  skip_ocr                   boolean NOT NULL DEFAULT false,
  hit_count                  integer NOT NULL DEFAULT 0,
  last_matched_at            timestamptz,
  is_active                  boolean NOT NULL DEFAULT true,
  notes                      text,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  created_by                 uuid,
  CONSTRAINT intake_rules_pkey PRIMARY KEY (id),
  CONSTRAINT intake_rules_matcher_type_check CHECK (matcher_type = ANY (ARRAY[
    'sender_address','sender_domain','sender_name','subject_pattern','attachment_name','body_keyword'])),
  CONSTRAINT intake_rules_organization_id_fkey
    FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE,
  CONSTRAINT intake_rules_category_code_fkey
    FOREIGN KEY (category_code) REFERENCES public.intake_categories(code),
  CONSTRAINT intake_rules_supplier_id_fkey
    FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id) ON DELETE SET NULL,
  CONSTRAINT intake_rules_customer_id_fkey
    FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL,
  CONSTRAINT intake_rules_job_id_fkey
    FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE SET NULL,
  CONSTRAINT intake_rules_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_intake_rules_org_active
  ON public.intake_rules USING btree (organization_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_intake_rules_lookup
  ON public.intake_rules USING btree (organization_id, matcher_type, matcher_value) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_intake_rules_priority
  ON public.intake_rules USING btree (organization_id, matcher_priority) WHERE is_active;

ALTER TABLE public.intake_rules ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY intake_rules_select ON public.intake_rules
    FOR SELECT TO authenticated
    USING (organization_id IN (SELECT public.get_accessible_org_ids()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY intake_rules_insert ON public.intake_rules
    FOR INSERT TO authenticated
    WITH CHECK (organization_id IN (SELECT public.get_accessible_org_ids()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY intake_rules_update ON public.intake_rules
    FOR UPDATE TO authenticated
    USING (organization_id IN (SELECT public.get_accessible_org_ids()))
    WITH CHECK (organization_id IN (SELECT public.get_accessible_org_ids()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY intake_rules_delete ON public.intake_rules
    FOR DELETE TO authenticated
    USING (organization_id IN (SELECT public.get_accessible_org_ids()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
