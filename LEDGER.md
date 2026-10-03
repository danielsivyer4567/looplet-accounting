# Finish-line ledger

**Goal:** Old Looplet Accounting (accounting.looplet.com.au) made legitimate, secure, modern and connected to Redbark bank feeds. Local proof first; production deploys, migrations and credential use need Daniel's explicit yes.

**Progress:** 6/51 verified. Generated from LEDGER.json by ledger.mjs; do not edit by hand.

| ID | Item | Status | Proof |
|---|---|---|---|
| INC-01 | August implant leftovers are gone and build configs pass an integrity check (.cursor, HANDOFF.md, hidden push-script ignores, postcss/vite/tailwind, lifecycle scripts) | verified | verified by claude-verifier (independent subagent) @ ba9534a7 |
| INC-02 | Credentials exposed by the August implant are rotated and recorded (Supabase service-role/JWT secret/DB password/access tokens, Cloudflare token, integration keys, GitHub PATs) | blocked | BLOCKED: Rotation of credentials exposed between 2026-08-08 and 2026-08-29 has not been recorded. (needs: Daniel rotates the Supabase service-role key, JWT secret, DB password and access tokens, the Cloudflare API token (and GitHub repo secrets), Xero/Gmail/Groq/Perplexity/Resend keys, ENCRYPTION_KEY and GitHub PATs, then confirms the rotation record.) |
| SEC-01 | intake-routing-apply accepts only the service role or an accepted member of the target organisation | done | done @ 14127b1e, awaiting independent verify |
| SEC-02 | staged-entities-enrich-sonar, bank-statement-extract, crm-pnl-sync-push and ato-lodge refuse unauthenticated calls | verified | verified by claude-verifier (independent subagent) @ 60b94a38 |
| SEC-03 | Payment-run, ABA export, mark-paid, super-batch and termination functions require an accepted admin or owner | verified | verified by claude-verifier (independent subagent) @ bbdacc04 |
| SEC-04 | Xero and Gmail OAuth state is signed, bound to the user and mandatory on callback | verified | verified by claude-verifier (independent subagent) @ 60b94a38 |
| SEC-05 | Writes to money tables (payees, bills, invoices, journals, period locks, employees, payment runs) need an accountant or admin role; viewers are read-only | done | done @ 6f46b943, awaiting independent verify |
| SEC-06 | CI uses least-privilege permissions, SHA-pinned actions and a deploy job separate from build | open | not run |
| SEC-07 | Hardening: CORS allow-list, constant-time secret checks, bundled pdf.js worker, cron secrets in headers, generic error responses | open | not run |
| PAY-01 | Pay runs calculate wages from the base hourly rate, not the loaded cost rate | done | done @ 702f63c0, awaiting independent verify |
| PAY-02 | Super defaults to the statutory rate (12%) and a pay run never applies less than the SG rate for the pay date | done | done @ 23e8aa88, awaiting independent verify |
| PAY-03 | PAYG withholding uses the financial year of the pay date and fails loudly instead of returning $0 when no table applies | open | not run |
| PAY-04 | FY2026-27 PAYG withholding tables match the ATO schedule (NAT 1004) worked examples | open | not run |
| PAY-05 | Payday Super (from 1 July 2026) drives super due dates instead of quarterly batching | open | not run |
| XERO-01 | Bills and invoices are never marked synced to Xero unless Xero accepted them (no STUB ids in production) | open | not run |
| FAKE-01 | Receipt Hub has no POS simulator, fake receipts or hard-coded demo figures | open | not run |
| FAKE-02 | The Scan page describes only the checks it really runs (no simulated AI audit) | open | not run |
| CONSENT-01 | Settings has no pre-ticked, unsaved or unrelated template consent switches | open | not run |
| LEGAL-01 | A privacy policy, terms of service and collection notice are published, linked, and accepted at sign-up | open | not run |
| AI-01 | AI answers and advice are labelled general information, and the model is allowed to recommend an accountant | open | not run |
| TFN-01 | TFNs are never returned to the browser or stored in plain text | open | not run |
| LODGE-01 | Nothing claims to lodge with the ATO or send to a super fund when it only prepares a file | open | not run |
| BANK-01 | Basiq is fully removed: functions, client, callback page, copy, CSP, MCP entry, env vars and docs | done | done @ 702f63c0, awaiting independent verify |
| BANK-02 | Redbark client pages accounts and transactions, splits truncated date windows, converts dollars to exact cents and skips pending rows | done | done @ 62a46f2a, awaiting independent verify |
| BANK-03 | bank-webhook verifies Redbark signatures and timestamps, stores the event before acting and dispatches one sync per linked connection | done | done @ 6468e475, awaiting independent verify |
| BANK-04 | bank-sync imports Redbark transactions idempotently on (bank account, provider id) and keeps the post-sync chain | done | done @ 62a46f2a, awaiting independent verify |
| BANK-05 | Admins can list Redbark accounts and link each one to a bank account with an import-from date | done | done @ b66e21cf, awaiting independent verify |
| BANK-06 | Redbark migrations apply cleanly and enforce one organisation per Redbark connection | done | done @ 61c93125, awaiting independent verify |
| BANK-07 | Redbark is live: migrations applied, functions deployed, secrets set and the destination delivering into the books | blocked | BLOCKED: Deploying needs a Supabase access token, function secrets and credential rotation first. (needs: Daniel: credential rotation (INC-02), a scoped Supabase access token for project looplet accounting (Database + Edge functions), the Redbark API key and webhook secret entered at a hidden prompt, and an explicit yes to deploy.) |
| STP-01 | Employees TFNs can be captured securely so the STP export can complete | open | not run |
| CSP-01 | PDF previews and the microphone feature work under the production security headers | open | not run |
| BAS-01 | BAS includes credit notes, supports cash basis and computes W3/W4 instead of hard-coded zeros | open | not run |
| GST-01 | No GST credit is invented when GST is missing or the supplier is not GST-registered | open | not run |
| TAX-01 | The tax set-aside uses GST-exclusive figures for one financial year | open | not run |
| INV-01 | Invoices can be issued as a tax invoice (PDF with "Tax invoice", ABN and GST) and sent | open | not run |
| DATE-01 | Default dates use Australian local time, not UTC | open | not run |
| SEED-01 | New organisations do not inherit the pilot business known-sender list | open | not run |
| XERO-02 | The Xero bank pull writes schema-valid rows (real connection, valid account type) | open | not run |
| BS-01 | The balance sheet does not count credit-card and loan balances as both cash and debts | open | not run |
| CI-01 | CI runs the Deno edge-function tests and reports environment-gated test files instead of skipping them silently | open | not run |
| UI-01 | Light theme polish: themed colours everywhere, no hard-coded dark-only colours, auth screens in the new style | open | not run |
| UI-02 | Shared PageHeader, Stat, StatusBadge, EmptyState, Alert and Field replace page-local copies | open | not run |
| UI-03 | Modern app shell: labelled sectioned sidebar, top bar with breadcrumbs, org switcher, user menu, command palette | open | not run |
| UI-04 | Accessibility: contrast-safe colour tokens, keyboard focus everywhere, labelled icon buttons, no text under 11px | open | not run |
| SHIP | Ship gate: typecheck, lint, the full test suite (Vitest and Deno) and the production build all pass | open | not run |
| DEPLOY | Production (accounting.looplet.com.au and the edge functions) serves the verified build after Daniel says go | blocked | BLOCKED: Production changes need the owner's explicit approval. (needs: Daniel reviews screenshots and the verified ledger, then says go for the production deploy.) |
| SEC-08 | bills-allocate-batch checks the caller's own accepted membership and needs accountant or higher to change allocations | verified | verified by claude-verifier (independent subagent) @ bbdacc04 |
| SEC-09 | accountant-email-query matches the sender's accepted accountant memberships by role_enum, so the emailed activity digest works | verified | verified by claude-verifier (independent subagent) @ bbdacc04 |
| MIG-01 | Every migration applies in order to a fresh database, so the history can rebuild the schema (no known failures left) | open | not run |
| SEC-10 | SECURITY DEFINER functions that users call and that write money tables check the caller's role | done | done @ 6f46b943, awaiting independent verify |
| SEC-11 | Bills only reference suppliers of their own organisation, so payment runs never copy another organisation's payee bank details | done | done @ 6f46b943, awaiting independent verify |

Acceptance commands, every run, exit codes and log hashes are in LEDGER.json; logs are in .ledger/logs/.
