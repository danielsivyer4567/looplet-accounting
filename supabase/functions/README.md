# Edge Functions

Deno-runtime functions deployed to Supabase. Each lives in its own folder
with `index.ts`. Shared modules live under `_shared/`.

## Functions

| Function | Status | Purpose |
|---|---|---|
| `bills-extract` | ✅ wired | OCR an uploaded bill, persist extracted fields |
| `bills-attach` | 🟡 wired, Xero stub | Attach a bill to a job + push to Xero ACCPAY |
| `xero-oauth-start` | 🟡 stub | Build the Xero OAuth authorize URL |
| `xero-oauth-callback` | ❌ not implemented | Token exchange + tenant fetch + encrypted store |

## Shared modules (`_shared/`)

- `cors.ts` — CORS headers + OPTIONS preflight
- `ocr/` — provider-agnostic OCR (Groq, OpenAI; Kimi/Anthropic stub)
  - `prompt.ts` — extraction prompt + JSON parser
  - `groq.ts` — Llama 4 Scout adapter (default for v1)
  - `openai.ts` — gpt-4o adapter
  - `index.ts` — provider router via `OCR_PROVIDER` env
- `xero/adapter.ts` — `pushBillToXero()` skeleton; stub mode operational

## Deploy

```bash
# Link to project (one-time)
supabase link --project-ref dxoikltymmknxqpkpyhi

# Deploy all functions
supabase functions deploy

# Or one at a time
supabase functions deploy bills-extract
supabase functions deploy bills-attach
```

## Required env (set in Supabase dashboard → Edge Functions → Secrets)

```
SUPABASE_URL                 # auto-set by Supabase
SUPABASE_ANON_KEY            # auto-set
SUPABASE_SERVICE_ROLE_KEY    # auto-set

OCR_PROVIDER=groq
GROQ_API_KEY=
GROQ_VISION_MODEL=meta-llama/llama-4-scout-17b-16e-instruct

OPENAI_API_KEY=              # fallback / alternative
OPENAI_VISION_MODEL=gpt-4o

XERO_CLIENT_ID=
XERO_CLIENT_SECRET=
XERO_STUB_MODE=true          # set false when adapter.ts is fully implemented (Phase 3)

ENCRYPTION_KEY=              # 32-char key for encrypting at-rest tokens
```

## Known limitations (v1)

1. **No PDF support yet.** Loopletnumero used `pdftoppm` (poppler) which
   isn't available in Deno edge functions. Phase 3.1 picks a path:
   pdfjs-dist + offscreen canvas in the function, OR browser-side PDF→PNG
   before upload. Until then `bills-extract` returns 400 for PDF mime types.
2. **Xero adapter stubbed.** `_shared/xero/adapter.ts` returns `STUB-XXXX`
   when `XERO_STUB_MODE=true`. Real implementation in Phase 3 ports the
   working logic from `Loopletnumero/backend/src/services/accounting/XeroAdapter.ts`.
3. **No PO matching, no PCR.** Loopletnumero's `services/po/poMatching.ts`
   and `services/pcr/projectCostReconciliation.ts` are not yet ported.
   Phase 3 + Phase 4 of `docs/ROADMAP.md`.
4. **No Gmail Pub/Sub inbound.** `bills-ingest-email` not yet created.
   Loopletnumero's `controllers/gmailInbound.controller.ts` is the port
   target. Phase 6 of the original Loopletnumero plan; deferrable past v1.
