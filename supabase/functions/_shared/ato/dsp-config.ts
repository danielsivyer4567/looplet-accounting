// DSP credential gate (SC-7.E.00)
//
// This gate checks ATO DSP (Digital Service Provider) credentials required for lodge operations.
// Copied from the existing SC-7.B.01 pattern but expanded to cover DSP-specific DSP requirements.
//
// DEPLOY-GATED: Requires ATO DSP certificates provisioned in Supabase Vault / Edge Function secrets.
// This gate does not fetch or consume secrets; it only validates environment variable presence.

export const DSP_REQUIRED_CONFIG = [
  "ATO_DSP_ABN",
  "ATO_SOFTWARE_ID",
  "ATO_STIN", 
  "ATO_M2M_KEYSTORE_REF",
] as const;

export type DspRequiredConfigName = typeof DSP_REQUIRED_CONFIG[number];

export interface DspConfigHealth {
  configured: boolean;
  missing: DspRequiredConfigName[];
  required: readonly DspRequiredConfigName[];
  environment: "dsp";
}

export interface EnvReader {
  get(name: string): string | undefined | null;
}

function readTrimmed(
  env: EnvReader,
  name: DspRequiredConfigName,
): string | null {
  const value = env.get(name)?.trim();
  return value && value.length > 0 ? value : null;
}

function requiredValue(
  values: Map<DspRequiredConfigName, string>,
  name: DspRequiredConfigName,
): string {
  const value = values.get(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function readDspConfig(env: EnvReader = Deno.env): {
  configured: boolean;
  missing: DspRequiredConfigName[];
  config: {
    dspAbn: string;
    softwareId: string;
    stin: string;
    m2mKeystoreRef: string;
  } | null;
} {
  const values = new Map<DspRequiredConfigName, string>();
  const missing: DspRequiredConfigName[] = [];

  for (const name of DSP_REQUIRED_CONFIG) {
    const value = readTrimmed(env, name);
    if (value) {
      values.set(name, value);
    } else {
      missing.push(name);
    }
  }

  if (missing.length > 0) {
    return { configured: false, missing, config: null };
  }

  return {
    configured: true,
    missing: [],
    config: {
      dspAbn: requiredValue(values, "ATO_DSP_ABN"),
      softwareId: requiredValue(values, "ATO_SOFTWARE_ID"),
      stin: requiredValue(values, "ATO_STIN"),
      m2mKeystoreRef: requiredValue(values, "ATO_M2M_KEYSTORE_REF"),
    },
  };
}

export function dspConfigHealth(env: EnvReader = Deno.env): DspConfigHealth {
  const result = readDspConfig(env);
  return {
    configured: result.configured,
    missing: result.missing,
    required: DSP_REQUIRED_CONFIG,
    environment: "dsp",
  };
}
