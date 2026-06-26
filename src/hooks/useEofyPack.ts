import { useCallback, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';

/**
 * useEofyPack (SC-4.C.02) — drives the EOFY pack flow for one AU FY by invoking the
 * `eofy-pack` edge function (SC-4.C.01), which composes the Phase-4 statement RPCs
 * into one artifact: a structured JSON `bundle` + a base64 PDF of the face statements.
 *
 * ACTION-DRIVEN, never auto-run: the default generate() runs the MUTATING true-up
 * (generate_eofy_pack closes the FY months, posts depreciation, locks periods), so it
 * must only fire on an explicit user action — never on mount. preview() runs the
 * read-only path (skip_true_up=true) for the wizard's readiness step.
 *
 * Errors: the edge fn maps the orchestrator's RAISEs to 403 (org inaccessible) and
 * 409 (books-health blocking). supabase-js surfaces a non-2xx as a FunctionsHttpError
 * whose Response rides in `.context`; we read the JSON body off it so the wizard can
 * show the real blocker message and flag `blocked` (books-health) distinctly.
 *
 * Hand-typed against the edge fn's response shape (no generated Supabase types).
 */

// ---- response shape (mirrors supabase/functions/eofy-pack/index.ts) ----------------

export interface EofyReadiness {
  ready: boolean;
  open_period_count: number;
  unreconciled_count: number;
  uncoded_count: number;
  trial_balance_net_cents: number;
  trial_balance_balanced: boolean;
  books_health_available: boolean;
  blockers: string[];
}

export interface EofyLineItem {
  account_code: string;
  account_name: string;
  amount_cents: number;
}

export interface EofyStatements {
  profit_and_loss: {
    revenue: EofyLineItem[];
    total_revenue_cents: number;
    expenses: EofyLineItem[];
    total_expenses_cents: number;
    net_profit_cents: number;
  };
  balance_sheet: {
    assets: EofyLineItem[];
    total_assets_cents: number;
    liabilities: EofyLineItem[];
    total_liabilities_cents: number;
    equity: EofyLineItem[];
    total_equity_cents: number;
    current_year_earnings_cents: number;
    total_equity_and_earnings_cents: number;
    balances: boolean;
  };
}

export interface EofyEquityMovement {
  account_code: string;
  account_name: string;
  opening_cents: number;
  movement_cents: number;
  closing_cents: number;
}

export interface EofyEquityCashflow {
  statement_of_changes_in_equity: {
    equity_accounts: EofyEquityMovement[];
    retained_earnings: {
      opening_cents: number;
      profit_for_year_cents: number;
      closing_cents: number;
    };
    opening_equity_cents: number;
    total_movement_cents: number;
    closing_equity_cents: number;
    reconciles: boolean;
  };
  cash_flow_statement: {
    cash_accounts: {
      account_code: string;
      account_name: string;
      opening_cents: number;
      closing_cents: number;
    }[];
    operating_cents: number;
    investing_cents: number;
    financing_cents: number;
    net_change_in_cash_cents: number;
    opening_cash_cents: number;
    closing_cash_cents: number;
    gl_cash_movement_cents: number;
    ties_to_gl: boolean;
  };
}

export interface EofyDepreciationAsset {
  asset_name: string;
  method: string;
  effective_life_years: number | null;
  cost_base_cents: number;
  period_depreciation_cents: number;
  accumulated_depreciation_cents: number;
}

export interface EofyNotes {
  notes: {
    accounting_policy: { title: string; body: string[] };
    depreciation: {
      title: string;
      asset_count: number;
      by_asset: EofyDepreciationAsset[];
      period_depreciation_total_cents: number;
      gl_depreciation_expense_cents: number;
      ties_to_gl: boolean;
    };
    related_party: { title: string; status: string; body: string };
  };
}

export interface EofyAdvisory {
  bad_debt_candidates: Record<string, unknown>[];
  bad_debt_count: number;
  owner_drawings_flags: Record<string, unknown>[];
  owner_drawings_count: number;
}

export interface EofyWorkingPaper {
  label: string;
  href: string;
}

export interface EofyPackBundle {
  organization_id: string;
  fy_start_year: number;
  generated_at: string;
  /** false when generated via preview() (read-only, no true-up). */
  true_up_run: boolean;
  readiness: EofyReadiness | null;
  /** Per-month close + accrual summary; present only when the true-up ran. */
  orchestration: Record<string, unknown> | null;
  statements: EofyStatements;
  equity_and_cash_flow: EofyEquityCashflow;
  notes: EofyNotes;
  advisory: EofyAdvisory;
  working_papers: EofyWorkingPaper[];
}

export interface EofyPackResponse {
  ok: boolean;
  bundle?: EofyPackBundle;
  pdf_base64?: string;
  error?: string;
  reason?: string;
}

// ---- helpers -----------------------------------------------------------------------

/** Read the JSON error body a non-2xx edge fn returns off the FunctionsHttpError's Response. */
async function readFnError(err: unknown): Promise<{ message: string; reason?: string | undefined }> {
  const e = err as { message?: string; context?: { json?: () => Promise<unknown> } };
  let message = e.message ?? 'Request failed';
  let reason: string | undefined;
  try {
    if (e.context?.json) {
      const body = (await e.context.json()) as { error?: string; reason?: string };
      if (body?.error) message = body.error;
      reason = body?.reason;
    }
  } catch {
    // body not JSON / already consumed — keep the FunctionsHttpError message.
  }
  return { message, reason };
}

// ---- hook --------------------------------------------------------------------------

export function useEofyPack(fyStartYear: number | null) {
  const { currentOrg } = useOrg();
  const [bundle, setBundle] = useState<EofyPackBundle | null>(null);
  const [pdfBase64, setPdfBase64] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** True when the failure was a books-health block (409) — the recoverable "fix your books" case. */
  const [blocked, setBlocked] = useState(false);

  const generate = useCallback(
    async (opts?: { skipTrueUp?: boolean }): Promise<EofyPackBundle | null> => {
      if (!currentOrg || fyStartYear == null) {
        setError('Select a financial year first.');
        return null;
      }
      setLoading(true);
      setError(null);
      setBlocked(false);

      const { data, error: fnErr } = await supabase.functions.invoke<EofyPackResponse>('eofy-pack', {
        body: {
          organization_id: currentOrg.id,
          fy_start_year: fyStartYear,
          skip_true_up: opts?.skipTrueUp === true,
        },
      });

      let result: EofyPackBundle | null = null;
      if (fnErr) {
        const parsed = await readFnError(fnErr);
        setError(parsed.message);
        setBlocked(parsed.reason === 'books_health_blocking');
        setBundle(null);
        setPdfBase64(null);
      } else if (data?.ok && data.bundle) {
        setBundle(data.bundle);
        setPdfBase64(data.pdf_base64 ?? null);
        result = data.bundle;
      } else {
        setError(data?.error ?? 'EOFY pack generation failed.');
        setBundle(null);
        setPdfBase64(null);
      }

      setLoading(false);
      return result;
    },
    [currentOrg, fyStartYear],
  );

  /** Read-only preview (no true-up) — the wizard's readiness step. */
  const preview = useCallback(() => generate({ skipTrueUp: true }), [generate]);

  const reset = useCallback(() => {
    setBundle(null);
    setPdfBase64(null);
    setError(null);
    setBlocked(false);
  }, []);

  return {
    bundle,
    pdfBase64,
    loading,
    error,
    blocked,
    generate,
    preview,
    reset,
  };
}
