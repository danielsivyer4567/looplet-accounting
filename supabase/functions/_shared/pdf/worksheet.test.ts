// Deno test for the shared PDF helper (SC-3.D.01). Runs the real pdf-lib render
// path — the runtime look that `deno check` alone can't give. NOT a vitest file:
// vitest's include is tests/** + src/** only, and pdf-lib is imported from esm.sh
// (Deno-resolvable, not Node). Run with: `deno test supabase/functions/_shared/pdf/`.

import { renderWorksheetPdf } from "./worksheet.ts";

const PDF_MAGIC = "%PDF-";

Deno.test("renderWorksheetPdf returns a non-empty, valid PDF", async () => {
  const bytes = await renderWorksheetPdf({
    title: "Business Activity Statement - Worksheet",
    subtitle: "FY 2025-2026, Quarter 4 - DRAFT",
    sections: [
      {
        heading: "GST",
        caption: "From invoices and bills",
        rows: [
          { label: "1A   GST on sales", value: "$100.00" },
          { label: "1B   GST on purchases", value: "$50.00" },
        ],
      },
      { heading: "Summary", rows: [{ label: "9   Net amount", value: "$50.00" }] },
    ],
    footer: "Draft worksheet.",
  });

  if (bytes.length === 0) throw new Error("PDF is empty");
  const head = new TextDecoder().decode(bytes.slice(0, 5));
  if (head !== PDF_MAGIC) throw new Error(`expected %PDF- header, got ${JSON.stringify(head)}`);
});

Deno.test("renderWorksheetPdf paginates a long doc without throwing", async () => {
  const rows = Array.from({ length: 90 }, (_, i) => ({
    label: `Line item ${i + 1}`,
    value: `$${(i * 100).toFixed(2)}`,
  }));
  const bytes = await renderWorksheetPdf({
    title: "Long worksheet",
    sections: [{ heading: "Many rows", rows }],
  });
  if (bytes.length === 0) throw new Error("PDF is empty");
});
