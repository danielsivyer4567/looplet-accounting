# Automate-the-Accountant — Coverage Gap Analysis (AU)

> Generated 2026-06-25 by a web-backed multi-agent audit: 14 domain researchers
> (ATO / TPB / state revenue offices / ASIC) enumerated what a full-service
> Australian accountant + tax agent + BAS agent actually does, mapped against the
> 7-phase build plan in `.claude/scratch/ledger.md`. This is a strategic
> completeness check, not a code review.

## Honest verdict

**No — even fully built, this plan automates _preparation and calculation_, not
_professional judgement or legal authority_.** And today it automates almost none
of it yet: only Phase 1.A/1.B (books-health score + UI) and one table
(`coding_suggestions`) are built; everything else — BAS worksheet, every tax
return, FBT, CGT, trusts, SMSF, super lodgement, the approval gate, the whole
DSP/SBR lodgement spine — is unbuilt design.

What the plan **scopes** is genuinely strong and unusually self-aware: it treats
ATO lodgement as DSP-certification-gated, builds a hash-bound Tier-2 approval
guard before any money-mover, models a registered-agent sign-off field, and
_stubs rather than fakes_ what it can't yet do. The architecture mirrors a real
firm: continuous books → reconciliation → prep → human/agent sign-off → lodge.

But the highest-value, highest-liability accountant work is irreducibly human and
the plan correctly cannot do it: capital-vs-revenue characterisation,
contractor-vs-employee / payroll-tax "relevant contract" analysis, s100A and
Part IVA anti-avoidance, Div 152 small-business-CGT qualification, trust-deed
interpretation, deductibility/substantiation judgement, loss continuity,
residency, entity grouping, award interpretation. And "lodge for a fee" is legally
walled off behind **TPB registration** and the **SBR/DSP Operational Security
Framework** audit.

**Defensible framing: the best _prep-and-approve engine_ for an AU SME, with a
registered agent in the loop. It cannot _be_ the agent.**

## Coverage matrix

| Accountant duty/domain | Covered? | Where / gap note |
|---|---|---|
| Bookkeeping / transaction coding & auto-post | Partial | Phase 1.C/1.D classifier + review queue (in-progress) |
| Bank/card/clearing reconciliation (to statement balance) | Partial | auto-reconcile exists; true statement-balance recon, merchant settlement (gross-vs-fee), suspense clearing not detailed |
| Chart of accounts design + GST tax-code mapping | Partial | 3.A adds expected-treatment; COA design itself is human |
| Fixed-asset register + depreciation (prime-cost/DV, pooling, IAWO) | Yes (planned) | Phase 1.E–1.H |
| Accruals / prepayments | Yes (planned) | Phase 1.I |
| Period-close + lock | Yes (planned) | Phase 1.J/1.K, gated by books-health |
| Books-health / data-quality score | **Yes (built)** | Phase 1.A/1.B |
| Trading stock / inventory valuation & stocktake | **No** | Not in any phase |
| Work-in-progress / unbilled revenue | **No** | Not addressed |
| Foreign-currency txns + period-end FX revaluation | **No** | Not addressed |
| Approval / guardrail layer (Tier-2, hash-bound) | Yes (planned) | Phase 2 — strong design |
| GST treatment validation + reconciliation to GL control | Yes (planned) | Phase 3.A/3.B |
| BAS worksheet (G1/1A/1B/W1/W2/T7/5A-5B) + PDF + guided prep | Yes (planned) | Phase 3.C–3.E. Gaps: G2/G3, FTC (7C/7D), WET, LCT absent |
| GST error correction / revised BAS | **No** | Agent judgement |
| IAS (PAYGW/PAYGI-only months) | Partial | components exist; distinct IAS flow not named |
| PAYG instalments — Option 1 vs 2, variation, GIC risk | Partial | T7 label only; method choice/variation not built |
| Payroll pay runs (gross, PAYGW, leave, allowances, sal-sac) | Partial | exists in repo; STP2 disaggregation/allowance codes not confirmed |
| STP Phase 2 lodgement + EOFY finalisation (14 Jul) | Partial | export-stp exists; real SBR lodgement deferred to 7.D.02 |
| Super guarantee calc + SuperStream batch | Partial | 3.F–3.H; **no fund USI/member-number**; clearing-house send is a stub |
| SG charge (SGC) statement for late super | **No** | Distinct BAS-agent service, DPN exposure |
| Payday Super readiness (from 1 Jul 2026) | **No** | Imminent regime change during the build window |
| Payroll tax (thresholds, grouping, annual recon, contractor analysis) | Partial | accrual + obligations only; grouping/DGE, relevant-contract, recon missing |
| WorkCover declaration of wages (per state) | Partial | QLD first; wage-definition differs, not reconciled |
| Award/EBA interpretation + underpayment | Partial (assist-only) | Phase 3.K — deliberately assist-only |
| Termination / ETP / redundancy / LSL | Yes (planned) | Phase 3.L |
| TPAR (building/cleaning/courier/IT/security) | **No (flagged)** | 7.D.03 adapter is fixture-only; no upstream generator |
| Income tax return — company | Yes (planned) | Phase 4.G |
| Income tax return — sole trader / partnership / trust | Yes (planned) | Phase 4.G (trust optimisation in Phase 5) |
| Income tax return — individual (non-business) | **No** | `entity_type` has no 'individual'; highest-volume return type |
| Book-to-tax reconciliation + offsets/credits | Yes (planned) | Phase 4.H |
| Work-related deductions / substantiation / WFH / car | **No** | No individual-deduction engine |
| Rental property schedules (Div 40/43, 6-yr rule, repairs vs capital) | **No** | Not in any phase |
| PSI rules (results test, 80%, PSB) | **No** | Not addressed |
| CGT — events, cost base, 50% discount, loss ordering | Yes (planned) | Phase 4.D/4.E |
| CGT small-business concessions (Div 152) | Yes (planned) | Phase 4.F (deep MNAV/active-asset analysis is human) |
| CGT main-residence exemption / FRCGW / scrip-for-scrip | **No** | High-frequency real-world items |
| Company tax-rate eligibility (BRE / 80% passive) | Partial | rate tables implied; BREPI + grouping is human |
| Franking account / imputation / Franking Account Tax Return | **No** | Material company gap; blocks profit-extraction advice |
| R&D Tax Incentive | **No** | Not addressed |
| Tax losses — COT/BCT continuity, loss carry-back | **No** | Not built |
| Trust net income (s95) + Bamford proportionate | Yes (planned) | Phase 5.B |
| Trust distribution resolution by 30 Jun + streaming + minute | Yes (planned) | Phase 5.C/5.D |
| s100A reimbursement-agreement risk (TR 2022/4) | **No** | Major ATO focus, irreducibly human |
| FTE/IEE + Family Trust Distribution Tax | **No** | FTE/IEE tables exist; FTDT detection not built |
| Division 7A loans / UPE / MYR / agreements | Yes (planned) | Phase 5.E/5.F |
| SMSF accounting, member balances, caps, TBC/TBAR | Yes (planned) | Phase 5.H–5.L |
| SMSF financials + annual return (SAR) draft | Yes (planned) | Phase 5.J/5.K |
| SMSF independent audit (Part A/B, IAR, ACR) | **No (by law)** | 5.M = audit PACK only; auditor is external |
| SMSF ECPI / actuarial certificate | **No** | External actuary |
| FBT — identify, value, gross-up, return, RFBA | **No (flagged)** | Only advisory + instalment; **no FBT-return generator** |
| Registrations (ABN/GST/PAYG/FBT) | Partial | 5.O pre-fill; real submission deferred to Phase 7 |
| ASIC company secretarial (Form 484, annual review, Director ID) | Partial | tables + draft; actual lodgement/fee not wired |
| ASIC financial reports (Form 388) + solvency resolution | **No** | Not addressed |
| Tax planning / advisory (structuring, year-end, vCFO) | Yes (planned) | Phase 6, with sign-off field |
| Fuel tax credits | **No** | Named but never scheduled into a phase |
| DSP/SBR/ebMS3 lodgement (BAS/STP/return/TBAR) | Partial (stubbed) | Phase 7.B–7.D, gated on DSP registration + OSF audit |
| Working papers / audit file (APES 320) | Yes (planned) | Phase 7.G |
| ATO correspondence / objections / amendments | Partial (assist-only) | Phase 7.H drafts, approve-to-send |
| ATO audit representation, payment plans, DPN/GIC remission | **No (by law)** | Registered-agent advocacy + judgement |
| Engagement letters / onboarding / POI / KYC / AML | **No** | Practice-management layer absent |
| TPB registration, PII, CPE, Code of Conduct | **No (by law)** | Cannot be discharged by software |
| Orchestrator: right engine at right time | Yes (planned) | Phase 7.I |

## Top gaps to close (mechanical — within software's reach, but block a complete compliance year)

1. **FBT return generation** — only advisory + an instalment exist; the Phase-7 FBT adapter runs on a fixture. Nearly every employer-client triggers FBT (cars, entertainment, loans, RFBA → STP). Without a generator there is no complete compliance year.
2. **Franking account + Franking Account Tax Return** — for any dividend-paying company this is core (franking ledger, benchmark rule, max-franking %, FDT). Also the substrate for Phase-6 profit-extraction advice.
3. **Individual (non-business) tax return path** — `entity_type` has no 'individual'; no work-related-deduction/rental/PSI engine. Highest-volume return type in Australia; its absence means you serve the entity, never the people behind it.
4. **The lodgement spine is DSP-gated and unbuilt** — every "lodge" is a mark-lodged stub until ATO DSP registration + OSF audit (months-to-years, external). Until then the product prepares but cannot transmit.
5. **SuperStream incomplete** — `employees` has no fund USI / member-number / ESA; clearing-house send is a stub. Super can be batched, not paid.
6. **Anti-avoidance / characterisation judgement out of scope** — s100A, Part IVA, wash sales, capital-vs-revenue, contractor-vs-employee. Exactly where the ATO scrutinises and the accountant earns the fee.
7. **Payroll tax + WorkCover are shallow** — no grouping/DGE, no relevant-contract/deemed-worker analysis, no annual reconciliation, and the three wage definitions (payroll-tax vs WorkCover vs PAYGW gross) differ.
8. **TPAR has no upstream generator** (adapter is fixture-only) — required for building/cleaning/courier/IT/security clients.
9. **SGC statement for late/missed super** — distinct BAS-agent service with DPN exposure; far more frequent once Payday Super lands.
10. **Practice/regulatory layer absent** — engagement letters, client-to-agent linking, POI/KYC, AML, ASIC annual review/solvency/Form 388.

## Hard limits (software legally/professionally cannot cross)

- **Lodging for a fee** requires **TPB registration** (Tax Agent Services Act 2009). The lodgement always occurs under a registered agent's or the taxpayer's own credential. The product can never _be_ the agent.
- **Transmitting to the ATO at all** requires being (or routing through) a registered **DSP** that has passed the **OSF** audit and SBR/ebMS3 certification — an external, multi-month-to-year gate.
- **SMSF independent audit** (Part A/B, IAR, ACR) must be by an ASIC-registered SMSF auditor independent of the preparer (APES 110). Software can assemble the pack, not sign the audit.
- **SMSF actuarial certificate** (proportionate-method ECPI) must come from an actuary.
- **Client-to-agent linking / agent nomination** is a deliberate client-side human action.
- **POI / client verification, TPB annual declaration, OSF attestation, PII/CPE currency** are human/registered-agent acts.
- The **lodgement declaration ("true and correct")** and signed client authority require an authorised human each time.
- **ATO audit representation, objections, amendments, private rulings, penalty/GIC remission, payment plans, DPN responses** are advocacy + judgement under agent authority.
- **Professional judgement that must not be faked:** capital-vs-revenue, deductibility/substantiation sufficiency, contractor-vs-employee + relevant-contract, entity grouping/aggregated-turnover, loss continuity, Div 152 active-asset/MNAV, trust-deed interpretation, s100A/Part IVA, award/EBA interpretation.
- **Personal financial-product / super-strategy advice** generally requires an **AFSL**, not tax-agent registration — much SMSF/contribution-strategy advice crosses that line.
- **ASIC company-secretarial acts** (solvency resolution, Form 388 audited reports) require director resolutions and, where applicable, a registered company auditor.

## Recommendations

- **Position honestly** as a "prep-and-approve engine for AU SMEs with a registered agent in the loop." The plan's stub-don't-fake discipline and `registered_agent_signoff` fields already support this. Ship the **"customer's existing agent"** model first; Looplet's own TPB + DSP registration is a separate, long, capital-intensive track to scope explicitly — not assume.
- **Close the calculation gaps before chasing autonomy** (they're mechanical and block a complete year): (1) FBT-return generation [also un-stubs the FBT adapter + feeds payroll-tax/WorkCover true-ups]; (2) Franking account + FATR into Phase 4; (3) TPAR generator upstream of 7.D.03; (4) SGC-statement generator; (5) individual return + deduction/rental/PSI engine — or explicitly scope individuals out so users aren't misled.
- **Treat Payday Super (1 Jul 2026) + the USI gap as a near-term blocker**, not a Phase-3 nicety: add fund USI/member-number/ESA columns and per-pay super timing now, since the quarterly regime is being replaced mid-build.
- **Re-frame every human-judgement / agent-only item as an explicit "assist + escalate-to-agent" surface** (s100A/Part IVA flags, contractor-vs-employee prompts, payroll-tax grouping, Div 152, deductibility review) so the product never appears to make a call it legally cannot.
- **Add a practice/regulatory layer** (engagement letters, POI/KYC, client-to-agent linking, ASIC annual review + solvency resolution, lodgement-declaration capture) — without it the product can't operate inside a real firm even as a prep tool, and these are mostly workflow, not judgement.
