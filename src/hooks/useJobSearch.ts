import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/contexts/OrgContext';

export interface JobOption {
  id: string;
  job_number: string;
  name: string;
  status: string;
}

/**
 * Typeahead search for jobs in the current org.
 * Matches against job_number OR name. Filters out completed/cancelled jobs
 * by default — bills can only be attached to live work.
 */
export function useJobSearch(query: string, includeAll = false) {
  const { currentOrg } = useOrg();
  const [results, setResults] = useState<JobOption[]>([]);
  const [loading, setLoading] = useState(false);

  const search = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);
    let q = supabase
      .from('jobs')
      .select('id, job_number, name, status')
      .eq('organization_id', currentOrg.id)
      .is('deleted_at', null);

    if (!includeAll) {
      q = q.in('status', ['draft', 'active', 'paused']);
    }

    if (query && query.trim().length > 0) {
      const trimmed = query.trim();
      q = q.or(`job_number.ilike.%${trimmed}%,name.ilike.%${trimmed}%`);
    }

    const { data } = await q.order('created_at', { ascending: false }).limit(20);
    setResults((data ?? []) as JobOption[]);
    setLoading(false);
  }, [currentOrg, query, includeAll]);

  useEffect(() => {
    const debounce = setTimeout(() => void search(), 200);
    return () => clearTimeout(debounce);
  }, [search]);

  return { results, loading };
}
