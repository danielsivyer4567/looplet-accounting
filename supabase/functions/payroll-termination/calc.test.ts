// Deno unit test for the termination/ETP calc (SC-3.L.01).
// Run: deno test supabase/functions/payroll-termination/calc.test.ts
//
// Pins the tax MECHANICS on hand-computed fixtures — genuine redundancy vs
// resignation, the whole-of-income cap, the above-cap top rate, and the
// preservation-age rate. Uses explicit constants so the assertions are
// independent of the annually-indexed defaults.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  calculateTermination,
  type TerminationInput,
  type TerminationTaxConstants,
} from "./calc.ts";

const K: TerminationTaxConstants = {
  redundancy_base_cents: 1_252_400, // $12,524
  redundancy_per_year_cents: 626_400, // $6,264
  etp_cap_cents: 24_500_000, // $245,000
  whole_of_income_cap_cents: 18_000_000, // $180,000
  etp_rate_under_preservation: 0.32,
  etp_rate_at_preservation: 0.17,
  etp_rate_above_cap: 0.47,
  leave_rate_concessional: 0.32,
};

const base: TerminationInput = {
  reason: "resignation",
  years_of_service: 10,
  at_or_above_preservation_age: false,
  unused_annual_leave_cents: 2_000_000, // $20,000
  unused_long_service_leave_cents: 1_000_000, // $10,000
  redundancy_or_severance_cents: 0,
  etp_other_cents: 0,
  other_taxable_income_cents: 9_000_000, // $90,000
  leave_marginal_rate: 0.345, // 32.5% + 2%
  constants: K,
};

Deno.test("genuine redundancy: tax-free cap + excluded ETP + concessional leave", () => {
  const res = calculateTermination({
    ...base,
    reason: "genuine_redundancy",
    redundancy_or_severance_cents: 10_000_000, // $100,000
  });
  // tax-free cap = 1,252,400 + 626,400*10 = 7,516,400
  assertEquals(res.redundancy_tax_free_cap_cents, 7_516_400);
  assertEquals(res.redundancy_tax_free_cents, 7_516_400);
  // excess 2,483,600 is an EXCLUDED ETP → ETP cap only (whole-of-income cap ignored)
  assertEquals(res.is_excluded_etp, true);
  assertEquals(res.etp_taxable_cents, 2_483_600);
  assertEquals(res.etp_applicable_cap_cents, 24_500_000);
  assertEquals(res.etp_above_cap_cents, 0);
  assertEquals(res.etp_tax_cents, Math.round(2_483_600 * 0.32)); // 794,752
  // unused leave taxed at the concessional flat rate, NOT the marginal rate
  assertEquals(res.unused_leave_rate, 0.32);
  assertEquals(res.unused_leave_tax_cents, 960_000); // 3,000,000 * 0.32
  assertEquals(res.total_tax_cents, 794_752 + 960_000);
  assertEquals(res.net_cents, 13_000_000 - (794_752 + 960_000));
});

Deno.test("resignation: no tax-free, marginal leave, non-excluded ETP within WOI cap", () => {
  const res = calculateTermination({
    ...base,
    reason: "resignation",
    etp_other_cents: 5_000_000, // $50,000 golden handshake
  });
  assertEquals(res.is_excluded_etp, false);
  assertEquals(res.redundancy_tax_free_cents, 0);
  assertEquals(res.etp_taxable_cents, 5_000_000);
  // non-excluded → lesser of ETP cap and (WOI cap - other income) = min(245k, 90k) = 90k
  assertEquals(res.etp_applicable_cap_cents, 9_000_000);
  assertEquals(res.etp_within_cap_cents, 5_000_000);
  assertEquals(res.etp_above_cap_cents, 0);
  assertEquals(res.etp_tax_cents, 1_600_000); // 5,000,000 * 0.32
  // unused leave at the MARGINAL rate (not concessional)
  assertEquals(res.unused_leave_rate, 0.345);
  assertEquals(res.unused_leave_tax_cents, 1_035_000); // 3,000,000 * 0.345
});

Deno.test("resignation: ETP above the whole-of-income cap taxed at the top rate", () => {
  const res = calculateTermination({
    ...base,
    reason: "resignation",
    etp_other_cents: 5_000_000,
    other_taxable_income_cents: 17_000_000, // $170,000 → WOI remaining 10,000 → 1,000,000c
  });
  assertEquals(res.etp_applicable_cap_cents, 1_000_000);
  assertEquals(res.etp_within_cap_cents, 1_000_000);
  assertEquals(res.etp_above_cap_cents, 4_000_000);
  // within cap @32% + above cap @47%
  assertEquals(res.etp_tax_cents, Math.round(1_000_000 * 0.32) + Math.round(4_000_000 * 0.47)); // 2,200,000
});

Deno.test("at/above preservation age: within-cap ETP taxed at the lower rate", () => {
  const res = calculateTermination({
    ...base,
    reason: "resignation",
    etp_other_cents: 5_000_000,
    at_or_above_preservation_age: true,
  });
  assertEquals(res.etp_within_cap_rate, 0.17);
  assertEquals(res.etp_tax_cents, 850_000); // 5,000,000 * 0.17
});
