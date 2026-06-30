# Looplet Accounting — Connector API Guide

Integrate any external system with Looplet Accounting without a human login. The
connector API has three surfaces:

- **Read** — query your org's data via Supabase PostgREST (`/rest/v1`).
- **Ingest** — push bills, bank transactions, and invoices in (`/functions/v1/ingest`).
- **POS receipts** — push structured merchant receipts in (`/functions/v1/receipt-webhook`).

Everything is **organization-scoped**: a key belongs to exactly one organization,
and Row-Level Security (RLS) enforces that **tenant** boundary on every read and
write — a key can never see or touch another organization's data. The raw
service-role key is never used by integrations.

> **Important — read scope is not granular.** Any valid key can **read your whole
> organization** over the Read API (PostgREST), regardless of its `scopes`. Read
> scopes (e.g. `read:financials`) are advisory today; they do **not** narrow what
> a key can read within its org. **Write** authority _is_ enforced per type
> (`write:bills` / `write:bank` / `write:invoices` / `write:receipts`) by the
> ingest and receipt endpoints. Treat
> issuing any key as granting full-org read, and grant write scopes minimally.

Base URL: `https://dxoikltymmknxqpkpyhi.supabase.co`

---

## 1. Get an API key

Keys are issued from inside an authenticated app/dashboard session (a member of
the owning org), via the `issue_api_key` RPC:

```sql
select * from issue_api_key(
  p_organization_id => '<your-org-uuid>',
  p_name            => 'Acme POS connector',
  p_scopes          => array['read:financials','write:bills','write:invoices','write:receipts'],
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

| Scope             | Allows                                                          |
| ----------------- | --------------------------------------------------------------- |
| `read:financials` | Advisory only — any key already has full-org read via PostgREST |
| `write:bills`     | `POST /ingest` with `type=bill`                                 |
| `write:bank`      | `POST /ingest` with `type=bank_transaction`                     |
| `write:invoices`  | `POST /ingest` with `type=invoice`                              |
| `write:receipts`  | `POST /receipt-webhook` for POS receipt ingestion               |
| `admin:keys`      | Implies all scopes                                              |

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
extra filtering required, and no way to read another tenant's data. Note this
restricts reads to _your org_, not to a subset of it: the token can read the
whole org regardless of the key's read scopes (see the note at the top).

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

Intake rules are applied automatically and must be accepted before the ingest
call returns success. The response includes the routing outcome:

```json
{
  "ok": true,
  "id": "<uuid>",
  "type": "bill",
  "deduped": false,
  "routing": { "outcome": "auto_attached", "match_score": 1.0 }
}
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
fed to the intake-rules engine automatically before success is returned. If
ingest returns `500` with `ingest_failed` after validation, retry the same
payload/idempotency key; the endpoint is designed to re-run the routing handoff
for deduped records.

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

### Document (`write:documents`)

Push a raw file for extraction (e.g. a scanned bill uploaded via a third-party
document management system). The file must already exist in the private `bills`
storage bucket under this organization prefix:

```text
org-<organization_id>/...
```

The ingest endpoint creates or reuses the canonical `bills` row, queues a
`bill_extract` job, and returns both the `bill_id` and `job_id`. The automation
worker OCRs the bill and moves it through the same routing path as manual uploads.

**`Idempotency-Key` header is required** (or `payload.idempotency_key`). On
replay with the same key the same `job_id` is returned with `deduped: true`.

```bash
curl -s -X POST \
  https://dxoikltymmknxqpkpyhi.supabase.co/functions/v1/ingest \
  -H "Authorization: Bearer llp_ab12cd34.0f1e2d3c..." \
  -H "Idempotency-Key: doc:supplier-portal:INV-99213.pdf" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "document",
    "payload": {
      "storage_key": "org-<organization_id>/supplier-portal/2026-06/INV-99213.pdf",
      "original_filename": "INV-99213.pdf",
      "mime_type": "application/pdf"
    }
  }'
```

```json
{ "ok": true, "bill_id": "<uuid>", "job_id": "<uuid>", "type": "document", "deduped": false }
```

Poll `automation_jobs` for the job status (or subscribe to a notification):

```sql
select id, status, last_error from automation_jobs
where id = '<job_id>';
```

### Payment (`write:payments`)

Record that a customer invoice has been paid. The payment is queued as a
`payment_record` job; the automation worker records an idempotent
`invoice_payments` row and the invoice triggers recompute the invoice balance.

Supplier bill payments are deliberately **not** accepted through generic payment
ingest. AP bills must be settled through bank reconciliation or payment runs so
Looplet keeps bank evidence, amount guards, and audit trails intact.

**`Idempotency-Key` header is required**. `invoice_id` is required.

```bash
curl -s -X POST \
  https://dxoikltymmknxqpkpyhi.supabase.co/functions/v1/ingest \
  -H "Authorization: Bearer llp_ab12cd34.0f1e2d3c..." \
  -H "Idempotency-Key: pay:bank-transfer:BSB-20260601-001" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "payment",
    "payload": {
      "invoice_id": "<uuid>",
      "amount_cents": 14300,
      "payment_date": "2026-06-01",
      "payment_method": "bank_transfer",
      "reference": "BSB-20260601-001"
    }
  }'
```

```json
{ "ok": true, "job_id": "<uuid>", "type": "payment", "deduped": false }
```

---

## 4. POS Receipt Webhook

The POS receipt path is rewards-style eReceipt capture: the customer presents a
Looplet QR/barcode/NFC/pass identity before payment, the POS attaches it to the
basket, and the POS or bridge sends the itemised receipt after the EFTPOS tender
is accepted. EFTPOS can provide payment metadata, but the POS is the receipt
source of truth.

Full implementation guidance, business-side install options, and the bridge
pattern are in [POS Receipt Webhook Design](./pos-receipt-webhook.md).

Endpoint:

```
POST /functions/v1/receipt-webhook
Authorization: Bearer llp_ab12cd34.0f1e2d3c...
Idempotency-Key: <stable POS payment or receipt event id>
Content-Type: application/json
```

Body:

```json
{
  "identity_token": "rhp_1234abcd.<secret>",
  "idempotency_key": "pos-payment-evt-88123",
  "event_type": "sale",
  "source_channel": "pos",
  "payload": {
    "merchant": { "name": "Bunnings Trade", "abn": "12123456789" },
    "receipt": {
      "number": "POS-2026-0001",
      "event_type": "sale",
      "purchase_at": "2026-06-28T03:00:00Z",
      "currency": "AUD",
      "subtotal_ex_gst_cents": 32727,
      "gst_cents": 3273,
      "total_inc_gst_cents": 36000,
      "tender_status": "completed",
      "payment_reference": "eftpos-auth-777331",
      "terminal_id": "TERM-04",
      "store_id": "STORE-017"
    },
    "line_items": [
      {
        "description": "Timber",
        "quantity": 2,
        "unit_price_cents": 15000,
        "total_inc_gst_cents": 30000,
        "gst_cents": 2727
      },
      {
        "description": "Fasteners",
        "quantity": 1,
        "unit_price_cents": 6000,
        "total_inc_gst_cents": 6000,
        "gst_cents": 546
      }
    ]
  },
  "sync_targets": ["xero", "myob", "quickbooks", "generic_api"]
}
```

Reliability rules enforced by the endpoint:

- `write:receipts` scope is required.
- `identity_token` must match an active receipt identity for the key's
  organization. In production it should come from the customer's scanned
  Looplet pass/tag on that checkout, not from one hardcoded bridge token.
- `event_type` must be `sale`, `refund`, or `void`; only `sale` events create bills.
- POS payloads must include `payload.merchant.name`.
- `tender_status` must describe a final tender state, not pending authorisation.
- POS payloads must include `payload.receipt.payment_reference` so Looplet can
  trace the receipt back to the EFTPOS/POS tender event.
- POS payloads must include `payload.receipt.purchase_at` as the original
  POS/EFTPOS completed tender timestamp. Do not substitute bridge send time.
- Do not send full card numbers. If `payload.receipt.payment_last4` is supplied,
  it must contain only the final four digits or a masked value with exactly four
  digits.
- A stable retry key is required: `Idempotency-Key`, body `idempotency_key`,
  POS external event id, or merchant + receipt number.
- When `Idempotency-Key` and body `idempotency_key` are both supplied, they
  must match.
- Safe duplicate retries must keep the same receipt number, purchase timestamp,
  total, GST/subtotal split, payment reference, terminal, store, and merchant
  facts.
- POS payloads must include both GST and subtotal, and supplied subtotal + GST
  must reconcile to the receipt total.
- Line item totals must equal the receipt total within one cent, and line-item
  GST must equal the receipt GST within one cent.
- Payloads over 128 KB or more than 100 line items are rejected.
- Safe retries return the same `receipt_event_id` with `"duplicate": true`.
- Refund/void events are stored as auditable receipt events and do not create
  positive bills.

If the POS cannot send webhooks or custom headers, install a small bridge,
plugin, Zapier/Make scenario, or integration service between the POS and
Looplet. A dependency-free reference bridge is in
[`examples/pos-bridge`](../examples/pos-bridge).

---

## 5. Rate limits & logging

- Each key has a **fixed-window per-minute limit** (`rate_limit_per_min`, default
  120). Over the ceiling returns `429 {"error":"rate_limited"}`.
- Every external call (gateway + ingest + receipt-webhook) is written to `api_request_log`
  (org, key prefix, endpoint, status, timestamp). Members of the owning org can
  read their own call log.

---

## 6. Errors

| Status | `error`                    | Meaning                                                         |
| ------ | -------------------------- | --------------------------------------------------------------- |
| 400    | `invalid_json`             | Body was not valid JSON                                         |
| 400    | `unsupported_type`         | `type` not in bill/bank_transaction/invoice, or missing payload |
| 400    | receipt validation message | Receipt payload/identity/idempotency/totals failed validation   |
| 401    | `invalid_api_key`          | Missing, malformed, expired, or revoked key                     |
| 403    | `insufficient_scope`       | Key lacks the scope for that ingest type                        |
| 429    | `rate_limited`             | Per-key window exceeded                                         |

Authentication failures never reveal which check failed.
