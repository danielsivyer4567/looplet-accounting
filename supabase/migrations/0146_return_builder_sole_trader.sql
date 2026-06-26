-- 0146_return_builder_sole_trader.sql — SC-4.G.02 (Phase 4, entity-aware return builder)
--
-- Extends build_return(org, fy_start_year) with the SOLE_TRADER branch. The company
-- branch (SC-4.G.01, 0145) is unchanged; partnership/trust arrive in SC-4.G.03 and
-- still RAISE feature_not_supported here; smsf has its own return in Phase 5 (SC-5.K).
--
-- ── REFACTOR vs 0145 ───────────────────────────────────────────────────────────
-- 0145 RAISEd for every non-company entity_type BEFORE sourcing the statements. With
-- a second supported branch, the source (generate_statutory_statements → the GL P&L)
-- is now loaded ONCE up front for the supported set, then the dispatch only chooses
-- the LABEL mapping + payload shape. The gate moves to an allow-list: anything outside
-- {company, sole_trader} RAISEs feature_not_supported (errcode 0A000) exactly as before.
--
-- ── SOLE TRADER RETURN MAPPING ─────────────────────────────────────────────────
-- A sole trader (individual carrying on a business) reports business income/expenses
-- on the Business and professional items schedule for individuals (NAT 2816), Item P8
-- "Business income and expenses"; the resulting net flows to Item 15 "Net income or
-- loss from business" on the individual return's supplementary section, then into
-- total/taxable income. So this branch maps the GL P&L to Item P8 + the Item-15 transfer:
--     each GL income  account → P8 income line   (catch-all label J "Other business income")
--     income subtotal         → P8 "Total business income" (a subtotal box, no label letter)
--     each GL expense account → P8 expense line  (catch-all label S "All other expenses")
--     expense subtotal        → P8 "Total expenses" (a subtotal box, no label letter)
--     income − expenses       → P8 label Z "Net income or loss from business"
--     P8 Z                     → Item 15 label C "Net non-primary production amount"
--
-- PRIMARY vs NON-PRIMARY PRODUCTION: Item P8 splits every line into a Primary-production
-- column (income letters C/E/N/G/I, net label Y → Item 15 B) and a Non-primary-production
-- column (income letters D/B/F/O/H/J, net label Z → Item 15 C). The GL carries no
-- PP/non-PP signal, so this branch DEFAULTS to non-primary production (the common case
-- for a sole trader) — surfaced explicitly as production_type='non_primary_production'
-- in the payload. A PP split (and the finer P8 income/expense sub-labels — cost of sales,
-- depreciation, superannuation, …) need per-account classification and are a documented
-- refinement, exactly as for the company Item-6 sub-labels in 0145; the subtotals and
-- the net (Z → 15-C) tie out regardless of how the lines are sub-bucketed.
--
-- Reconciliation items at P8 (e.g. label H "Expense reconciliation adjustments" — the
-- book-to-tax add-backs) are NOT applied here: build_return is the financial-accounts
-- re-labeller; the reconciliation to taxable income is book_to_tax (SC-4.H). So the
-- net here is the BOOK net income/loss from business, pre-reconciliation.
--
-- SECURITY INVOKER + STABLE (read-only): unchanged from 0145 — generate_statutory_-
-- statements and business_profile are RLS-scoped to the caller.
--
-- MIGRATION NUMBER: the ledger planned 0137, long taken (0137_eofy_orchestrate);
-- reassigned to 0146 per the drift rule — sequential repo head is 0145_return_builder
-- (0178/0179 are late hotfixes). Committed-but-not-deployed, staged with the 0138–0145
-- chain for the rolled-back live test.

create or replace function public.build_return(p_org uuid, p_fy_start_year integer)
  returns jsonb
  language plpgsql
  stable
  security invoker
  set search_path = public
as $$
declare
  v_fy_start      date := make_date(p_fy_start_year, 7, 1);
  v_fy_end        date := make_date(p_fy_start_year + 1, 6, 30);
  v_entity_type   text;
  v_stmt          jsonb;
  v_pl            jsonb;
  v_total_rev     bigint;
  v_total_exp     bigint;
  v_net_business  bigint;   -- total income − total expenses (the book net; reused across labels)
  v_income_lines  jsonb;
  v_expense_lines jsonb;
begin
  select entity_type into v_entity_type
  from business_profile
  where organization_id = p_org;

  if v_entity_type is null then
    raise exception 'build_return: no business_profile / entity_type for org %', p_org
      using errcode = 'no_data_found';
  end if;

  -- Supported branches: company (SC-4.G.01) + sole_trader (SC-4.G.02). partnership/
  -- trust arrive in SC-4.G.03; smsf has its own return in Phase 5 (SC-5.K). The
  -- explicit RAISE keeps the build green for every other entity_type until then.
  if v_entity_type not in ('company', 'sole_trader') then
    raise exception
      'build_return: unsupported entity_type "%" — only company and sole_trader are implemented (partnership/trust arrive in SC-4.G.03, smsf in Phase 5)',
      v_entity_type
      using errcode = '0A000';   -- feature_not_supported
  end if;

  -- Source the GL P&L line items from the statutory statements (SC-4.B.01, 0134) —
  -- common to both supported branches (one signing convention, one basis).
  v_stmt      := generate_statutory_statements(p_org, p_fy_start_year);
  v_pl        := v_stmt -> 'profit_and_loss';
  v_total_rev := coalesce((v_pl ->> 'total_revenue_cents')::bigint, 0);
  v_total_exp := coalesce((v_pl ->> 'total_expenses_cents')::bigint, 0);
  v_net_business := v_total_rev - v_total_exp;

  if v_entity_type = 'company' then
    -- COMPANY return Item 6 income lines: each GL income account → catch-all 6-C.
    select coalesce(jsonb_agg(jsonb_build_object(
             'account_code', e ->> 'account_code',
             'account_name', e ->> 'account_name',
             'form_item',    '6',
             'label_code',   'C',
             'label_name',   'Other sales of goods and services',
             'amount_cents', (e ->> 'amount_cents')::bigint
           ) order by e ->> 'account_code'), '[]'::jsonb)
      into v_income_lines
    from jsonb_array_elements(coalesce(v_pl -> 'revenue', '[]'::jsonb)) as e;

    -- COMPANY return Item 6 expense lines: each GL expense account → catch-all
    -- "Other expenses" (no single ATO box — expenses spread across letters; the
    -- per-account sub-classification is the documented refinement).
    select coalesce(jsonb_agg(jsonb_build_object(
             'account_code', e ->> 'account_code',
             'account_name', e ->> 'account_name',
             'form_item',    '6',
             'label_code',   null,
             'label_name',   'Other expenses',
             'amount_cents', (e ->> 'amount_cents')::bigint
           ) order by e ->> 'account_code'), '[]'::jsonb)
      into v_expense_lines
    from jsonb_array_elements(coalesce(v_pl -> 'expenses', '[]'::jsonb)) as e;

    return jsonb_build_object(
      'organization_id', p_org,
      'fy_start_year',   p_fy_start_year,
      'period_start',    v_fy_start,
      'period_end',      v_fy_end,
      'entity_type',     v_entity_type,
      'return_form',     'Company tax return (NAT 0656)',
      'basis',           coalesce(v_stmt ->> 'basis', 'cumulative_to_date'),
      -- Item 6 — Calculation of total profit or loss.
      'item6_total_profit_or_loss', jsonb_build_object(
        'income', jsonb_build_object(
          'lines', v_income_lines,
          'total', jsonb_build_object(
            'form_item', '6', 'label_code', 'S', 'label_name', 'Total income',
            'amount_cents', v_total_rev)
        ),
        'expenses', jsonb_build_object(
          'lines', v_expense_lines,
          'total', jsonb_build_object(
            'form_item', '6', 'label_code', 'Q', 'label_name', 'Total expenses',
            'amount_cents', v_total_exp)
        ),
        'total_profit_or_loss', jsonb_build_object(
          'form_item', '6', 'label_code', 'T', 'label_name', 'Total profit or loss',
          'amount_cents', v_net_business)   -- T = S − Q
      )
    );
  elsif v_entity_type = 'sole_trader' then
  -- ── SOLE_TRADER branch ────────────────────────────────────────────────────────
  -- P8 income lines: each GL income account → catch-all non-primary-production label
  -- J "Other business income".
  select coalesce(jsonb_agg(jsonb_build_object(
           'account_code', e ->> 'account_code',
           'account_name', e ->> 'account_name',
           'form_item',    'P8',
           'label_code',   'J',
           'label_name',   'Other business income',
           'amount_cents', (e ->> 'amount_cents')::bigint
         ) order by e ->> 'account_code'), '[]'::jsonb)
    into v_income_lines
  from jsonb_array_elements(coalesce(v_pl -> 'revenue', '[]'::jsonb)) as e;

  -- P8 expense lines: each GL expense account → catch-all non-primary-production label
  -- S "All other expenses" (the per-account P8 expense sub-labels are the documented
  -- refinement).
  select coalesce(jsonb_agg(jsonb_build_object(
           'account_code', e ->> 'account_code',
           'account_name', e ->> 'account_name',
           'form_item',    'P8',
           'label_code',   'S',
           'label_name',   'All other expenses',
           'amount_cents', (e ->> 'amount_cents')::bigint
         ) order by e ->> 'account_code'), '[]'::jsonb)
    into v_expense_lines
  from jsonb_array_elements(coalesce(v_pl -> 'expenses', '[]'::jsonb)) as e;

  return jsonb_build_object(
    'organization_id', p_org,
    'fy_start_year',   p_fy_start_year,
    'period_start',    v_fy_start,
    'period_end',      v_fy_end,
    'entity_type',     v_entity_type,
    'return_form',     'Individual tax return (NAT 2541) + Business and professional items schedule (NAT 2816)',
    'basis',           coalesce(v_stmt ->> 'basis', 'cumulative_to_date'),
    -- Default to the non-primary-production column — the GL carries no PP/non-PP signal.
    'production_type', 'non_primary_production',
    -- Item P8 — Business income and expenses (book amounts, pre book-to-tax reconciliation).
    'p8_business_income_and_expenses', jsonb_build_object(
      'income', jsonb_build_object(
        'lines', v_income_lines,
        'total', jsonb_build_object(
          'form_item', 'P8', 'label_code', null, 'label_name', 'Total business income',
          'amount_cents', v_total_rev)
      ),
      'expenses', jsonb_build_object(
        'lines', v_expense_lines,
        'total', jsonb_build_object(
          'form_item', 'P8', 'label_code', null, 'label_name', 'Total expenses',
          'amount_cents', v_total_exp)
      ),
      'net_income_or_loss_from_business', jsonb_build_object(
        'form_item', 'P8', 'label_code', 'Z',
        'label_name', 'Net income or loss from business (non-primary production)',
        'amount_cents', v_net_business)   -- Z = Total income − Total expenses
    ),
    -- Transfer P8 label Z → individual return supplementary Item 15 label C
    -- (15-C is by construction the same value as P8-Z — same local, not a re-derivation).
    'item15_net_income_or_loss_from_business', jsonb_build_object(
      'form_item', '15', 'label_code', 'C',
      'label_name', 'Net non-primary production amount',
      'source_label', 'P8 Z',
      'amount_cents', v_net_business)
  );
  end if;

  -- Unreachable: the allow-list above admits only company/sole_trader, both handled.
  -- If a future slice (SC-4.G.03) widens the allow-list without adding a branch, fail
  -- loudly here rather than silently routing a new entity into the sole_trader mapping.
  raise exception
    'build_return: entity_type "%" passed the allow-list but has no branch — allow-list and dispatch are out of sync',
    v_entity_type
    using errcode = 'XX000';   -- internal_error
end;
$$;

comment on function public.build_return(uuid, integer) is
  'SC-4.G.02: entity-aware tax-return label builder (jsonb) for an org + AU FY. '
  'Dispatches on business_profile.entity_type. COMPANY → Item 6 labels (income 6-C / '
  'Total income 6-S; expenses / Total expenses 6-Q; Total profit or loss 6-T = S − Q). '
  'SOLE_TRADER → Business and professional items schedule Item P8 (income → label J, '
  'expenses → label S, subtotals tie out) then net income or loss P8-Z → individual '
  'return supplementary Item 15-C; defaults to non-primary production. partnership/trust '
  'RAISE feature_not_supported until SC-4.G.03; smsf is Phase 5. SECURITY INVOKER — RLS '
  'scopes the caller. Book amounts only; the Item-7/reconciliation to taxable income is '
  'book_to_tax (SC-4.H).';

revoke all on function public.build_return(uuid, integer) from public, anon;
grant execute on function public.build_return(uuid, integer) to authenticated;
