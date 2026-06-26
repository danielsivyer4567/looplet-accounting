-- 0147_return_builder_partnership_trust.sql — SC-4.G.03 (Phase 4, entity-aware return builder)
--
-- Extends build_return(org, fy_start_year) with the PARTNERSHIP and TRUST branches.
-- company (SC-4.G.01, 0145) and sole_trader (SC-4.G.02, 0146) are unchanged; smsf has
-- its own return in Phase 5 (SC-5.K). Partnership + trust are grouped here because both
-- are flow-through entities reporting on an IDENTICAL Item 5 business-income structure.
--
-- ── PARTNERSHIP / TRUST RETURN MAPPING (ATO-cited) ─────────────────────────────────
-- Both forms report Business income and expenses at **Item 5** with the SAME label set:
--     Partnership tax return (NAT 0659)   /   Trust tax return (NAT 0660)
-- Item 5 has three columns — Primary production / Non-primary production / Totals. The
-- GL carries no PP/non-PP signal, so (exactly like the sole-trader P8 branch in 0146)
-- this branch DEFAULTS to the non-primary-production column, surfaced as
-- production_type='non_primary_production'. Non-PP labels:
--     each GL income  account → label H "Other business income"
--     income subtotal         → "Total business income" (an unlettered subtotal box)
--     each GL expense account → label N "All other expenses"
--     expense subtotal        → label O "Total expenses"
--     income − expenses       → label R "Net income or loss from business" (non-PP)
-- (The Totals-column net is label S; with no PP it equals the non-PP net R. The finer
-- per-account expense sub-labels — cost of sales P, superannuation, etc. — and the PP
-- split are a documented refinement, parallel to the company Item-6 and sole-trader P8
-- sub-labels. Item 5 reconciliation items (labels A/B) are the book-to-tax add-backs and
-- are NOT applied here — build_return maps book amounts; the reconciliation to taxable
-- income is book_to_tax, SC-4.H. So the net here is the BOOK business net.)
--
-- ── FLOW-THROUGH / DISTRIBUTION SCAFFOLD ───────────────────────────────────────────
-- A partnership/trust is not taxed itself: its net income is DISTRIBUTED to partners/
-- beneficiaries via the Statement of distribution. This slice MAPS LABELS ONLY — it does
-- NOT compute the per-partner / per-beneficiary allocation (the optimal split). That is
-- the trust distribution optimiser, Phase-5 **SC-5.C**. The `distribution_statement` here
-- is an empty-allocations scaffold that records where the net flows + the share labels.
--   PARTNERSHIP: Statement of distribution = Item 54; partner non-PP share = label B.
--   TRUST:       Statement of distribution = Item 57; beneficiary share of trust estate
--                = label W, non-PP share = label B. PLUS the s95 net-income scaffold:
--                Item 26 "Total net income or loss" = the s95 ITAA 1936 "net income of the
--                trust estate" — the figure that is distributed.
-- The statement-of-distribution ITEM NUMBER year-drifts (partnership 53/54, trust 54/57);
-- the Item 5 label set is stable across years. Pinned to the recent form year with this
-- caveat — the amounts/labels are authoritative, the distribution item number is metadata.
--
-- The entity-level Item 20 "Net Australian income or loss" (label $) and the trust Item 26
-- fold in other-income/deduction items (6–19) that build_return does not yet source; the
-- scaffold therefore carries the BUSINESS net (`basis:'business_net_only'`), widened when
-- those items land — exactly the documented-refinement posture of 0145/0146.
--
-- SECURITY INVOKER + STABLE (read-only): unchanged from 0145/0146.
--
-- MIGRATION NUMBER: the ledger planned 0138, long taken (0138_cgt_events); reassigned to
-- 0147 per the drift rule — sequential repo head is 0146_return_builder_sole_trader
-- (0178/0179 are late hotfixes). Committed-but-not-deployed, staged with the 0138–0146
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
  v_return_form   text;     -- partnership/trust: entity-specific form name
  v_dist_item     text;     -- partnership/trust: statement-of-distribution item number (year-drifts)
  v_dist_share    text;     -- partnership/trust: per-partner / per-beneficiary share label hint
  v_payload       jsonb;    -- partnership/trust: assembled return (s95 block concat'd for trust)
begin
  select entity_type into v_entity_type
  from business_profile
  where organization_id = p_org;

  if v_entity_type is null then
    raise exception 'build_return: no business_profile / entity_type for org %', p_org
      using errcode = 'no_data_found';
  end if;

  -- Supported branches: company (SC-4.G.01) + sole_trader (SC-4.G.02) + partnership and
  -- trust (SC-4.G.03). smsf has its own return in Phase 5 (SC-5.K). The explicit RAISE
  -- keeps the build green for every other entity_type until then.
  if v_entity_type not in ('company', 'sole_trader', 'partnership', 'trust') then
    raise exception
      'build_return: unsupported entity_type "%" — company, sole_trader, partnership and trust are implemented (smsf has its own return in Phase 5 SC-5.K)',
      v_entity_type
      using errcode = '0A000';   -- feature_not_supported
  end if;

  -- Source the GL P&L line items from the statutory statements (SC-4.B.01, 0134) —
  -- common to every supported branch (one signing convention, one basis).
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
  elsif v_entity_type in ('partnership', 'trust') then
  -- ── PARTNERSHIP / TRUST branch ────────────────────────────────────────────────
  -- Both flow-through entities report business income/expenses at Item 5 with an
  -- IDENTICAL label set on NAT 0659 (partnership) and NAT 0660 (trust): non-primary-
  -- production income catch-all H, expense catch-all N, Total expenses O, Net income
  -- or loss from business (non-PP) R. They diverge only in the form name, the trust's
  -- s95 net-income item (26), and the statement-of-distribution item number.
  --
  -- Item 5 income lines: each GL income account → non-PP label H "Other business income".
  select coalesce(jsonb_agg(jsonb_build_object(
           'account_code', e ->> 'account_code',
           'account_name', e ->> 'account_name',
           'form_item',    '5',
           'label_code',   'H',
           'label_name',   'Other business income',
           'amount_cents', (e ->> 'amount_cents')::bigint
         ) order by e ->> 'account_code'), '[]'::jsonb)
    into v_income_lines
  from jsonb_array_elements(coalesce(v_pl -> 'revenue', '[]'::jsonb)) as e;

  -- Item 5 expense lines: each GL expense account → label N "All other expenses".
  select coalesce(jsonb_agg(jsonb_build_object(
           'account_code', e ->> 'account_code',
           'account_name', e ->> 'account_name',
           'form_item',    '5',
           'label_code',   'N',
           'label_name',   'All other expenses',
           'amount_cents', (e ->> 'amount_cents')::bigint
         ) order by e ->> 'account_code'), '[]'::jsonb)
    into v_expense_lines
  from jsonb_array_elements(coalesce(v_pl -> 'expenses', '[]'::jsonb)) as e;

  -- Entity-specific metadata (form name + statement-of-distribution item + share labels).
  if v_entity_type = 'partnership' then
    v_return_form := 'Partnership tax return (NAT 0659)';
    v_dist_item   := '54';   -- year-drifts (was 53 in 2022); Item 5 labels are stable
    v_dist_share  := 'Per-partner share — non-primary production = label B';
  else
    v_return_form := 'Trust tax return (NAT 0660)';
    v_dist_item   := '57';   -- year-drifts (was 54 pre-2017); Item 5 labels are stable
    v_dist_share  := 'Per-beneficiary share — share of income of the trust estate = label W, non-primary production = label B';
  end if;

  v_payload := jsonb_build_object(
    'organization_id', p_org,
    'fy_start_year',   p_fy_start_year,
    'period_start',    v_fy_start,
    'period_end',      v_fy_end,
    'entity_type',     v_entity_type,
    'return_form',     v_return_form,
    'basis',           coalesce(v_stmt ->> 'basis', 'cumulative_to_date'),
    -- Default to the non-primary-production column — the GL carries no PP/non-PP signal.
    'production_type', 'non_primary_production',
    -- Item 5 — Business income and expenses (book amounts, pre book-to-tax reconciliation).
    'item5_business_income_and_expenses', jsonb_build_object(
      'income', jsonb_build_object(
        'lines', v_income_lines,
        'total', jsonb_build_object(
          'form_item', '5', 'label_code', null, 'label_name', 'Total business income',
          'amount_cents', v_total_rev)
      ),
      'expenses', jsonb_build_object(
        'lines', v_expense_lines,
        'total', jsonb_build_object(
          'form_item', '5', 'label_code', 'O', 'label_name', 'Total expenses',
          'amount_cents', v_total_exp)
      ),
      'net_income_or_loss_from_business', jsonb_build_object(
        'form_item', '5', 'label_code', 'R',
        'label_name', 'Net income or loss from business (non-primary production)',
        'amount_cents', v_net_business)   -- R = Total business income − Total expenses; Totals net S = R with no PP
    ),
    -- Flow-through: the entity's net income is DISTRIBUTED to partners/beneficiaries.
    -- This slice maps labels only; the per-partner / per-beneficiary allocation (the
    -- optimal split) is the trust distribution optimiser, SC-5.C — NOT computed here.
    'distribution_statement', jsonb_build_object(
      'form_item',               v_dist_item,
      'label_name',              'Statement of distribution',
      'distributable_net_cents', v_net_business,
      'share_labels',            v_dist_share,
      'allocations',             '[]'::jsonb,   -- populated by SC-5.C, not here
      'note',                    'Per-partner / per-beneficiary allocation is computed by SC-5.C (trust distribution optimiser); this builder maps labels only.'
    )
  );

  -- Trust-only s95 net-income scaffold: the "net income of the trust estate" (Item 26
  -- "Total net income or loss") is the figure distributed to beneficiaries. Folds in
  -- other-income/deduction items (6–19) not yet sourced by build_return — currently the
  -- business net (basis 'business_net_only'); widened when those items land.
  if v_entity_type = 'trust' then
    v_payload := v_payload || jsonb_build_object(
      'item26_trust_net_income', jsonb_build_object(
        'form_item',    '26',
        'label_code',   null,
        'label_name',   'Total net income or loss (s95 net income of the trust estate)',
        'amount_cents', v_net_business,
        'basis',        'business_net_only',   -- excludes items 6–19 until sourced
        'source_label', 'Item 5 R'
      )
    );
  end if;

  return v_payload;
  end if;

  -- Unreachable: the allow-list above admits only company/sole_trader/partnership/trust,
  -- all handled. If a future slice widens the allow-list without adding a branch, fail
  -- loudly here rather than silently routing a new entity into a wrong mapping.
  raise exception
    'build_return: entity_type "%" passed the allow-list but has no branch — allow-list and dispatch are out of sync',
    v_entity_type
    using errcode = 'XX000';   -- internal_error
end;
$$;

comment on function public.build_return(uuid, integer) is
  'SC-4.G.03: entity-aware tax-return label builder (jsonb) for an org + AU FY. '
  'Dispatches on business_profile.entity_type. COMPANY → Item 6 (income 6-C / Total income '
  '6-S; expenses / Total expenses 6-Q; Total profit or loss 6-T = S − Q). SOLE_TRADER → '
  'Business and professional items schedule Item P8 (income J, expenses S) → individual '
  'return Item 15-C; non-primary production. PARTNERSHIP (NAT 0659) and TRUST (NAT 0660) → '
  'shared Item 5 (income H, expenses N, Total expenses O, Net income/loss R, non-primary '
  'production) + a Statement-of-distribution scaffold (partnership Item 54 / trust Item 57; '
  'empty allocations — the per-partner/beneficiary split is SC-5.C, not here); trust adds '
  'the s95 Item-26 net-income scaffold. smsf is Phase 5 (SC-5.K). SECURITY INVOKER — RLS '
  'scopes the caller. Book amounts only; the reconciliation to taxable income is book_to_tax '
  '(SC-4.H).';

revoke all on function public.build_return(uuid, integer) from public, anon;
grant execute on function public.build_return(uuid, integer) to authenticated;
