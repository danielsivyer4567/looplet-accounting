-- 0150_return_offsets_credits.sql — SC-4.H.03 (Phase 4, book-to-tax reconciliation, part 3)
--
-- compute_tax_payable(org, fy_start_year) — the FINAL leg: from TAXABLE INCOME
-- (book_to_tax, SC-4.H.02, 0149) to NET TAX PAYABLE / REFUNDABLE. Three steps:
--   1. GROSS income tax = taxable income × the entity's rate/scale, plus the
--      Medicare levy for individuals.
--   2. NON-REFUNDABLE offsets reduce income tax to nil (no further): the small
--      business income tax offset (SBITO, individuals) and the franking offset
--      for COMPANIES (s67-25).
--   3. REFUNDABLE credits can take the result below nil into a refund: the
--      franking offset for INDIVIDUALS / complying super (Div 67) and PAYG
--      income-tax instalments already paid.
-- book_to_tax stopped at taxable income; this slice owns rate × income and the
-- offset/credit waterfall.
--
-- ── WHY A SEPARATE FUNCTION (not a 4th leg of book_to_tax) ─────────────────────
-- book_to_tax answers "what is taxable income?" (an accounting→tax reconciliation,
-- entity-agnostic until the very end). Tax payable is a different question — it is
-- rate-scale + offset-priority logic that branches hard on entity_type and depends
-- on inputs (instalments paid) that are NOT part of the reconciliation. Keeping it
-- a thin consumer of book_to_tax's payload preserves one taxable-income definition
-- and lets the return-draft UI (SC-4.I) call either independently.
--
-- ── 1. GROSS INCOME TAX BY ENTITY (ITAA 1997 / ITRA 1986) ──────────────────────
--   company     — flat company rate on the WHOLE taxable income (no tax-free
--                 threshold): 25% for a BASE RATE ENTITY (aggregated turnover
--                 < $50M), else 30%. Turnover is read from
--                 business_profile.estimated_annual_turnover_cents; a NULL turnover
--                 is treated as a base-rate entity (this app's users are SMEs).
--                 CAVEAT: the base-rate-entity "≤80% base rate entity passive
--                 income" test is NOT applied (turnover-only proxy) — documented.
--   sole_trader — resident INDIVIDUAL marginal scale (the rates in force from
--                 1 July 2024 / FY2024-25 onward) PLUS the 2% Medicare levy.
--                 CAVEAT: the encoded scale is the FY2024-25+ resident scale
--                 (earlier FYs differ); the Medicare levy is a flat 2% with the
--                 low-income threshold/shade-in NOT modelled; non-resident and
--                 working-holiday-maker scales are not modelled.
--   partnership / trust — PASS-THROUGH: no income tax is assessed at the entity
--                 level (the net income is taxed in the partners'/beneficiaries'
--                 own returns; trust s99/s99A assessment of undistributed income
--                 at the top rate is NOT modelled). Gross income tax = 0.
--   smsf        — the 15% concessional fund rate + the SMSF annual return are
--                 Phase 5 (SC-5.K); gross income tax = 0 here. CAVEAT documented.
--   other / unknown — no rate scale known; gross income tax = 0.
--
-- ── 2. NON-REFUNDABLE OFFSETS (reduce income tax to nil, never below) ──────────
--   SBITO (ITAA 1997 Subdiv 328-F) — INDIVIDUALS only: 16% (FY2021-22+) of the
--     basic income tax payable on the taxpayer's NET SMALL BUSINESS INCOME, capped
--     at $1,000. We assume net small business income = taxable income (the pure
--     sole-trader case, ratio 1), so SBITO = min($1,000, 16% × income tax).
--     CAVEAT: a mixed-income apportionment (net SB income ÷ taxable income < 1) is
--     the documented refinement.
--   FRANKING offset for COMPANIES (s67-25) — non-refundable; an EXCESS converts to
--     a tax loss under s36-55 (reported here as `unused`, NOT persisted —
--     compute_tax_payable is read-only; the same conversion is flagged in 0149's
--     caveats and is owned by the finalise step in SC-4.I).
--   Non-refundable offsets reduce the INCOME TAX component only, not the Medicare
--   levy (offsets do not reduce the levy).
--
-- ── 3. REFUNDABLE CREDITS (can produce a refund) ──────────────────────────────
--   FRANKING offset for INDIVIDUALS / complying super (Div 67) — refundable.
--     (Partnership/trust franking credits flow THROUGH to partners/beneficiaries
--     and are NOT used at the entity level — not applied here.)
--   PAYG income-tax INSTALMENTS paid — a credit for tax already paid toward the
--     entity's own liability; fully creditable/refundable, applied for every entity
--     type. SOURCE: a NEW curated input business_profile.payg_instalments_paid_cents
--     (default 0). The instalment AMOUNT is ATO-notified and has NO source in the
--     schema (0122 records it as a 0 placeholder; obligation_status tracks lodge/pay
--     STATUS, not dollars) — so, exactly like 0149's franking/loss inputs, a curated
--     opening balance is the honest choice. The ledger's "reads from obligation/
--     payment history" assumed an amount history that does not exist; documented.
--
-- ── WATERFALL ──────────────────────────────────────────────────────────────────
--     income_tax_after_nonref = max(0, income_tax − non_refundable_offsets)
--     total_liability         = income_tax_after_nonref + medicare_levy
--     net                     = total_liability − refundable_credits
--     net > 0 ⇒ payable;  net < 0 ⇒ refund (= −net);  net = 0 ⇒ nil.
--
-- SECURITY INVOKER + STABLE (read-only) — same posture as 0148/0149: book_to_tax
-- and business_profile are RLS-scoped to the caller, so a foreign org degrades to
-- zeros rather than leaking; a service_role backend bypasses RLS. No writes.
--
-- MIGRATION NUMBER: the ledger Files line planned 0141, long taken
-- (0141_cgt_sbe_eligibility). Reassigned to 0150 per the drift rule — the
-- sequential repo head is 0149_book_to_tax_cgt_losses (0178/0179 are late hotfixes
-- that sort after). Verified live (dxoikltymmknxqpkpyhi): compute_tax_payable
-- absent; book_to_tax / cgt_calc / build_return committed-but-not-deployed (only
-- generate_statutory_statements live); business_profile has entity_type +
-- estimated_annual_turnover_cents + is_paygi_registered and NO payg_instalments
-- column — confirming this input is new. The 0138–0150 chain deploys together.

-- ── 1. Curated tax input on business_profile (default 0 — never auto-applied) ──
alter table public.business_profile
  add column if not exists payg_instalments_paid_cents bigint not null default 0
    check (payg_instalments_paid_cents >= 0);

comment on column public.business_profile.payg_instalments_paid_cents is
  'SC-4.H.03: PAYG income-tax instalments already paid toward this FY''s income tax '
  '(money-in-cents), credited against tax payable by compute_tax_payable (fully '
  'refundable). A curated opening balance: the instalment amount is ATO-notified and '
  'has no source in the schema (0122 BAS worksheet records it as a 0 placeholder; '
  'obligation_status tracks lodge/pay status, not dollars). Default 0.';

-- ── 2. compute_tax_payable: rate × taxable income, then offsets + credits ──────
create or replace function public.compute_tax_payable(p_org uuid, p_fy_start_year integer)
  returns jsonb
  language plpgsql
  stable
  security invoker
  set search_path = public
as $$
declare
  v_fy_start        date := make_date(p_fy_start_year, 7, 1);
  v_fy_end          date := make_date(p_fy_start_year + 1, 6, 30);
  v_btt             jsonb;
  v_entity_type     text;
  v_taxable_income  bigint;        -- final taxable income from book_to_tax (>= 0)
  v_franking        bigint;        -- franking credits received (grossed up in 0149)
  v_turnover        bigint;        -- aggregated turnover proxy (base-rate-entity test)
  v_payg_paid       bigint;        -- curated PAYG instalments paid
  v_is_individual   boolean;
  v_is_company      boolean;
  v_company_rate    numeric;       -- 0.25 (base rate entity) or 0.30
  v_income_tax      bigint;        -- gross income tax (scale/flat), pre-offset
  v_medicare        bigint;        -- 2% levy (individuals only)
  v_sbito           bigint;        -- small business income tax offset (non-refundable)
  v_franking_nonref bigint;        -- company franking offset (non-refundable)
  v_franking_ref    bigint;        -- individual/smsf franking offset (refundable)
  v_nonref_total    bigint;
  v_nonref_unused   bigint;        -- offset that exceeds income tax (lost; co.→ loss)
  v_tax_after_nonref bigint;
  v_liability       bigint;        -- income tax after non-ref offsets + medicare
  v_refundable      bigint;
  v_net             bigint;        -- liability − refundable; >0 payable, <0 refund
begin
  -- Final taxable income + entity_type + franking come straight from book_to_tax
  -- (SC-4.H.02) — one taxable-income definition, no re-derivation.
  v_btt            := book_to_tax(p_org, p_fy_start_year);
  v_entity_type    := coalesce(v_btt ->> 'entity_type', 'other');
  v_taxable_income := greatest(0, coalesce((v_btt ->> 'taxable_income_cents')::bigint, 0));
  v_franking       := greatest(0, coalesce((v_btt #>> '{franking,credits_received_cents}')::bigint, 0));

  -- Turnover (base-rate-entity proxy) + PAYG instalments paid from business_profile.
  -- Defaults applied post-SELECT: SELECT INTO yields NULLs when the org has no
  -- business_profile row, so the post-select coalesce is the single guard.
  select estimated_annual_turnover_cents, payg_instalments_paid_cents
    into v_turnover, v_payg_paid
  from business_profile
  where organization_id = p_org;
  v_payg_paid := coalesce(v_payg_paid, 0);   -- turnover stays NULL → treated as base-rate

  v_is_individual := v_entity_type = 'sole_trader';
  v_is_company    := v_entity_type = 'company';

  -- ── 1. GROSS income tax by entity ──────────────────────────────────────────
  if v_is_company then
    -- Base rate entity (< $50M aggregated turnover) → 25%, else 30%. NULL turnover
    -- treated as base rate (SME default). $50M = 5_000_000_000 cents.
    v_company_rate := case when coalesce(v_turnover, 0) < 5000000000 then 0.25 else 0.30 end;
    v_income_tax   := round(v_taxable_income * v_company_rate);
    v_medicare     := 0;

  elsif v_is_individual then
    -- Resident individual marginal scale in force from 1 July 2024 (FY2024-25+),
    -- all thresholds/bases in cents.
    v_income_tax := round(
      case
        when v_taxable_income <= 1820000  then 0
        when v_taxable_income <= 4500000  then (v_taxable_income - 1820000)  * 0.16
        when v_taxable_income <= 13500000 then 428800  + (v_taxable_income - 4500000)  * 0.30
        when v_taxable_income <= 19000000 then 3128800 + (v_taxable_income - 13500000) * 0.37
        else                                   5163800 + (v_taxable_income - 19000000) * 0.45
      end
    );
    -- Medicare levy: flat 2% (low-income threshold/shade-in not modelled — caveat).
    v_medicare := round(v_taxable_income * 0.02);

  else
    -- partnership / trust (pass-through), smsf (Phase 5 SC-5.K), other / unknown.
    v_income_tax := 0;
    v_medicare   := 0;
  end if;

  -- ── 2. NON-REFUNDABLE offsets (reduce income tax to nil, never the levy) ─────
  -- SBITO: 16% (FY2021-22+) of income tax on net small business income (assumed =
  -- taxable income for a sole_trader), capped at $1,000 (100_000 cents). Individuals only.
  v_sbito := case when v_is_individual
                  then least(100000, round(v_income_tax * 0.16))
                  else 0 end;
  -- Company franking offset is non-refundable (s67-25).
  v_franking_nonref := case when v_is_company then v_franking else 0 end;

  v_nonref_total     := v_sbito + v_franking_nonref;
  v_tax_after_nonref := greatest(0, v_income_tax - v_nonref_total);
  v_nonref_unused    := greatest(0, v_nonref_total - v_income_tax);

  v_liability := v_tax_after_nonref + v_medicare;

  -- ── 3. REFUNDABLE credits (can take the result into a refund) ───────────────
  -- Franking is refundable for individuals / complying super (Div 67); company
  -- franking was used above (non-refundable). Partnership/trust franking flows
  -- through to members and is not applied at the entity level.
  v_franking_ref := case when v_is_individual or v_entity_type = 'smsf'
                         then v_franking else 0 end;
  -- PAYG instalments paid: a credit for tax already paid; applied for every entity.
  v_refundable := v_franking_ref + v_payg_paid;

  v_net := v_liability - v_refundable;

  return jsonb_build_object(
    'organization_id',      p_org,
    'fy_start_year',        p_fy_start_year,
    'period_start',         v_fy_start,
    'period_end',           v_fy_end,
    'entity_type',          v_entity_type,
    'taxable_income_cents', v_taxable_income,   -- from book_to_tax (SC-4.H.02)
    'rate_basis', case
      when v_is_company    then jsonb_build_object(
        'kind', 'company_flat',
        'rate', v_company_rate,
        'base_rate_entity', (v_company_rate = 0.25),
        'turnover_cents', v_turnover,
        'note', 'Base rate entity (< $50M turnover) → 25%, else 30%; NULL turnover treated as base rate. The ≤80% passive-income test is not applied.')
      when v_is_individual then jsonb_build_object(
        'kind', 'resident_individual_scale',
        'note', 'Resident individual marginal scale in force from 1 July 2024 (FY2024-25+) + 2% Medicare levy (low-income shade-in not modelled).')
      else jsonb_build_object(
        'kind', 'no_entity_level_tax',
        'note', 'partnership/trust are pass-through (taxed in members'' returns); smsf tax is Phase 5 (SC-5.K); other/unknown has no rate scale — gross income tax = 0.')
      end,
    'income_tax_cents',   v_income_tax,
    'medicare_levy_cents', v_medicare,
    'offsets', jsonb_build_object(
      'non_refundable', jsonb_build_object(
        'sbito_cents',           v_sbito,
        'company_franking_cents', v_franking_nonref,
        'total_cents',           v_nonref_total,
        'unused_cents',          v_nonref_unused,
        'note', 'Reduce income tax to nil only (not the Medicare levy). Unused company franking converts to a tax loss (s36-55) — reported, not persisted.'
      ),
      'refundable', jsonb_build_object(
        'franking_cents',                v_franking_ref,
        'payg_instalments_paid_cents',   v_payg_paid,
        'total_cents',                   v_refundable,
        'note', 'Franking is refundable for individuals/complying super (Div 67); PAYG instalments paid are creditable for every entity.'
      )
    ),
    'tax_after_non_refundable_offsets_cents', v_tax_after_nonref,
    'total_liability_cents',                  v_liability,
    'net_tax_payable_cents',                  greatest(0, v_net),    -- owe the ATO
    'net_refund_cents',                       greatest(0, -v_net),   -- refund from the ATO
    'result', case when v_net > 0 then 'payable'
                   when v_net < 0 then 'refundable'
                   else 'nil' end,
    'caveats', jsonb_build_array(
      'Company rate uses an aggregated-turnover proxy only (< $50M → 25%); the base-rate-entity ≤80% passive-income test is not applied, and a NULL turnover is treated as a base rate entity.',
      'The individual scale is the resident FY2024-25+ scale (earlier FYs differ); the 2% Medicare levy is flat with the low-income threshold/shade-in not modelled; non-resident / working-holiday-maker scales are not modelled.',
      'SBITO assumes net small business income = taxable income (the pure sole-trader case); a mixed-income apportionment is the documented refinement.',
      'Partnership/trust are treated as pure pass-through (no entity-level tax; trust s99/s99A assessment of undistributed income at the top rate is not modelled); SMSF tax is Phase 5 (SC-5.K).',
      'PAYG instalments paid is the curated business_profile.payg_instalments_paid_cents (no instalment-amount source in the schema); an unused company franking offset converts to a tax loss (s36-55) but is reported only, not persisted (this function is read-only).'
    ),
    'note', 'Net tax = (income tax − non-refundable offsets, to nil) + Medicare levy − refundable credits (franking for individuals/super + PAYG instalments paid). Positive = payable, negative = refundable. Taxable income is book_to_tax (SC-4.H.02).'
  );
end;
$$;

comment on function public.compute_tax_payable(uuid, integer) is
  'SC-4.H.03: net tax payable/refundable (jsonb) for an org + AU FY. Consumes '
  'book_to_tax (SC-4.H.02) taxable income, applies the entity rate/scale (company '
  'flat 25%/30%; resident individual marginal scale + 2% Medicare levy; '
  'partnership/trust/smsf/other = no entity-level tax), then the offset waterfall: '
  'non-refundable SBITO + company franking (to nil), then refundable individual/super '
  'franking + PAYG instalments paid (business_profile.payg_instalments_paid_cents). '
  'Returns net_tax_payable_cents / net_refund_cents + caveats. SECURITY INVOKER — '
  'RLS scopes the caller.';

revoke all on function public.compute_tax_payable(uuid, integer) from public, anon;
grant execute on function public.compute_tax_payable(uuid, integer) to authenticated;
