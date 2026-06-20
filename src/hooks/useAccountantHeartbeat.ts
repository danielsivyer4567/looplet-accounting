import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';
import { useAuth } from '@/hooks/useAuth';

/**
 * useAccountantHeartbeat — calls the accountant_session_heartbeat RPC on
 * pageview + every 60s while user is active. The RPC is a no-op for non-
 * accountant roles so it's safe to mount globally.
 *
 * Time-on-page: tracked via the duration since the last heartbeat fired
 * for the same path.
 */
export function useAccountantHeartbeat() {
  const { currentOrg } = useOrg();
  const { user } = useAuth();
  const location = useLocation();
  const lastHeartbeatRef = useRef<number>(Date.now());
  const lastPathRef = useRef<string>('');

  useEffect(() => {
    if (!currentOrg || !user) return;

    const fire = (path: string, durationMs: number | null) => {
      void supabase.rpc('accountant_session_heartbeat', {
        p_org_id: currentOrg.id,
        p_event_type: 'pageview',
        p_path: path,
        p_user_agent: navigator.userAgent.slice(0, 200),
        p_duration_ms: durationMs,
      });
    };

    // On path change: log previous path's duration, then start tracking new path
    if (lastPathRef.current && lastPathRef.current !== location.pathname) {
      const dur = Date.now() - lastHeartbeatRef.current;
      fire(lastPathRef.current, dur);
    }
    lastPathRef.current = location.pathname;
    lastHeartbeatRef.current = Date.now();
    // Also fire an immediate pageview for the new path
    fire(location.pathname, null);

    // Keep-alive heartbeat every 60s while page is in foreground
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') {
        const dur = Date.now() - lastHeartbeatRef.current;
        fire(location.pathname, dur);
        lastHeartbeatRef.current = Date.now();
      }
    }, 60_000);

    return () => clearInterval(interval);
  }, [currentOrg, user, location.pathname]);
}
