# Implementation Queue — Compliance Backlog

Generated: 2026-07-01

## Automation Backbone Epic — Completed Slices (SC-01–SC-09)

All slices code-complete and committed. Live-proof items blocked on deploy.

| Slice | Status | Commit |
|-------|--------|--------|
| SC-01 Automation jobs tables + TS library | done | 3ec0ac6 |
| SC-02 Automation worker Edge Function | done | 2ed9693 |
| SC-03 Automation watchdog scanner | done | — |
| SC-04 Confidence policy engine | done | f968b5e |
| SC-05 Versioned document extraction | done | d27601d |
| SC-06 Raw bank event layer | done | d4bcc9e |
| SC-07 Reconciliation evidence upgrade | done | 96d8194 |
| SC-08 Browser job schema + runbook | done | f736bf0 |
| SC-09 Connector endpoint completion + OpenAPI | done | 69ff6dc |

**Blocked on deploy (live-proof only — code is done):**
- Basiq end-to-end bank feed (C1 in AUTOPILOT_PLAN)
- POS pilot receipt flow (receipt-POS integration contract)
- Advisor sign-in live screenshot (SC-09 human gate)

Migration ceiling: **0219**. ATO/DSP/SBR lodgement remains external-gated throughout.

---

These items are identified in the accountant-coverage gap analysis as the next
meaningful blocks of compliance work. None are in-scope for the owner-first
epic (SC-01–SC-15); they are queued for subsequent epics.

## Priority queue

### 1. FBT Return engine
- Annual fringe benefits tax return (April year-end lodgement)
- Requires FBT-year aggregation of benefit categories (car, expense payment,
  living-away-from-home, loan, property)
- Grossed-up taxable value calculation (Type 1 / Type 2)
- ATO electronic lodgement via SBR2 (not yet wired)
- Employer-provided car log-book integration

### 2. Individual income tax returns
- Currently out of scope (TPB agent registration required for lodgement)
- Pre-fill data pipeline from ATO (income statements, private health, bank
  interest) needs a separate DSP agreement
- Draft-only mode (prepare but not lodge) is achievable without TPB registration
- Deprioritised until entity-level lodgements are stable

### 3. TPAR — Taxable Payments Annual Report
- Industries: building/construction, cleaning, courier, IT, security, road freight
- Annual report to ATO of payments to contractors
- Requires contractor payment tagging in chart-of-accounts and supplier records
- Due 28 August each year; can be lodged via SBR2
- Schema work: tag `supplier_type = contractor` + sum payments per ABN per year

### 4. SGC — Superannuation Guarantee Charge
- Quarterly SGC statement when employer misses or underpays SG by the quarterly
  due date
- Requires payroll data integration (base salary, OTE classification)
- Calculation: 11.5% of OTE + interest (10% p.a.) + administration fee ($20/employee/quarter)
- ATO lodgement via SGC statement form (SBR2)
- Blocked on payroll module (not yet built)

### 5. Franking account ledger
- Corporate tax entity franking account balance tracking
- Credit entries: tax paid (PAYG instalment, annual income tax)
- Debit entries: franked dividends paid
- Benchmark franking rate compliance (for private companies)
- Franking deficit tax and over-franking tax triggers
- ATO franking account tax return (FATR) for some entity types

## Later queue (lower urgency)

| Item | Reason deferred |
|------|----------------|
| SMSF audit lodgement | Requires approved SMSF auditor registration — legal barrier |
| Annual income tax return (company/trust) | Needs full GL close + depreciation schedules |
| Division 7A loan compliance | Requires shareholder loan tracking module |
| Payroll tax (state) | Multi-jurisdiction, each state has its own lodgement portal |
| R&D tax incentive | Requires cost-centre tagging + DSSP registration |
