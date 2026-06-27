-- 0153_trust_distributions.sql — SC-5.A.03 (Phase 5, Trusts)
--
-- The third trust slice: the persistence target the distribution engine (SC-5.C)
-- writes into. Split out from deed/FTE (0152) so the engine has a stable, minimal
-- write surface. TABLE ONLY — the net-income (s95) calc is SC-5.B, the allocation/
-- streaming optimiser is SC-5.C, and the distribution minute is SC-5.D.
--
--   trust_distributions — one row per beneficiary's share of a trust's income for a
--                         financial year. Money-in-cents (BIGINT). The distributed
--                         share (amount_cents) is broken into the three income-class
--                         buckets the optimiser/streaming overlay (SC-5.C) populates:
--                           * capital_gain_cents     — streamed net capital gain
--                                                      (Subdiv 115-C streaming)
--                           * franked_dividend_cents — streamed franked distributions
--                                                      (Subdiv 207-B streaming)
--                           * other_cents            — the non-streamable remainder
--                                                      (ordinary/foreign/unfranked),
--                                                      distributed proportionally
--                         A table-level CHECK enforces that these three sum to
--                         amount_cents, so a distribution can never record a total
--                         that disagrees with its components.
--
--                         franking_credits_cents rides alongside the franked-dividend
--                         component: it is the franking credit ATTACHED to the streamed
--                         franked distributions and flows to the beneficiary as a tax
--                         offset (a gross-up/credit), so it is deliberately NOT part of
--                         amount_cents (the distributed corpus) and is excluded from the
--                         sum CHECK.
--
--                         status (draft/approved/finalised) tracks the approve-to-
--                         finalise lifecycle — the distribution minute finalise (SC-5.D)
--                         is gated by the approvals queue (SC-2). The table just records
--                         the state; the gate lives in the RPC/edge layer.
--
-- Carries organization_id denormalised (direct RLS, no join through trusts) and the
-- full RLS/audit/soft-delete + created_at/updated_at/created_by convention of
-- 0001/0051/0138/0151/0152.
--
-- DESIGN NOTE — first-class component columns vs a `components` JSONB: the income-class
-- split is a FIXED, calc-critical closed set (the same classes SC-5.B's s95 calc
-- produces), and it must sum to the total. That makes it the hoist-to-first-class case
-- (like 0152's streaming_allowed/vesting_date and 0151's calc-relevant flags), not the
-- open-ended-JSONB case (0152's parsed_terms): typed columns are queryable, the sum is
-- enforced by a plain CHECK, and the streaming optimiser writes them directly. No
-- speculative JSONB is added (nothing consumes one yet — cf. the linked_organization_id
-- dropped from 0151).
--
-- MIGRATION NUMBER: 0153. The ledger planned 0144, but 0143–0150 are taken (Phase 4
-- CGT/return builder) and 0151/0152 are the trust slices this one extends; the
-- sequential repo head is 0152_trust_deed_fte (0178/0179 are late hotfixes). Verified
-- against live (dxoikltymmknxqpkpyhi, read-only): trust_distributions does not exist
-- (no drift); trusts/trust_beneficiaries are absent live too (0151/0152 are repo-only,
-- deployed in a later batched step); get_accessible_org_ids/set_updated_at/
-- audit_log_trigger_v2 all present.

create table public.trust_distributions (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null references public.organizations (id) on delete cascade,
  trust_id               uuid not null references public.trusts (id) on delete cascade,
  beneficiary_id         uuid not null references public.trust_beneficiaries (id) on delete cascade,
  -- The income year this distribution resolution belongs to.
  financial_year         int not null,
  -- The beneficiary's total distributed share for the year (sum of the three
  -- income-class components below — enforced by a CHECK).
  amount_cents           bigint not null default 0,
  -- Streamed net capital gain (Subdiv 115-C). Carries its CGT character to the
  -- beneficiary (discount eligibility etc. is resolved in the beneficiary's return).
  capital_gain_cents     bigint not null default 0,
  -- Streamed franked distributions (Subdiv 207-B). The attached franking credits are
  -- tracked separately in franking_credits_cents.
  franked_dividend_cents bigint not null default 0,
  -- The non-streamable remainder (ordinary income, foreign income, unfranked dividends,
  -- interest, ...), distributed proportionally rather than streamed.
  other_cents            bigint not null default 0,
  -- Franking credits ATTACHED to the streamed franked distributions. A tax offset to
  -- the beneficiary (a gross-up/credit), NOT distributed corpus — so it is excluded
  -- from amount_cents and the sum CHECK below.
  franking_credits_cents bigint not null default 0,
  -- Lifecycle: draft (optimiser proposal) -> approved (approvals gate, SC-2) ->
  -- finalised (the distribution minute is issued, SC-5.D).
  status                 text not null default 'draft'
                           check (status in ('draft', 'approved', 'finalised')),
  notes                  text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  created_by             uuid references auth.users (id),
  deleted_at             timestamptz,
  -- The income-class components must reconcile to the distributed total. Franking
  -- credits are an attached offset and are intentionally not part of this sum.
  constraint trust_distributions_components_sum
    check (amount_cents = capital_gain_cents + franked_dividend_cents + other_cents),
  -- A trust distributes income (>= 0); trust losses are trapped, not distributed.
  constraint trust_distributions_non_negative
    check (
      amount_cents >= 0
      and capital_gain_cents >= 0
      and franked_dividend_cents >= 0
      and other_cents >= 0
      and franking_credits_cents >= 0
    )
);

comment on table public.trust_distributions is
  'Per-beneficiary distribution of a trust''s income for a financial year (SC-5.A.03). '
  'Write target for the distribution engine (SC-5.C). amount_cents = capital_gain + '
  'franked_dividend + other (enforced by CHECK); franking_credits_cents is the attached '
  'offset and is NOT part of that sum. status drives the approve-to-finalise gate (SC-5.D).';

-- A trust's distributions for a year (the primary listing/optimiser path); org-first
-- so the index also serves RLS-scoped org-wide listing.
create index trust_distributions_org_trust_fy_idx
  on public.trust_distributions (organization_id, trust_id, financial_year)
  where deleted_at is null;

-- One FINALISED distribution governs a beneficiary's share for a year — a beneficiary's
-- s97 present entitlement to the trust's income for an income year is a single number,
-- so two finalised rows for the same (trust, beneficiary, year) would double-count.
-- Scoped to status='finalised' (not all live rows) so the optimiser (SC-5.C) is free to
-- hold many competing DRAFT/approved proposals; only the resolved entitlement is unique.
-- An amendment soft-deletes the prior finalised row (deleted_at set) and finalises a new
-- one, mirroring 0152's one-active-deed restatement pattern.
create unique index trust_distributions_one_final_per_beneficiary_fy
  on public.trust_distributions (trust_id, beneficiary_id, financial_year)
  where status = 'finalised' and deleted_at is null;

create trigger trust_distributions_set_updated_at
  before update on public.trust_distributions
  for each row execute function public.set_updated_at();
create trigger trust_distributions_audit
  after insert or update or delete on public.trust_distributions
  for each row execute function public.audit_log_trigger_v2();

alter table public.trust_distributions enable row level security;

create policy trust_distributions_select on public.trust_distributions for select
  using (organization_id in (select get_accessible_org_ids()));
create policy trust_distributions_insert on public.trust_distributions for insert
  with check (organization_id in (select get_accessible_org_ids()));
create policy trust_distributions_update on public.trust_distributions for update
  using (organization_id in (select get_accessible_org_ids()))
  with check (organization_id in (select get_accessible_org_ids()));
create policy trust_distributions_delete on public.trust_distributions for delete
  using (organization_id in (select get_accessible_org_ids()));

grant select, insert, update, delete on public.trust_distributions to authenticated;
