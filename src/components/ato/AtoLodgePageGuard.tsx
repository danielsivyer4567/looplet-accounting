// ATO lodge page guard component (SC-7.B.01 -> SC-4 extension)
//
// UI component wrapper for ATO lodge page guard.
//
// DEPLOY-GATED: Requires env vars: ATO_DSP_ABN, ATO_SOFTWARE_ID, ATO_STIN, ATO_M2M_KEYSTORE_REF
//                   SBR_TAXONOMY_VERSION, SBR_TAXONOMY_BASE_URL
//
// If any required configuration is missing, displays banner redirecting to settings.
// If all configured, renders protected lodge operations UI.

import { AlertTriangle, Settings } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useAtoLodgeGuard } from '@/hooks/useAtoLodgeGuard';

interface AtoLodgePageGuardProps {
  organizationId: string;
  children: React.ReactNode;
}

export function AtoLodgePageGuard({ organizationId, children }: AtoLodgePageGuardProps) {
  const { user, loading: authLoading } = useAuth();
  const { allowed, health, isLoading, configUrl } = useAtoLodgeGuard(organizationId);

  if (authLoading || isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-primary" />
      </div>
    );
  }

  if (!user) {
    return (
      <section className="max-w-2xl mx-auto mt-12 rounded-lg border p-6">
        <h2 className="text-xl font-semibold">Authentication Required</h2>
        <p className="mt-2 text-sm">Sign in to access ATO lodge operations.</p>
      </section>
    );
  }

  if (!allowed) {
    return (
      <section className="max-w-2xl mx-auto mt-12 rounded-lg border border-yellow-200 bg-yellow-50 p-6">
        <header>
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-yellow-600" />
            <h2 className="text-xl font-semibold text-yellow-800">ATO Operations Not Ready</h2>
          </div>
          <p className="mt-2 text-sm text-yellow-700">
            ATO lodge operations are blocked until configuration is complete.
          </p>
        </header>
        <div className="mt-4 space-y-4">
          <div className="p-3 bg-white rounded border border-yellow-200">
            <p className="font-medium text-sm mb-2">Configuration Issues:</p>
            <ul className="text-sm space-y-1">
              {(health?.evte_missing.length ?? 0) > 0 && (
                <li>
                  <span className="text-red-600">EVTE:</span> {health?.evte_missing.join(', ')}
                </li>
              )}
              {(health?.dsp_missing.length ?? 0) > 0 && (
                <li>
                  <span className="text-red-600">DSP:</span> {health?.dsp_missing.join(', ')}
                </li>
              )}
              {(health?.sbr_missing.length ?? 0) > 0 && (
                <li>
                  <span className="text-red-600">SBR:</span> {health?.sbr_missing.join(', ')}
                </li>
              )}
            </ul>
          </div>

          <p className="text-sm text-yellow-800">
            Complete the missing configuration in ATO credentials settings, then try again.
          </p>

          {configUrl && (
            <a
              className="inline-flex w-full items-center justify-center rounded bg-yellow-700 px-4 py-2 text-sm font-semibold text-white"
              href={configUrl}
            >
              <Settings className="mr-2 h-4 w-4" />
              Configure ATO Credentials
            </a>
          )}

          {health?.audit_trail && (
            <div className="p-2 bg-gray-50 rounded text-xs font-mono">{health.audit_trail}</div>
          )}
        </div>
      </section>
    );
  }

  return <>{children}</>;
}
