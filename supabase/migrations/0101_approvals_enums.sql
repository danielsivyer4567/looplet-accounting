-- 0101: Approval guardrail enums — risk tier + resolution status.
--
-- Phase 2.A foundation (SC-2.A.01). Two enums that the approvals table (SC-2.A.02)
-- and the request_approval / approve / reject / is_action_approved RPCs (SC-2.B)
-- type their columns against. Atomic prerequisite, kept tiny so the table slice has
-- clean type deps and the build stays green at every step.
--
--   * approval_risk_tier — how much human gating an action needs before it acts:
--       tier0_silent  — auto-approved, no human in the loop (e.g. the ≥0.9 coding
--                       auto-post path); request_approval resolves it immediately.
--       tier1_notify  — proceeds, but a human is notified after the fact.
--       tier2_approve — MUST have a matching 'approved' row before the money-mover /
--                       lodgement acts. This is the gate every Phase 3/7 action reads
--                       through is_action_approved() (SC-2.B.03).
--
--   * approval_status — the resolution state of an approvals row:
--       pending   — awaiting a human decision (the initial tier2_approve state).
--       approved  — resolved yes; the bound action may proceed.
--       rejected  — resolved no.
--       expired   — timed out without resolution (set by a future sweep, declared
--                   up front to avoid a later ALTER TYPE — same discipline as 0093).
--
-- Convention: CREATE TYPE ... AS ENUM in public, mirroring org_role in
-- 0039_audit_log_and_rbac.sql; wrapped in the idempotent duplicate_object guard
-- used by 0093_fixed_assets.sql so re-running the migration is a no-op.

DO $$ BEGIN
  CREATE TYPE public.approval_risk_tier AS ENUM (
    'tier0_silent',   -- auto-approved, no human gate
    'tier1_notify',   -- proceeds; human notified after the fact
    'tier2_approve'   -- requires an 'approved' row before the action runs
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.approval_status AS ENUM (
    'pending',   -- awaiting human decision (initial tier2_approve state)
    'approved',  -- resolved yes; bound action may proceed
    'rejected',  -- resolved no
    'expired'    -- timed out unresolved
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
