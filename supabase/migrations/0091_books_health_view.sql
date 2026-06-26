-- 0091: Books-health rollup view (ledger SC-1.A.02).
--
-- Thin, re-weightable view over compute_books_health() (0090). It turns the four
-- raw components into a single 0-100 `score` plus a `blocking` flag that every
-- downstream tax engine (BAS, EOFY, period-close in SC-1.J) checks before it runs.
-- Kept separate from the counting function on purpose: the score can be re-weighted
-- here without touching — or re-verifying — the raw component logic in 0090.
--
-- Scoring (every input is bounded to [0,100], so `score` is guaranteed an integer
-- in [0,100]):
--   coverage component  coverage_pct itself — the share of the ledger that is coded
--                       + reconciled. Uncoding a bill lowers coverage_pct, which
--                       lowers the score (the SC-1.A.02 assertion).        weight 0.70
--   period component    100 minus 10 per activity-month still outside a period lock,
--                       floored at 0 — open books are riskier to report on. weight 0.30
--                       (absolute count, not normalised: 0090 doesn't expose total
--                        activity months; revisit if open-period skew matters.)
--   score    = round(0.70*coverage_pct + 0.30*period_subscore)::int
--   blocking = score < 80   -- downstream engines refuse to run below this. A single
--                              threshold so callers read one boolean; re-tune here.
--
-- SECURITY INVOKER (security_invoker = on) so the underlying-table RLS inside
-- compute_books_health scopes results per tenant (matches every other org view —
-- see 0082). get_accessible_org_ids() is the explicit belt-and-suspenders org
-- filter and also supplies the per-org id that fans compute_books_health out across
-- each org the caller can see.

CREATE OR REPLACE VIEW public.v_books_health
WITH (security_invoker = on) AS
SELECT
  org.id AS organization_id,
  c.uncoded_count,
  c.unreconciled_count,
  c.open_period_count,
  c.coverage_pct,
  sc.score,
  (sc.score < 80) AS blocking      -- downstream tax engines refuse to run below 80
FROM public.get_accessible_org_ids() AS org(id)
CROSS JOIN LATERAL public.compute_books_health(org.id) AS c
CROSS JOIN LATERAL (
  SELECT round(
    0.70 * c.coverage_pct                                  -- coded + reconciled share
    + 0.30 * greatest(0, 100 - 10 * c.open_period_count)   -- closed-period share
  )::int AS score
) AS sc;

GRANT SELECT ON public.v_books_health TO authenticated;
