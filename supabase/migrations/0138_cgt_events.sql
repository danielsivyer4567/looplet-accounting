-- 0138_cgt_events.sql — SC-4.D.01 (Phase 4, CGT)
--
-- The CGT-events ledger: one row per capital-gains-tax event (a disposal etc.).
-- TABLE ONLY — no calc logic. The raw netting (proceeds − cost base), the
-- 12-month discount and the small-business concessions are separate slices
-- (SC-4.E / SC-4.F) so each leaves a green build. This stores the raw facts an
-- event needs to be computed and re-computed later.
--
--   cgt_events — org-scoped (RLS via get_accessible_org_ids()), audited,
--     money-in-cents (bigint). Optionally links to a tracked depreciable asset
--     (fixed_assets) when the disposal is of a fixed asset, but most CGT events
--     (shares, real property, crypto) are NOT tracked fixed assets, so the link
--     is nullable.
--
-- COST BASE (ITAA 1997 s110-25) is captured as its FIVE elements, each a raw
-- money-in-cents column. They are stored separately (not summed here) because:
--   (a) summing is calc — it belongs in SC-4.E; and
--   (b) the *reduced* cost base (used when an event makes a loss) EXCLUDES the
--       third element (non-capital ownership costs), so the calc needs the
--       elements split to apply the right base. Keeping them raw keeps the
--       table a pure, reproducible data store.
--
-- DISPOSAL DATE drives the financial year a gain falls in (cgt_calc(org, fy)
-- filters on it); for the common A1 event it is the disposal/contract date.
-- ACQUISITION DATE is needed for the 12-month-discount test (SC-4.E.02) but is
-- nullable so an event can be recorded before every detail is known — the calc
-- treats a missing acquisition date as discount-ineligible.
--
-- MIGRATION NUMBER: the ledger planned 0129, but 0129 is taken
-- (0129_award_underpayment_check); reassigned to 0138 per the drift rule — the
-- sequential head is 0137_eofy_orchestrate (0178/0179 are late hotfixes).
-- Verified against live (dxoikltymmknxqpkpyhi): cgt_events does not exist;
-- get_accessible_org_ids/set_updated_at/audit_log_trigger_v2/fixed_assets all present.

do $$ begin
  create type public.cgt_asset_type as enum (
    'share', 'real_property', 'crypto', 'collectable', 'personal_use',
    'business_asset', 'other'
  );
exception when duplicate_object then null; end $$;

create table public.cgt_events (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references public.organizations (id) on delete cascade,
  -- The depreciable asset this event disposes of, when it is a tracked fixed
  -- asset. Nullable + ON DELETE SET NULL: most CGT events (shares, property,
  -- crypto) are not fixed assets, and a recorded event must survive deletion of
  -- its source asset.
  fixed_asset_id           uuid references public.fixed_assets (id) on delete set null,
  asset_description        text not null,                       -- human label, e.g. "1,000 BHP shares"
  asset_type               public.cgt_asset_type not null default 'other',
  -- CGT event code (ITAA 1997 Div 104): A1 disposal (the common case), B1, C1–C3,
  -- D1–D4, E1–E9, F1–F5, G1–G3, H1–H2, I1–I2, J1–J6, K1–K12, L1–L8.
  event_type               text not null default 'A1' check (event_type ~ '^[A-L][0-9]{1,2}$'),
  acquisition_date         date,                                -- when the asset was acquired (null = unknown → discount-ineligible)
  disposal_date            date not null,                       -- the CGT event date; drives the FY the gain falls in
  proceeds_cents           bigint not null default 0 check (proceeds_cents >= 0),  -- capital proceeds
  -- Cost base, split into the five ITAA 1997 s110-25 elements (money-in-cents).
  -- Summed by the calc (SC-4.E), not here.
  acquisition_cost_cents   bigint not null default 0 check (acquisition_cost_cents >= 0),   -- element 1: money/property to acquire
  incidental_costs_cents   bigint not null default 0 check (incidental_costs_cents >= 0),   -- element 2: incidental costs (acquisition + disposal)
  ownership_costs_cents    bigint not null default 0 check (ownership_costs_cents >= 0),    -- element 3: non-capital ownership costs (excluded from reduced cost base)
  capital_improvement_cents bigint not null default 0 check (capital_improvement_cents >= 0), -- element 4: capital costs to increase/preserve value
  title_costs_cents        bigint not null default 0 check (title_costs_cents >= 0),        -- element 5: capital costs to establish/preserve/defend title
  notes                    text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  created_by               uuid references auth.users (id),
  deleted_at               timestamptz,
  check (acquisition_date is null or disposal_date >= acquisition_date)
);

comment on table public.cgt_events is
  'CGT-events ledger (ITAA 1997): one row per capital-gains-tax event with the raw '
  'facts (proceeds + five s110-25 cost-base elements, all money-in-cents) needed to '
  'compute the gain/loss. Table only — netting/discount/concessions are SC-4.E/4.F.';

-- Calc + listing read by org over a financial year window (disposal_date).
create index cgt_events_org_disposal_idx
  on public.cgt_events (organization_id, disposal_date)
  where deleted_at is null;

create trigger cgt_events_set_updated_at
  before update on public.cgt_events
  for each row execute function public.set_updated_at();
create trigger cgt_events_audit
  after insert or update or delete on public.cgt_events
  for each row execute function public.audit_log_trigger_v2();

alter table public.cgt_events enable row level security;

create policy cgt_events_select on public.cgt_events for select
  using (organization_id in (select get_accessible_org_ids()));
create policy cgt_events_insert on public.cgt_events for insert
  with check (organization_id in (select get_accessible_org_ids()));
create policy cgt_events_update on public.cgt_events for update
  using (organization_id in (select get_accessible_org_ids()))
  with check (organization_id in (select get_accessible_org_ids()));
create policy cgt_events_delete on public.cgt_events for delete
  using (organization_id in (select get_accessible_org_ids()));

grant select, insert, update, delete on public.cgt_events to authenticated;
