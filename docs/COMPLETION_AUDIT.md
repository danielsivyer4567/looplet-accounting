# Looplet Accounting — Completion Audit

**Date:** 2026-05-06
**Org under test:** Affordable Fencing Gold Coast (`9d5c9b9a-…`)
**Scope:** 25 modules × 12 dimensions, plus pipeline traces and DB-state cross-check.

---

## 2026-06-29 Wrap-up Addendum

This document is now a historical May 6 baseline, not the current release
scorecard. Current wrap-up evidence changes these conclusions:

- **Reconciliation invoice-side:** code and live DB hardening are done. The UI
  matches bank inflows to invoices and caps settlement at the lesser of the bank
  inflow and invoice balance. Live `0196_harden_invoice_reconciliation.sql`
  proof shows hardened AR grants, invoice-payment validation, triggers, and a
  security-invoker invoice match view. Remaining proof is a signed-in live
  invoice/payment smoke with real AR data.
- **Receipt Hub:** the Receipt Tag/Web NFC carrier and WhatsApp delivery scope
  have landed. The NFC read path was later corrected to wait for the `reading`
  event or timeout, and Chromium/Firefox desktop/mobile smoke passed with no
  console/page errors or horizontal overflow. Receipt functions and sync cron
  are deployed. A deploy-gated `tests/receipt-hub-live-smoke.test.ts` now
  encodes the signed-in SC-13 proof path: issue a receipt identity, call the
  deployed `receipt-webhook`, verify the persisted event, bill, line item, audit
  JSON, generic API sync job, and user RLS visibility, then clean up smoke data.
  Fresh live counts still show no end-to-end receipt data
  (`receipt_events=0`, `receipt_sync_jobs=0`) and no enabled
  `receipt_sync_endpoints`/`xero_integrations`, so the remaining blocker is live
  data/integration setup plus a real signed-in test JWT/org.
- **Legal RAG / Horizon:** schema and edge-function surfaces are live, including
  legal corpus/reference tables, advice-note RPCs, `legal-horizon-run`, and
  hardened legal table grants. The corpus now has all six registered official
  FRL Acts live-proven with embeddings and search proof; Legal Horizon still
  needs a real scanner run with valid scanner secret, and Ask still needs a
  signed-in proof that a real answer returns corpus `citations[]`.
- **Legal RAG seed proof:** a fresh source-material/secret check on 2026-06-29
  found no local NotebookLM/legal source text bundle. The linked project now has
  `OPENAI_API_KEY` and `LEGAL_SYNC_SECRET` configured, but still does not have
  `LEGAL_INGEST_SECRET` or `LEGAL_SCAN_SECRET` configured by those names. The
  scanner provider key is present. The `legal-corpus-sync` FRL fetch path now
  resolves official `/latest/text` EPUB HTML documents, strips markup/table of
  sections noise, and extracts compilation-date/version metadata; a local
  live-source proof against the current ITAA 1997 FRL page produced 5,956
  chunks and found `s 8-1 General deductions`. The updated bundle is deployed as
  `legal-corpus-sync` version 23, with `legal-corpus-ingest` active as version
  24, and supports resumable `chunk_offset`/`chunk_limit`
  processing for large Acts. The live FBT sync returned HTTP 200 with
  `chunks=391`, `inserted=385`, `unchanged=6`, and all 391 current FBT corpus
  rows have embeddings. The live GST sync completed across 14 windows:
  `processed=1042`, `inserted=365`, `unchanged=677`, with all 1,042 current GST
  corpus rows embedded. The SIS Act has 798 current embedded rows, ITAA 1936
  has 1,334, TAA 1953 has 1,692, and ITAA 1997 has 6,183. `match_legal_corpus`
  returned the expected section at similarity `1.0000` for FBT `s 47 [1]`, GST
  `s 9-5`, SIS `s 62`, ITAA 1936 `s 109N`, TAA `s 284-75`, and ITAA 1997
  `s 8-1`. The TAA source URL was corrected by `0198_fix_taa_legal_source_url`
  from a dead FRL title shell to the principal `C1953A00001` series, and the
  shared upsert now pages current corpus rows past PostgREST's 1,000-row cap so
  large-source resume does not duplicate existing sections. The generic ATO
  legal database landing page
  remains unsuitable for scheduled sync and is now refused until a specific ATO
  document URL, feed URL, or provided-text path is used intentionally.
- **Repeatable live blocker audit:** `npm run wrap:live-audit` now checks the
  linked project without printing secret values or Supabase secret digests. On
  2026-06-29 it passed: `advisor`, `receipt-webhook`, `legal-corpus-sync`, and
  `gmail-pubsub-push` returned CORS-capable OPTIONS 200; selected functions
  including Advisor, Receipt Hub, Legal Corpus, Legal Horizon, Gmail Pub/Sub,
  and Xero push/sync paths were active; live secret-name presence was true for
  `PERPLEXITY_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `GMAIL_CLIENT_ID`,
  `GMAIL_CLIENT_SECRET`, `GMAIL_PUBSUB_TOPIC`, `GMAIL_PUSH_VERIFY_TOKEN`, and
  `GMAIL_WATCH_RENEW_CRON_SECRET`, `BANK_SYNC_ALL_CRON_SECRET`,
  `NOTIFICATIONS_CRON_SECRET`, `ACCOUNTANT_SESSION_DIGEST_CRON_SECRET`, and
  `OPENAI_API_KEY` and `LEGAL_SYNC_SECRET`, and false for
  `LEGAL_INGEST_SECRET` and `LEGAL_SCAN_SECRET`. The signed-in Advisor and
  Receipt Hub smoke tests remain locally unrunnable until
  `SUPABASE_SERVICE_ROLE_KEY`, `TEST_USER_JWT`, and `TEST_ORG_ID` are supplied
  to the test environment.
- **Gmail Pub/Sub:** the May 6 "handler stub" finding is no longer current.
  `gmail-pubsub-push` now replays Gmail history deltas, downloads accepted
  invoice attachments, applies intake rules, creates `bills`, dispatches
  `bills-extract`, shares a Gmail message-id duplicate guard with backfill, and
  only advances `last_history_id` after the delta is durably handled. Focused
  Deno tests cover the duplicate guard and retryable-ingest classification, the
  touched Edge modules pass `deno check`, and the hardened function is active
  live as version 48. The live audit also proves the public push endpoint fails
  closed with HTTP 401 when called without `GMAIL_PUSH_VERIFY_TOKEN`.
- **Bank/notification cron auth:** the May 6/June ledger finding that cron
  functions trusted an unverified JWT payload for `role=service_role` is fixed
  live. A shared exact-match auth helper now gates service-role bearer and cron
  secrets, with focused Deno tests proving forged JWT rejection. `bank-sync` is
  active as version 43, `bank-sync-all` as version 41, and
  `notifications-cron` as version 38. The live audit proves forged
  `bank-sync` service-role JWT returns HTTP 401, unsigned `bank-sync-all` and
  `notifications-cron` return HTTP 403, both cron secret names exist in
  Supabase, and the functions are active. `bank-sync-all` was also rescheduled
  from the old no-auth cron to active cron job 14, which reads a scoped secret
  from Supabase Vault; direct and DB-side `pg_net` probes returned HTTP 200 with
  `ok=true`, `orgs=0`.
- **Accountant digest cron auth:** the prior 10-minute 401 loop is fixed live.
  `accountant-session-digest` is active as version 33 with `verify_jwt=false`;
  cron mode now requires exact `ACCOUNTANT_SESSION_DIGEST_CRON_SECRET` or
  service-role bearer, while browser/on-demand modes still verify the caller JWT
  inside the function before reading sessions or activity. The live audit proves
  unsigned cron-mode POST returns HTTP 403 and the scoped secret name exists in
  Supabase. The live cron was rescheduled to active job 15, which reads a scoped
  secret from Supabase Vault; a DB-side `pg_net` probe returned HTTP 200 with
  `ok=true`, `sent=0`, `failed=0`. The first scheduled post-fix run at
  `2026-06-28T20:00:00Z` also returned HTTP 200 with `sent=0`, `failed=0`.
  A fresh `cron_health_summary()` query at `2026-06-28T20:19:13Z` showed
  `http_failures_24h=41` (`401=35`, `403=6`) from historical failures while
  current cron `last_run_pg_status` values were succeeding where jobs had fired;
  clean-window cron health remains a separate follow-up until that 24-hour
  window ages out.
- **Core cron registration:** the live `bank-sync-all`,
  `notifications-cron-nightly`, and `accountant-digest-cron` schedules are now
  tracked by `0197_track_vault_backed_cron_schedules.sql`. `NOTIFICATIONS_CRON_SECRET`
  was rotated into a fresh scoped value stored in both Edge Function secrets and
  Supabase Vault as `notifications_cron_secret`. Live verification shows all
  three core cron commands are active, use `vault.decrypted_secrets`, use a
  `secret=` parameter, and contain no `<...>` placeholders. Version `0197` is
  recorded in `supabase_migrations.schema_migrations`; the CLI
  `supabase migration list --linked` path remains unavailable locally without
  `SUPABASE_DB_PASSWORD`.
- **Advisor:** deployed with JWT enabled and local Deno/model tests passing, but
  still needs a signed-in Ask/on-demand smoke proving a live `advice_notes` draft
  row is created. A deploy-gated `tests/advisor-live-smoke.test.ts` now encodes
  that proof path, but it requires a real `TEST_USER_JWT`, `TEST_ORG_ID`, and
  service-role cleanup key. Public sign-up was rate-limited during the
  2026-06-29 wrap-up pass, so this was not completed unattended.
- **Migration state:** missing live DDL for `0181`-`0187` was applied and verified
  on 2026-06-29. The timestamp-version drift for known-applied rows was repaired
  afterwards, then the remaining local-only ranges `0138`-`0150` and
  `0154`-`0177` were applied/verified live and recorded in history. The Supabase
  migration list now lines up for every local migration through `0196`, and a
  dry run of `supabase db push` returns `Remote database is up to date.`
- **Fresh local gates:** after the wrap-up DB/doc work, `npm run format:check`,
  `npm run typecheck`, `npm run lint`, `npm run test`, and `npm run build` all
  passed on 2026-06-29. The build still emits the pre-existing pdfjs dynamic
  import warning and a large main-chunk warning.
- **Fresh live blocker counts:** `legal_sources=7`, `legal_corpus=11440`,
  `legal_change_events=10757`, `legal_horizon=0`, `advice_notes=1`,
  `receipt_events=0`, enabled `receipt_sync_endpoints=0`, and enabled
  `xero_integrations=0`. A focused Receipt Hub check also found
  `receipt_identities=3` and `receipt_sync_jobs=0`; the receipt sync drain cron
  is active, but there is no live receipt chain data yet. The one advice note is
  a `structuring` draft created 2026-06-28; without a signed-in Ask/browser
  trace, it narrows but does not complete the advisor workflow proof.
- **Stale P1 corrections from repo inspection:** the original May 6 P1 list
  still contains several items that are now code-complete. `/customers` has a
  New customer flow, `/jobs` has a New job flow, Triage has bulk
  high-confidence approval/dismissal controls, bill detail has inline edit/save,
  `MoveToOrgButton` is wired on the bill/invoice/job/customer/supplier detail
  pages, and subscription, debt/payment, and employee detail pages exist. These
  still need normal release proof where they touch UI or live data, but they
  should no longer drive rebuild work.
- **Tenant-isolation gate correction:** the May 6 audit item that described
  `tests/tenant-isolation.test.ts` as an inert `describe.skip` is now stale.
  The suite self-seeds two orgs, signs in through anon-key clients, asserts
  cross-tenant invisibility, and `.github/workflows/ci.yml` runs it as a
  dedicated deploy-blocker job. Local no-secret verification on 2026-06-29
  skipped 1 file / 6 tests by design; in CI the test throws before collection if
  the required Supabase env is missing.
- **Local UX proof added:** Dashboard now has a pending onboarding-triage CTA
  backed by a progress-only `onboarding_progress` hook, and OrgProfile has a
  focused component test proving ABN plus `organizations.settings` are written
  back on save. Debt detail now has focused proof for `debt_payments` insert
  payloads plus principal balance reduction, and subscription detail has focused
  proof for status/cadence/notes/personal-classification save payloads. Employee
  detail now has focused proof for inline timesheet updates and new log-time
  inserts, and `MoveToOrgButton` now has focused proof for exact cross-org update
  payloads including FK clearing. Focused tests passed for `OrgProfile.test.tsx`,
  `Dashboard.test.tsx`, `DebtDetail.test.tsx`, `SubscriptionDetail.test.tsx`,
  `EmployeeDetail.test.tsx`, and `MoveToOrgButton.test.tsx` on 2026-06-29; full
  `npm run test` then passed at 36 passed / 16 skipped files and 171 passed / 33
  skipped tests. `npm run build` also passed with the known pdfjs dynamic-import
  and large chunk warnings.
- **Local browser proof added:** `npm run wrap:visual-smoke` now mounts the
  changed local UX surfaces in a deterministic Chromium harness, performs the
  Dashboard triage, OrgProfile save, debt payment, subscription edit, employee
  timesheet/log-time, and multi-org move interactions, and captures screenshots
  under
  `.claude/scratch/wrap-up-local-visual-smoke/2026-06-28T19-21-08-902Z/screenshots/`.
  The run returned all checks true with no browser console or page errors. This
  is local mocked browser proof; signed-in production/browser proof remains
  separate.

## TL;DR

**Code: ~70% complete.** The skeleton is whole and correct. RLS, multi-org, intake pipelines, and reconciliation infrastructure all work. The remaining 30% is split across:

- **Real polish:** mobile, pagination, error specificity, export, edit-modes on a few detail pages.
- **External integrations:** Xero bidirectional and Basiq Connect callback completion. Gmail Pub/Sub is now code-complete/live-deployed but still needs a real watched-mailbox event trace before being called end-to-end live-proven. `bank-sync-all` cron auth/scheduling is live-proven, but real bank-feed proof still needs a Basiq feed with transaction backfill.
- **Critical onboarding gaps:** Create-Customer and Create-Job are no longer
  missing; the remaining onboarding gap is guided first-invoice/first-customer
  empty-state flow and signed-in proof that a new user can get from onboarding
  through customer, job, invoice, and payment without SQL.

**Data: ~10% populated.** This is the bigger issue, and not a code bug — most of what looks broken is starvation, not breakage:

- 0 customers, 0 invoices, 0 employees, 0 debts, 0 timesheets, 0 subscriptions, 0 bills marked personal
- 449 staged entities classified by AI but **399 still pending triage** (user hasn't clicked through Triage to create intake_rules)
- 150 bills ingested but only 5 have totals (Gmail mining sweeping up non-bill emails)

The "subscriptions empty" complaint is correct: detection ran, but only 5 bank txns × 1 month is too sparse for a recurring pattern. **The fix is the 7 PDF statements you have queued — once they import, detection will fire and populate.**

---

## Scorecard

Score: 0=missing, 1=stub, 2=partial, 3=working, 4=polished. Cells with `—` are not applicable. ✓ ≥3, ⚠ =2, ✗ ≤1.

| Module                           | Schema | Pipeline | List | Detail | Create | Edit | Del | Multi-org | Empty | Error | Loading | Mobile |
| -------------------------------- | ------ | -------- | ---- | ------ | ------ | ---- | --- | --------- | ----- | ----- | ------- | ------ |
| 1. Auth                          | 4✓     | —        | 4✓   | —      | 4✓     | —    | —   | —         | 3✓    | 3✓    | 3✓      | 2⚠     |
| 2. Onboarding (AutoSetup+Triage) | 3✓     | 3✓       | 3✓   | 3✓     | —      | —    | —   | 3✓        | 2⚠    | 2⚠    | 3✓      | 1✗     |
| 3. Dashboard P&L                 | 4✓     | 4✓       | —    | —      | —      | —    | —   | 3✓        | 3✓    | 3✓    | 3✓      | 2⚠     |
| 4. Bills                         | 4✓     | 4✓       | 4✓   | 4✓     | 4✓     | 3✓   | 3✓  | 4✓        | 3✓    | 3✓    | 4✓      | 2⚠     |
| 5. Allocations                   | 4✓     | 4✓       | 4✓   | —      | —      | —    | —   | —         | 3✓    | 2⚠    | 3✓      | 2⚠     |
| 6. Suppliers                     | 4✓     | 4✓       | 4✓   | 4✓     | 0✗     | 4✓   | 3✓  | 0✗        | 3✓    | 2⚠    | 3✓      | 2⚠     |
| 7. Customers                     | 4✓     | 0✗       | 4✓   | 4✓     | 3✓     | 4✓   | 2⚠  | 0✗        | 2⚠    | 2⚠    | 3✓      | 2⚠     |
| 8. Jobs                          | 4✓     | 2⚠       | 4✓   | 4✓     | 3✓     | 4✓   | 3✓  | 0✗        | 3✓    | 2⚠    | 3✓      | 2⚠     |
| 9. Invoices                      | 4✓     | 4✓       | 4✓   | 4✓     | 4✓     | 4✓   | 3✓  | 0✗        | 3✓    | 2⚠    | 3✓      | 2⚠     |
| 10. Bank — Basiq Connect         | 4✓     | 2⚠       | 3✓   | 1✗     | 3✓     | —    | 1✗  | —         | 3✓    | 2⚠    | 2⚠      | 1✗     |
| 11. Bank — CSV import            | 4✓     | 4✓       | 3✓   | —      | 4✓     | —    | —   | —         | 3✓    | 3✓    | 3✓      | 1✗     |
| 12. Bank — PDF parser            | 4✓     | 3✓       | 3✓   | —      | 4✓     | —    | —   | —         | 2⚠    | 3✓    | 3✓      | 1✗     |
| 13. Bank — Reconciliation        | 4✓     | 3✓       | 4✓   | —      | —      | —    | —   | —         | 3✓    | 3✓    | 3✓      | 2⚠     |
| 14. Bank — Subscription detect   | 4✓     | 4✓       | —    | —      | —      | —    | —   | —         | 3✓    | 3✓    | 3✓      | —      |
| 15. Subscriptions                | 4✓     | 4✓       | 4✓   | 3✓     | —      | 3✓   | 0✗  | 4✓        | 3✓    | 2⚠    | 3✓      | 1✗     |
| 16. Debts                        | 4✓     | 0✗       | 4✓   | 3✓     | 4✓     | 3✓   | 0✗  | 3✓        | 3✓    | 2⚠    | 3✓      | 2⚠     |
| 17. Employees+Timesheets         | 4✓     | 1✗       | 4✓   | 3✓     | 4✓     | 3✓   | 0✗  | 0✗        | 3✓    | 2⚠    | 3✓      | 2⚠     |
| 18. Reports — BAS                | 4✓     | 4✓       | 4✓   | —      | —      | —    | —   | —         | 3✓    | 2⚠    | 3✓      | 2⚠     |
| 19. Reports — Cash flow          | 4✓     | 4✓       | 4✓   | —      | —      | —    | —   | —         | 3✓    | 1✗    | 3✓      | 2⚠     |
| 20. Settings — Org profile       | 4✓     | 3✓       | —    | 3✓     | 4✓     | 4✓   | —   | —         | —     | 2⚠    | 3✓      | 2⚠     |
| 21. Settings — Gmail             | 3✓     | 4✓       | 3✓   | —      | 4✓     | —    | 3✓  | —         | 3✓    | 3✓    | 3✓      | 1✗     |
| 22. Settings — Xero              | 1⚠     | 0✗       | —    | —      | 1⚠     | —    | —   | —         | —     | 0✗    | 0✗      | 0✗     |
| 23. Quality                      | 4✓     | 4✓       | 4✓   | —      | —      | —    | —   | —         | 4✓    | 3✓    | 3✓      | 2⚠     |
| 24. Personal/Business split      | 4✓     | 3✓       | —    | 4✓     | —      | 4✓   | —   | —         | —     | 3✓    | —       | 2⚠     |
| 25. Multi-org allocation         | 4✓     | 3✓       | —    | 4✓     | —      | —    | —   | 4✓        | —     | 3✓    | —       | 1✗     |

**Average score across cells with content:** ~2.9 / 4 = **72% complete**.

---

## Pipeline trace results (Phase D)

| Flow                                         | Result         | Evidence                                                                                                                              |
| -------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Email → Bill → Supplier auto-link**        | ✅ working     | 150 bills ingested; supplier-autolink trigger created 9 suppliers; 14 bills got supplier_id linked                                    |
| **Bills extract → suggested_job**            | ✅ working     | 22 bills have job_id from suggestions, all attached to J0001                                                                          |
| **gmail-mine → AI classify → Triage**        | ⚠ user-blocked | 449 staged_entities exist + classified; **399 still pending** because user hasn't run through Triage. Code works; user behaviour gap. |
| **Bank txn → Reconciliation candidates**     | ⚠ no data      | View `v_bank_match_candidates` exists; 0 matches because no real bills have totals matching the 5 fake txns                           |
| **Bank txn → subscriptions-detect**          | ⚠ no data      | Edge fn deployed; runs after every bank-sync/CSV/PDF; 0 subs detected because only 5 debit txns total (need ≥3 of same merchant)      |
| **Bill marked personal → excluded from BAS** | ⚠ untested     | View filters on `is_personal=false`; 0 bills tagged personal so excluded but not exercised                                            |
| **MoveToOrgButton → row moved**              | ⚠ live-blocked | Local component proof covers update payloads, FK clearing, and debt-row moves; live proof still needs a signed-in user with 2 orgs.   |
| **Timesheet entry → v_job_pnl wages**        | ⚠ no live data | Employee detail tests cover timesheet edit/log-time payloads; live proof still needs real timesheet rows flowing into `v_job_pnl`.    |
| **PDF statement → bank txns + subs**         | ⚠ user-blocked | Pipeline deployed; user hasn't uploaded the 7 queued PDFs                                                                             |

---

## Database state (Phase C)

```
ROW COUNTS                       BILL QUALITY
- bills              150         - total              150
- invoices             0         - with supplier_id    14  (9.3%)
- invoice_line_items   0         - with job_id         22  (14.7%)
- invoice_payments     0         - with total amount    5  (3.3%) ← OCR mostly failed
- suppliers            9         - paid                 0
- customers            0         - personal             0
- jobs                70         - low confidence      66  (44%)
- bank_connections     1         - duplicate groups     0
- bank_accounts        1
- bank_transactions    5         BANK
- subscriptions        0         - matched to bill      0
- debts                0         - matched to invoice   0
- employees            0         - unmatched            5
- timesheet_entries    0         - personal             0
- organizations        1
- gmail_integrations   1         PIPELINES
- staged_entities    449         - subscriptions      0  (need more bank data)
  └ pending          399         - intake_rules       0  (Triage never run to completion)
  └ classified       449         - high-confidence subs  0

ORPHANS                          ORG SETTINGS
- bills_w_bad_supplier  0        - has_abn          false  ← form not saved yet
- bills_w_bad_job       0        - settings_keys     null
- invoices_w_bad_customer  0
- invoice_lines_w_bad_invoice  0
- timesheets_w_bad_employee  0
```

**Healthy:** zero orphan rows, RLS isolating cleanly, triggers firing.
**Starved:** every revenue/payroll/debt table empty, 96% of bills missing totals, intake_rules empty.

---

## Gaps — P0 (broken on arrival)

None. The earlier subagent flagged some but they were false positives:

- ~~`Bills.tsx` joins non-existent `attached_job`~~ — actually present in `useBills.ts:36`
- ~~Triage page is a placeholder~~ — actually fully implemented
- ~~OrgSelector has no Create-org button~~ — actually present at `OrgSelector.tsx:126`

---

## Gaps — P1 (missing core)

Historical May 6 list, kept for context. Current wrap-up work should use the
2026-06-29 addendum and `docs/WRAP_UP_COMPLETION_PLAN.md` before treating any
item below as still missing.

Ordered by original user-visible value:

1. **Resolved 2026-06-29: "+ New customer" button on `/customers`** — `src/pages/Customers.tsx` now exposes a New customer flow, and `src/test/pages/Customers.test.tsx` covers the button, form opening, submit path, and cancel path. Remaining proof: signed-in browser flow against live data.
2. **Resolved 2026-06-29: "+ New job" button on `/jobs`** — `src/pages/Jobs.tsx` now exposes a New job flow. Remaining proof: focused page test coverage and signed-in browser flow against live data.
3. **Resolved 2026-06-29: Triage discoverability/bulk controls** — Dashboard now links directly to `/onboarding/triage` through the progress-only `onboarding_progress` hook, and Triage has bulk approval/dismissal controls for high-confidence AI/Sonar picks. Remaining proof: signed-in browser run with live staged entities.
4. **Resolved 2026-06-29: bill detail Edit mode** — `src/pages/BillDetail.tsx` now supports inline edit/save for supplier, ABN, invoice number, invoice/due dates, totals, GST share, job reference, and notes. Remaining proof: focused page test coverage and signed-in browser edit against a live bill.
5. **Resolved 2026-06-29: org settings write-through** — `src/components/settings/OrgProfile.tsx` saves ABN and `organizations.settings`, and `src/test/components/OrgProfile.test.tsx` proves the update payload. Remaining proof: signed-in settings save against the live org.
6. **Reconciliation invoice-side** — resolved 2026-06-29. The UI matches bank inflows to invoices, caps settlement at `min(bank inflow, invoice balance)`, and `0196_harden_invoice_reconciliation.sql` hardens the RPC, payment validator, AR grants, triggers, and security-invoker match view. Remaining proof: run a signed-in live invoice/payment smoke with real AR data.
7. **Resolved 2026-06-29: MoveToOrgButton wiring** — the move control is wired on bill, invoice, job, customer, supplier, subscription, and debt detail surfaces. `src/test/components/MoveToOrgButton.test.tsx` proves the update payload, FK clearing, and debt-row move behavior. Remaining proof: signed-in browser move with at least two live orgs.
8. **Resolved 2026-06-29: Subscription detail page** — `/subscriptions/:id` exists and supports detail editing; `src/test/pages/SubscriptionDetail.test.tsx` proves status, cadence, notes, and personal/business classification saves. Remaining proof: signed-in browser edit against live subscription data.
9. **Resolved 2026-06-29: Debt detail/payment recording** — debt detail now records payments; `src/test/pages/DebtDetail.test.tsx` proves the `debt_payments` insert payload and principal balance reduction. Remaining proof: signed-in browser payment against live debt data.
10. **Resolved 2026-06-29: Employee detail/timesheet edit** — employee detail now supports inline timesheet edits and new log-time entries; `src/test/pages/EmployeeDetail.test.tsx` proves cost recomputation, loaded rate, job, entry type, notes, and org/employee IDs. Remaining proof: signed-in browser edit against live employee/timesheet data.
11. **Basiq Connect callback path incomplete** — `bank-link-token` mints; `BankCallback.tsx` is shallow; doesn't reliably fetch initial transaction backfill after first connect. Fix: ~1 h.
12. **gmail-pubsub-push handler is a stub** — resolved 2026-06-29. The live
    version 48 handler replays Gmail history deltas, creates bill rows for
    accepted attachments, dispatches extraction, fails closed without the push
    token, dedupes Gmail message IDs across push/backfill overlap, and leaves
    `last_history_id` unchanged on retryable ingest failures so a later push can
    replay safely. Remaining proof: capture a real watched-mailbox Pub/Sub
    event trace against live Gmail.
13. **xero-oauth pair coded, not wired** — buttons missing from Settings. Even if wired, no `xero-sync-bills` / `xero-sync-invoices` edge fns exist. Fix: ~4-8 h (deferred, multi-day).

---

## Gaps — P2 (missing polish)

Ordered roughly by frequency-of-friction:

- **Mobile layout** — sidebar fixed at 220px, tables don't scroll horizontally, no `@media` breakpoints. Fix: ~2 h global pass.
- **No pagination on Bills/Invoices/Suppliers tables** — currently `select('*')` with no limit. Fine at 150 rows, breaks at 5k. Fix: cursor pagination ~1 h.
- **Loading states are "Loading…" text** — replace with skeleton cards matching page layout. Fix: ~1 h.
- **Error states say "Failed to load"** — propagate `error.message`, distinguish auth/network/RLS/validation. Fix: ~1 h.
- **No archive/restore UI** — `deleted_at` column exists, no way to soft-delete from the UI. Fix: ~30 min.
- **No CSV/PDF export on reports** — BAS and Cash Flow are tables-only. Fix: ~1 h each.
- **Job P&L has no trend chart** — KPIs only. Add sparkline for margin trend. Fix: ~1 h.
- **Invoice line items don't support `zero` GST treatment** — only `inc/ex/free`. Add for tax-free supplies. Fix: 5 min.
- **Cash flow forecast has no opening balance** — assumes $0 starting bank balance. Add seed from `bank_accounts.current_balance_cents`. Fix: ~30 min.
- **Allocations queue has no bill preview** — clicking opens detail page; would be nicer to side-pane the PDF. Fix: ~1 h.
- **Subscriptions table cramped on mobile** — 10 columns. Card layout below 768px. Fix: ~30 min.
- **Settings "Coming next" list** — replace static bullets with linkable issues / a roadmap doc. Fix: 5 min.

---

## Gaps — P3 (deferred / multi-day)

These are big enough to warrant their own sprint, not lumped in here:

- **Xero bidirectional sync** — push bills as ACCPAY, push invoices as ACCREC, pull payments. ~1-2 days.
- **Full payroll** — PAYG withholding tables, super contributions, STP file format. ~2 days.
- **Balance sheet** — needs a general-ledger model first (not yet designed). ~2 days.
- **Annual Tax summary** — depends on personal/business split being thoroughly applied; ATO-aligned categories. ~1 day.
- **Audit log + Team RBAC** — new tables, middleware, role checks. ~1 day.
- **Notification system** — channel preferences, delivery (email/in-app), templating. ~1 day.
- **Auto-routing rules engine** — `intake_rules.matcher_value` regex → `organization_id` override. ~4 h.
- **Split allocation** — one bill across multiple businesses with %. Schema change + UI + report-side handling. ~1 day.
- **Recurring bill detection** — sister of subscription detection but for inbound invoices. ~4 h.
- **ABA payment runs** — select bills due → generate ABA file → mark paid. ~4 h.

---

## Pipeline / function inventory

**Wired and working:**

- `bills-extract`, `bills-extract-batch`, `bills-attach`
- `gmail-oauth-start`, `gmail-oauth-callback`, `gmail-mine`, `gmail-classify-ai`, `gmail-watch-renew`, `gmail-pubsub-push`
- `bank-link-token`, `bank-exchange`, `bank-sync`, `bank-sync-all`, `bank-webhook`, `bank-csv-import`, `bank-statement-extract`
- `subscriptions-detect` (fires after every bank ingest)
- `xero-oauth-start`, `xero-oauth-callback` (deployed but UI never invokes)

**Triggers / DB-side automation:**

- `bills_autolink_supplier` — auto-creates + links supplier on bill insert/update (working)
- `invoices_assign_number` — auto-numbers invoices `INV-NNNN`
- `invoices_recompute_totals` — line items → invoice totals
- `invoices_apply_payment` — payment → status flip + paid_at
- `timesheet_recompute_cost` — hours × rate

**Views:**

- `v_organization_realtime_pnl`, `v_job_pnl`, `v_customer_pnl`
- `v_bas_quarterly`, `v_cash_flow_weekly`
- `v_bank_match_candidates`
- `v_personal_expenses`, `v_personal_bank_expenses`
- `v_duplicate_bills`, `v_low_confidence_bills`

---

## Migration ledger

| File                                         | Purpose                                                                                                                                                                                |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0001_initial_schema.sql`                    | Core tables, enums, RLS scaffold                                                                                                                                                       |
| `0002_bill_content_hash.sql`                 | `bills.content_sha256` + dedupe index                                                                                                                                                  |
| `0003_financial_views.sql`                   | `v_organization_realtime_pnl`, `v_job_pnl`                                                                                                                                             |
| `0004_bill_routing.sql`                      | `bills.suggested_job_id`, `suggested_match_score`, `job_reference_raw`                                                                                                                 |
| `0028_suppliers_backfill_and_autocreate.sql` | `suppliers.contact_phone` + `current_balance_owing_cents`, normalised-name unique idx, backfill from `bills.supplier_name_raw`, autolink trigger                                       |
| `0029_bank_reconciliation_match_view.sql`    | `v_bank_match_candidates` (amount + date + supplier-substring match)                                                                                                                   |
| `0030_invoices.sql`                          | `invoices`, `invoice_line_items`, `invoice_payments`, `invoice_number_counters`; auto-number, recompute-totals, apply-payment triggers; `invoice_gst_treatment` enum; `v_customer_pnl` |
| `0031_personal_business_split.sql`           | `bills.is_personal`, `bank_transactions.is_personal` + indexes; `v_personal_expenses`, `v_personal_bank_expenses`                                                                      |
| `0032_bas_and_cash_flow_views.sql`           | `au_bas_quarter()` helper; `v_bas_quarterly`, `v_cash_flow_weekly`                                                                                                                     |
| `0033_timesheet_entries.sql`                 | `timesheet_entries` table + RLS + auto-cost trigger                                                                                                                                    |
| `0034_quality_views.sql`                     | `v_duplicate_bills`, `v_low_confidence_bills`                                                                                                                                          |

---

## Recommended next-sprint order

Superseded for the 2026-06-29 wrap-up. Use this order now:

1. **Ledger cleanup** — update audit/status docs so stale May 6 P1 items are
   marked code-complete instead of rebuilt. Tenant isolation is now a
   CI-wired/code-complete gate; it still needs a real GitHub run with secrets
   before being called live-proven.
2. **Focused local proof** — verify org settings write-through,
   Dashboard-to-Triage discoverability, debt payment recording, employee detail,
   subscription detail, and multi-org move behavior. These local UX ledgers now
   have focused test proof; continue with signed-in browser proof and live
   blockers.
3. **Signed-in live proof** — run Advisor and Receipt Hub smoke tests with
   `TEST_USER_JWT`, `TEST_ORG_ID`, and service-role cleanup credentials.
4. **Legal proof** — register specific ATO Legal Database documents/feeds or
   formally defer ATO rulings/determinations, prove corpus citations in Ask,
   then run Legal Horizon.
5. **Data-starvation cleanup** — import queued bank statement PDFs, run
   subscription detection, and process pending triage rows into `intake_rules`.
6. **Integration decisions** — complete or explicitly defer Basiq callback
   backfill, Xero bidirectional sync, and ATO lodgement enablement. Gmail
   Pub/Sub now needs real watched-mailbox proof rather than implementation work.
7. **Release gate** — rerun full local gates, browser smoke critical surfaces,
   re-check live row counts, and label every ledger `live-proven`,
   `code-complete`, `external-blocked`, or `deferred`.

After (1-5) the app is usefully end-to-end on real data.
