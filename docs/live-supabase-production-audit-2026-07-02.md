# Live Supabase Production Audit - 2026-07-02

Project: `dxoikltymmknxqpkpyhi` (`looplet accounting`)

This file records the live Supabase audit supplied from the Chrome/Supabase
testing pass, plus the follow-up remediation completed from this worktree.

## Executive Verdict

Current verdict: PARTIAL.

Current completion estimate: approximately 85% overall product readiness.

Reason: local source-contract wiring is still `63 / 63`, but production is not
fully activated. The strongest blockers are missing production migration proof,
an invalid local linked-DB password, and absent signed-in/RLS proof.

## Passed Live Checks

- Vault `auto_reconcile_cron_secret` exists.
- Vault `bank_txn_classifier_cron_secret` exists.
- Vault and Edge digest checks matched for:
  - `AUTO_RECONCILE_CRON_SECRET`
  - `BANK_CLASSIFIER_CRON_SECRET`
- `auto-reconcile-daily` cron exists and is active.
- `bank-txn-classifier-cron` cron exists and is active.
- `bank-txn-classifier-cron` had successful runs.
- No 5xx Edge Function errors were observed in the audited last-hour window.
- `automation-worker` was returning 200 every 2 minutes in the audited window.
- `automation-watchdog` returned 200 in the audited window.

## Fixed After Audit

The Chrome audit reported these Edge Functions missing:

- `ato-lodge`
- `bas-lodgement-pack`

Follow-up action completed from this worktree:

- `deno check supabase/functions/ato-lodge/index.ts supabase/functions/bas-lodgement-pack/index.ts` passed.
- `deno test --quiet supabase/functions/ato-lodge/index.test.ts supabase/functions/bas-lodgement-pack/pack.test.ts` passed: 7 tests passed.
- `supabase functions deploy ato-lodge --project-ref dxoikltymmknxqpkpyhi` succeeded.
- `supabase functions deploy bas-lodgement-pack --project-ref dxoikltymmknxqpkpyhi` succeeded.
- `npm run supabase:readiness` now reports required functions `ok: true`.

The Chrome audit also reported these legal runtime Edge secrets missing:

- `LEGAL_INGEST_SECRET`
- `LEGAL_SCAN_SECRET`

Follow-up action completed from this worktree:

- Fresh random values were generated and set through `supabase secrets set`
  without printing secret values to the terminal or docs.
- `npm run supabase:readiness` now reports required secrets `ok: true`,
  including `LEGAL_INGEST_SECRET` and `LEGAL_SCAN_SECRET`.

Evidence logs:

- `tmp/deploy-ato-lodge.log`
- `tmp/deploy-bas-lodgement-pack.log`
- `tmp/set-legal-edge-secrets.log`
- `tmp/supabase-readiness-after-legal-functions.log`
- `tmp/supabase-readiness-after-invoice-zero.log`

## Remaining Failures

- The original eight target migrations are not proven live and were reported
  missing by the Chrome/Supabase audit:
  - `20260701070000_reconcile_evidence_atomic`
  - `20260702090000_period_lock_money_tables`
  - `20260702100000_statutory_statements_period_scope`
  - `20260702103000_bas_g10_capital_split`
  - `20260702104500_bas_worksheet_deterministic_period`
  - `20260702110000_bas_lodgement_draft_rpc`
  - `20260702123000_orchestrator_engine_dispatch`
  - `20260702124500_gmail_mine_refresh_jobs`
- A ninth local migration was added after that audit and must also be applied:
  - `20260702130000_invoice_zero_gst_treatment`
- `npm run supabase:readiness` cannot verify or apply migrations from this
  shell because `SUPABASE_DB_PASSWORD` is present but invalid for the linked
  remote DB.
- `SUPABASE_SERVICE_ROLE_KEY`, `TEST_USER_JWT`, and `TEST_ORG_ID` are missing
  locally, so deploy-gated signed-in/RLS tests still cannot run.

## Remaining Next Actions

1. Replace `SUPABASE_DB_PASSWORD` with the correct linked project DB password.
2. Rerun `npm run supabase:readiness`.
3. Apply the nine pending migrations only after confirming the SQL diff.
4. Load service-role/test JWT/fixture IDs.
5. Run deploy-gated tests without skips.
6. Re-run browser/signed-in proof and update the completion estimate only from
   evidence.
