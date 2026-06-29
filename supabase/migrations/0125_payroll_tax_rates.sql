-- 0125_payroll_tax_rates.sql — SC-3.I.01 (Phase 3, payroll tax)
--
-- Per-state payroll-tax thresholds + rates as GLOBAL REFERENCE DATA (not org-scoped),
-- mirroring tax_obligation_types (0089): read-only to authenticated+anon, no per-org
-- RLS. The monthly accrual (SC-3.I.02) joins this by the org's
-- business_profile.state_code (verified live: text, CHECK in QLD/NSW/VIC/WA/SA/TAS/
-- NT/ACT) and the period date.
--
-- EFFECTIVE-DATED so the accrual resolves the right year's parameters: each row is a
-- half-open window [effective_from, effective_to). The resolver (in SC-3.I.02) picks
-- the row WHERE state_code = ? AND effective_from <= period_date AND (effective_to IS
-- NULL OR period_date < effective_to). effective_to NULL = the current, open-ended row.
--
-- Thresholds are stored ANNUAL (in cents); the monthly accrual apportions threshold/12.
-- MVP single standard rate per state — QLD's higher >$6.5M tier + mental-health levy
-- and VIC's regional rate are deliberately NOT modelled yet (noted per row).
--
-- MIGRATION NUMBER: ledger planned 0116, but 0116–0124 are taken (legal-RAG 0108–0115;
-- accountant 0116–0124). Reassigned to 0125 per the drift rule (verified free: files
-- jump 0124 → 0178). Reference-data-only — lands green alone. Verified live: no
-- existing public.payroll_tax_rates.

create table public.payroll_tax_rates (
  id                     uuid primary key default gen_random_uuid(),
  state_code             text not null
    check (state_code in ('QLD', 'NSW', 'VIC', 'WA', 'SA', 'TAS', 'NT', 'ACT')),
  effective_from         date not null,
  effective_to           date,                              -- null = current (open-ended)
  annual_threshold_cents bigint not null check (annual_threshold_cents >= 0),
  rate                   numeric(6, 5) not null check (rate >= 0 and rate <= 1),
  notes                  text,
  -- one parameter row per state per effective-start (the upsert arbiter); windows for
  -- a state must not overlap — enforced by convention + the half-open resolver.
  unique (state_code, effective_from),
  check (effective_to is null or effective_to > effective_from)
);

comment on table public.payroll_tax_rates is
  'Global per-state payroll-tax parameters (annual threshold + standard rate), '
  'effective-dated as half-open [effective_from, effective_to) windows. Read-only '
  'reference data (like tax_obligation_types); joined by business_profile.state_code '
  'in the SC-3.I.02 accrual. MVP single rate/state — QLD >$6.5M tier + levy, VIC '
  'regional rate not modelled.';

-- AU state payroll-tax parameters (standard rate, current FY). Stored annual; the
-- accrual apportions to the month. effective_from 2024-07-01 so FY2025-26 resolves.
insert into public.payroll_tax_rates
  (state_code, effective_from, effective_to, annual_threshold_cents, rate, notes)
values
  ('QLD', date '2024-07-01', null, 130000000, 0.04750,
   'Annual threshold $1.3M; standard rate 4.75% for groups <= $6.5M AU taxable wages. Higher tier + mental-health levy not modelled.'),
  ('NSW', date '2024-07-01', null, 120000000, 0.05450,
   'Annual threshold $1.2M; rate 5.45%.'),
  ('VIC', date '2024-07-01', null, 90000000, 0.04850,
   'Annual threshold $900k; metropolitan rate 4.85% (regional employers lower; not modelled).')
on conflict (state_code, effective_from) do update set
  effective_to = excluded.effective_to,
  annual_threshold_cents = excluded.annual_threshold_cents,
  rate = excluded.rate,
  notes = excluded.notes;

alter table public.payroll_tax_rates enable row level security;

-- Read-only global reference: every authenticated/anon caller may SELECT; nobody may
-- write through the API (writes happen only via migrations like this one).
create policy payroll_tax_rates_select on public.payroll_tax_rates
  for select using (true);

revoke insert, update, delete on public.payroll_tax_rates from authenticated, anon;
grant select on public.payroll_tax_rates to authenticated, anon;
