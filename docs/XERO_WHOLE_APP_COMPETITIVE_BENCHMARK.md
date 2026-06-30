# Xero Whole-App Competitive Benchmark

Date: 2026-06-30

## Position

Looplet should not try to beat Xero by being a generic ledger with nicer screens.
Xero is already mature there. Looplet's path to being materially ahead is to be
an evidence-first operating system for trade businesses, advisors, receipts,
job-costed cash, and Australian compliance preparation.

The winning model is:

- source-of-truth capture before bookkeeping cleanup
- line-item evidence attached to every financial event
- job/customer/project profitability visible while work happens
- deterministic compliance prep with clear agent-only boundaries
- advisor proof packs that turn clicks, paths, and writes into billable evidence

Execution blueprint: `docs/OWNER_FIRST_AI_WORKSTREAM_BLUEPRINT.md`.

## Xero Baseline

Official Xero AU product surfaces reviewed:

- Small business accounting software: invoices, bills, bank feeds, reconciliation,
  GST/BAS, payroll, reports, budgets, cash flow, projects, expenses, files, and
  app connections.
  Source: https://www.xero.com/au/accounting-software/
- Invoicing: online invoices, reminders, payment options, recurring invoices,
  quote conversion, and payment tracking.
  Source: https://www.xero.com/au/accounting-software/invoicing/
- Bills/payables: bill entry, emailed/uploaded bills, Hubdoc extraction, duplicate
  detection, recurring bills, approvals, payment files, and reports.
  Source: https://www.xero.com/au/accounting-software/pay-bills/
- Payroll: pay runs, leave, payslips, Single Touch Payroll, PAYG, super, reports,
  and Xero Me.
  Source: https://www.xero.com/au/accounting-software/payroll/
- Accountants and bookkeepers: Xero HQ, Xero Tax, Xero Practice Manager,
  Workpapers, report templates, client queries, document packs, and practice
  workflows.
  Source: https://www.xero.com/au/accountant-bookkeeper-software/
- AI and ecosystem: JAX, accounting AI, and the Xero App Store.
  Source: https://www.xero.com/au/accounting-software/ai/

## Looplet Inventory

Verified from current routes, migrations, docs, and tests:

- Core AP/AR: bills, bill upload/OCR, suppliers, customers, invoices, customer
  and supplier credit notes, payment runs, approvals, allocation, and archiving.
- Cash and bank: bank connections/import, reconciliation, bank/invoice matching,
  cash-flow and balance-sheet reports.
- Trade operations: jobs, job detail, allocation queue, customer P&L views, and
  job-costed AP/AR framing.
- Receipt Hub and POS: POS receipt webhook, itemised receipt validation, sale /
  refund / void evidence, API keys, OpenAPI, bridge trials, and field pilot
  evidence tooling.
- Advisor surface: accountant portal, clients page, accepted-invite access,
  notifications, advice notes, advisor activity logging, and finish work proof.
- Compliance preparation: BAS, FBT, TPAR, franking, SGC, STP secure TFN
  lifecycle, SuperStream transport, trusts, SMSF, tax return, lodgements, and
  ATO correspondence assist surfaces.
- AI and review: Ask AI, coding review, legal horizon, advice note generation,
  OCR provider abstraction, and workflow-specific guardrails.
- Controls: audit log, accepted-membership RBAC, approval gates, RLS tests,
  migration reconciliation tests, and deployment runbooks.

## Competitive Scoreboard

| Area                                       | Xero position                                                                     | Looplet position                                                                                   | Honest verdict                                                                                              |
| ------------------------------------------ | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| General ledger, bank feeds, reconciliation | Mature production product with broad market adoption.                             | Built core bank/reconciliation surfaces and tests, but live bank-feed proof is still required.     | Xero leads on production maturity; Looplet can win by job/POS evidence depth.                               |
| Bills and supplier AP                      | Mature bill capture, Hubdoc extraction, approvals, payment files, reporting.      | Bills, OCR, document preview, allocations, payment runs, Xero push, credit notes, and audit trail. | Near parity in product scope; Looplet should win by source evidence and job allocation.                     |
| Invoices and AR                            | Mature invoicing, payments, reminders, quote conversion, recurring invoices.      | Invoices, invoice detail, customers, payments, debts, customer credit notes, Xero push.            | Xero leads on payment ecosystem; Looplet can win for trade/job cash visibility.                             |
| Payroll and super                          | Payroll, STP, PAYG, leave, super, employee app.                                   | Payroll, pay runs, STP secure TFN lifecycle, SGC, SuperStream transport tests.                     | Xero leads until Looplet has live payroll/STP/SuperStream proof.                                            |
| GST/BAS and AU compliance                  | Mature BAS/tax workflows in the advisor ecosystem.                                | BAS, FBT, TPAR, franking, SGC, trusts, SMSF, tax return, lodgement-assist surfaces.                | Looplet has broader local-code ambition; Xero leads on certified lodgement maturity.                        |
| Advisor and practice workflow              | Xero HQ, Tax, Practice Manager, Workpapers, client queries, document packs.       | Accountant portal, clients, advice notes, notifications, activity proof, audit trail.              | Xero leads on practice-suite breadth; Looplet's finish-proof bundle is a sharper billing/evidence model.    |
| Workpapers and audit proof                 | Workpapers, history/notes, assurance dashboard, login history.                    | Server-compiled advisor proof snapshots with click path, write audit, hash, save/download/email.   | Looplet can be ahead on proof quality if deployed and shown in real advisor workflow.                       |
| Receipts and POS                           | Strong ecosystem integrations, but not POS-first line-item accounting by default. | Receipt Hub is POS-first, itemised, idempotent, sale/refund/void-aware, and bridge-friendly.       | Looplet has a credible differentiated lead if a real POS pilot passes.                                      |
| AI                                         | JAX and embedded accounting AI across Xero products.                              | Ask AI, advice notes, legal horizon, OCR abstraction, deterministic guardrails.                    | Do not claim AI lead without live evals; Looplet's advantage should be evidence-bound AI, not generic chat. |
| Ecosystem                                  | Xero App Store and large partner network.                                         | OpenAPI, API keys, POS bridge, Xero push, connector guides.                                        | Xero leads massively; Looplet should win by owning the trade/POS workflow before syncing outward.           |
| Mobile and employee UX                     | Mature mobile apps and Xero Me.                                                   | Responsive web smoke-tested; no native mobile app proof.                                           | Xero leads. Looplet should not position as mobile-first yet.                                                |

## Where Looplet Can Be Miles Ahead

1. **Receipt truth before accounting cleanup**

   Xero is strong once documents reach the accounting system. Looplet can win
   earlier by capturing the actual POS sale, line GST, tender reference, refund,
   void, and merchant identity before it becomes a vague bank transaction or PDF.

2. **Job-costed cash from day one**

   Xero supports projects and tracking, but Looplet is framed around trade
   businesses: jobs, allocations, supplier costs, receipts, cash pulse, and
   "what is really yours" style owner language.

3. **Advisor proof, not just history**

   Xero has history, notes, assurance, and Workpapers. Looplet's smarter model is
   to compile a billable work proof from session path, control clicks, audit-log
   writes, summary counts, risk flags, invoice seed, and a tamper-evident hash.

4. **Compliance preparation breadth**

   Looplet now carries code and tests around BAS, FBT, TPAR, franking, SGC, STP
   lifecycle, SuperStream transport, trusts, SMSF, and tax return surfaces. This
   is powerful, but it should be sold as preparation and evidence until live
   lodgement and statutory transport are certified.

5. **Honest agent-only boundary**

   ATO/DSP/SBR lodgement and registered-agent judgement remain external-gated.
   The product should turn that honesty into trust: prepare, prove, approve, then
   hand off or lodge only when the external gate is genuinely cleared.

## Where Xero Still Leads

- Live bank-feed reliability and mature reconciliation at scale.
- Payroll/STP/SuperStream production maturity.
- ATO-connected tax and BAS lodgement through mature advisor products.
- Mobile apps and employee self-service.
- Payments, quote-to-cash, reminders, and recurring workflows.
- Partner ecosystem and marketplace reach.
- Training, support, certification, and accountant adoption.
- Practice management suite breadth.

## Must-Prove List To Blow Past Xero In A Demo

1. Deploy `0230_advisor_work_proofs.sql` and the updated
   `accountant-session-digest` function, then prove save/download/email on live
   advisor data.
2. Add a distinct `bookkeeper` role only if the permission model is intentionally
   different from `accountant`; otherwise keep bookkeepers under the current
   advisor role and name that clearly in UI copy.
3. Run a real POS pilot with sale, refund, and void field samples; attach the
   generated bill/evidence and show the audit package.
4. Prove bank connection or bank CSV import through reconciliation and reports on
   one complete sample month.
5. Prove bill upload/OCR to allocation to payment run to audit log.
6. Prove invoice creation to payment/debt tracking to customer credit note.
7. Prove BAS/FBT/TPAR/franking/SGC outputs as preparation artifacts, while keeping
   direct ATO send disabled.
8. Build a short "owner view" demo: cash pulse, jobs, bills due, tax set-aside,
   receipts, and what is really yours.
9. Build a short "advisor view" demo: clients, advice notes, proof finish,
   audit log, and downloaded evidence.
10. Run the full product smoke, accounting suite, and targeted live smoke before
    any competitive claim is used externally.

## Product Rule

Never say Looplet is ahead because it has more menu items. Say Looplet is ahead
only where it can prove a better workflow with source evidence, auditability,
job-level cash clarity, or lower manual accountant effort.
