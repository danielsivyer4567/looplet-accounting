-- 0173_asic_obligation.sql - SC-5.P.02 (Phase 5, ASIC annual-review obligation)
--
-- Replaces the SC-3.M.02 placeholder ASIC annual-review calendar row with a real,
-- curated review-date source on business_profile. 0131 already seeded the
-- asic_annual_review obligation type and emitted a "confirm review date" 31 Jan
-- placeholder for every company. This slice:
--   * adds business_profile.asic_review_date (the company's annual review date /
--     registration anniversary, curated by the user or future ASIC import),
--   * guards the obligation-type insert with ON CONFLICT DO NOTHING, and
--   * rebases generate_tax_obligations on the latest repo body, changing only the
--     ASIC branch so companies emit the row on their configured review date.
--
-- The row is a review-date reminder. ASIC annual statements, payment due dates,
-- Form 484 corrections, and solvency-resolution timing are separate obligations /
-- workflow steps and are not guessed here.
--
-- MIGRATION NUMBER: ledger planned 0165, long taken by SMSF TBC/TBAR. Reassigned
-- to 0173 per the drift rule: sequential repo head is 0172_asic_register
-- (0178/0179 are late hotfixes that sort after).

alter table public.business_profile
  add column if not exists asic_review_date date;

comment on column public.business_profile.asic_review_date is
  'SC-5.P.02: curated ASIC annual review date / company registration anniversary. '
  'generate_tax_obligations uses the month/day annually for company review-date '
  'reminders. Null means unknown and emits no ASIC annual-review calendar row.';

insert into public.tax_obligation_types
  (key, category, display_name, description, cadence, default_lead_days, sort_order)
values
  ('asic_annual_review', 'asic', 'ASIC annual review',
   'Annual company review-date reminder. Check the ASIC annual statement for fee, details-update, and solvency-resolution timing.',
   'annual', 21, 55)
on conflict (key) do nothing;

create or replace function public.generate_tax_obligations(p_org uuid, p_from date, p_to date)
  returns table(
    obligation_key text, category text, title text, period_label text,
    period_start date, period_end date, due_date date, fy_start_year integer
  )
  language sql
  stable
  security invoker
  set search_path = public
as $function$
WITH prof AS (
  SELECT
    COALESCE(bp.is_gst_registered, false)       AS gst,
    COALESCE(bp.bas_frequency, 'quarterly')     AS bas_freq,
    COALESCE(bp.employees_count, 0)             AS emp,
    COALESCE(bp.is_tpar_required, false)        AS tpar,
    COALESCE(bp.is_fbt_registered, false)       AS fbt,
    COALESCE(bp.is_workcover_registered, false) AS workcover,
    bp.state_code                               AS state,
    bp.entity_type                              AS entity,
    bp.asic_review_date                         AS asic_review_date
  FROM (SELECT p_org AS oid) x
  LEFT JOIN public.business_profile bp ON bp.organization_id = x.oid
),
yrs AS (
  SELECT gs AS y,
         'FY' || gs || '-' || lpad(((gs + 1) % 100)::text, 2, '0') AS fyl
  FROM generate_series(extract(year FROM p_from)::int - 1,
                       extract(year FROM p_to)::int + 1) gs
),
quarters AS (
  SELECT
    y.y, y.fyl, qn.quarter_num,
    CASE qn.quarter_num
      WHEN 1 THEN make_date(y.y, 7, 1)
      WHEN 2 THEN make_date(y.y, 10, 1)
      WHEN 3 THEN make_date(y.y + 1, 1, 1)
      ELSE        make_date(y.y + 1, 4, 1)
    END AS qs,
    CASE qn.quarter_num
      WHEN 1 THEN make_date(y.y, 9, 30)
      WHEN 2 THEN make_date(y.y, 12, 31)
      WHEN 3 THEN make_date(y.y + 1, 3, 31)
      ELSE        make_date(y.y + 1, 6, 30)
    END AS qe
  FROM yrs y
  CROSS JOIN (VALUES (1), (2), (3), (4)) AS qn(quarter_num)
),
months AS (
  SELECT (date_trunc('month', gs))::date AS ms
  FROM generate_series(p_from - interval '2 months',
                       p_to + interval '1 month',
                       interval '1 month') gs
),
asic_reviews AS (
  SELECT
    y,
    fyl,
    (
      prof.asic_review_date
      + make_interval(years => (
          y
          + CASE WHEN extract(month FROM prof.asic_review_date)::int >= 7 THEN 0 ELSE 1 END
          - extract(year FROM prof.asic_review_date)::int
        ))
    )::date AS review_due_date
  FROM yrs, prof
  WHERE prof.entity = 'company'
    AND prof.asic_review_date IS NOT NULL
),
obligations AS (
  SELECT
    'bas'::text                              AS obligation_key,
    'gst'::text                              AS category,
    'BAS Q' || quarter_num || ' ' || fyl     AS title,
    'Q' || quarter_num || ' ' || fyl         AS period_label,
    qs                                       AS period_start,
    qe                                       AS period_end,
    public.next_business_day(CASE quarter_num
      WHEN 1 THEN make_date(y, 10, 28)
      WHEN 2 THEN make_date(y + 1, 2, 28)
      WHEN 3 THEN make_date(y + 1, 4, 28)
      ELSE        make_date(y + 1, 7, 28)
    END)                                     AS due_date,
    y                                        AS fy_start_year
  FROM quarters, prof
  WHERE prof.gst AND prof.bas_freq = 'quarterly'

  UNION ALL
  SELECT
    'bas', 'gst',
    'BAS ' || to_char(ms, 'Mon YYYY'),
    to_char(ms, 'Mon YYYY'),
    ms,
    (ms + interval '1 month - 1 day')::date,
    public.next_business_day((ms + interval '1 month')::date + 20),
    (extract(year FROM ms)::int - CASE WHEN extract(month FROM ms) >= 7 THEN 0 ELSE 1 END)
  FROM months, prof
  WHERE prof.gst AND prof.bas_freq = 'monthly'

  UNION ALL
  SELECT
    'super', 'super',
    'Super Q' || quarter_num || ' ' || fyl,
    'Q' || quarter_num || ' ' || fyl,
    qs, qe,
    public.next_business_day((qe + 28)),
    y
  FROM quarters, prof
  WHERE prof.emp > 0

  UNION ALL
  SELECT
    'tpar', 'tpar',
    'TPAR ' || fyl, fyl,
    make_date(y, 7, 1), make_date(y + 1, 6, 30),
    public.next_business_day(make_date(y + 1, 8, 28)),
    y
  FROM yrs, prof
  WHERE prof.tpar

  UNION ALL
  SELECT
    'fbt', 'fbt',
    'FBT year to 31 Mar ' || (y + 1), 'FBT ' || (y + 1),
    make_date(y, 4, 1), make_date(y + 1, 3, 31),
    public.next_business_day(make_date(y + 1, 5, 21)),
    y
  FROM yrs, prof
  WHERE prof.fbt

  UNION ALL
  SELECT
    'fbt_instalment', 'fbt',
    'FBT instalment Q' || quarter_num || ' ' || fyl,
    'Q' || quarter_num || ' ' || fyl,
    qs, qe,
    public.next_business_day(CASE quarter_num
      WHEN 1 THEN make_date(y, 10, 28)
      WHEN 2 THEN make_date(y + 1, 2, 28)
      WHEN 3 THEN make_date(y + 1, 4, 28)
      ELSE        make_date(y + 1, 7, 28)
    END),
    y
  FROM quarters, prof
  WHERE prof.fbt

  UNION ALL
  SELECT
    'income_tax', 'income_tax',
    'Income tax return ' || fyl, fyl,
    make_date(y, 7, 1), make_date(y + 1, 6, 30),
    public.next_business_day(make_date(y + 1, 10, 31)),
    y
  FROM yrs, prof
  WHERE COALESCE(prof.entity, 'sole_trader') IN ('sole_trader', 'partnership', 'other')

  UNION ALL
  SELECT
    'eofy', 'eofy',
    'EOFY ' || (y + 1) || ' wrap-up', fyl,
    make_date(y, 7, 1), make_date(y + 1, 6, 30),
    make_date(y + 1, 6, 30),
    y
  FROM yrs, prof

  UNION ALL
  SELECT
    'workcover', 'workcover',
    'WorkCover declaration (' || COALESCE(prof.state, '?') || ') ' || fyl, fyl,
    make_date(y, 7, 1), make_date(y + 1, 6, 30),
    public.next_business_day(CASE prof.state
      WHEN 'QLD' THEN make_date(y + 1, 8, 31)
      WHEN 'NSW' THEN make_date(y + 1, 9, 30)
      WHEN 'VIC' THEN make_date(y + 1, 10, 31)
      WHEN 'SA'  THEN make_date(y + 1, 9, 15)
      WHEN 'WA'  THEN make_date(y + 1, 8, 31)
      WHEN 'TAS' THEN make_date(y + 1, 12, 1)
      WHEN 'NT'  THEN make_date(y + 1, 3, 31)
      WHEN 'ACT' THEN make_date(y + 1, 9, 30)
      ELSE            make_date(y + 1, 8, 31)
    END),
    y
  FROM yrs, prof
  WHERE prof.workcover

  UNION ALL
  SELECT
    'payroll_tax', 'payroll_tax',
    'Payroll tax ' || to_char(ms, 'Mon YYYY'),
    to_char(ms, 'Mon YYYY'),
    ms, (ms + interval '1 month - 1 day')::date,
    public.next_business_day((ms + interval '1 month')::date + 6),
    (extract(year FROM ms)::int - CASE WHEN extract(month FROM ms) >= 7 THEN 0 ELSE 1 END)
  FROM months, prof
  WHERE prof.emp > 0 AND prof.state IS NOT NULL

  UNION ALL
  SELECT
    'asic_annual_review', 'asic',
    'ASIC annual review ' || fyl, fyl,
    make_date(y, 7, 1), make_date(y + 1, 6, 30),
    review_due_date,
    y
  FROM asic_reviews

  UNION ALL
  SELECT
    'tbar', 'smsf',
    'TBAR Q' || quarter_num || ' ' || fyl,
    'Q' || quarter_num || ' ' || fyl,
    qs, qe,
    public.next_business_day((qe + 28)),
    y
  FROM quarters, prof
  WHERE prof.entity = 'smsf'

  UNION ALL
  SELECT
    'trust_distribution', 'trust',
    'Trust distribution resolution ' || fyl, fyl,
    make_date(y, 7, 1), make_date(y + 1, 6, 30),
    make_date(y + 1, 6, 30),
    y
  FROM yrs, prof
  WHERE prof.entity = 'trust'
)
SELECT obligation_key, category, title, period_label,
       period_start, period_end, due_date, fy_start_year
FROM obligations
WHERE due_date BETWEEN p_from AND p_to
ORDER BY due_date, obligation_key;
$function$;

comment on function public.generate_tax_obligations(uuid, date, date) is
  'Generates computed tax/compliance obligations for an org and date window. '
  'SC-5.P.02 replaces the ASIC annual-review placeholder with business_profile.'
  'asic_review_date, gated to entity_type=''company''.';

revoke all on function public.generate_tax_obligations(uuid, date, date) from public, anon;
grant execute on function public.generate_tax_obligations(uuid, date, date) to authenticated;
