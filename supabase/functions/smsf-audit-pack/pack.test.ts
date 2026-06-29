// Tests for the smsf-audit-pack pure builders (SC-5.M.01).
// Covers the deploy-gated edge fn's testable core: section completeness + that the PDF face
// reflects the bundle's figures (the "bundle contains each required section and totals match"
// smoke assertion, run against a synthetic bundle). The deploy->invoke->section-check end-to-end
// test rides the live deploy.
//
// Run: deno test supabase/functions/smsf-audit-pack/pack.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type AuditPackBundle,
  buildReconciliations,
  isComplete,
  money,
  REQUIRED_SECTIONS,
  sectionsPresent,
  toAuditPackDoc,
  toBase64,
} from "./pack.ts";

/** A complete synthetic bundle with known, internally-consistent figures (so reconciliations tie). */
function fullBundle(): AuditPackBundle {
  return {
    organization_id: "11111111-1111-1111-1111-111111111111",
    fund_id: "22222222-2222-2222-2222-222222222222",
    fy_start_year: 2024,
    operating_statement: {
      ok: true,
      assessable_income_cents: 5000000,
      income_tax_cents: 750000,
      net_result_cents: 4250000,
    },
    financial_position: {
      ok: true,
      assets: { total_assets_cents: 80000000 },
      liabilities_cents: 1000000,
      members_funds_cents: 79000000, // 80,000,000 - 1,000,000
    },
    member_statements: {
      ok: true,
      members: [
        { member_id: "m1", name: "Alice", closing_balance_cents: 40000000 },
        { member_id: "m2", name: "Bob", closing_balance_cents: 39000000 }, // sum 79,000,000
      ],
    },
    contribution_caps: {
      ok: true,
      totals: { members_over_concessional: 1, members_over_non_concessional: 0, members_div293: 1 },
    },
    pension_drawdown: {
      ok: true,
      totals: { pension_count: 2, under_minimum_count: 1, total_required_minimum_cents: 5000000 },
    },
    investments: [
      { name: "BHP shares", asset_class: "listed_shares", units: 1000, cost_base_cents: 40000000, market_value_cents: 50000000, acquisition_date: "2020-07-01" },
      { name: "Cash at bank", asset_class: "cash", units: null, cost_base_cents: 30000000, market_value_cents: 30000000, acquisition_date: null }, // market value sum 80,000,000
    ],
    reconciliations: [],
  };
}

Deno.test("money formats cents as AUD with two decimals", () => {
  assertEquals(money(123456), "$1,234.56");
  assertEquals(money(0), "$0.00");
  assertEquals(money(null), "$0.00");
  assertEquals(money(undefined), "$0.00");
});

Deno.test("isComplete + sectionsPresent: full bundle is complete", () => {
  const b = fullBundle();
  assert(isComplete(b), "full bundle should be complete");
  const present = sectionsPresent(b);
  for (const key of REQUIRED_SECTIONS) {
    assertEquals(present[key], true, `${key} should be present`);
  }
});

Deno.test("isComplete: a missing section makes the pack incomplete and is flagged", () => {
  const b = fullBundle();
  b.financial_position = null; // auditor must not get a pack missing the SoFP
  assert(!isComplete(b), "bundle missing financial_position should be incomplete");
  const present = sectionsPresent(b);
  assertEquals(present.financial_position, false);
  assertEquals(present.operating_statement, true); // others unaffected
});

Deno.test("buildReconciliations: a consistent bundle ties on all three checks", () => {
  const recs = buildReconciliations(fullBundle());
  assertEquals(recs.length, 3);
  for (const r of recs) {
    assertEquals(r.reconciles, true, `"${r.label}" should reconcile`);
    assertEquals(r.difference_cents, 0);
  }
});

Deno.test("buildReconciliations: an out-of-balance figure is flagged with the difference", () => {
  const b = fullBundle();
  // Break the balance sheet: members' funds no longer equals assets - liabilities.
  (b.financial_position as Record<string, unknown>).members_funds_cents = 78000000;
  const recs = buildReconciliations(b);
  const sheet = recs.find((r) => r.label.startsWith("Assets less liabilities"));
  assert(sheet, "balance-sheet tie should exist");
  assertEquals(sheet.reconciles, false);
  assertEquals(sheet.difference_cents, 1000000); // (80,000,000 - 1,000,000) - 78,000,000
  // The members-funds-vs-statements tie also breaks (78,000,000 vs 79,000,000 closing total).
  const roll = recs.find((r) => r.label.startsWith("Members' funds (SoFP)"));
  assertEquals(roll?.reconciles, false);
});

Deno.test("toAuditPackDoc: every section renders with the bundle's totals", () => {
  const bundle = fullBundle();
  bundle.reconciliations = buildReconciliations(bundle);
  const doc = toAuditPackDoc(bundle);
  assertEquals(doc.title, "SMSF Audit Pack");
  assert(doc.subtitle?.includes("30 June 2025"), "subtitle shows the year ended");

  const headings = doc.sections.map((s) => s.heading);
  for (
    const h of [
      "Operating statement",
      "Statement of financial position",
      "Member balances",
      "Investment evidence",
      "Reconciliations",
      "Compliance flags",
    ]
  ) {
    assert(headings.includes(h), `doc should contain the "${h}" section`);
  }

  // Totals match the bundle (the smoke "totals match" assertion against a synthetic source).
  const flat = doc.sections.flatMap((s) => s.rows);
  const find = (label: string) => flat.find((r) => r.label === label)?.value;
  assertEquals(find("Total assessable income"), "$50,000.00");
  assertEquals(find("Income tax"), "$7,500.00");
  assertEquals(find("Total assets (market value)"), "$800,000.00");
  assertEquals(find("Members' funds"), "$790,000.00");
  // Member lines reflect each member's closing balance.
  assertEquals(find("Alice"), "$400,000.00");
  assertEquals(find("Bob"), "$390,000.00");
  // Investment evidence: one line per holding at market value, asset class in the label.
  assertEquals(find("BHP shares (listed_shares)"), "$500,000.00");
  assertEquals(find("Cash at bank (cash)"), "$300,000.00");
  // Reconciliations all agree for the consistent bundle.
  assert(flat.some((r) => r.label.startsWith("OK -") && r.value === "agrees"), "ties shown as agreeing");
  // Compliance counts come straight from the caps/drawdown totals.
  assertEquals(find("Members over the concessional cap"), "1");
  assertEquals(find("Members subject to Div 293"), "1");
  assertEquals(find("Pensions under the minimum drawdown"), "1");
});

Deno.test("toAuditPackDoc: tolerates null sections (renders zeros, no member/evidence lines)", () => {
  const b = fullBundle();
  b.operating_statement = null;
  b.financial_position = null;
  b.member_statements = null;
  b.contribution_caps = null;
  b.pension_drawdown = null;
  b.investments = [];
  b.reconciliations = [];
  const doc = toAuditPackDoc(b);
  const headings = doc.sections.map((s) => s.heading);
  // The two financial sections + compliance flags always render; member/evidence/recon only when present.
  assert(headings.includes("Operating statement"));
  assert(headings.includes("Compliance flags"));
  assert(!headings.includes("Member balances"), "no member section when members are absent");
  assert(!headings.includes("Investment evidence"), "no evidence section when no holdings");
  assert(!headings.includes("Reconciliations"), "no recon section when none built");
  const flat = doc.sections.flatMap((s) => s.rows);
  assertEquals(flat.find((r) => r.label === "Income tax")?.value, "$0.00");
  assertEquals(flat.find((r) => r.label === "Members subject to Div 293")?.value, "0");
});

Deno.test("toBase64 round-trips bytes", () => {
  const bytes = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
  assertEquals(toBase64(bytes), "SGVsbG8=");
});
