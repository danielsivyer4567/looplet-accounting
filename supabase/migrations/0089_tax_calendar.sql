-- 0089: Tax-calendar engine (Phase 1 of the tax copilot).
--
-- Gives every org a time-aware, personalized set of AU tax obligations with correct
-- due dates, gated by their registrations in business_profile. Later phases (seasonal
-- nudges, prep workflows, document generation) read from v_tax_calendar.
--
-- Design (hybrid rules + status): due dates are deterministic from rules, so we COMPUTE
-- obligation instances on demand (generate_tax_obligations) and — in a later slice —
-- persist only status. This migration ships the rules + generator + read view.
--
-- AU fiscal year: Jul 1 - Jun 30. "FY start year" Y means Jul Y .. Jun Y+1.
--
-- Scoping decisions for v1 (see docs/tax-calendar-engine-plan.md):
--   * Self-lodger due dates (no tax-agent concession offsets yet).
--   * PAYG-W and PAYG-I are reported on the BAS / activity statement and share its due
--     date, so they are NOT separate calendar rows (avoids duplicate due dates).
--   * Income-tax return is emitted only for self-lodging entity types
--     (sole_trader / partnership / other / unknown). Company & trust return dates differ
--     and are deferred rather than guessed.
--   * WorkCover is emitted for QLD only (other states' declaration dates added later).
--   * Due dates falling on a weekend roll forward to the next business day
--     (next_business_day). Public-holiday roll is a deferred refinement.

-- ---------------------------------------------------------------------------
-- Helper: roll a date off weekends to the next business day (Mon-Fri).
-- IMMUTABLE so it can be inlined. Public-holiday awareness is a future refinement.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.next_business_day(d date)
RETURNS date
LANGUAGE sql IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE extract(isodow FROM d)
    WHEN 6 THEN d + 2   -- Saturday -> Monday
    WHEN 7 THEN d + 1   -- Sunday   -> Monday
    ELSE d
  END;
$$;

-- ---------------------------------------------------------------------------
-- Reference catalog of obligation types (metadata for UI + lead times).
-- Not org-specific; locked like system_defaults (RLS on, reads open, no writes).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tax_obligation_types (
  key               text PRIMARY KEY,
  category          text NOT NULL,
  display_name      text NOT NULL,
  description       text,
  cadence           text NOT NULL CHECK (cadence IN ('monthly','quarterly','annual')),
  default_lead_days int  NOT NULL DEFAULT 14,   -- "due soon" window for nudges
  sort_order        int  NOT NULL DEFAULT 100
);

INSERT INTO public.tax_obligation_types (key, category, display_name, description, cadence, default_lead_days, sort_order) VALUES
  ('bas',        'gst',        'BAS / GST',
    'Business Activity Statement. GST, plus PAYG withholding and PAYG instalments where registered, are reported here.',
    'quarterly', 14, 10),
  ('super',      'super',      'Super guarantee',
    'Quarterly super for employees, due 28 days after quarter end. Funds must RECEIVE it by the due date — pay ~5 business days early.',
    'quarterly', 14, 20),
  ('tpar',       'tpar',       'TPAR',
    'Taxable Payments Annual Report for businesses paying contractors (e.g. building & construction). Due 28 August.',
    'annual', 30, 30),
  ('fbt',        'fbt',        'FBT return',
    'Fringe Benefits Tax. FBT year runs 1 Apr - 31 Mar; self-lodged return due 21 May.',
    'annual', 30, 40),
  ('income_tax', 'income_tax', 'Income tax return',
    'Annual income tax return. Self-lodgers due 31 October (tax-agent-lodged returns can be later).',
    'annual', 30, 50),
  ('eofy',       'eofy',       'EOFY wrap-up',
    'End-of-financial-year tasks (30 Jun): finalise STP by 14 Jul, pay super before 30 Jun for the deduction, asset write-off and prepayment decisions, logbook check.',
    'annual', 30, 60),
  ('workcover',  'workcover',  'WorkCover declaration',
    'Annual wages declaration to the state workers-compensation insurer. QLD declaration due ~31 August.',
    'annual', 30, 70)
ON CONFLICT (key) DO UPDATE SET
  category = EXCLUDED.category,
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  cadence = EXCLUDED.cadence,
  default_lead_days = EXCLUDED.default_lead_days,
  sort_order = EXCLUDED.sort_order;

ALTER TABLE public.tax_obligation_types ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tax_obligation_types_select ON public.tax_obligation_types;
CREATE POLICY tax_obligation_types_select ON public.tax_obligation_types
  FOR SELECT USING (true);

REVOKE INSERT, UPDATE, DELETE ON public.tax_obligation_types FROM authenticated, anon;
GRANT SELECT ON public.tax_obligation_types TO authenticated, anon;

-- ---------------------------------------------------------------------------
-- Generator: concrete obligation instances for one org over a date window,
-- gated by the org's business_profile. SECURITY INVOKER — business_profile RLS
-- scopes reads to the caller's orgs.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.generate_tax_obligations(
  p_org  uuid,
  p_from date,
  p_to   date
)
RETURNS TABLE (
  obligation_key text,
  category       text,
  title          text,
  period_label   text,
  period_start   date,
  period_end     date,
  due_date       date,
  fy_start_year  int
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
WITH prof AS (
  SELECT
    COALESCE(bp.is_gst_registered, false)      AS gst,
    COALESCE(bp.bas_frequency, 'quarterly')    AS bas_freq,
    COALESCE(bp.employees_count, 0)            AS emp,
    COALESCE(bp.is_tpar_required, false)       AS tpar,
    COALESCE(bp.is_fbt_registered, false)      AS fbt,
    COALESCE(bp.is_workcover_registered, false) AS workcover,
    bp.state_code                              AS state,
    bp.entity_type                             AS entity
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
  -- BAS quarterly (GST + PAYG-W/PAYG-I reported on the same statement)
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
  -- BAS monthly (due 21st of the following month)
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
  -- Super guarantee (quarterly, due 28 days after quarter end)
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
  -- TPAR (annual, due 28 Aug for the prior FY)
  SELECT
    'tpar', 'tpar',
    'TPAR ' || fyl, fyl,
    make_date(y, 7, 1), make_date(y + 1, 6, 30),
    public.next_business_day(make_date(y + 1, 8, 28)),
    y
  FROM yrs, prof
  WHERE prof.tpar

  UNION ALL
  -- FBT (FBT year 1 Apr - 31 Mar, self-lodged return due 21 May)
  SELECT
    'fbt', 'fbt',
    'FBT year to 31 Mar ' || (y + 1), 'FBT ' || (y + 1),
    make_date(y, 4, 1), make_date(y + 1, 3, 31),
    public.next_business_day(make_date(y + 1, 5, 21)),
    y
  FROM yrs, prof
  WHERE prof.fbt

  UNION ALL
  -- Income tax return (self-lodgers; company/trust deferred)
  SELECT
    'income_tax', 'income_tax',
    'Income tax return ' || fyl, fyl,
    make_date(y, 7, 1), make_date(y + 1, 6, 30),
    public.next_business_day(make_date(y + 1, 10, 31)),
    y
  FROM yrs, prof
  WHERE COALESCE(prof.entity, 'sole_trader') IN ('sole_trader', 'partnership', 'other')

  UNION ALL
  -- EOFY task bucket (always)
  SELECT
    'eofy', 'eofy',
    'EOFY ' || (y + 1) || ' wrap-up', fyl,
    make_date(y, 7, 1), make_date(y + 1, 6, 30),
    make_date(y + 1, 6, 30),
    y
  FROM yrs, prof

  UNION ALL
  -- WorkCover QLD annual declaration (~31 Aug)
  SELECT
    'workcover', 'workcover',
    'WorkCover declaration ' || fyl, fyl,
    make_date(y, 7, 1), make_date(y + 1, 6, 30),
    public.next_business_day(make_date(y + 1, 8, 31)),
    y
  FROM yrs, prof
  WHERE prof.workcover AND prof.state = 'QLD'
)
SELECT obligation_key, category, title, period_label,
       period_start, period_end, due_date, fy_start_year
FROM obligations
WHERE due_date BETWEEN p_from AND p_to
ORDER BY due_date, obligation_key;
$$;

GRANT EXECUTE ON FUNCTION public.generate_tax_obligations(uuid, date, date) TO authenticated;

-- ---------------------------------------------------------------------------
-- Read view: every accessible org's tax calendar over a standing window
-- (~90 days back for overdue history, ~13 months forward). security_invoker so
-- organizations RLS scopes it per tenant. Status overlay arrives in the next slice.
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS public.v_tax_calendar;
CREATE VIEW public.v_tax_calendar
WITH (security_invoker = on) AS
SELECT
  o.id                                   AS organization_id,
  g.obligation_key,
  g.category,
  g.title,
  g.period_label,
  g.period_start,
  g.period_end,
  g.due_date,
  g.fy_start_year,
  t.display_name,
  t.description,
  t.cadence,
  COALESCE(t.default_lead_days, 14)      AS default_lead_days,
  COALESCE(t.sort_order, 100)            AS sort_order,
  (g.due_date - CURRENT_DATE)            AS days_until_due,
  CASE
    WHEN g.due_date < CURRENT_DATE                                          THEN 'overdue'
    WHEN g.due_date <= CURRENT_DATE + COALESCE(t.default_lead_days, 14)     THEN 'due_soon'
    ELSE 'upcoming'
  END                                    AS stage
FROM public.organizations o
CROSS JOIN LATERAL public.generate_tax_obligations(o.id, CURRENT_DATE - 90, CURRENT_DATE + 400) g
LEFT JOIN public.tax_obligation_types t ON t.key = g.obligation_key
WHERE o.deleted_at IS NULL;

GRANT SELECT ON public.v_tax_calendar TO authenticated;
