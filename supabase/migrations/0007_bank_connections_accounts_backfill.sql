-- 0007 (BACKFILL): Banking — enums, bank_connections, bank_accounts.
--
-- RECONSTRUCTION NOTE: Exist in the LIVE DB but had no repo migration. Reconstructed
-- verbatim from the live schema (read-only MCP, 2026-06-20). bank_accounts is referenced
-- by debts (0010) and the reconciliation flows. Idempotent and safe to apply.
-- See docs/MIGRATION_GAP_AUDIT.md.

-- ---------------------------------------------------------------------------
-- Enum types
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE public.bank_provider AS ENUM ('plaid','basiq','manual');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.bank_connection_status AS ENUM ('pending','active','error','expired','revoked');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.bank_account_type AS ENUM
    ('checking','savings','credit_card','loan','investment','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- bank_connections
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.bank_connections (
  id                     uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id        uuid NOT NULL,
  provider               public.bank_provider NOT NULL,
  institution_id         text,
  institution_name       text,
  external_item_id       text,
  encrypted_access_token text NOT NULL,
  next_cursor            text,
  status                 public.bank_connection_status NOT NULL DEFAULT 'pending',
  last_synced_at         timestamptz,
  last_error             text,
  webhook_received_at    timestamptz,
  metadata               jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid,
  CONSTRAINT bank_connections_pkey PRIMARY KEY (id),
  CONSTRAINT bank_connections_organization_id_provider_external_item_id_key
    UNIQUE (organization_id, provider, external_item_id),
  CONSTRAINT bank_connections_organization_id_fkey
    FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE,
  CONSTRAINT bank_connections_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_bank_conn_org_active
  ON public.bank_connections USING btree (organization_id) WHERE (status = 'active'::public.bank_connection_status);

ALTER TABLE public.bank_connections ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY bank_conn_select ON public.bank_connections
    FOR SELECT TO authenticated
    USING (organization_id IN (SELECT public.get_accessible_org_ids()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY bank_conn_insert ON public.bank_connections
    FOR INSERT TO authenticated
    WITH CHECK (organization_id IN (SELECT public.get_accessible_org_ids()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY bank_conn_update ON public.bank_connections
    FOR UPDATE TO authenticated
    USING (organization_id IN (SELECT public.get_accessible_org_ids()))
    WITH CHECK (organization_id IN (SELECT public.get_accessible_org_ids()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY bank_conn_delete ON public.bank_connections
    FOR DELETE TO authenticated
    USING (organization_id IN (SELECT public.get_accessible_org_ids()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- bank_accounts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.bank_accounts (
  id                      uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id         uuid NOT NULL,
  bank_connection_id      uuid NOT NULL,
  external_id             text NOT NULL,
  name                    text NOT NULL,
  account_number_last4    text,
  bsb                     text,
  account_type            public.bank_account_type NOT NULL DEFAULT 'checking',
  current_balance_cents   bigint DEFAULT 0,
  available_balance_cents bigint DEFAULT 0,
  currency_code           char(3) NOT NULL DEFAULT 'AUD',
  is_primary              boolean NOT NULL DEFAULT false,
  is_active               boolean NOT NULL DEFAULT true,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bank_accounts_pkey PRIMARY KEY (id),
  CONSTRAINT bank_accounts_organization_id_bank_connection_id_external_i_key
    UNIQUE (organization_id, bank_connection_id, external_id),
  CONSTRAINT bank_accounts_organization_id_fkey
    FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE,
  CONSTRAINT bank_accounts_bank_connection_id_fkey
    FOREIGN KEY (bank_connection_id) REFERENCES public.bank_connections(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_bank_acct_org
  ON public.bank_accounts USING btree (organization_id) WHERE is_active;

ALTER TABLE public.bank_accounts ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY bank_acct_select ON public.bank_accounts
    FOR SELECT TO authenticated
    USING (organization_id IN (SELECT public.get_accessible_org_ids()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY bank_acct_insert ON public.bank_accounts
    FOR INSERT TO authenticated
    WITH CHECK (organization_id IN (SELECT public.get_accessible_org_ids()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY bank_acct_update ON public.bank_accounts
    FOR UPDATE TO authenticated
    USING (organization_id IN (SELECT public.get_accessible_org_ids()))
    WITH CHECK (organization_id IN (SELECT public.get_accessible_org_ids()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
