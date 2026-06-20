-- 0010 (BACKFILL): staged_entities — onboarding/email-mining staging.
--
-- RECONSTRUCTION NOTE: Exists in the LIVE DB but had no repo migration. Migration 0049
-- ALTERs it (adds sonar_* columns + sonar_suggested_category FK + a partial index);
-- those columns/index are created up front here so 0049's ADD COLUMN IF NOT EXISTS /
-- CREATE INDEX IF NOT EXISTS no-op. Reconstructed verbatim from the live schema
-- (read-only MCP, 2026-06-20). Idempotent and safe. See docs/MIGRATION_GAP_AUDIT.md.

CREATE TABLE IF NOT EXISTS public.staged_entities (
  id                       uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id          uuid NOT NULL,
  canonical_key            text NOT NULL,
  display_name             text NOT NULL,
  primary_email            text,
  observed_emails          text[] NOT NULL DEFAULT '{}'::text[],
  observed_domains         text[] NOT NULL DEFAULT '{}'::text[],
  abn                      text,
  message_count            integer NOT NULL DEFAULT 0,
  attachment_count         integer NOT NULL DEFAULT 0,
  total_amount_seen_cents  bigint,
  first_seen_at            timestamptz,
  last_seen_at             timestamptz,
  sample_subjects          text[] NOT NULL DEFAULT '{}'::text[],
  sample_message_ids       text[] NOT NULL DEFAULT '{}'::text[],
  predicted_kind           public.staged_entity_kind NOT NULL DEFAULT 'unknown',
  predicted_category       text,
  prediction_reason        text,
  confidence               numeric(3,2) NOT NULL DEFAULT 0.0,
  status                   public.staged_entity_status NOT NULL DEFAULT 'pending',
  user_kind                public.staged_entity_kind,
  user_category            text,
  resolved_supplier_id     uuid,
  resolved_customer_id     uuid,
  resolved_rule_id         uuid,
  reviewed_at              timestamptz,
  reviewed_by              uuid,
  is_recurring             boolean NOT NULL DEFAULT false,
  recurrence_period_days   integer,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  extracted_supplier_name  text,
  sonar_summary            text,
  sonar_suggested_kind     public.staged_entity_kind,
  sonar_suggested_category text,
  sonar_confidence         numeric(3,2),
  sonar_evidence_url       text,
  sonar_enriched_at        timestamptz,
  CONSTRAINT staged_entities_pkey PRIMARY KEY (id),
  CONSTRAINT staged_entities_organization_id_canonical_key_key
    UNIQUE (organization_id, canonical_key),
  CONSTRAINT staged_entities_confidence_check
    CHECK (confidence >= 0::numeric AND confidence <= 1::numeric),
  CONSTRAINT staged_entities_organization_id_fkey
    FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE,
  CONSTRAINT staged_entities_predicted_category_fkey
    FOREIGN KEY (predicted_category) REFERENCES public.intake_categories(code),
  CONSTRAINT staged_entities_user_category_fkey
    FOREIGN KEY (user_category) REFERENCES public.intake_categories(code),
  CONSTRAINT staged_entities_sonar_suggested_category_fkey
    FOREIGN KEY (sonar_suggested_category) REFERENCES public.intake_categories(code),
  CONSTRAINT staged_entities_resolved_supplier_id_fkey
    FOREIGN KEY (resolved_supplier_id) REFERENCES public.suppliers(id) ON DELETE SET NULL,
  CONSTRAINT staged_entities_resolved_customer_id_fkey
    FOREIGN KEY (resolved_customer_id) REFERENCES public.customers(id) ON DELETE SET NULL,
  CONSTRAINT staged_entities_resolved_rule_id_fkey
    FOREIGN KEY (resolved_rule_id) REFERENCES public.intake_rules(id) ON DELETE SET NULL,
  CONSTRAINT staged_entities_reviewed_by_fkey
    FOREIGN KEY (reviewed_by) REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_staged_entities_org_status
  ON public.staged_entities USING btree (organization_id, status);
CREATE INDEX IF NOT EXISTS idx_staged_entities_org_kind
  ON public.staged_entities USING btree (organization_id, predicted_kind);
CREATE INDEX IF NOT EXISTS idx_staged_entities_message_count
  ON public.staged_entities USING btree (organization_id, message_count DESC);
CREATE INDEX IF NOT EXISTS idx_staged_entities_review
  ON public.staged_entities USING btree (organization_id)
  WHERE ((status = 'pending'::public.staged_entity_status) OR (status = 'needs_review'::public.staged_entity_status));

ALTER TABLE public.staged_entities ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY staged_entities_select ON public.staged_entities
    FOR SELECT TO authenticated
    USING (organization_id IN (SELECT public.get_accessible_org_ids()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY staged_entities_insert ON public.staged_entities
    FOR INSERT TO authenticated
    WITH CHECK (organization_id IN (SELECT public.get_accessible_org_ids()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY staged_entities_update ON public.staged_entities
    FOR UPDATE TO authenticated
    USING (organization_id IN (SELECT public.get_accessible_org_ids()))
    WITH CHECK (organization_id IN (SELECT public.get_accessible_org_ids()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY staged_entities_delete ON public.staged_entities
    FOR DELETE TO authenticated
    USING (organization_id IN (SELECT public.get_accessible_org_ids()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
