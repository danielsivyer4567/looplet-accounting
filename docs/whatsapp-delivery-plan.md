# WhatsApp Receipt Delivery — Build Scope

**Goal:** after a receipt is processed, send the customer their receipt over WhatsApp —
and use the same channel as the lowest-friction way to onboard them (no app, works on
iPhone). Companion to [Receipt Tag](receipt-tag.md): the tag/pass identifies *at the
till*; WhatsApp distributes the pass *and* delivers the receipt *afterward*.

Status: **scoped, not built.** The code is buildable now; going live is gated on
external provisioning (a WhatsApp Business number + an approved template), the same
deploy-gated pattern as the rest of the receipt epic.

---

## The one hard gap (must be solved first)

Today a receipt is **anonymous**: the identity is an `rhp_…` token
([0088_receipt_hub.sql](../supabase/migrations/0088_receipt_hub.sql)) with no customer
contact. `receipt_events` has **no phone, no email, no customer link** — and the webhook
strips any `customer` field from the payload (`receipt-webhook/index.ts`). There *is* a
`customers` table with `phone`/`email` ([0001_initial_schema.sql:288](../supabase/migrations/0001_initial_schema.sql))
but nothing connects a receipt to it.

> **You cannot WhatsApp a receipt until you capture (a) the customer's phone and
> (b) their opt-in consent.** That capture is the heart of this build.

The elegant fix: **WhatsApp onboarding doubles as the capture.**
`Customer scans QR / taps link → opens WhatsApp chat → says "hi" → bot replies with their
Receipt Pass → we now hold their phone + a logged opt-in`. One inbound message gives us
the pass distribution, the phone number, *and* consent — closing the gap in a single step.

---

## Hard WhatsApp constraints (these shape the build)

1. **A post-purchase receipt is business-initiated and outside the 24-hour window → it
   MUST be a pre-approved UTILITY template.** Free-form messages only work for 24h after
   the customer messages *us* first. (The onboarding "hi" opens a window; later receipts
   usually don't, so budget for templates.)
2. **Opt-in is mandatory.** Must store consent (bool + timestamp + source); the opt-in
   prompt must name the business and state they'll get WhatsApp messages. AU: keep an
   auditable consent record (Privacy/Spam Act).
3. **Keep the template strictly transactional** (no promo/upsell) or Meta may
   reclassify it MARKETING (~6.5× the cost; auto-recategorization since Apr 2025).
4. **Pricing (AU, indicative — verify live):** ~US$0.011 per delivered *utility* message
   (Meta moved to per-delivered-message pricing Jul 1 2025) + any BSP markup. Utility
   messages sent *inside* an open window are free.

---

## Provider choice

All providers sit on Meta's WhatsApp Cloud API; the choice is who hosts the number.

| Option | Per-msg markup | Setup | When |
|---|---|---|---|
| **Twilio** | +~$0.005/msg | Easiest (best SDK/docs, pay-as-you-go) | **Start here** — fastest to first receipt |
| **360dialog** | $0 + ~$50/mo flat | Medium | Cheapest at volume |
| **Meta Cloud API (direct)** | $0 | Most plumbing (you own verification/templates) | At scale, if you want zero markup |

**Recommendation:** start on **Twilio**, abstract the send behind a `sendWhatsApp()`
interface, migrate to 360dialog/direct if volume justifies it. (Switching BSP re-onboards
the number — keep the abstraction.)

## Receipt format

- **v1 (recommended):** UTILITY template = text summary (merchant, total, GST, date) +
  a **signed HTTPS link** to the receipt/audit PDF in Supabase storage. Cheapest, most
  robust, no per-send upload, link can expire. Reuses the `receipt-audit` bucket we built.
- **v2:** attach the PDF as a template **document header** (keep < 5 MB).

---

## Architecture

```
Onboarding (capture):
  QR/link → WhatsApp inbound "hi" → whatsapp-inbound edge fn → store phone + opt-in
            → reply with Receipt Pass (rhp_ token: barcode + "add to wallet")

Delivery (send):
  receipt-webhook finalizes receipt  (index.ts ~L487, after queueSyncJobs)
    → fire-and-forget → receipt-deliver edge fn
      → look up customer phone + opt-in for this receipt
      → if opted-in: provider.sendTemplate(UTILITY, {merchant,total,date, link})
      → log delivery (sent/failed) for audit + retry
```

Mirrors existing patterns: fire-and-forget like
[`fireAndForgetIntakeRouting`](../supabase/functions/bills-extract/index.ts), `verify_jwt=false`,
`requireEnv`, `_shared/cors.ts`. Config lives in a new service-role-only table modelled on
[`receipt_sync_endpoints`](../supabase/migrations/0191_receipt_sync_endpoints.sql).

### New data model
```sql
-- per-org WhatsApp sender config (service-role only; secret never reaches the client)
whatsapp_integrations(
  organization_id, provider('twilio'|'meta'|'360dialog'),
  phone_number_id, api_secret, template_name, is_enabled, ...
)

-- customer contact + consent (the gap-closer)
receipt_contacts(
  organization_id, receipt_identity_id,  -- ties a phone to an rhp_ identity
  phone_e164, whatsapp_opt_in bool, opt_in_at, opt_in_source, ...
)

-- delivery audit (sent/failed/retry, provider message id)
receipt_deliveries(
  organization_id, receipt_event_id, channel('whatsapp'),
  to_phone, status, provider_message_id, error, attempts, next_attempt_at, ...
)
```
The receipt payload also gains an optional `customer.phone` / `customer.opt_in` so a POS
that already has consent can pass it directly (alternative to the WhatsApp-onboarding path).

---

## Build phases (when greenlit)

1. **Data model** — `whatsapp_integrations`, `receipt_contacts`, `receipt_deliveries`
   migrations (service-role RLS pattern). *Local-buildable.*
2. **Onboarding capture** — `whatsapp-inbound` edge fn (handles the inbound "hi": logs
   phone + opt-in, replies with the pass) **OR** a web/QR opt-in form. Ties phone → `rhp_`
   identity. *Local-buildable; live needs the number + webhook URL set in the provider.*
3. **Send layer** — `receipt-deliver` edge fn with a `sendWhatsApp()` provider interface
   (Twilio first); UTILITY template + signed PDF link; writes `receipt_deliveries`.
   *Local-buildable; live needs the approved template + provider secret.*
4. **Trigger** — fire-and-forget from `receipt-webhook` after finalize (or a drainable
   `receipt-delivery` cron, mirroring receipt-sync-dispatch). *Local-buildable.*
5. **Consent UI + audit** — opt-in surfacing/management + a delivery log in the app.

Everything in 1–5 is **code we can build now**; each is inert until the external pieces
below exist (same as the migrations/edge-fns this session — build, commit, deploy-gate).

---

## External prerequisites (yours to provide — ~1–2 weeks)

- **Meta Business Verification** ← critical path, start first (hours to ~10 business days).
- A **Twilio account** (or Meta WABA) + a **dedicated business phone number** (must NOT be
  on a personal WhatsApp).
- An **approved UTILITY receipt template** (approval: minutes to ~24h once verified).
- Decisions: **provider** (recommend Twilio to start), **capture path** (WhatsApp-onboarding
  vs POS-supplied phone vs web opt-in), **format** (link vs PDF-header).

---

## Cost (indicative — verify live before committing)
~US$0.011 per AU utility message (per delivered message) + BSP markup (Twilio +~$0.005).
Onboarding/inbound replies inside the 24h window are free. Confirm the live AU utility
rate on Meta's pricing page / your BSP dashboard before finalizing.
