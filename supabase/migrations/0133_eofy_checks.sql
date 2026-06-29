-- 0133_eofy_checks.sql — SC-4.A.03 (Phase 4, EOFY advisory checks)
--
-- eofy_advisory_checks(org, fy_start_year, age_days=90) — READ-ONLY advisory FLAGS
-- for EOFY review (Tier-1 notify, surfaced as exceptions/tasks by the Phase-7
-- orchestrator). NOT balance-changing journals — deliberately split out of the
-- SC-4.A.02 atomic true-up. Returns jsonb:
--   bad_debt_candidates — AR (invoices) still unpaid (balance_due_cents > 0, status
--     sent/partially_paid/overdue) and overdue by >= age_days as at the FY end;
--   owner_drawings_flags — a COMPANY that has an owner-drawings EQUITY account
--     (owner payments should be wages/dividends — Div 7A risk). HEURISTIC by account
--     name (no dedicated drawings account_type exists); sole traders/partnerships
--     legitimately use drawings, so they are NOT flagged. Confirm before acting.
--
-- SECURITY INVOKER + STABLE (no writes): every read (invoices, chart_of_accounts,
-- business_profile) is RLS-scoped to the caller. Verified live schemas first
-- (invoice_status enum: draft/sent/partially_paid/paid/overdue/void; account_type
-- enum has no 'drawings' — equity + name match).
--
-- MIGRATION NUMBER: Phase-4 plan said 0125, taken; 0133 per the drift rule.

create or replace function public.eofy_advisory_checks(
  p_org uuid,
  p_fy_start_year integer,
  p_age_days integer default 90
)
  returns jsonb
  language plpgsql
  stable
  security invoker
  set search_path = public
as $$
declare
  v_fy_end   date := make_date(p_fy_start_year + 1, 6, 30);
  v_bad_debt jsonb;
  v_drawings jsonb;
begin
  -- Bad-debt candidates: unpaid invoices overdue by >= age_days as at the FY end.
  select coalesce(jsonb_agg(jsonb_build_object(
           'invoice_id', i.id,
           'invoice_number', i.invoice_number,
           'customer_id', i.customer_id,
           'balance_due_cents', i.balance_due_cents,
           'due_date', i.due_date,
           'days_overdue', (v_fy_end - i.due_date)
         ) order by i.due_date), '[]'::jsonb)
  into v_bad_debt
  from invoices i
  where i.organization_id = p_org
    and i.deleted_at is null
    and coalesce(i.balance_due_cents, 0) > 0
    and i.status in ('sent', 'partially_paid', 'overdue')
    and i.due_date <= (v_fy_end - greatest(p_age_days, 0));

  -- Owner-drawings flags: a company with an owner-drawings equity account.
  select coalesce(jsonb_agg(jsonb_build_object(
           'account_id', coa.id,
           'code', coa.code,
           'name', coa.name,
           'reason', 'Company has an owner-drawings account — owner payments should be wages/dividends (Div 7A risk); confirm classification.'
         ) order by coa.code), '[]'::jsonb)
  into v_drawings
  from chart_of_accounts coa
  join business_profile bp on bp.organization_id = coa.organization_id
  where coa.organization_id = p_org
    and coa.account_type = 'equity'
    and coa.is_active is not false
    and coa.name ilike '%drawing%'
    and bp.entity_type = 'company';

  return jsonb_build_object(
    'organization_id', p_org,
    'fy_start_year', p_fy_start_year,
    'period_end', v_fy_end,
    'age_days_threshold', p_age_days,
    'bad_debt_candidates', v_bad_debt,
    'bad_debt_count', jsonb_array_length(v_bad_debt),
    'owner_drawings_flags', v_drawings,
    'owner_drawings_count', jsonb_array_length(v_drawings)
  );
end;
$$;

comment on function public.eofy_advisory_checks(uuid, integer, integer) is
  'READ-ONLY EOFY advisory flags (jsonb): aged-AR bad-debt candidates (unpaid '
  'invoices overdue >= age_days at FY end) + owner-drawings-on-a-company flags '
  '(Div 7A heuristic). Advisory only (Tier-1 notify), no journals. SECURITY INVOKER.';

revoke all on function public.eofy_advisory_checks(uuid, integer, integer) from public, anon;
grant execute on function public.eofy_advisory_checks(uuid, integer, integer) to authenticated;
