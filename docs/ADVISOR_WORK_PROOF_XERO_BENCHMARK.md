# Advisor Work Proof Xero Benchmark

Date: 2026-06-30

## Xero baseline

Official Xero docs describe these adjacent surfaces:

- History and notes report: summary/export for transaction and user activity.
  Source: https://central.xero.com/s/article/View-a-history-and-notes-summary-for-transactions-and-user-activity
- Transaction history and notes: per-transaction history plus notes.
  Source: https://central.xero.com/s/article/View-history-and-notes-for-individual-transactions-and-inventory-items
- Assurance dashboard: advisor-facing audit checks around organisation data.
  Source: https://central.xero.com/s/article/Assurance-dashboard-explanation
- Login history: user and organisation login trail over a recent window.
  Source: https://central.xero.com/s/article/Security-in-Xero
- Workpapers: practice workflow packs, work programs, and client queries.
  Source: https://central.xero.com/s/article/About-Xero-Workpapers

## Looplet model

Looplet should not copy those as separate loose screens. The smarter model is a
single advisor work proof bundle:

- Path trail: pageviews and control-click actions from the advisor's session.
- Write trail: database audit rows for the same user, organisation, and period.
- Work snapshot: server-compiled JSON with counts, resource coverage, risk flags,
  and an invoice seed.
- Tamper evidence: SHA-256 snapshot hash persisted with the proof.
- Advisor handoff: save inside Looplet, download to local JSON, or email the saved
  proof.
- Billing support: a generated evidence line accountants can attach to their own
  invoice/workpaper system.

## Current implementation

Migration `0230_advisor_work_proofs.sql` adds durable saved proofs plus the
`finish_advisor_work_session(...)` RPC. The header `Finish` button opens the
proof modal and supports refresh, internal save, JSON download, and email. The
accountant heartbeat now tracks meaningful control clicks as action events.

## Deliberate constraints

- ATO lodgement remains on the TODO list and is not implied by advisor work proof.
- The current schema's external-advisor role is `accountant`. Bookkeepers are
  covered when invited under that advisor role. A separate `bookkeeper` enum role
  would need its own permission model before it is used in production.
- The `0230` migration is local pending until deliberately applied to the live
  Supabase project.
