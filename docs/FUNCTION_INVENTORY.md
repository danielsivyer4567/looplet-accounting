# Edge Function Inventory

**Status:** active reconciliation artifact.
**Source of truth:** `supabase/functions-inventory.json`.
**Live evidence:** `supabase functions list --project-ref dxoikltymmknxqpkpyhi --output json`
on 2026-06-29.

Local function directories: 66. Live active functions observed: 51. Remote-only
functions observed: 0.

`local-only` means source exists in this branch but was not observed as an active
live function. Do not deploy these by default; use a staging ticket and proof.

| Function                       | Live status | Live verify_jwt | Live version | Notes                                                            |
| ------------------------------ | ----------- | --------------- | ------------ | ---------------------------------------------------------------- |
| `accountant-email-query`       | live-active | false           | 32           |                                                                  |
| `accountant-orchestrator`      | local-only  | n/a             | n/a          | Hold until cron/deploy proof.                                    |
| `accountant-session-digest`    | live-active | false           | 33           |                                                                  |
| `accruals-run`                 | local-only  | n/a             | n/a          | Hold until accounting job proof.                                 |
| `advisor`                      | live-active | true            | 19           |                                                                  |
| `api-gateway`                  | live-active | false           | 26           |                                                                  |
| `ask-bot`                      | live-active | true            | 36           |                                                                  |
| `ato-correspondence`           | local-only  | n/a             | n/a          | ATO external-gated.                                              |
| `ato-lodge`                    | local-only  | n/a             | n/a          | ATO external-gated; leave disabled.                              |
| `auto-reconcile`               | live-active | false           | 26           |                                                                  |
| `bank-csv-import`              | live-active | true            | 39           |                                                                  |
| `bank-discover`                | live-active | true            | 28           |                                                                  |
| `bank-exchange`                | live-active | true            | 40           |                                                                  |
| `bank-job-poll`                | live-active | true            | 37           |                                                                  |
| `bank-link-token`              | live-active | true            | 41           |                                                                  |
| `bank-statement-extract`       | live-active | true            | 37           |                                                                  |
| `bank-sync`                    | live-active | true            | 43           |                                                                  |
| `bank-sync-all`                | live-active | false           | 41           |                                                                  |
| `bank-webhook`                 | live-active | false           | 41           |                                                                  |
| `bas-worksheet-pdf`            | local-only  | n/a             | n/a          | Hold until PDF deploy proof.                                     |
| `bills-attach`                 | live-active | true            | 42           |                                                                  |
| `bills-extract`                | live-active | true            | 62           |                                                                  |
| `bills-extract-batch`          | live-active | true            | 42           |                                                                  |
| `coding-classifier`            | local-only  | n/a             | n/a          | Hold until classifier deploy proof.                              |
| `depreciation-run`             | local-only  | n/a             | n/a          | Hold until accounting job proof.                                 |
| `div7a-agreement`              | local-only  | n/a             | n/a          | Hold until tax workflow proof.                                   |
| `employee-tfn-save`            | local-only  | n/a             | n/a          | Hold until secret-store proof.                                   |
| `eofy-pack`                    | live-active | true            | 19           |                                                                  |
| `gmail-backfill`               | live-active | true            | 40           |                                                                  |
| `gmail-classify-ai`            | live-active | true            | 39           |                                                                  |
| `gmail-mine`                   | live-active | true            | 40           |                                                                  |
| `gmail-oauth-callback`         | live-active | true            | 41           |                                                                  |
| `gmail-oauth-start`            | live-active | true            | 42           |                                                                  |
| `gmail-pubsub-push`            | live-active | false           | 48           |                                                                  |
| `gmail-watch-renew`            | live-active | false           | 43           |                                                                  |
| `ingest`                       | live-active | false           | 25           |                                                                  |
| `intake-routing-apply`         | live-active | true            | 39           |                                                                  |
| `legal-corpus-ingest`          | live-active | false           | 24           |                                                                  |
| `legal-corpus-sync`            | live-active | false           | 23           |                                                                  |
| `legal-horizon-run`            | live-active | true            | 18           |                                                                  |
| `legal-horizon-scan`           | live-active | false           | 19           |                                                                  |
| `lodgements`                   | local-only  | n/a             | n/a          | Hold until deploy proof; ATO live actions remain external-gated. |
| `notifications-cron`           | live-active | false           | 38           |                                                                  |
| `payment-runs-aba-export`      | live-active | false           | 35           |                                                                  |
| `payment-runs-create`          | live-active | false           | 35           |                                                                  |
| `payment-runs-mark-paid`       | live-active | false           | 35           |                                                                  |
| `payroll-create-pay-run`       | live-active | true            | 35           |                                                                  |
| `payroll-export-stp`           | live-active | true            | 35           |                                                                  |
| `payroll-finalise-pay-run`     | live-active | true            | 35           |                                                                  |
| `payroll-termination`          | local-only  | n/a             | n/a          | Hold until payroll lifecycle proof.                              |
| `receipt-sync-dispatch`        | live-active | false           | 21           |                                                                  |
| `receipt-webhook`              | live-active | false           | 20           |                                                                  |
| `smsf-audit-pack`              | local-only  | n/a             | n/a          | Hold until SMSF workflow proof.                                  |
| `staged-entities-enrich-sonar` | live-active | true            | 30           |                                                                  |
| `subscriptions-autoconfirm`    | live-active | true            | 25           |                                                                  |
| `subscriptions-detect`         | live-active | true            | 39           |                                                                  |
| `super-batch-send`             | local-only  | n/a             | n/a          | Hold until clearing-house export proof.                          |
| `team-invite`                  | live-active | true            | 36           |                                                                  |
| `trust-minute`                 | local-only  | n/a             | n/a          | Hold until trust workflow proof.                                 |
| `working-papers`               | local-only  | n/a             | n/a          | Hold until working-paper deploy proof.                           |
| `xero-oauth-callback`          | live-active | false           | 42           |                                                                  |
| `xero-oauth-start`             | live-active | true            | 42           |                                                                  |
| `xero-push-bill`               | live-active | false           | 35           |                                                                  |
| `xero-push-invoice`            | live-active | false           | 35           |                                                                  |
| `xero-sync-accounts`           | live-active | false           | 35           |                                                                  |
| `xero-sync-payments`           | live-active | false           | 35           |                                                                  |

## Deployment Notes

- Default deploy loops should read `supabase/functions-inventory.json` and deploy
  only `deploy_by_default=true`.
- Local-only functions are not dead code. They are queued deploy/proof work.
- `ato-lodge`, `ato-correspondence`, and ATO live behavior remain on the
  external-gated ATO TODO list.
