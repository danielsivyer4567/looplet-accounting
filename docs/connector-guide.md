# Looplet Accounting — Connector API Guide

Integrate any external system with Looplet Accounting without a human login. The
connector API has two surfaces:

- **Read** — query your org's data via Supabase PostgREST (`/rest/v1`).
- **Ingest** — push bills, bank transactions, and invoices in (`/functions/v1/ingest`).

Everything is **organization-scoped**: a key belongs to exactly one organization,
and Row-Level Security (RLS) enforces that boundary on every read and write. The
raw service-role key is never used by integrations.

Base URL: `https://dxoikltymmknxqpkpyhi.supabase.co`

---

## 1. Get an API key

Keys are issued from inside an authenticated app/dashboard session (a member of
the owning org), via the `issue_api_key` RPC:

```sql
select * from issue_api_key(
  p_organization_id => '<your-org-uuid>',
  p_name            => 'Acme POS connector',
  p_scopes          => array['read:financials','write:bills','write:invoices'],
  p_expires_at      => null,           -- or a timestamptz
  p_rate_limit_per_min => 120
);
```

The response returns the **full secret exactly once**:

```
 api_key                         | key_prefix    | id
---------------------------------+---------------+------
 llp_ab12cd34.0f1e2d3c...<32hex> | llp_ab12cd34  | <uuid>
```

Store `api_key` securely — only its SHA-256 hash is persisted; it cannot be
recovered. Present it later as:

```
Authorization: Bearer llp_ab12cd34.0f1e2d3c...
```

**Scopes** (grant the minimum needed):

| Scope             | Allows                                  |
|-------------------|-----------------------------------------|
| `read:financials` | Read API (PostgREST), reporting views   |
| `write:bills`     | `POST /ingest` with `type=bill`         |
| `write:bank`      | `POST /ingest` with `type=bank_transaction` |
| `write:invoices`  | `POST /ingest` with `type=invoice`      |
| `admin:keys`      | Implies all scopes                      |

**Revoke** a key (soft, audit-preserving):

```sql
select revoke_api_key('<api_key_id>');
```

---

## 2. Read API

Reads go through Supabase PostgREST, which expects a Supabase JWT. Exchange your
API key for a short-lived (15-minute) org-scoped JWT first.

### Step 1 — exchange key for JWT

```bash
curl -s -X POST \
  https://dxoikltymmknxqpkpyhi.supabase.co/functions/v1/api-gateway \
  -H "Authorization: Bearer llp_ab12cd34.0f1e2d3c..."
```

```json
{
  "access_token": "<jwt>",
  "token_type": "Bearer",
  "expires_in": 900,
  "organization_id": "<your-org-uuid>"
}
```

The JWT carries `role=authenticated` and an `organization_id` claim. The
`get_accessible_org_ids()` RLS helper honours that claim, so every existing
org-scoped policy automatically restricts your reads to your organization — no
extra filtering required, and no way to read another tenant's data.

### Step 2 — query PostgREST

Send the JWT as the bearer token AND the project **anon** key as `apikey`:

```bash
curl -s \
  "https://dxoikltymmknxqpkpyhi.supabase.co/rest/v1/invoices?select=id,invoice_number,total_inc_gst_cents,status&order=issue_date.desc&limit=50" \
  -H "Authorization: Bearer <jwt>" \
  -H "apikey: <project-anon-key>"
```

Anything RLS exposes to your org is readable: `bills`, `invoices`,
`bank_transactions`, `jobs`, `customers`, `suppliers`, plus reporting views like
`v_customer_pnl`. Use the full
[PostgREST query grammar](https://postgrest.org/en/stable/references/api/tables_views.html)
(`select`, filters, `order`, `limit`, embedded resources).

Re-exchange for a fresh JWT when it expires (every 15 min).

---

## 3. Ingest API

Push records straight in. Authenticate with the **API key itself** (no JWT
exchange needed):

```
POST /functions/v1/ingest
Authorization: Bearer llp_ab12cd34.0f1e2d3c...
Content-Type: application/json

{ "type": "<bill|bank_transaction|invoice>", "payload": { ... } }
```

`organization_id` is always pinned to the key — any value in the body is ignored.

### Bill (`write:bills`)

```json
{
  "type": "bill",
  "payload": {
    "supplier_name_raw": "Bunnings Trade",
    "invoice_number": "INV-99213",
    "invoice_date": "2026-06-01",
    "total_inc_gst_cents": 14300,
    "gst_cents": 1300,
    "job_reference_raw": "JOB-1042"
  }
}
```

The bill runs through the **same router** the Gmail/upload path uses:

- exact job match + decent confidence → **auto-attached** (and pushed to Xero),
- fuzzy match → **suggested** in the Allocation Portal,
- no match → **queued** for manual allocation.

Intake rules are applied automatically. The response includes the routing
outcome:

```json
{ "ok": true, "id": "<uuid>", "type": "bill", "deduped": false,
  "routing": { "outcome": "auto_attached", "match_score": 1.0 } }
```

Dedup: a byte-identical re-push (same org + same payload), or a collision on
`(organization_id, supplier_id, invoice_number)`, returns `"deduped": true`.

### Bank transaction (`write:bank`)

```json
{
  "type": "bank_transaction",
  "payload": {
    "bank_account_id": "<uuid>",
    "external_id": "txn_88123",
    "posted_at": "2026-06-02T03:00:00Z",
    "description": "EFTPOS BUNNINGS",
    "amount_cents": -14300
  }
}
```

`bank_account_id` must belong to your org. Idempotent on
`(bank_account_id, external_id)` — same as the Basiq sync. New transactions are
fed to the intake-rules engine automatically.

### Invoice (`write:invoices`)

```json
{
  "type": "invoice",
  "payload": {
    "invoice_number": "2026-0007",
    "customer_id": "<uuid>",
    "due_date": "2026-07-01",
    "total_inc_gst_cents": 220000
  }
}
```

`customer_id` must belong to your org. Dedup on
`(organization_id, invoice_number)`.

---

## 4. Rate limits & logging

- Each key has a **fixed-window per-minute limit** (`rate_limit_per_min`, default
  120). Over the ceiling returns `429 {"error":"rate_limited"}`.
- Every external call (gateway + ingest) is written to `api_request_log`
  (org, key prefix, endpoint, status, timestamp). Members of the owning org can
  read their own call log.

---

## 5. Errors

| Status | `error`              | Meaning                                  |
|--------|----------------------|------------------------------------------|
| 400    | `invalid_json`       | Body was not valid JSON                  |
| 400    | `unsupported_type`   | `type` not in bill/bank_transaction/invoice, or missing payload |
| 401    | `invalid_api_key`    | Missing, malformed, expired, or revoked key |
| 403    | `insufficient_scope` | Key lacks the scope for that ingest type |
| 429    | `rate_limited`       | Per-key window exceeded                  |

Authentication failures never reveal which check failed.
