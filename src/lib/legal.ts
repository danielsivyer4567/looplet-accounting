/**
 * Versions of the published legal documents and the acceptance record kept on the user's account
 * (Supabase auth user metadata, `legal_acceptance`). Bump a version when its document changes; the
 * record says which version the person accepted and when.
 *
 * The documents are drafts until Looplet's legal reviewer approves them (LEGAL-01).
 */
export const LEGAL_VERSIONS = {
  terms: '2026-10-03-draft',
  privacy: '2026-10-03-draft',
  collectionNotice: '2026-10-03-draft',
} as const;

export const LEGAL_PATHS = {
  privacy: '/privacy',
  terms: '/terms',
  collectionNotice: '/collection-notice',
} as const;

export const SUPPORT_EMAIL = 'support@looplet.com.au';

export type LegalAcceptanceMethod = 'signup_checkbox' | 'google_continue';

/**
 * Set in sessionStorage when someone clicks "Continue with Google" under the legal notice. The
 * Google round trip returns to the same tab, and AuthProvider then records the acceptance.
 */
export const PENDING_GOOGLE_ACCEPTANCE_KEY = 'looplet_pending_legal_acceptance';

export interface LegalAcceptance {
  terms_version: string;
  privacy_version: string;
  collection_notice_version: string;
  accepted_at: string;
  method: LegalAcceptanceMethod;
}

export function legalAcceptanceRecord(
  method: LegalAcceptanceMethod,
  now: Date = new Date(),
): { legal_acceptance: LegalAcceptance } {
  return {
    legal_acceptance: {
      terms_version: LEGAL_VERSIONS.terms,
      privacy_version: LEGAL_VERSIONS.privacy,
      collection_notice_version: LEGAL_VERSIONS.collectionNotice,
      accepted_at: now.toISOString(),
      method,
    },
  };
}

/** True when the user's metadata already records acceptance of the current versions. */
export function hasAcceptedCurrentLegal(metadata: Record<string, unknown> | undefined): boolean {
  const record = metadata?.['legal_acceptance'] as Partial<LegalAcceptance> | undefined;
  return (
    record?.terms_version === LEGAL_VERSIONS.terms &&
    record?.privacy_version === LEGAL_VERSIONS.privacy &&
    record?.collection_notice_version === LEGAL_VERSIONS.collectionNotice
  );
}
