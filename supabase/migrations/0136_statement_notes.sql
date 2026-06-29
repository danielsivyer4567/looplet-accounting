-- 0136_statement_notes.sql — SC-4.B.03 (Phase 4, statutory statements)
--
-- generate_statement_notes(org, fy_start_year) — the notes that accompany the face
-- statements (0134 P&L/BS, 0135 equity/cash-flow). Emits three structured notes:
--   1. accounting_policy   — basis of preparation (special-purpose, accrual, historical
--                            cost), depreciation, revenue, GST. Static disclosure text.
--   2. depreciation        — per-asset period charge + accumulated depreciation, sourced
--                            from the POSTED depreciation journals, whose total ties to
--                            the GL depreciation-expense movement (ties_to_gl).
--   3. related_party       — placeholder (automated analysis finds none; manual review
--                            required). A forward hook for Phase-5 Div 7A / trust work.
--
-- DEPRECIATION NOTE — the depreciation-run engine (SC-1.G.02) posts each month as
--   Dr 6700 Depreciation expense  /  Cr 1900 Accumulated depreciation
-- on a journal_entries row tagged source_type='depreciation_schedule', source_id=<the
-- depreciation_schedules row>, entry_date=<month-end> (0093/0095/0097). So per asset:
--   * period charge       = the EXPENSE leg (account_type='expense') debits of that
--                           schedule's depreciation entries dated within the FY;
--   * accumulated to date = the contra-asset leg (account_type='asset', i.e. 1900)
--                           credits of that schedule's entries up to period_end.
-- Reading the legs by account_type WITHIN the source_type='depreciation_schedule'
-- entries keeps the note tied to what was actually POSTED (not a recompute) and robust
-- to a renamed 6700/1900 code. The note total (sum of per-asset period charges) is then
-- checked against an INDEPENDENT GL figure — the FY movement on the depreciation-expense
-- account (code 6700 or name like depreciation) — via ties_to_gl; they agree unless a
-- non-engine journal touched the expense account.
--
-- DEPENDENCY / DEGRADE: reads depreciation_schedules + fixed_assets (Phase-1 SC-1.E.01,
-- migration 0093, which precedes this one in the chain). With no depreciable assets /
-- no posted depreciation the note degrades cleanly to an empty by_asset / zero totals
-- (asset_count=0), not an error. Special-purpose statements only — full AASB disclosure
-- is out of scope for this phase.
--
-- SECURITY INVOKER + STABLE (read-only): underlying-table RLS scopes every read to the
-- caller's orgs, so a foreign org returns empty notes (no leak), like the 0132–0135
-- Phase-4 siblings.
-- MIGRATION NUMBER: Phase-4 plan said 0128, taken; 0136 per the drift rule (repo head 0135).

create or replace function public.generate_statement_notes(p_org uuid, p_fy_start_year integer)
  returns jsonb
  language sql
  stable
  security invoker
  set search_path = public
as $$
  with bounds as (
    select make_date(p_fy_start_year, 7, 1)      as period_start,
           make_date(p_fy_start_year + 1, 6, 30) as period_end
  ),
  -- Legs of the org's POSTED depreciation journals (one expense + one contra-asset leg
  -- per entry), tagged with their schedule and class. One scan feeds both windows below.
  depr_legs as (
    select
      je.source_id          as schedule_id,
      je.entry_date         as entry_date,
      coa.account_type::text as account_class,
      jl.debit_cents        as debit_cents,
      jl.credit_cents       as credit_cents
    from public.journal_entries je
    join public.journal_lines jl on jl.journal_entry_id = je.id
    join public.chart_of_accounts coa on coa.id = jl.account_id
    where je.organization_id = p_org
      and je.status = 'posted'
      and je.source_type = 'depreciation_schedule'
  ),
  -- Per schedule: FY period charge (expense leg, in-FY) + accumulated to period_end
  -- (contra-asset leg, to-date).
  per_schedule as (
    select
      schedule_id,
      coalesce(sum(debit_cents) filter (
        where account_class = 'expense'
          and entry_date between (select period_start from bounds) and (select period_end from bounds)), 0) as period_dep_cents,
      coalesce(sum(credit_cents) filter (
        where account_class = 'asset'
          and entry_date <= (select period_end from bounds)), 0) as accum_dep_cents
    from depr_legs
    group by schedule_id
  ),
  -- Attach the asset's static disclosure (name, cost, method, effective life).
  by_asset as (
    select
      fa.name                  as asset_name,
      ds.method::text          as method,
      ds.effective_life_years  as effective_life_years,
      fa.cost_base_cents       as cost_base_cents,
      ps.period_dep_cents      as period_dep_cents,
      ps.accum_dep_cents       as accum_dep_cents
    from per_schedule ps
    join public.depreciation_schedules ds on ds.id = ps.schedule_id and ds.deleted_at is null
    join public.fixed_assets fa on fa.id = ds.fixed_asset_id and fa.deleted_at is null
    where ps.period_dep_cents <> 0 or ps.accum_dep_cents <> 0
  ),
  -- Independent GL truth: FY movement on the depreciation-expense account(s).
  gl_dep as (
    select coalesce(sum(jl.debit_cents - jl.credit_cents), 0) as gl_expense_cents
    from public.journal_lines jl
    join public.journal_entries je on je.id = jl.journal_entry_id
     and je.status = 'posted' and je.organization_id = p_org
     and je.entry_date between (select period_start from bounds) and (select period_end from bounds)
    join public.chart_of_accounts coa on coa.id = jl.account_id
    where coa.account_type = 'expense'
      and (coa.code = '6700' or coa.name ilike '%depreciation%')
  ),
  -- The note's headline period charge, computed once (reused by the total + ties_to_gl).
  period_dep_total as (
    select coalesce(sum(period_dep_cents), 0) as total_cents from per_schedule
  )

  select jsonb_build_object(
    'organization_id', p_org,
    'fy_start_year', p_fy_start_year,
    'period_start', (select period_start from bounds),
    'period_end', (select period_end from bounds),
    'basis', 'special_purpose',
    'notes', jsonb_build_object(
      'accounting_policy', jsonb_build_object(
        'title', 'Statement of significant accounting policies',
        'body', jsonb_build_array(
          'These special-purpose financial statements have been prepared on an accrual basis under the historical cost convention. Amounts are stated in Australian cents.',
          'Property, plant and equipment are carried at cost less accumulated depreciation. Depreciation is recognised over each asset''s effective life using the prime cost (straight-line) or diminishing value method in accordance with ATO effective-life determinations (see the depreciation note).',
          'Revenue is recognised when the entity''s performance obligations to its customers are satisfied.',
          'Where the entity is registered for GST, revenue, expenses and assets are stated net of recoverable GST; the net GST position is reported as a receivable or payable.'
        )
      ),
      'depreciation', jsonb_build_object(
        'title', 'Depreciation and the fixed-asset register',
        'asset_count', (select count(*) from by_asset),
        'by_asset', (
          select coalesce(jsonb_agg(jsonb_build_object(
                   'asset_name', asset_name,
                   'method', method,
                   'effective_life_years', effective_life_years,
                   'cost_base_cents', cost_base_cents,
                   'period_depreciation_cents', period_dep_cents,
                   'accumulated_depreciation_cents', accum_dep_cents)
                 order by asset_name), '[]'::jsonb)
          from by_asset),
        'period_depreciation_total_cents', (select total_cents from period_dep_total),
        'gl_depreciation_expense_cents', (select gl_expense_cents from gl_dep),
        'ties_to_gl', (
          select (select total_cents from period_dep_total)
                   = (select gl_expense_cents from gl_dep))
      ),
      'related_party', jsonb_build_object(
        'title', 'Related-party transactions',
        'status', 'placeholder',
        'body', 'No related-party transactions have been identified through automated analysis. Related-party balances and transactions (owner loans, Division 7A arrangements, trust distributions) require manual confirmation before lodgement.'
      )
    )
  );
$$;

comment on function public.generate_statement_notes(uuid, integer) is
  'Structured notes (jsonb) to the statutory statements for an FY: accounting-policy '
  'note, depreciation note (per-asset period charge + accumulated, sourced from the '
  'posted depreciation_schedule journals, total tied to the GL depreciation-expense '
  'movement via ties_to_gl), and a related-party placeholder. Reads depreciation_schedules/'
  'fixed_assets (0093); degrades to empty notes with no depreciable assets. Special-purpose '
  'only. SECURITY INVOKER.';

revoke all on function public.generate_statement_notes(uuid, integer) from public, anon;
grant execute on function public.generate_statement_notes(uuid, integer) to authenticated;
