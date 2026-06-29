# Receipt Tag

## What it is

Receipt Tag gives a customer a **physical carrier** for their Looplet receipt
identity. The identity is unchanged — it is the same `rhp_` token the Receipt Hub
already issues, revokes, and validates. Receipt Tag simply lets that one identity
ride on a second carrier so the customer can choose how they present it at the
counter.

## Dual-carrier model: one identity, two carriers

There is exactly **one identity** per customer pass: the existing
`rhp_<prefix>.<secret>` token issued by `issue_receipt_identity`. Nothing about
the identity, the database, or the webhook changes.

What changes is how the customer _carries_ that identity to checkout:

- **Carrier 1 — the Receipt Tag (physical).** An NFC fob or card (a "gym fob")
  that holds the token. Built for low-tech and elderly users: no app, no battery,
  no login. Keep it on the keyring, tap it at the counter.
- **Carrier 2 — the phone (digital).** The token in a wallet pass or written to a
  tag via Web NFC, for tech-savvy users who would rather tap their phone.

The customer **chooses the carrier**. The merchant flow, the token, and the
receipt pipeline are identical either way.

## The gym-fob analogy

A gym fob is the right mental model and it carries zero learning curve. You do not
"log in" to a gym — you tap a fob the front desk gave you and the door opens. The
fob is not your membership; it is a _carrier_ for your membership identity. Lose
it, and the desk deactivates that fob and hands you a new one. Receipt Tag is the
same: tap to identify yourself to the receipt machine, nothing more.

## Identity, not payment

This is the single most important property. A Receipt Tag carries an **identity
token, not a payment instrument.**

- A lost or stolen tag **cannot spend money** — it only tells the receipt machine
  "this receipt belongs to me."
- A lost tag is **revocable**, and **revoke is already built and live**: the
  Receipt Hub "Revoke" action flips the identity to `revoked` and the webhook's
  `resolveReceiptIdentity` immediately refuses any token whose identity is not
  `active`. A revoked tag is inert.
- The full secret is **never stored** — the database keeps only `token_prefix` and
  a SHA-256 `token_hash`. Even a database leak does not yield a usable tag.

So the worst case for a lost tag is: revoke it, issue a new one. No money is ever
at risk.

## Hardware and cost

- **Tags:** standard NTAG NFC stickers/fobs/cards cost roughly **$0.20–$0.50**
  each. They are passive (no battery) and write-once-then-reuse.
- **Reading at the counter:**
  - **Modern Android smart terminals** expose NFC to apps, so the tag can be read
    by the terminal app directly — **no extra hardware**.
  - **Locked, old-style EFTPOS** units do not expose NFC to third-party apps; a
    counter that wants tag-read on those needs a **separate USB NFC reader (~$40)**
    wired to the POS PC.
- **Phone tap:** the digital carrier is **Android-friendly** (Chrome Web NFC can
  read/write tags). It is **Apple-restricted** — iOS does not expose Web NFC to
  browsers, so iPhone users fall back to the barcode/wallet pass.

None of this requires the customer to own anything but a sub-dollar tag.

## Honest status: BUILT vs TO-BUILD

**Built and live today:**

- The identity token (`rhp_…`), issued by `issue_receipt_identity`.
- Issuing, listing, and **revoking** identities in the Receipt Hub.
- The full receipt pipeline: webhook ingest → identity validation
  (`resolveReceiptIdentity`) → normalize → classify → sync queue.

**Still the real gap:**

- The **merchant-POS auto-attach connector** — the piece that makes an arbitrary
  merchant POS read a tapped tag and attach the token to the outgoing receipt
  payload automatically. That is integration work per POS and remains unbuilt for
  general merchants (the POS bridge setup panel documents the contract).

**What this feature delivers:**

- The **in-app tag round-trip as proof**: program the currently-issued `rhp_`
  token onto a blank tag, then tap to read it back and reuse it for capture — all
  inside the Receipt Hub, on a phone, with no merchant dependency.
- The **consumer-facing path**: the customer's chosen carrier, demonstrated
  end-to-end, ready to hand to the eventual merchant connector.

Receipt Tag is therefore an honest _consumer-side_ and _proof_ feature. It does
not pretend the merchant connector exists; it makes the customer half real and
testable today.
