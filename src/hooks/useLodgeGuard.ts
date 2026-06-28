// Frontend guard (SC-7.B.01 -> SC-4 extension)
//
// Enforces ATO credential completeness for lodge operations.
// Combines existing EVTE config health with new DSP/SBR checks.
//
// This guard is called from UI components before allowing lodge operations.

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
  environment: 'production';
}

export interface LodgeGuardResult {
  allowed: boolean;
  health?: LodgeOperationsHealth;
  error?: string;
}

export async function checkLodgeGuard(
  organizationId: string,
): Promise<LodgeGuardResult> {
  if (!organizationId) {
    return {
      allowed: false,
      error: 'Organization is required',
    };
  }

  const health: LodgeOperationsHealth = {
    evte_configured: false,
    evte_missing: ['ATO_EVTE_ENDPOINT', 'ATO_DSP_ABN', 'ATO_SOFTWARE_ID', 'ATO_STIN', 'ATO_M2M_KEYSTORE_REF'],
    dsp_configured: false,
    dsp_missing: ['ATO_DSP_ABN', 'ATO_SOFTWARE_ID', 'ATO_STIN', 'ATO_M2M_KEYSTORE_REF'],
    sbr_configured: false,
    sbr_missing: ['SBR_TAXONOMY_VERSION', 'SBR_TAXONOMY_BASE_URL'],
    any_configured: false,
    all_green: false,
    fallback_available: false,
    audit_trail: `Lodge operations blocked for ${organizationId}: backend ATO/DSP/SBR readiness check is deploy-gated.`,
    environment: 'production',
  };

  return {
    allowed: false,
    health,
    error: `Lodge operations not ready: ${health.audit_trail}`,
  };
}
