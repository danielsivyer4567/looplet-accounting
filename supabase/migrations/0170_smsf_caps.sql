-- 0170_smsf_caps.sql — SC-5.L.01 (Phase 5, SMSF — contribution caps / Div 293)
--
-- smsf_caps(org, fy[, fund]) — per-member contribution-cap monitoring: flags concessional and
-- non-concessional cap breaches for the income year, and the Division 293 high-income surcharge.
-- Reads smsf_contributions (SC-5.H.02). Pure read; no writes. Advisory monitor (the breach is
-- the user's to remedy; nothing is reported to the ATO here).
--
-- ── CAPS (seeded reference constants per FY) ───────────────────────────────────
-- Concessional cap: $30,000 (FY2024-25; $27,500 FY2021-22..2023-24). Carry-forward of unused
--   concessional cap from up to 5 prior years is available if total super balance < $500k —
--   NOT modelled here (needs prior-year unused cap + each member's total super balance, which
--   the schema does not track). So this flags against the BASE cap; carry-forward headroom is a
--   documented caveat (a member with carry-forward may not actually breach).
-- Non-concessional cap: $120,000 (FY2024-25; $110,000 prior). Bring-forward (2-3 years, up to
--   $360k, if under 75 and TSB under the cap) is likewise NOT modelled — base-cap flag + caveat.
-- Div 293 threshold: $250,000. An extra 15% tax applies to the LESSER of (a) low-tax
--   contributions [concessional] and (b) the amount by which (income for surcharge purposes +
--   low-tax contributions) exceeds $250,000. The member's personal income for surcharge purposes
--   is NOT in the SMSF schema, so it defaults to 0 — meaning Div 293 only flags here when
--   concessional contributions ALONE exceed $250,000. Documented; the real test needs the
--   member's taxable income (a later input).
--
-- SECURITY INVOKER + STABLE — reads (smsf_members/contributions) RLS-scoped to the caller;
-- foreign org/fund yields empty. No writes. revoke public/anon + grant authenticated.
--
-- MIGRATION NUMBER: the ledger Files line planned 0162, long taken. Reassigned to 0170 per the
-- drift rule — the sequential repo head is 0169_smsf_return_draft (0178/0179 are late hotfixes
-- that sort after). Verified live (read-only): smsf_caps ABSENT (no drift); the SMSF 0162-0169
-- chain is repo-only (deploys together).

create or replace function public.smsf_caps(
    p_org uuid, p_fy_start_year integer, p_fund uuid default null)
  returns jsonb
  language plpgsql
  stable
  security invoker
  set search_path = public
as $$
declare
  v_fund      uuid;
  v_cc_cap    bigint;   -- concessional cap (cents)
  v_ncc_cap   bigint;   -- non-concessional cap (cents)
  v_div293    bigint := 25000000;   -- Div 293 threshold $250,000
  v_result    jsonb;
begin
  -- Resolve the fund (explicit, else the org's single fund, else RAISE on >1).
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

  -- Seeded caps for the income year.
  v_cc_cap  := case when p_fy_start_year >= 2024 then 3000000  else 2750000  end;  -- $30k / $27.5k
  v_ncc_cap := case when p_fy_start_year >= 2024 then 12000000 else 11000000 end;  -- $120k / $110k

  with
  -- Per-member concessional / non-concessional totals for the year. One scan of
  -- smsf_contributions (filter() splits the two types) joined to each member.
  contrib as (
    select member_id,
      coalesce(sum(amount_cents) filter (where contribution_type = 'concessional'), 0)     as cc,
      coalesce(sum(amount_cents) filter (where contribution_type = 'non_concessional'), 0) as ncc
    from smsf_contributions
    where organization_id = p_org and fy_start_year = p_fy_start_year and deleted_at is null
    group by member_id
  ),
  mem as (
    select mb.id, mb.name,
      coalesce(c.cc, 0)  as cc,
      coalesce(c.ncc, 0) as ncc
    from smsf_members mb
    left join contrib c on c.member_id = mb.id
    where mb.fund_id = v_fund and mb.organization_id = p_org and mb.deleted_at is null
  ),
  flagged as (
    select id, name, cc, ncc,
      greatest(0, cc  - v_cc_cap)  as cc_excess,
      greatest(0, ncc - v_ncc_cap) as ncc_excess,
      -- Div 293: extra 15% on lesser(concessional, (income[=0 here] + concessional) − 250k).
      -- With income defaulted to 0, the surchargeable amount is max(0, cc − 250k) capped at cc.
      least(cc, greatest(0, cc - v_div293)) as div293_surchargeable
    from mem
  )
  select jsonb_build_object(
    'ok',              true,
    'organization_id', p_org,
    'fund_id',         v_fund,
    'fy_start_year',   p_fy_start_year,
    'caps', jsonb_build_object(
      'concessional_cap_cents',     v_cc_cap,
      'non_concessional_cap_cents', v_ncc_cap,
      'div293_threshold_cents',     v_div293
    ),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
        'member_id',                       f.id,
        'name',                            f.name,
        'concessional_cents',              f.cc,
        'concessional_cap_cents',          v_cc_cap,
        'concessional_excess_cents',       f.cc_excess,
        'concessional_cap_exceeded',       (f.cc_excess > 0),
        'non_concessional_cents',          f.ncc,
        'non_concessional_cap_cents',      v_ncc_cap,
        'non_concessional_excess_cents',   f.ncc_excess,
        'non_concessional_cap_exceeded',   (f.ncc_excess > 0),
        'div293_surchargeable_cents',      f.div293_surchargeable,
        'div293_extra_tax_cents',          floor(f.div293_surchargeable * 0.15)::bigint,
        'div293_applies',                  (f.div293_surchargeable > 0)
      ) order by f.name) from flagged f), '[]'::jsonb),
    'totals', (
      select jsonb_build_object(
        'members_over_concessional',     count(*) filter (where cc_excess > 0),
        'members_over_non_concessional', count(*) filter (where ncc_excess > 0),
        'members_div293',                count(*) filter (where div293_surchargeable > 0))
      from flagged),
    'caveats', jsonb_build_array(
      'Caps are flagged against the base concessional ($30k FY2024-25 / $27.5k prior) and non-concessional ($120k / $110k) caps. CARRY-FORWARD of unused concessional cap (5 years, if total super balance < $500k) and BRING-FORWARD of non-concessional (2-3 years, under 75) are NOT modelled — a member with carry/bring-forward headroom may not actually breach; confirm before acting.',
      'Division 293 applies an extra 15% to the lesser of low-tax (concessional) contributions and the excess of (income for surcharge purposes + low-tax contributions) over $250,000. The member''s personal income is not in the SMSF schema, so it is defaulted to 0 here — Div 293 only flags when concessional contributions ALONE exceed $250,000. Supply the member''s taxable income for the real test.',
      'Advisory only — an excess-contributions or Div 293 determination is ATO-issued; this monitor flags the risk from the fund''s recorded contributions.'
    ),
    'note', 'SMSF contribution-cap + Div 293 monitor (SC-5.L.01): per-member concessional/non-concessional cap breaches (base caps; carry/bring-forward not modelled) + Div 293 high-income surcharge (income defaulted to 0). Reads smsf_contributions (SC-5.H.02). Advisory; SECURITY INVOKER; no writes.'
  )
  into v_result;

  return v_result;
end;
$$;

comment on function public.smsf_caps(uuid, integer, uuid) is
  'SC-5.L.01: per-member SMSF contribution-cap monitor (jsonb) — concessional ($30k/$27.5k) and '
  'non-concessional ($120k/$110k) cap breaches (base caps; carry/bring-forward not modelled) + '
  'Division 293 surcharge ($250k threshold, personal income defaulted to 0). Reads '
  'smsf_contributions (0163). SECURITY INVOKER — RLS scopes the caller; no writes.';

revoke all on function public.smsf_caps(uuid, integer, uuid) from public, anon;
grant execute on function public.smsf_caps(uuid, integer, uuid) to authenticated;
