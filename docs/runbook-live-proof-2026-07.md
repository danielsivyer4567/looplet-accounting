# Runbook: Live-Proof Push — 2026-07 (Training Wheels Edition)

Execute these cards **in order**. Rules, tiers, and escalation live in
`docs/guardrails-live-proof-2026-07.md` — read that first, once, fully.
The card being worked on is tracked in `.claude/scratch/ledger.md`.

Conventions used by every card:

- Shell blocks are PowerShell, run from the repo root.
- "Marker fresh" means `.claude/scratch/guard-preflight-passed` exists and is
  less than 30 minutes old (re-run `npm run guard:preflight` if not). The
  marker writes on `safe_to_proceed` (valid DB password + no secret leak) —
  deliberately narrower than the report's overall `ok` field, which also
  requires migrations already applied and test creds already loaded. Tier 2
  work is what makes `ok` become true, so the marker can't require it first.
- Evidence goes to `tmp/` (gitignored). Name files after the card:
  `tmp/lp-03-verify.log`.
- SQL against prod runs in the Supabase dashboard SQL editor (or the Supabase
  MCP `execute_sql` tool when a Claude session is the operator).

> ⚠️ **Critical local fact discovered while writing this runbook:** the repo
> contains **24** local migrations dated 2026-07, not just the 9 in the apply
> checklist — including several that **activate cron jobs** (Tier 3) and
> **three files sharing the duplicate timestamp `20260701160000_*`**. This is
> exactly why `supabase db push` is forbidden here: it would apply all of
> them, cron activations included, in one blind step. Card LP-02 sorts this
> out before anything is applied.

---

### LP-00 — Orientation + baseline red preflight
Tier: 0 | Depends on: nothing | Owner: junior

Goal: prove your local setup works and prove the preflight gate correctly
detects the currently-broken prod credentials.

Pre-flight:
- [ ] You have read `docs/guardrails-live-proof-2026-07.md` end to end.
- [ ] `git status` shows you are on the expected branch.

Commands:
```powershell
npm run check:local-env
npm run typecheck
npm run lint
npm test -- --reporter=dot
npm run guard:preflight 2>&1 | Tee-Object tmp/lp-00-preflight-baseline.log
```

Expected output:
- The first four commands exit 0.
- `guard:preflight` **exits 1** (this is correct today) with
  `"ok": false` and a failure naming `SUPABASE_DB_PASSWORD` as invalid for
  the linked database, and `.claude/scratch/guard-preflight-passed` is
  **not** created/updated.

STOP and escalate if:
- Any of the four local gates fails — the working tree is not at a known-good
  state; do not proceed to prod work from a red local baseline.
- `guard:preflight` exits 0 today — that means the gate failed to detect a
  known-bad credential; the gate itself is broken. Nothing above Tier 1 may
  run until it is fixed.

Rollback: none — read-only.
Done-evidence: `tmp/lp-00-preflight-baseline.log` saved; flip LP-00 in the ledger.

---

### LP-01 — Valid `SUPABASE_DB_PASSWORD` (USER)
Tier: 3 | Depends on: LP-00 | Owner: user
Sign-off: this card IS the user acting; the owner performs it personally.

Goal: put a working database password for project `dxoikltymmknxqpkpyhi` into
`.env.local`.

Steps (owner):
1. Supabase dashboard → project `dxoikltymmknxqpkpyhi` → Settings → Database.
   Reset the database password if the current one is unknown.
2. Edit `.env.local` in an editor and set `SUPABASE_DB_PASSWORD=<value>`.
   Do not paste the value anywhere else — not chat, not terminal, not docs.
3. Hand back to the junior to verify.

Verification (junior):
```powershell
supabase migration list --linked 2>&1 | Tee-Object tmp/lp-01-migration-list.log
npm run guard:preflight
```

Expected output:
- `migration list --linked` prints a Local/Remote version table (no
  `password authentication failed`).
- `guard:preflight` no longer lists `SUPABASE_DB_PASSWORD` under `blocked`
  (it may still be red for other reasons — that's fine at this stage).

STOP and escalate if: authentication still fails after a dashboard reset —
possible project-ref mismatch; check `VITE_SUPABASE_PROJECT_REF`.

> ⚠️ **Known gotcha — a stale OS-level env var silently wins over `.env.local`.**
> Both `guard-preflight.mjs` and `live-supabase-readiness.mjs` merge env as
> `{ ...process.env, ...envLocalOnlyIfKeyNotAlreadyPresent }` — meaning if
> `SUPABASE_DB_PASSWORD` (or any of the other three required vars) is *already*
> set as a Windows User/Machine environment variable (e.g. from an old `setx`
> or a previous troubleshooting session), editing `.env.local` has **zero
> effect** and the check will keep failing with no visible reason why. If you
> edited `.env.local` and `guard:preflight` still reports the same failure,
> check for a stale OS-level variable before assuming your edit was wrong:
> ```powershell
> [System.Environment]::GetEnvironmentVariable('SUPABASE_DB_PASSWORD','User') -ne $null
> ```
> If that prints `True`, clear it (`[System.Environment]::SetEnvironmentVariable('SUPABASE_DB_PASSWORD', $null, 'User')`)
> — this is a reversible settings change, not a Tier X action, so a junior may
> do it directly. **Then restart the terminal/session** — Windows registry
> changes only apply to newly spawned processes, not the one you're already
> in. Re-run `guard:preflight` only after the restart.

> ⚠️ **Known gotcha — a duplicate key line in `.env.local` silently wins over
> the real one.** `loadEnv()` parses the file top-to-bottom and the LAST
> matching `KEY=value` line wins (confirmed empirically 2026-07-02:
> `SUPABASE_SERVICE_ROLE_KEY` had a real value on an earlier line and a
> leftover empty placeholder line further down — the empty one silently won,
> and the key kept reporting "missing" with no error). This is easy to hit
> when a template `.env.local` shipped with a blank placeholder line and you
> add the real value as a NEW line instead of editing the existing blank one.
> If a key you just set keeps reporting missing/wrong: check for a duplicate
> definition of that same key elsewhere in the file (grep the key name,
> value redacted) before assuming the value itself is wrong.

Rollback: owner can reset the password again at any time (invalidates the old one).
Done-evidence: `tmp/lp-01-migration-list.log` (skim it — no secrets appear in
migration lists); flip LP-01.

---

### LP-02 — Confirm the TRUE pending migration set
Tier: 1 | Depends on: LP-01 | Owner: junior

Goal: build the real pending-migration list from the linked database. This
project has known migration-history drift — never assume local filenames map
to live history.

Pre-flight:
- [ ] LP-01 done (`migration list --linked` works).

Commands:
```powershell
supabase migration list --linked 2>&1 | Tee-Object tmp/lp-02-migration-state.log
```

Read-only SQL (dashboard SQL editor), save results into `tmp/lp-02-db-state.md`:
```sql
-- which of the required 9 are already recorded?
select version, name from supabase_migrations.schema_migrations
where version >= '20260701000000' order by version;

-- current cron jobs (snapshot BEFORE any apply)
select jobid, jobname, schedule, active from cron.job order by jobname;

-- vault secret NAMES only (never values)
select name from vault.secrets order by name;
```

Then classify **every** local `supabase/migrations/202607*.sql` file into one
of four buckets, and write the table into the ledger under LP-02:

1. **Already applied** on remote (version present in `schema_migrations`) — skip.
2. **Pending + in the checklist-9** (`20260701070000_reconcile_evidence_atomic`,
   `20260702090000_period_lock_money_tables`,
   `20260702100000_statutory_statements_period_scope`,
   `20260702103000_bas_g10_capital_split`,
   `20260702104500_bas_worksheet_deterministic_period`,
   `20260702110000_bas_lodgement_draft_rpc`,
   `20260702123000_orchestrator_engine_dispatch`,
   `20260702124500_gmail_mine_refresh_jobs`,
   `20260702130000_invoice_zero_gst_treatment`) — these go to LP-03/04/05.
3. **Pending + cron-activating** (anything containing `cron.schedule`, e.g.
   `20260701190000_automation_worker_cron_live`,
   `20260701191500_automation_watchdog_cron_live`, the `gmail_*_cron` files,
   `20260701160000_bank_reconcile_classifier_cron`) — **Tier 3**. Do NOT
   apply under this runbook's Tier 2 cards; they wait for owner sign-off
   alongside LP-08.
4. **Pending + not in the checklist** (e.g. `universal_search_index`,
   `business_profile_facts`, `debts_soft_delete`,
   `timesheet_entries_job_pnl`, `expand_debt_kind_enum`,
   `bank_accounts_to_debts_pipeline`, `move_employee_to_org`,
   `harden_notify_org_guard`, `close_task_preflight_detail`) — **scope
   decision**. List them for the owner; they are appended to the LP-03..05
   protocol ONLY if the owner writes a sign-off line naming them.

Also record: the three files sharing timestamp `20260701160000_*` — flag this
duplicate-timestamp trio to the owner regardless of bucket.

Expected output: every 202607 file classified; buckets recorded in the ledger.

STOP and escalate if:
- `schema_migrations` shows a version that has **no matching local file** in
  that range — out-of-band drift; owner decides before anything is applied.
- You cannot cleanly bucket a file (e.g. it both creates tables AND schedules
  a cron) — treat as bucket 3 (Tier 3) and flag it.

Rollback: none — read-only.
Done-evidence: `tmp/lp-02-migration-state.log`, `tmp/lp-02-db-state.md`,
bucket table in the ledger; flip LP-02.

---

### The per-migration protocol (used by LP-03, LP-04, LP-05)

For **each** migration, one at a time, in timestamp order:

1. **Marker fresh?** `npm run guard:preflight` green within 30 minutes.
2. **Code-safety review (Tier 1 substitute — NOT a live dry-run):**

   > ⚠️ **`BEGIN…ROLLBACK` dry-runs are NOT reliable through the Supabase MCP
   > `execute_sql` tool for real migration content, and this runbook no
   > longer recommends them.** Confirmed empirically 2026-07-02: a plain
   > `BEGIN; CREATE TABLE t(...); INSERT...; ROLLBACK;` test rolled back
   > correctly, but the SAME pattern wrapping a real migration (containing
   > `CREATE FUNCTION ... AS $$ ... $$` and `DO $$ ... $$` bodies) did NOT —
   > the function and part of its trigger loop landed live despite the
   > trailing `ROLLBACK;`. Every real migration in this repo uses those
   > dollar-quoted constructs, so the dry-run technique can't be trusted for
   > the exact content it exists to protect. Read the full file and confirm,
   > by inspection, that every operation is safe to apply directly:
   > - `CREATE OR REPLACE FUNCTION` / `CREATE OR REPLACE VIEW` — safe, idempotent.
   > - `DROP ... IF EXISTS` followed by recreate — safe, idempotent.
   > - `ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`,
   >   `CREATE INDEX IF NOT EXISTS` — safe, idempotent.
   > - A bare `INSERT` (no `ON CONFLICT`), a bare `ALTER TABLE ADD COLUMN`
   >   (no `IF NOT EXISTS`), a `DROP` without `IF EXISTS`, or any one-shot
   >   data backfill — **NOT safe to treat as routine Tier 2**. Stop and get
   >   explicit owner sign-off before applying, since a partial/failed run
   >   can't be cleanly retried.
   > If everything in the file is in the safe/idempotent category, proceed
   > directly to Apply — there is no separate sandbox step.
3. **Apply:** run the file for real. When a Claude session is the operator,
   use Supabase MCP `apply_migration` with the file's exact name (it records
   `schema_migrations` automatically). When a human is the operator: run the
   file in the SQL editor, then record it:
   `insert into supabase_migrations.schema_migrations (version, name) values ('<version>', '<name>');`

   > ⚠️ **`apply_migration` does NOT preserve the local file's timestamp.**
   > It mints its own synthetic `version` at apply time (confirmed empirically
   > 2026-07-02: `reconcile_evidence_atomic`'s local timestamp is
   > `20260701070000`, but it recorded as `20260701225359`). This is also
   > the real explanation for several of LP-02's "unexplained remote-only
   > migration, no matching local file" drift entries — they're not drift at
   > all, they're earlier migrations applied this same way. **Always verify
   > by `name`, never by the local file's `version` string.**
4. **Verify-after (all three, every time):**
   - Row exists, checked **by name** (not by the local file's timestamp —
     see warning above): `select version from supabase_migrations.schema_migrations where name = '<migration_name_without_timestamp>';`
   - The card's object-existence SELECT (below) returns the expected rows.
   - **DEFINER-grant check** — must return **zero rows** for any function the
     migration created with SECURITY DEFINER that is meant to be
     service-role-only:
     ```sql
     select p.proname, r.rolname
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     join aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a on true
     join pg_roles r on r.oid = a.grantee
     where n.nspname = 'public'
       and p.prosecdef
       and r.rolname in ('anon', 'authenticated')
       and p.proname = any(array['<functions created by this migration>']);
     ```
     (If the function is *intended* to be called by `authenticated` — the
     migration's comments say so — a row for `authenticated` is expected;
     `anon` almost never is.)
5. Log everything into `tmp/lp-0N-<version>.log`, then move to the next file.

**Never** run `supabase db push` (applies every pending migration including
Tier 3 cron activations in one blind step). **Never** hand-patch a partially
applied migration — STOP and escalate (Principle 3).

---

### LP-03 — Apply migrations 1–3 of the checklist-9
Tier: 2 | Depends on: LP-02 | Owner: junior

Goal: apply `20260701070000_reconcile_evidence_atomic`,
`20260702090000_period_lock_money_tables`,
`20260702100000_statutory_statements_period_scope` — each via the
per-migration protocol above (skip any LP-02 marked already-applied).

Object-existence SELECTs (step 4 of the protocol):
```sql
-- 20260701070000
select proname from pg_proc join pg_namespace n on n.oid = pronamespace
where nspname='public' and proname in
 ('reconcile_match_bill_with_evidence','reconcile_match_invoice_with_evidence','record_reconciliation_skip_evidence');
-- expect 3 rows

-- 20260702090000
select proname from pg_proc join pg_namespace n on n.oid = pronamespace
where nspname='public' and proname = 'check_period_lock';
-- expect 1 row; also expect its triggers:
select tgname, relname from pg_trigger t join pg_class c on c.oid = t.tgrelid
where not tgisinternal and tgname like '%period_lock%' order by relname;

-- 20260702100000
select proname from pg_proc join pg_namespace n on n.oid = pronamespace
where nspname='public' and proname = 'generate_statutory_statements';
-- expect 1 row
```

STOP and escalate if: any dry-run errors; any verify query returns the wrong
count; the DEFINER-grant check shows `anon` on any new function.

Rollback: functions from these migrations can be dropped individually
(`drop function public.<name>(...)`) — but do not do this yourself; a failed
verify is an escalation, and rollback is the owner's call.

Done-evidence: `tmp/lp-03-<version>.log` per migration; flip LP-03.

---

### LP-04 — Apply migrations 4–6 (the BAS trio)
Tier: 2 | Depends on: LP-03 | Owner: junior

Goal: apply `20260702103000_bas_g10_capital_split`,
`20260702104500_bas_worksheet_deterministic_period`,
`20260702110000_bas_lodgement_draft_rpc` via the per-migration protocol.

Object-existence SELECTs:
```sql
-- 20260702103000
select proname from pg_proc join pg_namespace n on n.oid = pronamespace
where nspname='public' and proname = 'generate_bas_worksheet_gst';  -- 1 row

-- 20260702104500
select proname from pg_proc join pg_namespace n on n.oid = pronamespace
where nspname='public' and proname = 'generate_bas_worksheet';      -- 1 row

-- 20260702110000
select proname from pg_proc join pg_namespace n on n.oid = pronamespace
where nspname='public' and proname = 'prepare_bas_lodgement_draft'; -- 1 row
```

Extra functional verify (Tier 1 sandbox — reads only, rolls back):
```sql
BEGIN;
select public.generate_bas_worksheet('<TEST or any real org id from LP-02 snapshot>'::uuid, '2026-04-01'::date, '2026-06-30'::date);
ROLLBACK;
```
A clean run (or a clean domain error like "no data for period") proves the
function is callable; a `does not exist` error means the apply failed.

STOP/Rollback/Evidence: same as LP-03 (`tmp/lp-04-<version>.log`).

---

### LP-05 — Apply migrations 7–9
Tier: 2 | Depends on: LP-04 | Owner: junior

Goal: apply `20260702123000_orchestrator_engine_dispatch`,
`20260702124500_gmail_mine_refresh_jobs`,
`20260702130000_invoice_zero_gst_treatment` via the per-migration protocol.

Object-existence SELECTs:
```sql
-- 20260702123000
select relname from pg_class join pg_namespace n on n.oid = relnamespace
where nspname='public' and relname = 'compliance_drafts';           -- 1 row
select proname from pg_proc join pg_namespace n on n.oid = pronamespace
where nspname='public' and proname in
 ('request_system_approval','prepare_bas_lodgement_draft_system');  -- 2 rows

-- 20260702124500
select proname from pg_proc join pg_namespace n on n.oid = pronamespace
where nspname='public' and proname = 'enqueue_gmail_mine_refresh_jobs'; -- 1 row
-- NOTE: this creates the enqueue FUNCTION only. If the file also calls
-- cron.schedule, STOP — that makes it bucket 3 / Tier 3 (check during dry-run).

-- 20260702130000 (column/enum change)
select column_name from information_schema.columns
where table_schema='public' and table_name='invoice_lines'
  and column_name like '%gst%';
```

Special attention: `orchestrator_engine_dispatch` creates SECURITY DEFINER
functions that write approval/draft rows — the DEFINER-grant check (protocol
step 4) is **mandatory**, and `request_system_approval` must NOT be
executable by `anon`.

STOP/Rollback/Evidence: same as LP-03 (`tmp/lp-05-<version>.log`).

---

### LP-06 — Post-apply verification sweep
Tier: 1 | Depends on: LP-05 | Owner: junior

Goal: prove the applied state end to end, read-only (checklist Stage 5).

Commands:
```powershell
supabase functions list 2>&1 | Tee-Object tmp/lp-06-functions.log
supabase secrets list    2>&1 | Tee-Object tmp/lp-06-secrets.log
npm run wrap:live-audit  2>&1 | Tee-Object tmp/lp-06-live-audit.log
npm run supabase:readiness 2>&1 | Tee-Object tmp/lp-06-readiness.log
```

SQL (dashboard):
```sql
select version, name from supabase_migrations.schema_migrations
where name in ('reconcile_evidence_atomic','period_lock_money_tables',
 'statutory_statements_period_scope','bas_g10_capital_split',
 'bas_worksheet_deterministic_period','bas_lodgement_draft_rpc',
 'orchestrator_engine_dispatch','gmail_mine_refresh_jobs',
 'invoice_zero_gst_treatment') order by version;   -- expect 9 rows

-- ⚠️ checked by `name`, NOT the local file's `version` timestamp — see the
-- warning in the per-migration protocol above (apply_migration mints its
-- own timestamp at apply time, confirmed empirically 2026-07-02).

select jobname, schedule, active from cron.job order by jobname;
-- expect: IDENTICAL to the LP-02 snapshot, PLUS exactly one addition if
-- LP-05's migration 8 (gmail_mine_refresh_jobs) sign-off was taken:
-- `gmail-mine-refresh`, schedule '30 4 * * *'. Any OTHER new/changed/missing
-- job vs. LP-02 is a real side-effect signal, not expected drift.

select name from vault.secrets
where name in ('auto_reconcile_cron_secret','bank_txn_classifier_cron_secret')
order by name;                                           -- expect 2 rows
```

Expected output: 9 migration rows; cron list matches LP-02 plus at most the
one LP-05-approved addition noted above; readiness shows `migrations.ok: true`;
remaining readiness failures name ONLY the test credentials
(`SUPABASE_SERVICE_ROLE_KEY`, `TEST_USER_JWT`, `TEST_ORG_ID`).

STOP and escalate if: the cron list has any change beyond the one
LP-05-approved addition — something else activated as a side effect; the
owner must review before anything else runs.

Rollback: none — read-only.
Done-evidence: the four `tmp/lp-06-*.log` files + SQL results; flip LP-06.

---

### LP-07 — Test credentials + fixture IDs (USER)
Tier: 3 | Depends on: LP-06 | Owner: user
Sign-off: the owner performs this personally.

Goal: load into `.env.local` (editor only, never chat/terminal):
`SUPABASE_SERVICE_ROLE_KEY`, `TEST_USER_JWT`, `TEST_ORG_ID`, plus the fixture
IDs the deploy-gated BAS/super/tenant tests need (see each test file's header
for exact names).

Verification (junior):
```powershell
npm run guard:preflight 2>&1 | Tee-Object tmp/lp-07-preflight.log
```

Expected output: `guard:preflight` **exits 0**, `"ok": true`, and
`.claude/scratch/guard-preflight-passed` is written. From here on, Tier 2
cards check marker freshness.

STOP and escalate if: preflight's leak tripwire reports a JWT-shaped string
or an `.env.local` value inside a git-tracked file — stop everything;
the credential must be rotated (owner) before work continues.

Rollback: owner rotates any of these keys from the dashboard at any time.
Done-evidence: `tmp/lp-07-preflight.log` (JSON is redacted by design); flip LP-07.

---

### LP-08 — Edge-function deploys (SIGN-OFF)
Tier: 3 | Depends on: LP-07 | Owner: sign-off (owner approves, junior executes)
Sign-off line required in the ledger BEFORE the first deploy, naming the
function list approved.

Goal: deploy the checklist Stage 4 list so prod code matches this worktree —
15 core functions + 3 shared-module importers (`bills-extract`,
`bills-attach`, `receipt-sync-dispatch`).

Method: this project deploys via the **Supabase MCP deploy path with the
deno.json import-map override and nested paths** (see
`docs/live-apply-checklist-2026-07-02.md` Stage 4 for the list; deploy in
that order). JWT mode follows `supabase/config.toml` — never force
`--no-verify-jwt`.

Protocol: deploy in batches of ~5; after each batch:
```powershell
supabase functions list 2>&1 | Tee-Object -Append tmp/lp-08-functions.log
```
and confirm each deployed slug shows `ACTIVE` with a bumped version.

If the owner also signed off bucket-3 cron migrations from LP-02, they are
applied here (per-migration protocol), AFTER the functions they invoke are
deployed, and the cron snapshot diff is recorded.

Expected output: every deployed slug ACTIVE, version bumped.
STOP and escalate if: any function goes non-ACTIVE, or a deploy errors —
do not retry-loop deploys; capture and stop.
Rollback: redeploy the previous version (owner decision).
Done-evidence: `tmp/lp-08-functions.log`; flip LP-08.

---

### LP-09 — Deploy-gated read-proof tests
Tier: 2 | Depends on: LP-07 (LP-08 for BAS pack) | Owner: junior

Goal: run the deploy-gated tests that only read or write inside the test org.
Order matters — tenant isolation FIRST (it proves the walls before anything
else writes).

Pre-flight: [ ] marker fresh.

Commands:
```powershell
npm test -- tests/tenant-isolation.test.ts --reporter=dot 2>&1 | Tee-Object tmp/lp-09-tenant.log
npm test -- tests/bas-lodgement-pack.test.ts --reporter=dot 2>&1 | Tee-Object tmp/lp-09-bas-pack.log
npm test -- tests/bas-worksheet-pdf.test.ts --reporter=dot 2>&1 | Tee-Object tmp/lp-09-bas-pdf.log
```

Expected output: each file: 0 failed, **0 skipped** (a skip means an env var
is still missing — that's a failed pre-flight, not a pass).

STOP and escalate if: tenant isolation fails — this is a cross-tenant
exposure signal; nothing else runs until the owner reviews. Any other failure:
capture, mark blocked, continue is NOT allowed within this card.

Rollback: tests clean up after themselves via service-role teardown; if a
teardown fails the log will say so — escalate with the log.
Done-evidence: three `tmp/lp-09-*.log`; flip LP-09.

---

### LP-10 — Payroll/super deploy-gated tests (SIGN-OFF)
Tier: 3 | Depends on: LP-09 | Owner: sign-off
Sign-off line required BEFORE running (these write payroll tables, fixture
org only).

Commands:
```powershell
npm test -- tests/payroll-termination.test.ts --reporter=dot 2>&1 | Tee-Object tmp/lp-10-payroll.log
npm test -- tests/super-batch-send.test.ts --reporter=dot 2>&1 | Tee-Object tmp/lp-10-super.log
```

Expected output: 0 failed, 0 skipped. Note: "super batch send" here is the
batch **preparation** proof — actual super money movement is Tier X and is
not touched by any test.

STOP and escalate if: any write lands outside `TEST_ORG_ID` (the tests assert
this; a failure of that assertion is a tenant-wall alarm).
Rollback: service-role teardown in the tests; escalate if teardown fails.
Done-evidence: both logs; flip LP-10.

---

### LP-11 — Signed-in browser proof
Tier: 2 | Depends on: LP-07 | Owner: junior

Goal: capture the signed-in product proof that the audit scorecard still
lists as open: create/edit/archive flows and mobile screenshots.

Rules of engagement (from `docs/BROWSER_AUTOMATION_RUNBOOK.md`): signed-in
session on the **test org only**; screenshots + read flows freely; writes
only through the product's own review flows; no lodgement surfaces.

Pre-flight: [ ] marker fresh. [ ] Signed in as the test user, test org selected.

Scope (each → screenshot to `tmp/lp-11/`):
- Create: customer, job, supplier ("+ New …" flows)
- Edit/save: bill detail, org settings (ABN save), subscription detail,
  debt payment record, employee timesheet entry
- Archive/restore: bill, invoice, subscription, employee, debt
- MoveToOrg control (needs ≥ 2 orgs — if the test user has only one org,
  record that as the blocker instead of creating a second org yourself)
- Mobile (390×844): Dashboard, Bills, Settings connectors, Reconciliation,
  Triage, Auto Setup

Expected output: screenshots exist; no console errors on visited pages
(capture DevTools console per page group).

STOP and escalate if: any flow errors, writes to the wrong org, or a surface
demands a provider connection (that's LP-13, not this card).
Rollback: archive/restore proofs restore their own rows; created test rows
stay in the test org (note their IDs in the evidence file).
Done-evidence: `tmp/lp-11/` screenshot set + `tmp/lp-11-notes.md`; flip LP-11.

---

### LP-12 — Data actions: PDFs + Triage (USER-driven)
Tier: 2 | Depends on: LP-11 | Owner: user (junior may assist at the keyboard)

Goal: feed the system its real data through the product UI:
1. Upload the 7 queued bank-statement PDFs via Settings → Bank statement import.
2. Work through Triage: approve/dismiss the ~399 pending staged senders
   (approvals create `intake_rules` + customers — the product's review UI is
   the guard rail).

Expected output: imports queue and complete (watch the import status panel);
approved senders disappear from Triage; `intake_rules` count grows.

STOP and escalate if: an import errors or a triage approval throws — capture
the exact sender/file and the console error.
Rollback: intake rules can be disabled from Settings; statement imports are
reviewable before posting (that's the point of the queue).
Done-evidence: before/after counts (staged pending, bank_transactions,
intake_rules) recorded in `tmp/lp-12-counts.md`; flip LP-12.

---

### LP-13 — External provider proof (SIGN-OFF, joint)
Tier: 3 | Depends on: LP-08, LP-12 | Owner: joint (owner connects, junior traces)
Sign-off line required per provider BEFORE connecting.

Goal: one real trace per provider, captured read-only:
- **Xero**: owner completes OAuth from Settings → Xero; junior captures the
  connected-tenant state + one push (bill or invoice) sync-log evidence.
- **Basiq**: owner links a bank; junior captures callback → exchange →
  transaction backfill counts.
- **Gmail Pub/Sub**: owner reconnects the watched mailbox; junior captures
  one real push event landing in the intake pipeline.

Expected output: per provider, an evidence note in `tmp/lp-13-<provider>.md`
with timestamps and row counts — no tokens, no secrets, ever.

STOP and escalate if: any OAuth flow asks for scopes beyond the documented
ones, or a push writes rows in an unexpected org.
Rollback: every provider connection is disconnectable from Settings
(Basiq: Disable feed; Gmail: disconnect; Xero: disconnect tenant).
Done-evidence: the three provider notes; flip LP-13.

---

### LP-14 — Docs closeout + estimate update
Tier: 0 | Depends on: all cards above resolved (done or explicitly deferred by owner) | Owner: junior

Goal: close the loop (checklist Stage 7): update
`docs/proof-run-2026-07-02.md` (or a new proof note),
`docs/remaining-work-todo.md`, and `docs/automation-spine.html` node statuses.
Only NOW may the ~85% completion estimate change — and only to a number the
evidence in `tmp/` actually supports.

Commands:
```powershell
npm run typecheck
npm run lint
```

Expected output: gates green; docs updated; every claim in the updated docs
cites a `tmp/` evidence file from LP-00…LP-13.

Rollback: docs are git-versioned.
Done-evidence: updated docs committed (normal commit flow); flip LP-14 —
runbook complete.
