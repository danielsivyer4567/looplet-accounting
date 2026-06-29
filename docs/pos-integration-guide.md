# Looplet Receipt Hub — POS Integration Guide

**Audience:** the merchant's POS vendor or developer.
**Purpose:** send itemised sale/refund/void receipts into Looplet so they become
classified, GST-coded bills automatically.

There is **nothing to install from Looplet** and **no Looplet dependency** to add.
A POS integrates by making one authenticated HTTPS `POST` per completed receipt.

---

## Part A — For the Looplet operator: what to give each business

Before a merchant can send anything, generate their credentials in Looplet:

1. Open **Receipt Hub → POS bridge setup → Generate config** for that organisation.
   This issues, **once**:
   - a **POS API key** (`llp_…`) scoped to `write:receipts`
   - a **fallback receipt identity token** (`rhp_…`)
   - the **webhook URL** for your project
2. Hand the business the generated `.env` block (or just the three values). The API
   key secret is shown **once** — they must store it securely.
3. Give them this guide.

That's the whole packet: **webhook URL + API key + (optionally) a fallback identity
token + this document.**

> Production webhook URL (current project):
> `https://dxoikltymmknxqpkpyhi.supabase.co/functions/v1/receipt-webhook`
> Always use the URL shown in the business's own setup panel — it is authoritative.

---

## Part B — Merchant / POS vendor integration

### 1. What your side needs

| Requirement | Detail |
|---|---|
| **Outbound HTTPS** | Your POS (or a small connector) must be able to `POST` to the Looplet webhook URL over HTTPS. No inbound ports, no static IP. |
| **The API key** | The `llp_…` key Looplet issued, stored **outside source code** (env var / secret store). |
| **Mapping code** | A small transform from your POS's sale event → the Looplet JSON below. This is the only real work. |
| **Identity capture** | The customer's scanned Looplet identity token (`rhp_…`) at tender. A fallback token is provided for setup/testing. |

### 2. How it works (the flow)

```
Customer pays  ──►  Cashier scans the customer's Looplet pass (rhp_…)
                         │
POS finalises sale  ────►  POST receipt JSON ──► Looplet receipt-webhook
                                                      │
                                  creates: receipt event + bill + GST split
                                           + audit package + accounting sync jobs
```

### 3. Integration options (pick one)

1. **Native POS webhook / plugin** — if your POS can fire an outbound webhook on
   "sale completed", point it at a tiny transform that reshapes your payload into
   Looplet's and forwards it.
2. **Looplet local bridge** — for POS systems that can't call out directly, run the
   Looplet connector on the back-office machine; it reads the POS export and forwards.
3. **Direct API call** — for custom/in-house POS, call the endpoint directly from your
   sale-completion code.

All three send the **same request** described below.

---

### 4. The request

**Endpoint** (POST):
```
https://<your-project>.supabase.co/functions/v1/receipt-webhook
```

**Headers**
```
Authorization: Bearer llp_xxxxxxxxxxxxxxxxxxxx     # your POS API key (write:receipts)
Content-Type: application/json
Idempotency-Key: <stable per-receipt id>           # see §6
```

**Body** (a completed **sale**):
```json
{
  "identity_token": "rhp_xxxxxxxx.xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "idempotency_key": "POS-TXN-100482",
  "event_type": "sale",
  "source_channel": "pos",
  "sync_targets": ["xero"],
  "payload": {
    "merchant": {
      "name": "Coomera Trade Supplies",
      "abn": "26 008 672 179",
      "external_id": "store-qld-01"
    },
    "receipt": {
      "number": "INV-100482",
      "event_type": "sale",
      "purchase_at": "2026-06-29T03:14:05Z",
      "currency": "AUD",
      "subtotal_ex_gst_cents": 3273,
      "gst_cents": 327,
      "total_inc_gst_cents": 3600,
      "tender_status": "completed",
      "payment_method": "card",
      "payment_last4": "4242",
      "payment_reference": "auth-7741920",
      "terminal_id": "TERM-01",
      "store_id": "STORE-QLD"
    },
    "classification": {
      "business_use": "business",
      "category": "materials"
    },
    "line_items": [
      {
        "description": "Treated pine framing pack",
        "quantity": 1,
        "unit_price_cents": 3273,
        "total_inc_gst_cents": 3600,
        "gst_cents": 327,
        "category": "materials"
      }
    ]
  }
}
```

### 5. Required fields for a POS sale

The webhook is **strict** for `source_channel: "pos"` — this is deliberate, so the
books are accurate. A request missing any of these is rejected with `400` and a clear
message (it does **not** create a partial receipt).

| Field | Rule |
|---|---|
| `identity_token` | The scanned customer pass (`rhp_…`). Use the fallback token until in-store scanning is live. |
| `payload.merchant.name` | ≥ 2 characters. |
| `payload.receipt.purchase_at` | ISO‑8601 timestamp of the sale. |
| `payload.receipt.total_inc_gst_cents` | Whole cents, **> 0** (sale/refund). |
| `payload.receipt.gst_cents` **and** `payload.receipt.subtotal_ex_gst_cents` | **Both required.** Must reconcile: `subtotal + gst = total` (±1c). |
| `payload.receipt.tender_status` | A **final** status — sale: `completed`/`paid`/`succeeded`/`approved`. |
| `payload.receipt.payment_reference` | The acquirer/auth reference for the tender. |
| `payload.line_items` | **At least one** line. Each needs `gst_cents`, and a total (`total_inc_gst_cents`, or `quantity` × `unit_price_cents`). Line totals must sum to the receipt total (±1c) and line GST must sum to the receipt GST (±1c). Max **100** lines. |

All monetary values are **integer cents** (e.g. `$36.00` → `3600`). GST is Australian
standard rate where applicable; send the real figures from the receipt — don't estimate.

### 6. Idempotency (retry safety)

Networks fail; POS systems retry. Send a **stable** `Idempotency-Key` derived from the
POS transaction id so a retry never creates a duplicate receipt.

- Put it in the `Idempotency-Key` header **and/or** the body `idempotency_key`. If you
  send both, they must be **identical**.
- Max length **160** characters.
- A retry with the same key returns the **same** receipt — safe to fire repeatedly.
- If you can't supply one, Looplet derives a key from `merchant.name + receipt.number`,
  so always send a unique `receipt.number` at minimum.

### 7. Refunds and voids

Send `event_type: "refund"` or `"void"`, and **reference the original sale**:

- Set `payload.receipt.original_receipt_number` (or `original_external_event_id`).
- The original sale **must already exist** in Looplet (send the sale first).
- Use a final refund/void `tender_status` (refund: `refunded`/`completed`/…; void:
  `voided`/`cancelled`/…).

```json
{
  "event_type": "refund",
  "source_channel": "pos",
  "identity_token": "rhp_…",
  "idempotency_key": "POS-TXN-100482-RF",
  "payload": {
    "merchant": { "name": "Coomera Trade Supplies" },
    "receipt": {
      "number": "INV-100482-RF",
      "event_type": "refund",
      "original_receipt_number": "INV-100482",
      "purchase_at": "2026-06-30T01:00:00Z",
      "currency": "AUD",
      "subtotal_ex_gst_cents": 3273,
      "gst_cents": 327,
      "total_inc_gst_cents": 3600,
      "tender_status": "refunded",
      "payment_reference": "refund-7741988"
    },
    "line_items": [
      { "description": "Treated pine framing pack", "quantity": 1,
        "total_inc_gst_cents": 3600, "gst_cents": 327 }
    ]
  }
}
```

### 8. Limits

| Limit | Value |
|---|---|
| Payload size | ≤ 128 KB |
| Line items | ≤ 100 |
| Line quantity | ≤ 999,999,999.999 (max 3 decimals) |
| Idempotency key | ≤ 160 chars |
| Rate limit | Per API key (default ~120 requests/min; ask Looplet if you need more) |

### 9. Responses

**Success** `200`:
```json
{ "ok": true, "receipt_event_id": "…", "bill_id": "…", "sync_jobs": [ … ] }
```

**Failure** — the `error` string tells you exactly what to fix:

| Status | Meaning |
|---|---|
| `400` | Validation failed (missing/invalid field). The receipt was **not** stored. |
| `401` | Missing/invalid API key. |
| `403` | API key lacks the `write:receipts` scope. |
| `429` | Rate limited — back off and retry. |
| `5xx` | Transient server error — retry with the **same** idempotency key. |

Treat `400`/`403` as **do not retry without changes**; treat `429`/`5xx` as
**retry-safe** (idempotency protects you).

### 10. Security

- The API key is a **secret** — store it in a secret manager / protected env file,
  never in source control or client-side code. Rotate via Looplet if exposed.
- Send only over **HTTPS**.
- The key is scoped to one organisation and to `write:receipts` only — it cannot read
  data or act on other tenants.

---

## Part C — Testing & go-live

Looplet ships a reference mock POS that exercises this exact contract:
`scripts/mock-pos.mjs`. A merchant's developer can copy it as a starting point.

1. **Dry run against the real endpoint** with the issued key + fallback identity token:
   ```bash
   node scripts/mock-pos.mjs --env bridge.env            # one sale
   node scripts/mock-pos.mjs --env bridge.env --replay   # proves idempotency
   node scripts/mock-pos.mjs --env bridge.env --refund   # sale + linked refund
   ```
   A `200` with a real `receipt_event_id` means the front door works end-to-end.
2. **Confirm in Looplet** that the receipt appears in Receipt Hub with the right
   merchant, total, GST split, and line items.
3. **Switch from the fallback identity token to real in-store scanning** before going
   live, so each receipt carries the actual customer's pass.

### Go-live checklist (per business)

- [ ] API key issued and stored securely (not in source)
- [ ] Webhook URL reachable from the POS / bridge machine over HTTPS
- [ ] Sale payload maps all required fields; GST + subtotal reconcile to total
- [ ] Stable `Idempotency-Key` derived from the POS transaction id
- [ ] Refund/void payloads reference the original sale
- [ ] Customer identity token captured per receipt (not just the fallback)
- [ ] A real test sale appears correctly in Receipt Hub
