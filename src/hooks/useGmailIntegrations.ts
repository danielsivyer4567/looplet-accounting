import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/contexts/OrgContext';

export interface GmailIntegration {
  id: string;
  gmail_address: string;
  is_active: boolean;
  last_history_id: string | null;
  watch_expires_at: string | null;
  last_synced_at: string | null;
  last_error: string | null;
  allowlist: string[];
  created_at: string;
}

export function useGmailIntegrations() {
  const { currentOrg } = useOrg();
  const [integrations, setIntegrations] = useState<GmailIntegration[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);
    const { data } = await supabase
      .from('gmail_integrations')
      .select('*')
      .eq('organization_id', currentOrg.id)
      .order('created_at', { ascending: false });
    setIntegrations((data ?? []) as GmailIntegration[]);
    setLoading(false);
  }, [currentOrg]);

  useEffect(() => void refresh(), [refresh]);

  return { integrations, loading, refresh };
}
