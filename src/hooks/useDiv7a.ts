import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';
import { downloadBlob } from '@/lib/download';

// ---- response shapes (hand-typed against the RPCs / table; no generated Database types
// yet, same `as unknown as` convention as useTrustDistribution) ----------------------

/** A Division 7A loan row (div7a_loans, SC-5.E.01, 0159). */
export interface Div7aLoanRow {
  id: string;
  lender_company_name: string;
  borrower_name: string;
  loan_year: number;
  principal_cents: number;
  term_years: number;
  has_complying_agreement: boolean;
}

/**
 * One breach flagged by div7a_breach_scan (SC-5.E.03, 0161). Fields vary by `kind`:
 *   repayment_shortfall: loan_id, income_year, min_repayment_cents, actual_repaid_cents, shortfall_cents
 *   loan_over_term:      loan_id, loan_year, term_years, final_year
 *   stale_upe:           upe_id, beneficiary, year_arose, unpaid_amount_cents
 */
export interface Div7aBreach {
  kind: 'repayment_shortfall' | 'loan_over_term' | 'stale_upe';
  loan_id?: string;
  upe_id?: string;
  income_year?: number;
  period_label?: string;
  min_repayment_cents?: number;
  actual_repaid_cents?: number;
  shortfall_cents?: number;
  loan_year?: number;
  term_years?: number;
  final_year?: number;
  beneficiary?: string;
  year_arose?: number;
  unpaid_amount_cents?: number;
  detail?: string;
}

/** The breach-scan result (div7a_breach_scan, 0161). */
export interface Div7aScan {
  ok: boolean;
  current_income_year: number;
  breach_count: number;
  counts: { repayment_shortfall: number; loan_over_term: number; stale_upe: number };
  breaches: Div7aBreach[];
}

/**
 * The Div 7A tracker's data layer (SC-5.G.04). Loads the org's loans + runs the breach
 * scan (div7a_breach_scan, org-wide — loans are company→shareholder, not trust-scoped),
 * and generates a complying loan-agreement PDF per loan (div7a-agreement edge fn,
 * SC-5.F.01). RLS-scoped to the caller. The Div 7A chain deploys as a batch; until then
 * the scan/agreement calls return an error the panel surfaces.
 */
export function useDiv7a() {
  const { currentOrg } = useOrg();
  const [loans, setLoans] = useState<Div7aLoanRow[]>([]);
  const [scan, setScan] = useState<Div7aScan | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [agreementBusyId, setAgreementBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!currentOrg) {
      setLoans([]);
      setScan(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);

    const [loansRes, scanRes] = await Promise.all([
      supabase
        .from('div7a_loans')
        .select('id, lender_company_name, borrower_name, loan_year, principal_cents, term_years, has_complying_agreement')
        .eq('organization_id', currentOrg.id)
        .is('deleted_at', null)
        .order('loan_year', { ascending: false }),
      supabase.rpc('div7a_breach_scan', { p_org: currentOrg.id }),
    ]);

    if (loansRes.error) {
      setError(loansRes.error.message);
      setLoans([]);
    } else {
      setLoans((loansRes.data ?? []) as Div7aLoanRow[]);
    }
    // The scan can fail independently (e.g. undeployed) without blanking the loan list.
    if (scanRes.error) {
      setError((prev) => prev ?? scanRes.error!.message);
      setScan(null);
    } else {
      setScan(scanRes.data as unknown as Div7aScan);
    }
    setLoading(false);
  }, [currentOrg]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const generateAgreement = useCallback(async (loanId: string): Promise<boolean> => {
    setAgreementBusyId(loanId);
    setError(null);
    const { data, error: fnErr } = await supabase.functions.invoke<Blob>('div7a-agreement', {
      body: { loan_id: loanId },
    });
    setAgreementBusyId(null);
    if (fnErr || !data) {
      setError(fnErr?.message ?? 'Could not generate the loan agreement.');
      return false;
    }
    downloadBlob(data, `div7a-loan-agreement-${loanId}.pdf`);
    return true;
  }, []);

  return { loans, scan, loading, error, agreementBusyId, refresh, generateAgreement };
}
