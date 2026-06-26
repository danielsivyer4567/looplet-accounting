-- 0143_cgt_retirement_cap_tracking.sql — SC-4.F.03 (Phase 4, CGT small-business concessions)
--
-- The lifetime-cap ledger for the small-business RETIREMENT EXEMPTION (ITAA 1997
-- Subdiv 152-D). This migration is the FIRST of the two in SC-4.F.03 — it lands
-- the durable cap state + the remaining-cap helper that the concession calc
-- (0144) reads. They are ONE atomic unit (the calc cannot enforce the $500k cap
-- without this table); the table is applied first so 0144 can reference it.
--
-- ── WHY A LEDGER (not derived from cgt_events like the loss carry-forward) ─────
-- The carry-forward of capital LOSSES (0139) is reproducible from prior cgt_events
-- and so needs no ledger. The retirement-exemption $500,000 limit is different:
--   * it is a LIFETIME cap (s152-320) that can span decades and PRE-DATE this
--     system — historical usage (exemptions claimed before the books were on this
--     platform) is not reconstructable from cgt_events and must be enterable; and
--   * the exempt amount each year is an ELECTED figure (s152-305, the taxpayer
--     nominates it), not a deterministic function of the disposal — so it is a
--     recorded fact, not a recomputation.
-- Hence a durable, auditable ledger: one row per retirement-exemption amount used,
-- tagged with the FY it was used in and (optionally) the CGT concession stakeholder
-- it belongs to. Opening/historical balances are entered with source='historical'.
--
-- ── CAP SCOPE (per-stakeholder in law; entity-level here, conservatively) ──────
-- The $500k limit is per CGT concession STAKEHOLDER (individual), NOT per entity
-- (s152-320, s152-310(2)). A company/trust with two equal stakeholders can shelter
-- up to $1,000,000 ($500k each). We model usage at the ORG level by default
-- (stakeholder_label NULL = a single notional cap for the entity), which TREATS THE
-- WHOLE ORG AS ONE $500k cap. That is the CONSERVATIVE direction — it can only
-- UNDER-state the remaining cap for a multi-stakeholder entity, never over-claim,
-- which is the safe posture for prep-and-approve (a human re-allocates per
-- stakeholder where the entity has several). stakeholder_label is carried so true
-- per-stakeholder tracking can be layered on later without a schema change.
--
-- MIGRATION NUMBER: the ledger planned 0135, but 0135 is taken; reassigned to 0143
-- per the drift rule — the sequential repo head is 0142_cgt_concession_15yr_50pct
-- (0178/0179 are late hotfixes). Verified against live (dxoikltymmknxqpkpyhi):
-- cgt_retirement_exemption_usage does not exist; get_accessible_org_ids /
-- set_updated_at / audit_log_trigger_v2 / organizations all present; cgt_events is
-- committed-but-not-yet-deployed (0138), staged with this file for the live test.

-- ── 1. The lifetime-cap usage ledger ──────────────────────────────────────────
create table public.cgt_retirement_exemption_usage (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations (id) on delete cascade,
  -- The disposal this exemption amount relates to, when known. Nullable +
  -- ON DELETE SET NULL: historical/opening entries have no in-system event, and a
  -- recorded usage must survive deletion of its source event (the cap was still
  -- consumed). cgt_events is created in 0138 (same slice family).
  cgt_event_id      uuid references public.cgt_events (id) on delete set null,
  -- AU financial year the exemption was used in (the FY start year, e.g. 2024 for
  -- FY2024-25). Drives the "prior usage" sum the remaining-cap helper computes.
  fy_start_year     integer not null check (fy_start_year between 1985 and 2200),  -- CGT began 1985
  -- The CGT concession stakeholder this amount is charged to. NULL = entity-level
  -- (the conservative single-$500k model — see header). A label so per-stakeholder
  -- caps can be tracked later without a schema change.
  stakeholder_label text,
  -- Retirement exemption applied (money-in-cents). Counts toward the $500k cap.
  amount_cents      bigint not null check (amount_cents >= 0),
  -- Provenance: 'historical' (pre-system usage entered by the accountant),
  -- 'manual' (a hand-entered current figure), 'system' (written when a return is
  -- finalised — that write path is a later slice).
  source            text not null default 'manual' check (source in ('historical', 'manual', 'system')),
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid references auth.users (id),
  deleted_at        timestamptz
);

comment on table public.cgt_retirement_exemption_usage is
  'SC-4.F.03: lifetime-cap ledger for the small-business retirement exemption '
  '(ITAA 1997 Subdiv 152-D, $500,000 limit per s152-320). One row per exemption '
  'amount used, tagged with the FY and (optionally) the CGT concession stakeholder. '
  'Durable + accountant-enterable because the limit is lifetime (can pre-date this '
  'system) and the amount is an elected figure, not a recomputation. Read by '
  'cgt_retirement_cap_remaining() to gate the concession calc (0144). The current-'
  'year ''system'' write happens when a return is finalised (a later slice).';

-- Remaining-cap sum is by org over PRIOR financial years.
create index cgt_retirement_exemption_usage_org_fy_idx
  on public.cgt_retirement_exemption_usage (organization_id, fy_start_year)
  where deleted_at is null;

create trigger cgt_retirement_exemption_usage_set_updated_at
  before update on public.cgt_retirement_exemption_usage
  for each row execute function public.set_updated_at();
create trigger cgt_retirement_exemption_usage_audit
  after insert or update or delete on public.cgt_retirement_exemption_usage
  for each row execute function public.audit_log_trigger_v2();

alter table public.cgt_retirement_exemption_usage enable row level security;

create policy cgt_retirement_exemption_usage_select on public.cgt_retirement_exemption_usage for select
  using (organization_id in (select get_accessible_org_ids()));
create policy cgt_retirement_exemption_usage_insert on public.cgt_retirement_exemption_usage for insert
  with check (organization_id in (select get_accessible_org_ids()));
create policy cgt_retirement_exemption_usage_update on public.cgt_retirement_exemption_usage for update
  using (organization_id in (select get_accessible_org_ids()))
  with check (organization_id in (select get_accessible_org_ids()));
create policy cgt_retirement_exemption_usage_delete on public.cgt_retirement_exemption_usage for delete
  using (organization_id in (select get_accessible_org_ids()));

grant select, insert, update, delete on public.cgt_retirement_exemption_usage to authenticated;

-- ── 2. Remaining-cap helper ───────────────────────────────────────────────────
-- The $500,000 lifetime retirement-exemption limit (s152-320) LESS all usage in
-- FINANCIAL YEARS BEFORE p_fy_start_year. Current-FY usage is deliberately
-- EXCLUDED: the calc (0144) computes the current FY's exemption fresh from the
-- per-event elections, so subtracting any already-finalised current-FY ledger rows
-- here would double-count. Floored at 0 so an over-used cap never goes negative.
create or replace function public.cgt_retirement_cap_remaining(p_org uuid, p_fy_start_year integer)
  returns bigint
  language sql
  stable
  security invoker
  set search_path = public
as $$
  select greatest(
    0,
    50000000 - coalesce((                                  -- $500,000 lifetime cap
      select sum(amount_cents)
      from public.cgt_retirement_exemption_usage
      where organization_id = p_org
        and deleted_at is null
        and fy_start_year < p_fy_start_year
    ), 0)
  )::bigint;
$$;

comment on function public.cgt_retirement_cap_remaining(uuid, integer) is
  'SC-4.F.03: the small-business retirement-exemption lifetime cap remaining for an '
  'org BEFORE the given AU FY = $500,000 (s152-320) minus usage in all prior FYs '
  'from cgt_retirement_exemption_usage. Excludes the current FY (the calc recomputes '
  'it). Org-level (treats the entity as a single $500k cap — conservative; the law '
  'is $500k per CGT concession stakeholder). SECURITY INVOKER — RLS scopes the caller. '
  'CONTRACT owed to the later finalise slice: because this helper ignores current-FY '
  'rows, the finalise writer of the current FY''s applied exemption (source=''system'') '
  'MUST be idempotent per (organization_id, fy_start_year) — re-finalising the same FY '
  'must replace, not append, or the cap is double-consumed.';

revoke all on function public.cgt_retirement_cap_remaining(uuid, integer) from public, anon;
grant execute on function public.cgt_retirement_cap_remaining(uuid, integer) to authenticated;
