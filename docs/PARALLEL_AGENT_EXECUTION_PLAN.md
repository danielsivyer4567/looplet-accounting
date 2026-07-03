# Parallel Agent Execution Plan

Created: 2026-06-29

## Constraint Observed

The requested target is 50 parallel agents. The current sub-agent runtime accepted 6 active agents and rejected the 7th spawn with `agent thread limit reached`.

Therefore the safe execution model is:

- Maintain the 50-agent decomposition.
- Run agents in waves of up to 6 active agents.
- Keep every agent on a unique ownership lane.
- First wave is read-only audit/planning plus unique scratch output files.
- Later implementation waves use smaller write-scoped batches of 4 to 8 tasks, depending on overlap risk.

This still gives the desired 50-agent plan, but respects the actual tool limit instead of pretending 50 simultaneous threads are available.

## Current Runtime State

Updated: 2026-06-29 after audit completion

- Completed scratch outputs: Agents 01 through 50.
- Active/queued audit lanes: none.
- The runtime cap remains useful operational context, but the read-only audit wave is finished.
- Implementation promotion now lives in `docs/IMPLEMENTATION_QUEUE.md`, which converts audit findings into write-scoped tasks with file ownership, dependencies, tests, live proof, and rollback notes.

## Wave 1 - Ledger, Deploy, Cron, Gmail

Completed scratch outputs:

- Agent 01: ledger reconciliation and incomplete ledgers.
- Agent 02: live deploy blockers for accountant/tag-drop.
- Agent 03: Supabase migration drift and pending migrations.
- Agent 04: edge function deployment inventory.
- Agent 05: cron and heartbeat reliability.
- Agent 06: Gmail reconnect and Pub/Sub proof.

Each agent may write only its own scratch file:

- `.claude/scratch/parallel-roadmap/agent-01.md`
- `.claude/scratch/parallel-roadmap/agent-02.md`
- `.claude/scratch/parallel-roadmap/agent-03.md`
- `.claude/scratch/parallel-roadmap/agent-04.md`
- `.claude/scratch/parallel-roadmap/agent-05.md`
- `.claude/scratch/parallel-roadmap/agent-06.md`

Key findings now promoted into `APP_COMPLETION_ROADMAP.md`:

- Live schema is in parity through migration `0198`; `0199`-`0201` remain pending.
- Pending invite memberships can grant access before acceptance unless access helpers and org selection filter accepted membership state.
- The tag draft `onConflict` path needs a matching unique constraint.
- Cron health needs no-success-window monitoring, not only recent HTTP failure checks.
- Gmail reconnect/disconnect handling needs real watched-mailbox proof and centralized fatal token-state notification.
- Function deployment inventory needs reconciliation before final release.

## Wave 2 - External Money And Data Quality

- Agent 07: Xero retry/backfill.
- Agent 08: Basiq/bank feed.
- Agent 09: auto-reconciliation.
- Agent 10: OCR provider and bill extraction.
- Agent 11: GST coverage and BAS readiness.
- Agent 12: double-entry schema.

Status:

- Completed scratch outputs: Agents 07 through 12.
- Every Wave 2 agent wrote only `.claude/scratch/parallel-roadmap/agent-XX.md`.

## Wave 3 - Accounting Engine

- Agent 13: posting rules.
- Agent 14: reporting migration.
- Agent 15: BAS compliance.
- Agent 16: payroll/STP.
- Agent 17: SuperStream/super payments.
- Agent 18: fixed assets/depreciation.

Status:

- Completed scratch outputs: Agents 13 through 18.
- Agent 13 depends on Agent 12's canonical posting primitives and is not ready for implementation until those are scoped.

## Wave 4 - Compliance And Controls

- Agent 19: credit notes/adjustments.
- Agent 20: period locks.
- Agent 21: connector API gateway.
- Agent 22: ingest endpoint handlers.
- Agent 23: API key UI.
- Agent 24: OpenAPI/docs.

Status:

- Completed scratch outputs: Agents 19 through 24.

## Wave 5 - Security And Integrity

- Agent 25: webhook HMAC/replay.
- Agent 26: audit logging.
- Agent 27: SECURITY DEFINER hardening.
- Agent 28: FK indexes/performance DB.
- Agent 29: tenant isolation/CI.
- Agent 30: accounting test suite.

Status:

- Completed scratch outputs: Agents 25 through 30.

## Wave 6 - Core Product UX

- Agent 31: bills UX.
- Agent 32: invoices UX.
- Agent 33: reconciliation UX.
- Agent 34: dashboard/home UX.
- Agent 35: accountant portal UX.
- Agent 36: tag-drop UX.

Status: completed scratch outputs, Agents 31 through 36.

## Wave 7 - Supporting UX And Platform

- Agent 37: notifications UX.
- Agent 38: settings/onboarding UX.
- Agent 39: legal horizon/RAG UX and backend.
- Agent 40: Receipt Hub/POS.
- Agent 41: accessibility.
- Agent 42: mobile/responsive.

Status: completed scratch outputs, Agents 37 through 42.

## Wave 8 - Release Readiness

- Agent 43: performance/bundle splitting.
- Agent 44: error handling and observability.
- Agent 45: data model documentation.
- Agent 46: user-facing docs/runbooks.
- Agent 47: deployment/rollback process.
- Agent 48: security/product threat model.

Status: completed scratch outputs, Agents 43 through 48.

## Wave 9 - Final Acceptance

- Agent 49: demo/sample data and QA scripts.
- Agent 50: final polish and acceptance criteria.

Status: completed scratch outputs, Agents 49 through 50.

## Promotion From Audit To Implementation

Audit outputs are promoted to implementation only after the main thread consolidates:

1. Objective.
2. Files owned.
3. Dependencies.
4. Tests required.
5. Live proof required.
6. Rollback plan.

No implementation worker may edit outside its declared file scope without stopping and reporting the conflict. The first promoted queue is in `docs/IMPLEMENTATION_QUEUE.md`.
