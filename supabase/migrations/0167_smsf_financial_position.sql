-- 0167_smsf_financial_position.sql — SC-5.J.02 (Phase 5, SMSF financials — balance sheet)
--
-- smsf_financial_position(org, fy[, fund]) — the SMSF STATEMENT OF FINANCIAL POSITION (the
-- fund's balance sheet) as at year end: assets (investments at market value) − liabilities =
-- members' funds. Part 2 of the SMSF financials milestone (the income side is the operating
-- statement, SC-5.J.01). Pure read; no writes.
--
-- ── THE KEY RECONCILIATION ─────────────────────────────────────────────────────
-- The accounting identity must hold: assets = liabilities + members' funds. AND members'
-- funds must equal the member-balance roll-forward total (SC-5.I.01). This RPC delegates the
-- members'-funds figure to smsf_member_balance (0164), which constructs each member's closing
-- balance so that the member balances sum to fund net assets (earnings are the reconciling
-- residual). Therefore:
--   assets          = sum(smsf_investments.market_value_cents)          (net assets, SIS market value)
--   liabilities     = 0  (see caveat — no liability table yet)
--   members' funds  = smsf_member_balance.totals.closing_cents          (= net assets by construction)
-- so assets = liabilities + members' funds AND members' funds = the member-balance total both
-- hold BY CONSTRUCTION — the two SC-5.J.02 assertions. (If a liability table is added later,
-- members' funds becomes assets − liabilities and the member-balance earnings residual must net
-- liabilities too; flagged in caveats.)
--
-- ── ASSETS (at market value, per SIS reg 8.02B) ────────────────────────────────
-- Investments are carried at market value (SIS regulation 8.02B requires SMSF assets at market
-- value for reporting). Broken out by asset_class (0163) for the balance-sheet presentation and
-- the in-house-asset tests.
--
-- SECURITY INVOKER + STABLE — every read (smsf_investments + the delegated smsf_member_balance,
-- itself INVOKER) is RLS-scoped to the caller; a foreign org/fund yields zeros. No writes.
-- revoke public/anon + grant authenticated (the trust-chain RPC posture, 0154-0164-0166).
--
-- MIGRATION NUMBER: the ledger Files line planned 0159, long taken (book_to_tax_cgt_losses).
-- Reassigned to 0167 per the drift rule — the sequential repo head is 0166_smsf_operating_statement
-- (0178/0179 are late hotfixes that sort after). Verified live (read-only): smsf_financial_position
-- ABSENT (no drift); the SMSF 0162-0166 chain is repo-only (deploys together).

create or replace function public.smsf_financial_position(
    p_org uuid, p_fy_start_year integer, p_fund uuid default null)
  returns jsonb
  language plpgsql
  stable
  security invoker
  set search_path = public
as $$
declare
  v_fund          uuid;
  v_assets        bigint;
  v_liabilities   bigint := 0;
  v_members_funds bigint;
  v_mb            jsonb;     -- smsf_member_balance (SC-5.I.01) output
  v_by_class      jsonb;
begin
  -- Resolve the fund (explicit, else the org's single fund, else RAISE on >1).
  if p_fund is not null then
    v_fund := p_fund;
  else
    select id into v_fund from smsf_funds
      where organization_id = p_org and deleted_at is null;
    if not found then
      return jsonb_build_object('ok', false, 'organization_id', p_org,
        'error', 'no SMSF fund for this org');
    end if;
    if (select count(*) from smsf_funds where organization_id = p_org and deleted_at is null) > 1 then
      raise exception 'org % has multiple SMSF funds; pass p_fund', p_org;
    end if;
  end if;

  -- Assets at market value (SIS reg 8.02B), total + by asset class.
  select coalesce(sum(market_value_cents), 0) into v_assets
  from smsf_investments where fund_id = v_fund and organization_id = p_org and deleted_at is null;

  select coalesce(jsonb_agg(jsonb_build_object(
           'asset_class',        asset_class,
           'market_value_cents', class_total
         ) order by asset_class), '[]'::jsonb)
  into v_by_class
  from (
    select asset_class, sum(market_value_cents) as class_total
    from smsf_investments
    where fund_id = v_fund and organization_id = p_org and deleted_at is null
    group by asset_class
  ) c;

  -- Members' funds = the member-balance roll-forward total (SC-5.I.01), which reconciles to
  -- net assets by construction. Delegating keeps the two statements consistent.
  v_mb            := smsf_member_balance(p_org, p_fy_start_year, v_fund);
  v_members_funds := coalesce((v_mb #>> '{totals,closing_cents}')::bigint, 0);

  return jsonb_build_object(
    'ok',                 true,
    'organization_id',    p_org,
    'fund_id',            v_fund,
    'fy_start_year',      p_fy_start_year,
    'assets', jsonb_build_object(
      'by_asset_class',     v_by_class,
      'total_assets_cents', v_assets
    ),
    'liabilities_cents',  v_liabilities,
    'net_assets_cents',   v_assets - v_liabilities,
    'members_funds_cents', v_members_funds,
    -- Per-member closing balances passed through from the roll-forward.
    'members', coalesce(v_mb -> 'members', '[]'::jsonb),
    'reconciliation', jsonb_build_object(
      -- assets = liabilities + members' funds (the balance-sheet identity). Holds by
      -- construction (members' funds is the member-balance total, which reconciles to net
      -- assets in SC-5.I.01) — but expressed as a real comparison so it would catch a drift
      -- if liabilities are later tracked or the net-assets basis diverges.
      'balances',                   ((v_liabilities + v_members_funds) = v_assets),
      -- members' funds (the SC-5.I.01 roll-forward total) equals net assets (assets − liabilities).
      'members_funds_reconciles',   (v_members_funds = (v_assets - v_liabilities)),
      'member_balance_total_cents', v_members_funds
    ),
    'caveats', jsonb_build_array(
      'Assets are investments at market value (SIS reg 8.02B). Cash at bank and other asset types not modelled as investments are not included — add them as smsf_investments rows (asset_class cash) or a future cash-account model.',
      'Liabilities are 0 — no SMSF liability table yet (the realistic liability is the income-tax provision from the operating statement, SC-5.J.01). When liabilities are tracked, members'' funds becomes assets − liabilities and the member-balance earnings residual (SC-5.I.01) must net them.',
      'Members'' funds is delegated to the member-balance roll-forward (SC-5.I.01), where earnings are the residual that reconciles member balances to net assets — so the balance-sheet identity holds by construction.'
    ),
    'note', 'SMSF statement of financial position (SC-5.J.02): assets (investments at market value) − liabilities = members'' funds, with members'' funds reconciled to the member-balance roll-forward (SC-5.I.01). Reads smsf_investments (0163) + smsf_member_balance (0164). Advisory; SECURITY INVOKER; no writes. Income side is SC-5.J.01.'
  );
end;
$$;

comment on function public.smsf_financial_position(uuid, integer, uuid) is
  'SC-5.J.02: SMSF statement of financial position (balance sheet, jsonb) — assets (investments '
  'at market value, by asset class) − liabilities (0; no table yet) = members'' funds, with '
  'members'' funds delegated to smsf_member_balance (SC-5.I.01) so assets = liabilities + members'' '
  'funds AND members'' funds = the member-balance total both hold by construction. Reads '
  'smsf_investments (0163). SECURITY INVOKER — RLS scopes the caller; no writes. Income side = SC-5.J.01.';

revoke all on function public.smsf_financial_position(uuid, integer, uuid) from public, anon;
grant execute on function public.smsf_financial_position(uuid, integer, uuid) to authenticated;
