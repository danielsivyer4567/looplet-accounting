# Owner-First Implementation TODO

Date: 2026-06-30

Use this as a handoff checklist for the next model. The product direction is:
make Looplet feel simpler than Xero by showing owners plain-language tasks while
the accounting engine, audit trail, and advisor controls stay underneath.

## 1. Persist Today as a real workstream feed

**Primary files**

- `supabase/migrations/0231_workstream_tasks.sql`
- `src/hooks/useWorkstreamTasks.ts`
- `src/pages/Dashboard.tsx`
- `src/test/db/workstreamTasks.test.ts`
- `src/test/hooks/useWorkstreamTasks.test.tsx`

**What is involved**

- Create a `workstream_tasks` view or RPC that derives tasks from current data.
- Include task fields: `task_kind`, `owner_label`, `why_now`, `source_refs`,
  `suggested_action`, `confidence`, `impact_cents`, `due_at`,
  `blocking_reason`, `completion_event`.
- Start with existing signals: onboarding triage, tax obligations, BAS blockers,
  unapproved bills, overdue invoices, unmatched bank items, missing documents,
  pending approvals, advisor proof reminders.
- Replace the dashboard-local `buildOwnerWorkstreamTasks(...)` derivation with
  the hook once the feed exists.
- Keep the dashboard fallback local derivation only for loading/demo states.

**Verification**

- DB tests prove org scoping and accepted-membership access.
- Component tests prove Today renders tasks from the hook.
- Product smoke proves no console errors and no mobile overflow.

## 2. Add automation decision payloads

**Primary files**

- `supabase/migrations/0232_automation_decisions.sql`
- `src/lib/automationDecision.ts`
- `src/test/db/automationDecisions.test.ts`
- Existing callers in `src/pages/CodingReview.tsx`, `src/pages/ReceiptHub.tsx`,
  `src/hooks/useBillUpload.ts`, `src/hooks/onboarding/useStagedEntities.ts`

**What is involved**

- Add a reusable `automation_decisions` table or embedded JSON contract.
- Store `source_kind`, `source_id`, `decision_kind`, `suggested_treatment`,
  `confidence`, `reason_codes`, `evidence_refs`, `policy_refs`,
  `accepted_by`, `accepted_at`, `overridden_by`, `override_reason`.
- Use common confidence bands: `auto_post`, `quick_confirm`, `review_needed`,
  `advisor_required`, `blocked_external`.
- Do not let AI decisions bypass approval gates, RLS, period locks, or ATO
  external gates.

**Verification**

- Unit tests for serialization/validation.
- DB tests for org isolation and append-only/override audit behavior.

## 3. Build owner intent launchers

**Primary files**

- `src/components/IntentLauncher.tsx`
- `src/pages/Dashboard.tsx`
- `src/components/Layout.tsx`
- `src/test/components/IntentLauncher.test.tsx`

**What is involved**

- Add owner-first actions: `Get paid`, `Pay a bill`, `Buy gear`, `Run payday`,
  `File tax`, `Fix books`.
- Route each intent to the right existing workflow:
  - `Get paid` -> invoices, deposits/card sale, overdue invoice follow-up.
  - `Pay a bill` -> bill upload, supplier, approval, payment run.
  - `Buy gear` -> bill/receipt plus fixed asset or repair/expense treatment.
  - `Run payday` -> payroll/pay run/super/STP proof state.
  - `File tax` -> BAS/tax prep and advisor review, not direct ATO send.
  - `Fix books` -> coding review, reconciliation, missing docs, anomalies.
- Keep professional accounting routes available under Advisor/Advanced.

**Verification**

- Component tests check every intent has a target.
- Product smoke checks desktop/mobile render.

## 4. Add anomaly tasks

**Primary files**

- `supabase/migrations/0233_anomaly_signals.sql`
- `src/hooks/useWorkstreamTasks.ts`
- `src/pages/Quality.tsx`
- `src/test/db/anomalySignals.test.ts`
- `src/test/pages/Dashboard.test.tsx`

**What is involved**

- Create anomaly signals for:
  - unusual expense amount or supplier pattern
  - missing invoice/receipt for a bank payment
  - GST treatment differs from similar jobs
  - duplicate bill or receipt
  - supplier spend spike
  - super/payroll timing issue
  - BAS source coverage gap
- Surface them as owner-language Today tasks, not GL warnings.
- Preserve links to source evidence and suggested fix.

**Verification**

- DB tests prove anomalies are scoped by org and do not expose other tenants.
- UI tests prove anomaly language is owner-readable.

## 5. Turn AP automation into exception review

**Primary files**

- `src/pages/Bills.tsx`
- `src/pages/BillDetail.tsx`
- `src/hooks/useBillUpload.ts`
- `supabase/functions/bills-extract/index.ts`
- `src/test/pages/Bills.test.tsx`
- `tests/receipt-webhook.test.ts`

**What is involved**

- Move bill upload/email/OCR outputs into the automation decision contract.
- Show draft bill confidence, duplicate flags, suggested supplier, GST split, job
  tag, asset/expense treatment, and why Looplet picked them.
- Let high-confidence bills become quick-confirm tasks.
- Keep low-confidence bills in review-needed state.
- Record user corrections as learning feedback.

**Verification**

- OCR/bill tests prove suggested fields and override behavior.
- Dashboard tests prove bills with review state appear in Today.

## 6. Turn bank matching into exception review

**Primary files**

- `src/pages/Reconciliation.tsx`
- `src/hooks/useWorkstreamTasks.ts`
- `supabase/migrations/*bank*`
- `src/test/db/bankReconciliationGlPosting.test.ts`
- `src/test/pages/Dashboard.test.tsx`

**What is involved**

- Convert unmatched bank items into Today tasks.
- Show suggested match, merchant/category, GST treatment, job tag, confidence,
  and missing-evidence state.
- Use bank rules as deterministic fallback, not the primary owner workflow.
- Keep GL posting and reconciliation safety checks unchanged.

**Verification**

- Existing bank reconciliation GL tests stay green.
- New UI test proves "Match X bank items" appears when feed has unmatched items.

## 7. Create a plain-language Tax task layer

**Primary files**

- `src/hooks/useTaxCalendar.ts`
- `src/hooks/useBasWorksheet.ts`
- `src/pages/reports/Bas.tsx`
- `src/pages/reports/TaxReturn.tsx`
- `src/pages/reports/Fbt.tsx`
- `src/pages/reports/Tpar.tsx`
- `src/pages/reports/Franking.tsx`
- `src/pages/reports/Sgc.tsx`
- `src/components/ato/AtoLodgePageGuard.tsx`

**What is involved**

- Convert BAS/FBT/TPAR/franking/SGC/tax return blockers into Today tasks.
- Explain blockers in owner language: "missing receipt", "GST source gap",
  "approval needed", "advisor required", "ATO send disabled".
- Keep ATO/DSP/SBR direct lodgement disabled until external certification is
  genuinely complete.
- Link each task to the relevant prep screen.

**Verification**

- Existing compliance tests stay green.
- Dashboard tests prove tax blockers become Today tasks.

## 8. Add Advisor/Advanced mode separation

**Primary files**

- `src/components/Layout.tsx`
- `src/pages/AuditLog.tsx`
- `src/pages/reports/Index.tsx`
- `src/pages/MyActivity.tsx`
- `src/components/AdvisorFinishButton.tsx`

**What is involved**

- Keep the owner nav simple: Today, Money, Jobs, Gear, People, Tax.
- Put technical/accountant surfaces behind Advisor/Advanced grouping:
  GL/reporting, audit log, coding review, approvals, lodgements, Xero/export,
  advisor finish proof.
- Do not remove routes; only change the default information architecture.

**Verification**

- Product smoke proves all existing routes still render.
- Tests like `creditNotesProduct.test.ts` keep checking route reachability.

## 9. Deploy and live-prove advisor work proof

**Primary files**

- `supabase/migrations/0230_advisor_work_proofs.sql`
- `supabase/functions/accountant-session-digest/index.ts`
- `src/components/AdvisorFinishButton.tsx`
- `docs/ADVISOR_WORK_PROOF_XERO_BENCHMARK.md`
- `docs/DEPLOY_PROOF_P0-05.md`

**What is involved**

- Apply migration `0230` to the target Supabase project.
- Deploy `accountant-session-digest`.
- Sign in as an accepted accountant/advisor.
- Perform real work, click Finish, save internally, download JSON, and email the
  saved proof.
- Capture screenshot proof, console status, function response, and DB row proof.

**Verification**

- Live proof evidence is added to deploy docs.
- No claim that bookkeeper is a separate DB role unless that role is added.

## 10. Add distinct bookkeeper role only if needed

**Primary files**

- `supabase/migrations/0237_bookkeeper_role.sql`
- `supabase/functions/team-invite/index.ts`
- `src/components/settings/InviteAccountant.tsx`
- `src/contexts/OrgContext.tsx`
- `src/hooks/useAccountantHeartbeat.ts`

**What is involved**

- Decide if `bookkeeper` permissions differ from `accountant`.
- If yes, add enum migration, role ranking, invite support, RLS/helper support,
  and UI copy.
- If no, keep bookkeepers under the current advisor/accountant role and name that
  clearly in UI.

**Verification**

- Role tests prove accepted-membership access and no privilege escalation.

## 11. Prove POS-first receipt advantage

**Primary files**

- `docs/pos-integration-guide.md`
- `docs/pos-receipt-webhook.md`
- `src/pages/ReceiptHub.tsx`
- `supabase/functions/receipt-webhook/index.ts`
- `examples/pos-bridge/*`
- `tests/receipt-webhook.test.ts`

**What is involved**

- Run real or pilot sale/refund/void samples through Receipt Hub.
- Prove itemised GST, idempotency, bill/evidence creation, refund/void evidence,
  and sync job generation.
- Add Today tasks for receipt review, missing job tag, missing evidence, and
  failed sync.

**Verification**

- POS acceptance scripts pass.
- Product smoke for Receipt Hub passes.
- Evidence added to POS docs.

## 12. Add close/month-end assistant tasks

**Primary files**

- `src/hooks/useWorkstreamTasks.ts`
- `src/pages/reports/BalanceSheet.tsx`
- `src/pages/reports/CashFlow.tsx`
- `src/pages/reports/EOFY.tsx`
- `supabase/migrations/*journal*`

**What is involved**

- Build close tasks for unposted transactions, unreconciled bank rows, pending
  approvals, AP/AR variances, missing source documents, and period-lock blockers.
- Add simple owner/advisor explanations rather than trial-balance jargon.
- Keep underlying GL reconciliation available for advisors.

**Verification**

- Accounting suite remains green.
- Today panel shows close tasks near month end.

## 13. Add Finance Intelligence explanations

**Primary files**

- `src/pages/Ask.tsx`
- `supabase/functions/ask-bot/index.ts`
- `supabase/functions/advisor/index.ts`
- `src/components/Citations.tsx`
- `src/test/pages/Ask.test.tsx`

**What is involved**

- Let Ask AI answer owner questions with permission-scoped data.
- Add "How Looplet worked this out" explanations: filters, tables, source docs,
  tax assumptions, and caveats.
- Keep citations and evidence links visible.

**Verification**

- Ask tests prove citations/explanations render.
- Security tests prove no cross-org data leakage.

## 14. Add automation learning loop

**Primary files**

- `supabase/migrations/0236_automation_feedback.sql`
- `src/lib/automationDecision.ts`
- `src/pages/CodingReview.tsx`
- `src/pages/BillDetail.tsx`
- `src/pages/Reconciliation.tsx`

**What is involved**

- Record owner/advisor corrections to categories, GST, supplier, job, asset, and
  confidence outcomes.
- Promote repeated accepted decisions into deterministic org-level rules.
- Detect drift when new AI suggestions conflict with historical approved
  treatment.

**Verification**

- DB tests prove feedback is org-scoped.
- Unit tests prove correction events update future suggestions only inside the
  same org.

## 15. Keep final reconciliation gates green

**Primary files**

- `docs/FINISH_LINE_TRACKER.md`
- `docs/IMPLEMENTATION_QUEUE.md`
- `docs/COMPLIANCE_BACKLOG.md`
- `docs/MIGRATION_BASELINE_RUNBOOK.md`
- `src/test/db/deploymentDocsReconciliation.test.ts`

**What is involved**

- Keep ATO lodgement as the explicit TODO/external-gated list.
- Update migration ceiling when new migrations are added.
- Map all queue items to completed, TODO, or external-gated.
- Run gates before handoff.

**Verification**

- `npm run format:check`
- `npm run typecheck`
- `npm run lint`
- `npm run build`
- `npm test`
- `npm run test:accounting`
- `npm run product:ux-smoke -- --browsers=chromium,firefox`
- `git diff --check`
