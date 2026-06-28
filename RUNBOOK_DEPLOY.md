# RUNBOOK — Deploying the merged epics to live (`dxoikltymmknxqpkpyhi`)

All 10 PRs are merged to `main`. This is the **deploy** sequence to make them operational on the live DB. Do it in a monitored window — several steps change core behaviour on a real business's books.

## ⚠️ Do NOT run `supabase db push`

The repo migrations are **numbered** (`0001…0080`); the live migration history is **timestamped** (`20260…`). They don't align, so `db push` would try to replay the entire repo history against a DB that already has it. **Apply only the specific new migrations below**, individually (MCP `apply_migration` or `supabase migration up` one-by-one). **Do NOT apply #18's `0005–0038` backfills to live** — they reconstruct objects live already has (they exist only so a fresh `db reset` reproduces the schema).

## ✅ Already live

- EPIC B (OCR→GST): MiniMax-M3, PDF rasterize, GST derivation, `bills.gst_estimated`, `v_bas_gst_coverage` (allocation-based), `bills-extract` + `bills-extract-batch`. Migrations 0058/0059.
- EPIC E hardening: **0061** (FK indexes) + **0062** (audit triggers on invoice_payments / payment_runs / payment_run_items / bank_transactions) — applied + verified.
- 0057 (cron health monitor) — applied during EPIC A.

## 1. Secrets to set first (only you can)

- `SUPABASE_JWT_SECRET` — **required** for F's `api-gateway` (mints the org-scoped JWT). Without it the function throws on boot.
- `BANK_SYNC_ALL_CRON_SECRET` is already set live for `bank-sync-all` cron job 14. Only rotate it via `RUNBOOK_EPIC_A.md` if needed. The remaining cron
  secret blocker is the `accountant-session-digest` Vault `service_role_key`
  or a replacement scoped `?secret=` auth path.
- GitHub Actions secret `SUPABASE_SERVICE_ROLE_KEY` — else the now-real tenant-isolation CI gate (E) fails red on every PR.

## 2. Apply migrations (in this order; verify the ⚠ ones immediately after)

1. **E 0060** `definer_search_path_hardening` — ⚠ rewrites `get_accessible_org_ids()` (central RLS). Verify right after: as a normal org member, confirm you still see your bills/invoices (RLS not broken).
2. **G1 0071–0075** — additive GL schema (chart_of_accounts, journal_entries/lines, posting fn, trial balance, immutability). Inert until G2/G3.
3. **C3 0066/0067** — subscription auto-confirm audit columns + index. Additive.
4. **C2 0063** (v_bank_match_candidates), **0064** ⚠ (DROP+recreate `reconcile_match_bill`/`reconcile_match_invoice` — adds amount guard + `manually_matched`). Verify after: the Reconciliation page still matches; a manual match still works.
5. **D 0078** (bills.document_kind + is_probable_bill), **0079** (coverage view + is_probable_bill), **0080** ⚠ (rebuilds v_bas_quarterly with the filter — confirm BAS figures unchanged, since all rows default is_probable_bill=true).
6. **F 0068** (api_request_log + rate-limit RPC), **0069** ⚠ (extends `get_accessible_org_ids()` for the integration claim — supersedes 0060; verify RLS again). **Only after `SUPABASE_JWT_SECRET` is set.**

## 3. Deploy functions (`supabase functions deploy <name>`)

- After D migrations + a PostgREST schema reload (`NOTIFY pgrst, 'reload schema';`): redeploy **bills-extract** + **bills-extract-batch** (now set document_kind/is_probable_bill).
- **subscriptions-autoconfirm**, **auto-reconcile** (safe — only act when invoked/scheduled).
- After secrets: **api-gateway** + **ingest** (F); **bank-sync-all**, **notifications-cron**, **gmail-watch-renew** (#10).

## 4. Backfills / follow-ups

- **Re-OCR for document_kind:** existing 247 bills won't be classified until re-extracted. Run the `bills-extract-batch` repair loop (paid MiniMax calls) so non-invoices get `is_probable_bill=false` and drop out of the bills list + BAS. Until then the classifier only affects _new_ intake.
- **#18 shadow-reset validation:** run `supabase db reset` against a throwaway/shadow DB to confirm the reconstructed migrations rebuild the schema before trusting them.
- **EPIC B estimated GST:** review the bills flagged `gst_estimated` in `v_bas_gst_coverage` before lodging any BAS.

## 5. Known residual decisions

- F read-path scopes: any valid key gets full-org _read_ (writes are scope-checked). Documented in `docs/connector-guide.md`.
- F throttle keys on spoofable `x-forwarded-for` (LOW).
- The repo↔live migration-version misalignment (see top) should be reconciled (a baseline-repair) before normal `db push`-based workflows resume.
