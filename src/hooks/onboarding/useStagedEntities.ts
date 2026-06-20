import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';

export type EntityKind =
  | 'supplier' | 'contractor' | 'customer'
  | 'personal' | 'subscription' | 'internal_admin' | 'unknown';

export type EntityStatus = 'pending' | 'approved' | 'dismissed' | 'needs_review';

export interface StagedEntity {
  id: string;
  organization_id: string;
  canonical_key: string;
  display_name: string;
  primary_email: string | null;
  observed_emails: string[];
  observed_domains: string[];
  abn: string | null;
  message_count: number;
  attachment_count: number;
  total_amount_seen_cents: number | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  sample_subjects: string[];
  sample_message_ids: string[];
  predicted_kind: EntityKind;
  predicted_category: string | null;
  prediction_reason: string | null;
  confidence: number;
  status: EntityStatus;
  user_kind: EntityKind | null;
  user_category: string | null;
  is_recurring: boolean;
  // Sonar (Perplexity) enrichment — fact-check + grounded category prediction
  sonar_summary: string | null;
  sonar_suggested_kind: EntityKind | null;
  sonar_suggested_category: string | null;
  sonar_confidence: number | null;
  sonar_evidence_url: string | null;
  sonar_enriched_at: string | null;
}

export interface OnboardingProgress {
  total_entities: number;
  pending_count: number;
  needs_review_count: number;
  approved_count: number;
  dismissed_count: number;
  pct_complete: number;
  is_complete: boolean;
}

export function useStagedEntities() {
  const { currentOrg } = useOrg();
  const [entities, setEntities] = useState<StagedEntity[]>([]);
  const [progress, setProgress] = useState<OnboardingProgress | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);
    const [{ data: rows }, { data: prog }] = await Promise.all([
      supabase
        .from('staged_entities')
        .select('*')
        .eq('organization_id', currentOrg.id)
        .order('message_count', { ascending: false }),
      supabase.rpc('onboarding_progress', { p_org_id: currentOrg.id }),
    ]);
    setEntities((rows ?? []) as StagedEntity[]);
    setProgress(((prog as OnboardingProgress[] | null)?.[0] as OnboardingProgress) ?? null);
    setLoading(false);
  }, [currentOrg]);

  useEffect(() => void refresh(), [refresh]);

  return { entities, progress, loading, refresh };
}
