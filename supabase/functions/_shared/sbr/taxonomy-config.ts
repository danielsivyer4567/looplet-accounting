// SBR taxonomy gate for lodge operations (SC-7.G.02)
//
// This gate checks SBR (Standard Business Reporting) taxonomy assets availability
// required for working-papers bundle and smsf-audit-pack operations.
//
// DEPLOY-GATED: Requires SBR taxonomy files available in CDN/storage.
// This gate validates environment variables for taxonomy configuration.

export const SBR_REQUIRED_CONFIG = [
  "SBR_TAXONOMY_VERSION",
  "SBR_TAXONOMY_BASE_URL",
] as const;

export type SbrRequiredConfigName = typeof SBR_REQUIRED_CONFIG[number];

export interface SbrTaxonomyHealth {
  configured: boolean;
  missing: SbrRequiredConfigName[];
  required: readonly SbrRequiredConfigName[];
  environment: "sbr_taxonomy";
  fallback_available: boolean;
}

export interface EnvReader {
  get(name: string): string | undefined | null;
}

function readTrimmed(
  env: EnvReader,
  name: SbrRequiredConfigName,
): string | null {
  const value = env.get(name)?.trim();
  return value && value.length > 0 ? value : null;
}

function requiredValue(
  values: Map<SbrRequiredConfigName, string>,
  name: SbrRequiredConfigName,
): string {
  const value = values.get(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function readSbrTaxonomyConfig(env: EnvReader = Deno.env): {
  configured: boolean;
  missing: SbrRequiredConfigName[];
  config: {
    taxonomyVersion: string;
    taxonomyBaseUrl: string;
  } | null;
  fallbackAvailable: boolean;
} {
  const values = new Map<SbrRequiredConfigName, string>();
  const missing: SbrRequiredConfigName[] = [];

  for (const name of SBR_REQUIRED_CONFIG) {
    const value = readTrimmed(env, name);
    if (value) {
      values.set(name, value);
    } else {
      missing.push(name);
    }
  }

  // Check fallback configuration (bundled subset in Supabase functions)
  const fallbackAvailable = env.get("SBR_TAXONOMY_FALLBACK_ENABLED") === "true";

  if (missing.length > 0 && !fallbackAvailable) {
    return { configured: false, missing, config: null, fallbackAvailable };
  }

  return {
    configured: missing.length === 0,
    missing,
    config: missing.length === 0 ? {
      taxonomyVersion: requiredValue(values, "SBR_TAXONOMY_VERSION"),
      taxonomyBaseUrl: requiredValue(values, "SBR_TAXONOMY_BASE_URL"),
    } : null,
    fallbackAvailable,
  };
}

export function sbrTaxonomyHealth(env: EnvReader = Deno.env): SbrTaxonomyHealth {
  const result = readSbrTaxonomyConfig(env);
  return {
    configured: result.configured,
    missing: result.missing,
    required: SBR_REQUIRED_CONFIG,
    environment: "sbr_taxonomy",
    fallback_available: result.fallbackAvailable,
  };
}
