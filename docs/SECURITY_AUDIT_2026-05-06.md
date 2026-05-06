# Security Audit — Looplet Accounting (multi-tenant isolation)

**Date:** 2026-05-06
**Scope:** Postgres RLS, Supabase Edge Functions (Deno), React client.
**Auditor:** application-security review focused on cross-org data leakage.
**Repo audited:** `C:\repos\looplet-accounting` (mirror of `crazy-kapitsa-d060fb` worktree).

---

## Executive summary

The schema is built on a sane membership model (`get_accessible_org_ids()`), and most edge functions correctly use a user-scoped client to verify org access before performing service-role writes. However, three structural problems undermine the multi-tenant guarantee:

1. **UPDATE policies have no `WITH CHECK` clause.** A user can change `organization_id` on rows they own to any UUID — the policy only verifies the OLD org, not the NEW one. This is the exact attack `MoveToOrgButton` opens up at the API layer.
2. **Several tables defined post-0001 (`invoices`, `invoice_line_items`, `invoice_payments`, `invoice_number_counters`, plus all `bank_*`, `subscriptions`, `staged_entities`, `intake_rules`, `gmail_integrations`) are not visible in the migrations folder with their RLS policies.** Migration `0030_invoices.sql` creates the tables and explicitly defers policies to "the migration body in DB". They cannot be reviewed from source.
3. **`subscriptions-detect` accepts an `organization_id` from the request body and reads/writes with the service-role key without any membership check.** Any authenticated user can trigger detection (and read the candidate list) for any org id.

Fixes for (1) and (3) are small and high-leverage. (2) is a process problem — RLS that isn't in source-controlled migrations cannot be audited or reproduced in staging.

---

## 1. RLS coverage — High / Medium

### Tables with RLS verified in source (0001 + 0033)

`organizations`, `organization_memberships`, `team_invitations`, `customers`, `suppliers`, `jobs`, `bills`, `bill_line_items`, `customer_invoices`, `customer_invoice_line_items`, `employees`, `wage_entries`, `overhead_profiles`, `overhead_allocations`, `xero_integrations`, `xero_sync_log`, `audit_log`, `period_locks`, `timesheet_entries`. All gate on `organization_id IN (SELECT get_accessible_org_ids())`. Good baseline.

### High — `WITH CHECK` missing on every UPDATE policy

In `0001_initial_schema.sql` lines 720, 731, 761 and `0033_timesheet_entries.sql` line 34, every UPDATE policy uses `USING (...)` without a paired `WITH CHECK (...)`. Postgres semantics: `USING` validates the OLD row, `WITH CHECK` validates the NEW row. With only `USING`, an attacker can `UPDATE bills SET organization_id = '<other-org-uuid>' WHERE id = '<my-bill-id>'` and the policy passes because the OLD `organization_id` is in their accessible list. The new value is not checked.

**Why it matters:** this is exactly the attack `MoveToOrgButton` performs from the UI (intentionally). Same primitive lets a member of org A push a row into a stranger's org C — the row is then invisible to the attacker (now in C) but visible to org C's owners as poisoned data, plus storage_key still references `org-A/...` (see §7).

**Fix:** add `WITH CHECK (organization_id IN (SELECT get_accessible_org_ids()))` to every UPDATE policy. Severity: **High** for `bills`, `invoices`, `customer_invoices`, `bank_transactions` (financial integrity); **Medium** for `customers`, `suppliers`, `jobs` (operational).

### High — invoices/payments/bank_* RLS not in migrations

Migration `0030_invoices.sql` creates `invoices`, `invoice_line_items`, `invoice_payments`, `invoice_number_counters` but contains no `ENABLE ROW LEVEL SECURITY` or `CREATE POLICY` statements; the comment says "see migration body in DB". `bank_connections`, `bank_accounts`, `bank_transactions`, `subscriptions`, `staged_entities`, `intake_rules`, `gmail_integrations` are referenced everywhere by edge functions but have no `CREATE TABLE` in `supabase/migrations/`.

If any of these tables is missing `ENABLE RLS` on the live DB, every authenticated user reads every other tenant's invoices, payments, bank statements, gmail OAuth tokens, etc. **Cannot be confirmed from source.** Treat as High until verified by a `\d+` against production with documented RLS policy text checked into a migration. The `invoice_number_counters` table in particular has no `organization_id` filter pattern in the migration — it's keyed solely by `organization_id` PK, so a missing policy means the counter is globally visible.

### Medium — views likely SECURITY DEFINER

`v_personal_expenses`, `v_personal_bank_expenses`, `v_duplicate_bills`, `v_low_confidence_bills`, `v_bank_invoice_match_candidates` (migrations 0031/0034/0035) aggregate across `organization_id`. On Postgres ≥15 these run as the invoker so RLS applies; on 14 they default to the view owner (often a superuser) and skip RLS. Confirm `security_invoker = true` is set on each view.

---

## 2. Edge function service-role usage — High / Medium

| Function | Membership check before service-role write? | Verdict |
|---|---|---|
| `bills-attach` | yes (userClient SELECT bills + jobs) | OK |
| `bank-csv-import` | yes (userClient SELECT organizations) | OK |
| `bank-sync` | yes (userClient SELECT organizations) — service-role bypasses | OK |
| `bank-statement-extract` | no DB write — pure OCR pass-through | OK |
| `gmail-mine` | yes (userClient SELECT gmail_integrations) | OK |
| `xero-oauth-callback` | yes (userClient SELECT organizations + state CSRF check) | OK |
| `bank-webhook` | shared-secret URL token; service-role only acts on `external_item_id` lookup | OK |
| `gmail-pubsub-push` | shared-secret URL token; integration is looked up by sender's `gmail_address`, not by user input | OK |
| **`subscriptions-detect`** | **NO** — trusts `body.organization_id`, queries `bank_transactions` + writes `subscriptions` with service-role | **High** |
| `bills-extract` | accepts service-role OR user JWT; user path uses RLS-bound dbClient | OK (small caveat below) |
| `gmail-watch-renew` | none — runs over all integrations | Medium |

### High — `subscriptions-detect` trusts caller's `organization_id`

`supabase/functions/subscriptions-detect/index.ts` lines 52-78. The handler requires an `Authorization` header but never verifies the bearer is a member of `body.organization_id`. It builds an `admin` client with the service-role key and reads/upserts. Any authenticated user can:

- Send `{ organization_id: '<victim-uuid>' }` and receive the up-to-50 `candidates` array, which includes raw merchant strings from the victim's bank feed (PII / spending patterns).
- Cause writes to the victim's `subscriptions` table (data-poisoning of someone else's dashboard).

**Fix:** mirror the pattern from `bank-sync`: build a `userClient` with `anonKey + Authorization`, `SELECT id FROM organizations WHERE id = body.organization_id` and 403 on miss. Allow service-role bearer (used by the fire-and-forget caller in `bank-csv-import`/`bank-sync`) to bypass.

### Medium — `gmail-watch-renew` has no auth at all

`--no-verify-jwt` and no `GMAIL_WATCH_RENEW_TOKEN` URL secret. Any anonymous request triggers a sweep of every integration. Impact is bounded (it only refreshes Google watches and writes `last_history_id`) but it is unauthenticated egress to Google's API. Add a URL secret following the `BASIQ_WEBHOOK_VERIFY_TOKEN` pattern.

### Low — `bills-extract` permissive auth path

The function accepts either a user JWT or a service-role key (used by `bills-extract-batch` and `gmail-pubsub-push`). The service-role-detection branch decodes the JWT payload without verifying the signature — an attacker who knows the JWT shape can craft a token with `role: 'service_role'`, but only if Supabase routes the request *and* the function trusts the decoded role. In practice the gateway has already verified the JWT at this point because `verify_jwt` is on, so this is theoretical. Still, the `payload?.role === 'service_role'` shortcut would be safer as a comparison against the env value only.

---

## 3. `MoveToOrgButton` cross-org movement — Medium

`src/components/MoveToOrgButton.tsx` filters the dropdown to orgs the user is a member of, but the actual move is a plain client-side `supabase.from(table).update({ organization_id: targetOrgId })`. RLS is the only barrier. Combined with §1 finding (no `WITH CHECK`), a malicious member of org A can move a row into **any UUID at all**, not just orgs in their dropdown, by bypassing the UI. The component itself is fine; the underlying RLS isn't.

Storage stays behind: see §7 path-traversal note.

---

## 4. Public-token attack surface — Low (currently)

`invoices.public_token UUID` exists (migration `0030_invoices.sql` line 37) with a partial unique index. No edge function reads by `public_token`, no public route serves it. `src/pages/InvoiceDetail.tsx` only mentions it in a comment as a future feature. Current exposure: **none**. When the public payment page lands, ensure: (a) the route uses service-role + `WHERE public_token = $1 AND deleted_at IS NULL` only, (b) the response excludes `internal_notes`, customer PII fields not needed for payment, sibling invoices, and Xero IDs, (c) the token is rotatable (add a `regenerate_public_token` RPC), and (d) rate-limit the route to mitigate UUID-guess + timing.

---

## 5. Webhook auth — Medium

- `bank-webhook` (Basiq): URL token gated by `BASIQ_WEBHOOK_VERIFY_TOKEN`. **OK**, but the env check is wrapped in `if (expectedToken)` — if the secret is unset, auth is skipped and any caller can dispatch a `bank-sync` with arbitrary `connection_id`. Make the env var mandatory.
- `gmail-pubsub-push`: same pattern, same conditional bypass on missing `GMAIL_PUSH_VERIFY_TOKEN`. Make mandatory. Bonus: Pub/Sub also signs with an OIDC token — verifying `Authorization: Bearer <oidc>` against `aud = function URL` would be defence in depth.
- `gmail-watch-renew`: no auth (see §2).

Severity: Medium — secret-not-set fail-open is a deploy-time footgun, not a current vulnerability.

---

## 6. Fire-and-forget service-role calls — Low

`bank-csv-import`, `bank-sync`, `gmail-pubsub-push` invoke `subscriptions-detect` / `bills-extract` / `bank-sync` server-side with `Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}`. The bearer never leaves the edge runtime; it is environment-resident. Acceptable. Two cleanup notes:

- The dispatch URLs are constructed from `Deno.env.get('SUPABASE_URL')` — fine.
- There is no idempotency token on the inter-function call, so a retried Pub/Sub push could double-fire `bills-extract`. The `content_sha256` cache and bill-status guard absorb this; not a security issue.

---

## 7. Storage — Medium

`storage.buckets` row for `bills` is private (per the comment in 0001 line 775). Storage RLS is "authored via the Supabase dashboard" and not in version control — same problem as §1. Three concrete risks:

- **Path traversal:** `bills.storage_key` comes from `gmail-pubsub-push` line 304 as ``org-${integ.organization_id}/${today}/${rand}-${cleanName}``. `cleanName` is sanitised (`replace(/[^a-zA-Z0-9._-]/g, '_')`) so traversal via filename is blocked. Manual upload paths are not in this audit; verify they use the same prefix.
- **Cross-org leak after `MoveToOrgButton`:** when a bill row is moved from org A to org B, `storage_key` still starts with `org-A/`. If the storage RLS policy enforces `name LIKE 'org-' || (current org id) || '/%'`, the new owners cannot read the file (broken UX) — but if the policy is `EXISTS (SELECT 1 FROM bills WHERE bills.storage_key = storage.objects.name AND bills.organization_id IN (...))`, members of A still read the file because they no longer see the bill row. Either way it's wrong. The fix is to copy/rename the object to `org-B/...` when moving.
- **Signed URLs:** confirm `createSignedUrl` callers use ≤ 600s TTL and that public URLs are never generated for the `bills` bucket.

---

## 8. CSV / PDF imports — Low

- `bank-csv-import` parses with a tiny RFC-4180 splitter. No SQL is templated — all writes use the supabase client which parameterises. Description strings are stored verbatim; no XSS risk because the React side will escape on render (verify dangerouslySetInnerHTML is not used in transactions table).
- `bank-statement-extract` ships the rendered-page image to Groq with a fixed system prompt. The image bytes are user-controlled but cannot inject prompt instructions because Groq treats them as image content. The OCR JSON is parsed with `JSON.parse` and then field-validated (`Number.isFinite`, regex date matchers), so a hostile model response cannot smuggle a SQL string into a numeric column.
- **Prompt-injection through OCR text:** `bills-extract` stores `raw_extracted` (full OCR JSON) and `notes` from the model. Downstream consumers must not feed these into an unsandboxed LLM ("ask your accountant" Q&A in the roadmap). Treat OCR output as untrusted in any future LLM call.

---

## Priority fix list

1. **High** — Add `WITH CHECK (organization_id IN (SELECT get_accessible_org_ids()))` to every UPDATE policy across all tenant tables (0001, 0030, 0033 + the un-version-controlled bank/invoice/subscription policies).
2. **High** — Membership-check `subscriptions-detect`. Pattern from `bank-sync` lines 63-74.
3. **High** — Source-control the missing migrations: invoice* RLS, bank_* tables and RLS, subscriptions, staged_entities, intake_rules, gmail_integrations. Re-run on a clean staging DB to prove parity.
4. **Medium** — Make `BASIQ_WEBHOOK_VERIFY_TOKEN` and `GMAIL_PUSH_VERIFY_TOKEN` mandatory (fail closed). Add a token gate to `gmail-watch-renew`.
5. **Medium** — Storage object-key migration on `MoveToOrgButton` (copy to `org-{newOrg}/...`, update `storage_key`, delete original). Confirm storage RLS in version control.
6. **Medium** — Verify all aggregate views are `SECURITY INVOKER`.
7. **Low** — Lock `bills-extract` service-role detection to env-equality only; drop the JWT-claim shortcut.
8. **Low** — Tighten CORS `Access-Control-Allow-Origin` from `*` to the production frontend origin.

OWASP cross-references: A01 Broken Access Control (1, 2, 3, 5), A04 Insecure Design (3, 4), A05 Security Misconfiguration (4, 7, 8), A07 Identification and Authentication Failures (5).
