import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';

export type ObligationStage = 'overdue' | 'due_soon' | 'upcoming' | 'done';

/** Persisted completion statuses (obligation_status, SC-3.E.02) that override the time-stage. */
export type ObligationStatusValue = 'in_progress' | 'lodged' | 'accepted' | 'paid' | 'done';

export interface TaxObligation {
  organization_id: string;
  obligation_key: string;
  category: string;
  title: string;
  period_label: string;
  period_start: string;
  period_end: string;
  due_date: string;
  fy_start_year: number;
  display_name: string | null;
  description: string | null;
  cadence: string | null;
  default_lead_days: number;
  sort_order: number;
  days_until_due: number;
  stage: ObligationStage;
  /** Persisted status if set (e.g. 'lodged'), else the computed time-stage (v_tax_calendar overlay). */
  status: ObligationStage | ObligationStatusValue;
  /** Present after SC-7.E.00 when a persisted status is linked to a lodgement ledger row. */
  lodgement_id?: string | null;
  lodged_at?: string | null;
}

export type ObligationIntent = 'explain' | 'prepare' | 'remind';

function describeDueStatus(o: Pick<TaxObligation, 'stage' | 'days_until_due'>): string {
  if (o.stage === 'done') return 'already completed';
  if (o.stage === 'overdue') return `currently ${Math.abs(o.days_until_due)} days OVERDUE`;
  if (o.days_until_due === 0) return 'due today';
  return `due in ${o.days_until_due} days`;
}

/**
 * Composes a plain-English, step-by-step prompt about a specific obligation, for
 * handing off to the Ask AI chat. Shared by the timeline rail and the Ask page.
 */
export function buildObligationPrompt(o: TaxObligation, intent: ObligationIntent): string {
  const dueStr = new Date(`${o.due_date}T00:00:00`).toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  const status = describeDueStatus(o);
  const ctx = `Regarding my tax obligation "${o.title}" (due ${dueStr}, ${status}):`;
  const prompts: Record<ObligationIntent, string> = {
    explain: `${ctx} In the simplest plain English — assume I have no accounting knowledge and don't use a bookkeeper — explain what this is, why it applies to my business, and exactly what I need to do, as a short numbered step-by-step. No jargon.`,
    prepare: `${ctx} Give me a simple numbered checklist of what I need to gather and prepare, and how to actually lodge or pay it. Plain English, practical steps only.`,
    remind: `${ctx} When should I start preparing, what are the key dates leading up to the deadline, and what's a sensible reminder plan so I never miss it? Keep it simple.`,
  };
  return prompts[intent];
}

/**
 * Upserts a persisted obligation status (obligation_status, SC-3.E.02) — the generic
 * lodge/pay write-back overlaid onto v_tax_calendar via COALESCE(os.status, stage).
 * Reused across obligation keys: BAS marks 'lodged' (Bas.tsx), super marks 'paid'
 * (SC-3.H.02), Phase 7 lodgements pass `lodgementId`/`lodgedAt`. `periodLabel` MUST equal
 * generate_tax_obligations' format 'Q{n} FY{gs}-{lpad((gs+1)%100,2)}' so it joins
 * (the migration's check asserts that format hasn't drifted). deleted_at:null so a
 * re-mark un-soft-deletes via the (org, key, period_label) upsert arbiter.
 */
export async function markObligationStatus(args: {
  organizationId: string;
  obligationKey: string;
  periodLabel: string;
  status: ObligationStatusValue;
  lodgementId?: string | null;
  lodgedAt?: string | null;
}): Promise<void> {
  const payload: Record<string, unknown> = {
    organization_id: args.organizationId,
    obligation_key: args.obligationKey,
    period_label: args.periodLabel,
    status: args.status,
    deleted_at: null,
  };
  if ('lodgementId' in args) payload.lodgement_id = args.lodgementId;
  if ('lodgedAt' in args) payload.lodged_at = args.lodgedAt;

  const { error } = await supabase
    .from('obligation_status' as never)
    .upsert(payload as never, { onConflict: 'organization_id,obligation_key,period_label' });
  if (error) throw new Error(error.message);
}

/**
 * Reads the per-org tax calendar (v_tax_calendar) — personalized obligations with
 * correct AU due dates, ordered soonest-first.
 */
export function useTaxCalendar() {
  const { currentOrg } = useOrg();
  const [obligations, setObligations] = useState<TaxObligation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!currentOrg) {
      setObligations([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    void supabase
      .from('v_tax_calendar')
      .select('*')
      .eq('organization_id', currentOrg.id)
      .order('due_date', { ascending: true })
      .then(({ data, error }) => {
        if (error) {
          setError(error.message);
          setObligations([]);
        } else {
          setObligations((data ?? []) as TaxObligation[]);
        }
        setLoading(false);
      });
  }, [currentOrg]);

  return { obligations, loading, error };
}
