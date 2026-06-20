-- 0009 (BACKFILL): gmail_integrations.
--
-- RECONSTRUCTION NOTE: Exists in the LIVE DB but had no repo migration. Used by the
-- gmail-* edge functions (.from('gmail_integrations')). Reconstructed verbatim from the
-- live schema (read-only MCP, 2026-06-20). Idempotent and safe to apply.
-- See docs/MIGRATION_GAP_AUDIT.md.

CREATE TABLE IF NOT EXISTS public.gmail_integrations (
  id                      uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id         uuid NOT NULL,
  gmail_address           text NOT NULL,
  encrypted_refresh_token text NOT NULL,
  encrypted_access_token  text,
  access_token_expires_at timestamptz,
  last_history_id         bigint,
  watch_expires_at        timestamptz,
  allowlist               text[] NOT NULL DEFAULT '{}'::text[],
  is_active               boolean NOT NULL DEFAULT true,
  last_error              text,
  last_synced_at          timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  created_by              uuid,
  CONSTRAINT gmail_integrations_pkey PRIMARY KEY (id),
  CONSTRAINT gmail_integrations_organization_id_gmail_address_key
    UNIQUE (organization_id, gmail_address),
  CONSTRAINT gmail_integrations_organization_id_fkey
    FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE,
  CONSTRAINT gmail_integrations_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_gmail_integrations_org
  ON public.gmail_integrations USING btree (organization_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_gmail_integrations_address
  ON public.gmail_integrations USING btree (gmail_address) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_gmail_integrations_renew
  ON public.gmail_integrations USING btree (watch_expires_at) WHERE is_active;

ALTER TABLE public.gmail_integrations ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY gmail_integrations_select ON public.gmail_integrations
    FOR SELECT TO authenticated
    USING (organization_id IN (SELECT public.get_accessible_org_ids()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY gmail_integrations_insert ON public.gmail_integrations
    FOR INSERT TO authenticated
    WITH CHECK (organization_id IN (SELECT public.get_accessible_org_ids()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY gmail_integrations_update ON public.gmail_integrations
    FOR UPDATE TO authenticated
    USING (organization_id IN (SELECT public.get_accessible_org_ids()))
    WITH CHECK (organization_id IN (SELECT public.get_accessible_org_ids()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY gmail_integrations_delete ON public.gmail_integrations
    FOR DELETE TO authenticated
    USING (organization_id IN (SELECT public.get_accessible_org_ids()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
