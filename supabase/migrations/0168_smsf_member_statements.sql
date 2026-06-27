-- 0168_smsf_member_statements.sql — SC-5.J.03 (Phase 5, SMSF financials — member statements)
--
-- smsf_member_statements(org, fy[, fund]) — per-member statements (opening/closing balance,
-- the tax-free/taxable component split, and the preservation status) PLUS the statutory notes
-- for the SMSF financial report. Part 3 of the financials milestone — completes the set
-- (operating statement SC-5.J.01, financial position SC-5.J.02, member statements + notes here)
-- and is the input to the annual-return draft (SC-5.K.01). Pure read; no writes.
--
-- ── DELEGATION (single source of truth) ────────────────────────────────────────
-- The per-member opening/contributions/earnings/payments/closing + the tax-free/taxable
-- component split are DELEGATED to smsf_member_balance (SC-5.I.01, 0164) — not re-derived —
-- so each member statement reconciles to the roll-forward (the SC-5.J.03 assertion) by
-- construction. This RPC adds the presentation layer: the preservation status + the notes.
--
-- ── PRESERVATION STATUS (SIS reg 6.01) ─────────────────────────────────────────
-- A member's benefits are 'preserved' until they reach preservation age and meet a condition
-- of release. Preservation age is 60 for anyone born on/after 1 July 1964 (and on a sliding
-- 55→60 scale for earlier cohorts; everyone reaching it now is 60). We derive a SIMPLE status
-- from age at year end:
--   * reached preservation age (>= 60 at 30 June) -> 'unrestricted_non_preserved' (eligible)
--   * otherwise                                    -> 'preserved'
-- This is the common case; the restricted-non-preserved sub-category (pre-1999 contributions)
-- and the exact pre-1964 sliding scale are not modelled — documented caveat. Age is from
-- smsf_members.date_of_birth (null DOB -> 'preserved', the conservative default).
--
-- ── STATUTORY NOTES ────────────────────────────────────────────────────────────
-- The standard notes a special-purpose SMSF financial report carries (basis of preparation,
-- market-value measurement per SIS reg 8.02B, member-component basis, income-tax basis). A
-- fixed reference set surfaced as data so the annual-return/audit-pack slices render them.
--
-- SECURITY INVOKER + STABLE — reads (the delegated smsf_member_balance, itself INVOKER, +
-- smsf_members for DOB) are RLS-scoped to the caller; foreign org/fund yields empty. No writes.
-- revoke public/anon + grant authenticated (the trust-chain RPC posture, 0154-0164-0166-0167).
--
-- MIGRATION NUMBER: the ledger Files line planned 0160, long taken (return_offsets_credits).
-- Reassigned to 0168 per the drift rule — the sequential repo head is 0167_smsf_financial_position
-- (0178/0179 are late hotfixes that sort after). Verified live (read-only): smsf_member_statements
-- ABSENT (no drift); the SMSF 0162-0167 chain is repo-only (deploys together).

create or replace function public.smsf_member_statements(
    p_org uuid, p_fy_start_year integer, p_fund uuid default null)
  returns jsonb
  language plpgsql
  stable
  security invoker
  set search_path = public
as $$
declare
  v_fund      uuid;
  v_fy_end    date := make_date(p_fy_start_year + 1, 6, 30);
  -- A member who was born on/before this date has reached preservation age (60) by 30 June.
  v_pres_cutoff date := make_date(p_fy_start_year + 1 - 60, 6, 30);
  v_mb        jsonb;     -- smsf_member_balance (SC-5.I.01) output
  v_members   jsonb;
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

  -- Per-member figures from the roll-forward (SC-5.I.01) — the single source of truth.
  v_mb := smsf_member_balance(p_org, p_fy_start_year, v_fund);

  -- Augment each member with their preservation status. The age test (reached preservation
  -- age 60 by 30 June) is computed ONCE per member in `reached`; the status is derived from it
  -- so the two fields can't drift. Null DOB -> not reached -> 'preserved' (conservative).
  select coalesce(jsonb_agg(
    mb_row || jsonb_build_object(
      'preservation_status',     case when r.reached then 'unrestricted_non_preserved' else 'preserved' end,
      'preservation_age_reached', r.reached
    )
    order by mb_row ->> 'name'), '[]'::jsonb)
  into v_members
  from jsonb_array_elements(coalesce(v_mb -> 'members', '[]'::jsonb)) as mb_row
  left join smsf_members m
    on m.id = (mb_row ->> 'member_id')::uuid and m.deleted_at is null
  cross join lateral (
    select (m.date_of_birth is not null and m.date_of_birth <= v_pres_cutoff) as reached
  ) r;

  return jsonb_build_object(
    'ok',              true,
    'organization_id', p_org,
    'fund_id',         v_fund,
    'fy_start_year',   p_fy_start_year,
    'period_end',      v_fy_end,
    'net_assets_cents', coalesce((v_mb ->> 'net_assets_cents')::bigint, 0),
    'members',         v_members,
    'totals',          v_mb -> 'totals',
    -- The statutory notes a special-purpose SMSF financial report carries.
    'statutory_notes', jsonb_build_array(
      jsonb_build_object('note', 'Basis of preparation',
        'text', 'These are special-purpose financial statements prepared to meet the needs of the members and the fund''s reporting obligations under the SIS Act 1993; they do not purport to be general-purpose financial statements.'),
      jsonb_build_object('note', 'Measurement of assets',
        'text', 'Fund investments are measured at market value as at the reporting date, in accordance with SIS regulation 8.02B.'),
      jsonb_build_object('note', 'Member components',
        'text', 'Each member''s balance is split into tax-free and taxable components; concessional contributions are credited net of 15% contributions tax, non-concessional to the tax-free component.'),
      jsonb_build_object('note', 'Income tax',
        'text', 'The fund is a complying superannuation fund taxed at 15% on assessable income in the accumulation phase; income attributable to retirement-phase pensions is exempt (not separated in this draft).'),
      jsonb_build_object('note', 'Preservation',
        'text', 'Members'' benefits are preserved until preservation age (60) and a condition of release is met; the status shown is derived from the member''s age at year end.')
    ),
    'caveats', jsonb_build_array(
      'Per-member opening/closing balances + component split are delegated to the member-balance roll-forward (SC-5.I.01), so each statement reconciles to it by construction.',
      'Preservation status is a simple age test (reached preservation age 60 by 30 June -> unrestricted non-preserved; else preserved). The restricted-non-preserved sub-category and the pre-1964 sliding 55-60 scale are not modelled; a null date of birth defaults to preserved.',
      'The statutory notes are a standard reference set; fund-specific notes (related-party transactions, limited-recourse borrowing, reserves) are a later refinement.'
    ),
    'note', 'SMSF member statements + statutory notes (SC-5.J.03): per-member opening/closing + tax-free/taxable components (delegated to SC-5.I.01) + preservation status + the special-purpose financial-report notes. Advisory; SECURITY INVOKER; no writes. Input to the annual-return draft (SC-5.K.01).'
  );
end;
$$;

comment on function public.smsf_member_statements(uuid, integer, uuid) is
  'SC-5.J.03: SMSF per-member statements (opening/closing + tax-free/taxable components, '
  'delegated to smsf_member_balance SC-5.I.01 so they reconcile by construction) + preservation '
  'status (age-60 test) + the special-purpose financial-report statutory notes. jsonb. '
  'SECURITY INVOKER — RLS scopes the caller; no writes. Input to the annual return (SC-5.K.01).';

revoke all on function public.smsf_member_statements(uuid, integer, uuid) from public, anon;
grant execute on function public.smsf_member_statements(uuid, integer, uuid) to authenticated;
