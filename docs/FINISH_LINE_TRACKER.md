# Finish Line Tracker — Owner-First Implementation

**Updated**: 2026-06-30

## Legend
- ✅ Done
- 🟡 Needs live deployment (skipped)
- 📋 TODO (future)

---

## Core Slices

| # | Slice | Status | Files |
|---|-------|--------|-------|
| SC-01 | Workstream feed (DB + hook + Dashboard) | ✅ Done | `0200_workstream_tasks.sql`, `useWorkstreamTasks.ts`, `Dashboard.tsx` |
| SC-02 | Automation decisions table + library | ✅ Done | `0201_automation_decisions.sql`, `automationDecision.ts` |
| SC-03 | Owner intent launchers | ✅ Done | `IntentLauncher.tsx`, `Dashboard.tsx`, `Layout.tsx` |
| SC-04 | Anomaly tasks | ✅ Done | `0202_anomaly_signals.sql`, `useWorkstreamTasks.ts`, `Dashboard.tsx` |
| SC-05 | AP automation → exception review | ✅ Done | `0203_ap_exception_review.sql`, `ConfidenceBadge.tsx`, `Bills.tsx`, `BillDetail.tsx` |
| SC-06 | Bank matching → exception review | ✅ Done | `Reconciliation.tsx` |
| SC-07 | Plain-language Tax task layer | ✅ Done | `Dashboard.tsx` (taskRoute + clickable cards) |
| SC-08 | Advisor/Advanced nav separation | ✅ Done | `Layout.tsx` (owner/advisor nav split) |
| SC-09 | Deploy and live-prove advisor work proof | 🟡 Skipped | Needs live Supabase + ATO credentials |
| SC-10 | Bookkeeper role | 🟡 Skipped | Needs live Supabase for role tests |
| SC-11 | POS receipt advantage proof | 🟡 Skipped | Needs live Supabase + POS bridge |
| SC-12 | Month-end close assistant | ✅ Done | `0204_close_tasks.sql`, `Dashboard.tsx` |
| SC-13 | Ask AI explanations | ✅ Done | `Ask.tsx` (always-visible transparency section) |
| SC-14 | Automation learning loop | ✅ Done | `0205_automation_feedback.sql`, `automationDecision.ts` |
| SC-15 | Final gates + tracker docs | ✅ Done | This file + migration ceiling updated |

---

## Migration Ceiling

**Current**: 0205 (`0205_automation_feedback.sql`)

| Migration | Purpose |
|-----------|---------|
| 0200 | Workstream tasks composite type + RPC |
| 0201 | Automation decisions table |
| 0202 | Anomaly signal arms for workstream feed |
| 0203 | AP exception review RPC |
| 0204 | Month-end close task arm |
| 0205 | Automation feedback + learning loop |

---

## Test Summary

- **44 test files passed**
- **212 tests passed** (41 skipped: DB integration, deployment, e2e)
- **0 failures**
- **Build**: TypeScript clean, Vite build pass

---

## External Gates (blocked)

| Gate | Reason |
|------|--------|
| ATO lodge (`checkLodgeGuard`) | Always returns `allowed: false` — needs deployed ATO credentials + EVTE cert |
| DB integration tests | Skip without `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` in env |
| Advisor work proof deploy | Needs live Supabase project with edge function deployed |
| Bookkeeper role | Needs live RBAC verification |
| POS bridge | Needs live Receipt Hub + POS terminal |
