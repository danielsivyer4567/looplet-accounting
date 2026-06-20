-- 0005 (BACKFILL): Intake taxonomy — enums, intake_categories, intake_known_senders.
--
-- RECONSTRUCTION NOTE: These objects exist in the LIVE database (project ref
-- dxoikltymmknxqpkpyhi) but had no CREATE statement in any repo migration. They are
-- reconstructed verbatim from the live schema via the Supabase MCP (read-only) on
-- 2026-06-20. Several later migrations (0006, 0008, 0010, 0011, 0049) FK-reference
-- intake_categories(code), and 0013 builds functions on top of these tables, so they
-- MUST exist before those run. This file is idempotent
-- (IF NOT EXISTS / DO-block guards) and safe to apply on the live DB.
--
-- See docs/MIGRATION_GAP_AUDIT.md for the full gap analysis.

-- ---------------------------------------------------------------------------
-- Enum types used by intake / staging / banking objects
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE public.staged_entity_kind AS ENUM
    ('supplier','contractor','customer','personal','subscription','internal_admin','unknown');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.staged_entity_status AS ENUM
    ('pending','approved','dismissed','needs_review');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- intake_categories — global category taxonomy (no org scoping; PK = code)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.intake_categories (
  code              text NOT NULL,
  label             text NOT NULL,
  xero_account_code text,
  xero_tax_type     text,
  description       text,
  is_business       boolean NOT NULL DEFAULT true,
  side              text NOT NULL DEFAULT 'expense',
  sort_order        integer NOT NULL DEFAULT 0,
  CONSTRAINT intake_categories_pkey PRIMARY KEY (code)
);

ALTER TABLE public.intake_categories ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY intake_categories_select ON public.intake_categories
    FOR SELECT TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- intake_known_senders — global directory of known email senders/brands.
-- Required by function public.lookup_known_sender (backfilled in 0013).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.intake_known_senders (
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  domain         text NOT NULL,
  sender_pattern text,
  brand_name     text NOT NULL,
  parent_brand   text,
  kind           public.staged_entity_kind NOT NULL,
  category_code  text,
  arm            text NOT NULL,
  is_marketing   boolean NOT NULL DEFAULT false,
  confidence     numeric NOT NULL DEFAULT 1.0,
  country        text,
  source         text NOT NULL DEFAULT 'manual',
  notes          text,
  verified_at    timestamptz DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT intake_known_senders_pkey PRIMARY KEY (id),
  CONSTRAINT intake_known_senders_arm_check
    CHECK (arm = ANY (ARRAY['invoice','marketing','support','statement','mixed'])),
  CONSTRAINT intake_known_senders_confidence_check
    CHECK (confidence >= 0 AND confidence <= 1),
  CONSTRAINT intake_known_senders_category_code_fkey
    FOREIGN KEY (category_code) REFERENCES public.intake_categories(code)
);

CREATE INDEX IF NOT EXISTS idx_known_senders_domain
  ON public.intake_known_senders USING btree (domain);
CREATE INDEX IF NOT EXISTS idx_known_senders_parent_brand
  ON public.intake_known_senders USING btree (parent_brand);
CREATE INDEX IF NOT EXISTS idx_known_senders_marketing
  ON public.intake_known_senders USING btree (is_marketing) WHERE is_marketing;
CREATE UNIQUE INDEX IF NOT EXISTS idx_known_senders_unique
  ON public.intake_known_senders USING btree (domain, COALESCE(sender_pattern, ''::text));

ALTER TABLE public.intake_known_senders ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY known_senders_select ON public.intake_known_senders
    FOR SELECT TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
