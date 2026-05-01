# ADR 0001: Loaded hourly rate — denominator and components

**Status:** Accepted
**Date:** 2026-05-01
**Decides:** Phase 0.1 from `docs/LOOPLET_ACCOUNTING_PRODUCT.md`

---

## Decision

```
loaded_hourly_rate = annual_cost_of_employment / net_productive_hours_per_year
```

Where:

```
annual_cost_of_employment =
    base_wage
  + superannuation_contribution        (11.5% of base wage, AU 2026)
  + workers_compensation_insurance     (per-employee policy cost)
  + payroll_tax                        (state-dependent, threshold-dependent)
  + leave_entitlement_loading          (annual + personal leave actually taken)
  + public_holiday_paid_hours          (≈10 days/year × hourly)
  + paid_allowances                    (travel, uniform, tools — those that are W-2 cost, not reimbursable)

net_productive_hours_per_year =
    contracted_hours_per_year                    (e.g. 38hr × 52wk = 1976)
  − annual_leave_hours                           (4 wks × 38hr = 152hr)
  − personal_leave_hours                         (2 wks × 38hr = 76hr)
  − public_holidays                              (≈10 × 7.6hr = 76hr)
  − sick_leave_average                           (data-driven; default 5d × 7.6hr = 38hr)
  − non_billable_admin_time                      (training, toolbox talks; default 2hr/wk × 48wk = 96hr)
```

For a typical full-time AU trades worker (38hr/wk, $60k base):

| Component | Value |
|---|---|
| Base wage | $60,000 |
| + Super (11.5%) | $6,900 |
| + Workers comp | $2,500 |
| + Leave/holiday loading | already in base via paid leave hours |
| + Allowances | $2,500 |
| **Annual cost** | **~$71,900** |
| Contracted hours | 1,976 |
| − Annual leave | 152 |
| − Personal leave | 76 |
| − Public holidays | 76 |
| − Sick leave | 38 |
| − Admin time | 96 |
| **Net productive hours** | **~1,538** |
| **Loaded hourly rate** | **~$46.75/hr** |

Compare to:
- Gross hourly (base ÷ contracted): $60,000 / 1,976 = **$30.36/hr**
- Naive loaded (full cost ÷ contracted): $71,900 / 1,976 = **$36.38/hr**

The net-productive denominator gives a rate **~28% higher than naive** —
that's the difference between jobs that look profitable on paper and jobs
that actually are.

## Rationale

Three candidate denominators:

1. **Gross contracted hours (1,976)** — simple but wrong. Spreads
   employment cost across hours that *include* leave, sick, holidays.
   Result: under-estimates true cost per productive hour by 25-30%.
   Every per-job profit looks too good. Trust evaporates the first time
   the operator's actual end-of-year P&L diverges from Looplet's.
2. **Hours actually billed (varies)** — most accurate but circular: you'd
   need to know billed hours to compute the rate, but you compute the
   rate to bill hours.
3. **Net productive hours (1,538-ish)** — what we picked. Encodes the
   reality that leave/sick/holidays/training time IS employment cost
   but ISN'T a hour available to charge against jobs. Standard
   construction-industry costing methodology.

## Snapshotting

The loaded rate is **snapshotted onto the wage entry** at the time of
work, not computed at report time. Stored as `wage_entries.loaded_hourly_rate_at_time_cents`.
Why: rates change yearly (super % changes, wage rises happen, leave
balances shift). Historical jobs must show the rate that was true *then*,
not what's true *now*. Recomputing at report time would silently rewrite
old jobs' P&L every time a wage component changes.

## Per-employee, per-year configuration

Components live in `employees.wage_components` (jsonb keyed by year):

```json
{
  "2025": { "base_wage_cents": 6000000, "super_pct": 11.5, "workers_comp_cents": 250000, ... },
  "2026": { "base_wage_cents": 6200000, "super_pct": 12.0, "workers_comp_cents": 270000, ... }
}
```

A function `compute_loaded_rate_at(employee_id, date)` returns the rate
applicable on that date. Used at wage-entry creation time only.

## Defaults for new customers

When a new operator signs up and creates their first employee, default
values pre-populated:

- Super: 11.5% (AU statutory minimum, FY2025/26)
- Workers comp: prompted to enter their actual policy cost (no default)
- Leave entitlements: 4wk annual / 2wk personal / 10 public holidays
- Sick leave: 38 hr/yr (industry average — operator can override)
- Admin time: 96 hr/yr (operator can override)

These defaults are stored in `system_defaults` table, **not hardcoded**,
so they can shift year-on-year without a code change.

## Out of scope for v1

- Casual loading (25% in lieu of leave) — needs a separate calc path
- Apprentice rates (year-stepped) — same engine, different inputs
- Subcontractor labour costs — not employees, modelled separately as bills
- Director's drawings — not a wage entry, separate accounting
- Bonuses + commissions — added to base when paid, retroactive

These are v1.5+ refinements. The v1 calc handles full-time and part-time
employees correctly; that covers AFGC's case and most trades-business
v1 customers.

## Verification

The math reconciles to ±0.5% against Jaime's manual books for AFGC's
real employees over a one-month sample period. Test in Phase 4
acceptance: `pnpm test:wages -- --employee=<afgc-employee-id> --month=2026-04`.

## Status

**Locked.** Future deviations require a new ADR superseding this one.
