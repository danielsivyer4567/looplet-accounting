# Looplet Accounting — Product Roadmap

**A separate product, designed standalone, connectable to Looplet CRM later.**

Created 2026-05-01 after a long architecture session that boiled down to this:
the headline feature is **per-job true profit ("what's really yours")**, the
architecture is **Looplet-as-source-of-truth with Xero as a printer driver**,
and the trap to avoid is letting CRM-integration concerns leak into v1
schema decisions. CRM connection is **Phase 8**, not Phase 1.

**Loopletnumero (the Mongo prototype) is a reference implementation, not
a production system.** Its OCR pipeline, Xero adapter, prompt engineering,
PO matching, and metadata-cache code are *ported* into this new product as
edge functions / services. AFGC's first real production bills land on the
Postgres product — they do not launch on Mongo. The 14-day Loopletnumero
launch plan in [LOOPLET_ACCOUNTING_TODO.md](LOOPLET_ACCOUNTING_TODO.md) is
**superseded by this roadmap.**

Why: accounting data is fundamentally relational (bills × line items ×
allocations × wage entries × overhead × GST × tax — every "what's really
yours" calc is a chain of joins). Mongo was a bootstrap choice, not a
long-term storage decision. Running two production systems in parallel is
ops debt a solo founder can't afford. Build it right from the get-go on
Postgres, port the working logic across, kill Mongo before it has any
production data on it.

**Cost:** AFGC's launch slips from "next week" to "~week 12." That's the
real price of building right. The benefit: no migration, no dual-system
operations, no technical debt baked into the foundation.

---

## North Star

A trades operator finishes a job. Looplet shows them, in plain English:

> *"On Job 1090 you grossed $11,000. After materials, subbies, and labour
> at full loaded cost, you cleared $4,200. $850 needs to sit aside for GST,
> $920 for income tax, your overhead share was $340. **What's really yours:
> $2,090.**"*

Every decision in this roadmap rolls up to whether it makes that sentence
possible, accurate, and trustworthy.

---

## Foundational disciplines — apply to every phase, every PR, every table

These are non-negotiable from day 1. None are "v1.5 nice-to-haves." All are
brutal to retrofit once production data exists. Cost today is small; cost
later is migrations + downtime + lost trust.

### Data model

- **UUID primary keys everywhere.** Never serial integers. Lets us merge
  databases, sync across systems, and never collide IDs.
- **Money is `BIGINT` cents, not `NUMERIC` dollars.** No floating-point in
  financial calcs. UI layer converts for display. Every monetary column
  has `_cents` suffix to make it unmistakable.
- **`TIMESTAMPTZ` always, UTC stored.** Never `TIMESTAMP` without zone.
  Display layer converts to user's tz.
- **Currency-ready from day 1.** Every monetary table has
  `currency_code CHAR(3) NOT NULL DEFAULT 'AUD'`. v1 only writes 'AUD';
  v2 multi-currency just removes the constraint. Adding the column later
  is an ALTER on a populated billing table — don't.
- **Soft deletes on financial tables.** `deleted_at TIMESTAMPTZ NULL` on
  `bills`, `customer_invoices`, `wage_entries`, `transactions`. Hard
  deletes only on prefs / cache tables. ATO requires record retention.
- **Append-only event tables.** `audit_log`, `transactions`,
  `xero_sync_log`, `crm_sync_log` reject UPDATE and DELETE at the DB
  level via trigger. Mistakes get corrected by inserting a reversing
  entry, not by editing history.
- **DB-level constraints, not app-level.** `CHECK` constraints on enum
  values, `NOT NULL` where required, FK constraints with proper
  `ON DELETE` clauses, partial unique indexes for "one active per X"
  rules. Application code is a third line of defence, not the first.
- **Period locking infrastructure from day 1.** `period_locks` table
  tracks "this BAS quarter is locked, no writes to records dated within
  it without an unlock." A trigger on every financial table enforces.
  v1 may not actively lock anything; the infrastructure ships ready.

### External integrations

- **Idempotency keys on every external write.** Every Xero push, every
  webhook receive, has an idempotency key (UUID). Replays never double-post.
- **Webhook signing verified, no exceptions.** Every inbound webhook
  (Xero, Gmail, future CRM) verifies HMAC signature before any side
  effect. No "auth comes later" loopholes.
- **External state cached, never authoritative.** When Xero says a bill
  is paid, we record `xero_paid_at` as a cached observation, not as our
  truth. Looplet's truth is its own records.

### Operations

- **Every schema change is a migration file with `up` and `down`.** No
  `ALTER TABLE` in psql, no manual fixes in the Supabase UI. Migrations
  versioned in Git. Reviewable in PRs.
- **CI required from day 1.** Typecheck + lint + migration-apply +
  integration tests. No merge to main without green.
- **TypeScript strict mode on, `any` banned.** `strict: true`,
  `noUncheckedIndexedAccess: true`. Slower to write; survivable in five
  years.
- **Sentry from day 1, not Phase 5.** Cost: 30 minutes setup. Benefit:
  every production error has a stack trace and a user impact count from
  the first deployed customer.
- **Structured logging with correlation IDs.** Every request gets a
  UUID, propagated through every log line, every external call. Debug a
  customer issue by grepping one ID across edge fns + frontend + Xero
  call logs.
- **Staging environment exists from Phase 1.** Separate Supabase project
  mirroring prod schema. Every migration runs against staging first.
  Every Xero integration tested against Xero's demo company before prod.

### Multi-tenancy (every organisation is fully separate, day 1)

Looplet Accounting is a multi-tenant SaaS from the first deploy. Not "AFGC
v1, multi-tenant v2." Multi-tenant from line one of code. Every customer
organisation is isolated as if it were on its own server.

The pattern: **shared schema, RLS-isolated** — same model used by Stripe,
Linear, Notion. One Supabase project, one schema, one set of edge
functions, one set of migrations — separation enforced at the database
level via Row-Level Security, not by application code.

**Org structure: copy Looplet CRM's pattern verbatim.** CRM has already
built and proven a 3-tier (standard / agency / sub-account) tenant model
in `001_initial_schema.sql` + `002_multi_org_invitations.sql` +
`20260206000007_alter_organizations_agency.sql`. We adopt it as-is so
Phase 8 alignment is a literal name match.

**Foundational tables (copied from CRM's pattern):**

- `organizations` — tenant container. Has `organization_type` enum
  (`standard | agency | sub_account`) and `parent_organization_id`
  self-FK so an agency tenant can parent its sub-accounts. **From day 1**
  — even though v1 only uses `standard`. The columns sitting unused for
  6 months cost nothing; adding them later is an ALTER on a populated
  table.
- `organization_memberships` — M2M between `auth.users` and
  `organizations`. Role enum: `owner | admin | manager | member`. One
  user can belong to many orgs (Daniel runs AFGC + a property co + a
  trust). `is_default` flag designates which org a returning user lands
  in.
- `team_invitations` — invite-by-email flow with token + role + expiry.
  Same shape as CRM.
- RLS helper functions (`is_agency_user()`, `get_user_agency_id()`,
  `can_access_sub_account()`, `get_accessible_org_ids()`) — ported
  verbatim from `20260206000007`. They're the load-bearing logic for
  "agency admin sees all their sub-accounts but not other agencies'
  sub-accounts" without us writing a line of new RLS code.

**What we deliberately DON'T copy from CRM (yet):**

- `sub_accounts` table (with credit limits, seat limits, billing markup %)
  — agency-monetization layer; defer to v1.5 when Jaime onboards as the
  first agency.
- `agency_configurations`, `agency_branding` — white-label / agency
  config. v1.5+.
- CRM's domain tables (`contacts`, `projects`, `activity_logs`) — those
  are CRM's job, not Accounting's. Accounting has its own domain
  (`bills`, `customer_invoices`, `wages`, etc.).

**Why copying is right (not over-engineering):**

1. **L5 destination unlocked from day 1.** Jaime's bookkeeping firm
   eventually onboards as `organization_type='agency'` with 50 trades
   businesses as `sub_account`s. No retrofit migration. The agency
   hierarchy is already a column.
2. **Phase 8 alignment becomes a literal name match.** Both products'
   `organizations` tables share shape; FK is `crm_organization_id`.
   Nothing to translate.
3. **RLS helpers are solved already** — port the functions, save weeks.

**Isolation rules — non-negotiable:**

- Every business table has `organization_id UUID NOT NULL` and an RLS
  policy that filters via `organization_id IN (SELECT * FROM
  get_accessible_org_ids())`. The helper handles standard / agency /
  sub-account access automatically.
- Edge functions using the service-role key **must** explicitly filter by
  the caller's accessible orgs. Service-role bypasses RLS — that's the
  entire risk surface. Code review checklist: every service-role query
  has an `organization_id IN (...)` filter.
- Supabase Storage: one folder prefix per org (`org-{id}/bills/...`).
  Bucket-level RLS enforces folder access.
- Audit log captures **attempted** cross-tenant access (which should never
  succeed) — flagged in monitoring.
- Onboarding: self-service signup creates a new `organization` (type =
  `standard`) and an `organization_memberships` row with role `owner`.
  From there, the new owner invites other users via `team_invitations`.

**Isolation rules — non-negotiable:**

- Every business table has `entity_id UUID NOT NULL` and an RLS policy
  that filters on `entity_id IN (SELECT entity_id FROM entity_users
  WHERE user_id = auth.uid())`. No exceptions.
- Edge functions using the service-role key **must** explicitly filter by
  the caller's `entity_id` extracted from the JWT. Service-role bypasses
  RLS — that's the entire risk surface. Code review checklist: every
  service-role query has an `entity_id =` filter.
- Supabase Storage: one folder prefix per entity (`entity-{id}/bills/...`).
  Bucket-level RLS enforces folder access. No shared storage paths.
- Audit log captures **attempted** cross-tenant access (which should never
  succeed) — flagged in monitoring.
- Onboarding: self-service signup creates a new `entity` and an
  `entity_users` row with role `owner`. From there, the new owner invites
  other users.

**Tenant isolation tests in CI from day 1:**

```text
- User A in org A1 creates a bill.
- User B in org B1 tries to read it (via API, direct Supabase query, edge fn).
- Test PASSES iff every attempt returns empty / 404 — no rows, no IDs,
  no error messages that reveal existence.
- Plus: agency-mode test. Agency user A1 has sub-accounts SA1, SA2.
  Agency user A2 has sub-accounts SA3, SA4. A1 cannot see SA3/SA4 data
  via any channel.
```

If this test ever goes red on `main`, deploys block until fixed. The
multi-tenant property is the *one* invariant we never break.

**What is per-tenant (every organisation has their own):**

- Bills, invoices, jobs, allocations, wages, employees, customers, suppliers
- Xero OAuth connection (each org links its own Xero org)
- Overhead profile, daily rate, fiscal year settings
- BAS quarter dates (mostly aligned but configurable for fiscal-year-end variants)
- GST rate (currently 10% AU — config column, not a constant)
- Stripe subscription / billing
- Storage folder
- Audit log (queries always filtered by `organization_id`)

**What is global (shared across tenants, deliberately):**

- Provider config (OpenAI/Groq/Kimi keys for OCR — operator-level, not tenant-level)
- System settings (feature flags, marketing copy)
- Public reference data (Australian public holidays, BAS quarter calendar)

**What is global but tenant-aware (one record, many tenants reference it):**

- *Defer this question until v2.* For v1, suppliers and contacts are
  per-tenant — Reece exists once per tenant that buys from them. Pro:
  zero cross-tenant data leak risk. Con: no fraud-detection-by-supplier-pattern
  in v1. Acceptable trade-off.

### Security

- **Row-Level Security on every table from day 1.** Already covered above
  — calling out that this isn't theoretical: it's the entire foundation
  of multi-tenancy.
- **Service role key never reaches the browser.** All Supabase client
  operations from the frontend use the anon key with RLS. Privileged
  operations go through edge functions with service role + manual
  `entity_id` filtering.
- **Secrets in Supabase secrets, not in code.** Xero client secret,
  HMAC keys, etc. never in repo, never in `.env` files committed
  anywhere.
- **PII column tagging.** Mark every column holding PII (`name`,
  `email`, `phone`, `abn`, `bank_account`) with a comment so a future
  GDPR-style "delete my data" request is a SQL query, not an audit.
- **Tenant data export on request.** Owner of an entity can trigger a
  full export (bills + invoices + wages + audit log + storage files) as
  a zip. Required for AU privacy compliance and for the customer's
  peace of mind that data isn't held hostage.

### Schema patterns to use everywhere

```sql
-- Standard table preamble, used on every business table:
CREATE TABLE bills (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  -- ... domain columns ...
  currency_code   CHAR(3) NOT NULL DEFAULT 'AUD',
  total_cents     BIGINT NOT NULL CHECK (total_cents >= 0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      UUID NOT NULL REFERENCES auth.users(id),
  deleted_at      TIMESTAMPTZ NULL,
  -- CRM alignment-prep:
  crm_record_id   UUID NULL
);

-- updated_at trigger (one helper function, applied via trigger to every table)
CREATE TRIGGER bills_set_updated_at
  BEFORE UPDATE ON bills
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Audit-log trigger (captures before/after on every UPDATE/DELETE)
CREATE TRIGGER bills_audit
  AFTER INSERT OR UPDATE OR DELETE ON bills
  FOR EACH ROW EXECUTE FUNCTION write_audit_log();

-- RLS — uses the helper function ported from CRM:
ALTER TABLE bills ENABLE ROW LEVEL SECURITY;
CREATE POLICY bills_tenant_select ON bills
  FOR SELECT USING (organization_id IN (SELECT get_accessible_org_ids()));
CREATE POLICY bills_tenant_insert ON bills
  FOR INSERT WITH CHECK (organization_id IN (SELECT get_accessible_org_ids()));
CREATE POLICY bills_tenant_update ON bills
  FOR UPDATE USING (organization_id IN (SELECT get_accessible_org_ids()));
-- DELETE policy intentionally absent — financial tables soft-delete only
```

This block is the rule, not the exception. **If a table doesn't follow
this pattern, it's wrong.**

---

## Phase 0 — Decisions to lock THIS WEEK (no more research procrastination)

These four blockers must be written-down decisions before any schema gets
written. Each is one hour of focus, not weeks.

| # | Decision | Format | Lock by |
|---|---|---|---|
| 0.1 | **Loaded hourly rate formula** — denominator: gross hours (1976) vs net productive hours (~1700). Pick one, write the formula, lock it. | One paragraph in `docs/decisions/0001-loaded-hourly-rate.md` | Wed 2026-05-03 |
| 0.2 | **Daily overhead allocation rule** — "tenant fixed daily cost ÷ active jobs by duration" or "÷ revenue share" or "by hours-on-job-this-day." | `docs/decisions/0002-overhead-allocation.md` | Thu 2026-05-04 |
| 0.3 | **Tax-set-aside formula** — fixed % of net (simple) vs progressive bracket estimate (accurate) vs "use last year's effective rate" (defensible). | `docs/decisions/0003-tax-set-aside.md` | Fri 2026-05-05 |
| 0.4 | **AFGC's real numbers as defaults** — Daniel's actual yearly wage cost, super rate, leave entitlements, daily overhead. Stops the calc being theoretical. | `docs/decisions/0004-afgc-baseline-figures.md` | Fri 2026-05-05 |

**Acceptance:** four short markdown files committed. Each ≤300 words. No
code yet. If a decision can't be made in an hour, mark it "TBD with rationale"
and move on — locked-as-TBD beats unlocked-and-debated.

---

## Phase 1 — Scaffold (Week 1, ~2 days)

The separate product gets its own repo and its own Supabase. Nothing in this
phase is technically novel; it's standing up the box.

### 1.1 New repo
- [ ] Create `C:\repos\looplet-accounting\` (or path of choice)
- [ ] `git init`, push to GitHub `Loopletnumero/looplet-accounting` or new org
- [ ] Stack: React 18 + Vite + Supabase JS client + TypeScript + MUI
  (matches Looplet CRM stack so patterns transfer later — but **no CRM
  imports**)
- [ ] Vite proxy to Supabase Edge Functions
- [ ] CI: GitHub Actions running typecheck + build on every push

### 1.2 Supabase project
- [ ] **Use the wiped `dxoikltymmknxqpkpyhi`** (already empty as of today)
- [ ] Configure auth providers: email/password + magic link
- [ ] Set storage bucket `bills` for original PDF/image storage
- [ ] Generate service-role key, anon key — capture in repo `.env.example`

### 1.3 Local dev
- [ ] `docker-compose.yml` runs Supabase local stack (optional — can hit cloud directly for v1)
- [ ] `npm run dev` launches Vite + Supabase migrations apply automatically
- [ ] One end-to-end smoke test: log in → see empty dashboard → log out

### 1.4 Self-service signup + entity creation
- [ ] **Sign-up flow** creates the auth user AND a fresh `entity` AND an `entity_users` row with role `owner` — atomically, in a single transaction. A new user lands on a blank-slate dashboard for *their* entity, not a shared sandbox.
- [ ] **Switch-entity selector** in the UI header — for users who belong to multiple entities. Default to most-recently-used.
- [ ] **Invite flow** — owner can invite by email; invited user signs up, sees the existing entity in their selector, role assigned per the invitation.

### 1.5 Tenant isolation test suite from day 1
- [ ] Two test users (entity A owner, entity B owner) created in CI.
- [ ] Test: A creates a bill, B tries to read it (every channel: anon-key REST, edge fn, raw Supabase client) — every read returns empty/404. **Goes red? Deploys block.**
- [ ] Test: B tries to upload a file to A's storage prefix — denied.
- [ ] Test: B tries to read A's audit log — denied.
- [ ] Wire to GitHub Actions; runs on every PR.

**Acceptance:** running `npm run dev` from a fresh clone starts the app, lets
two separate users sign up, each lands on their own empty dashboard, neither
can see the other's data via any channel. CI tenant-isolation suite green.

---

## Phase 2 — Schema v1 (Week 1, ~3 days)

13 tables. Migration committed. RLS on every table from day 1, multi-tenant
from day 1 (no "v2 migration to multi-tenancy" — it's foundational).

### 2.1 Tenant infrastructure (copied from CRM)

| # | Table | Purpose | Source |
|---|---|---|---|
| 1 | `organizations` | Tenant container. `organization_type` ∈ `{standard, agency, sub_account}`, `parent_organization_id` self-FK. Day 1 only `standard` is used. | CRM `001_initial_schema.sql` + `20260206000007_alter_organizations_agency.sql` |
| 2 | `organization_memberships` | M2M users↔orgs with `role` ∈ `{owner, admin, manager, member}`, `is_default`. | CRM `002_multi_org_invitations.sql` |
| 3 | `team_invitations` | Email + token + role + expiry for invite flow. | CRM `002_multi_org_invitations.sql` |
| — | RLS helpers (`is_agency_user`, `get_user_agency_id`, `can_access_sub_account`, `get_accessible_org_ids`) | Functions, not tables. Port from CRM verbatim. | CRM `20260206000007` |

### 2.2 Domain tables (Accounting-specific)

| # | Table | Purpose |
|---|---|---|
| 4 | `jobs` | The spine. `organization_id`, `job_number`, `name`, `customer_id`, `status`, timeline, budget. |
| 5 | `customers` | AR-side counterparty (per-org). The party being invoiced. |
| 6 | `suppliers` | AP-side counterparty (per-org). Reece, Bunnings, etc. — duplicated per org in v1. |
| 7 | `bills` | Inbound supplier bills (AP). Status enum: `received → verified → attached → paid`. Original file in storage bucket. |
| 8 | `bill_line_items` | Line items per bill — description, qty, unit_price_cents, gst_cents, account_category. |
| 9 | `customer_invoices` | Outbound invoices (AR). Sent to customers, pushed to Xero immediately on send. |
| 10 | `customer_invoice_line_items` | Lines on AR invoices. |
| 11 | `employees` | Staff records — wage components (super, leave, insurance), used to compute loaded rate. |
| 12 | `wage_entries` | Time-tracked work — `employee_id`, `job_id`, start/end, `loaded_hourly_rate_at_time_cents` (snapshotted). |

### 2.3 Infrastructure tables

| # | Table | Purpose |
|---|---|---|
| 13 | `audit_log` | Append-only. Every UPDATE/DELETE on any business table writes a before/after row here, captured by Postgres trigger. Immutable. |
| 14 | `period_locks` | One row per locked BAS quarter per org. Triggers on financial tables block writes to records dated within a locked period. |
| 15 | `xero_integrations` | Per-org OAuth tokens (encrypted). One row per (org, Xero org) connection. |
| 16 | `xero_sync_log` | Append-only record of every push to Xero — `organization_id`, `record_type`, `record_id`, `xero_id`, `payload_hash`, `synced_at`. |
| 17 | `crm_sync_log` | Append-only record of every webhook from CRM (idempotency + observability). Empty until Phase 8. |

### 2.4 Discipline

- Every business table has `organization_id UUID NOT NULL`,
  `created_at`, `updated_at`, `created_by`, `deleted_at NULL` (financial
  tables only), `currency_code DEFAULT 'AUD'` (monetary tables only).
- RLS: every read/write filters via
  `organization_id IN (SELECT * FROM get_accessible_org_ids())`.
  No exceptions.
- No FK to anything outside this Supabase project. CRM connection (Phase 8)
  uses an integration table + nullable FK columns, not a structural FK.
- No "Xero-shaped" columns. The schema reflects trades workflow, not
  Xero's API surface.

### 2.5 CRM alignment-prep (cheap now, painful to retrofit later)

Every table that *could* link to a CRM concept gets a nullable `crm_*_id
UUID` column **from day 1**, null until Phase 8 wires it. Cost today: ~5
extra columns. Cost if we skip and add later: 5 ALTER migrations across
populated tables, 5 backfill scripts, real downtime risk.

| Looplet Accounting table | Nullable column added | Maps to (Phase 8) |
|---|---|---|
| `organizations` | `crm_organization_id UUID` | CRM `organizations.id` |
| `jobs` | `crm_project_id UUID` (CRM calls them `projects`) | CRM `projects.id` |
| `customers` | `crm_contact_id UUID` | CRM `contacts.id` |
| `suppliers` | `crm_contact_id UUID` | CRM `contacts.id` (when supplier-side contacts land in CRM) |
| `employees` | `crm_user_id UUID` | CRM `auth.users.id` |
| `organization_memberships` | `crm_membership_id UUID` | CRM `organization_memberships.id` |

Plus one new infrastructure table:

- `crm_sync_log` — append-only record of every webhook received from CRM:
  `event_type`, `crm_record_id`, `payload jsonb`, `received_at`,
  `processed_at`, `result`. Provides idempotency (replay-safe) and
  observability (debug what synced when).

**The three disciplines that make Phase 8 clean:**

1. **Nullable FK columns from day 1** — never store CRM state authoritatively in our tables; only cache with last-sync timestamps.
2. **Sync is one-way primary** — CRM → Accounting for context (jobs, contacts); Accounting → CRM for the "what's really yours" overlay only. Bidirectional writes create reconciliation hell.
3. **Translation tables, not enum mirrors** — CRM's `job_status` enum and Accounting's diverge by design. A `status_mappings` table documents the translation; we don't try to keep the enums in sync.

**Acceptance:** migration runs clean on the wiped project. Sample row
inserted into each table via `psql`. Every alignment-prep column is
present and nullable. No CRM dependency anywhere — alignment-prep
columns are unused until Phase 8.

---

## Phase 3 — Port working pieces from Loopletnumero (Week 2-3, ~5 days)

Don't rebuild the OCR/Xero plumbing — it works. Port it.

### 3.1 OCR adapter layer
- [ ] Port `backend/src/services/ocr/{index,openai,groq,kimi,anthropic,prompt}.ts` → Supabase Edge Function `bills-extract`
- [ ] Port `metadata.ts` (XMP-embedded extraction cache) → same edge fn
- [ ] Port `pdfToImage.ts` (poppler shell-out) → Edge Functions don't have native poppler. **Two options:** (a) keep Mongo backend running just for OCR, edge fn calls it; (b) use `pdf-lib` + `pdfjs-dist` in pure JS. Pick during implementation, default (b).
- [ ] Same `OCR_PROVIDER` env var, same provider switching

### 3.2 Bill intake
- [ ] **Manual upload** — React form, multipart upload to Supabase storage, row in `bills` table with status `received`
- [ ] **Gmail Pub/Sub** — port `gmailInbound.controller.ts` logic to edge fn `bills-ingest-email`. Webhook URL changes; logic ports verbatim
- [ ] After upload, fire `bills-extract` async; UI polls bill status

### 3.3 Allocation
- [ ] After OCR, attempt auto-match against open jobs by `job_reference` string
- [ ] Match found → bill status `verified`, surface "attach to Job X?" prompt
- [ ] No match → bill sits in `received`, surfaces in "needs review" queue
- [ ] **No PCR / PO matching in v1** — defer to Phase 4

### 3.4 Xero push
- [ ] Port `XeroAdapter.ts` `pushBill()` → edge fn `bills-push-xero`
- [ ] **Trigger: bill attached to a job.** Single-shot, original-dated, tracking category = job number
- [ ] OAuth flow: port `xero.controller.ts` start/callback/select-tenant/disconnect → edge fns
- [ ] Stub mode preserved for dev

**Acceptance:** in dev, upload a real Paul Finch invoice → OCR extracts → form pre-populates → user clicks "attach to Job 1090" → row appears in `bills` with `status='attached'` → Xero stub returns `STUB-XXXX`. ~30 seconds end-to-end.

---

## Phase 4 — Killer features (Week 4-10, ~6 weeks)

The deep-scale per-job P&L. **Phase 0 decisions are prerequisites** — don't
start until 0.1–0.4 are locked.

### 4.1 Loaded hourly rate engine
- [ ] `wage_components` table (per-employee, per-year): base wage, super %, leave entitlements, insurance allocation
- [ ] Function `compute_loaded_rate(employee_id, date)` → returns the loaded rate as of that date (snapshotted to `wage_entries.loaded_hourly_rate_at_time` so historical jobs don't re-compute)
- [ ] Admin UI: configure wage components per employee, see computed rate

### 4.2 Per-job ledger view
- [ ] Materialised view `job_ledger` UNIONing approved bills, customer invoices, wage entries, allocated overhead — by job, by date, with running totals
- [ ] React component `<JobLedger jobId>` rendering it as timeline
- [ ] Filter: by category (materials / subbies / labour / overhead / income), by date range

### 4.3 Daily overhead allocator
- [ ] `overhead_profiles` table (per-entity): daily $ rate, allocation rule (per Phase 0.2 decision)
- [ ] Function `allocate_overhead_to_job(job_id, date_range)` — runs nightly, populates `overhead_allocations` rows
- [ ] Admin UI: configure overhead profile, see allocations applied

### 4.4 GST netting + BAS quarter awareness
- [ ] Every bill + invoice has `gst_amount` extracted and stored
- [ ] View `gst_summary_by_quarter` — input credits (from bills) minus output GST (from invoices) per BAS quarter, per entity
- [ ] React `<BASQuarter>` component showing live netting, "current quarter so far" + "previous quarter to lodge"

### 4.5 Tax-set-aside calculator
- [ ] Per Phase 0.3 decision: fixed % / progressive / last-year-effective
- [ ] View `tax_set_aside_estimate` — by entity, by period, with the math shown so the user trusts the number
- [ ] Banner on dashboard: "Set aside $X for tax this quarter so far"

### 4.6 The "What's really yours" view
- [ ] Per-job: revenue − costs − labour@loaded − overhead share − GST set aside − tax set aside = take-home
- [ ] Per-week / per-quarter / per-year aggregations
- [ ] Single-screen UI showing this for a job in plain English, not accountant-speak
- [ ] Export as PDF report (printable, share with accountant)

**Acceptance:** AFGC's real Job 1090 (or equivalent) shows a complete
end-to-end "what's really yours" view, every number traceable to a row in
the database, and the math reconciles to ±0.5% against Jaime's manual calc
on the same job.

---

## Phase 5 — Production hardening (Week 10-12, ~2 weeks)

Sentry, structured logging, audit log, and staging are already in place
from day 1 (see Foundational Disciplines). Phase 5 layers the remaining
ops hardening on top.

- [ ] **Backup restore tested.** Supabase auto-backs-up; we don't trust it without restoring. Spin up a fresh project, restore last night's backup, run smoke tests, confirm timing. Document the RTO/RPO numbers honestly.
- [ ] **Monitoring with alerting.** UptimeRobot (or Better Stack) pings public endpoints every 5 min. PagerDuty / Slack alert on consecutive failures. SLOs documented: 99.5% uptime, p95 OCR < 60s, p95 Xero push < 10s.
- [ ] **Rate limiting per-IP and per-user.** Every public endpoint. Tunable per-tenant (an enterprise customer might need higher limits later).
- [ ] **Load testing.** Run 100 concurrent bill uploads against staging. Identify the bottleneck (probably edge fn cold starts or Xero rate limits). Document the ceiling.
- [ ] **Error budget defined.** "We accept 0.5% bill processing failure rate; if exceeded, freeze feature work until causes resolved." Without this, every Sentry alert becomes a fire.
- [ ] **On-call runbook.** Single Notion page (or markdown in `/docs/runbooks/`): "Xero OAuth tokens expired", "OCR provider rate-limited", "Mongo prototype container down" (during overlap), "user reports wrong P&L". Each with: symptoms, diagnosis, fix.
- [ ] **DR plan.** What if Supabase has a regional outage? What if a customer accidentally deletes 6 months of bills? Documented procedures, tested quarterly.
- [ ] **Status page.** `status.looplet-accounting.com` (Better Stack free tier or similar). Public uptime + incident history. Builds trust before sales conversations.

**Acceptance:** deliberate failures (kill the OCR provider, post a malformed
bill, stress-test 100 concurrent uploads, simulate a region outage) produce
clean error states, visible in monitoring, and recoverable per the runbook.
On-call rota is `@daniel` for v1 — runbook is so you don't have to think
when paged at 3am.

---

## Phase 6 — AFGC pilot launch (Week 12-14, ~2 weeks)

This is when AFGC's first real production bills land. **There is no migration
from Mongo** — Mongo never held AFGC production data. Loopletnumero was
Daniel's dev sandbox; AFGC starts on Postgres.

- [ ] AFGC user onboarded on the new product (creates entity, links to Xero, sets wage components per employee)
- [ ] Historical bills (last 12 months from Daniel's existing records / Xero export) imported as `closed` jobs to seed the per-job P&L view
- [ ] Daniel runs all new bills through the product for 2 weeks, daily
- [ ] Jaime reviews + corrects in the product; every correction logged to `audit_log`
- [ ] Decommission Loopletnumero (Mongo) at end of Phase 6 — kill the containers, archive the repo. The OCR/Xero code lives on inside the new product as edge functions; the Mongo prototype itself is retired

**Acceptance:** 50+ real AFGC bills processed through the new product over 2
weeks. Every Jaime correction logged in `audit_log`. Xero sync running clean.
Per-job P&L matching Jaime's manual books to ±0.5%. Loopletnumero containers
stopped, repo marked archived.

---

## Phase 7 — Public beta (Week 14-26, ~3 months)

3 friendly trades businesses (per Jaime's network) onboarded. Free for 90 days.

- [ ] Onboarding flow: signup → connect Xero → import historical bills (last 12 months) → see first per-job P&L within 10 minutes
- [ ] Help docs: 5 short Loom videos covering the main flows
- [ ] Stripe billing wired up (subscription + free-trial logic)
- [ ] Customer feedback funnel: in-app feedback button → Linear/Notion ticket
- [ ] Iterate on the "What's really yours" view based on what 4 customers actually use

**Acceptance:** 4 customers actively using the product after 90 days. NPS ≥ 30.
At least one customer says "I haven't logged into Xero in 2 weeks" — that's
the L2 autonomy signal.

---

## Phase 8 — Connect to Looplet CRM (Month 6+)

**Deliberately deferred until v1 is in production with paying customers.**
Do not let this leak into earlier phases.

Because of the alignment-prep discipline locked in Phase 2 (§2.3), this
phase is *plumbing*, not architecture. The schema columns already exist —
we just start populating them.

### 8.1 Connection mechanics

- [ ] **Sync from CRM → Accounting** (read-only mirror, webhook-driven): when a CRM job is created/updated/closed, fire a webhook to Accounting's edge fn `crm-webhook-receiver`. Idempotent via `crm_sync_log`.
- [ ] **Sync from Accounting → CRM** (one-direction overlay): per-job "what's really yours" totals push to CRM as custom fields on the matching `jobs` row. Bookkeeper sees them inside CRM without leaving.
- [ ] **SSO**: CRM is the IdP, Accounting accepts CRM JWTs. Existing Accounting users get linked to their `crm_user_id` on first SSO login.

### 8.2 Concrete table mappings (the alignment payoff)

Because the org-tier was copied from CRM verbatim, identical names line up:

| Concept | Accounting table.column | CRM table.column | Direction |
|---|---|---|---|
| Tenant container | `organizations.crm_organization_id` | `organizations.id` | CRM → Accounting (link, identical shape) |
| Membership | `organization_memberships.crm_membership_id` | `organization_memberships.id` | CRM → Accounting |
| Job ↔ Project | `jobs.crm_project_id` | `projects.id` (CRM calls them projects) | CRM → Accounting (1:1 typical) |
| Customer | `customers.crm_contact_id` | `contacts.id` (where `type='customer'`) | CRM → Accounting |
| Supplier | `suppliers.crm_contact_id` | `contacts.id` (where `type='vendor'`) | CRM → Accounting |
| User identity | (via Supabase auth federation) | `auth.users.id` | CRM is IdP via SSO |
| Per-job profit | (computed view in Accounting) | `projects.really_yours_amount_cents` (new custom column) | Accounting → CRM |
| Agency hierarchy | `organizations.parent_organization_id` | `organizations.parent_organization_id` | identical model |

### 8.3 What deliberately doesn't sync

- **Status enums.** CRM's `job_status` and Accounting's will diverge naturally. A `status_mappings` table documents the translation; enums stay independent.
- **Numbering schemes.** Each system has its own job numbers / invoice numbers. They link by ID, not by user-visible number.
- **Bills / supplier invoices.** Accounting owns the AP side completely. CRM never sees individual bills. CRM only sees the summary "really yours" overlay per job.
- **Authoritative writes.** Accounting never accepts a write from CRM as authoritative — only as a sync event with a timestamp. Accounting always wins on its own data.

The architecture decisions in any future `LOOPLET_ACCOUNTING_PLAN.md`
(CRM-side spec) inherit from this roadmap; not the other way around.

---

## What's intentionally NOT in v1

The brutal-honesty list. Each is a real feature someone will ask for. Each
is a v2+ problem.

- ❌ ~~Multi-org / agency multi-tenancy~~ — **REVERSED:** multi-tenant from day 1, see Foundational Disciplines. What's deferred is *agency* hierarchies (one bookkeeper firm managing 50 client entities with cross-entity dashboards) — that's v1.5+.
- ❌ Bank reconciliation (Xero handles bank rec for v1; v2 = Redbark bank feed)
- ❌ Direct ATO BAS lodgement (regulated, partner play)
- ❌ Multi-currency (AUD-only)
- ❌ MYOB / QuickBooks adapters (Xero only)
- ❌ Customer portal (Looplet CRM has one; integrate via Phase 8)
- ❌ Mobile native app (PWA at most)
- ❌ Double-entry ledger (single-entry, journal-derivable)
- ❌ Complex variation/change-order workflow (v1.5)
- ❌ Retentions held back (v2)
- ❌ Progress claims / staged invoicing (v1.5)
- ❌ AI-driven anomaly detection / fraud flags (v1.5+)
- ❌ Sub-account hierarchies / inter-company transactions (never, or v3)

If a customer asks for any of these in v1: write the request down, thank
them, ship without it. The "no" is the product.

---

## Success metrics

What "good" looks like at each phase.

| Phase | Metric | Target |
|---|---|---|
| 0 | Decisions locked | 4/4 in writing |
| 1 | Scaffold green | `npm run dev` works, login works, dashboard renders |
| 2 | Schema clean | Migration runs, RLS verified, sample data inserts |
| 3 | OCR e2e | Real PDF → "attach to job" → Xero stub in <30s |
| 4 | "What's really yours" | AFGC's job 1090 shows correct take-home, ±0.5% vs Jaime's manual |
| 5 | Prod-ready | Sentry alerting, audit log capturing, backup tested |
| 6 | AFGC live on Postgres | 50+ bills through new product, Mongo prototype decommissioned (it never held production data — its code lives on as ported edge functions) |
| 7 | Beta | 4 paying customers, NPS ≥ 30 |
| 8 | CRM connected | One AFGC job's "really yours" number visible in CRM |

---

## Critical paths

| What | Path |
|---|---|
| This roadmap | `docs/LOOPLET_ACCOUNTING_PRODUCT.md` |
| Decision records | `docs/decisions/000{1,2,3,4}-*.md` (to be created Phase 0) |
| Loopletnumero v1 plan (Mongo prototype — **superseded by this roadmap**, kept for reference) | `docs/LOOPLET_ACCOUNTING_TODO.md` |
| Glossary | `docs/architecture/00-glossary.md` |
| New product repo | `C:\repos\looplet-accounting\` (to be created Phase 1) |
| New product Supabase | `dxoikltymmknxqpkpyhi` (wiped, ready) |
| Looplet CRM (deferred to Phase 8) | `Looplet-main.zip` in Downloads |
| Existing CRM Supabase (untouched) | `afytnccutuurafmeymud` |

---

## What this list is NOT

- Not aspirational. Every task is a doable thing.
- Not a wishlist. The 210+ Looplet feature list is parked until v2.
- Not a Gantt chart. Phases are sequential dependencies, not calendar dates.
- Not negotiable on Phase 0. Decisions before code, not the other way round.
- Not a contract with anyone but yourself. Edit it freely as you learn.

**Last reviewed:** 2026-05-01
**Next review:** when Phase 0 is complete (this week)

---

## What's been delivered in this plan (2026-05-01 close-out)

**Decisions locked (Phase 0):**

| ADR | Topic | Status | File |
|---|---|---|---|
| 0001 | Loaded hourly rate formula | ✅ Decided (net productive hours, ~$46.75/hr loaded for typical AU FT worker) | [docs/decisions/0001-loaded-hourly-rate.md](decisions/0001-loaded-hourly-rate.md) |
| 0002 | Daily overhead allocation | ✅ Decided (proportional to job-hours that day) | [docs/decisions/0002-overhead-allocation.md](decisions/0002-overhead-allocation.md) |
| 0003 | Tax set-aside formula | ✅ Decided (25% default of net profit, configurable) | [docs/decisions/0003-tax-set-aside.md](decisions/0003-tax-set-aside.md) |
| 0004 | AFGC baseline figures | 🟡 Template ready, **needs Daniel to fill in TBDs** | [docs/decisions/0004-afgc-baseline-figures.md](decisions/0004-afgc-baseline-figures.md) |

**Schema (Phase 2):**

- Single SQL migration file ready to apply: [docs/looplet-accounting/migrations/0001_initial_schema.sql](looplet-accounting/migrations/0001_initial_schema.sql)
- 17 tables + system_defaults seed
- 3 custom helper functions (get_accessible_org_ids, set_updated_at, write_audit_log, block_modifications, check_period_lock)
- 10 custom enum types
- RLS enabled on every table with policies generated by DO blocks
- Audit + updated_at triggers applied to every business table via DO block
- Period-lock triggers on financial tables (bills, customer_invoices, wage_entries)
- Append-only enforcement on audit_log + xero_sync_log + crm_sync_log
- Multi-tenant from line 1 — agency hierarchy supported via parent_organization_id
- All money in BIGINT cents, all timestamps TIMESTAMPTZ, currency_code on monetary tables
- Standard preamble pattern documented in code; every business table follows it

**What's ready to execute (in order, when you're ready):**

1. **Daniel fills ADR 0004** with AFGC's real numbers (5 hours)
2. **Create the new repo** at `C:\repos\looplet-accounting\` (Phase 1)
3. **Apply the migration** to the wiped Supabase project — the SQL file is ready
4. **Tenant isolation tests** — write the CI tests per Phase 1.5
5. **Phase 3 — port the working OCR/Xero pieces from Loopletnumero**

**Status check at close:**

- ✅ `dxoikltymmknxqpkpyhi` is wiped and ready to receive the new schema
- ✅ Architecture is locked (multi-tenant, Looplet-as-SoT, single-shot Xero push, deep-scale P&L)
- ✅ CRM org structure copied — Phase 8 alignment will be a name match
- ✅ Foundational disciplines documented and applied (UUID, cents, RLS, audit)
- 🟡 ADR 0004 (AFGC baseline figures) is the only Phase 0 item still needing input
- 🟡 Phase 1 (scaffold new repo + apply migration) hasn't started — needs Daniel to spin up the repo

The plan is coherent end-to-end. From here, execution is mostly mechanical: write code that matches the spec. The hard thinking is done.
