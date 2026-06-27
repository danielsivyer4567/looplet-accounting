// Tests for the working-papers pure bundle builders (SC-7.G.02).
//
// Run: deno test supabase/functions/working-papers/bundle.test.ts

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { renderWorksheetPdf } from "../_shared/pdf/worksheet.ts";
import {
  buildWorkingPapersBundle,
  collectSourceFileRefs,
  money,
  type ResolvedSourceFile,
  toBase64,
  toWorkingPapersIndexDoc,
} from "./bundle.ts";

function manifestFixture(ok = true): Record<string, unknown> {
  return {
    ok,
    organization_id: "11111111-1111-1111-1111-111111111111",
    period_start: "2026-01-01",
    period_end: "2026-01-31",
    checks: {
      period_closed: { passed: true },
      reconciliation_complete: {
        passed: ok,
        reconciled_count: 2,
        unreconciled_count: ok ? 0 : 1,
      },
      period_journals: { journal_count: 2 },
    },
    manifest: {
      reconciliation_set: [
        {
          id: "bt-bill",
          posted_at: "2026-01-05T00:00:00Z",
          description: "Supplier bill",
          amount_cents: -11000,
          source_document: {
            type: "bill",
            id: "bill-1",
            invoice_number: "BILL-1",
            storage_key: "org-1/2026-01-05/bill.pdf",
            original_filename: "bill.pdf",
          },
        },
        {
          id: "bt-invoice",
          posted_at: "2026-01-09T00:00:00Z",
          description: "Customer receipt",
          amount_cents: 22000,
          source_document: {
            type: "invoice",
            id: "inv-1",
            invoice_number: "INV-1",
          },
        },
      ],
      period_journals: [
        {
          id: "je-1",
          entry_date: "2026-01-05",
          memo: "Accrual",
          status: "posted",
        },
        {
          id: "je-2",
          entry_date: "2026-01-31",
          memo: "Month end",
          status: "posted",
        },
      ],
      schedules: {
        trial_balance: [
          { account_code: "1000", account_name: "Cash", net_cents: 22000 },
          { account_code: "2000", account_name: "Payables", net_cents: -11000 },
        ],
      },
      receipt_audit_packages: [
        {
          id: "rap-1",
          storage_key:
            "receipt-hub/11111111-1111-1111-1111-111111111111/receipt.json",
        },
      ],
      audit_log: [
        {
          table_name: "bank_transactions",
          operation: "INSERT",
          record_id: "bt-bill",
          occurred_at: "2026-01-05T01:00:00Z",
        },
      ],
    },
  };
}

function resolvedFiles(): ResolvedSourceFile[] {
  return collectSourceFileRefs(manifestFixture()).map((ref) => ({
    ...ref,
    resolved: true,
    signed_url: `https://signed.example/${encodeURIComponent(ref.storage_key)}`,
    expires_in_seconds: 3600,
    error: null,
  }));
}

Deno.test("money formats cents as AUD", () => {
  assertEquals(money(123456), "$1,234.56");
  assertEquals(money(null), "$0.00");
});

Deno.test("collectSourceFileRefs finds every manifest storage link once", () => {
  const refs = collectSourceFileRefs(manifestFixture());
  assertEquals(refs.map((ref) => ref.storage_key), [
    "org-1/2026-01-05/bill.pdf",
    "receipt-hub/11111111-1111-1111-1111-111111111111/receipt.json",
  ]);
  assertEquals(refs[0].source, "reconciliation:bill");
  assertEquals(refs[0].original_filename, "bill.pdf");
});

Deno.test("buildWorkingPapersBundle is complete when manifest is ok and every link resolves", () => {
  const bundle = buildWorkingPapersBundle(
    manifestFixture(),
    resolvedFiles(),
    "2026-02-01T00:00:00Z",
  );
  assert(bundle.complete, "bundle should be complete");
  assertEquals(bundle.checks.manifest_ok, true);
  assertEquals(bundle.checks.source_files_resolved, true);
  assertEquals(bundle.checks.unresolved_source_file_count, 0);
  assertEquals(bundle.source_files.length, 2);
});

Deno.test("buildWorkingPapersBundle flags a missing linked source file", () => {
  const files = resolvedFiles();
  files[1] = {
    ...files[1],
    resolved: false,
    signed_url: null,
    error: "Object not found",
  };
  const bundle = buildWorkingPapersBundle(
    manifestFixture(),
    files,
    "2026-02-01T00:00:00Z",
  );
  assert(
    !bundle.complete,
    "bundle with an unresolved source file must not be complete",
  );
  assertEquals(bundle.checks.source_files_resolved, false);
  assertEquals(bundle.checks.unresolved_source_file_count, 1);
});

Deno.test("buildWorkingPapersBundle flags an incomplete manifest even when links resolve", () => {
  const bundle = buildWorkingPapersBundle(
    manifestFixture(false),
    resolvedFiles(),
    "2026-02-01T00:00:00Z",
  );
  assert(
    !bundle.complete,
    "incomplete manifest must not become complete through resolved links",
  );
  assertEquals(bundle.checks.manifest_ok, false);
});

Deno.test("toWorkingPapersIndexDoc renders the bundle contents", () => {
  const bundle = buildWorkingPapersBundle(
    manifestFixture(),
    resolvedFiles(),
    "2026-02-01T00:00:00Z",
  );
  const doc = toWorkingPapersIndexDoc(bundle);
  assertEquals(doc.title, "Working Papers Index");
  assert(
    doc.subtitle?.includes("COMPLETE"),
    "subtitle should show complete status",
  );

  const headings = doc.sections.map((section) => section.heading);
  for (
    const heading of [
      "Bundle status",
      "Close and reconciliation checks",
      "Reconciliation set",
      "Period journals",
      "Trial balance schedule",
      "Source files",
      "Audit-log evidence",
    ]
  ) {
    assert(headings.includes(heading), `doc should contain ${heading}`);
  }

  const rows = doc.sections.flatMap((section) => section.rows);
  assert(
    rows.some((row) =>
      row.label.includes("Supplier bill") && row.value.includes("BILL-1")
    ),
  );
  assert(
    rows.some((row) => row.label === "bill.pdf" && row.value === "resolved"),
  );
  assert(
    rows.some((row) =>
      row.label.includes("1000 Cash") && row.value === "$220.00"
    ),
  );
});

Deno.test("working-papers PDF smoke: non-empty PDF over resolved source-file links", async () => {
  const bundle = buildWorkingPapersBundle(
    manifestFixture(),
    resolvedFiles(),
    "2026-02-01T00:00:00Z",
  );
  const pdf = await renderWorksheetPdf(toWorkingPapersIndexDoc(bundle));
  assert(pdf.length > 0, "PDF should be non-empty");
  assertEquals(new TextDecoder().decode(pdf.slice(0, 5)), "%PDF-");
  assert(toBase64(pdf).length > 0, "bundle PDF base64 should be non-empty");
  assert(
    bundle.source_files.every((file) => file.resolved && file.signed_url),
    "every manifest link resolves",
  );
});
