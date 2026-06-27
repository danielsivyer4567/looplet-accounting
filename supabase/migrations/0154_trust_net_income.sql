-- 0154_trust_net_income.sql — SC-5.B.01 (Phase 5, Trusts — s95 net income)
--
-- trust_net_income(org, fy_start_year) — the net income of a trust estate under
-- ITAA 1936 s95(1): the trust's total assessable income calculated as if the trustee
-- were a resident taxpayer, less all allowable deductions. For trust distributions
-- this number must be split into INCOME CLASSES, because beneficiaries can be made
-- specifically entitled to (i.e. streamed) particular classes:
--   * ordinary income              — the residual business/other income class
--   * net capital gain             — Subdiv 115-C streaming (s115-227)
--   * franked distributions        — Subdiv 207-B streaming (s207-35..-58):
--     + attached franking credits    the franked dividend PLUS its franking credit
--   * foreign income               — flows with the foreign income tax offset (FITO)
-- The four classes sum to the s95 net income; the streaming optimiser (SC-5.C) reads
-- this split, and the persist target trust_distributions (0153) folds ordinary+foreign
-- into its `other_cents` bucket while capital gain / franked distribution stream.
--
-- ── REUSE: book_to_tax (SC-4.H) does the book-to-tax legwork ────────────────────
-- The ledger's cross-phase note: "if SC-4.H has landed, call it." It has (0148–0150).
-- book_to_tax(org, fy) already computes, from the GL, the tax-basis ordinary income
-- subtotal (accounting profit + non-deductible add-backs + book/tax depreciation
-- difference), the net capital gain (cgt_calc, post Div 115 + Subdiv 152), the
-- franking gross-up (s207-20), the carried-forward revenue-loss recoupment (Div 36),
-- and the FINAL taxable income. trust_net_income consumes those figures rather than
-- re-deriving them — so the s95 total here is exactly book_to_tax's taxable income and
-- the two can never drift. This slice ADDS only the class SPLIT, which book_to_tax
-- does not produce.
--
-- ── INCOME-CLASS SPLIT ─────────────────────────────────────────────────────────
-- book_to_tax gives the per-leg figures but not which GL revenue is franked / foreign.
-- The GL has no per-account income-class flag (a chart_of_accounts.income_class column
-- is the documented refinement — the same altitude as 0148's add-back name-match and
-- 0149's curated franking input), so revenue accounts are classified by NAME over the
-- generate_statutory_statements (0134) revenue line items:
--   * franked distribution cash : account name ~* '\m(franked|imputation)'  (CONSERVATIVE
--     — only explicitly-franked accounts; a plain "Dividend Income" account that is in
--     fact franked stays ordinary until the per-account flag lands. The authoritative
--     franking signal is the franking CREDIT, a curated input book_to_tax already reads.)
--   * foreign income            : account name ~* '\m(foreign|overseas)'
--   * everything else           : ordinary
-- Each class is then built so the four sum back to the s95 net income:
--   ncg_class      = book_to_tax net capital gain
--   franked_class  = franked-dividend cash (GL) + franking credit (s207-20 gross-up)
--   foreign_class  = foreign-income cash (GL)
--   ordinary_class = tax-basis ordinary subtotal − franked cash − foreign cash
--                    − prior-year revenue losses applied
-- Prior-year revenue losses (Div 36) are deducted from the ORDINARY class, not pro-rata
-- across classes: streamed net capital gains and franked distributions retain their
-- character and are not reduced by the trust's general losses (the point of streaming).
-- A `reconciles` flag asserts the four classes sum to book_to_tax's independent taxable
-- income — true in a normal (net-income-positive) year; it goes false only in the
-- edge case where an overall loss clamps taxable income to nil while a streamed class
-- is positive (a current-year trust loss), which the streaming overlay (SC-5.C.03)
-- resolves — surfaced in caveats, not silently mis-stated.
--
-- s95 net income is nil in a loss year (the loss is trapped and carried forward under
-- the trust-loss rules, not distributed — cf. trust_distributions' non-negative CHECK);
-- book_to_tax.taxable_income_cents is already clamped at nil, so net_income_cents is too.
--
-- SECURITY INVOKER + STABLE (read-only) — unchanged from book_to_tax: every read
-- (book_to_tax → generate_statutory_statements / cgt_calc / business_profile, all
-- RLS-scoped to the caller) degrades a foreign org to zeros rather than leaking. No
-- writes — the s95 number is independently assertable and cheap to recompute; persistence
-- of any proposed distribution is SC-5.C.04.
--
-- MIGRATION NUMBER: the ledger Files line planned 0145, long taken (book_to_tax took
-- 0148–0150). Reassigned to 0154 per the drift rule — the sequential repo head is
-- 0153_trust_distributions (0178/0179 are late hotfixes that sort after). Verified live
-- (dxoikltymmknxqpkpyhi, read-only): trust_net_income absent (no drift);
-- generate_statutory_statements + v_trial_balance + business_profile live; book_to_tax /
-- cgt_calc committed-but-not-deployed (the 0138–0154 chain deploys together);
-- business_profile.entity_type CHECK includes 'trust'.

create or replace function public.trust_net_income(p_org uuid, p_fy_start_year integer)
  returns jsonb
  language plpgsql
  stable
  security invoker
  set search_path = public
as $$
declare
  v_fy_start         date := make_date(p_fy_start_year, 7, 1);
  v_fy_end           date := make_date(p_fy_start_year + 1, 6, 30);
  v_btt              jsonb;
  v_entity_type      text;
  v_basis            text;
  v_subtotal         bigint;   -- tax-basis ordinary income (pre-CGT/franking/loss), 0148
  v_ncg              bigint;   -- net capital gain (post all CGT concessions), cgt_calc
  v_franking_credit  bigint;   -- franking credit grossed up (s207-20)
  v_losses_applied   bigint;   -- prior-year revenue losses recouped (Div 36)
  v_taxable_income   bigint;   -- book_to_tax FINAL taxable income = the s95 total
  -- GL revenue classification
  v_stmt             jsonb;
  v_revenue          jsonb;
  v_franked_cash     bigint;   -- franked-dividend cash from the GL (name-matched)
  v_foreign_cash     bigint;   -- foreign income cash from the GL (name-matched)
  v_class_lines      jsonb;    -- audit trail of the franked/foreign accounts matched
  -- derived classes
  v_franked_class    bigint;   -- franked cash + franking credit
  v_ordinary         bigint;
  v_classes_sum      bigint;
begin
  -- 1. Book-to-tax legwork (SC-4.H) — the s95 total and its per-leg figures.
  v_btt             := book_to_tax(p_org, p_fy_start_year);
  v_entity_type     := coalesce(v_btt ->> 'entity_type', 'other');
  v_basis           := coalesce(v_btt ->> 'basis', 'cumulative_to_date');
  v_subtotal        := coalesce((v_btt ->> 'taxable_income_subtotal_cents')::bigint, 0);
  v_ncg             := coalesce((v_btt #>> '{capital_gains,net_capital_gain_cents}')::bigint, 0);
  v_franking_credit := coalesce((v_btt #>> '{franking,credits_received_cents}')::bigint, 0);
  v_losses_applied  := coalesce((v_btt #>> '{revenue_losses,applied_cents}')::bigint, 0);
  v_taxable_income  := coalesce((v_btt ->> 'taxable_income_cents')::bigint, 0);

  -- 2. Classify GL revenue lines into franked / foreign / ordinary by account name.
  v_stmt    := generate_statutory_statements(p_org, p_fy_start_year);
  v_revenue := coalesce(v_stmt #> '{profit_and_loss,revenue}', '[]'::jsonb);

  with rev as (
    select
      e ->> 'account_code'           as account_code,
      e ->> 'account_name'           as account_name,
      (e ->> 'amount_cents')::bigint as amount_cents,
      case
        when (e ->> 'account_name') ~* '\m(franked|imputation)' then 'franked'
        when (e ->> 'account_name') ~* '\m(foreign|overseas)'   then 'foreign'
        else 'ordinary'
      end as income_class
    from jsonb_array_elements(v_revenue) as e
  )
  select
    coalesce(sum(amount_cents) filter (where income_class = 'franked'), 0),
    coalesce(sum(amount_cents) filter (where income_class = 'foreign'), 0),
    coalesce(jsonb_agg(jsonb_build_object(
      'account_code', account_code,
      'account_name', account_name,
      'amount_cents', amount_cents,
      'income_class', income_class
    ) order by account_code) filter (where income_class <> 'ordinary'), '[]'::jsonb)
  into v_franked_cash, v_foreign_cash, v_class_lines
  from rev;

  -- 3. Build the four income classes so they sum back to the s95 net income.
  v_franked_class := v_franked_cash + v_franking_credit;
  -- Ordinary = tax-basis ordinary income, less the franked/foreign cash reclassified
  -- out of it, less the prior-year revenue losses (deducted from the ordinary class).
  v_ordinary      := v_subtotal - v_franked_cash - v_foreign_cash - v_losses_applied;
  v_classes_sum   := v_ordinary + v_ncg + v_franked_class + v_foreign_cash;

  return jsonb_build_object(
    'organization_id', p_org,
    'fy_start_year',   p_fy_start_year,
    'period_start',    v_fy_start,
    'period_end',      v_fy_end,
    'entity_type',     v_entity_type,
    'basis',           v_basis,
    -- The s95 net income (ITAA 1936 s95(1)); nil in a loss year (clamped by book_to_tax).
    'net_income_cents', v_taxable_income,
    'income_classes', jsonb_build_object(
      'ordinary_cents',         v_ordinary,
      'net_capital_gain_cents', v_ncg,
      'franked_distribution', jsonb_build_object(
        'cash_dividends_cents',   v_franked_cash,
        'franking_credits_cents', v_franking_credit,
        'class_total_cents',      v_franked_class
      ),
      'foreign_cents',          v_foreign_cash,
      'classes_sum_cents',      v_classes_sum,
      -- True when the four classes form a VALID, non-negative partition of the s95 net
      -- income: they sum to book_to_tax's taxable income AND the residual ordinary class
      -- is non-negative. (The other three classes are non-negative by construction, so
      -- ordinary is the only one that can go negative.) False in a current-year trust
      -- loss (the classes do not sum to the nil-clamped net income) or when general
      -- deductions exceed the ordinary income so ordinary goes negative — both cases the
      -- streaming overlay (SC-5.C.03) resolves; surfaced here, not silently mis-stated.
      'reconciles',             (v_classes_sum = v_taxable_income and v_ordinary >= 0)
    ),
    'revenue_classification', jsonb_build_object(
      'lines',  v_class_lines,
      'source', 'generate_statutory_statements (0134) revenue lines, classified by account name'
    ),
    -- Pass through the book_to_tax detail the approver/optimiser needs.
    'book_to_tax', jsonb_build_object(
      'taxable_income_subtotal_cents', v_subtotal,
      'net_capital_gain_cents',        v_ncg,
      'franking_credits_cents',        v_franking_credit,
      'revenue_losses_applied_cents',  v_losses_applied,
      'taxable_income_cents',          v_taxable_income
    ),
    'caveats', jsonb_build_array(
      'Income-class split classifies GL revenue by account name (franked|imputation / foreign|overseas); a per-account chart_of_accounts.income_class flag is the documented refinement. Only explicitly-franked accounts are treated as the franked class — a franked account named plainly "Dividend Income" stays ordinary until that flag lands.',
      'Prior-year revenue losses (Div 36) are deducted from the ordinary class, not pro-rata across classes (streamed net capital gains and franked distributions retain their character).',
      'reconciles is false when the simple class split is not a valid non-negative partition of the s95 net income: either a current-year trust loss clamps net income to nil (the loss is trapped and carried forward), or general deductions exceed the ordinary income so the residual ordinary class goes negative (e.g. a trust whose income is mostly franked distributions). The streaming overlay (SC-5.C.03) allocates deductions across classes in those cases.'
    ),
    'note', 'Net income of the trust estate (ITAA 1936 s95(1)) split into income classes for streaming (Subdiv 115-C net capital gain, Subdiv 207-B franked distributions, foreign income, ordinary). Total = book_to_tax taxable income (SC-4.H). Read by the distribution optimiser SC-5.C; no writes.'
  );
end;
$$;

comment on function public.trust_net_income(uuid, integer) is
  'SC-5.B.01: net income of a trust estate (ITAA 1936 s95, jsonb) for an org + AU FY, '
  'split into the income classes a trust can stream — ordinary, net capital gain '
  '(Subdiv 115-C), franked distributions + attached franking credits (Subdiv 207-B), '
  'and foreign income. Reuses book_to_tax (SC-4.H) for the s95 total and per-leg figures '
  'and classifies GL revenue by account name; the four classes sum to book_to_tax taxable '
  'income (reconciles flag). Read by the distribution optimiser (SC-5.C). SECURITY '
  'INVOKER — RLS scopes the caller; no writes.';

revoke all on function public.trust_net_income(uuid, integer) from public, anon;
grant execute on function public.trust_net_income(uuid, integer) to authenticated;
