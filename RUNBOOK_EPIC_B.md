# RUNBOOK — EPIC B (OCR → GST, fill the books)

Project: `dxoikltymmknxqpkpyhi` · Branch: `epic-b-fill-the-books`

## What shipped (code + live schema)

- **B1 — reliable OCR.** New `supabase/functions/_shared/ocr/minimax.ts` (MiniMax-M3 vision,
  OpenAI-compatible). `ocr/index.ts` defaults to the `minimax` provider. Model `MiniMax-M3`,
  override with `MINIMAX_VISION_MODEL`.
  - **PDFs:** `pdfRasterize.ts` (MuPDF.js WASM) renders the PDF's first page to a PNG, which
    MiniMax then OCRs — works for **born-digital AND scanned** PDFs. Born-digital PDFs still
    take the cheap text-layer path first; only those that fail fall through to rasterize+vision.
    Corrupt/encrypted PDFs that can't render fall back to the manual-entry stub. `anthropic.ts`
    (Claude, native PDF) also remains available via `OCR_PROVIDER=anthropic`.
- **B1 — GST capture.** `bills-extract` derives GST when the supplier didn't itemise it
  (AU 1/11 of the inclusive total, or total − subtotal), flagged `gst_estimated=true`.
  New column `bills.gst_estimated` (migration **0058**, applied live).
- **B2 — repair backfill.** `bills-extract-batch` gained `mode:"repair"` — re-OCRs any
  non-void bill missing amount/GST and bypasses the dedup cache (`force`).
- **B3 — BAS gate.** View `v_bas_gst_coverage` + function `bas_quarter_gst_ready()`
  (migration **0059**, applied live). BAS page shows a coverage banner + per-quarter %
  and warns before CSV export when a quarter is < 95% complete.

## You must do (CLI — needs your Supabase auth)

1. **Set the MiniMax key as an edge secret:**

   ```
   supabase secrets set MINIMAX_API_KEY=... --project-ref dxoikltymmknxqpkpyhi
   ```

   (Optional: `supabase secrets set MINIMAX_VISION_MODEL=MiniMax-M3`)

   Until this is set, `OCR_PROVIDER` defaults to `minimax` and extraction will error —
   so set the key **before** the deploy below goes live to intake.

## Then (Claude can run these once the key is set)

2. **Deploy the functions** (`bills-extract`, `bills-extract-batch` — they bundle `_shared/ocr`).
3. **Smoke test one bill** through `bills-extract` and confirm amount + GST land.
4. **Run the repair backfill** in a loop until `remaining = 0`:
   ```
   POST /functions/v1/bills-extract-batch
   { "organization_id": "<org>", "mode": "repair", "max": 20, "delay_ms": 1500 }
   ```
5. **Verify coverage** climbs in `v_bas_gst_coverage` (target: ≥95% `gst_ready`).

## Done when

`v_bas_gst_coverage.gst_ready` is true for active quarters (≥95% of bills carry amount+GST)
and the BAS page shows real figures with no provisional banner.
