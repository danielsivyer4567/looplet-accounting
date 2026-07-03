# Handover: Claude Chrome — connect Xero + bank feed (Basiq)

**Why:** the finish-line wiring plan (`docs/WIRING_ACTIVATION_PLAN.md`) has
everything else live except two connections that require a human/browser
OAuth consent click — something a CLI/API session cannot do. This doc gives
a browser-driving agent everything it needs to complete both.

**Prod app:** `https://looplet-accounting.pages.dev`
**Login:** affordablefencinggc@gmail.com (owner account — use the normal
login form; this agent should already have/be given the password out of
band, do not guess or brute force it)

## Task 1 — Connect Xero

1. Log in at `https://looplet-accounting.pages.dev`.
2. Navigate to **Settings** (left nav) → find the **Xero** card
   (`src/components/settings/XeroConnect.tsx` renders it under
   Integrations).
3. Click **Connect Xero**. This calls the `xero-oauth-start` edge function
   and redirects to Xero's real login/consent screen
   (`https://login.xero.com/identity/connect/authorize`).
4. Log into Xero with the org's real Xero credentials and approve the
   requested scopes (invoices, contacts, settings — read/write).
5. Xero redirects back to `xero-oauth-callback`, which the app then bounces
   to `/settings#xero-connected`. You should see a green "Xero connected
   successfully" message and a live tenant name/status card.
6. **If you don't know the Xero login credentials**, stop here and ask the
   user — do not attempt to create a new Xero account or guess credentials.

## Task 2 — Connect the bank feed via Basiq (first-time connect, not a repair)

**Corrected 2026-07-02:** the one existing row in `bank_connections` is
`provider: 'manual'`, `metadata: {source: 'csv_import'}` — a historical CSV
import, not a real Basiq connection. `BASIQ_API_KEY`/`BASIQ_BASE_URL`/
`BASIQ_WEBHOOK_VERIFY_TOKEN` are already set as secrets, so the backend is
ready; nobody has ever completed the Basiq consent flow for this org. This
is a first connection, not a reconnect.

1. Still in **Settings**, find the **Bank Connection** card
   (`src/components/settings/BankConnect.tsx`).
2. Click **+ Connect bank account (Basiq)**.
3. It will prompt for an **Australian mobile number** (Basiq requires this
   to start the Connect flow) — use the org's real business mobile number.
4. This opens Basiq's hosted Connect UI. Select the bank (CommBank, NAB,
   Westpac, ANZ, or another supported institution), log in with the org's
   real online banking credentials, and approve the requested account
   access.
5. On success a new row should appear in `bank_connections` with
   `provider: 'basiq'` and a real `institution_id`/`external_item_id` — the
   old `provider: 'manual'` CSV-import row stays as historical data and can
   be left alone.
6. **If you don't know the banking credentials**, stop here and ask the
   user — same rule as Xero, do not guess or attempt recovery flows.

## How to verify success (needs DB access, not just the UI)

Run these against project `dxoikltymmknxqpkpyhi` (Supabase CLI:
`supabase db query --linked "<sql>"` from the repo root, or Supabase MCP if
connected):

```sql
-- Xero: should return 1+ row with is_enabled=true after Task 1
select organization_id, xero_tenant_name, is_enabled, status, last_synced_at
from xero_integrations;

-- Bank feed: expect a NEW row with provider='basiq' (the existing row is
-- provider='manual', a CSV-import artifact — leave it, don't count it as success)
select organization_id, provider, institution_id, status, last_synced_at, updated_at
from bank_connections
order by updated_at desc;
```

Report back: whether each task succeeded, the tenant name Xero connected to,
and the new `last_synced_at` for the bank feed. If either OAuth flow errors
out, capture the exact error text/screenshot — both edge functions
(`xero-oauth-start`, `xero-oauth-callback`) were freshly redeployed
2026-07-02 and this would be the first live run since, so a first-time
failure here is meaningful signal, not noise.

## Guardrails

- Do not touch anything else in Settings — no other toggles, no deleting
  existing integrations, no changing org details.
- Do not accept/override any rows in the Coding Review queue — that's
  reserved for a human making real accounting judgments on real bills, out
  of scope for this handover.
- If a step asks for a password/credential you were not given, stop and
  ask — do not attempt password reset, guess common passwords, or search
  for credentials elsewhere.
