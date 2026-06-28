// Combined lodge operations health gate (SC-4)
//
// Aggregate gate combining all three conditions:
// 1. EVTE/DSP credentials (ATO gateway health)
// 2. DSP configuration (ATO DSP-specific)
// 3. SBR taxonomy availability
//
// DEPLOY-GATED: All three components require deploy-time verification.
// This gate provides aggregate status for feature flags and routing decisions.

import { atoConfigHealth, type EnvReader } from "../ato/config.ts";
import { dspConfigHealth } from "../ato/dsp-config.ts";
import { sbrTaxonomyHealth } from "../sbr/taxonomy-config.ts";

export interface LodgeOperationsHealth {
  evte_configured: boolean;
  evte_missing: string[];
  dsp_configured: boolean;
  dsp_missing: string[];
  sbr_configured: boolean;
  sbr_missing: string[];
  any_configured: boolean;
  all_green: boolean;
  fallback_available: boolean;
  audit_trail: string;
  environment: "production";
}

export function lodgeOperationsHealth(
  env: EnvReader = Deno.env,
): LodgeOperationsHealth {
  const evte = atoConfigHealth(env);
  const dsp = dspConfigHealth(env);
  const sbr = sbrTaxonomyHealth(env);

  const anyConfigured = evte.configured || dsp.configured || sbr.configured;
  const allGreen = evte.configured && dsp.configured && sbr.configured;

  // Build audit trail message
  const missingItems: string[] = [];
  if (evte.missing?.length) missingItems.push(`EVTE: ${evte.missing.join(", ")}`);
  if (dsp.missing?.length) missingItems.push(`DSP: ${dsp.missing.join(", ")}`);
  if (sbr.missing?.length) missingItems.push(`SBR: ${sbr.missing.join(", ")}`);

  const auditTrail = missingItems.length
    ? `Lodge blocked - missing: ${missingItems.join("; ")}`
    : "Lodge operations permitted - all gates configured";

  return {
    evte_configured: evte.configured,
    evte_missing: evte.missing,
    dsp_configured: dsp.configured,
    dsp_missing: dsp.missing,
    sbr_configured: sbr.configured,
    sbr_missing: sbr.missing,
    any_configured: anyConfigured,
    all_green: allGreen,
    fallback_available: sbr.fallback_available,
    audit_trail: auditTrail,
    environment: "production",
  };
}
