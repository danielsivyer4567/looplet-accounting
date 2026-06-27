-- 0165_smsf_tbc_tbar.sql — SC-5.I.02 (Phase 5, SMSF — transfer balance cap / TBAR)
--
-- smsf_tbc_tbar(org, fy[, fund]) — tracks each member's TRANSFER BALANCE ACCOUNT (TBA)
-- against the transfer balance cap (TBC), and emits a TBAR-shaped structured payload of the
-- reportable transfer-balance events. The TBA governs how much a member can hold in the
-- retirement (pension) phase; exceeding the cap triggers an excess-transfer-balance
-- determination. Pure read; no writes.
--
-- ── TRANSFER BALANCE ACCOUNT (Div 294) ─────────────────────────────────────────
-- A member's TBA is CREDITED when they start a retirement-phase income stream (the
-- commencement value is a credit) and DEBITED by commutations / structured settlements /
-- certain payments. The net TBA balance is compared to the member's personal TBC.
--   credits = sum of retirement-phase pension commencement values (smsf_pensions, 0163).
--             ABP (account-based pension) commencement is a credit. A TRIS is in
--             ACCUMULATION phase and does NOT count toward the TBA until it moves to
--             retirement phase (member meets a condition of release) — so TRIS rows are
--             EXCLUDED from the credit here (documented; flagged in tris_excluded_count).
--   debits  = commutations / structured settlements — NOT tracked in the schema yet, so 0
--             (documented caveat). The TBA balance is therefore credits − 0 = credits today.
--
-- ── TRANSFER BALANCE CAP (general cap, seeded constant) ─────────────────────────
-- The general TBC is a legislated, CPI-indexed figure: $1.6M (2017-21), $1.7M (2021-23),
-- $1.9M (2023-24 onward). A member's PERSONAL cap depends on their highest-ever TBA and
-- prior indexation — that personal-cap history is not modelled yet, so this uses the
-- GENERAL cap for the income year as a seeded constant (FY2023-24+ = $1.9M = 190,000,000
-- cents; earlier years mapped below). Surfaced as tbc_cents + a caveat; refine to the
-- personal cap when TBA history is tracked.
--
-- ── TBAR PAYLOAD (the lodgement input) ─────────────────────────────────────────
-- Each transfer-balance event is emitted as a structured row (event type, member, value,
-- date) — the shape a Transfer Balance Account Report carries. This is the LODGEMENT INPUT
-- only: actual lodgement is blocked by the DSP/EVTE gateway (SC-7.B/7.D); this ships the
-- payload + a mark-lodged path lands with that gateway. No event is reported to the ATO here.
--
-- SECURITY INVOKER + STABLE — every read (smsf_pensions/members/funds) is RLS-scoped to the
-- caller; a foreign org/fund yields an empty result. No writes. revoke public/anon + grant
-- authenticated (the trust-chain RPC posture, 0154-0160-0164).
--
-- MIGRATION NUMBER: the ledger Files line planned 0157, long taken (distribution_streaming).
-- Reassigned to 0165 per the drift rule — the sequential repo head is 0164_smsf_member_balance
-- (0178/0179 are late hotfixes that sort after). Verified live (read-only): smsf_tbc_tbar
-- ABSENT (no drift); the SMSF 0162-0164 chain is repo-only (deploys together).

create or replace function public.smsf_tbc_tbar(
    p_org uuid, p_fy_start_year integer, p_fund uuid default null)
  returns jsonb
  language plpgsql
  stable
  security invoker
  set search_path = public
as $$
declare
  v_fund   uuid;
  v_tbc    bigint;
  v_result jsonb;
begin
  -- Resolve the fund (explicit, else the org's single fund, else RAISE on >1).
  if p_fund is not null then
    v_fund := p_fund;
  else
    select id into v_fund from smsf_funds
      where organization_id = p_org and deleted_at is null;
    if not found then
      return jsonb_build_object('ok', false, 'organization_id', p_org,
        'error', 'no SMSF fund for this org', 'members', '[]'::jsonb, 'tbar_events', '[]'::jsonb);
    end if;
    if (select count(*) from smsf_funds where organization_id = p_org and deleted_at is null) > 1 then
      raise exception 'org % has multiple SMSF funds; pass p_fund', p_org;
    end if;
  end if;

  -- General TBC for the income year (seeded constant; CPI-indexed in legislation).
  v_tbc := case
    when p_fy_start_year >= 2023 then 190000000   -- FY2023-24+: $1.9M
    when p_fy_start_year >= 2021 then 170000000   -- FY2021-22..2022-23: $1.7M
    else                              160000000   -- FY2017-18..2020-21: $1.6M
  end;

  with
  -- The retirement-phase (ABP) pensions in this fund — the single source of TBA credit
  -- events. Reused for the per-member credits, the TBAR event payload, and its count, so
  -- "which pensions count toward the TBA" is defined exactly once.
  abp as (
    select p.member_id, mb.name as member_name, p.pension_type,
           p.commencement_date, p.commencement_value_cents
    from smsf_pensions p
    join smsf_members mb on mb.id = p.member_id
    where mb.fund_id = v_fund and mb.organization_id = p_org
      and p.pension_type = 'abp' and p.deleted_at is null and mb.deleted_at is null
  ),
  -- Per member: TBA credits = ABP pension commencement values; TRIS excluded (accumulation
  -- phase). Debits not tracked yet (0).
  mem as (
    select
      mb.id, mb.name,
      coalesce((select sum(a.commencement_value_cents) from abp a where a.member_id = mb.id), 0) as credits,
      (select count(*) from smsf_pensions p
                where p.member_id = mb.id and p.pension_type = 'tris' and p.deleted_at is null) as tris_excluded_count
    from smsf_members mb
    where mb.fund_id = v_fund and mb.organization_id = p_org and mb.deleted_at is null
  ),
  bal as (
    select id, name, credits, tris_excluded_count,
      credits                              as tba_balance,    -- credits - 0 debits
      greatest(0, credits - v_tbc)         as excess,
      (credits > v_tbc)                    as exceeds_cap
    from mem
  )
  select jsonb_build_object(
    'ok',              true,
    'organization_id', p_org,
    'fund_id',         v_fund,
    'fy_start_year',   p_fy_start_year,
    'tbc_cents',       v_tbc,
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
        'member_id',            b.id,
        'name',                 b.name,
        'tba_credits_cents',    b.credits,
        'tba_debits_cents',     0,
        'tba_balance_cents',    b.tba_balance,
        'tbc_cents',            v_tbc,
        'available_cap_cents',  greatest(0, v_tbc - b.tba_balance),
        'excess_cents',         b.excess,
        'exceeds_cap',          b.exceeds_cap,
        'tris_excluded_count',  b.tris_excluded_count
      ) order by b.name) from bal b), '[]'::jsonb),
    -- TBAR-shaped events: one credit per retirement-phase (ABP) pension commencement.
    'tbar_events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'event_type',     'transfer_balance_credit',
        'event_subtype',  'income_stream_commencement',
        'member_id',      a.member_id,
        'member_name',    a.member_name,
        'pension_type',   a.pension_type,
        'event_date',     a.commencement_date,
        'value_cents',    a.commencement_value_cents
      ) order by a.commencement_date nulls last, a.member_id)
      from abp a), '[]'::jsonb),
    'totals', jsonb_build_object(
      'tba_balance_cents', (select coalesce(sum(tba_balance), 0) from bal),
      'members_exceeding', (select count(*) from bal where exceeds_cap),
      'tbar_event_count',  (select count(*) from abp)
    ),
    'caveats', jsonb_build_array(
      'The general transfer balance cap for the income year is used as a seeded constant ($1.6M 2017-21 / $1.7M 2021-23 / $1.9M 2023-24+). A member''s PERSONAL cap depends on their highest-ever TBA and prior proportional indexation, which is not modelled yet — refine to the personal cap when TBA history is tracked.',
      'TBA credits count retirement-phase (account-based) pension commencement values only. A TRIS is in accumulation phase and does not count toward the TBA until it moves to retirement phase (tris_excluded_count flags any excluded TRIS rows).',
      'TBA debits (commutations, structured settlements, certain payments) are not tracked in the schema yet, so the TBA balance equals credits today.',
      'The tbar_events array is the lodgement INPUT (TBAR shape). Actual lodgement to the ATO is gated by the DSP/EVTE gateway (SC-7.B/7.D); nothing is reported here.'
    ),
    'note', 'SMSF transfer-balance-cap tracking + TBAR payload (SC-5.I.02): per-member TBA balance (retirement-phase pension credits) vs the general TBC, with an excess/cap-exceed flag, and a TBAR-shaped event payload for lodgement. Reads smsf_pensions/members (0162/0163). Advisory; SECURITY INVOKER; no writes; lodgement gated by SC-7.'
  )
  into v_result;

  return v_result;
end;
$$;

comment on function public.smsf_tbc_tbar(uuid, integer, uuid) is
  'SC-5.I.02: per-member transfer balance account (retirement-phase ABP pension credits) vs '
  'the general transfer balance cap (seeded $1.6M/$1.7M/$1.9M by year), with excess/cap-exceed '
  'flags, plus a TBAR-shaped event payload (the lodgement input; actual lodgement gated by '
  'SC-7 DSP gateway). jsonb. Reads smsf_pensions/members (0162/0163). SECURITY INVOKER — RLS '
  'scopes the caller; no writes. TRIS excluded from the TBA; debits not tracked yet (caveats).';

revoke all on function public.smsf_tbc_tbar(uuid, integer, uuid) from public, anon;
grant execute on function public.smsf_tbc_tbar(uuid, integer, uuid) to authenticated;
