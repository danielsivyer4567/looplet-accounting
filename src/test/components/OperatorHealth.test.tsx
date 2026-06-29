/**
 * Tests for src/components/ops/OperatorHealth.tsx (P1-01).
 *
 * OperatorHealth is a read-only panel over the cron_no_success_windows() monitor
 * (migration 0211). We mock @/lib/supabase so supabase.rpc('cron_no_success_windows')
 * returns configurable rows, then assert:
 *   - stale-job rows render
 *   - the HTTP-200-but-failed *soft failure* surfaces as a failure, not a success
 *   - the empty result shows the healthy state
 *   - an rpc error surfaces
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { OperatorHealth, type StaleCronJob } from '@/components/ops/OperatorHealth';

// --- supabase.rpc mock ------------------------------------------------------
let _rpcData: unknown = [];
let _rpcError: { message: string } | null = null;
const mockRpc = vi.fn(() => Promise.resolve({ data: _rpcData, error: _rpcError }));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => mockRpc(...(args as [])),
  },
}));

const STALE_JOB: StaleCronJob = {
  job_name: 'notifications-cron',
  description: 'Nightly notification sweep',
  expected_interval: '1 day',
  grace_period: '01:00:00',
  last_success_at: '2026-06-20T02:30:00Z',
  last_run_at: '2026-06-20T02:30:00Z',
  last_run_success: true,
  last_run_http_status: 200,
  last_run_detail: {},
  seconds_overdue: 90061, // ~1d 1h
};

// HTTP-200 yet success=false — the soft-failure case the whole table exists for.
const SOFT_FAILED_JOB: StaleCronJob = {
  job_name: 'bank-sync-all',
  description: null,
  expected_interval: '6 hours',
  grace_period: '01:00:00',
  last_success_at: null,
  last_run_at: '2026-06-29T06:00:00Z',
  last_run_success: false,
  last_run_http_status: 200,
  last_run_detail: { error: 'token expired' },
  seconds_overdue: 3600,
};

describe('OperatorHealth — cron no-success-window monitor', () => {
  beforeEach(() => {
    _rpcData = [];
    _rpcError = null;
    mockRpc.mockClear();
  });

  it('renders stale-job rows from the monitor query', async () => {
    _rpcData = [STALE_JOB];

    render(<OperatorHealth />);

    await waitFor(() => expect(screen.getByText('notifications-cron')).toBeInTheDocument());
    expect(mockRpc).toHaveBeenCalledWith('cron_no_success_windows');
    expect(screen.getByText('Nightly notification sweep')).toBeInTheDocument();
    expect(screen.getByText('No success in window')).toBeInTheDocument();
    // overdue formatted from seconds (~1d 1h)
    expect(screen.getByText('1d 1h')).toBeInTheDocument();
  });

  it('surfaces an HTTP-200-but-failed soft failure as a failure, not success', async () => {
    _rpcData = [SOFT_FAILED_JOB];

    render(<OperatorHealth />);

    await waitFor(() => expect(screen.getByText('bank-sync-all')).toBeInTheDocument());
    // The 200 status must NOT mask the body-level failure.
    expect(screen.getByText(/Ran, reported failure \(HTTP 200\)/i)).toBeInTheDocument();
    // never succeeded -> last success column reads "never"
    expect(screen.getByText('never')).toBeInTheDocument();
  });

  it('renders both a stale and a soft-failed job together', async () => {
    _rpcData = [STALE_JOB, SOFT_FAILED_JOB];

    render(<OperatorHealth />);

    await waitFor(() => expect(screen.getByText('notifications-cron')).toBeInTheDocument());
    expect(screen.getByText('bank-sync-all')).toBeInTheDocument();
    expect(screen.getByText('No success in window')).toBeInTheDocument();
    expect(screen.getByText(/Ran, reported failure/i)).toBeInTheDocument();
  });

  it('shows the healthy empty state when no jobs are stale', async () => {
    _rpcData = [];

    render(<OperatorHealth />);

    await waitFor(() =>
      expect(screen.getByText(/All monitored cron jobs are healthy/i)).toBeInTheDocument(),
    );
  });

  it('surfaces an rpc error', async () => {
    _rpcError = { message: 'permission denied for function cron_no_success_windows' };

    render(<OperatorHealth />);

    await waitFor(() =>
      expect(screen.getByText(/Failed to load cron health/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/permission denied/i)).toBeInTheDocument();
  });
});
