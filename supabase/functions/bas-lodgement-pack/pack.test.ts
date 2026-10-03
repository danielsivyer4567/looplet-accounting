// Tests for the BAS lodgement pack pure builders.
//
// Run: deno test supabase/functions/bas-lodgement-pack/pack.test.ts

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { renderWorksheetPdf } from "../_shared/pdf/worksheet.ts";
import {
  basLodgementFilename,
  buildBasLodgementBundle,
  type BasLodgementRow,
  requiredBasTotalsPresent,
  toBase64,
  toBasLodgementWorksheetDoc,
} from "./pack.ts";

const row: BasLodgementRow = {
  id: "7bd6a947-7664-4c10-bc52-f4da80b7f234",
  organization_id: "9d5c9b9a-a576-458d-913a-fa822d33320d",
  lodgement_type: "bas",
  period_label: "Q4 FY2025-26",
  payload_hash: "abcdef1234567890",
  payload: {
    fy_start_year: 2025,
    quarter: 4,
    quarter_start: "2026-04-01",
    quarter_end: "2026-06-30",
    due_date: "2026-07-28",
    gst: {
      G1: 110000,
      G10: 55000,
      G11: 22000,
      "1A": 10000,
      "1B": 7000,
    },
    payg_withholding: {
      W1: 800000,
      W2: 144000,
      W4: 0,
      W5: 144000,
      "4": 144000,
    },
    payg_instalment: {
      T7: 0,
      "5A": 0,
      "5B": 0,
    },
    summary: {
      "9_net_amount_cents": 147000,
    },
  },
  ato_receipt_id: null,
  status: "draft",
  submitted_at: null,
  response: {},
  error_message: null,
  created_at: "2026-07-02T00:00:00Z",
  updated_at: "2026-07-02T00:00:00Z",
  created_by: "user-1",
};

Deno.test("requiredBasTotalsPresent requires the BAS GST and net labels", () => {
  assertEquals(requiredBasTotalsPresent(row.payload), true);
  assertEquals(requiredBasTotalsPresent({ ...row.payload, summary: {} }), false);
});

Deno.test("buildBasLodgementBundle marks BAS draft pack complete without transmission", () => {
  const bundle = buildBasLodgementBundle(row, "2026-07-02T01:00:00Z");

  assertEquals(bundle.complete, true);
  assertEquals(bundle.lodgement_id, row.id);
  assertEquals(bundle.checks.is_bas_lodgement, true);
  assertEquals(bundle.checks.has_payload_hash, true);
  assertEquals(bundle.checks.has_required_bas_totals, true);
  assertEquals(bundle.checks.ato_transmission_included, false);
  assertEquals(bundle.checks.human_declaration_required, true);
});

Deno.test("toBasLodgementWorksheetDoc renders identity, BAS totals, and guardrails", () => {
  const bundle = buildBasLodgementBundle(row, "2026-07-02T01:00:00Z");
  const doc = toBasLodgementWorksheetDoc(row, bundle);

  assertEquals(doc.title, "Business Activity Statement - Lodgement Pack");
  assertStringIncludes(doc.subtitle ?? "", "NOT LODGED");
  assert(doc.sections.some((section) => section.heading === "Lodgement identity"));
  assert(doc.sections.some((section) => section.heading === "GST"));
  assert(doc.sections.some((section) => section.heading === "Guardrails"));
});

Deno.test("BAS lodgement pack PDF renders to non-empty valid PDF bytes", async () => {
  const bundle = buildBasLodgementBundle(row, "2026-07-02T01:00:00Z");
  const bytes = await renderWorksheetPdf(toBasLodgementWorksheetDoc(row, bundle));

  assert(bytes.length > 0);
  assertEquals(new TextDecoder().decode(bytes.slice(0, 5)), "%PDF-");
  assert(toBase64(bytes).length > 0);
});

Deno.test("basLodgementFilename is stable and filesystem-safe", () => {
  assertEquals(
    basLodgementFilename({ ...row, period_label: "Q4 FY2025/26 !@#" }),
    "bas-lodgement-pack-Q4-FY2025-26-7bd6a947.pdf",
  );
});

Deno.test("W3/W4 Looplet does not record are shown as blank, not $0.00", () => {
  const blankRow: BasLodgementRow = {
    ...row,
    payload: {
      ...row.payload,
      gst_accounting_basis: "cash",
      payg_withholding: { W1: 0, W2: 0, W3: null, W4: null, W5: 0, "4": 0 },
      payg_instalment: { T7: null, "5A": null, "5B": null, source_status: "missing" },
    },
  };
  const doc = toBasLodgementWorksheetDoc(blankRow, buildBasLodgementBundle(blankRow, "2026-07-02T01:00:00Z"));
  const rows = doc.sections.flatMap((section) => section.rows);
  const value = (prefix: string) => rows.find((r) => r.label.startsWith(prefix))?.value;

  assertEquals(value("W3"), "Not recorded in Looplet (blank)");
  assertEquals(value("W4"), "Not recorded in Looplet (blank)");
  assertEquals(value("5A"), "Not entered");
  assertEquals(value("W1"), "$0.00");
  assertStringIncludes(doc.sections.find((s) => s.heading === "GST")?.caption ?? "", "cash basis");
});
