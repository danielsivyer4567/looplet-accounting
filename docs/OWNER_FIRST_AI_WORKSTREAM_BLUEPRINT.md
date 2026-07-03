# Owner-First AI Workstream Blueprint

Date: 2026-06-30

## Objective

Make Looplet feel dramatically easier than Xero, QuickBooks, Zoho, and Sage by
removing the accounting interface from the owner experience while keeping a real
double-entry engine, controls, and advisor-grade reporting underneath.

This is not a cosmetic rename. It is an operating model:

- owners work in plain-language intents
- automation handles routine bookkeeping
- exceptions are surfaced as guided tasks
- advisors retain ledger, audit, compliance, and export surfaces

## Competitive Reference Points

- Xero now markets AI-powered automatic bank reconciliation through JAX, using
  rule, match, memory, and prediction methods.
  Source: https://www.xero.com/us/accounting-software/reconcile-bank-transactions/
- Xero Central describes automatic bank reconciliation powered by JAX as looking
  at statement-line data and reconciling against Xero data.
  Source: https://central.xero.com/s/article/About-auto-bank-reconciliation-powered-by-JAX
- Zoho Books has Auto-scan / Documents workflows for emailing or uploading
  receipts, bills, and purchase orders, extracting key information, and turning
  documents into transactions.
  Source: https://www.zoho.com/blog/books/auto-scan-receipts-document-management.html
- Sage Intacct GL Outlier Detection is an ML service that evaluates current
  transactions against historical patterns and flags outliers in journal-entry
  approval.
  Source: https://www.intacct.com/ia/docs/en_US/help_action/General_Ledger/GL_Outlier_Detection/glod-overview.htm

The bar is therefore not "has AI" or "has OCR". The bar is an integrated system
where most owner-facing work is exception review, not bookkeeping.

## Pillar 1: Plain-Language, Non-Accountant Interface

### Owner navigation

Replace accountant-first modules with owner mental models:

| Owner area | Meaning                                         | Current Looplet surfaces to fold in                                                      |
| ---------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Today      | What needs my attention now                     | notifications, onboarding triage, allocations, approvals, overdue invoices, BAS blockers |
| Money      | Cash in, cash out, what is really mine          | dashboard, bank, reconciliation, bills, invoices, debts, cash flow                       |
| Jobs       | Work, customers, margin, supplier costs         | jobs, job detail, customers, allocations, customer P&L                                   |
| Gear       | Assets, vehicles, tools, depreciation, finance  | fixed assets, finance/debt, asset-related bills, depreciation                            |
| People     | Payroll, employees, super, timesheets, advisors | employees, payroll, payment runs, accountant portal, team                                |
| Tax        | GST, BAS, PAYG, super, EOFY, proof packs        | BAS, tax return, FBT, TPAR, franking, SGC, lodgements, advisor proof                     |

### Intent verbs

Main actions should be phrased as what the owner wants to do:

| Intent       | User wording  | System maps to                                                                            |
| ------------ | ------------- | ----------------------------------------------------------------------------------------- |
| `get_paid`   | Get paid      | invoice, card sale, deposit, receipt, customer, debt follow-up                            |
| `pay_bill`   | Pay a bill    | bill capture, supplier, GST split, approval, payment run, bank match                      |
| `buy_gear`   | Buy gear      | bill/receipt, asset register, depreciation, finance, GST treatment                        |
| `run_payday` | Run payday    | pay run, PAYG, super, STP evidence, employee records                                      |
| `file_tax`   | File tax      | BAS/IAS/FBT/TPAR/tax prep, review blockers, advisor approval, external lodgement boundary |
| `fix_books`  | Fix something | uncategorised bank items, missing docs, anomalies, duplicates, wrong GST/job tag          |

### Advisor mode

Keep professional accounting surfaces, but put them behind explicit advisor /
advanced entry points:

- general ledger and journals
- chart of accounts and tax-code mappings
- audit log
- migration/import/export reports
- BAS/tax workpapers
- advisor finish proof
- Xero/export connectors

Product rule: owner screens must not require a user to know GL codes, GST labels,
debit/credit direction, journal mechanics, or SBR terminology.

## Pillar 2: AI-First Automation Engine

### Automation stack

Looplet should treat every financial event as a candidate for automatic handling:

1. **Evidence ingest**

   Sources: bank feed, POS receipt, bill upload, email attachment, Gmail mining,
   bank CSV, supplier invoice, payroll record, contract, manual upload.

2. **Evidence graph**

   Link merchant, supplier, customer, document, bank transaction, POS sale, job,
   asset, employee, tax period, and audit event. The graph is what lets the app
   explain why it made a decision.

3. **Classification engine**

   Rank candidate category, GST treatment, job tag, contact, asset treatment, and
   confidence. Use rules as deterministic guardrails and fallback, not the main
   owner workflow.

4. **Regulation-aware policy engine**

   AU rules first: GST, BAS labels, PAYG, super, SGC, TPAR, FBT, depreciation,
   franking, trust distribution, and entity-specific tax treatment. Human
   judgement and registered-agent boundaries are surfaced as blockers.

5. **Anomaly engine**

   Show alerts as owner language:
   - "This expense looks unusual for this supplier."
   - "Missing invoice for this payment."
   - "GST treatment differs from similar jobs."
   - "This looks like gear, not a normal expense."
   - "Super looks late for this pay run."
   - "This BAS draft has source gaps."

6. **Human-in-the-loop confirmation**

   Confidence bands:
   - `auto_post`: system can post and keep evidence.
   - `quick_confirm`: one-tap owner confirmation.
   - `review_needed`: owner/advisor chooses between clear options.
   - `advisor_required`: professional judgement or regulated action.
   - `blocked_external`: ATO/DSP/SBR/live transport is not available.

### Smart default contract

Every suggested action should include:

- suggested action in plain English
- accounting treatment behind the scenes
- confidence score / reason
- source evidence links
- tax/GST consequence
- job/customer/asset/person tag
- reversible audit trail
- escalation path if uncertain

### Do not over-automate

Automation should not silently perform regulated judgement, ATO lodgement,
tax-agent advice, AFSL-adjacent super strategy, objections, penalty remission, or
legal characterisation decisions. Those become guided prep and advisor handoff.

## Pillar 3: Guided Tasks Instead Of Modules

### Today screen

The first screen should answer one question: "What do I need to do today?"

Task examples:

- Match 12 bank items
- Approve 2 bills to pay
- Send 3 overdue invoices
- Review 4 unusual expenses
- Confirm 6 receipt matches
- Finish payroll for Friday
- Review BAS draft for Apr-Jun
- Add missing invoice for a bank payment
- Invite accountant to review tax
- Download advisor work proof

### Task object model

A task should be a derived object, not a hardcoded page notification:

| Field              | Purpose                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| `task_kind`        | bank_match, overdue_invoice, approve_bill, bas_review, anomaly, missing_document, payroll_review |
| `owner_label`      | Human-language title                                                                             |
| `why_now`          | Trigger and urgency                                                                              |
| `source_refs`      | Linked records and documents                                                                     |
| `suggested_action` | Default action                                                                                   |
| `confidence`       | auto_post, quick_confirm, review_needed, advisor_required, blocked_external                      |
| `impact_cents`     | Cash/tax/payroll value where relevant                                                            |
| `due_at`           | Deadline or recommended action date                                                              |
| `blocking_reason`  | Missing evidence, missing setup, policy gate, external gate                                      |
| `completion_event` | Audit event emitted when done                                                                    |

### Intent wizard behavior

Wizards should adapt to the user's goal instead of asking them to choose an
accounting module:

- **Get paid**: create invoice, record deposit, import card/POS sale, chase debt,
  or match bank receipt.
- **Pay a bill**: upload/email bill, approve, schedule payment, match bank debit,
  or mark as disputed.
- **Buy gear**: capture receipt/bill, decide asset vs repair/expense, attach to
  job, set depreciation treatment, track finance.
- **Run payday**: calculate pay, PAYG, super, leave, employee evidence, and STP
  proof state.
- **File tax**: gather blockers, build draft, explain labels, request advisor
  review, and keep ATO send disabled until certified.

## Current Looplet Fit

| Pillar                     | Already present                                                         | Gap to close                                                                  |
| -------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Plain-language owner model | Cash pulse, jobs, bills, receipts, tax reports, advisor proof           | Reorganise main nav into Today / Money / Jobs / Gear / People / Tax           |
| Intent verbs               | Upload bill, payment run, invoice, payroll, BAS prep                    | Add intent launcher and guided wizards that hide module choices               |
| AI automation              | OCR, coding review, advice notes, legal horizon, POS receipt validation | Add confidence bands, learning loop, explanation payload, and exception queue |
| Regulation-aware engine    | BAS, FBT, TPAR, franking, SGC, STP lifecycle, SuperStream tests         | Convert outputs into owner tasks with clear external-gated boundaries         |
| Anomaly alerts             | Audit log, quality, reconciliation, BAS blockers                        | Add anomaly table/service and owner-language alert cards                      |
| Guided Today screen        | Dashboard, notifications, onboarding triage                             | Build task derivation layer and make Today the default home                   |
| Advisor/advanced area      | GL/report surfaces, audit log, advisor finish proof                     | Move pro surfaces behind explicit advanced/advisor grouping                   |

## Implementation Roadmap

### Phase 1: Information architecture shift

- Add a product-level `Today / Money / Jobs / Gear / People / Tax / Advisor`
  navigation map.
- Keep current routes working, but group them under the owner mental model.
- Rename owner-facing actions to intents without changing accounting internals.
- Add a visible "Advanced / Advisor" entry for ledger, reports, audit, and export.

### Phase 2: Task derivation layer

- Create a `workstream_tasks` view or RPC that derives tasks from existing data:
  unmatched bank items, unapproved bills, overdue invoices, BAS blockers,
  missing documents, payroll blockers, anomalies, and advisor-review requests.
- Make the Today screen consume that task feed.
- Add completion events to the audit log.

### Phase 3: Automation confidence model

- Add shared `automation_decision` payloads for classifier/OCR/POS/bank/BAS
  decisions.
- Store confidence, reasoning, source evidence, selected treatment, and override
  history.
- Let rules, ML, and regulation checks contribute to one explanation.

### Phase 4: Exception-first workflows

- Convert coding review, allocation, receipt review, BAS prep, and payroll review
  into the same exception queue pattern.
- Add one-tap confirmation for high-confidence items.
- Escalate ambiguous or regulated items to advisor-required state.

### Phase 5: Learning loop

- Learn from owner/advisor overrides per organisation.
- Promote repeated approved decisions into deterministic rules.
- Detect drift when a new decision conflicts with historical treatment.
- Keep all model decisions explainable and reversible.

## Demo Standard

The demo should show the owner doing almost no bookkeeping:

1. Open Today.
2. See five plain-English tasks.
3. Confirm high-confidence matches.
4. Review one unusual expense.
5. Upload or receive one missing receipt.
6. Approve a BAS draft for advisor review.
7. Advisor clicks Finish and downloads/emails proof.

The story is not "Looplet has AI." The story is "Looplet understands what
happened, proves it, posts it correctly, and only asks you about exceptions."
