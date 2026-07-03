// Deno unit test for depreciation-run's pure logic (SC-1.G.02).
// Run: deno test supabase/functions/depreciation-run/logic.test.ts

import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { assetName, monthEndISO, resolveTargetDate, type ScheduleRow } from "./logic.ts";

Deno.test("monthEndISO: mid-year month", () => {
  assertEquals(monthEndISO(2026, 5), "2026-06-30"); // June (0-indexed 5)
});

Deno.test("monthEndISO: December rolls into next January cleanly", () => {
  assertEquals(monthEndISO(2026, 11), "2026-12-31");
});

Deno.test("monthEndISO: leap-year February", () => {
  assertEquals(monthEndISO(2028, 1), "2028-02-29");
});

Deno.test("monthEndISO: non-leap-year February", () => {
  assertEquals(monthEndISO(2026, 1), "2026-02-28");
});

Deno.test("resolveTargetDate: no period defaults to the previous calendar month", () => {
  const now = new Date(Date.UTC(2026, 6, 15)); // 2026-07-15
  assertEquals(resolveTargetDate(undefined, now), "2026-06-30");
});

Deno.test("resolveTargetDate: no period at a January clock rolls back into December of the prior year", () => {
  const now = new Date(Date.UTC(2026, 0, 3)); // 2026-01-03
  assertEquals(resolveTargetDate(undefined, now), "2025-12-31");
});

Deno.test("resolveTargetDate: explicit period resolves that period's month-end regardless of `now`", () => {
  const now = new Date(Date.UTC(2026, 6, 15));
  assertEquals(resolveTargetDate("2026-03-14", now), "2026-03-31");
});

Deno.test("resolveTargetDate: blank/whitespace period falls back to the default (previous month)", () => {
  const now = new Date(Date.UTC(2026, 6, 15));
  assertEquals(resolveTargetDate("   ", now), "2026-06-30");
});

Deno.test("resolveTargetDate: malformed period throws", () => {
  assertThrows(() => resolveTargetDate("not-a-date"), Error, "invalid period");
});

Deno.test("resolveTargetDate: out-of-range month throws", () => {
  assertThrows(() => resolveTargetDate("2026-13-01"), Error, "invalid period month");
});

Deno.test("assetName: single fixed_assets object", () => {
  const row: ScheduleRow = {
    id: "s1",
    organization_id: "org1",
    fixed_asset_id: "fa1",
    fixed_assets: { name: "Delivery Van" },
  };
  assertEquals(assetName(row), "Delivery Van");
});

Deno.test("assetName: array embed uses the first row", () => {
  const row: ScheduleRow = {
    id: "s1",
    organization_id: "org1",
    fixed_asset_id: "fa1",
    fixed_assets: [{ name: "Laptop" }],
  };
  assertEquals(assetName(row), "Laptop");
});

Deno.test("assetName: null embed yields null", () => {
  const row: ScheduleRow = {
    id: "s1",
    organization_id: "org1",
    fixed_asset_id: "fa1",
    fixed_assets: null,
  };
  assertEquals(assetName(row), null);
});

Deno.test("assetName: empty array embed yields null", () => {
  const row: ScheduleRow = {
    id: "s1",
    organization_id: "org1",
    fixed_asset_id: "fa1",
    fixed_assets: [],
  };
  assertEquals(assetName(row), null);
});
