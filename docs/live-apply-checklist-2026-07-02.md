# Live Apply Checklist - 2026-07-02

This checklist converts the current local change set into a safe production
apply order. It is not a claim that live apply has already happened.

Current source change count after ignoring proof artefacts: tracked in git
status; this checklist is the live apply sequence, not a commit manifest.

Latest live audit: `docs/live-supabase-production-audit-2026-07-02.md`.

Follow-up already completed after that audit:

- `ato-lodge` deployed successfully.
- `bas-lodgement-pack` deployed successfully.
- `LEGAL_INGEST_SECRET` and `LEGAL_SCAN_SECRET` were added successfully without
  exposing values.
- `npm run supabase:readiness` now reports required functions `ok: true`.
- `npm run supabase:readiness` now reports required secrets `ok: true`.

## Do Not Apply

- Do not commit or deploy `tmp/` proof screenshots/logs. They are local evidence
  only and are now ignored by `.gitignore`.
- Do not run live migrations or deploy functions until credentials are loaded
  securely. Required blockers from the proof run:
  a valid `SUPABASE_DB_PASSWORD`, `SUPABASE_SERVICE_ROLE_KEY`, `TEST_USER_JWT`,
  `TEST_ORG_ID`, plus fixture IDs for BAS/super/tenant tests.
- Do not disable legal/money walls. ATO/SBR lodgement, true-and-correct
  declaration, ABA release, super send, STP transmit, and SMSF independent audit
  remain human/legal gates.

## Stage 0 - Local Gate Already Proven

Last proof run evidence: `docs/proof-run-2026-07-02.md`.

Re-run if any file changes before applying:

```powershell
npm run typecheck
npm run lint
npm test -- --reporter=dot
npm run build
deno check supabase/functions/intake-routing-apply/index.ts supabase/functions/bank-transaction-classifier/index.ts supabase/functions/payroll-export-stp/stp.ts supabase/functions/payroll-finalise-pay-run/index.ts supabase/functions/_shared/orchestrator/dispatch.ts supabase/functions/_shared/xero/adapter.ts supabase/functions/xero-push-bill/index.ts supabase/functions/xero-push-invoice/index.ts supabase/functions/automation-watchdog/index.ts
deno test --quiet supabase/functions/payroll-export-stp/stp.test.ts supabase/functions/_shared/orchestrator/dispatch.test.ts supabase/functions/advisor/index.test.ts supabase/functions/_shared/xero/idempotency.test.ts supabase/functions/ato-lodge/index.test.ts supabase/functions/bas-lodgement-pack/pack.test.ts
```

## Stage 1 - Confirm Remote Migration State

Load the DB password securely, then run:

```powershell
$env:SUPABASE_DB_PASSWORD = "<password from Supabase dashboard>"
supabase migration list --linked
```

Because this project has known migration-history drift, do not blindly assume
all local filenames map cleanly to live history. Confirm whether each migration
below is pending before applying.

## Stage 2 - Apply Migrations In Timestamp Order

Pending migration apply set:

1. `supabase/migrations/20260701070000_reconcile_evidence_atomic.sql`
2. `supabase/migrations/20260702090000_period_lock_money_tables.sql`
3. `supabase/migrations/20260702100000_statutory_statements_period_scope.sql`
4. `supabase/migrations/20260702103000_bas_g10_capital_split.sql`
5. `supabase/migrations/20260702104500_bas_worksheet_deterministic_period.sql`
6. `supabase/migrations/20260702110000_bas_lodgement_draft_rpc.sql`
7. `supabase/migrations/20260702123000_orchestrator_engine_dispatch.sql`
8. `supabase/migrations/20260702124500_gmail_mine_refresh_jobs.sql`
9. `supabase/migrations/20260702130000_invoice_zero_gst_treatment.sql`

Preferred apply after confirming pending state:

```powershell
supabase db push
```

If drift prevents `db push`, apply the pending SQL files one at a time in the
Supabase SQL editor, wrapped in a transaction where the migration supports it.
After each apply, record the migration row and rerun the relevant verification
query/test before moving to the next migration.

## Stage 3 - Confirm Required Secrets

The live audit originally reported these Edge secrets missing, but follow-up
remediation added them:

- `LEGAL_INGEST_SECRET`
- `LEGAL_SCAN_SECRET`

Also confirm these are present and matching where relevant:

- `BANK_CLASSIFIER_CRON_SECRET`
- `AUTO_RECONCILE_CRON_SECRET`
- Vault `bank_txn_classifier_cron_secret`
- Vault `auto_reconcile_cron_secret`

Do not print secret values. Compare by presence/name and digest only.

## Stage 4 - Deploy Edge Functions

Production currently has the required function slugs present after deploying
`ato-lodge` and `bas-lodgement-pack`. After the missing migrations are applied,
deploy direct changed functions as needed so production code matches this
worktree:

```powershell
supabase functions deploy accountant-orchestrator
supabase functions deploy advisor
supabase functions deploy ato-lodge
supabase functions deploy automation-watchdog
supabase functions deploy automation-worker
supabase functions deploy bank-sync
supabase functions deploy bank-transaction-classifier
supabase functions deploy bas-lodgement-pack
supabase functions deploy gmail-classify-ai
supabase functions deploy ingest
supabase functions deploy intake-routing-apply
supabase functions deploy payroll-export-stp
supabase functions deploy payroll-finalise-pay-run
supabase functions deploy xero-push-bill
supabase functions deploy xero-push-invoice
```

Deploy importers affected by changed shared modules:

```powershell
supabase functions deploy bills-extract
supabase functions deploy bills-attach
supabase functions deploy receipt-sync-dispatch
```

JWT mode must follow `supabase/config.toml`. Do not force `--no-verify-jwt`
globally; only functions configured with `verify_jwt = false` should run without
the platform JWT gate.

## Stage 5 - Post-Apply Read-Only Verification

Run live metadata checks:

```powershell
supabase functions list
supabase secrets list
npm run wrap:live-audit
```

Run read-only SQL checks in Supabase:

```sql
select version, name
from supabase_migrations.schema_migrations
where version in (
  '20260701070000',
  '20260702090000',
  '20260702100000',
  '20260702103000',
  '20260702104500',
  '20260702110000',
  '20260702123000',
  '20260702124500',
  '20260702130000'
)
order by version;

select jobname, schedule, active
from cron.job
where jobname in (
  'auto-reconcile-daily',
  'bank-txn-classifier-cron',
  'gmail-mine-refresh'
)
order by jobname;

select name
from vault.decrypted_secrets
where name in (
  'auto_reconcile_cron_secret',
  'bank_txn_classifier_cron_secret'
)
order by name;
```

## Stage 6 - Deploy-Gated Tests

Only after service-role/test JWT/fixture IDs are loaded:

```powershell
npm test -- tests/tenant-isolation.test.ts --reporter=dot
npm test -- tests/bas-lodgement-pack.test.ts --reporter=dot
npm test -- tests/bas-worksheet-pdf.test.ts --reporter=dot
npm test -- tests/payroll-termination.test.ts --reporter=dot
npm test -- tests/super-batch-send.test.ts --reporter=dot
```

Then run signed-in product proof for Advisor, Receipt Hub, BAS pack download,
bank classifier, auto-reconcile, and Xero push/stub evidence.

## Stage 7 - Completion Update

After Stage 6 passes:

- Update `docs/proof-run-2026-07-02.md` or create a new proof note.
- Update `docs/remaining-work-todo.md`.
- Update `docs/automation-spine.html` if node statuses change.
- Only then increase the overall app completion estimate.
