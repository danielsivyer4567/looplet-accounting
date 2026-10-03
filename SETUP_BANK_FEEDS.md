# Bank feeds setup — Redbark

**Status (3 October 2026):** the Redbark bank feed is built in this repo (ledger items BANK-01 to BANK-06) and is **not
deployed**. The earlier provider never went live and has been removed. Statement import (CSV and PDF) is unchanged.

## How it works

| Piece | What it does |
| --- | --- |
| Redbark login | Holds the bank connections. Banks are connected in Redbark, not in Looplet. |
| `REDBARK_API_KEY` | One server key, read only by edge functions. It never reaches the browser. |
| `REDBARK_ORGANIZATION_IDS` | The Looplet organisations allowed to use the feed. Unset means none: listing, linking, syncing and webhooks all refuse. |
| `bank-feed-accounts` | An admin or owner lists the Redbark accounts (Settings → Bank accounts → Bank feed (Redbark)). |
| `bank-feed-link` | An admin or owner links one account with an import-from date. One Redbark connection can belong to one organisation only. |
| `bank-sync` | Imports posted transactions from each linked account's import-from date, in date windows with a checkpoint (`bank_accounts.feed_covered_through`). Pending transactions are skipped. A transaction is never imported twice and an imported one is never rewritten. Then runs the post-sync chain (subscriptions, intake routing, classifier, auto-reconcile). |
| `bank-webhook` | Receives Redbark's signed `transactions.synced` events, stores each in `bank_events_raw`, then starts one `bank-sync` per linked connection. |
| `bank-sync-all` | Cron every six hours; the backstop if a webhook is missed. |
| `bank-disconnect` | Disable feed: stops importing in Looplet. It does not change anything in Redbark. |

Redbark's terms allow an account holder's own personal or business accounts only, not accessing or supplying data for
customers or other account holders (https://redbark.com/docs/help-center/business-and-customer-data). That is why the
feed is limited to the organisations in `REDBARK_ORGANIZATION_IDS`. Offering bank feeds to customer organisations needs
a different provider arrangement and legal review first.

## Go-live steps (owner)

1. **Secrets** on the Supabase project (values typed at a prompt, never committed):
   - `REDBARK_API_KEY`: a read-only Redbark API key.
   - `REDBARK_WEBHOOK_SECRET`: the signing secret Redbark shows when the webhook destination is saved.
   - `REDBARK_ORGANIZATION_IDS`: the owner's organisation id (comma-separated UUIDs if more than one).
2. **Migrations**, applied one file at a time, in order:
   1. `supabase/migrations/20261003140000_bank_provider_redbark.sql` (adds the enum label; a no-op where it exists)
   2. `supabase/migrations/20261003140100_redbark_bank_feed.sql`
3. **Deploy** the edge functions `bank-sync`, `bank-sync-all`, `bank-webhook` (it must keep `verify_jwt = false`, as
   in `supabase/config.toml`), `bank-disconnect`, `bank-feed-accounts` and `bank-feed-link`, then the web app.
4. **Delete** the retired functions from the live project: `bank-link-token`, `bank-exchange`, `bank-job-poll` and
   `bank-discover`.
5. **Redbark webhook destination:** URL
   `https://dxoikltymmknxqpkpyhi.supabase.co/functions/v1/bank-webhook`, for transaction events
   (`transactions.synced`). Save it, then put its signing secret in `REDBARK_WEBHOOK_SECRET` before the first
   delivery: a destination whose deliveries fail is disabled by Redbark after one failed batch.
6. **Check:** in Settings → Bank accounts, Show Redbark accounts, link one account with an import-from date, and
   confirm the queued first import brings in posted transactions. After Redbark's next sync, a `bank_events_raw` row
   with provider `redbark` shows the webhook was received.

## Behaviour worth knowing

- The webhook answers within Redbark's window and runs the sync afterwards. A failed sync is written to the
  connection's `last_error` (shown in Settings) and the next sync retries from the checkpoint.
- The first import of a long history may take several runs: each run reads up to three date windows per account.
- Linking an account again resets its checkpoint, so its history is re-read from the new import-from date. Nothing is
  imported twice.
- If statements for the same account were already imported by CSV or PDF, choose an import-from date after the last
  imported statement; the two sources use different transaction ids.
