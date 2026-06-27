// Deno test for the div7a-agreement generator (SC-5.F.01). Verifies the LOCALLY-testable
// half of the slice's smoke test: (1) the doc-builder lays out the complying-loan terms
// (parties, principal, term, rate, security) and the s109E schedule rows faithfully from
// the div7a_min_repayment output, and (2) the real pdf-lib render returns non-empty, valid
// PDF bytes. Imports the PURE builder from ./agreement.ts (not ./index.ts), so the test
// never boots the edge function's Deno.serve listener. The end-to-end HTTP smoke test
// (deploy -> invoke -> parse PDF text back) rides the deploy (this slice is held
// [blocked: needs deploy] per the autoloop policy).

import { money, ratePct, toAgreementDoc, type LoanRow, type ScheduleLine } from "./agreement.ts";
import { renderWorksheetPdf } from "../_shared/pdf/worksheet.ts";

const PDF_MAGIC = "%PDF-";

const loan7yr: LoanRow = {
  lender_company_name: "Acme Pty Ltd",
  lender_company_abn: "12 345 678 901",
  borrower_name: "Jane Shareholder",
  loan_year: 2024,
  principal_cents: 10_000_000, // $100,000.00
  term_years: 7,
  benchmark_rate_basis_points: 877, // 8.77%
  has_complying_agreement: true,
};

// A 3-row slice of a div7a_min_repayment schedule (shape per SC-5.E.02). period_label
// matches what the RPC emits: format('FY%s-%s', iy, iy+1) -> full 4-digit second year.
const schedule: ScheduleLine[] = [
  {
    income_year: 2025,
    period_label: "FY2025-2026",
    opening_balance_cents: 10_000_000,
    rate_basis_points: 877,
    min_repayment_cents: 1_950_000,
    interest_cents: 877_000,
    principal_cents: 1_073_000,
    closing_balance_cents: 8_927_000,
  },
  {
    income_year: 2026,
    period_label: "FY2026-2027",
    opening_balance_cents: 8_927_000,
    rate_basis_points: 877,
    min_repayment_cents: 1_950_000,
    interest_cents: 782_900,
    principal_cents: 1_167_100,
    closing_balance_cents: 7_759_900,
  },
  // rate_missing rows carry no period_label (RPC omits it) -> builder falls back to FYxxxx-yyyy.
  { income_year: 2027, rate_missing: true, opening_balance_cents: 7_759_900 },
];

function allValues(doc: ReturnType<typeof toAgreementDoc>): string[] {
  return doc.sections.flatMap((s) => s.rows.map((r) => `${r.label} = ${r.value}`));
}

Deno.test("money and ratePct format AU cents / basis points", () => {
  if (money(10_000_000) !== "$100,000.00") throw new Error(`money: got ${money(10_000_000)}`);
  if (ratePct(877) !== "8.77%") throw new Error(`ratePct: got ${ratePct(877)}`);
  if (ratePct(null) !== "n/a") throw new Error("ratePct(null) should be n/a");
});

Deno.test("agreement states the parties + complying terms", () => {
  const doc = toAgreementDoc(loan7yr, schedule);
  const flat = allValues(doc).join(" | ");

  // Parties (lender with ABN, borrower).
  if (!flat.includes("Acme Pty Ltd (ABN 12 345 678 901)")) throw new Error("lender+ABN missing");
  if (!flat.includes("Jane Shareholder")) throw new Error("borrower missing");

  // Complying terms: principal, term, rate.
  if (!flat.includes("$100,000.00")) throw new Error("principal missing");
  if (!flat.includes("7 years")) throw new Error("term missing");
  if (!flat.includes("8.77%")) throw new Error("rate missing");

  // 7-year loan => unsecured statement.
  if (!flat.toLowerCase().includes("unsecured")) throw new Error("7yr should be stated unsecured");
});

Deno.test("subtitle reflects has_complying_agreement (on record vs draft)", () => {
  // loan7yr has has_complying_agreement: true -> "agreement on record".
  const onRecord = toAgreementDoc(loan7yr, schedule);
  if (!onRecord.subtitle?.includes("agreement on record")) {
    throw new Error(`expected 'agreement on record'; got ${onRecord.subtitle}`);
  }
  // No complying agreement yet -> "DRAFT for execution".
  const draft = toAgreementDoc({ ...loan7yr, has_complying_agreement: false }, schedule);
  if (!draft.subtitle?.includes("DRAFT for execution")) {
    throw new Error(`expected 'DRAFT for execution'; got ${draft.subtitle}`);
  }
});

Deno.test("a 25-year loan is stated as secured by a registered mortgage", () => {
  const doc = toAgreementDoc({ ...loan7yr, term_years: 25 }, schedule);
  const flat = allValues(doc).join(" | ");
  if (!flat.toLowerCase().includes("registered mortgage")) {
    throw new Error("25yr should require a registered mortgage");
  }
  if (flat.toLowerCase().includes("unsecured")) throw new Error("25yr must not say unsecured");
});

Deno.test("the schedule section reflects the div7a_min_repayment rows", () => {
  const doc = toAgreementDoc(loan7yr, schedule);
  const sched = doc.sections.find((s) => s.heading.startsWith("Minimum yearly repayment"));
  if (!sched) throw new Error("schedule section missing");

  // Computed years carry the MYR + interest/principal split.
  const fy25 = sched.rows.find((r) => r.label === "FY2025-2026");
  if (!fy25) throw new Error("FY2025-2026 row missing");
  for (const part of ["$19,500.00", "int $8,770.00", "prin $10,730.00"]) {
    if (!fy25.value.includes(part)) throw new Error(`FY2025-2026 missing ${part}; got ${fy25.value}`);
  }

  // A rate_missing year renders gracefully (not a crash, not blank numbers); no period_label
  // on the row -> builder falls back to FY2027-2028.
  const fy27 = sched.rows.find((r) => r.label === "FY2027-2028");
  if (!fy27 || !fy27.value.includes("rate not set")) throw new Error("rate_missing year not handled");
});

Deno.test("the agreement renders to non-empty, valid PDF bytes", async () => {
  const bytes = await renderWorksheetPdf(toAgreementDoc(loan7yr, schedule));
  if (bytes.length === 0) throw new Error("PDF is empty");
  const head = new TextDecoder().decode(bytes.slice(0, 5));
  if (head !== PDF_MAGIC) throw new Error(`expected %PDF- header, got ${JSON.stringify(head)}`);
});
