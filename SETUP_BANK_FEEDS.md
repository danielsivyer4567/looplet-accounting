# Bank Feeds Setup — Plaid (US-fallback) + Basiq (AU-primary)

The bank-feed plumbing is in place (migration `0025_bank_connections_and_transactions`).
This doc covers the choice between **Basiq** (Australian-bank specialist) and **Plaid**
(global, with AU production support), and the GCP-style runbook for setting either up.

## TL;DR — pick a provider

| | Basiq | Plaid |
|---|---|---|
| AU bank coverage | All major + 100s of credit unions | CommBank, NAB, Westpac, ANZ (4 majors only in production) |
| Sandbox | Real AU sandbox banks | US banks only — AU testing requires production |
| Pricing | Free tier (50 connections) → A$0.50/conn/mo | $0.30 USD/conn/mo (production), free dev |
| BSB / account-num format | Native AU | Returns AU format correctly but US-shaped API |
| Initial setup time | ~30 min | ~30 min |
| Status of Looplet integration | Ready to scaffold (Phase 2) | Code patterns extracted from old build |

**Recommendation for AFGC:** start with **Basiq** in dev mode. CommBank, ANZ, Westpac,
NAB all available immediately, real sandbox flow works, no waiting for Plaid AU
production approval (which can take weeks).

---

## Option A — Basiq (recommended for AU)

### 1. Sign up

Console: https://dashboard.basiq.io/signup

Verify email, get API key from the **Applications** tab.

### 2. Set Supabase secrets

```powershell
npx supabase secrets set --project-ref dxoikltymmknxqpkpyhi `
  BASIQ_API_KEY=YOUR_KEY `
  BASIQ_BASE_URL=https://au-api.basiq.io
```

### 3. Edge functions to deploy (scaffolds in `supabase/functions/bank-*`)

(Not yet implemented in this repo — the scaffolds will be:)

- `bank-link-token` — creates a Basiq user + auth_link, returns the Connect-UI URL
- `bank-exchange` — receives the connection_id from Basiq's Connect UI, persists `bank_connections` row, kicks initial sync
- `bank-sync` — calls `GET /users/{id}/connections/{id}/transactions` with cursor, upserts `bank_transactions`
- `bank-webhook` — handles Basiq webhooks: `transactions.updated` / `connection.updated` / `connection.expired`

### 4. Test in browser

(After scaffolds land:)
1. Open `/settings` → "Connect Bank Account"
2. Pick CommBank / NAB / etc. from Basiq's Connect UI
3. Authenticate with real online-banking credentials (sandbox uses test credentials in dev mode)
4. Watch transactions sync into `bank_transactions`

---

## Option B — Plaid (US fallback, future global)

### 1. Sign up

https://dashboard.plaid.com/signup

Get **Client ID** + **Sandbox Secret** from Team Settings → Keys.

### 2. Set Supabase secrets

```powershell
npx supabase secrets set --project-ref dxoikltymmknxqpkpyhi `
  PLAID_CLIENT_ID=YOUR_ID `
  PLAID_SECRET=YOUR_SECRET `
  PLAID_ENV=sandbox `
  PLAID_COUNTRY_CODES=US,AU
```

### 3. Edge functions (Deno port from old `backend/src/services/banking/plaidService.ts`)

The old TypeScript implementation works as a near-line-by-line port:

- `plaidService.createLinkToken(userId)` → edge fn `plaid-link-token`
- `plaidService.exchangePublicToken(token, orgId, instId, instName)` → edge fn `plaid-exchange-token`
- `plaidService.syncAccounts(connectionId)` + `syncTransactions(connectionId)` → edge fn `plaid-sync`
- `plaidWebhookService` → edge fn `plaid-webhook` (no-verify-jwt)

### 4. AU sandbox limitation

Plaid's sandbox ONLY has US test banks. To test against CommBank/NAB/Westpac/ANZ you
need to:
1. Apply for **production access** at Plaid Dashboard (1-2 week approval)
2. Or use **development environment** (free, but rate-limited) with real credentials

### 5. Test in browser (sandbox)

Same flow — pick "First Platypus Bank", username `user_good`, password `pass_good`.

---

## Common — encryption + cron

Both providers use:
- Same `ENCRYPTION_KEY` env (already set; shared with Xero/Gmail tokens)
- Same `_shared/xero/crypto.ts` AES-256-GCM helpers (rename to `_shared/crypto.ts` once we stop calling it Xero-specific)
- Same daily `pg_cron` pattern as `gmail-watch-renew` for periodic sync

```sql
-- Once edge functions are deployed:
SELECT cron.schedule(
  'bank-sync-all',
  '0 */6 * * *',  -- every 6 hours
  $$ SELECT net.http_post(
       url := 'https://dxoikltymmknxqpkpyhi.supabase.co/functions/v1/bank-sync',
       headers := jsonb_build_object('Content-Type','application/json')
     ); $$
);
```

---

## Reconciliation: matching bank txns → bills/invoices

Once `bank_transactions` are flowing in, the matcher logic (next phase) does:

1. **Exact amount + date** match → high-confidence auto-match
2. **Amount + supplier name fuzzy match** → suggested match
3. **Amount + recurring pattern** → flag as subscription candidate
4. **Unmatched after 30 days** → flag for user review

Schema is already in place via `bank_transactions.matched_bill_id`,
`matched_invoice_id`, `match_confidence`, `manually_matched`.

---

## Production checklist

Before going live:
- [ ] Apply for Plaid production OR Basiq paid tier
- [ ] Generate fresh `BANKING_ENCRYPTION_KEY` for production
- [ ] Configure webhook signature verification
- [ ] Set up monitoring (sync failures, expired connections)
- [ ] Document rollout plan for AFGC + future customers
- [ ] Test with real CommBank Business account (AFGC's primary)

---

**Schema reference:** [supabase migrations](supabase/migrations/0025_bank_connections_and_transactions.sql)
**Memory:** see `reference_old_looplet_platform_extraction.md` for what was learned from the prior implementation
