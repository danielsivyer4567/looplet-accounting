import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';
import { useAuth } from '@/hooks/useAuth';

/**
 * useAccountantHeartbeat — calls the accountant_session_heartbeat RPC on
 * pageview + every 60s while user is active, and meaningful clicks on controls.
 * The RPC is a no-op for non-accountant roles so it's safe to mount globally.
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

    const fire = (
      path: string,
      durationMs: number | null,
      eventType: 'pageview' | 'action' = 'pageview',
      description: string | null = null,
    ) => {
      void supabase.rpc('accountant_session_heartbeat', {
        p_org_id: currentOrg.id,
        p_event_type: eventType,
        p_path: path,
        p_description: description,
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

    const onClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const control = target.closest<HTMLElement>(
        'button, a, [role="button"], input, select, textarea',
      );
      if (!control || control.closest('[data-no-advisor-activity="true"]')) return;
      const label =
        control.getAttribute('aria-label') ??
        control.getAttribute('title') ??
        control.textContent?.replace(/\s+/g, ' ').trim() ??
        control.getAttribute('name') ??
        control.id ??
        control.tagName.toLowerCase();
      const safeLabel = label.slice(0, 140);
      if (!safeLabel) return;
      fire(location.pathname, null, 'action', `Clicked ${safeLabel}`);
    };

    document.addEventListener('click', onClick, true);

    return () => {
      clearInterval(interval);
      document.removeEventListener('click', onClick, true);
    };
  }, [currentOrg, user, location.pathname]);
}
