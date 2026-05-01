# ADR 0002: Daily overhead allocation rule

**Status:** Accepted
**Date:** 2026-05-01
**Decides:** Phase 0.2 from `docs/LOOPLET_ACCOUNTING_PRODUCT.md`

---

## Decision

**Daily overhead is allocated to each job in proportion to the hours of
labour that job consumed that day.**

```
For each working day D in the period:
  total_labour_hours_D  = SUM(wage_entries.hours WHERE date = D AND organization = X)
  daily_overhead_D      = organization_overhead_profile.daily_rate_cents

  For each job J active on day D:
    job_labour_hours_D = SUM(wage_entries.hours WHERE date = D AND job_id = J)
    overhead_share_J_D = daily_overhead_D × (job_labour_hours_D / total_labour_hours_D)

    INSERT INTO overhead_allocations (job_id, date, amount_cents)
    VALUES (J, D, overhead_share_J_D)
```

Example — AFGC has $400/day overhead. Tuesday, three jobs got labour:

| Job | Hours that day |
|---|---|
| 1090 | 6 |
| 1102 | 4 |
| 1108 | 2 |
| **Total** | **12** |

Allocations:
- 1090: $400 × (6/12) = **$200**
- 1102: $400 × (4/12) = **$133.33**
- 1108: $400 × (2/12) = **$66.67**

Total: $400. Conserved exactly.

## Rationale

Three candidates were considered:

1. **Equal split across all open jobs.** A job paused for a month still
   carries 1/N of overhead. Inflates costs of stalled jobs unfairly.
   Penalises operators for legitimate pauses (waiting on materials,
   customer sign-off, etc.).
2. **Proportional to revenue share.** Big jobs carry more overhead.
   Reasonable but circular — you don't know revenue until the invoice is
   sent, which can be after the day in question. Also penalises jobs
   that haven't billed yet.
3. **Proportional to labour-hours-that-day.** What we picked. Operational
   reality maps directly: the day a worker is on Job 1090, AFGC's
   premises/admin/vehicles are supporting that job. Overhead naturally
   follows operational intensity.

## Edge cases

| Scenario | Rule |
|---|---|
| Day with zero labour anywhere (Saturday with no work) | Overhead for that day is **not allocated to jobs**; rolled into a `period_overhead_unallocated` bucket per entity. Surfaced in reports as "fixed cost on non-operational days." |
| Materials-only day (no labour but bills landed) | Overhead allocated to jobs whose labour was logged on the **most recent prior labour-active day**, weighted same way. Materials don't generate overhead allocation directly — labour does. |
| Day with labour but no jobs (training day, toolbox talk) | Overhead absorbed by the entity, not allocated to any job. Surfaced as "training/admin overhead" in reports. |
| Worker logged to two jobs same hour (data error) | Disallowed at insert time via overlap check on `wage_entries`. |
| Public holidays | Treated like Saturdays — no labour expected, overhead → period bucket. |
| Job cancelled mid-day | Hours logged that day still count for allocation. The job carries the overhead it consumed even if it never invoices. |

## Configuration

Per-organization `overhead_profiles` table:

```sql
CREATE TABLE overhead_profiles (
  id              UUID PRIMARY KEY,
  organization_id UUID NOT NULL,
  effective_from  DATE NOT NULL,
  daily_rate_cents BIGINT NOT NULL,
  components      JSONB NOT NULL,    -- breakdown for reporting
  ...
);
```

`components` looks like:

```json
{
  "rent_cents": 10000,
  "vehicle_lease_cents": 8000,
  "insurance_cents": 5000,
  "admin_wages_cents": 12000,
  "subscriptions_cents": 3000,
  "utilities_cents": 2000
}
```

Sum of components must equal `daily_rate_cents`. Validates at insert.

When the operator changes overhead (e.g. takes on a new lease), insert a
new row with a new `effective_from`. Allocation queries pick the row
where `effective_from ≤ date` AND no later effective_from exists.
Historical allocations don't recompute — they use the rate that was
true on that date.

## When does allocation actually run?

Two triggers:

1. **On-demand**, when a job's P&L is rendered. Compute on the fly from
   `wage_entries` + `overhead_profiles` joined by date. No background
   job, no stale data.
2. **Materialised** at job completion — computed once and frozen into
   `overhead_allocations` rows. After job close, the values don't change.

For active jobs, on-demand is fine. For closed jobs, materialised values
are the audit-trail source of truth.

## Out of scope for v1

- Activity-based costing (different overhead rates for different work
  types) — too much config for v1, deferred to v1.5.
- Per-employee overhead loading (allocating overhead by which worker
  was on the job, not just hours) — same.
- Variable overhead (busy season vs quiet season rates) — operator
  manually changes the rate via a new `effective_from` row when they
  want.

## Verification

Reconciliation test: for any period, `SUM(overhead_allocations.amount) +
SUM(period_overhead_unallocated.amount) = SUM(daily_rate × days)`.
Conservation property — every dollar of overhead is either allocated to
a job or sitting in the unallocated bucket.

Test in Phase 4 acceptance: pick AFGC's last completed job, verify
overhead share matches what Jaime would compute manually within 0.5%.

## Status

**Locked.**
