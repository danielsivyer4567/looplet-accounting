-- 0129_award_underpayment_check.sql — SC-3.K.02 (Phase 3, award interpretation)
--
-- v_award_rate_exceptions — FLAGS employees whose base hourly rate is below the
-- award minimum for their (modern_award, classification_level) at the current date.
-- ASSIST-ONLY: this view only surfaces a *possible* underpayment for a human to
-- confirm against the actual award — it NEVER auto-acts, never changes pay, and the
-- seeded award_rates (0128) are illustrative/non-authoritative.
--
-- Effective rate source: employees.wage_components ->> 'base_hourly_rate' (DOLLARS,
-- written by the employee UI; cf. computeLoadedRate), ×100 → cents, compared to
-- award_rates.min_hourly_rate_cents. We compare BASE-to-BASE (the award minimum is a
-- base rate); casual loadings / penalty rates are NOT modelled — a documented
-- refinement, and the reason a human must confirm.
--
-- Safety (no false flags): only employees that are active, not deleted, HAVE an
-- award + classification, HAVE a resolvable current award_rates row, and HAVE a
-- numeric base_hourly_rate > 0 are considered. Missing/zero/unparseable rate or no
-- award mapping ⇒ excluded (unknown, not "underpaid").
--
-- SECURITY INVOKER: the view chains the caller's RLS on employees, so a caller only
-- sees exceptions for orgs they can access (award_rates is public read-only ref).
--
-- MIGRATION NUMBER: ledger planned 0120; reassigned to 0129 per the drift rule
-- (0128 = SC-3.K.01). Blocked by 0128 (employees.modern_award/classification_level +
-- award_rates). Check-only — no table, no write path.

create or replace view public.v_award_rate_exceptions
  with (security_invoker = true) as
select
  e.id                     as employee_id,
  e.organization_id,
  e.full_name,
  e.modern_award,
  e.classification_level,
  ((e.wage_components ->> 'base_hourly_rate')::numeric * 100)::bigint as base_hourly_rate_cents,
  ar.min_hourly_rate_cents as award_min_hourly_rate_cents,
  (ar.min_hourly_rate_cents - ((e.wage_components ->> 'base_hourly_rate')::numeric * 100)::bigint) as shortfall_cents
from public.employees e
  join public.award_rates ar
    on ar.modern_award = e.modern_award
   and ar.classification_level = e.classification_level
   and ar.effective_from <= current_date
   and (ar.effective_to is null or current_date < ar.effective_to)
where e.deleted_at is null
  and e.is_active
  and e.modern_award is not null
  and e.classification_level is not null
  -- numeric guard: the value must be a JSON number (not absent / json null / string)
  and jsonb_typeof(e.wage_components -> 'base_hourly_rate') = 'number'
  and (e.wage_components ->> 'base_hourly_rate')::numeric > 0
  and ((e.wage_components ->> 'base_hourly_rate')::numeric * 100) < ar.min_hourly_rate_cents;

comment on view public.v_award_rate_exceptions is
  'ASSIST-ONLY: employees whose base hourly rate (wage_components.base_hourly_rate) is '
  'below the illustrative award minimum (award_rates) for their award+classification. '
  'Flags a possible underpayment for human confirmation against the actual award — '
  'never auto-acts. Base-to-base; loadings/penalties not modelled. SECURITY INVOKER.';

-- Supabase default-grants SELECT on new views to anon + authenticated; revoke anon
-- (employee pay data, no anon surface) and keep authenticated — security_invoker then
-- RLS-scopes rows per the caller.
revoke all on public.v_award_rate_exceptions from anon;
grant select on public.v_award_rate_exceptions to authenticated;
