# Edge Function Inventory

**Status:** active reconciliation artifact.
**Source of truth:** `supabase/functions-inventory.json`.
**Live evidence:** `supabase functions list --project-ref dxoikltymmknxqpkpyhi --output json`
on 2026-07-02 after local/live reconciliation.

Local function directories: 71. Live active functions observed: 69. Remote-only
functions observed: 0.

Retired 2026-10-03 (BANK-01): `bank-link-token`, `bank-exchange`, `bank-job-poll` and `bank-discover` served the bank-feed
provider that never went live. Their source is removed; delete them from the live project when the Redbark functions
are deployed (see `SETUP_BANK_FEEDS.md`).

`local-only` means source exists in this branch but was not observed as an active
live function. Do not deploy these by default; use a staging ticket and proof.

| Function                       | Live status | Live verify_jwt | Live version | Notes                                                                  |
| ------------------------------ | ----------- | --------------- | ------------ | ---------------------------------------------------------------------- |
| `accountant-email-query`       | live-active | false           | 32           |                                                                        |
| `accountant-orchestrator`      | live-active | true            | 1            | Deployed 2026-06-30; cron/auth gate remains fail-closed.               |
| `accountant-session-digest`    | live-active | false           | 33           |                                                                        |
| `accruals-run`                 | live-active | false           | 1            | Deployed 2026-06-30; cron secret/service-role auth gate.               |
| `advisor`                      | live-active | true            | 19           |                                                                        |
| `api-gateway`                  | live-active | false           | 26           |                                                                        |
| `ask-bot`                      | live-active | true            | 36           |                                                                        |
| `ato-correspondence`           | local-only  | n/a             | n/a          | ATO external-gated.                                                    |
| `ato-lodge`                    | live-active | true            | 5            | ATO external-gated behavior; keep live transmit disabled by policy.     |
| `auto-reconcile`               | live-active | false           | 26           |                                                                        |
| `automation-watchdog`          | live-active | false           | 13           | Background anomaly/healing scanner; cron/service-secret gated.          |
| `automation-worker`            | live-active | false           | 16           | Automation job drainer; cron/service-secret gated.                     |
| `bank-csv-import`              | live-active | true            | 39           |                                                                        |
| `bank-disconnect`              | local-only  | n/a             | n/a          | Pending deploy: bank connection teardown.                              |
| `bank-feed-accounts`           | local-only  | n/a             | n/a          | Pending deploy: lists Redbark accounts for an admin (BANK-05).         |
| `bank-feed-link`               | local-only  | n/a             | n/a          | Pending deploy: links a Redbark account with an import-from date.      |
| `bank-statement-extract`       | live-active | true            | 37           |                                                                        |
| `bank-sync`                    | live-active | true            | 43           |                                                                        |
| `bank-sync-all`                | live-active | false           | 41           |                                                                        |
| `bank-transaction-attach-job`  | local-only  | n/a             | n/a          | Pending deploy: attach bank txn to job.                                |
| `bank-transaction-classifier`   | live-active | false           | 22           | Bank transaction coding classifier; cron/user auth paths.               |
| `bank-webhook`                 | live-active | false           | 41           |                                                                        |
| `bas-lodgement-pack`           | live-active | true            | 5            | BAS review pack builder; not ATO transport.                            |
| `bas-worksheet-pdf`            | live-active | true            | 1            | Deployed 2026-06-30; caller-scoped PDF render.                         |
| `bills-allocate-batch`         | live-active | true            | 13           | Batch bill allocation helper.                                          |
| `bills-attach`                 | live-active | true            | 42           |                                                                        |
| `bills-extract`                | live-active | true            | 62           |                                                                        |
| `bills-extract-batch`          | live-active | true            | 42           |                                                                        |
| `coding-classifier`            | live-active | true            | 1            | Deployed 2026-06-30; fails closed if connector signing secret missing. |
| `crm-pnl-sync-push`            | local-only  | n/a             | n/a          | Pending deploy: CRM P&L push (endpoint secrets uncoordinated).         |
| `depreciation-run`             | live-active | false           | 1            | Deployed 2026-06-30; cron secret/service-role auth gate.               |
| `div7a-agreement`              | live-active | true            | 1            | Deployed 2026-06-30; document generation only.                         |
| `employee-tfn-save`            | live-active | false           | 1            | Deployed 2026-06-30; self-auth + TFN vault path.                       |
| `eofy-pack`                    | live-active | true            | 19           |                                                                        |
| `gmail-backfill`               | live-active | true            | 40           |                                                                        |
| `gmail-classify-ai`            | live-active | true            | 39           |                                                                        |
| `gmail-mine`                   | live-active | true            | 40           |                                                                        |
| `gmail-oauth-callback`         | live-active | true            | 41           |                                                                        |
| `gmail-oauth-start`            | live-active | true            | 42           |                                                                        |
| `gmail-pubsub-push`            | live-active | false           | 48           |                                                                        |
| `gmail-watch-renew`            | live-active | false           | 43           |                                                                        |
| `ingest`                       | live-active | false           | 25           |                                                                        |
| `intake-routing-apply`         | live-active | true            | 39           |                                                                        |
| `legal-corpus-ingest`          | live-active | false           | 24           |                                                                        |
| `legal-corpus-sync`            | live-active | false           | 23           |                                                                        |
| `legal-horizon-run`            | live-active | true            | 18           |                                                                        |
| `legal-horizon-scan`           | live-active | false           | 19           |                                                                        |
| `lodgements`                   | local-only  | n/a             | n/a          | Hold until deploy proof; ATO live actions remain external-gated.       |
| `notifications-cron`           | live-active | false           | 38           |                                                                        |
| `payment-runs-aba-export`      | live-active | false           | 35           |                                                                        |
| `payment-runs-create`          | live-active | false           | 35           |                                                                        |
| `payment-runs-mark-paid`       | live-active | false           | 35           |                                                                        |
| `payroll-create-pay-run`       | live-active | true            | 35           |                                                                        |
| `payroll-export-stp`           | live-active | true            | 35           |                                                                        |
| `payroll-finalise-pay-run`     | live-active | true            | 35           |                                                                        |
| `payroll-termination`          | live-active | false           | 1            | Deployed 2026-06-30; calculation only, no lodgement.                   |
| `receipt-sync-dispatch`        | live-active | false           | 21           |                                                                        |
| `receipt-webhook`              | live-active | false           | 20           |                                                                        |
| `smsf-audit-pack`              | live-active | true            | 1            | Deployed 2026-06-30; auditor hand-off prep only.                       |
| `staged-entities-enrich-sonar` | live-active | true            | 30           |                                                                        |
| `subscriptions-autoconfirm`    | live-active | true            | 25           |                                                                        |
| `subscriptions-detect`         | live-active | true            | 39           |                                                                        |
| `super-batch-send`             | live-active | false           | 1            | Deployed 2026-06-30; approval-gated clearing-house export path.        |
| `team-invite`                  | live-active | true            | 37           | Redeployed 2026-06-30 after 0199-0207 DB proof.                        |
| `trust-minute`                 | live-active | true            | 1            | Deployed 2026-06-30; document generation only.                         |
| `working-papers`               | live-active | true            | 1            | Deployed 2026-06-30; working-paper bundle prep only.                   |
| `xero-oauth-callback`          | live-active | false           | 42           |                                                                        |
| `xero-oauth-start`             | live-active | true            | 42           |                                                                        |
| `xero-pull-bank-transactions`  | local-only  | n/a             | n/a          | Pending deploy: Xero pull-first bank transactions.                     |
| `xero-push-bill`               | live-active | false           | 35           |                                                                        |
| `xero-push-invoice`            | live-active | false           | 35           |                                                                        |
| `xero-sync-accounts`           | live-active | false           | 35           |                                                                        |
| `xero-sync-payments`           | live-active | false           | 35           |                                                                        |
| `xero-webhook`                 | local-only  | n/a             | n/a          | Pending deploy: Xero webhook receiver (ITR validated).                 |

## Deployment Notes

- Default deploy loops should read `supabase/functions-inventory.json` and deploy
  only `deploy_by_default=true`.
- Local-only functions are not dead code. They are queued deploy/proof work.
- `ato-correspondence` and `lodgements` remain local-only holdbacks.
- `ato-lodge` is live-active, but ATO live behavior remains on the
  external-gated ATO TODO list and must stay policy-disabled until approved.
