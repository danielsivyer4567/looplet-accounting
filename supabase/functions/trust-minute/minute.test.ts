// Deno test for the trust-minute generator (SC-5.D.01). Verifies the LOCALLY-
// testable half of the slice's smoke test: (1) the doc-builder maps each DB
// distribution row's amounts/components faithfully into the rendered resolution, and
// (2) the real pdf-lib render path returns non-empty, valid PDF bytes. NOT a vitest
// file (pdf-lib is esm.sh / Deno-resolvable). Run: `deno test supabase/functions/trust-minute/`.
//
// Imports the PURE builder from ./minute.ts (not ./index.ts), so the test never boots
// the edge function's Deno.serve listener. The end-to-end HTTP smoke test (deploy ->
// invoke -> parse PDF text back) rides with the deploy (this slice is held
// [blocked: needs deploy] per the autoloop policy); the mapping logic that test would
// exercise is verified here against the pure doc-builder.

import { money, toMinuteDoc, type DistributionRow, type TrustRow } from "./minute.ts";
import { renderWorksheetPdf } from "../_shared/pdf/worksheet.ts";

const PDF_MAGIC = "%PDF-";

const trust: TrustRow = {
  name: "Smith Family Trust",
  trust_type: "discretionary",
  abn: "12 345 678 901",
  trustee_name: "Smith Holdings Pty Ltd",
  trustee_abn: "98 765 432 109",
  is_corporate_trustee: true,
};

const rows: DistributionRow[] = [
  {
    beneficiary_id: "aaaaaaaa-0000-0000-0000-000000000001",
    amount_cents: 20_000_000,
    capital_gain_cents: 4_000_000,
    franked_dividend_cents: 6_000_000,
    other_cents: 10_000_000,
    franking_credits_cents: 2_000_000,
    status: "draft",
    trust_beneficiaries: { name: "Alice Smith", beneficiary_type: "individual", relationship: "spouse" },
  },
  {
    beneficiary_id: "bbbbbbbb-0000-0000-0000-000000000002",
    amount_cents: 4_000_000,
    capital_gain_cents: 0,
    franked_dividend_cents: 0,
    other_cents: 4_000_000,
    franking_credits_cents: 0,
    status: "draft",
    trust_beneficiaries: { name: "Bob Smith", beneficiary_type: "individual", relationship: "child" },
  },
];

Deno.test("toMinuteDoc renders each beneficiary's components verbatim from the DB rows", () => {
  const doc = toMinuteDoc(trust, rows, 2024, true);

  // One section per beneficiary + a totals section.
  if (doc.sections.length !== rows.length + 1) {
    throw new Error(`expected ${rows.length + 1} sections, got ${doc.sections.length}`);
  }

  // Alice's section carries her exact component money strings.
  const alice = doc.sections.find((s) => s.heading === "Alice Smith");
  if (!alice) throw new Error("Alice section missing");
  const aliceValues = alice.rows.map((r) => r.value);
  for (const expected of [
    money(4_000_000), // capital gain
    money(6_000_000), // franked dividend
    money(2_000_000), // franking credits
    money(10_000_000), // other
    money(20_000_000), // total share
  ]) {
    if (!aliceValues.includes(expected)) {
      throw new Error(`Alice section missing value ${expected}; had ${JSON.stringify(aliceValues)}`);
    }
  }

  // Caption reflects beneficiary type + relationship (title-cased).
  if (alice.caption !== "Individual - Spouse") {
    throw new Error(`unexpected Alice caption: ${JSON.stringify(alice.caption)}`);
  }
});

Deno.test("toMinuteDoc totals are the exact column sums of the DB rows", () => {
  const doc = toMinuteDoc(trust, rows, 2024, true);
  const totals = doc.sections.find((s) => s.heading === "Resolution totals");
  if (!totals) throw new Error("totals section missing");
  const values = totals.rows.map((r) => r.value);

  // amount: 20m + 4m = 24m; cg: 4m; franked: 6m; credits: 2m; other: 14m.
  for (const expected of [
    money(4_000_000), // total cg
    money(6_000_000), // total franked
    money(2_000_000), // total credits
    money(14_000_000), // total other
    money(24_000_000), // total distributed
  ]) {
    if (!values.includes(expected)) {
      throw new Error(`totals missing ${expected}; had ${JSON.stringify(values)}`);
    }
  }
});

Deno.test("toMinuteDoc stamps DRAFT vs Resolved in the subtitle", () => {
  const draft = toMinuteDoc(trust, rows, 2024, true);
  if (!draft.subtitle?.includes("DRAFT")) throw new Error("draft subtitle not stamped DRAFT");

  const finalised = toMinuteDoc(trust, rows, 2024, false);
  if (finalised.subtitle?.includes("DRAFT")) throw new Error("finalised subtitle wrongly says DRAFT");
  if (!finalised.subtitle?.includes("Resolved")) throw new Error("finalised subtitle not Resolved");

  // Income year is the FY end (fy_start_year + 1).
  if (!draft.subtitle?.includes("30 June 2025")) throw new Error("wrong income year in subtitle");
});

Deno.test("toMinuteDoc falls back to beneficiary_id when the join is missing a name", () => {
  const orphan: DistributionRow[] = [{ ...rows[0], trust_beneficiaries: null }];
  const doc = toMinuteDoc(trust, orphan, 2024, true);
  const section = doc.sections.find((s) => s.heading === orphan[0].beneficiary_id);
  if (!section) throw new Error("expected a section headed by the beneficiary_id fallback");
});

Deno.test("the minute renders to non-empty, valid PDF bytes", async () => {
  const bytes = await renderWorksheetPdf(toMinuteDoc(trust, rows, 2024, true));
  if (bytes.length === 0) throw new Error("PDF is empty");
  const head = new TextDecoder().decode(bytes.slice(0, 5));
  if (head !== PDF_MAGIC) throw new Error(`expected %PDF- header, got ${JSON.stringify(head)}`);
});
