-- 0128_award_rates.sql — SC-3.K.01 (Phase 3, award interpretation — ASSIST-ONLY)
--
-- Award interpretation is HIGH-LIABILITY: this lays the data so a later view
-- (SC-3.K.02) can FLAG a possible underpayment for a human to confirm. It NEVER
-- auto-acts and never changes pay. The seed is ILLUSTRATIVE, not an authoritative
-- award-rate source.
--
-- One atomic schema unit:
--   1. employees gains modern_award + classification_level (both nullable; existing
--      employees have none until set). The employee's effective base hourly rate is
--      NOT duplicated here — it already lives in employees.wage_components
--      (base_hourly_rate / loaded_hourly_rate_cents, written by the employee UI). The
--      SC-3.K.02 underpayment view reads the rate from there, avoiding a second
--      source of truth for pay (drift in a high-liability comparison).
--   2. award_rates — a GLOBAL read-only reference (like payroll_tax_rates 0125 /
--      tax_obligation_types 0089): the minimum hourly rate per (award, classification)
--      effective-dated as half-open [effective_from, effective_to) windows, resolved
--      by the SC-3.K.02 underpayment check.
--
-- MIGRATION NUMBER: ledger planned 0119; reassigned to 0128 per the drift rule
-- (0125–0127 = SC-3.I.01/3.I.02/3.J.01). Verified live: employees has no award columns
-- and no existing award_rates; wage_components already carries the hourly rate
-- (base_hourly_rate / loaded_hourly_rate_cents), so no rate column is added here.

alter table public.employees
  add column modern_award         text,
  add column classification_level text;

comment on column public.employees.modern_award is
  'Modern award code/name (e.g. MA000004) — assist-only award interpretation (SC-3.K).';
comment on column public.employees.classification_level is
  'Award classification level (e.g. Level 1), paired with modern_award to resolve award_rates. '
  'The effective base rate for the SC-3.K.02 underpayment comparison comes from '
  'wage_components (base_hourly_rate / loaded_hourly_rate_cents), not a duplicate column.';

create table public.award_rates (
  id                   uuid primary key default gen_random_uuid(),
  modern_award         text not null,
  classification_level text not null,
  effective_from       date not null,
  effective_to         date,                              -- null = current (open-ended)
  min_hourly_rate_cents bigint not null check (min_hourly_rate_cents >= 0),
  notes                text,
  unique (modern_award, classification_level, effective_from),
  check (effective_to is null or effective_to > effective_from)
);

comment on table public.award_rates is
  'Global ILLUSTRATIVE award minimum hourly rates per (modern_award, classification_level), '
  'effective-dated half-open. Read-only reference (like payroll_tax_rates). ASSIST-ONLY — '
  'flags possible underpayment (SC-3.K.02) for human confirmation; NOT an authoritative '
  'award source and never auto-corrects pay.';

-- Illustrative AU award minimums (~FY2024-25). NOT exhaustive or authoritative.
insert into public.award_rates
  (modern_award, classification_level, effective_from, effective_to, min_hourly_rate_cents, notes)
values
  ('MA000004', 'Level 1', date '2024-07-01', null, 2655, 'General Retail Industry Award — illustrative.'),
  ('MA000004', 'Level 2', date '2024-07-01', null, 2714, 'General Retail Industry Award — illustrative.'),
  ('MA000004', 'Level 3', date '2024-07-01', null, 2755, 'General Retail Industry Award — illustrative.'),
  ('MA000003', 'Level 1', date '2024-07-01', null, 2622, 'Fast Food Industry Award — illustrative.'),
  ('MA000003', 'Level 2', date '2024-07-01', null, 2715, 'Fast Food Industry Award — illustrative.')
on conflict (modern_award, classification_level, effective_from) do update set
  effective_to = excluded.effective_to,
  min_hourly_rate_cents = excluded.min_hourly_rate_cents,
  notes = excluded.notes;

alter table public.award_rates enable row level security;

create policy award_rates_select on public.award_rates
  for select using (true);

revoke insert, update, delete on public.award_rates from authenticated, anon;
grant select on public.award_rates to authenticated, anon;
