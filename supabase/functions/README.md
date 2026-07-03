# Edge Functions

Deno-runtime functions deployed to Supabase. Each lives in its own folder
with `index.ts`. Shared modules live under `_shared/`.

## Functions

| Function | Status | Purpose |
|---|---|---|
| `bills-extract` | ✅ wired | OCR an uploaded bill, persist extracted fields |
| `bills-attach` | ✅ wired | Attach a bill to a job + queue/push to Xero ACCPAY when configured |
| `receipt-webhook` | ✅ wired | Structured POS/Receipt Hub receipt ingestion |
| `receipt-sync-dispatch` | ✅ wired, provider stubs | Dispatch queued receipt sync jobs |
| `bas-lodgement-pack` | 🟡 deploy-gated | Render a BAS lodgement draft review bundle/PDF without ATO transmission |
| `xero-oauth-start` | ✅ wired | Build the Xero OAuth authorize URL |
| `xero-oauth-callback` | ✅ wired | Token exchange + tenant fetch + encrypted token store |
| `xero-push-bill` | ✅ locally wired | Push a bill as ACCPAY with stable idempotency and sync-log evidence |
| `xero-push-invoice` | ✅ locally wired | Push an invoice as ACCREC with stable idempotency and sync-log evidence |
| `xero-sync-accounts` | ✅ locally wired | Pull Xero chart/accounts into local account-code mapping |
| `xero-sync-payments` | ✅ locally wired | Pull Xero payments into local payment/reconciliation records |

## Shared modules (`_shared/`)

- `cors.ts` — CORS headers + OPTIONS preflight
- `ocr/` — provider-agnostic OCR (MiniMax, Anthropic, OpenAI, Groq)
  - `prompt.ts` — extraction prompt + JSON parser
  - `minimax.ts` — MiniMax-M3 adapter (default v2 when configured)
  - `anthropic.ts` — native PDF/image adapter
  - `openai.ts` — gpt-4o adapter
  - `groq.ts` — legacy Llama adapter
  - `index.ts` — provider router via `OCR_PROVIDER` env
- `xero/adapter.ts` — shared Xero push/auth/idempotency helpers. Stub mode is
  still available for non-provider proof, but real push paths exist.

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

OCR_PROVIDER=minimax
MINIMAX_API_KEY=
MINIMAX_VISION_MODEL=MiniMax-M3

ANTHROPIC_API_KEY=           # native PDF/image fallback or primary
ANTHROPIC_VISION_MODEL=claude-sonnet-4-6

OPENAI_API_KEY=              # fallback / alternative
OPENAI_VISION_MODEL=gpt-4o

GROQ_API_KEY=                # legacy fallback
GROQ_VISION_MODEL=meta-llama/llama-4-scout-17b-16e-instruct

XERO_CLIENT_ID=
XERO_CLIENT_SECRET=
XERO_STUB_MODE=true          # set false for real provider calls after live credentials are ready

ENCRYPTION_KEY=              # 32-char key for encrypting at-rest tokens
```

## Known limitations (v1)

1. **OCR live quality still needs sample proof.** Born-digital PDFs use the
   text-first parser, image-based PDFs are rasterized for image-only providers,
   and Anthropic can read PDFs natively. Before relying on BAS numbers, run a
   live sample/backfill and verify amount+GST coverage.
2. **Xero still needs provider-live proof.** OAuth, account sync, payment sync,
   bill push, invoice push, idempotency, and sync-log evidence paths are locally
   wired. `XERO_STUB_MODE=true` remains available for non-provider proof; real
   Xero calls still require live credentials and accepted provider traces.
3. **No PO matching, no PCR.** Loopletnumero's `services/po/poMatching.ts`
   and `services/pcr/projectCostReconciliation.ts` are not yet ported.
   Phase 3 + Phase 4 of `docs/ROADMAP.md`.
4. **Gmail Pub/Sub inbound exists.** It still needs a real watched-mailbox event
   trace before being called end-to-end live-proven.
