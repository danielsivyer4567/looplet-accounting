-- 0095: Depreciation math — per-schedule, per-period amount (ledger SC-1.G.01).
--
-- Pure calc function. Given a depreciation_schedules row (0093) and a period date,
-- returns the depreciation expense in cents for the calendar MONTH containing that
-- period. The depreciation-run edge fn (SC-1.G.02) calls this once per active
-- schedule per month and posts the result as a journal (Dr depreciation expense /
-- Cr accumulated depreciation); the per-(schedule, period) idempotency lives in the
-- fn, not here.
--
-- Self-contained: the schedule carries its own calc inputs (method, start_date,
-- opening_cost_base_cents, effective_life_years) per 0093, so this reads NOTHING
-- but the one schedule row — no journal_entries, no prior-posting lookup. The
-- amount for any month is a deterministic function of those inputs + the period,
-- which makes it independently assertable (the SC-1.G.01 DONE criterion) and means
-- a re-run for the same period always yields the same cents.
--
-- AU convention (documented so the math is reviewable and hand-computable):
--   * Day-based ATO decline-in-value formula: amount = base x rate x (days held / 365).
--     A fixed 365 divisor matches the published ATO formula; the lifetime cap below
--     guarantees total depreciation never exceeds cost despite leap years.
--   * Prime cost (straight-line): rate = 100% / effective life; base = the ORIGINAL
--     cost every period (rate_base is constant).
--   * Diminishing value: 200% DV (the rate for assets first used on/after 10 May
--     2006), rate = 200% / effective life. Base value = the asset's written-down
--     value (cost - depreciation already taken) brought forward at the start of the
--     AU income year (1 July), and HELD CONSTANT through that income year. Allocating
--     each month base x rate x (days in month / 365) therefore sums, over a full
--     income year, to the ATO annual DV figure (base x rate); the WDV only steps
--     down at the 1 July boundary, not monthly. (AU standard 1 Jul-30 Jun income
--     year is assumed; substituted accounting periods are a later refinement.)
--   * Acquisition-period proration: in the asset's first month, days held is counted
--     from start_date to month-end (inclusive), so a mid-month start is part-yeared.
--   * Lifetime cap: accumulated depreciation can never exceed opening_cost_base_cents.
--     The final period is reduced to land exactly on cost; every period after the
--     asset is fully written down returns 0. A period before start_date returns 0.
--   * Pooled / instant-write-off assets have NO schedule (0093), so they never reach
--     this function — it only ever sees real depreciating schedules.
--
-- Security model: SECURITY INVOKER (matches 0090/0094) — RLS on depreciation_schedules
-- scopes the lookup to the caller's accessible orgs; a service_role backend bypasses
-- RLS. No new SECURITY DEFINER advisor is introduced.

CREATE OR REPLACE FUNCTION public.compute_depreciation(
  p_schedule_id uuid,
  p_period      date
)
RETURNS bigint
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_method    public.depreciation_method;
  v_start     date;
  v_opening   bigint;
  v_life      numeric;
  v_rate      numeric;    -- annual rate: prime 1/life, DV 2/life
  v_target    date;       -- first day of the month we want the amount for
  v_m         date;       -- first day of the month being walked
  v_m_end     date;       -- last day of v_m's month
  v_eff_start date;       -- first day held within v_m (start_date in the acquisition month)
  v_days      integer;    -- days the asset is held within v_m
  v_acc       numeric := 0;        -- depreciation accumulated through v_m
  v_fy_base   numeric;             -- DV base value for the current AU income year
  v_rate_base numeric;             -- the base this month's rate applies to
  v_amount    numeric;
BEGIN
  SELECT method, start_date, opening_cost_base_cents, effective_life_years
    INTO v_method, v_start, v_opening, v_life
    FROM public.depreciation_schedules
    WHERE id = p_schedule_id
      AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'compute_depreciation: schedule % not found or not accessible', p_schedule_id;
  END IF;

  -- Annual rate from effective life. effective_life_years is NOT NULL CHECK > 0 (0093).
  v_rate := CASE v_method
              WHEN 'prime_cost'        THEN 1.0 / v_life
              WHEN 'diminishing_value' THEN 2.0 / v_life
            END;

  v_target  := date_trunc('month', p_period)::date;
  v_m       := date_trunc('month', v_start)::date;
  v_fy_base := v_opening;   -- DV base for the first income year (no prior depreciation)

  -- Walk month-by-month from acquisition to the target month, accumulating so the
  -- lifetime cap and (for DV) the 1-July base step-down are exact. Bounded by the
  -- early-exit once fully depreciated, so this is ~effective-life-in-months at most.
  WHILE v_m <= v_target LOOP
    -- Diminishing value: refresh the income-year base value at each 1 July to the
    -- written-down value carried forward. Prime cost never reads v_fy_base.
    IF v_method = 'diminishing_value' AND EXTRACT(MONTH FROM v_m) = 7 THEN
      v_fy_base := v_opening - v_acc;
    END IF;

    v_rate_base := CASE WHEN v_method = 'prime_cost' THEN v_opening::numeric ELSE v_fy_base END;

    v_m_end     := (v_m + INTERVAL '1 month' - INTERVAL '1 day')::date;
    v_eff_start := GREATEST(v_m, v_start);
    v_days      := GREATEST((v_m_end - v_eff_start) + 1, 0);

    v_amount := round(v_rate_base * v_rate * v_days / 365.0);
    -- Floor at 0, cap so accumulated depreciation never passes cost.
    v_amount := LEAST(GREATEST(v_amount, 0), v_opening - v_acc);
    v_acc    := v_acc + v_amount;

    IF v_m = v_target THEN
      RETURN v_amount::bigint;
    END IF;

    -- Fully depreciated before the target month -> every later period (incl. target) is 0.
    IF v_acc >= v_opening THEN
      RETURN 0;
    END IF;

    v_m := (v_m + INTERVAL '1 month')::date;
  END LOOP;

  -- Target month precedes the acquisition month: nothing depreciated yet.
  RETURN 0;
END;
$$;

COMMENT ON FUNCTION public.compute_depreciation(uuid, date) IS
  'SC-1.G.01: depreciation expense in cents for the calendar month containing p_period, for one depreciation_schedules row. Self-contained (reads only the schedule). Day-based ATO formula (days held / 365); prime cost on original cost; 200% diminishing value with the base value held constant within each AU income year (1 July step-down). Caps accumulated depreciation at cost and returns 0 once fully depreciated or before start_date. SECURITY INVOKER — RLS scopes the caller.';

GRANT EXECUTE ON FUNCTION public.compute_depreciation(uuid, date) TO authenticated;
