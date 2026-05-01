# ADR 0004: AFGC baseline figures (TBD by Daniel)

**Status:** Draft — needs data
**Date:** 2026-05-01
**Decides:** Phase 0.4 from `docs/LOOPLET_ACCOUNTING_PRODUCT.md`

---

## Purpose

The other three ADRs (0001 loaded hourly rate, 0002 overhead allocation,
0003 tax set-aside) reference "AFGC's real numbers" as the defaults the
product seeds with. This ADR captures those numbers concretely so the
product launches with truth, not placeholder data.

**Action required from Daniel:** fill in the TBDs below and tick the
sign-off at the bottom.

---

## Employment cost components (per employee, FY 2026)

For each AFGC employee currently on the books, fill out one block:

### Employee 1 — Daniel (owner-operator)

| Component | Value |
|---|---|
| Role | TBD |
| Base wage / drawings | TBD |
| Super % | 11.5% (statutory) |
| Workers comp annual cost | TBD |
| Payroll tax (if QLD threshold exceeded) | TBD or N/A |
| Vehicle / fuel allowance per year | TBD |
| Tools / uniform allowance per year | TBD |
| Annual leave entitlement | 4 wks (152 hr) |
| Personal/sick leave entitlement | 2 wks (76 hr) |
| Public holidays observed | 10 days (76 hr) |
| Average sick days actually taken | TBD |
| Non-billable admin/training hr/yr | TBD |
| Contracted hours/wk | 38 |

### Employee 2 — [name]

(Repeat block per employee)

### Employee N — Subcontractor / contractor pool

For subbies, no employment cost components — they invoice AFGC as
suppliers. Their costs land via `bills`, not `wage_entries`. Captured
here only so we don't accidentally try to model them as employees.

---

## Overhead profile (AFGC, monthly → daily)

| Component | Monthly cost | Notes |
|---|---|---|
| Rent / shed lease | TBD | |
| Vehicle leases (utes, trailer) | TBD | |
| Vehicle running costs (fuel avg, rego, maint) | TBD | |
| Public liability insurance | TBD | annualised ÷ 12 |
| Workers comp (already in employee cost) | $0 here | already counted per-employee |
| Phone + internet | TBD | |
| Software subscriptions (Looplet, accountant tool, etc.) | TBD | |
| Admin labour (bookkeeper monthly fee) | TBD | |
| Bank fees | TBD | |
| Other | TBD | |
| **Monthly total** | **TBD** | |
| **Daily rate (÷ 22 working days)** | **TBD** | |

The 22 working days/month figure is approximate. The schema stores the
daily rate; the operator can override the divisor if their pattern is
different.

---

## Tax set-aside default (AFGC)

- Default: 25% (per ADR 0003)
- AFGC's prior-year effective rate: TBD (compute from last lodged BAS + tax return)
- Override default to actual rate: yes / no — TBD

If AFGC's actual rate is materially different (>5pp from 25%), set the
override on the entity's settings during initial seed.

---

## GST defaults (AFGC, AU 2026)

- GST rate: 10% (statutory, all line items default)
- BAS quarter: AU standard (Q1 Jul-Sep, Q2 Oct-Dec, Q3 Jan-Mar, Q4 Apr-Jun)
- BAS lodgement frequency: quarterly (vs monthly) — TBD; quarterly is the default
- Cash vs accrual basis: TBD (most small AU businesses use cash; AFGC's accountant decides)

---

## Fiscal year

- AU standard FY: 1 July → 30 June
- AFGC's fiscal year: matches AU standard — yes / no — TBD

---

## ABN + GST registration

- AFGC's ABN: TBD
- GST registered: yes / no
- BAS Agent (Jaime / Envy Business): name + agent number — TBD

---

## Sign-off

- [ ] All employee blocks complete
- [ ] Overhead profile complete with monthly total
- [ ] Tax set-aside default decided
- [ ] GST + BAS defaults confirmed
- [ ] ABN captured
- [ ] Reviewed with Jaime / accountant for sanity check

Signed: Daniel Sivyer __________ Date: __________

---

## Why this matters

Without these numbers, the product launches with synthetic defaults that
look right in demos but produce wrong P&L for AFGC the moment real data
hits them. Five hours of capturing this once is worth a hundred hours
of "why is the loaded rate so far off" support tickets later.

This ADR is a one-time fill exercise, not an ongoing process. Once the
numbers land in `system_defaults` + `organizations.settings` +
`overhead_profiles` rows for AFGC, future updates happen through the
product UI (operator changes their own settings), not by editing this
file.
