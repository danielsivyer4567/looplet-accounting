-- 0169_smsf_return_draft.sql — SC-5.K.01 (Phase 5, SMSF — annual return draft)
--
-- smsf_return_draft(org, fy[, fund]) — drafts the SMSF Annual Return (SAR) by mapping the
-- SMSF financials (operating statement SC-5.J.01, member statements SC-5.J.03) and the
-- transfer-balance data (SC-5.I.02) onto the SAR label sections. DRAFT ONLY — electronic
-- lodgement is gated by the DSP/EVTE gateway (SC-7.B/7.D); this produces the structured
-- label payload + a mark-lodged path lands with that gateway. Pure read; no writes.
--
-- ── REUSE (single source of truth) ─────────────────────────────────────────────
-- A SIS-Act specialisation of the entity-aware return builder (SC-4.G, Phase 4), but the SAR
-- structure (Section B income with the 15% concessional-contributions tax, Section D tax +
-- supervisory levy, the member contributions/balance sections) is SMSF-specific, so the
-- labels are mapped here from the SMSF RPCs rather than the general builder. Each financial
-- figure is DELEGATED to the RPC that owns it (operating statement, member statements) — not
-- re-derived — so the return ties to the financials by construction. The SC-5.J.03 member
-- statements already reconcile to the member-balance roll-forward (SC-5.I.01), so member
-- balances roll forward into the return automatically (the SC-5.K.01 assertion).
--
-- ── SAR LABEL SECTIONS (mapped from the financials) ────────────────────────────
-- Section B (income): assessable contributions (concessional), gross investment income,
--   non-concessional contributions (shown but not assessable), total assessable income.
-- Section C (deductions): 0 — no SMSF expense table yet (caveat; mirrors the operating
--   statement). Taxable income = assessable − deductions.
-- Section D (tax): tax on taxable income at 15% (from the operating statement) + the ATO
--   SMSF supervisory levy (a flat annual amount, seeded $259 = 25900 cents) = total liability.
-- Member section: per member — opening balance, concessional/non-concessional contributions,
--   closing balance, tax-free/taxable components, preservation status (from SC-5.J.03).
-- TBC: per-member transfer-balance-account info (from SC-5.I.02) for the TBAR/Section F context.
--
-- SECURITY INVOKER + STABLE — every read is via the delegated RPCs (each INVOKER) so RLS scopes
-- the caller; foreign org/fund yields an empty draft. No writes. revoke public/anon + grant
-- authenticated (the trust-chain RPC posture, 0154-0164-0166-0168).
--
-- MIGRATION NUMBER: the ledger Files line planned 0161, long taken. Reassigned to 0169 per the
-- drift rule — the sequential repo head is 0168_smsf_member_statements (0178/0179 are late
-- hotfixes that sort after). Verified live (read-only): smsf_return_draft ABSENT (no drift);
-- the SMSF 0162-0168 chain is repo-only (deploys together).

create or replace function public.smsf_return_draft(
    p_org uuid, p_fy_start_year integer, p_fund uuid default null)
  returns jsonb
  language plpgsql
  stable
  security invoker
  set search_path = public
as $$
declare
  v_fund            uuid;
  v_os              jsonb;     -- operating statement (SC-5.J.01)
  v_ms              jsonb;     -- member statements (SC-5.J.03)
  v_tbc             jsonb;     -- transfer-balance (SC-5.I.02)
  v_supervisory_levy bigint := 25900;   -- ATO SMSF supervisory levy, $259 (seeded constant)
  v_assessable      bigint;
  v_deductions      bigint := 0;
  v_taxable_income  bigint;
  v_tax_on_income   bigint;
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

  -- Delegate to the financials RPCs (single source of truth).
  v_os  := smsf_operating_statement(p_org, p_fy_start_year, v_fund);
  v_ms  := smsf_member_statements(p_org, p_fy_start_year, v_fund);
  v_tbc := smsf_tbc_tbar(p_org, p_fy_start_year, v_fund);

  v_assessable     := coalesce((v_os ->> 'assessable_income_cents')::bigint, 0);
  v_taxable_income := v_assessable - v_deductions;
  v_tax_on_income  := coalesce((v_os ->> 'income_tax_cents')::bigint, 0);

  return jsonb_build_object(
    'ok',              true,
    'organization_id', p_org,
    'fund_id',         v_fund,
    'fy_start_year',   p_fy_start_year,
    'status',          'draft',
    -- Section B — income.
    'section_b_income', jsonb_build_object(
      'assessable_contributions_cents',     coalesce((v_os #>> '{income,contributions_concessional_cents}')::bigint, 0),
      'gross_investment_income_cents',      coalesce((v_os #>> '{income,investment_income_cents}')::bigint, 0),
      'non_concessional_contributions_cents', coalesce((v_os #>> '{income,contributions_non_concessional_cents}')::bigint, 0),
      'total_assessable_income_cents',      v_assessable
    ),
    -- Section C — deductions.
    'section_c_deductions', jsonb_build_object(
      'total_deductions_cents', v_deductions,
      'taxable_income_cents',   v_taxable_income
    ),
    -- Section D — tax + the supervisory levy.
    'section_d_tax', jsonb_build_object(
      'tax_on_taxable_income_cents', v_tax_on_income,
      'supervisory_levy_cents',      v_supervisory_levy,
      'total_amount_payable_cents',  v_tax_on_income + v_supervisory_levy
    ),
    -- Member section — per-member contributions + balances + components (roll forward in).
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
        'member_id',                m ->> 'member_id',
        'name',                     m ->> 'name',
        'opening_balance_cents',    coalesce((m ->> 'opening_balance_cents')::bigint, 0),
        'concessional_cents',       coalesce((m ->> 'concessional_gross_cents')::bigint, 0),
        'non_concessional_cents',   coalesce((m ->> 'non_concessional_cents')::bigint, 0),
        'closing_balance_cents',    coalesce((m ->> 'closing_balance_cents')::bigint, 0),
        'closing_tax_free_cents',   coalesce((m ->> 'closing_tax_free_cents')::bigint, 0),
        'closing_taxable_cents',    coalesce((m ->> 'closing_taxable_cents')::bigint, 0),
        'preservation_status',      m ->> 'preservation_status'
      ) order by m ->> 'name')
      from jsonb_array_elements(coalesce(v_ms -> 'members', '[]'::jsonb)) m), '[]'::jsonb),
    -- Transfer-balance context (Section F / TBAR) — passed through from SC-5.I.02.
    'transfer_balance', jsonb_build_object(
      'tbc_cents',     coalesce((v_tbc ->> 'tbc_cents')::bigint, 0),
      'members',       coalesce(v_tbc -> 'members', '[]'::jsonb),
      'tbar_events',   coalesce(v_tbc -> 'tbar_events', '[]'::jsonb)
    ),
    'caveats', jsonb_build_array(
      'Draft only — electronic lodgement of the SMSF annual return is gated by the DSP/EVTE gateway (SC-7.B/7.D); nothing is lodged here.',
      'Deductions are 0 (no SMSF expense table yet) so taxable income = assessable income; the operating statement (SC-5.J.01) carries the same limitation.',
      'The supervisory levy is the flat ATO SMSF levy seeded at $259; confirm the current-year amount and any part-year/new-fund proration.',
      'Income, tax, member balances and transfer-balance figures are delegated to the financials RPCs (SC-5.J.01/.03, SC-5.I.02), which reconcile to the member-balance roll-forward (SC-5.I.01) — so member balances roll forward into the return by construction.'
    ),
    'note', 'SMSF annual return (SAR) draft (SC-5.K.01): Section B income, Section C deductions, Section D tax + supervisory levy, the member contributions/balance section, and transfer-balance context — mapped from the SMSF financials (SC-5.J.01/.03) + TBC (SC-5.I.02). Advisory; SECURITY INVOKER; no writes. Lodgement gated by SC-7.'
  );
end;
$$;

comment on function public.smsf_return_draft(uuid, integer, uuid) is
  'SC-5.K.01: SMSF annual return (SAR) draft (jsonb) — maps the SMSF financials '
  '(smsf_operating_statement SC-5.J.01, smsf_member_statements SC-5.J.03) + transfer-balance '
  '(smsf_tbc_tbar SC-5.I.02) onto SAR sections (B income, C deductions, D tax + supervisory '
  'levy, member section, transfer-balance). Draft only; lodgement gated by SC-7. SECURITY '
  'INVOKER — RLS scopes the caller; no writes.';

revoke all on function public.smsf_return_draft(uuid, integer, uuid) from public, anon;
grant execute on function public.smsf_return_draft(uuid, integer, uuid) to authenticated;
