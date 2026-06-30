# Looplet Connector Bridge — Generic Template

A minimal Node.js (ESM) template for building a connector between any external
system and the Looplet Accounting API. Use this as the starting point when your
source system can't hit Looplet directly (wrong network, no HTTPS, batch-only
export, etc.).

For POS-specific wiring see [`../pos-bridge`](../pos-bridge/README.md).  
For the full API reference see [`../../docs/connector-guide.md`](../../docs/connector-guide.md).

---

## What this bridge does

```
External system ──→ bridge.mjs ──→ POST /functions/v1/ingest
                                         type: bill | bank_transaction |
                                               invoice | document | payment
```

The bridge:
1. Reads records from the external source (CSV, REST API, file-watch, etc.)
2. Maps them to the Looplet ingest payload shape
3. POSTs to `/ingest` with the API key and an `Idempotency-Key`
4. Handles retries and logs results

---

## Quick start

```bash
cp .env.example .env
# fill in LOOPLET_API_KEY and LOOPLET_ORG_ID
node bridge.mjs
```

---

## .env.example

```
LOOPLET_INGEST_URL=https://dxoikltymmknxqpkpyhi.supabase.co/functions/v1/ingest
LOOPLET_API_KEY=llp_<prefix>.<secret>
LOOPLET_ORG_ID=<your-org-uuid>
```

---

## bridge.mjs (template)

```js
#!/usr/bin/env node
// connector-bridge/bridge.mjs — generic Looplet ingest bridge template.
// Copy and adapt: replace readRecords() with your source-system logic.

const URL   = process.env.LOOPLET_INGEST_URL;
const KEY   = process.env.LOOPLET_API_KEY;

if (!URL || !KEY) {
  console.error('Set LOOPLET_INGEST_URL and LOOPLET_API_KEY');
  process.exit(1);
}

// Replace this with your real source — CSV, DB query, API call, etc.
async function readRecords() {
  return [
    {
      type: 'bill',
      idempotencyKey: 'my-system:invoice:INV-99213',
      payload: {
        supplier_name_raw: 'Acme Supplies',
        invoice_number: 'INV-99213',
        invoice_date: '2026-06-01',
        total_inc_gst_cents: 14300,
        gst_cents: 1300,
        job_reference_raw: 'JOB-1042',
      },
    },
  ];
}

async function push(record) {
  const res = await fetch(URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      // Idempotency-Key prevents double-posts on retry. Required for
      // document and payment types; strongly recommended for all others.
      'Idempotency-Key': record.idempotencyKey,
    },
    body: JSON.stringify({ type: record.type, payload: record.payload }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

(async () => {
  const records = await readRecords();
  let ok = 0, fail = 0;
  for (const r of records) {
    try {
      const result = await push(r);
      console.log(`✓ ${r.type} ${r.idempotencyKey} → id=${result.id ?? result.job_id} deduped=${result.deduped}`);
      ok++;
    } catch (err) {
      console.error(`✗ ${r.type} ${r.idempotencyKey}: ${err.message}`);
      fail++;
    }
  }
  console.log(`\n${ok} ok, ${fail} failed`);
  if (fail > 0) process.exit(1);
})();
```

---

## Idempotency pattern

Every record push includes an `Idempotency-Key` header. A stable, source-scoped
key (e.g. `my-system:invoice:INV-99213`) means:

- Re-running the bridge after a partial failure never creates duplicates
- `"deduped": true` in the response means the record already exists — not an error
- Document and payment types **require** an idempotency key; bill/bank/invoice
  use content-hash dedup as a fallback if the header is omitted

Recommended key format: `<system>:<type>:<stable-source-id>`

---

## Supported types

| `type`             | Scope needed       | Idempotency basis                  |
|--------------------|--------------------|------------------------------------|
| `bill`             | `write:bills`      | content hash + (org, supplier, invoice_number) |
| `bank_transaction` | `write:bank`       | (bank_account_id, external_id)     |
| `invoice`          | `write:invoices`   | (org, invoice_number)              |
| `document`         | `write:documents`  | Idempotency-Key **required**       |
| `payment`          | `write:payments`   | Idempotency-Key **required**       |

---

## Error handling

| Status | `error`              | Action                              |
|--------|----------------------|-------------------------------------|
| 200    | —                    | OK (deduped re-push)                |
| 201/202| —                    | OK (created / queued)               |
| 400    | validation message   | Fix payload; do not retry as-is     |
| 401    | `invalid_api_key`    | Check key; rotate if compromised    |
| 403    | `insufficient_scope` | Issue a new key with the right scope|
| 429    | `rate_limited`       | Back off and retry after 60 s       |
| 5xx    | any                  | Retry with exponential backoff      |

For full API docs and payload schemas see
[`../../docs/connector-guide.md`](../../docs/connector-guide.md) and
[`../../docs/openapi.yaml`](../../docs/openapi.yaml).
