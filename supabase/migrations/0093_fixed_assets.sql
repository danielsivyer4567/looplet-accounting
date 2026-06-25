-- 0093: Fixed-asset register — assets + depreciation schedules.
--
-- Phase 1.E foundation. Two tables that ship together as one atomic schema unit:
--   * fixed_assets          — the capitalised-asset register (one row per asset)
--   * depreciation_schedules — the depreciation plan for an asset (FKs the asset)
--
-- Pure schema slice: NO logic here. The capital-purchase detect + capitalisation
-- RPCs land in SC-1.F (which writes 'proposed' assets + a default schedule), the
-- depreciation math/posting in SC-1.G, and the register UI in SC-1.H.
--
-- Money is in cents (BIGINT) per the ledger money convention. account_code columns
-- are advisory TEXT (the proposed chart_of_accounts.code), not hard FKs — same
-- reasoning as 0092: a register row must not be rejectable by a since-renamed or
-- deactivated GL account. Per-period depreciation postings are NOT stored here —
-- they live in journal_entries (source_type/source_id), so the depreciation-run fn
-- (SC-1.G.02) achieves (schedule, period) idempotency by checking for an existing
-- posted journal, exactly like the coding classifier checks for an existing journal.
--
-- Conventions mirror 0092_coding_review_queue / writable org tables (e.g. bills):
-- RLS via get_accessible_org_ids() (SELECT/INSERT/UPDATE; soft-delete, no hard
-- DELETE), set_updated_at() + audit_log_trigger_v2() triggers, standard
-- created_at/updated_at/created_by/deleted_at columns.

-- -- enums ----------------------------------------------------------------------
DO $$ BEGIN
  -- AU general depreciation methods. Pool / instant-write-off treatment is carried
  -- by the boolean flags on fixed_assets, not by a separate method value.
  CREATE TYPE public.depreciation_method AS ENUM (
    'prime_cost',          -- straight-line: cost / effective life
    'diminishing_value'    -- declining balance: 2/effective life (200% DV) on opening WDV
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  -- Full asset lifecycle declared up front (cf. 0092) to avoid a later ALTER TYPE.
  CREATE TYPE public.fixed_asset_status AS ENUM (
    'proposed',  -- machine-proposed by capitalisation detection (SC-1.F); awaiting human confirm
    'active',    -- confirmed / in service; depreciating
    'disposed'   -- sold, scrapped or written off (disposal detail lands with the disposal slice)
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- -- fixed_assets ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fixed_assets (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- The bill this asset was capitalised from. Nullable (manual entry has none) and
  -- ON DELETE SET NULL: a capitalised asset must survive deletion of its source bill.
  source_bill_id        uuid REFERENCES public.bills(id) ON DELETE SET NULL,
  name                  text NOT NULL,                 -- human label / description
  asset_account_code    text,                          -- proposed balance-sheet asset account (chart_of_accounts.code; advisory, no FK)
  acquisition_date      date NOT NULL,
  cost_base_cents       bigint NOT NULL CHECK (cost_base_cents >= 0),  -- money-in-cents
  depreciation_method   public.depreciation_method NOT NULL DEFAULT 'prime_cost',
  effective_life_years  numeric CHECK (effective_life_years IS NULL OR effective_life_years > 0),  -- ATO effective life; NULL for instant-write-off / pooled
  pool_eligible         boolean NOT NULL DEFAULT false, -- small-business general pool eligible
  instant_write_off     boolean NOT NULL DEFAULT false, -- instant asset write-off (fully expensed; no schedule)
  status                public.fixed_asset_status NOT NULL DEFAULT 'proposed',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid REFERENCES auth.users(id),
  deleted_at            timestamptz
);

-- One live asset per source bill — lets propose_capitalisation (SC-1.F.02) upsert
-- idempotently ("no duplicate, keyed on source_bill_id").
CREATE UNIQUE INDEX IF NOT EXISTS fixed_assets_source_bill_uniq
  ON public.fixed_assets (source_bill_id)
  WHERE source_bill_id IS NOT NULL AND deleted_at IS NULL;

-- Register listing: live assets for an org by status, newest acquisitions first.
CREATE INDEX IF NOT EXISTS fixed_assets_org_status_idx
  ON public.fixed_assets (organization_id, status, acquisition_date DESC)
  WHERE deleted_at IS NULL;

COMMENT ON TABLE public.fixed_assets IS
  'Capitalised-asset register (one row per asset). cost_base_cents is money-in-cents; asset_account_code is the advisory balance-sheet account (chart_of_accounts.code, no FK). source_bill_id FKs bills ON DELETE SET NULL so an asset survives its source bill. Machine-proposed rows arrive status=proposed (SC-1.F); a human confirms to active (SC-1.H).';

-- -- depreciation_schedules -----------------------------------------------------
-- The depreciation plan for an asset. Carries its own copy of the calc inputs so
-- compute_depreciation(:schedule, :period) (SC-1.G.01) is self-contained.
CREATE TABLE IF NOT EXISTS public.depreciation_schedules (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  fixed_asset_id           uuid NOT NULL REFERENCES public.fixed_assets(id) ON DELETE CASCADE,
  method                   public.depreciation_method NOT NULL,
  start_date               date NOT NULL,                                            -- first depreciation period (usually acquisition / first-use date)
  opening_cost_base_cents  bigint NOT NULL CHECK (opening_cost_base_cents >= 0),      -- depreciable base in cents
  effective_life_years     numeric NOT NULL CHECK (effective_life_years > 0),         -- drives the rate (prime-cost 1/life; DV 2/life)
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  created_by               uuid REFERENCES auth.users(id),
  deleted_at               timestamptz
);

-- One live schedule per asset (SC-1.F.02 creates "a default depreciation_schedule";
-- SC-1.G computes per schedule). Also serves the asset -> schedule lookup.
CREATE UNIQUE INDEX IF NOT EXISTS depreciation_schedules_asset_uniq
  ON public.depreciation_schedules (fixed_asset_id)
  WHERE deleted_at IS NULL;

-- Org-scoped scans (RLS predicate is organization_id IN (...)).
CREATE INDEX IF NOT EXISTS depreciation_schedules_org_idx
  ON public.depreciation_schedules (organization_id)
  WHERE deleted_at IS NULL;

COMMENT ON TABLE public.depreciation_schedules IS
  'Depreciation plan for a fixed_asset (FK ON DELETE CASCADE). Holds its own copy of the calc inputs (method, start_date, opening_cost_base_cents, effective_life_years) so compute_depreciation (SC-1.G.01) is self-contained. Per-period postings are NOT here — they live in journal_entries; idempotency is keyed on (schedule, period) by the posted journal.';

-- -- triggers (both tables) -----------------------------------------------------
DROP TRIGGER IF EXISTS trg_fixed_assets_updated_at ON public.fixed_assets;
CREATE TRIGGER trg_fixed_assets_updated_at
  BEFORE UPDATE ON public.fixed_assets
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_fixed_assets_audit ON public.fixed_assets;
CREATE TRIGGER trg_fixed_assets_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.fixed_assets
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_trigger_v2();

DROP TRIGGER IF EXISTS trg_depreciation_schedules_updated_at ON public.depreciation_schedules;
CREATE TRIGGER trg_depreciation_schedules_updated_at
  BEFORE UPDATE ON public.depreciation_schedules
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_depreciation_schedules_audit ON public.depreciation_schedules;
CREATE TRIGGER trg_depreciation_schedules_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.depreciation_schedules
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_trigger_v2();

-- -- RLS (writable org-scoped convention: SELECT/INSERT/UPDATE; soft-delete) -----
-- A fixed-asset register is user-managed (manual entry, confirm/reject, edits) as
-- well as machine-proposed, so unlike 0092 it is NOT read-only: authenticated org
-- members get SELECT/INSERT/UPDATE scoped to get_accessible_org_ids(). DEFINER RPCs
-- (propose_capitalisation, SC-1.F.02) run as service_role and bypass RLS. No hard
-- DELETE policy — removal is soft via deleted_at (matches bills).
ALTER TABLE public.fixed_assets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fixed_assets_select ON public.fixed_assets;
CREATE POLICY fixed_assets_select ON public.fixed_assets
  FOR SELECT TO authenticated
  USING (organization_id IN (SELECT public.get_accessible_org_ids()));

DROP POLICY IF EXISTS fixed_assets_insert ON public.fixed_assets;
CREATE POLICY fixed_assets_insert ON public.fixed_assets
  FOR INSERT TO authenticated
  WITH CHECK (organization_id IN (SELECT public.get_accessible_org_ids()));

DROP POLICY IF EXISTS fixed_assets_update ON public.fixed_assets;
CREATE POLICY fixed_assets_update ON public.fixed_assets
  FOR UPDATE TO authenticated
  USING (organization_id IN (SELECT public.get_accessible_org_ids()))
  WITH CHECK (organization_id IN (SELECT public.get_accessible_org_ids()));

GRANT SELECT, INSERT, UPDATE ON public.fixed_assets TO authenticated;

ALTER TABLE public.depreciation_schedules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS depreciation_schedules_select ON public.depreciation_schedules;
CREATE POLICY depreciation_schedules_select ON public.depreciation_schedules
  FOR SELECT TO authenticated
  USING (organization_id IN (SELECT public.get_accessible_org_ids()));

DROP POLICY IF EXISTS depreciation_schedules_insert ON public.depreciation_schedules;
CREATE POLICY depreciation_schedules_insert ON public.depreciation_schedules
  FOR INSERT TO authenticated
  WITH CHECK (organization_id IN (SELECT public.get_accessible_org_ids()));

DROP POLICY IF EXISTS depreciation_schedules_update ON public.depreciation_schedules;
CREATE POLICY depreciation_schedules_update ON public.depreciation_schedules
  FOR UPDATE TO authenticated
  USING (organization_id IN (SELECT public.get_accessible_org_ids()))
  WITH CHECK (organization_id IN (SELECT public.get_accessible_org_ids()));

GRANT SELECT, INSERT, UPDATE ON public.depreciation_schedules TO authenticated;

-- Make PostgREST pick up the new tables immediately after deployment.
NOTIFY pgrst, 'reload schema';
