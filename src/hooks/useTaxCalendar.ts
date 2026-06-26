import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';

export type ObligationStage = 'overdue' | 'due_soon' | 'upcoming';

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
}

export type ObligationIntent = 'explain' | 'prepare' | 'remind';

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
  const status =
    o.stage === 'overdue'
      ? `currently ${Math.abs(o.days_until_due)} days OVERDUE`
      : o.days_until_due === 0
        ? 'due today'
        : `due in ${o.days_until_due} days`;
  const ctx = `Regarding my tax obligation "${o.title}" (due ${dueStr}, ${status}):`;
  const prompts: Record<ObligationIntent, string> = {
    explain: `${ctx} In the simplest plain English — assume I have no accounting knowledge and don't use a bookkeeper — explain what this is, why it applies to my business, and exactly what I need to do, as a short numbered step-by-step. No jargon.`,
    prepare: `${ctx} Give me a simple numbered checklist of what I need to gather and prepare, and how to actually lodge or pay it. Plain English, practical steps only.`,
    remind: `${ctx} When should I start preparing, what are the key dates leading up to the deadline, and what's a sensible reminder plan so I never miss it? Keep it simple.`,
  };
  return prompts[intent];
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
