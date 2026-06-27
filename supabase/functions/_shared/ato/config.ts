// ATO EVTE/DSP configuration scaffold (SC-7.B.01).
//
// This module declares the machine-credential and DSP identity settings the
// lodgement gateway will need later. It never logs or returns secret values.

export const ATO_REQUIRED_CONFIG = [
  "ATO_EVTE_ENDPOINT",
  "ATO_DSP_ABN",
  "ATO_SOFTWARE_ID",
  "ATO_STIN",
  "ATO_M2M_KEYSTORE_REF",
] as const;

export type AtoRequiredConfigName = typeof ATO_REQUIRED_CONFIG[number];

export interface AtoEvteConfig {
  evteEndpoint: string;
  dspAbn: string;
  softwareId: string;
  stin: string;
  m2mKeystoreRef: string;
}

export interface AtoConfigReadResult {
  configured: boolean;
  missing: AtoRequiredConfigName[];
  config: AtoEvteConfig | null;
}

export interface AtoConfigHealth {
  configured: boolean;
  missing: AtoRequiredConfigName[];
  required: readonly AtoRequiredConfigName[];
  environment: "evte";
}

export interface EnvReader {
  get(name: string): string | undefined | null;
}

function readTrimmed(
  env: EnvReader,
  name: AtoRequiredConfigName,
): string | null {
  const value = env.get(name)?.trim();
  return value && value.length > 0 ? value : null;
}

export function readAtoEvteConfig(
  env: EnvReader = Deno.env,
): AtoConfigReadResult {
  const values = new Map<AtoRequiredConfigName, string>();
  const missing: AtoRequiredConfigName[] = [];

  for (const name of ATO_REQUIRED_CONFIG) {
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
      evteEndpoint: values.get("ATO_EVTE_ENDPOINT")!,
      dspAbn: values.get("ATO_DSP_ABN")!,
      softwareId: values.get("ATO_SOFTWARE_ID")!,
      stin: values.get("ATO_STIN")!,
      m2mKeystoreRef: values.get("ATO_M2M_KEYSTORE_REF")!,
    },
  };
}

export function atoConfigHealth(env: EnvReader = Deno.env): AtoConfigHealth {
  const result = readAtoEvteConfig(env);
  return {
    configured: result.configured,
    missing: result.missing,
    required: ATO_REQUIRED_CONFIG,
    environment: "evte",
  };
}
