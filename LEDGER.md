# Finish-line ledger

**Goal:** Old Looplet Accounting (accounting.looplet.com.au) made legitimate, secure, modern and connected to Redbark bank feeds. Local proof first; production deploys, migrations and credential use need Daniel's explicit yes.

**Progress:** 15/57 verified. Generated from LEDGER.json by ledger.mjs; do not edit by hand.

| ID | Item | Status | Proof |
|---|---|---|---|
| INC-01 | August implant leftovers are gone and build configs pass an integrity check (.cursor, HANDOFF.md, hidden push-script ignores, postcss/vite/tailwind, lifecycle scripts) | verified | verified by claude-verifier (independent subagent) @ ba9534a7 |
| INC-02 | Credentials exposed by the August implant are rotated and recorded (Supabase service-role/JWT secret/DB password/access tokens, Cloudflare token, integration keys, GitHub PATs) | blocked | BLOCKED: Rotation of credentials exposed between 2026-08-08 and 2026-08-29 has not been recorded. (needs: Daniel rotates the Supabase service-role key, JWT secret, DB password and access tokens, the Cloudflare API token (and GitHub repo secrets), Xero/Gmail/Groq/Perplexity/Resend keys, ENCRYPTION_KEY and GitHub PATs, then confirms the rotation record.) |
| SEC-01 | intake-routing-apply accepts only the service role or an accepted member of the target organisation | done | done @ dfc8a06f, awaiting independent verify |
| SEC-02 | staged-entities-enrich-sonar, bank-statement-extract, crm-pnl-sync-push and ato-lodge refuse unauthenticated calls | verified | verified by claude-verifier (independent subagent) @ 6da4d8b8 |
| SEC-03 | Payment-run, ABA export, mark-paid, super-batch and termination functions require an accepted admin or owner | verified | verified by claude-verifier (independent subagent) @ 6da4d8b8 |
| SEC-04 | Xero and Gmail OAuth state is signed, bound to the user and mandatory on callback | verified | verified by claude-verifier (independent subagent) @ 60b94a38 |
| SEC-05 | Writes to money tables (payees, bills, invoices, journals, period locks, employees, payment runs) need an accountant or admin role; viewers are read-only | done | done @ 56e21d96, awaiting independent verify |
| SEC-06 | CI uses least-privilege permissions, SHA-pinned actions and a deploy job separate from build | verified | verified by claude-verifier (independent subagent) @ 6da4d8b8 |
| SEC-07 | Hardening: CORS allow-list, constant-time secret checks, bundled pdf.js worker, cron secrets in headers, generic error responses | done | done @ dfc8a06f, awaiting independent verify |
| PAY-01 | Pay runs calculate wages from the base hourly rate, not the loaded cost rate | verified | verified by claude-verifier (independent subagent) @ 6da4d8b8 |
| PAY-02 | Super defaults to the statutory rate (12%) and a pay run never applies less than the SG rate for the pay date | done | done @ 10b7b1d6, awaiting independent verify |
| PAY-03 | PAYG withholding uses the financial year of the pay date and fails loudly instead of returning $0 when no table applies | done | done @ 56e21d96, awaiting independent verify |
| PAY-04 | FY2026-27 PAYG withholding tables match the ATO schedule (NAT 1004) worked examples | done | done @ 56e21d96, awaiting independent verify |
| PAY-05 | Payday Super (from 1 July 2026) drives super due dates instead of quarterly batching | done | done @ 10b7b1d6, awaiting independent verify |
| XERO-01 | Bills and invoices are never marked synced to Xero unless Xero accepted them (no STUB ids in production) | verified | verified by claude-verifier (independent subagent) @ 6da4d8b8 |
| FAKE-01 | Receipt Hub has no POS simulator, fake receipts or hard-coded demo figures | done | done @ 10b7b1d6, awaiting independent verify |
| FAKE-02 | The Scan page describes only the checks it really runs (no simulated AI audit) | done | done @ 10b7b1d6, awaiting independent verify |
| CONSENT-01 | Settings has no pre-ticked, unsaved or unrelated template consent switches | done | done @ 10b7b1d6, awaiting independent verify |
| LEGAL-01 | A privacy policy, terms of service and collection notice are published, linked, and accepted at sign-up | done | done @ 10b7b1d6, awaiting independent verify |
| AI-01 | AI answers and advice are labelled general information, and the model is allowed to recommend an accountant | done | done @ 10b7b1d6, awaiting independent verify |
| TFN-01 | TFNs are never returned to the browser or stored in plain text | done | done @ 10b7b1d6, awaiting independent verify |
| LODGE-01 | Nothing claims to lodge with the ATO or send to a super fund when it only prepares a file | done | done @ 10b7b1d6, awaiting independent verify |
| BANK-01 | Basiq is fully removed: functions, client, callback page, copy, CSP, MCP entry, env vars and docs | done | done @ dfc8a06f, awaiting independent verify |
| BANK-02 | Redbark client pages accounts and transactions, splits truncated date windows, converts dollars to exact cents and skips pending rows | verified | verified by claude-verifier (independent subagent) @ 6da4d8b8 |
| BANK-03 | bank-webhook verifies Redbark signatures and timestamps, stores the event before acting and dispatches one sync per linked connection | verified | verified by claude-verifier (independent subagent) @ 6da4d8b8 |
| BANK-04 | bank-sync imports Redbark transactions idempotently on (bank account, provider id) and keeps the post-sync chain | verified | verified by claude-verifier (independent subagent) @ 6da4d8b8 |
| BANK-05 | Admins can list Redbark accounts and link each one to a bank account with an import-from date | done | done @ 10b7b1d6, awaiting independent verify |
| BANK-06 | Redbark migrations apply cleanly and enforce one organisation per Redbark connection | done | done @ 56e21d96, awaiting independent verify |
| BANK-07 | Redbark is live: migrations applied, functions deployed, secrets set and the destination delivering into the books | blocked | BLOCKED: Deploying needs a Supabase access token, function secrets and credential rotation first. (needs: Daniel: credential rotation (INC-02), a scoped Supabase access token for project looplet accounting (Database + Edge functions), the Redbark API key and webhook secret entered at a hidden prompt, and an explicit yes to deploy.) |
| STP-01 | Employees TFNs can be captured securely so the STP export can complete | done | done @ 10b7b1d6, awaiting independent verify |
| CSP-01 | PDF previews and the microphone feature work under the production security headers | verified | verified by claude-verifier (independent subagent) @ 6da4d8b8 |
| BAS-01 | BAS includes credit notes, supports cash basis and computes W3/W4 instead of hard-coded zeros | done | done @ 56e21d96, awaiting independent verify |
| GST-01 | No GST credit is invented when GST is missing or the supplier is not GST-registered | done | done @ 10b7b1d6, awaiting independent verify |
| TAX-01 | The tax set-aside uses GST-exclusive figures for one financial year | done | done @ 56e21d96, awaiting independent verify |
| INV-01 | Invoices can be issued as a tax invoice (PDF with "Tax invoice", ABN and GST) and sent | done | done @ 10b7b1d6, awaiting independent verify |
| DATE-01 | Default dates use Australian local time, not UTC | done | done @ 10b7b1d6, awaiting independent verify |
| SEED-01 | New organisations do not inherit the pilot business known-sender list | done | done @ 56e21d96, awaiting independent verify |
| XERO-02 | The Xero bank pull writes schema-valid rows (real connection, valid account type) | verified | verified by claude-verifier (independent subagent) @ 6da4d8b8 |
| BS-01 | The balance sheet does not count credit-card and loan balances as both cash and debts | done | done @ 56e21d96, awaiting independent verify |
| CI-01 | CI runs the Deno edge-function tests and reports environment-gated test files instead of skipping them silently | verified | verified by claude-verifier (independent subagent) @ 6da4d8b8 |
| UI-01 | Light theme polish: themed colours everywhere, no hard-coded dark-only colours, auth screens in the new style | done | done @ 10b7b1d6, awaiting independent verify |
| UI-02 | Shared PageHeader, Stat, StatusBadge, EmptyState, Alert and Field replace page-local copies | done | done @ 10b7b1d6, awaiting independent verify |
| UI-03 | Modern app shell: labelled sectioned sidebar, top bar with breadcrumbs, org switcher, user menu, command palette | done | done @ 10b7b1d6, awaiting independent verify |
| UI-04 | Accessibility: contrast-safe colour tokens, keyboard focus everywhere, labelled icon buttons, no text under 11px | done | done @ ddf1de2a, awaiting independent verify |
| SHIP | Ship gate: typecheck, lint, the full test suite (Vitest and Deno) and the production build all pass | done | done @ dfc8a06f, awaiting independent verify |
| DEPLOY | Production (accounting.looplet.com.au and the edge functions) serves the verified build after Daniel says go | blocked | BLOCKED: Production changes need the owner's explicit approval. (needs: Daniel reviews screenshots and the verified ledger, then says go for the production deploy.) |
| SEC-08 | bills-allocate-batch checks the caller's own accepted membership and needs accountant or higher to change allocations | verified | verified by claude-verifier (independent subagent) @ bbdacc04 |
| SEC-09 | accountant-email-query matches the sender's accepted accountant memberships by role_enum, so the emailed activity digest works | verified | verified by claude-verifier (independent subagent) @ 6da4d8b8 |
| MIG-01 | Every migration applies in order to a fresh database, so the history can rebuild the schema (no known failures left) | done | done @ 56e21d96, awaiting independent verify |
| SEC-10 | SECURITY DEFINER functions that users call and that write money tables check the caller's role | done | done @ 56e21d96, awaiting independent verify |
| SEC-11 | Bills only reference suppliers of their own organisation, so payment runs never copy another organisation's payee bank details | done | done @ 56e21d96, awaiting independent verify |
| SEC-12 | Data-completeness sweep functions can only be run by the service role, not by signed-in users | done | done @ 56e21d96, awaiting independent verify |
| PAY-06 | FY2025-26 PAYG withholding rows match the official 2025 schedule (F2025L00647) worked examples | open | not run |
| UX-01 | Lower roles see a clear 'read-only' state instead of silent no-op saves on bills, jobs, allocations, payment runs, employees, customers and suppliers | open | not run |
| INV-02 | Looplet can email a tax invoice PDF to the customer from a verified sender, and marks it sent only after the email is accepted | open | not run |
| CI-02 | One production deploy path: Cloudflare Pages Git integration deploys main; the CI wrangler deploy step is removed and the Cloudflare token leaves GitHub | open | not run |
| FIX-01 | Ask AI's BAS answer reads columns that v_bas_quarterly actually has | done | done @ 716df180, awaiting independent verify |

Acceptance commands, every run, exit codes and log hashes are in LEDGER.json; logs are in .ledger/logs/.
