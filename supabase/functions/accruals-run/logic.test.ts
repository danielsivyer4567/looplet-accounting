// Deno unit test for accruals-run's pure logic (SC-1.I.03).
// Run: deno test supabase/functions/accruals-run/logic.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { CADENCE_PERIODS, planAccrualJobs, type RecurringSeries } from "./logic.ts";

function series(cadence: string, billIds: string[]): RecurringSeries {
  return { cadence, bill_ids: billIds };
}

Deno.test("planAccrualJobs: quarterly series produces a job for its most-recent bill", () => {
  const plan = planAccrualJobs([series("quarterly", ["b1", "b2", "b3"])]);
  assertEquals(plan.jobs, [{ billId: "b3", periods: 3 }]);
  assertEquals(plan.skippedShortCadence, 0);
});

Deno.test("planAccrualJobs: semi_annual and yearly both qualify with their own period counts", () => {
  const plan = planAccrualJobs([
    series("semi_annual", ["b1"]),
    series("yearly", ["b2"]),
  ]);
  assertEquals(plan.jobs, [
    { billId: "b1", periods: 6 },
    { billId: "b2", periods: 12 },
  ]);
  assertEquals(plan.skippedShortCadence, 0);
});

Deno.test("planAccrualJobs: monthly/fortnightly/weekly cadences are all skipped (no real spread)", () => {
  const plan = planAccrualJobs([
    series("monthly", ["b1"]),
    series("fortnightly", ["b2"]),
    series("weekly", ["b3"]),
  ]);
  assertEquals(plan.jobs, []);
  assertEquals(plan.skippedShortCadence, 3);
});

Deno.test("planAccrualJobs: unknown cadence is skipped like a short cadence", () => {
  const plan = planAccrualJobs([series("bi_monthly", ["b1"])]);
  assertEquals(plan.jobs, []);
  assertEquals(plan.skippedShortCadence, 1);
});

Deno.test("planAccrualJobs: a qualifying series with no bills produces no job and is not counted as skipped", () => {
  const plan = planAccrualJobs([series("quarterly", [])]);
  assertEquals(plan.jobs, []);
  assertEquals(plan.skippedShortCadence, 0);
});

Deno.test("planAccrualJobs: mixed series only accrue the qualifying ones", () => {
  const plan = planAccrualJobs([
    series("quarterly", ["q1", "q2"]),
    series("monthly", ["m1"]),
    series("yearly", ["y1"]),
  ]);
  assertEquals(plan.jobs, [
    { billId: "q2", periods: 3 },
    { billId: "y1", periods: 12 },
  ]);
  assertEquals(plan.skippedShortCadence, 1);
});

Deno.test("planAccrualJobs: empty input yields an empty plan", () => {
  const plan = planAccrualJobs([]);
  assertEquals(plan.jobs, []);
  assertEquals(plan.skippedShortCadence, 0);
});

Deno.test("CADENCE_PERIODS: mapping matches the documented cadence -> period-count contract", () => {
  assertEquals(CADENCE_PERIODS, {
    yearly: 12,
    semi_annual: 6,
    quarterly: 3,
    monthly: 1,
    fortnightly: 1,
    weekly: 1,
  });
});
