# RUNBOOK — EPIC B (OCR → GST, fill the books)

Project: `dxoikltymmknxqpkpyhi` · Branch: `epic-b-fill-the-books`

## What shipped (code + live schema)

- **B1 — reliable OCR.** New `supabase/functions/_shared/ocr/anthropic.ts` (Claude vision +
  **native PDF** via `document` blocks, structured-output JSON schema). `ocr/index.ts` now
  defaults to the `anthropic` provider and **no longer stubs PDFs** for it. Model
  `claude-sonnet-4-6`, override with `ANTHROPIC_VISION_MODEL`.
- **B1 — GST capture.** `bills-extract` derives GST when the supplier didn't itemise it
  (AU 1/11 of the inclusive total, or total − subtotal), flagged `gst_estimated=true`.
  New column `bills.gst_estimated` (migration **0058**, applied live).
- **B2 — repair backfill.** `bills-extract-batch` gained `mode:"repair"` — re-OCRs any
  non-void bill missing amount/GST and bypasses the dedup cache (`force`).
- **B3 — BAS gate.** View `v_bas_gst_coverage` + function `bas_quarter_gst_ready()`
  (migration **0059**, applied live). BAS page shows a coverage banner + per-quarter %
  and warns before CSV export when a quarter is < 95% complete.

## You must do (CLI — needs your Supabase auth)

1. **Set the Anthropic key as an edge secret:**
   ```
   supabase secrets set ANTHROPIC_API_KEY=sk-ant-... --project-ref dxoikltymmknxqpkpyhi
   ```
   (Optional: `supabase secrets set ANTHROPIC_VISION_MODEL=claude-sonnet-4-6`)

   Until this is set, `OCR_PROVIDER` defaults to `anthropic` and extraction will error —
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
