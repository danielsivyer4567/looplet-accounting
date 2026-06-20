-- ============================================================================
-- 0071: Chart of accounts (double-entry GL foundation).
--
-- EPIC G1 — the existing balance sheet / P&L views (0041, 0047) are stitched
-- approximations because there was no general-ledger schema. This migration
-- begins the real thing: a per-org chart of accounts that journal lines
-- (0072) reference. From these postings we will derive P&L and Balance Sheet
-- from a single source of truth (v_trial_balance, 0074) instead of mixing
-- GST-inclusive revenue from invoices.
--
-- Scope: one table, its enum, RLS scoped to get_accessible_org_ids(), and a
-- per-org unique account code. Account hierarchy via a self-FK parent.
-- ============================================================================

-- -- account_type enum -------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE public.account_type AS ENUM (
    'asset', 'liability', 'equity', 'income', 'expense'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- -- chart_of_accounts -------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.chart_of_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  account_type public.account_type NOT NULL,
  parent_account_id uuid REFERENCES public.chart_of_accounts(id) ON DELETE SET NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chart_of_accounts_org_code_uniq UNIQUE (organization_id, code)
);

CREATE INDEX IF NOT EXISTS chart_of_accounts_org_idx
  ON public.chart_of_accounts (organization_id, account_type, is_active);
CREATE INDEX IF NOT EXISTS chart_of_accounts_parent_idx
  ON public.chart_of_accounts (parent_account_id)
  WHERE parent_account_id IS NOT NULL;

COMMENT ON TABLE public.chart_of_accounts IS
  'Per-org chart of accounts. Account codes are unique within an organization. account_type drives whether the account rolls up to the P&L (income/expense) or Balance Sheet (asset/liability/equity). parent_account_id allows a hierarchy (e.g. 4000 Income > 4100 Job revenue).';

-- -- updated_at trigger (mirrors set_updated_at() from 0001) -----------------
DROP TRIGGER IF EXISTS trg_chart_of_accounts_set_updated_at ON public.chart_of_accounts;
CREATE TRIGGER trg_chart_of_accounts_set_updated_at
  BEFORE UPDATE ON public.chart_of_accounts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- -- RLS ---------------------------------------------------------------------
ALTER TABLE public.chart_of_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS chart_of_accounts_select ON public.chart_of_accounts;
CREATE POLICY chart_of_accounts_select ON public.chart_of_accounts
  FOR SELECT USING (organization_id IN (SELECT public.get_accessible_org_ids()));

DROP POLICY IF EXISTS chart_of_accounts_insert ON public.chart_of_accounts;
CREATE POLICY chart_of_accounts_insert ON public.chart_of_accounts
  FOR INSERT WITH CHECK (organization_id IN (SELECT public.get_accessible_org_ids()));

DROP POLICY IF EXISTS chart_of_accounts_update ON public.chart_of_accounts;
CREATE POLICY chart_of_accounts_update ON public.chart_of_accounts
  FOR UPDATE USING (organization_id IN (SELECT public.get_accessible_org_ids()))
  WITH CHECK (organization_id IN (SELECT public.get_accessible_org_ids()));

DROP POLICY IF EXISTS chart_of_accounts_delete ON public.chart_of_accounts;
CREATE POLICY chart_of_accounts_delete ON public.chart_of_accounts
  FOR DELETE USING (organization_id IN (SELECT public.get_accessible_org_ids()));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.chart_of_accounts TO authenticated;
