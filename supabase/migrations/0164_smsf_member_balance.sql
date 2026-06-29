-- 0164_smsf_member_balance.sql — SC-5.I.01 (Phase 5, SMSF — member-balance roll-forward)
--
-- smsf_member_balance(org, fy[, fund]) — rolls each member's account balance forward over an
-- AU income year, splitting the closing balance into its tax-free vs taxable components. The
-- prerequisite for the SMSF financials (SC-5.J: member statements, statement of financial
-- position) and the contribution-cap / TBC monitors (SC-5.L/5.I.02). Pure read; no writes.
--
-- ── THE ROLL-FORWARD (per member, documented so it is hand-computable) ──────────
-- Opening balance  = smsf_members.tax_free_component_cents + taxable_component_cents (0162,
--                    the opening split).
-- + Contributions  (smsf_contributions, 0163, this FY):
--     * non-concessional (after-tax) -> tax-free component, no fund tax.
--     * concessional (before-tax)    -> taxable component, LESS 15% contributions tax
--       (s295-160): credited net = gross x (1 - 0.15). The 15% is the fund's liability.
-- + Earnings       (proportional allocation): see below — credited to the taxable component.
-- - Pension payments (smsf_pensions, 0163): the FY minimum drawdown
--     (commencement_value_cents x min_drawdown_percent/100) is taken as the payment for the
--     year, drawn from the member's components in proportion to their pre-payment split.
-- = Closing balance, re-split into tax-free / taxable components.
--
-- ── EARNINGS = THE RECONCILING RESIDUAL (proportional method) ──────────────────
-- A fund's net assets at year end are a known figure (the market value of its investments).
-- Member balances must, by definition, sum to fund net assets. So rather than estimate
-- earnings independently (which would not reconcile), total earnings is the RESIDUAL that
-- makes the members' closing balances sum to net assets:
--   net_assets        = sum(smsf_investments.market_value_cents)         (fund net assets)
--   total_earnings    = net_assets - sum(opening) - net_contributions_after_tax + total_payments
-- and total_earnings is allocated to members IN PROPORTION TO their opening balances (the
-- documented proportional crediting-rate method; a fund with no opening balances splits
-- earnings equally is moot — first-year contributions get the allocation pro-rata to those).
-- This GUARANTEES sum(closing member balances) == fund net assets (the SC-5.I.01 assertion),
-- which is the real-world member-statement method. Earnings (positive or negative) credit the
-- taxable component. (Earnings tax in accumulation is embedded in net assets, not re-deducted.)
--
-- Caveats: minimum drawdown is used as the pension payment (actual payments are not separately
-- tracked yet); earnings are allocated on opening balances (a time-weighted rate is the
-- refinement); pension (retirement-phase) vs accumulation tax treatment of earnings is not
-- separated here (net assets already reflect tax). Surfaced in the payload, not silently assumed.
--
-- SECURITY INVOKER + STABLE — every read (smsf_members/contributions/pensions/investments) is
-- RLS-scoped to the caller; a foreign org/fund rolls forward to empty. No writes. revoke
-- public/anon + grant authenticated (the trust-chain RPC posture, 0154-0160).
--
-- MIGRATION NUMBER: the ledger Files line planned 0156, long taken (distribution_optimiser).
-- Reassigned to 0164 per the drift rule — the sequential repo head is 0163_smsf_movements
-- (0178/0179 are late hotfixes that sort after). Verified live (read-only): smsf_member_balance
-- ABSENT (no drift); the SMSF 0162/0163 chain is repo-only (deploys together).

create or replace function public.smsf_member_balance(
    p_org uuid, p_fy_start_year integer, p_fund uuid default null)
  returns jsonb
  language plpgsql
  stable
  security invoker
  set search_path = public
as $$
declare
  v_fund            uuid;
  v_net_assets      bigint;
  v_result          jsonb;
begin
  -- Resolve the fund: explicit, else the org's single fund (>1 with null is ambiguous).
  if p_fund is not null then
    v_fund := p_fund;
  else
    select id into v_fund from smsf_funds
      where organization_id = p_org and deleted_at is null;
    if not found then
      return jsonb_build_object('ok', false, 'organization_id', p_org,
        'error', 'no SMSF fund for this org', 'members', '[]'::jsonb);
    end if;
    if (select count(*) from smsf_funds where organization_id = p_org and deleted_at is null) > 1 then
      raise exception 'org % has multiple SMSF funds; pass p_fund', p_org;
    end if;
  end if;

  -- Fund net assets = market value of investments (the figure member balances reconcile to).
  select coalesce(sum(market_value_cents), 0) into v_net_assets
  from smsf_investments where fund_id = v_fund and organization_id = p_org and deleted_at is null;

  -- Single pass: m (per-member raw) -> totals (fund aggregates + the reconciling earnings
  -- residual) -> alloc (cross-join totals; cumulative-floor earnings share) -> rolled/final.
  -- One declaration of m, so the contribution/pension subqueries run once.
  with m as (
    select
      mb.id, mb.name,
      mb.tax_free_component_cents                                   as open_tax_free,
      mb.taxable_component_cents                                    as open_taxable,
      mb.tax_free_component_cents + mb.taxable_component_cents      as opening,
      -- non-concessional -> tax-free; concessional -> taxable net of 15% contributions tax.
      coalesce((select sum(amount_cents) from smsf_contributions c
                where c.member_id = mb.id and c.fy_start_year = p_fy_start_year
                  and c.contribution_type = 'non_concessional' and c.deleted_at is null), 0) as nc_contrib,
      coalesce((select sum(amount_cents) from smsf_contributions c
                where c.member_id = mb.id and c.fy_start_year = p_fy_start_year
                  and c.contribution_type = 'concessional' and c.deleted_at is null), 0) as cc_gross,
      -- pension payment for the year = sum of each pension's minimum drawdown.
      coalesce((select sum(floor(p.commencement_value_cents * p.min_drawdown_percent / 100.0))::bigint
                from smsf_pensions p
                where p.member_id = mb.id and p.deleted_at is null), 0) as payments
    from smsf_members mb
    where mb.fund_id = v_fund and mb.organization_id = p_org and mb.deleted_at is null
  ),
  mc as (  -- + concessional net of 15% contributions tax (s295-160).
    select *, floor(cc_gross * 0.85)::bigint as cc_net from m
  ),
  totals as (
    select
      coalesce(sum(opening), 0)            as open_total,
      coalesce(sum(nc_contrib + cc_net), 0) as net_contrib,
      coalesce(sum(payments), 0)            as payments_total,
      coalesce(sum(cc_gross - cc_net), 0)   as contributions_tax,
      -- Earnings = the residual that makes closing balances sum to net assets.
      v_net_assets - coalesce(sum(opening), 0) - coalesce(sum(nc_contrib + cc_net), 0)
        + coalesce(sum(payments), 0)        as earnings_total
    from mc
  ),
  alloc as (
    select mc.*, t.open_total, t.earnings_total,
      -- earnings share by cumulative floor over opening / open_total (sums to earnings_total).
      coalesce(
        floor(t.earnings_total::numeric * (sum(mc.opening) over (order by mc.id rows between unbounded preceding and current row))
              / nullif(t.open_total, 0))::bigint
        - floor(t.earnings_total::numeric * (sum(mc.opening) over (order by mc.id rows between unbounded preceding and current row) - mc.opening)
              / nullif(t.open_total, 0))::bigint, 0) as earnings_share
    from mc cross join totals t
  ),
  rolled as (
    select id, name, opening, nc_contrib, cc_gross, cc_net, payments, earnings_share,
      -- pre-payment components: tax-free gets non-concessional; taxable gets concessional-net + earnings.
      (open_tax_free + nc_contrib)                          as pre_tax_free,
      (open_taxable + cc_net + earnings_share)              as pre_taxable
    from alloc
  ),
  final as (
    select id, name, opening, nc_contrib, cc_gross, cc_net, payments, earnings_share,
      pre_tax_free, pre_taxable,
      (pre_tax_free + pre_taxable)                          as pre_total,
      -- draw the payment from components in proportion to the pre-payment split (floor the
      -- tax-free portion; taxable takes the remainder so the total payment is exact).
      case when (pre_tax_free + pre_taxable) > 0
           then floor(payments::numeric * pre_tax_free / (pre_tax_free + pre_taxable))::bigint
           else 0 end                                       as pay_from_tax_free
    from rolled
  )
  select jsonb_build_object(
    'ok',               true,
    'organization_id',  p_org,
    'fund_id',          v_fund,
    'fy_start_year',    p_fy_start_year,
    'net_assets_cents', v_net_assets,
    'earnings_allocated_cents', t.earnings_total,
    'contributions_tax_cents',  t.contributions_tax,
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
        'member_id',                f.id,
        'name',                     f.name,
        'opening_balance_cents',    f.opening,
        'concessional_gross_cents', f.cc_gross,
        'concessional_net_cents',   f.cc_net,
        'non_concessional_cents',   f.nc_contrib,
        'earnings_cents',           f.earnings_share,
        'pension_payment_cents',    f.payments,
        'closing_tax_free_cents',   f.pre_tax_free - f.pay_from_tax_free,
        'closing_taxable_cents',    f.pre_taxable - (f.payments - f.pay_from_tax_free),
        'closing_balance_cents',    f.pre_total - f.payments
      ) order by f.name) from final f), '[]'::jsonb),
    'totals', jsonb_build_object(
      'opening_cents',           t.open_total,
      'net_contributions_cents', t.net_contrib,
      'earnings_cents',          t.earnings_total,
      'payments_cents',          t.payments_total,
      'closing_cents',           t.open_total + t.net_contrib + t.earnings_total - t.payments_total,
      -- The reconciliation: closing member balances sum to fund net assets (true by construction).
      'reconciles_to_net_assets',
        ((t.open_total + t.net_contrib + t.earnings_total - t.payments_total) = v_net_assets)
    ),
    'caveats', jsonb_build_array(
      'Earnings are the residual that reconciles member balances to fund net assets (sum of investment market values), allocated in proportion to opening balances (the proportional crediting-rate method). A time-weighted rate that accounts for the timing of contributions is the refinement.',
      'The pension payment for the year is taken as each pension''s minimum drawdown (commencement value x min_drawdown_percent); actual payments are not separately tracked yet. Payments are drawn from the member''s tax-free/taxable components in proportion to the pre-payment split.',
      'Concessional contributions are credited net of 15% contributions tax (s295-160) to the taxable component; non-concessional to the tax-free component. Earnings tax in accumulation phase is embedded in net assets, not re-deducted here; retirement-phase (pension) earnings exemption is not separated.'
    ),
    'note', 'SMSF member-balance roll-forward (SC-5.I.01): opening + contributions (concessional net of 15% tax) + proportional earnings - minimum-drawdown pension payments, split into tax-free/taxable components. Earnings reconcile member balances to fund net assets. Reads smsf_members/contributions/pensions/investments. Advisory; SECURITY INVOKER; no writes.'
  )
  into v_result
  from totals t;

  return v_result;
end;
$$;

comment on function public.smsf_member_balance(uuid, integer, uuid) is
  'SC-5.I.01: rolls each SMSF member''s balance forward over an AU FY (opening + contributions '
  'net of 15% concessional tax + proportional earnings - minimum-drawdown pension payments), '
  'split into tax-free/taxable components (jsonb). Earnings are the residual that reconciles '
  'member balances to fund net assets (sum of investment market values). Reads smsf_members/'
  'contributions/pensions/investments (0162/0163). SECURITY INVOKER — RLS scopes the caller; '
  'no writes. Prerequisite for the SMSF financials (SC-5.J).';

revoke all on function public.smsf_member_balance(uuid, integer, uuid) from public, anon;
grant execute on function public.smsf_member_balance(uuid, integer, uuid) to authenticated;
