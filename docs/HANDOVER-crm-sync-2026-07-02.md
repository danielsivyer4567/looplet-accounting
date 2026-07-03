# Handover: Looplet Accounting ↔ Looplet CRM sync

**For:** the Looplet CRM session, to cross-check against its own side before
either app writes any sync code. Two separate Supabase projects (same
Supabase account, different projects) — no shared DB, no shared auth. This
is Accounting's complete inventory of everything sync-relevant.

## What already exists on the Accounting side (scaffolded, unused)

Someone previously planned this integration and added schema for it, but
**no code anywhere in this repo reads or writes these** — confirmed via
repo-wide grep. This is empty scaffolding, safe to build against or replace.

- `public.organizations.crm_organization_id` — a column that already exists
  on the Accounting org table, presumably meant to hold the matching CRM
  org id. Nullable, no FK (can't FK across projects anyway), no unique
  constraint currently.
- `public.crm_sync_log` — a full inbound event ledger table:
  `id, organization_id, event_type, crm_record_type, crm_record_id, payload,
  received_at, processed_at, result, idempotency_key`. Has a UNIQUE
  constraint on `idempotency_key` (good — replay-safe by design). Grants:
  `service_role` full access, a `connector` role SELECT-only, no RLS policy
  (fine for a service-role-only ingest table, never read by anon/authenticated
  client code).

**Decision needed with CRM side:** do we finish wiring these two as-is, or
design fresh? They look purpose-built for "CRM pushes events INTO
Accounting" (the log table name/shape), which is the *opposite* direction
from the "Accounting numbers flow INTO CRM" idea being discussed. Confirm
which direction(s) are actually wanted before building.

## Existing patterns to reuse (proven, live, don't reinvent)

- **`supabase/functions/api-gateway/index.ts`** — the sanctioned pattern for
  an external system to get scoped access to an org's data: exchanges an
  API key for a short-lived, org-scoped Supabase JWT (`organization_id`
  claim), which every existing RLS policy already enforces. A `connector`
  Postgres role holds SELECT-only on org tables by grant (migration 0205) —
  cannot INSERT/UPDATE/DELETE even with a valid token. All writes must go
  through a separate scoped `ingest`-style function with an explicit
  per-type `write:*` scope check. If CRM needs to pull Accounting numbers,
  **this is the pattern to hand it**, not a new bespoke auth scheme.
- **`_shared/env.ts` → `requireEnv()`** — every secret this repo reads is
  pulled via this helper (fails closed if unset). Any new secret (e.g. a
  CRM-side shared key) should follow the same convention.
- **Secret naming convention** (see `supabase secrets list` output below) —
  `<SYSTEM>_<PURPOSE>` e.g. `XERO_CLIENT_SECRET`, `BASIQ_API_KEY`,
  `CONNECTOR_JWT_SECRET`. A CRM integration secret should follow suit, e.g.
  `CRM_SYNC_SECRET` or `CRM_API_KEY` — check CRM's own naming so both sides
  agree on the same secret name/value if it's a shared static key.
- **Cron pattern** for any scheduled sync — see `supabase/migrations/*.sql`
  entries using `cron.schedule(...)`, e.g.
  `20260702173000_bill_code_jobs.sql` (the most recent, cleanest example:
  DB-side enqueue function + a 5-min pg_cron schedule, decoupled from the
  actual HTTP dispatch which lives in a durable `automation_jobs` queue
  drained by `automation-worker`). If CRM sync should be near-real-time
  rather than polled, model it on `xero-webhook`/`bank-webhook` instead
  (inbound webhook receiver, HMAC/token-verified, writes to a durable table
  first, processes async).

## All currently-configured secrets (names only, for convention-matching)

```
ACCOUNTANT_SESSION_DIGEST_CRON_SECRET   AUTOMATION_WATCHDOG_SECRET
AUTOMATION_WORKER_SECRET                AUTO_RECONCILE_CRON_SECRET
BANK_CLASSIFIER_CRON_SECRET             BANK_SYNC_ALL_CRON_SECRET
BASIQ_API_KEY                           BASIQ_BASE_URL
BASIQ_WEBHOOK_VERIFY_TOKEN              CONNECTOR_JWT_SECRET
ENCRYPTION_KEY                          GMAIL_CLIENT_ID / _SECRET
GMAIL_PUBSUB_TOPIC                      GMAIL_PUSH_VERIFY_TOKEN
GMAIL_WATCH_RENEW_CRON_SECRET           GOOGLE_MAPS_SERVER_KEY
GROQ_API_KEY / _VISION_MODEL            LEGAL_INGEST_SECRET / _SCAN / _SYNC
MINIMAX_API_KEY                         NOTIFICATIONS_CRON_SECRET
OCR_PROVIDER                            OPENAI_API_KEY
PERPLEXITY_API_KEY                      RECEIPT_SYNC_DISPATCH_CRON_SECRET
RESEND_API_KEY                          SUPABASE_* (URL/keys/JWKS — project-internal)
XERO_CLIENT_ID / _SECRET                XERO_CRON_SECRET
XERO_DEFAULT_ACCOUNT_CODE / _TAX_TYPE   XERO_DEFAULT_TENANT_ID
XERO_REDIRECT_URI                       XERO_STUB_MODE
XERO_WEBHOOK_KEY
```

No `CRM_*` secret exists yet on this side — first thing to add once a
direction/design is agreed.

## Data an "Accounting numbers → CRM" sync would actually expose

If the plan is CRM reading Accounting's numbers, the source tables are:

- `public.organizations` — org identity, `crm_organization_id` for mapping
- `public.journal_entries` + `public.journal_lines` — the posted GL
- `public.gl_trial_balance(from, to)` — RPC, date-scoped trial balance
  (added in migration `20260702_gl_posting_rpc` per
  `docs/WIRING_ACTIVATION_PLAN.md` Phase — canonical source for "the numbers")
- `public.bills` / `public.invoices` — AP/AR source documents
- `public.chart_of_accounts` — account structure, needed to label any
  numbers meaningfully in the CRM UI
- `public.coding_suggestions` / `public.coding_review_queue` — NOT
  recommended to expose; internal workflow state, not client-facing data

All are RLS-scoped by `organization_id IN (SELECT get_accessible_org_ids())`
— the same helper enforced everywhere else in this repo. A CRM-facing sync
should read through a **new, narrow RPC or view** (e.g.
`crm_financial_summary(organization_id)`) rather than exposing raw tables,
so Accounting controls exactly what leaves the system and can change
internal schema without breaking CRM.

## What's needed to actually build this (once direction is confirmed)

1. A migration adding a UNIQUE constraint on
   `organizations.crm_organization_id` (currently unconstrained — two
   Accounting orgs could point at the same CRM org by accident today).
2. A new edge function, e.g. `crm-sync-push` (Accounting → CRM) or
   `crm-sync-pull`/inbound webhook receiver (CRM → Accounting via
   `crm_sync_log`), following the api-gateway/webhook patterns above.
3. A new secret pair — a shared static key or per-call signed token,
   named to match whatever CRM's side calls it.
4. If exposing summarized numbers: the narrow RPC/view mentioned above,
   not raw table grants.
5. Decide sync direction and cadence with the CRM side before writing any
   code — this doc plus CRM's equivalent inventory is exactly the input
   needed to make that call together.
