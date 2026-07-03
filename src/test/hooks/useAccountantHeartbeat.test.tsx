import { fireEvent, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
  currentOrg: { id: 'org-1' },
  user: { id: 'user-1' },
}));

vi.mock('@/hooks/useOrg', () => ({
  useOrg: () => ({ currentOrg: mocks.currentOrg }),
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: mocks.user }),
}));

vi.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: '/bills' }),
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: vi.fn((name: string, args: Record<string, unknown>) => {
      mocks.rpcCalls.push({ name, args });
      return Promise.resolve({ data: 'session-1', error: null });
    }),
  },
}));

import { useAccountantHeartbeat } from '@/hooks/useAccountantHeartbeat';

describe('useAccountantHeartbeat', () => {
  beforeEach(() => {
    mocks.rpcCalls = [];
    document.body.innerHTML = '';
  });

  it('logs pageviews and meaningful advisor control clicks', async () => {
    const { unmount } = renderHook(() => useAccountantHeartbeat());

    await waitFor(() => {
      expect(mocks.rpcCalls.some((call) => call.args.p_event_type === 'pageview')).toBe(true);
    });

    const button = document.createElement('button');
    button.textContent = 'Save bill';
    document.body.appendChild(button);
    fireEvent.click(button);

    await waitFor(() => {
      expect(mocks.rpcCalls).toContainEqual(
        expect.objectContaining({
          name: 'accountant_session_heartbeat',
          args: expect.objectContaining({
            p_event_type: 'action',
            p_path: '/bills',
            p_description: 'Clicked Save bill',
          }),
        }),
      );
    });

    unmount();
  });
});
