-- 0116_gst_treatment_ref.sql — SC-3.A.01 (Phase 3, GST treatment validation)
--
-- Foundation for GST treatment validation. Adds (1) a read-only reference set of
-- AU GST treatment codes and (2) a nullable "expected GST treatment" column on
-- both suppliers and chart_of_accounts. No validation logic here — that lands in
-- SC-3.A.02's v_gst_treatment_exceptions, which reads these columns to flag a
-- bill line whose GST treatment contradicts the supplier's/account's expectation.
-- Foundation-only, so it lands green independently.
--
-- gst_treatment_codes is GLOBAL reference data (the codes are identical for every
-- tenant), modelled on tax_obligation_types (0089): text PK, no organization_id,
-- no audit columns, RLS read-only. Writes are service_role/owner only.
--
-- MIGRATION NUMBER: reassigned from the ledger's planned 0107 to 0116 per the
-- drift rule — 0107 is the payroll approval gate and 0108–0115 were taken by the
-- legal-RAG epic (verified against the live dxoikltymmknxqpkpyhi head + repo).

-- 1. Reference table: AU GST treatment codes -------------------------------------
create table if not exists public.gst_treatment_codes (
  code         text primary key,
  display_name text not null,
  description  text,
  sort_order   integer not null default 0
);

comment on table public.gst_treatment_codes is
  'Global reference: AU GST treatment codes used to tag the expected GST treatment '
  'of a supplier/account and to validate bill-line GST (SC-3.A). Read-only '
  'reference data modelled on tax_obligation_types; writes are backend-only.';

-- Read-only reference: any authenticated user may read; writes are service_role
-- / table-owner only (no INSERT/UPDATE/DELETE policy). Global (not org-scoped),
-- following the reference-data shape of tax_obligation_types / legal_corpus — but
-- deliberately scoped to `authenticated` only, stricter than tax_obligation_types
-- (which is also anon-readable): internal accounting reference data has no
-- anon-facing surface, so least-privilege wins over matching the older grant.
alter table public.gst_treatment_codes enable row level security;

drop policy if exists gst_treatment_codes_select on public.gst_treatment_codes;
create policy gst_treatment_codes_select
  on public.gst_treatment_codes for select
  to authenticated
  using (true);

grant select on public.gst_treatment_codes to authenticated;

-- Seed the AU GST treatment set (idempotent / replay-safe).
insert into public.gst_treatment_codes (code, display_name, description, sort_order) values
  ('GST',            'GST (taxable)',          'Standard 10% GST applies — taxable supply / creditable acquisition.',                         10),
  ('GST_FREE',       'GST-free',               'GST-free supply (Div 38) — e.g. basic food, most health, education. No GST charged; input credits still claimable.', 20),
  ('INPUT_TAXED',    'Input-taxed',            'Input-taxed supply (Div 40) — e.g. residential rent, financial supplies. No GST charged and no input tax credit.', 30),
  ('GST_ON_CAPITAL', 'GST on capital',         'GST on a capital acquisition — reported separately at BAS label G10.',                        40),
  ('EXPORT',         'Export',                 'Export of goods or services — GST-free under the export rules (Subdiv 38-E).',                50),
  ('NO_GST',         'No GST / out of scope',  'Not a taxable transaction — e.g. wages, ATO payments, internal transfers. Excluded from GST labels.', 60)
on conflict (code) do nothing;

-- 2. Expected-treatment columns (nullable) --------------------------------------
-- What GST treatment SHOULD apply. NULL = no expectation set (the default for all
-- existing rows). Added to BOTH suppliers and chart_of_accounts so SC-3.A.02 can
-- use whichever signal(s) the org has configured. chart_of_accounts had no
-- tax-code concept before this (only account_type).
alter table public.suppliers
  add column if not exists expected_gst_treatment text references public.gst_treatment_codes(code);

alter table public.chart_of_accounts
  add column if not exists expected_gst_treatment text references public.gst_treatment_codes(code);

comment on column public.suppliers.expected_gst_treatment is
  'Optional FK gst_treatment_codes: the GST treatment expected for this supplier''s '
  'bills. NULL = no expectation. Read by v_gst_treatment_exceptions (SC-3.A.02).';
comment on column public.chart_of_accounts.expected_gst_treatment is
  'Optional FK gst_treatment_codes: the GST treatment expected for postings to this '
  'account. NULL = no expectation. Read by v_gst_treatment_exceptions (SC-3.A.02).';
