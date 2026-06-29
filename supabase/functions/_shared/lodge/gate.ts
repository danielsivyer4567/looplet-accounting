// Fail-closed lodge gate (SC-DEPLOY-04)
//
// One place that turns the SC-7.E.00 lodge operations health into a uniform
// FORBIDDEN decision for every action entry point that would otherwise touch a
// lodge/transport/taxonomy path. The action functions call requireLodgeReady()
// (or requireSbrReady() for taxonomy-only paths) and short-circuit with a 403
// before any outward step.
//
// DEPLOY-GATED for verification only: the env-var presence checks run locally,
// but the live "returns FORBIDDEN when secrets absent" smoke ride rides the
// deploy (see ledger SC-DEPLOY-04 / SC-DEPLOY-01).
//
// No secret values are read or returned here — only presence/absence and the
// names of what is missing, so the block decision is auditable without leaking.

import { lodgeOperationsHealth } from "./operations-health.ts";
import { sbrTaxonomyHealth } from "../sbr/taxonomy-config.ts";
import { type EnvReader } from "../ato/config.ts";

export interface LodgeGateBlock {
  ok: false;
  error: "FORBIDDEN";
  block_reason: string;
  // The names of the missing config items, grouped by gate, so a smoke test /
  // compliance trail can see *what* is unconfigured without exposing values.
  missing: {
    evte?: string[];
    dsp?: string[];
    sbr?: string[];
  };
  // Stable marker the SC-DEPLOY-01 smoke test asserts on, and that the caller
  // logs as the audit entry for a blocked lodge attempt.
  blocked_action: string;
}

/**
 * Gate a full lodge/transport action (needs EVTE + DSP + SBR all green).
 * Returns a LodgeGateBlock to return verbatim as 403 when not ready, else null.
 */
export function requireLodgeReady(
  blockedAction: string,
  env: EnvReader = Deno.env,
): LodgeGateBlock | null {
  const health = lodgeOperationsHealth(env);
  if (health.all_green) return null;

  return {
    ok: false,
    error: "FORBIDDEN",
    block_reason: health.audit_trail,
    missing: {
      ...(health.evte_missing.length ? { evte: health.evte_missing } : {}),
      ...(health.dsp_missing.length ? { dsp: health.dsp_missing } : {}),
      ...(health.sbr_missing.length ? { sbr: health.sbr_missing } : {}),
    },
    blocked_action: blockedAction,
  };
}

/**
 * Gate a taxonomy-dependent bundle action (needs SBR taxonomy, or its bundled
 * fallback). Used by working-papers / smsf-audit-pack, which do not transport to
 * the ATO but must not emit a bundle against an unconfigured taxonomy.
 */
export function requireSbrReady(
  blockedAction: string,
  env: EnvReader = Deno.env,
): LodgeGateBlock | null {
  const sbr = sbrTaxonomyHealth(env);
  if (sbr.configured || sbr.fallback_available) return null;

  return {
    ok: false,
    error: "FORBIDDEN",
    block_reason: `Bundle blocked - SBR taxonomy unavailable: ${
      sbr.missing.join(", ")
    }`,
    missing: { sbr: sbr.missing },
    blocked_action: blockedAction,
  };
}
