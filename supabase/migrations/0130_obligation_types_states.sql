-- 0130_obligation_types_states.sql — SC-3.M.01 (Phase 3, obligation-types expansion)
--
-- Two changes to the tax calendar, ONE atomic generate_tax_obligations rewrite:
--   1. WorkCover declaration now generates for EVERY state (was QLD-only), with a
--      per-state due date (the wages-declaration deadline differs by state insurer).
--   2. FBT INSTALMENTS — a new quarterly obligation for FBT-registered employers,
--      reported on the activity statement (due on the BAS quarter dates).
--
-- The per-state WorkCover dates and the "FBT-registered ⇒ pays instalments" gate are
-- APPROXIMATE (most states tie the declaration to policy renewal; FBT instalments
-- only apply above the prior-year ~$3,000 threshold). Calendar nudges are assist-only
-- — confirm with the insurer/ATO. The figures live in the function so they're easy to
-- correct.
--
-- DRIFT: verified the LIVE generate_tax_obligations(uuid,date,date) body before
-- rewriting — it matches 0089 (prof CTE flags gst/bas_freq/emp/tpar/fbt/workcover/
-- state/entity). This CREATE OR REPLACE reproduces every existing branch verbatim and
-- changes only the workcover branch + adds the fbt_instalment branch.
--
-- MIGRATION NUMBER: ledger planned 0121; reassigned to 0130 per the drift rule
-- (0125–0129 used). Sequence BEFORE SC-3.M.02 (both rewrite this same function body).

-- New obligation type for the FBT instalment (workcover already seeded in 0089).
insert into public.tax_obligation_types
  (key, category, display_name, description, cadence, default_lead_days, sort_order)
values
  ('fbt_instalment', 'fbt', 'FBT instalment',
   'Quarterly FBT instalment reported on the activity statement (FBT payers above the prior-year instalment threshold).',
   'quarterly', 14, 45)
on conflict (key) do update set
  category = excluded.category,
  display_name = excluded.display_name,
  description = excluded.description,
  cadence = excluded.cadence,
  default_lead_days = excluded.default_lead_days,
  sort_order = excluded.sort_order;

create or replace function public.generate_tax_obligations(p_org uuid, p_from date, p_to date)
  returns table(
    obligation_key text, category text, title text, period_label text,
    period_start date, period_end date, due_date date, fy_start_year integer
  )
  language sql
  stable
  set search_path to 'public'
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
    bp.entity_type                              AS entity
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
    y.y,
    y.fyl,
    qn.quarter_num,
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

  -- FBT instalments (quarterly) for FBT-registered employers — reported on the
  -- activity statement, so they fall on the BAS quarter due dates.
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

  -- WorkCover annual wages declaration — now ALL states, per-state due date.
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
)
SELECT obligation_key, category, title, period_label,
       period_start, period_end, due_date, fy_start_year
FROM obligations
WHERE due_date BETWEEN p_from AND p_to
ORDER BY due_date, obligation_key;
$function$;
