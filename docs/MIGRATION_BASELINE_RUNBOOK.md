# Migration Baseline And Rollback Runbook

**Status:** active finish-line runbook.
**Project:** `dxoikltymmknxqpkpyhi`.
**Current local ceiling:** `0229_credit_notes_product.sql`.

This runbook supersedes older warnings that named `0080` or `0207` as the local
ceiling. The source tree now carries numbered migrations through `0229`.

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

The local finish-line deploy batch after that repaired baseline is now live:

- `0197_track_vault_backed_cron_schedules.sql`
- `0198_fix_taa_legal_source_url.sql`
- `0199_accountant_portal.sql` through `0229_credit_notes_product.sql`

Representative post-apply proof collected on 2026-06-30:

- `supabase_migrations.schema_migrations` rows exist for every version `0199`
  through `0229`.
- Tag tables/RLS/RPCs/storage and `team-invite` v37 are live.
- Representative finish-line tables exist: `api_keys`, `cron_heartbeat_jobs`,
  `bank_link_jobs`, `extraction_attempts`, `xero_push_queue`,
  `bas_worksheet_snapshots`, `customer_credit_notes`, `supplier_credit_notes`.
- Representative finish-line RPCs exist, including `create_and_post_journal`,
  `generate_bas_worksheet`, `build_fbt_return`, `build_tpar_report`,
  `build_franking_register`, `build_sgc_statement`, `build_superstream_payload`,
  and the AR/AP credit-note RPCs.

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
