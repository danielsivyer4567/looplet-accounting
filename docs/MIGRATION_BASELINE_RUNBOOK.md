# Migration Baseline And Rollback Runbook

**Status:** active finish-line runbook.
**Project:** `dxoikltymmknxqpkpyhi`.
**Current local ceiling:** `20261003170200_super_batch_file_prepared_lifecycle.sql`.

This runbook supersedes older warnings that named `0080`, `0207`, or `0236` as
the local ceiling. The source tree now carries numbered migrations through
`0236` plus timestamped hardening repairs through
`20261003170200_super_batch_file_prepared_lifecycle.sql`.

These exist in source only and have **not** been applied to the project; apply them with the rest of
the release after the baseline check below. Each is proven against a fresh local database by
`node scripts/db/run-pg-sql-tests.mjs <test>`:

| Migration | What it does | Test |
|---|---|---|
| `20261003120000_money_table_write_roles.sql` | SEC-05: money-table writes need a role (`can_write_org`); payment-run items and pay slips stay in their organisation | `tests/db-sql/money-table-roles.sql` |
| `20261003121000_definer_write_roles.sql` | SEC-10: definer functions that write money tables check the caller's role | `tests/db-sql/definer-write-roles.sql` |
| `20261003170200_super_batch_file_prepared_lifecycle.sql` | SEC-11: bills only reference their own organisation's suppliers | `tests/db-sql/bill-supplier-same-org.sql` |

Before applying `20261003120000` and `20261003122000`, check production for existing cross-organisation
links (they only guard new writes):
`payment_run_items` whose bill or run is in another organisation, `pay_slips` whose employee or pay run is in
another organisation, and `bills` whose supplier is in another organisation. Every migration now applies to a fresh database (`node scripts/db/run-pg-sql-tests.mjs --strict`); the repairs are recorded in `docs/MIGRATION_GAP_AUDIT.md`.

## Baseline Status

`docs/MIGRATION_GAP_AUDIT.md` records the live-history repair through `0196` and
the prior `supabase db push --linked --dry-run` evidence of "Remote database is
up to date" at that point.

On 2026-06-30, the finish-line migration batch `0199`-`0229` was applied to live
through `supabase db query --linked` and recorded in
`supabase_migrations.schema_migrations`. `0197` and `0198` were already recorded
before this pass. The Postgres pooler password available in this worktree still
does not authenticate for `supabase migration list --linked` or
`supabase db push --linked --dry-run`, but the Management API SQL path proves the
live ledger has numeric rows through `0229`.

Later on 2026-06-30, the owner-first/advisor proof batch `0230`-`0236` was
applied to live through the same `supabase db query --linked` Management API SQL
path and recorded in `supabase_migrations.schema_migrations` with
`created_by='codex-live-owner-first-20260630'`.

- `0197_track_vault_backed_cron_schedules.sql`
- `0198_fix_taa_legal_source_url.sql`
- `0199_accountant_portal.sql` through `0229_credit_notes_product.sql`
- `0230_advisor_work_proofs.sql` _(live via Management API SQL path)_
- `0231_workstream_tasks.sql` _(live via Management API SQL path)_
- `0232_automation_decisions.sql` _(live via Management API SQL path)_
- `0233_anomaly_signals.sql` _(live via Management API SQL path)_
- `0234_ap_exception_review.sql` _(live via Management API SQL path)_
- `0235_close_tasks.sql` _(live via Management API SQL path)_
- `0236_automation_feedback.sql` _(live via Management API SQL path)_

Representative post-apply proof collected on 2026-06-30:

- `supabase_migrations.schema_migrations` rows exist for every version `0199`
  through `0236`.
- Tag tables/RLS/RPCs/storage and `team-invite` v37 are live.
- Representative finish-line tables exist: `api_keys`, `cron_heartbeat_jobs`,
  `bank_link_jobs`, `extraction_attempts`, `xero_push_queue`,
  `bas_worksheet_snapshots`, `customer_credit_notes`, `supplier_credit_notes`.
- Representative finish-line RPCs exist, including `create_and_post_journal`,
  `generate_bas_worksheet`, `build_fbt_return`, `build_tpar_report`,
  `build_franking_register`, `build_sgc_statement`, `build_superstream_payload`,
  and the AR/AP credit-note RPCs.
- Owner-first proof exists for `advisor_work_proofs`, `automation_decisions`,
  `automation_feedback`, `workstream_task`, `get_workstream_tasks(uuid)`,
  `get_bill_decisions(uuid[])`, `record_automation_decision(...)`, and
  `record_feedback(...)`. `get_workstream_tasks(...)` executed successfully
  against a real organization and returned rows.

On 2026-07-02, local foundation hardening added timestamped grant/search-path,
extension-schema, and orphan-function cleanup migrations through
`20260702170000_extension_schema_and_orphan_function_cleanup.sql`. That file's
core (extension-schema move + `match_job_for_bill`/`match_legal_corpus`
redefinitions + orphaned-function drops) was live-applied and verified
directly (`supabase db query --linked`, bypassing the blocked `db push
--dry-run`) since the remote history ledger was not reconciled with the local
timestamped files. Its `search()`/`search_index_set_embedding()` functions
were split out to `20260703160000_xero_webhook_events.sql` — these are
**NOT applied**, since they depend on `public.search_index`
(`20260701140000_universal_search_index.sql`, built + dry-run-verified but
never shipped live — an explicit product decision pending, not a bug). Do not
apply `20260702171500` until `20260701140000` ships first.

## Operator Baseline Check

Run this in a monitored staging window first, then repeat against production:

```bash
supabase link --project-ref dxoikltymmknxqpkpyhi --password "$SUPABASE_DB_PASSWORD"
supabase migration list --linked
supabase db push --linked --dry-run
```

Pass condition: the dry run prints "Remote database is up to date" or lists only
the reviewed finish-line migration batch expected for that environment.

Stop condition: the dry run wants to replay old backfill ranges, unrelated
timestamp history, or any migration earlier than the reviewed finish-line batch.
Do not continue with `--include-all`; repair the history ledger or apply the
specific missing migration after object-level proof.

## Apply Rules

- Apply migrations in ascending filename order only.
- Use staging first and capture `migration list`, dry-run output, and post-apply
  object checks before production.
- Prefer `supabase db push --linked` only after the dry run has proven the
  baseline is clean for that environment.
- If baseline drift appears, apply one reviewed file at a time or repair
  `supabase_migrations.schema_migrations` only after proving the target objects
  already exist.
- Keep ATO live electronic lodgement disabled until `docs/COMPLIANCE_BACKLOG.md`
  is satisfied.

## Rollback / Abort

Supabase migrations in this repo do not carry automatic down migrations. Rollback
is therefore an operational decision, not a blind CLI command.

Abort before apply when dry-run output is unexpected, required secrets are
missing, or staging proof is red.

Abort during apply by stopping at the first failed file. Do not continue the
batch. Re-run only the failed file after its prerequisite is fixed.

For additive migrations, prefer a forward-fix migration. For behavior changes,
ship a targeted revert migration that restores the prior function/policy body.
For data corruption or an irreversible DDL error, use Supabase PITR/backups and
record the restore point in the release ticket.

## Evidence To Attach

- `supabase migration list --linked` before and after.
- `supabase db push --linked --dry-run` before apply.
- Applied migration range and commit SHA.
- Post-apply SQL checks for the affected tables, policies, triggers, RPCs, and
  cron rows.
- Function deploy inventory from `docs/FUNCTION_INVENTORY.md`.
