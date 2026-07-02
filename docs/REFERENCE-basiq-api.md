# Basiq API — reference index

Saved 2026-07-02 so future sessions don't have to rediscover this. Basiq is
the bank-feed provider wired up in `supabase/functions/_shared/basiq/*` and
`supabase/functions/bank-*`.

## Top-level entry points

- **Docs index (always fetch first):** https://api.basiq.io/llms.txt
- **Full docs guide list:** https://api.basiq.io/docs
- **API reference (all endpoints):** https://api.basiq.io/reference
- **MCP server (live API interaction/debugging for an agent):** https://api.basiq.io/mcp
  — added to both `%APPDATA%\Claude\claude_desktop_config.json` (Claude
  Desktop) and this repo's `.mcp.json` (this CLI session) on 2026-07-02.
  Requires a session/app restart to connect; not yet verified live.
- **OpenAPI spec (canonical schema, for SDK gen / validation):**
  https://api.basiq.io/reference/openapi — also split into domain-level
  JSON specs on GitHub (`basiqio-oss/Basiq-docs`, `v3.0` branch):
  connect.json, enrich.json, insights.json, identity.json, reporting.json,
  webhooks.json, platform.json, affordability.json.

## Docs most relevant to this codebase's integration

- **Dashboard config** (`/docs/dash-configuration`) — consent policy,
  institution selection, header branding, redirect URL, multiple-connections
  toggle. See `docs/WIRING_ACTIVATION_PLAN.md` for the checklist of what to
  set here.
- **Connections** (`/docs/platform-connections`) — connection states,
  refresh, purge, revoke/delete. `purgeConnection()` in
  `_shared/basiq/client.ts` implements the purge endpoint; wired into
  `bank-disconnect` (new 2026-07-02, replaces the old local-only "disable").
- **User Management** (`/docs/user-management`) — create/get/update/delete
  a Basiq "user" (our `getOrCreateBasiqUser()` — one per org, id stored on
  `organizations.basiq_user_id`).
- **Statements** (`/docs/bank-statements`) — official bank-issued PDF/JSON
  statements via the Reports API (`reportType: STATEMENT_01`). **Not yet
  implemented** — flagged as a real gap for the compliance packs
  (`working-papers`, `bas-lodgement-pack`, `smsf-audit-pack`), which
  currently have no way to attach an actual bank statement as audit
  evidence. Scoped but not built as of 2026-07-02.
- **Go live checklist** (`/docs/go-live-checklist`) — walked through
  2026-07-02, see `docs/WIRING_ACTIVATION_PLAN.md` for what's done vs.
  outstanding (dashboard config items mostly, code side is largely covered).
- **Webhooks / Webhooks Security** (`/docs/webhooks`,
  `/docs/webhooks-security`) — `BASIQ_WEBHOOK_VERIFY_TOKEN` secret already
  set; `bank-webhook` function already receives these.
- **CDR Compliance / Consent Management** (`/docs/cdr-compliance`,
  `/docs/consent.md`) — relevant background for why purge-on-disconnect
  matters (a user revoking access in-app must propagate upstream, not just
  hide locally) and for the "Manage Consent URL" dashboard field (needs a
  real consent-management page in this app — not built yet).
- **API Rate Limiting** (`/docs/api-rate-limiting`) — relevant to
  `basiqFetch()`'s existing 429/5xx retry-with-backoff logic in
  `_shared/basiq/client.ts`.

## Reference endpoints used vs. not yet used in this repo

**Used:** `POST /token`, `POST /users`, `PATCH /users/{id}`,
`POST /users/{id}/auth_link`, `GET /users/{id}/connections[/{id}]`,
`GET /users/{id}/accounts`, `GET /users/{id}/transactions`,
`GET /jobs/{jobId}`, `POST /users/{id}/connections/{id}/purge`.

**Not used, worth knowing about:** `POST /reports` + report retrieval
(official statements — see above), `/insights/*` (income/expense/identity
verification), `/enrich` (transaction categorization/merchant enrichment —
could improve `bank-transaction-classifier`'s categorization quality),
`/connectors` (per-institution health/outage status — recommended by the
go-live checklist for dynamic status, not wired in), `/payments/*`
(payouts/payrequests — not relevant unless building payment initiation),
`/affordability`, `/analytics/connections` + `/analytics/users`.

**Deprecated — do not build against these:** `POST /users/{id}/expenses`
and `GET /users/{id}/expenses/{snapshotId}` (the old "Affordability"
expense-summary endpoints) are explicitly marked `deprecated: true` in
Basiq's own OpenAPI spec, with the docs saying "Please use Reporting
(Insights)" (`POST /reports` / `POST /insights`) instead. Same almost
certainly applies to the sibling `/income` endpoints (same Affordability
API family, same pattern) — verify before using, but assume deprecated.
If a category-spend or income view is ever wanted, build it against
`/reports` (`createReport`) or `/insights`, not `/expenses` or `/income`.
