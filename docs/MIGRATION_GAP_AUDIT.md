# Migration Gap Audit & Remote-Schema Reconciliation

**Date:** 2026-06-20
**Project ref:** `dxoikltymmknxqpkpyhi`
**Branch:** `chore-migration-reconciliation`
**Author:** automated reconciliation pass

## 2026-10-03 MIG-01: every migration applies to a fresh database

`node scripts/db/run-pg-sql-tests.mjs --strict` builds a disposable Supabase
Postgres from the migration files in order. Nine files failed; they were listed
in `scripts/db/known-migration-failures.json`, which is now empty. Each repair
below is in place, keeps what live already ran, and is marked in the file with a
`MIG-01 repair (2026-10-03)` comment.

Why "what live ran" is unaffected: several numbered versions are shared by two
files (for example `0200_tag_drop.sql` and `0200_workstream_tasks.sql`), and the
2026-06-30 batch applied renumbered copies `0230`-`0236`. Every file repaired
in place below either raised an error on any database (so it never ran
anywhere) or only changes statement order. The renumbered copies that did run
live are only made idempotent, which changes nothing where their objects
already exist.

| File | Failure on a fresh database | Repair |
|---|---|---|
| `0200_workstream_tasks.sql` | `get_workstream_tasks`: `se.organization_id` (and `b`/`ci`/`bt`) selected in aggregate arms without `GROUP BY`; behind that, `public.customer_invoices` (dropped in `0042`), `data_completeness_findings.deleted_at` (no such column) and `ORDER BY urgency, created_at` on a `UNION` that exposes no such names | The same corrections the live copy `0231` carries: `p_org_id` in those arms (each arm's `WHERE` already restricts to `p_org_id`, so the rows are identical), `public.invoices`, no `deleted_at` filter, `ORDER BY 13, 14` (urgency, created_at). Function body now identical to `0231`'s. |
| `0202_anomaly_signals.sql` | Needed `public.workstream_task` from `0200`, and carries the same function errors | Same corrections; body identical to the live copy `0233`. |
| `0204_close_tasks.sql` | As `0202` | Same corrections; body identical to the live copy `0235`. |
| `20260701160000_close_task_preflight_detail.sql` | Arms 1-11 copied "unchanged from 0204", with its errors | Arms 1-11 corrected to match `0235`; arm 12 (the pre-flight close signal) and the output columns are unchanged. |
| `0203_ap_exception_review.sql` | A stray second `$$;` after the function body (unterminated dollar-quoted string) | Removed the stray line. |
| `0206_bank_classifier_schema.sql` | Partial index `WHERE ... deleted_at IS NULL` created before `ADD COLUMN deleted_at` | Swapped the two statements. |
| `0208_advisor_work_proofs.sql` | References `public.organisations` and `public.organisation_users(organisation_id)`; neither exists in any Looplet database | Kept as a documented no-op with the original statements commented out. Fixing only the spelling is not enough: the policy still names `organisation_users`, and the file would create an older `advisor_work_proofs` shape (`org_id`, `session_id`, ...) before `0230`, whose `CREATE TABLE IF NOT EXISTS` would then skip and whose `organization_id` indexes would fail. Live's table comes from `0230`. |
| `0231_workstream_tasks.sql` | (Applied before only because `0200` failed.) `CREATE TYPE public.workstream_task` now meets the type `0200` creates | `CREATE TYPE` wrapped in a `duplicate_object` guard. |
| `0232_automation_decisions.sql` | Renumbered copy of `0201`: `type automation_confidence already exists` | Made idempotent: guarded enum, `CREATE TABLE/INDEX IF NOT EXISTS`, `DROP POLICY IF EXISTS` before each `CREATE POLICY`. Functions were already `CREATE OR REPLACE`. |
| `0236_automation_feedback.sql` | Renumbered copy of `0205`: `relation automation_feedback already exists` | Made idempotent: `CREATE TABLE/INDEX IF NOT EXISTS`, `CREATE OR REPLACE VIEW`, `DROP POLICY IF EXISTS` before each `CREATE POLICY`. |

Live ran `0231`/`0232`/`0236` with plain `CREATE TYPE`/`CREATE TABLE`, which
would have failed had `0200`/`0201`/`0205` run there first; that is the
evidence that those originals never ran live.

Proof: `node scripts/db/run-pg-sql-tests.mjs --strict` reports
`287 applied, 0 known failures, 0 problems (287 files)` on the books worktree
(which also carries the new `20261003150000`-`20261003155000` migrations).
None of these repairs has been applied to live, and none needs to be: the
repaired files are either already recorded there (the copies) or never ran.

## 2026-06-29 Wrap-up Addendum

The live project `dxoikltymmknxqpkpyhi` now has migration-history parity with
the current local migration set through `0196`.

Current evidence:

- `supabase db query --linked` works through the Management API.
- `supabase migration list --linked` works when the stale
  `SUPABASE_DB_PASSWORD` environment variable is removed.
- Earlier on 2026-06-29, it compared local numeric files against remote
  timestamp versions and reported local `0089`-`0196` as local-only, even though
  raw `supabase_migrations.schema_migrations` rows mapped many timestamp
  versions to the same local migration names.
- That timestamp-history drift was repaired: 54 timestamp-version rows
  whose `name` matched a local migration prefix were rewritten to the matching
  numeric `version` (`0089`, `0090`-`0137`, `0108`-`0115`, `0151`-`0153`,
  `0178`, and `0179`).
- Missing live DDL for `0181`-`0187` was applied on 2026-06-29 after checking
  target objects/columns were absent and existing data would not violate the new
  constraints. Verified live after apply: `lodgements`, `ato_correspondence`,
  `ato_correspondence_drafts`, `lodgement_type`, `lodgement_status`,
  `compile_working_papers(uuid,date,date)`,
  `distribution_finalise(uuid,uuid,integer,text)`,
  `distribution_finalise_payload(uuid,uuid,integer,text)`,
  `obligation_status.lodgement_id`, `obligation_status.lodged_at`, receipt POS
  reliability columns, and the expected lodgement/receipt indexes all exist.
- Numeric history rows were added for known-applied or intentionally no-op
  migrations `0180`-`0196`. `0180`, `0185`, and `0192` are inert/commented notes.
  `0188` was not replayed because live `write_audit_log()` already includes the
  organizations special case and has a stricter `search_path = public, pg_temp`
  than the local file. The other rows in that range have live DDL evidence.
- The previously local-only ranges `0138`-`0150` and `0154`-`0177` were then
  applied to live in order. `0175`/`0176` were not replayed because advice-note
  table/RPC objects already existed via the later `0194` hardening migration;
  their live objects were verified before recording history.
- Post-repair `supabase migration list --linked` shows local/remote parity for
  every local migration version through `0196`.
- `supabase db push --linked --dry-run` returned `Remote database is up to date.`

Remaining migration-history work:

- No current local migration file is pending on the linked remote. Continue to
  verify live object/function evidence before any future manual history repair.

## Problem

The repo's `supabase/migrations/` folder is missing several migration files that
correspond to objects which exist in the **live** database. A fresh
`supabase db reset` would therefore **not** reproduce the live schema: multiple
later migrations `ALTER` / FK-reference / index tables that no migration ever
`CREATE`s, and several edge functions / frontend pages query tables, views and
RPCs that have no `CREATE` statement anywhere in the repo.

## Part A — Gap Audit (repo-only, authoritative)

### A.1 Missing migration NUMBERS (gaps in the sequence)

Existing files jump: `0001–0004`, then `0028`, `0030–0036`, `0039–0054`.

Gap slots (no file present): **0005–0027, 0029, 0037, 0038.**

Backfill files were placed in: `0005–0013`, `0029`, `0038`. Reference-data seed
files were added in the free slots `0014`/`0015` (see B.3). (Slot `0037` was
initially used for a deferred FK but removed — see B.3/B.4: existing migration
`0030` already adds that FK.)

### A.2 Objects REFERENCED/USED but NOT created by any migration

Determined by scanning `supabase/migrations/*.sql` (created objects),
`supabase/functions/**/*.ts` (`.from('X')`, `.rpc('Y')`), and `src/**/*.{ts,tsx}`
(frontend `.from()` / `.rpc()`), then diffing.

#### Tables (no `CREATE TABLE` in any migration)

| Object                 | Evidence of use                                                                                                                          | Smoking gun                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `intake_categories`    | `gmail-classify-ai`, `staged-entities-enrich-sonar`, `src/hooks/useIntakeCategories.ts`                                                  | FK-referenced by `0049` (`intake_categories(code)`)                                      |
| `intake_known_senders` | `lookup_known_sender()` function body                                                                                                    | required by RPC used in `gmail-mine`                                                     |
| `intake_rules`         | `intake-routing-apply`, `gmail-pubsub-push`, `xero-push-*`, `src/pages/onboarding/Triage.tsx`                                            | indexed by `0036`; FK target of `bank_transactions.applied_intake_rule_id` (`0036`)      |
| `bank_connections`     | `bank-exchange`, `bank-sync*`, `bank-csv-import`, `notifications-cron`, `src/components/settings/BankConnect.tsx`                        | —                                                                                        |
| `bank_accounts`        | `bank-exchange`, `bank-sync`, `bank-csv-import`, `src/pages/reports/CashFlow.tsx`                                                        | —                                                                                        |
| `bank_transactions`    | `bank-sync`, `bank-csv-import`, `intake-routing-apply`, `subscriptions-detect`, `src/pages/Reconciliation.tsx`, `SubscriptionDetail.tsx` | `ALTER`ed by `0030`, `0031`, `0036`; indexed by `0043` — table never created             |
| `subscriptions`        | `subscriptions-detect`, `notifications-cron`, `src/pages/Subscriptions*.tsx`                                                             | referenced by `0047` `split_resource_type` enum + `v_subscription_effective_allocations` |
| `staged_entities`      | `gmail-classify-ai`, `gmail-mine`, `staged-entities-enrich-sonar`, `src/hooks/onboarding/useStagedEntities.ts`                           | `ALTER`ed by `0049` (adds `sonar_*`) — table never created                               |
| `gmail_integrations`   | all `gmail-*` functions, `src/hooks/useGmailIntegrations.ts`                                                                             | —                                                                                        |
| `debts`                | `src/pages/Debts.tsx`, `DebtDetail.tsx`                                                                                                  | —                                                                                        |
| `debt_payments`        | `src/pages/Debts.tsx`, `DebtDetail.tsx`                                                                                                  | —                                                                                        |

#### Views (no `CREATE VIEW` in any migration)

| Object                    | Evidence of use                                                     | Smoking gun                                                                                                         |
| ------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `v_bank_match_candidates` | `src/pages/Reconciliation.tsx` (`.from('v_bank_match_candidates')`) | `0035` header comment calls itself a "mirror of v_bank_match_candidates" — the mirrored view is absent              |
| `v_customer_pnl`          | `src/pages/CustomerDetail.tsx` (`.from('v_customer_pnl')`)          | `0030` comment: _"v_customer_pnl: see migration body in DB"_ — explicit admission the DDL lives only in the live DB |

#### Functions / RPCs (no `CREATE FUNCTION` in any migration)

| Object                                   | Evidence of use                             |
| ---------------------------------------- | ------------------------------------------- |
| `lookup_known_sender(text)`              | `gmail-mine` `.rpc('lookup_known_sender')`  |
| `match_intake_rule(uuid,text,text,text)` | `gmail-pubsub-push`, `intake-routing-apply` |
| `record_intake_rule_hit(uuid)`           | `gmail-pubsub-push`, `intake-routing-apply` |
| `onboarding_progress(uuid)`              | `src/hooks/onboarding/useStagedEntities.ts` |
| `business_profile_signals(uuid)`         | `src/hooks/useBusinessSignals.ts`           |

#### Enum types implied by the above (no `CREATE TYPE` in any migration)

`bank_provider`, `bank_connection_status`, `bank_account_type`,
`subscription_cadence`, `subscription_status`, `staged_entity_kind`,
`staged_entity_status`, `debt_kind`.

### A.3 Objects that LOOK missing but are NOT

- `v_bank_invoice_match_candidates` — created by `0035` (present).
- `invoices`, `invoice_line_items`, `invoice_payments` — created by `0030`.
- `intake_categories` is FK-referenced by `0049` but **not** created there; it is in the missing set above.
- `src/lib/database.types.ts` named in the task brief **does not exist** in this repo (only `src/lib/{csv,money,supabase}.ts`). Frontend was scanned directly instead.

## Part B — Reconstruction

### B.1 `supabase db dump` — BLOCKED (needs DB password)

```
supabase link --project-ref dxoikltymmknxqpkpyhi      # SUCCEEDED (access token)
supabase db dump --linked --schema public -f /tmp/remote.sql   # FAILED
```

Error (verbatim):

```
Dumping schemas from remote database...
pg_dump: error: connection to server at "aws-1-ap-south-1.pooler.supabase.com"
(3.111.225.200), port 5432 failed: FATAL:  password authentication failed for user "postgres"
error running container: exit 1
```

`db dump` runs `pg_dump` inside a Docker container and needs the **database
password**, not just the CLI access token — exactly the failure mode the brief
anticipated. **Needs DB password to complete via the CLI path.**

### B.2 Reconstruction COMPLETED via read-only MCP path

The authenticated Supabase **MCP** connection (`list_tables`, `execute_sql`) does
_not_ need the DB password and is **read-only**. DDL for every missing object
was extracted from the live DB using `information_schema`, `pg_constraint`,
`pg_indexes`, `pg_views`, `pg_get_constraintdef()` and `pg_get_functiondef()`.
**No DDL was applied and nothing was deployed** — only `SELECT`s were run.

> **On "verbatim".** Earlier notes (and a few migration headers) call these
> reconstructions "verbatim". That is imprecise: `pg_views` /
> `pg_get_functiondef()` return the _reparsed and normalized_ server-side
> representation (re-qualified identifiers, re-cast literals, canonicalized
> whitespace), not the original source text. The backfills are therefore
> **semantically equivalent** to the live objects rather than byte-for-byte
> copies. View `security` settings (e.g. `security_invoker = on`) live in
> `pg_class.reloptions`, _not_ in the `pg_views` body, and must be re-applied
> explicitly in the `CREATE VIEW` — see B.6.

### B.3 Backfill migration files created

All use `CREATE ... IF NOT EXISTS` / `CREATE OR REPLACE` / `DO $$ ... EXCEPTION
WHEN duplicate_object`, so they are idempotent and safe to apply on the live DB.
RLS is enabled and policies recreated to match live (`get_accessible_org_ids()`
pattern). Existing migration files were **not** modified or reordered.

| File                                                | Objects                                                                                                                    |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `0005_intake_taxonomy_backfill.sql`                 | enums `staged_entity_kind`, `staged_entity_status`; tables `intake_categories`, `intake_known_senders` (+RLS)              |
| `0006_intake_rules_backfill.sql`                    | table `intake_rules` (+indexes, +RLS)                                                                                      |
| `0007_bank_connections_accounts_backfill.sql`       | enums `bank_provider`, `bank_connection_status`, `bank_account_type`; tables `bank_connections`, `bank_accounts` (+RLS)    |
| `0008_bank_transactions_backfill.sql`               | table `bank_transactions` (+indexes, +RLS); invoices-FK deferred to 0037                                                   |
| `0009_gmail_integrations_backfill.sql`              | table `gmail_integrations` (+RLS)                                                                                          |
| `0010_staged_entities_backfill.sql`                 | table `staged_entities` incl. `sonar_*` cols (+RLS)                                                                        |
| `0011_subscriptions_backfill.sql`                   | enums `subscription_cadence`, `subscription_status`; table `subscriptions` (+RLS)                                          |
| `0012_debts_backfill.sql`                           | enum `debt_kind`; tables `debts`, `debt_payments` (+RLS)                                                                   |
| `0013_intake_functions_backfill.sql`                | `lookup_known_sender`, `match_intake_rule`, `record_intake_rule_hit`                                                       |
| `0029_onboarding_and_signal_functions_backfill.sql` | `onboarding_progress`, `business_profile_signals`                                                                          |
| `0038_match_and_customer_pnl_views_backfill.sql`    | views `v_bank_match_candidates`, `v_customer_pnl` (both `WITH (security_invoker = on)` — see B.6)                          |
| `0014_intake_categories_seed.sql`                   | seed data: all 24 `intake_categories` rows (`INSERT ... ON CONFLICT (code) DO NOTHING`)                                    |
| `0015_intake_known_senders_seed.sql`                | seed data: all 723 `intake_known_senders` rows (`INSERT ... ON CONFLICT (domain, COALESCE(sender_pattern,'')) DO NOTHING`) |

The deferred FK `bank_transactions.matched_invoice_id -> invoices(id)` does **not**
need its own backfill: the existing migration `0030` already adds it (guarded
`ADD CONSTRAINT bank_transactions_matched_invoice_fkey`), and now runs against the
`bank_transactions` table created in `0008`.

### B.4 Ordering notes (why these slot numbers)

- `bank_transactions` (0008) FK to `invoices` is **not declared in 0008** because
  `invoices` is created later (0030). The existing migration 0030 already adds that
  FK (`bank_transactions_matched_invoice_fkey`) in a guarded block; since 0008 < 0030,
  the table exists by the time 0030's `ADD CONSTRAINT` runs. No extra backfill needed.
- The two views (0038) depend on `invoices` (0030, incl. `amount_paid_cents` /
  `balance_due_cents`) and on `bank_transactions`/`bills`, so they are placed after 0030.
- `subscriptions` (0011) is created before 0047 which references it.
- Later `ALTER ... ADD COLUMN IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`
  statements in 0030/0031/0036/0043/0049 no-op because the columns/indexes already
  exist from the backfills.

### B.6 View security (`security_invoker`)

`v_bank_match_candidates` and `v_customer_pnl` are both org-scoped (they expose
`organization_id` and join org-scoped base tables whose RLS does the tenant
filtering). The live DB has `security_invoker = on` on both
(`SELECT relname, reloptions FROM pg_class ...` → `{security_invoker=on}`,
verified 2026-06-20). This option is stored in `pg_class.reloptions` and is **not**
part of the `pg_views` body, so the initial reconstruction silently dropped it —
the views would have run as the definer (owner), bypassing RLS and leaking rows
across organizations. `0038` now declares `WITH (security_invoker = on)` on both
`CREATE OR REPLACE VIEW` statements, matching live and the 0055 security work.

### B.5 Caveats / not covered

- **GRANTs and table ownership** were not extracted (only RLS policies). If strict
  privilege parity is required, extract `information_schema.role_table_grants`.
- **Reference / seed data IS now backfilled.** `intake_categories` (24 rows) and
  `intake_known_senders` (723 rows) are global reference tables (`source='manual'`
  for all senders) consumed by `lookup_known_sender()` and the classifier — an empty
  table on a fresh `db reset` would break intake routing. Seeded idempotently in
  `0014` / `0015` (`INSERT ... ON CONFLICT DO NOTHING`). Both sets are seeded in full
  (not a subset). Snapshot taken 2026-06-20; new live rows added after that date are
  not reflected until the seed files are regenerated.
- These files reproduce the live **shape**; they have not been applied or validated
  against a clean `supabase db reset` (no local DB / no DB password available here).
  Recommend running `supabase db reset` against a shadow DB before merging.
