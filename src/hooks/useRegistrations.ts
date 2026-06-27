import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';

// The slice of business_profile (live schema, verified) the registration payload maps from.
export interface RegistrationProfile {
  entity_type: string | null;
  industry_code: string | null;
  industry_label: string | null;
  state_code: string | null;
  is_gst_registered: boolean | null;
  is_fbt_registered: boolean | null;
  is_paygi_registered: boolean | null;
  is_paygw_registered: boolean | null;
  estimated_annual_turnover_cents: number | null;
  employees_count: number | null;
}

// The four ATO/ABR registrations the wizard prepares. ABN is the base registration; the rest
// are roles added to it. Each line says whether the business is already registered (from the
// profile) and therefore whether it needs action.
export type RegistrationType = 'ABN' | 'GST' | 'PAYGW' | 'PAYGI' | 'FBT';

export interface RegistrationLine {
  type: RegistrationType;
  label: string;
  /** Already registered for this per the business profile. */
  registered: boolean;
  /** Whether v1 recommends registering now (a simple, transparent rule per type). */
  recommended: boolean;
  /** One line explaining the registered/recommended state. */
  reason: string;
}

export interface RegistrationPayload {
  entity_type: string | null;
  state_code: string | null;
  industry_code: string | null;
  industry_label: string | null;
  estimated_annual_turnover_cents: number | null;
  lines: RegistrationLine[];
}

// GST is compulsory once annual turnover reaches $75,000 (7,500,000 cents). Below that it's
// optional; we only *recommend* it when the threshold is met (and the business isn't already
// registered). A transparent, auditable rule — not tax advice.
export const GST_THRESHOLD_CENTS = 7_500_000;

/**
 * Build the ABN/GST/PAYG-W/PAYG-I/FBT registration payload from a business profile. PURE — no
 * I/O, fully unit-testable (SC-5.O.01 asserts this mapping). Each line maps a profile field to a
 * registered flag + a simple recommendation rule:
 *   ABN   — the base registration; assumed required for any operating entity.
 *   GST   — required at/above the $75k turnover threshold; recommend if at threshold & not registered.
 *   PAYGW — required once the business has employees; recommend if employees_count > 0 & not registered.
 *   PAYGI — instalments are ATO-initiated; we don't auto-recommend, only surface the current state.
 *   FBT   — recommend only when already flagged (fringe-benefit provision isn't derivable here).
 */
export function buildRegistrationPayload(p: RegistrationProfile): RegistrationPayload {
  const turnover = p.estimated_annual_turnover_cents ?? 0;
  const employees = p.employees_count ?? 0;
  const meetsGstThreshold = turnover >= GST_THRESHOLD_CENTS;
  const hasEmployees = employees > 0;

  const lines: RegistrationLine[] = [
    {
      type: 'ABN',
      label: 'Australian Business Number (ABN)',
      registered: false,
      recommended: true,
      reason: 'The base registration for an operating entity; required before adding GST/PAYG/FBT roles.',
    },
    {
      type: 'GST',
      label: 'Goods & Services Tax (GST)',
      registered: !!p.is_gst_registered,
      recommended: !p.is_gst_registered && meetsGstThreshold,
      reason: p.is_gst_registered
        ? 'Already registered for GST.'
        : meetsGstThreshold
          ? 'Turnover is at or above the $75,000 GST threshold — registration is required.'
          : 'Turnover is below the $75,000 threshold — GST registration is optional.',
    },
    {
      type: 'PAYGW',
      label: 'PAYG withholding',
      registered: !!p.is_paygw_registered,
      recommended: !p.is_paygw_registered && hasEmployees,
      reason: p.is_paygw_registered
        ? 'Already registered for PAYG withholding.'
        : hasEmployees
          ? 'The business has employees — PAYG withholding registration is required.'
          : 'No employees recorded — PAYG withholding is not required yet.',
    },
    {
      type: 'PAYGI',
      label: 'PAYG instalments',
      registered: !!p.is_paygi_registered,
      // Instalments are entered into by the ATO based on prior-year tax; we surface, not recommend.
      recommended: false,
      reason: p.is_paygi_registered
        ? 'Already in the PAYG instalments system.'
        : 'PAYG instalments are initiated by the ATO based on your prior-year tax position.',
    },
    {
      type: 'FBT',
      label: 'Fringe Benefits Tax (FBT)',
      registered: !!p.is_fbt_registered,
      // Whether fringe benefits are provided isn't derivable from the profile, so we don't push it.
      recommended: false,
      reason: p.is_fbt_registered
        ? 'Already registered for FBT.'
        : 'Register for FBT if the business provides fringe benefits to employees (e.g. a work vehicle for private use).',
    },
  ];

  return {
    entity_type: p.entity_type,
    state_code: p.state_code,
    industry_code: p.industry_code,
    industry_label: p.industry_label,
    estimated_annual_turnover_cents: p.estimated_annual_turnover_cents,
    lines,
  };
}

/** The Australian Business Register "register for an ABN" entry point (the v1 deep link). */
export const ABR_REGISTER_URL = 'https://www.abr.gov.au/business-super-funds-charities/applying-abn';

/**
 * Loads the org's business profile and exposes the prepared registration payload + the ABR deep
 * link. RLS-scoped to the caller. v1 prepares the payload + deep link only — real submission via
 * the ABR/ATO channel is deferred to Phase 7 (SC-7.B). Mirrors the org-scoped fetch +
 * loading/error/refresh shape of useTrusts/useSmsf.
 */
export function useRegistrations() {
  const { currentOrg } = useOrg();
  const [payload, setPayload] = useState<RegistrationPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!currentOrg) {
      setPayload(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);

    const { data, error: profErr } = await supabase
      .from('business_profile')
      .select(
        'entity_type, industry_code, industry_label, state_code, is_gst_registered, is_fbt_registered, is_paygi_registered, is_paygw_registered, estimated_annual_turnover_cents, employees_count',
      )
      .eq('organization_id', currentOrg.id)
      .maybeSingle();

    if (profErr) {
      setError(profErr.message);
      setPayload(null);
      setLoading(false);
      return;
    }

    setPayload(buildRegistrationPayload((data ?? {}) as RegistrationProfile));
    setLoading(false);
  }, [currentOrg]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { payload, loading, error, refresh, abrRegisterUrl: ABR_REGISTER_URL };
}
