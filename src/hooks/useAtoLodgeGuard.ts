// ATO lodge UI guard (SC-7.B.01 -> SC-4 extension)
//
// Frontend guard for ATO lodge page. Checks EVTE/DSP/SBR configuration completeness.
// If not configured, shows "Setup Required" banner with config status.
//
// This guard is called from the ATO Lodge page component.

import { useEffect, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { checkLodgeGuard, type LodgeGuardResult } from '@/hooks/useLodgeGuard';

export function useAtoLodgeGuard(organizationId: string): {
  allowed: boolean;
  health?: LodgeGuardResult['health'];
  error?: string;
  isLoading: boolean;
  configUrl?: string;
} {
  const { user } = useAuth();
  const [state, setState] = useState<LodgeGuardResult & { isLoading: boolean }>({
    allowed: false,
    isLoading: true,
  });

  useEffect(() => {
    let cancelled = false;
    if (!user || !organizationId) {
      setState({
        allowed: false,
        isLoading: false,
        error: !user ? 'Not authenticated' : 'Organization is required',
      });
      return;
    }

    setState((current) => ({ ...current, isLoading: true }));
    checkLodgeGuard(organizationId)
      .then((result) => {
        if (!cancelled) setState({ ...result, isLoading: false });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            allowed: false,
            isLoading: false,
            error: error instanceof Error ? error.message : 'Failed to check lodge readiness',
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [organizationId, user]);

  if (state.isLoading) {
    return { allowed: false, isLoading: true };
  }

  if (state.error) {
    return {
      allowed: false,
      isLoading: false,
      error: state.error,
    };
  }

  const configUrl = state.allowed
    ? undefined
    : '/dashboard/settings/integrations/ato-credentials?tab=production';

  const result: {
    allowed: boolean;
    health?: LodgeGuardResult['health'];
    error?: string;
    isLoading: boolean;
    configUrl?: string;
  } = {
    allowed: state.allowed,
    isLoading: false,
  };
  if (state.health) result.health = state.health;
  if (configUrl) result.configUrl = configUrl;
  return result;
}
