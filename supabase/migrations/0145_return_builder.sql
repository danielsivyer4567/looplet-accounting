-- 0145_return_builder.sql — SC-4.G.01 (Phase 4, entity-aware return builder)
--
-- build_return(org, fy_start_year) — maps the GL trial balance to TAX-RETURN labels,
-- dispatching on business_profile.entity_type. This slice implements the COMPANY
-- branch only (the most structured return); every other entity_type RAISEs a clear
-- "unsupported entity_type" so the build stays green until the sole_trader branch
-- (SC-4.G.02) and the partnership/trust branches (SC-4.G.03) land. SMSF has its own
-- return in Phase 5 (SC-5.K) and is NOT a branch here.
--
-- ── SOURCE: the statutory P&L, not v_trial_balance directly ────────────────────
-- build_return is a thin ENTITY-AWARE RE-LABELLER over generate_statutory_statements
-- (SC-4.B.01, 0134), which already signs each GL account into its statement-positive
-- amount off v_trial_balance (0074) and exposes profit_and_loss.{revenue,expenses}
-- line items + totals. Re-using it (rather than re-querying v_trial_balance) keeps
-- ONE signing convention and inherits its basis=cumulative_to_date limitation (the
-- trial balance is cumulative-to-date, so fy_start_year labels the period only — a
-- documented refinement, surfaced as 'basis' in the payload).
--
-- ── COMPANY RETURN MAPPING (NAT 0656, Item 6 "Calculation of total profit or loss") ─
-- Item 6 is the part of the company return sourced straight from the financial
-- accounts, BEFORE the Item-7 reconciliation to taxable income (add-backs / CGT /
-- losses) — that reconciliation is book_to_tax, SC-4.H. So the company branch maps
-- the GL P&L to Item 6:
--     each GL income  account → income line   (catch-all label 6-C "Other sales of
--                                               goods and services")
--     income subtotal         → label 6-S "Total income"
--     each GL expense account → expense line  (catch-all label "Other expenses")
--     expense subtotal        → label 6-Q "Total expenses"
--     income − expenses       → label 6-T "Total profit or loss"
-- The ATO relationship is authoritative: T (Total profit or loss) = S (Total income)
-- − Q (Total expenses). Lines are keyed by their STABLE descriptive name; finer Item-6
-- sub-labels (Cost of sales 6-A, Depreciation, Superannuation, Total salary & wages,
-- ...) need per-account classification and are a documented refinement — the totals
-- (6-S / 6-Q / 6-T) tie out regardless of how the lines are sub-bucketed, so the
-- catch-all mapping is exact at the level that matters to the return.
--
-- SECURITY INVOKER + STABLE (read-only): generate_statutory_statements and
-- business_profile are RLS-scoped to the caller, so a foreign org reads no profile
-- (→ a clear RAISE) and no GL rather than leaking; a service_role backend bypasses RLS.
--
-- MIGRATION NUMBER: the ledger planned 0136, long taken (0136_statement_notes);
-- reassigned to 0145 per the drift rule — the sequential repo head is
-- 0144_cgt_concession_retirement_rollover (0178/0179 are late hotfixes). Verified
-- live (dxoikltymmknxqpkpyhi): build_return absent; generate_statutory_statements
-- live; business_profile.entity_type CHECK = {sole_trader, partnership, company,
-- trust, smsf, other} (no 'individual'). Committed-but-not-deployed, staged with the
-- 0138–0144 CGT chain for the rolled-back live test.

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

  -- Only the company branch is mapped in SC-4.G.01. sole_trader is SC-4.G.02;
  -- partnership/trust are SC-4.G.03; smsf has its own return in Phase 5 (SC-5.K).
  -- The explicit RAISE keeps the build green for every other entity_type until then.
  if v_entity_type <> 'company' then
    raise exception
      'build_return: unsupported entity_type "%" — only company is implemented in SC-4.G.01 (sole_trader/partnership/trust arrive in SC-4.G.02/4.G.03, smsf in Phase 5)',
      v_entity_type
      using errcode = '0A000';   -- feature_not_supported
  end if;

  -- Source the GL P&L line items from the statutory statements (SC-4.B.01, 0134).
  v_stmt      := generate_statutory_statements(p_org, p_fy_start_year);
  v_pl        := v_stmt -> 'profit_and_loss';
  v_total_rev := coalesce((v_pl ->> 'total_revenue_cents')::bigint, 0);
  v_total_exp := coalesce((v_pl ->> 'total_expenses_cents')::bigint, 0);

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
        'amount_cents', v_total_rev - v_total_exp)   -- T = S − Q
    )
  );
end;
$$;

comment on function public.build_return(uuid, integer) is
  'SC-4.G.01: entity-aware tax-return label builder (jsonb) for an org + AU FY. '
  'Dispatches on business_profile.entity_type; the COMPANY branch maps the GL P&L '
  '(via generate_statutory_statements, 0134) to company-return Item 6 labels — '
  'income lines (6-C) + Total income (6-S), expense lines + Total expenses (6-Q), '
  'and Total profit or loss (6-T = S − Q). Every other entity_type RAISEs '
  'feature_not_supported until SC-4.G.02 (sole_trader) / SC-4.G.03 (partnership, '
  'trust); smsf is Phase 5. SECURITY INVOKER — RLS scopes the caller. The Item-7 '
  'reconciliation to taxable income is book_to_tax (SC-4.H).';

revoke all on function public.build_return(uuid, integer) from public, anon;
grant execute on function public.build_return(uuid, integer) to authenticated;
