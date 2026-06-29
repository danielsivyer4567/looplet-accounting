-- 0149_book_to_tax_cgt_losses.sql — SC-4.H.02 (Phase 4, book-to-tax reconciliation, part 2)
--
-- Extends book_to_tax (SC-4.H.01, 0148) with the THIRD leg of the Item-7
-- reconciliation: the move from a taxable-income SUBTOTAL (net ordinary business
-- income on a tax basis) to actual TAXABLE INCOME, by folding in
--   3a. the net capital gain     (ITAA 1997 s102-5 — statutory income),
--   3b. the franking gross-up    (ITAA 1997 s207-20 — statutory income),
--   3c. carried-forward revenue (tax) losses (ITAA 1997 Div 36 deduction).
-- Tax payable (rate × taxable income), the franking/PAYG/SBITO OFFSETS, and
-- refundability are SC-4.H.03 (0150). This slice stops at taxable income.
--
-- ── WHY CGT-inclusion + loss-offset are ONE slice (per the ledger) ─────────────
-- The Div 36 loss deduction applies to the TOTAL assessable income, which already
-- INCLUDES the net capital gain (s102-5) and the franking gross-up (s207-20). The
-- loss-offset amount therefore depends on the CGT-inclusion amount — splitting the
-- two would either deduct losses against the wrong base or leave a half-computed
-- subtotal, breaking the ITAA ordering. They are kept together here.
--
-- ── 3a. NET CAPITAL GAIN (s102-5) ──────────────────────────────────────────────
-- cgt_calc (SC-4.E/4.F, 0139–0144) already nets current-year and carried-forward
-- CAPITAL losses, applies the Div 115 discount and the Subdiv 152 small-business
-- concessions, and returns net_capital_gain_cents — the FINAL post-ALL-concessions
-- assessable amount. We add that figure to assessable income (and pass through its
-- capital-loss summary for the approver). Capital losses live ENTIRELY inside
-- cgt_calc and are NOT the carried-forward losses in 3c (those are REVENUE losses).
-- If the org has no CGT events, cgt_calc returns 0 — the leg degrades cleanly.
--   CAVEAT (documented refinement, same altitude as 0148's add-back name-match):
--   an accounting profit/loss on disposal of a CGT asset already sits inside
--   accounting profit (the 0148 subtotal). It is NOT yet backed out before adding
--   the statutory net capital gain, so for assets sold at an accounting gain/loss
--   the two can overlap. The clean fix needs a per-account "disposal of CGT asset"
--   classification (the same per-account tax_treatment flag 0148 defers); surfaced
--   in caveats here rather than silently mis-stated.
--
-- ── 3b. FRANKING GROSS-UP (s207-20) ────────────────────────────────────────────
-- A franked distribution is assessable for BOTH the cash dividend AND the attached
-- franking (imputation) credit (s207-20): the credit is "grossed up" into
-- assessable income, and a tax OFFSET of the same amount applies against tax
-- payable (SC-4.H.03 — non-refundable for companies, refundable for individuals /
-- complying super). The cash dividend, if received, is already ordinary income in
-- the GL accounting profit; the credit is a TAX-ONLY add not in the books, so we
-- gross it up here. franking_credits_received_cents is the CREDIT amount only (not
-- the cash dividend) — adding it does not double-count the dividend. This slice
-- both surfaces the credit (for the 0150 offset) AND grosses it into assessable
-- income (so taxable income is correct). Default 0 ⇒ no effect.
--
-- ── 3c. CARRIED-FORWARD REVENUE (TAX) LOSSES (Div 36) ──────────────────────────
-- Prior-year tax losses are a deduction in working out taxable income (s36-15/-17),
-- deductible only down to nil (they never create a refund; the unused remainder
-- carries on). Unlike CAPITAL losses (reproducible from cgt_events, so cgt_calc
-- derives them), revenue losses cannot be reliably reconstructed from the GL: the
-- trial balance behind generate_statutory_statements is cumulative-to-date
-- (basis=cumulative_to_date), so a per-prior-FY taxable result is not isolatable.
-- They are therefore a CURATED opening-balance input on business_profile
-- (prior_year_tax_losses_cents), defaulting to 0 — mirroring the per-event CGT
-- elections (0144) and 0148's "implement the mechanism, defer the clean per-row
-- design" altitude. ORDERING:
--     income_before_losses = subtotal(0148) + net_capital_gain + franking_grossup
--     losses_applied       = least(available_prior_losses, max(0, income_before_losses))
--     taxable_income       = max(0, income_before_losses - available_prior_losses)
--     current_year_loss    = max(0, -income_before_losses)
--     losses_carried_fwd   = (available - losses_applied) + current_year_loss
-- A negative income_before_losses is itself a current-year tax loss that adds to
-- the carry-forward and uses none of the prior pool; a positive one is reduced (to
-- nil at most) by the prior pool. book_to_tax is STABLE/read-only, so it REPORTS
-- the new carry-forward but does not persist it (the finalise step in 4.I/4.H.03
-- owns write-back).
--   CAVEAT: prior_year_tax_losses_cents is a single opening balance, applied for
--   whatever p_fy_start_year is requested (an FY-keyed loss schedule is the
--   documented refinement); and the Div 36 "deduct from net exempt income first"
--   step is not modelled (no exempt-income concept). Both surfaced in caveats.
--
-- SECURITY INVOKER + STABLE (read-only) — unchanged from 0148: every read
-- (generate_statutory_statements, cgt_calc, depreciation_schedules, fixed_assets,
-- business_profile) is RLS-scoped to the caller, so a foreign org degrades to zeros
-- rather than leaking; a service_role backend bypasses RLS.
--
-- MIGRATION NUMBER: the ledger Files line planned 0140, long taken
-- (0140_cgt_discount). Reassigned to 0149 per the drift rule — the sequential repo
-- head is 0148_book_to_tax (0178/0179 are late hotfixes that sort after). Verified
-- live (dxoikltymmknxqpkpyhi): book_to_tax / cgt_calc / build_return are
-- committed-but-not-deployed (only generate_statutory_statements is live); the
-- 0138–0149 chain deploys together. business_profile present with no franking/loss
-- columns and no franking/loss/dividend tables anywhere — confirming these two
-- inputs are genuinely new.

-- ── 1. Curated tax inputs on business_profile (default 0 — never auto-applied) ──
alter table public.business_profile
  add column if not exists prior_year_tax_losses_cents bigint not null default 0
    check (prior_year_tax_losses_cents >= 0),
  add column if not exists franking_credits_received_cents bigint not null default 0
    check (franking_credits_received_cents >= 0);

comment on column public.business_profile.prior_year_tax_losses_cents is
  'SC-4.H.02: carried-forward REVENUE (tax) losses available to deduct in working '
  'out taxable income (ITAA 1997 Div 36), money-in-cents. A curated opening balance '
  '(cannot be reconstructed from the cumulative-to-date GL); read by book_to_tax, '
  'applied down to nil with the unused remainder carried on. Default 0. An FY-keyed '
  'loss schedule is the documented refinement.';
comment on column public.business_profile.franking_credits_received_cents is
  'SC-4.H.02: franking (imputation) CREDITS attached to franked distributions '
  'received in the FY (the credit only, NOT the cash dividend), money-in-cents. '
  'book_to_tax grosses this up into assessable income (ITAA 1997 s207-20); the '
  'matching tax offset is applied in SC-4.H.03. Default 0.';

-- ── 2. book_to_tax: + CGT inclusion + franking gross-up + revenue-loss offset ──
create or replace function public.book_to_tax(p_org uuid, p_fy_start_year integer)
  returns jsonb
  language plpgsql
  stable
  security invoker
  set search_path = public
as $$
declare
  v_fy_start          date := make_date(p_fy_start_year, 7, 1);
  v_fy_end            date := make_date(p_fy_start_year + 1, 6, 30);
  v_stmt              jsonb;
  v_pl                jsonb;
  v_expenses          jsonb;
  v_accounting_profit bigint;
  v_add_backs         jsonb;
  v_total_add_backs   bigint;
  v_book_dep          bigint;
  v_tax_dep           bigint;
  v_dep_diff          bigint;
  v_subtotal          bigint;        -- 0148 subtotal: profit + add-backs + dep diff
  -- new in 0149:
  v_entity_type       text;
  v_prior_losses      bigint;        -- curated carried-forward REVENUE losses (input)
  v_franking          bigint;        -- franking credits received (input)
  v_cgt               jsonb;
  v_ncg               bigint;        -- final net capital gain (post all CGT concessions)
  v_income_b4_losses  bigint;        -- assessable income before prior-year loss recoupment
  v_losses_applied    bigint;
  v_cy_loss           bigint;        -- current-year tax loss generated
  v_losses_cf         bigint;        -- revenue losses carried to the NEXT FY
  v_taxable_income    bigint;        -- FINAL taxable income (>= 0)
begin
  -- Accounting result + GL expense line items from the statutory statements (0134).
  v_stmt              := generate_statutory_statements(p_org, p_fy_start_year);
  v_pl                := v_stmt -> 'profit_and_loss';
  v_expenses          := coalesce(v_pl -> 'expenses', '[]'::jsonb);
  v_accounting_profit := coalesce((v_pl ->> 'net_profit_cents')::bigint, 0);

  -- 1. Non-deductible add-backs: match each expense account name against the curated
  -- ITAA non-deductible set (one row per matched account; depreciation excluded).
  with rules(ord, pattern, reason) as (
    values
      (1, '\m(entertainment)\M',                'Entertainment expense — non-deductible (ITAA 1997 Div 32)'),
      (2, '\m(fine|fines|penalty|penalties)\M', 'Fines & penalties — non-deductible (ITAA 1997 s26-5)'),
      (3, 'income tax',                         'Income tax expense — non-deductible (ITAA 1997 s26-5)'),
      (4, '\m(private|domestic)\M',             'Private/domestic portion — non-deductible (ITAA 1997 s8-1)')
  ),
  matched as (
    select
      e ->> 'account_code'           as account_code,
      e ->> 'account_name'           as account_name,
      (e ->> 'amount_cents')::bigint as amount_cents,
      r.reason
    from jsonb_array_elements(v_expenses) as e
    cross join lateral (
      select reason
      from rules
      where (e ->> 'account_name') ~* pattern
      order by ord
      limit 1
    ) r
    where (e ->> 'account_name') !~* '\mdepreciation\M'   -- reconciled separately below
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'account_code', account_code,
      'account_name', account_name,
      'amount_cents', amount_cents,
      'reason',       reason
    ) order by account_code), '[]'::jsonb),
    coalesce(sum(amount_cents), 0)
  into v_add_backs, v_total_add_backs
  from matched;

  -- 2a. Book depreciation = GL depreciation expense (account 6700; matched by name).
  select coalesce(sum((e ->> 'amount_cents')::bigint), 0)
    into v_book_dep
  from jsonb_array_elements(v_expenses) as e
  where (e ->> 'account_name') ~* '\mdepreciation\M';

  -- 2b. Tax depreciation = ATO-basis charge from active assets' live schedules, summed
  -- across the 12 FY month-ends (compute_depreciation is per-month). Degrades to 0 when
  -- the org has no eligible schedules.
  select coalesce(sum(compute_depreciation(s.id, m.month_end)), 0)
    into v_tax_dep
  from depreciation_schedules s
  join fixed_assets a on a.id = s.fixed_asset_id
  cross join (
    select (date_trunc('month', v_fy_start + (g.n || ' months')::interval)
            + interval '1 month - 1 day')::date as month_end
    from generate_series(0, 11) as g(n)
  ) m
  where s.organization_id = p_org
    and s.deleted_at is null
    and a.deleted_at is null
    and a.status = 'active';

  v_dep_diff := v_book_dep - v_tax_dep;

  -- 0148 subtotal: net ordinary business income on a tax basis (pre-CGT/loss).
  v_subtotal := v_accounting_profit + v_total_add_backs + v_dep_diff;

  -- 3. Curated tax inputs + the CGT result (all default-safe to 0 / 'other').
  -- The defaults are applied AFTER the select on purpose: SELECT INTO sets EVERY
  -- target to NULL when the org has no business_profile row, and an in-select
  -- coalesce would not fire in that no-row case — so the post-select coalesce is the
  -- single guard (the *_cents columns are NOT NULL, so it is also all they need).
  select entity_type, prior_year_tax_losses_cents, franking_credits_received_cents
    into v_entity_type, v_prior_losses, v_franking
  from business_profile
  where organization_id = p_org;
  v_entity_type  := coalesce(v_entity_type, 'other');
  v_prior_losses := coalesce(v_prior_losses, 0);
  v_franking     := coalesce(v_franking, 0);

  -- 3a. Net capital gain (s102-5) — final post-ALL-concessions figure from cgt_calc.
  v_cgt := cgt_calc(p_org, p_fy_start_year);
  v_ncg := coalesce((v_cgt ->> 'net_capital_gain_cents')::bigint, 0);

  -- 3b. Franking gross-up (s207-20) + 3a CGT inclusion → assessable income before
  -- prior-year loss recoupment (may be negative = a current-year tax loss).
  v_income_b4_losses := v_subtotal + v_ncg + v_franking;

  -- 3c. Carried-forward REVENUE losses (Div 36): deductible only down to nil; the
  -- unused prior pool plus any current-year loss carries to the next FY.
  v_losses_applied := least(v_prior_losses, greatest(0, v_income_b4_losses));
  v_taxable_income := greatest(0, v_income_b4_losses - v_prior_losses);
  v_cy_loss        := greatest(0, -v_income_b4_losses);
  v_losses_cf      := (v_prior_losses - v_losses_applied) + v_cy_loss;

  return jsonb_build_object(
    'organization_id',         p_org,
    'fy_start_year',           p_fy_start_year,
    'period_start',            v_fy_start,
    'period_end',              v_fy_end,
    'entity_type',             v_entity_type,
    'basis',                   coalesce(v_stmt ->> 'basis', 'cumulative_to_date'),
    'accounting_profit_cents', v_accounting_profit,
    'add_backs', jsonb_build_object(
      'lines',       v_add_backs,
      'total_cents', v_total_add_backs
    ),
    'depreciation_reconciliation', jsonb_build_object(
      'book_depreciation_cents', v_book_dep,
      'tax_depreciation_cents',  v_tax_dep,
      'difference_cents',        v_dep_diff,
      'note', 'book − tax: a positive difference increases taxable income (book over-depreciated vs the ATO schedule basis)'
    ),
    'taxable_income_subtotal_cents', v_subtotal,   -- 0148 subtotal (pre-CGT/franking/loss)
    -- 3a. Net capital gain folded in (s102-5); capital losses are netted inside cgt_calc.
    'capital_gains', jsonb_build_object(
      'net_capital_gain_cents',                       v_ncg,
      'current_year_capital_gains_cents',             coalesce((v_cgt ->> 'current_year_capital_gains_cents')::bigint, 0),
      'current_year_capital_losses_cents',            coalesce((v_cgt ->> 'current_year_capital_losses_cents')::bigint, 0),
      'carried_forward_capital_losses_applied_cents', coalesce((v_cgt ->> 'carried_forward_losses_applied_cents')::bigint, 0),
      'net_capital_loss_carried_forward_cents',       coalesce((v_cgt ->> 'net_capital_loss_carried_forward_cents')::bigint, 0),
      'source', 'cgt_calc (SC-4.E/4.F); net of the Div 115 discount + Subdiv 152 concessions'
    ),
    -- 3b. Franking gross-up (s207-20); the offset itself is SC-4.H.03.
    'franking', jsonb_build_object(
      'credits_received_cents',           v_franking,
      'grossed_up_into_assessable_income', true,
      'note', 'Credit grossed up into assessable income (s207-20); the matching tax offset (non-refundable for companies, refundable for individuals/complying super) is applied in SC-4.H.03.'
    ),
    'assessable_income_before_losses_cents', v_income_b4_losses,  -- subtotal + net capital gain + franking gross-up
    -- 3c. Carried-forward REVENUE losses (Div 36) — distinct from the capital losses above.
    'revenue_losses', jsonb_build_object(
      'available_cents',      v_prior_losses,
      'applied_cents',        v_losses_applied,
      'current_year_loss_cents', v_cy_loss,
      'carried_forward_cents', v_losses_cf,
      'source', 'business_profile.prior_year_tax_losses_cents (curated opening balance)'
    ),
    'taxable_income_cents', v_taxable_income,   -- FINAL taxable income; SC-4.H.03 computes tax payable
    'caveats', jsonb_build_array(
      'Net capital gain is added on top of accounting profit; an accounting profit/loss on disposal of a CGT asset already inside accounting profit is NOT yet backed out (needs a per-account disposal classification — documented refinement).',
      'Carried-forward revenue losses are a single curated opening balance (business_profile.prior_year_tax_losses_cents) applied for whatever FY is requested; an FY-keyed loss schedule is the documented refinement.',
      'The Div 36 "deduct losses from net exempt income first" step is not modelled (no exempt-income concept); losses are deducted directly from assessable income.',
      'For companies, an excess franking offset is non-refundable and converts to a tax loss (s36-55); refundability and that conversion are handled in SC-4.H.03, not here.'
    ),
    'note', 'Taxable income = accounting profit + non-deductible add-backs + depreciation difference (subtotal, SC-4.H.01) + net capital gain (s102-5) + franking gross-up (s207-20), less carried-forward revenue losses (Div 36, to nil). Tax payable and the franking / PAYG / SBITO offsets are SC-4.H.03.'
  );
end;
$$;

comment on function public.book_to_tax(uuid, integer) is
  'SC-4.H.02: book-to-tax reconciliation (jsonb) for an org + AU FY. Extends '
  'SC-4.H.01 (accounting profit + non-deductible add-backs + depreciation '
  'difference) by folding in the net capital gain (cgt_calc, s102-5), the franking '
  'gross-up (s207-20), and carried-forward REVENUE losses (Div 36, deducted to nil). '
  'Returns final TAXABLE INCOME (taxable_income_cents) plus the franking credit for '
  'the SC-4.H.03 offset. Capital losses are netted inside cgt_calc; revenue losses '
  'are the curated business_profile.prior_year_tax_losses_cents input. Tax payable '
  'and offsets/credits are SC-4.H.03. SECURITY INVOKER — RLS scopes the caller.';

revoke all on function public.book_to_tax(uuid, integer) from public, anon;
grant execute on function public.book_to_tax(uuid, integer) to authenticated;
