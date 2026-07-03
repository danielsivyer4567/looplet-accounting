# GL posting interface — FROZEN (Lane E)

Lane E (General Ledger) owns the immutable-journal engine (E1) and GST/BAS
control account posting (E2). **This document is the contract.** Lanes C
(AP coding), D (bank), and F (payroll, if it posts) build against what's
written here — you should not need to read or edit anything under
`supabase/functions/_shared/gl/` or the journal migrations to post a
transaction. If this doc is insufficient for what you need to post, that's a
gap to raise with Lane E, not a reason to hand-roll the draft-insert/post-rpc
dance again.

Status: E1 is pre-existing and unchanged by this doc (migrations `0071`–`0075`,
already live). E2 (`system_accounts` control-account resolution → journal
posting) is new in this lane and additive — no existing caller is modified.

## E1 — Immutable journal engine

### Data model (unchanged, migrations `0071`–`0075`)

- `chart_of_accounts` — per-org account list. `account_type ∈ {asset, liability, equity, income, expense}`.
- `journal_entries` — one balanced transaction. `status ∈ {draft, posted, void}`. `source_type`/`source_id` are a soft (non-FK) link back to whatever produced the entry (e.g. `"bill"` / bill id) — set them so the entry is traceable.
- `journal_lines` — debit/credit lines on an entry. Amounts are non-negative `bigint` cents; each line is *either* a debit *or* a credit (`journal_lines_one_side` CHECK), never both, never zero-and-zero.
- **Immutability**: once `journal_entries.status = 'posted'`, the row and its lines are frozen (BEFORE triggers in `0075`, not a REVOKE — RLS still grants UPDATE/DELETE, the triggers are the actual enforcement). The only legal transition is `posted → void`. **Corrections are a reversing entry, never a mutation.** A `draft` entry may be freely deleted (used for cleanup-on-failure).

Full schema/security writeup: `docs/general-ledger.md`. Read that for the
*why*; this doc is the *how do I call it*.

### The call — `postJournalEntry()`

```ts
import { postJournalEntry, type PostJournalEntryDeps, type PostJournalEntryParams } from "../_shared/gl/postJournalEntry.ts";

const deps: PostJournalEntryDeps = {
  admin,                                    // service-role SupabaseClient (bypasses RLS for the draft write)
  supabaseUrl: Deno.env.get("SUPABASE_URL")!,
  anonKey: Deno.env.get("SUPABASE_ANON_KEY")!,
  connectorJwtSecret: Deno.env.get("CONNECTOR_JWT_SECRET"), // same secret api-gateway uses
};

const result = await postJournalEntry(deps, {
  organizationId: bill.organization_id,
  lines: [
    { account_id: expenseAccountId, debit_cents: netCents, credit_cents: 0, description: "..." },
    { account_id: apAccountId,      debit_cents: 0,        credit_cents: totalCents, description: "..." },
  ],
  memo: `Auto-coded bill ${bill.invoice_number}`,   // optional
  sourceType: "bill",                                // optional but recommended
  sourceId: bill.id,                                 // optional but recommended
  entryDate: bill.invoice_date,                      // optional, defaults to today in the DB
});
// result: { posted: boolean, journalEntryId: string | null, reason: string | null }
```

**Contract, frozen as of this commit:**

- `lines` must be ≥ 1 and balance (`Σ debit_cents === Σ credit_cents`) — `post_journal_entry()` (`0073`) is the source of truth for this check; `postJournalEntry()` does not duplicate it, it surfaces the DB's rejection reason verbatim in `result.reason`.
- All `account_id`s must belong to `organizationId` and be `is_active` — same, enforced DB-side, surfaced verbatim.
- On any failure **before** posting (draft insert, lines insert, or the post RPC itself), the still-draft `journal_entries` row is deleted. You never get a dangling unposted entry from a failed call.
- On success, `journalEntryId` is the posted entry's id and `reason` is `null`. On failure, `posted: false`, `journalEntryId: null`, `reason` is a human-readable string (log it; don't pattern-match on it — it may change wording, though the *conditions* it fires under won't).
- Requires `CONNECTOR_JWT_SECRET` set in the calling function's environment (same secret `api-gateway` already requires) — the RPC re-checks org access via a short-lived org-scoped JWT since backend callers have no `auth.uid()`. If unset, `postJournalEntry()` fails closed with `reason: "CONNECTOR_JWT_SECRET unset; cannot post"` and never calls the RPC.
- **Do not** insert directly into `journal_entries`/`journal_lines` and call `post_journal_entry()` yourself unless you have a reason `postJournalEntry()` can't accommodate — if you find one, extend `PostJournalEntryParams` (additively — see "Change policy" below) rather than bypassing it, so every caller stays on one audited path.

Existing callers (`coding-classifier`, `depreciation-run`, `accrue_recurring_bill`, `close_period`) predate this wrapper and still do the insert/insert/rpc dance inline — they are **not required to migrate**. New posting code should use `postJournalEntry()`.

## E2 — GST/BAS control account posting

### The gap this closes

`system_accounts` (`0118`) already lets an org designate *which*
`chart_of_accounts` row fills the `gst_collected` (output GST on sales) or
`gst_paid` (input GST credits on purchases) role — but until this lane, only
the read-side `v_gst_reconciliation` view (`0119`) consumed it. Every
write-side poster (e.g. `coding-classifier`'s `buildLines`) still hardcodes a
chart-of-accounts **code** (e.g. `"1200"`) for its GST line, which breaks the
moment an org's COA doesn't match the seeded template. E2 is the
control-account-aware alternative.

### The call — `postGstControlEntry()`

```ts
import { postGstControlEntry } from "../_shared/gl/gstControlAccounts.ts";

const result = await postGstControlEntry(deps, {          // deps: same PostJournalEntryDeps as E1
  organizationId: bill.organization_id,
  kind: "purchase",                 // "sale" (output GST) | "purchase" (input GST)
  netAccountId: expenseAccountId,   // revenue account for a sale, expense account for a purchase
  netCents: netAmountExGst,
  counterAccountId: apOrBankAccountId, // AR/bank for a sale, AP/bank for a purchase
  gstCents: gstAmount,              // 0 is fine — the GST line is simply omitted
  description: "Bill #123",
  sourceType: "bill",
  sourceId: bill.id,
});
// result: { posted, journalEntryId, reason, gstAccountId: string | null }
```

Line shape it produces (via `postJournalEntry()` underneath, so all of E1's
guarantees above apply unchanged):

| `kind` | Debit | Credit |
|---|---|---|
| `"sale"` (role `gst_collected`) | counter account, `net + gst` | net account, `net`; GST control account, `gst` |
| `"purchase"` (role `gst_paid`) | net account, `net`; GST control account, `gst` | counter account, `net + gst` |

**Contract:**

- Resolves the control account via `system_accounts` (`organization_id`, `role`, `deleted_at IS NULL`) — at most one live row per org+role by DB constraint (`0118`).
- If the org has no live designation for the required role, **nothing is written** — no draft entry, no partial state — and `result.reason` is `"no live system_accounts designation for org <id> role <gst_collected|gst_paid>"` (also thrown as `GstControlAccountNotConfiguredError` from `resolveGstControlAccount()` if you call that directly). Treat this the same way `coding-classifier` treats an unresolvable hardcoded account today: fall back to `needs_review`, don't silently skip the GST line.
- `gstCents: 0` is valid and produces a two-line, GST-free entry (the GST line is omitted, not zeroed) — `journal_lines_one_side`/nonneg CHECKs forbid a zero-amount line either way.
- `netCents` must be `> 0`; `gstCents` must be `>= 0`. Violating this returns a validation `reason` without any DB call.

### Change policy

This interface is frozen for **additive** change only:

- New optional fields on `PostJournalEntryParams` / `PostGstControlEntryParams` — fine.
- New exported functions in `supabase/functions/_shared/gl/` — fine.
- Renaming/removing existing fields, changing return shapes, or changing what a given input produces — **not fine** without re-freezing this doc and notifying lanes C/D/F, since they build against it without reading Lane E's files.

Lane E owns and is the only lane that edits: `supabase/functions/_shared/gl/**`, `docs/general-ledger.md`, `docs/gl-posting-interface.md`, and any future GL/GST migrations. Everything else — including the existing hardcoded-GST-code callers — is out of scope for this lane; adopting `postGstControlEntry()` in those callers is left to the lane that owns them.
