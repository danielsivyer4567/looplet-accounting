#!/usr/bin/env node
/**
 * mock-pos.mjs — a standalone mock Point-of-Sale that talks to Looplet exactly
 * the way a real merchant POS would: an API-key-authenticated HTTPS POST to the
 * receipt-webhook. This is the reference integration a real POS's developer
 * would copy, and a repeatable "is the front door real?" test.
 *
 * It deliberately uses the API-KEY path (Authorization: Bearer llp_…), NOT a
 * user JWT — that's the path a real POS uses, and the one the in-app simulator
 * does NOT exercise.
 *
 * Config (env vars, or a Looplet POS bridge .env file via --env <path>):
 *   LOOPLET_RECEIPT_WEBHOOK_URL     e.g. https://<ref>.supabase.co/functions/v1/receipt-webhook
 *   LOOPLET_POS_API_KEY             the llp_… key with write:receipts scope
 *   LOOPLET_RECEIPT_IDENTITY_TOKEN  the rhp_… customer identity scanned at tender
 *   LOOPLET_ORGANIZATION_ID         (optional) only needed if you skip the API key
 *   LOOPLET_SYNC_TARGETS            (optional) csv, default xero,myob,quickbooks,generic_api
 *
 * Usage:
 *   node scripts/mock-pos.mjs                 # one sale
 *   node scripts/mock-pos.mjs --env bridge.env
 *   node scripts/mock-pos.mjs --replay        # send the SAME sale twice (idempotency proof)
 *   node scripts/mock-pos.mjs --refund        # a sale, then a refund referencing it
 *   node scripts/mock-pos.mjs --amount 49.50  # override the total (dollars, inc GST)
 *   node scripts/mock-pos.mjs --merchant "Acme Hardware"
 *
 * Exit code is non-zero if any send fails, so it's CI-friendly.
 */

import { readFileSync } from 'node:fs';

// --------------------------------------------------------------------------
// Tiny arg + env parsing (no dependencies — a real POS bridge stays lean too).
// --------------------------------------------------------------------------
const args = process.argv.slice(2);
function flag(name) {
  return args.includes(`--${name}`);
}
function opt(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

// Load a Looplet POS bridge .env file if asked (KEY=VALUE lines, # comments).
const envPath = opt('env', null);
if (envPath) {
  const text = readFileSync(envPath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim();
    if (!(k in process.env)) process.env[k] = v;
  }
}

const WEBHOOK_URL = process.env.LOOPLET_RECEIPT_WEBHOOK_URL;
const API_KEY = process.env.LOOPLET_POS_API_KEY;
const IDENTITY = process.env.LOOPLET_RECEIPT_IDENTITY_TOKEN;
const ORG_ID = process.env.LOOPLET_ORGANIZATION_ID || undefined;
const SYNC_TARGETS = (process.env.LOOPLET_SYNC_TARGETS || 'xero,myob,quickbooks,generic_api')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function fail(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

if (!WEBHOOK_URL) fail('Missing LOOPLET_RECEIPT_WEBHOOK_URL (set env or --env <bridge.env>).');
if (!API_KEY) fail('Missing LOOPLET_POS_API_KEY.');
if (!API_KEY.startsWith('llp_')) fail(`API key must start with "llp_" (got "${API_KEY.slice(0, 6)}…").`);
if (!IDENTITY) fail('Missing LOOPLET_RECEIPT_IDENTITY_TOKEN (the customer pass scanned at tender).');
if (!IDENTITY.startsWith('rhp_')) fail(`Identity token must start with "rhp_" (got "${IDENTITY.slice(0, 6)}…").`);

// --------------------------------------------------------------------------
// Build a FULLY-VALID POS sale payload. The webhook requires (for source 'pos'):
// merchant.name, final tender_status, payment_reference, GST + subtotal both
// supplied, and a positive total. We satisfy all of them — that's the point.
// --------------------------------------------------------------------------
const merchantName = opt('merchant', 'Coomera Trade Supplies');
const totalDollars = Number.parseFloat(opt('amount', '36.00'));
if (!Number.isFinite(totalDollars) || totalDollars <= 0) fail('--amount must be a positive number.');
const totalCents = Math.round(totalDollars * 100);
const gstCents = Math.round(totalCents / 11); // AU standard rate, 1/11 of inclusive total
const subtotalCents = totalCents - gstCents;

// A stable per-run receipt number so --replay can reuse it for the idempotency proof.
const runStamp = `${Date.now()}`.slice(-9);

function salePayload(receiptNumber) {
  return {
    merchant: { name: merchantName, abn: '26 008 672 179', external_id: 'mock-pos-terminal-01' },
    receipt: {
      number: receiptNumber,
      event_type: 'sale',
      purchase_at: new Date().toISOString(),
      currency: 'AUD',
      subtotal_ex_gst_cents: subtotalCents,
      gst_cents: gstCents,
      total_inc_gst_cents: totalCents,
      tender_status: 'completed', // a FINAL status — required for POS
      payment_method: 'card',
      payment_last4: '4242',
      payment_reference: `auth-${receiptNumber}`, // required for POS
      terminal_id: 'MOCK-TERM-01',
      store_id: 'MOCK-STORE-QLD',
    },
    classification: {
      business_use: 'business',
      deductibility: 'deductible',
      category: 'materials',
      sync_targets: SYNC_TARGETS,
    },
    line_items: [
      {
        description: 'Treated pine framing pack',
        quantity: 1,
        unit_price_cents: subtotalCents,
        total_inc_gst_cents: totalCents,
        gst_cents: gstCents,
        category: 'materials',
      },
    ],
  };
}

function refundPayload(originalReceiptNumber) {
  // A refund must reference the original sale (webhook enforces this for POS).
  const n = `${originalReceiptNumber}-RF`;
  const p = salePayload(n);
  p.receipt.event_type = 'refund';
  p.receipt.original_receipt_number = originalReceiptNumber;
  p.receipt.tender_status = 'refunded';
  return p;
}

// --------------------------------------------------------------------------
// Send one receipt over the wire, exactly as a POS would.
// --------------------------------------------------------------------------
async function send(label, payload, idempotencyKey) {
  const body = {
    // organization_id is only needed if not using the API key; harmless to include.
    ...(ORG_ID ? { organization_id: ORG_ID } : {}),
    identity_token: IDENTITY,
    idempotency_key: idempotencyKey,
    event_type: payload.receipt.event_type,
    source_channel: 'pos',
    payload,
    sync_targets: SYNC_TARGETS,
  };
  process.stdout.write(`→ ${label} (idem=${idempotencyKey}) … `);
  let res, json;
  try {
    res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(body),
    });
    json = await res.json().catch(() => ({}));
  } catch (err) {
    console.log('NETWORK ERROR');
    fail(`Could not reach ${WEBHOOK_URL}: ${err.message}`);
  }
  if (!res.ok || !json.ok) {
    console.log(`HTTP ${res.status}`);
    console.error(`   ✗ ${json.error ?? 'unknown error'}`);
    return { ok: false, status: res.status, json };
  }
  console.log(`HTTP ${res.status} ✓`);
  console.log(`   event_id=${json.receipt_event_id ?? '—'}  bill_id=${json.bill_id ?? '—'}  ` +
    `sync_jobs=${json.sync_jobs?.length ?? 0}`);
  return { ok: true, status: res.status, json };
}

// --------------------------------------------------------------------------
// Scenarios.
// --------------------------------------------------------------------------
(async () => {
  console.log(`\nMock POS → ${WEBHOOK_URL}`);
  console.log(`  merchant="${merchantName}"  total=$${totalDollars.toFixed(2)} ` +
    `(gst=$${(gstCents / 100).toFixed(2)})  key=${API_KEY.slice(0, 8)}…  identity=${IDENTITY.slice(0, 8)}…\n`);

  const receiptNumber = `MOCK-${runStamp}`;
  const idem = `mockpos:${receiptNumber}`;
  let anyFail = false;

  const sale = await send('SALE', salePayload(receiptNumber), idem);
  anyFail ||= !sale.ok;

  if (flag('replay')) {
    // Same idempotency key + same payload → webhook must NOT create a duplicate.
    const replay = await send('SALE (replay, same idem)', salePayload(receiptNumber), idem);
    anyFail ||= !replay.ok;
    if (sale.ok && replay.ok) {
      const same = sale.json.receipt_event_id === replay.json.receipt_event_id;
      console.log(`   ${same ? '✓' : '✗'} idempotency: replay ${same ? 'returned the SAME' : 'created a DIFFERENT'} event_id`);
      anyFail ||= !same;
    }
  }

  if (flag('refund')) {
    const refund = await send('REFUND (references the sale)', refundPayload(receiptNumber), `mockpos:${receiptNumber}-RF`);
    anyFail ||= !refund.ok;
  }

  console.log('');
  if (anyFail) fail('One or more sends failed — see above.');
  console.log('✓ All mock-POS sends succeeded.\n');
})();
