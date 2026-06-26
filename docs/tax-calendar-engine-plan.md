# Tax-Calendar Engine — Plan (Phase 1 of the Tax Copilot)

> Status: **proposed** · Owner: Daniel · Last updated: 2026-06-25
>
> Part of a larger "time-aware tax copilot" vision. This document covers **Phase 1
> only** — the calendar engine that every later layer reads from.

## Vision (context)

Today the system answers tax questions when asked but doesn't *drive*. The goal is a
copilot that, depending on the time of year, reminds you, works with you, prepares
documents, and removes the need for a bookkeeper and most accountant *prep*.

It builds in three stacked layers:

1. **Tax-calendar engine** (this doc) — knows what's due, when, for THIS business.
2. **Seasonal copilot surface** — a "do this now" home panel + escalating nudges.
3. **Guided prep workflows + document generation** — readiness checklists that end in
   a lodgement-ready artifact (BAS worksheet, EOFY pack, TPAR file).

## Goal of Phase 1

A **per-org, time-aware tax calendar** exposed as data: what's due, when, and for whom —
correct for Australian rules and gated by each org's registrations. It also becomes the
single source of truth that fixes today's BAS-only, partly-incorrect calendar.

## Foundations that already exist

- `ask-bot` — routes questions, queries the user's books, grounds tax answers in AU law
  with citations; already loads a personalized profile (entity, GST, state, registrations,
  TPAR, vehicles, turnover bracket). `supabase/functions/ask-bot/index.ts:127`
- `au_bas_quarter()` + `v_bas_quarterly` — a tax-calendar primitive (FY/quarter/due date).
  `supabase/migrations/0032_bas_and_cash_flow_views.sql`
- `notifications-cron` — daily cron at 02:30 already emits a "BAS due within 14 days" alert
  plus 6 other categories. `supabase/functions/notifications-cron/index.ts`
- `business_profile` — entity_type, is_gst_registered, bas_frequency, is_paygw/paygi/fbt/
  workcover_registered, is_tpar_required, employees_count, state_code, vehicles.
  `supabase/migrations/0051_business_profile.sql`

## Design: hybrid rules + status

Due dates are deterministic from rules, so we **compute** obligation instances on demand
and **persist only status** (what the user has done).

1. **Rules layer** — `tax_obligation_types`: what obligations exist, cadence, due-date
   rule, enabling registration flag, nudge lead times.
2. **Generator** — `generate_tax_obligations(org, from_date, to_date)`: a set-returning
   function emitting concrete instances over a window, gated by `business_profile`.
3. **Status layer** — `tax_obligation_status`: per-instance state (open / in_progress /
   done / dismissed) — makes it "works *with* you."

`v_tax_calendar` = generated instances `LEFT JOIN` status, scoped to current + next FY,
RLS-gated via existing org policies.

## AU obligations encoded (gated by registration)

| Obligation | Enabled when | Cadence | Due-date rule |
|---|---|---|---|
| BAS / GST | `is_gst_registered` | quarterly (or monthly) | Q1→28 Oct, Q2→**28 Feb**, Q3→28 Apr, Q4→28 Jul; monthly→21st next month |
| PAYG-W | `is_paygw_registered` / employees | with BAS | aligns to BAS |
| PAYG-I | `is_paygi_registered` | quarterly | aligns to BAS |
| Super guarantee | `employees_count > 0` | quarterly | quarter end **+28 days** (pay ~5 business days earlier) |
| TPAR | `is_tpar_required` | annual | **28 Aug** |
| FBT return | `is_fbt_registered` | annual (yr end 31 Mar) | **21 May** |
| Income tax return | always (entity-aware) | annual | sole trader **31 Oct** |
| EOFY tasks | always | annual | **30 Jun** bucket (finalise STP by 14 Jul, pay super for deduction, write-off decisions) |
| WorkCover QLD | `is_workcover_registered` | annual | declaration ~**31 Aug** |

Each carries **lead times** for escalating nudges (BAS 21/14/3 days, super 10 days,
TPAR 30 days, EOFY 30 days) — consumed in Phase 2.

## Correctness fixes folded into this phase

- **BAS Q2 due date** — replace `quarter_end + 28 days` (gives ~28 Jan) with the correct
  fixed dates above (**28 Feb** for Q2). Fixes `au_bas_quarter()` → propagates to
  `v_bas_quarterly`, `Bas.tsx`, and `notifications-cron`.
- **Super rate** — bump `system_defaults.au_super_pct` 11.5 → **12%** (effective 1 Jul
  2025), with a comment noting the rate schedule.
- **Weekend/holiday roll-forward** — add `next_business_day()` helper. v1 ships
  **weekend-only roll**; full QLD public-holiday accuracy is a flagged refinement.

## Build slices (vertical, each shippable)

**Slice 1 — Rules + due-date correctness** (`0089_tax_calendar.sql`)
- Fix `au_bas_quarter()` due dates; add `next_business_day()` (weekend roll).
- `tax_obligation_types` seed.
- `generate_tax_obligations(org, from_date, to_date)` SRF (gated by business_profile).
- `v_tax_calendar` view (instances only), RLS via existing org policies.

**Slice 2 — Status tracking** (`0090`)
- `tax_obligation_status` table + RLS + audit-log hook.
- `set_tax_obligation_status(...)` RPC.
- Extend `v_tax_calendar` with status + derived stage
  (`upcoming` / `due_soon` / `overdue` / `done`).

**Slice 3 — Wire into existing systems (data, minimal UI)**
- `ask-bot` → add `=== TAX CALENDAR (next 90 days) ===` to `loadBusinessContext` →
  answers become time-aware immediately.
- `notifications-cron` → replace BAS-only `checkBasDue` with a generic "obligations
  entering their lead window" check across all enabled types.
- `useTaxCalendar` React hook (data ready for Phase 2).

**Slice 4 — Tests + verification**
- SQL assertions for due-date math (esp. Q2), registration gating, overdue detection.
- Simulate cron at several dates against a seeded org; confirm correct alerts.

## Honest scoping note

This engine + later phases eliminate the bookkeeper and most accountant *prep*: it tracks
deadlines, validates readiness, and produces lodgement-ready figures/documents. It does
**not** electronically lodge to the ATO (no SBR/online-services integration in scope) —
the user or their tax agent still submits and signs off. Position as "your books are
always tax-ready and the copilot does the prep," not "no human ever touches the ATO."

## Open decisions — recommended v1 defaults (override anytime)

1. **Tax-agent concessions** — agents get ~4 weeks later due dates.
   **Recommended v1:** add a per-org `lodges_via_tax_agent` setting (default `false` =
   self-lodger dates), so the data model supports it but v1 shows self-lodger dates.
2. **Public holidays** — **Recommended v1:** weekend-only roll-forward now; QLD public
   holidays added as a later refinement.
3. **Monthly BAS / IAS** — **Recommended v1:** honour `bas_frequency` and include the
   monthly path (small extra effort, avoids wrong dates for monthly lodgers).

## Out of scope (later phases)

- Seasonal "do this now" home surface and escalating nudge UI (Phase 2).
- Guided prep workflows + document generation — BAS worksheet PDF, EOFY accountant pack,
  TPAR file (Phase 3).
- Electronic lodgement to the ATO.
