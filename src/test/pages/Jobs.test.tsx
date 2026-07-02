/**
 * Tests for src/pages/Jobs.tsx
 *
 * Focused proof for the New job flow recorded in docs/COMPLETION_AUDIT.md.
 * These tests avoid network calls and assert the Supabase insert payload.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { JobsPage } from '@/pages/Jobs';
import {
  clearSupabaseOperations,
  getSupabaseOperations,
  mockSupabaseResponse,
} from '@/test/mocks/supabase';
import type { JobListRow } from '@/hooks/useJobs';

vi.mock('@/lib/supabase', () => import('@/test/mocks/supabase'));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

// Stable org/organizations references so CreateJobForm's auto-load
// useEffect([currentOrg]) runs once instead of re-firing every render.
const testOrg = vi.hoisted(() => ({
  id: 'org-1',
  name: 'AFGC Plumbing',
  organization_type: 'standard',
}));
const testOrgs = vi.hoisted(() => [testOrg]);

vi.mock('@/hooks/useOrg', () => ({
  useOrg: () => ({
    organizations: testOrgs,
    currentOrg: testOrg,
    loading: false,
    setCurrentOrg: vi.fn(),
    createOrganization: vi.fn(),
    refresh: vi.fn(),
  }),
}));

let mockJobs: JobListRow[] = [];
let mockLoading = false;
let mockError: string | null = null;
const mockRefresh = vi.fn().mockResolvedValue(undefined);

vi.mock('@/hooks/useJobs', () => ({
  useJobs: () => ({
    jobs: mockJobs,
    loading: mockLoading,
    error: mockError,
    refresh: mockRefresh,
  }),
}));

function renderPage() {
  return render(<JobsPage />);
}

const SAMPLE_JOBS: JobListRow[] = [
  {
    id: 'job-1',
    job_number: 'J0041',
    name: 'Boundary fence replacement',
    status: 'active',
    created_at: '2026-06-15T00:00:00Z',
    attached_bills: [{ count: 2 }],
    suggested_bills: [],
    revenue_inc_gst_cents: 165000,
    total_cost_cents: 99000,
    gross_profit_cents: 66000,
  },
];

describe('JobsPage', () => {
  beforeEach(() => {
    mockJobs = [];
    mockLoading = false;
    mockError = null;
    mockNavigate.mockClear();
    mockRefresh.mockClear();
    clearSupabaseOperations();
    mockSupabaseResponse({ data: [], error: null });
  });

  it('renders the page heading and New job button', () => {
    mockJobs = SAMPLE_JOBS;
    renderPage();

    expect(screen.getByRole('heading', { name: /jobs/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /new job/i })).toBeInTheDocument();
    // Rendered in both the desktop table and the mobile card deck.
    expect(screen.getAllByText('Boundary fence replacement').length).toBeGreaterThan(0);
  });

  it('renders jobs as mobile cards alongside the desktop table', () => {
    mockJobs = SAMPLE_JOBS;
    const { container } = renderPage();

    const table = screen.getByRole('table');
    expect(table).toHaveClass('table-premium');
    expect(table.closest('.jobs-table-view')).toBeInTheDocument();

    const cards = screen.getByLabelText('Job cards');
    expect(cards).toHaveClass('jobs-card-view');
    expect(container.querySelector('.job-mobile-card')).toBeInTheDocument();
    const link = within(cards).getByRole('link', { name: /J0041.*Boundary fence replacement/i });
    expect(link).toHaveAttribute('href', '/jobs/job-1');
    expect(within(cards).getByText('Bills attached')).toBeInTheDocument();
  });

  it('has a max-width: 768px breakpoint that swaps the jobs table for the card deck', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');
    expect(css).toMatch(
      /@media \(max-width: 768px\)[\s\S]*\.jobs-table-view[\s\S]*\{[\s\S]*display: none/,
    );
    expect(css).toMatch(
      /@media \(max-width: 768px\)[\s\S]*\.jobs-card-view[\s\S]*\{[\s\S]*display: grid/,
    );
  });

  it('opens the create-job form and auto-generates the next job number', async () => {
    mockSupabaseResponse({
      data: [{ id: 'cust-1', name: 'Acme Homes', job_number: 'J0041' }],
      error: null,
    });

    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /new job/i }));

    expect(screen.getByRole('heading', { name: /create new job/i })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByDisplayValue('J0042')).toBeInTheDocument();
    });
    expect(screen.getByLabelText(/job number/i)).toHaveValue('J0042');
    expect(screen.getByRole('option', { name: 'Acme Homes' })).toBeInTheDocument();
  });

  it('submits a new active job with organization, customer, budget, dates, and description', async () => {
    mockSupabaseResponse({
      data: [{ id: 'cust-1', name: 'Acme Homes', job_number: 'J0041' }],
      error: null,
    });

    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /new job/i }));

    await waitFor(() => {
      expect(screen.getByDisplayValue('J0042')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText(/1 schablon close/i), {
      target: { value: '22 Example Street fence' },
    });
    fireEvent.change(screen.getByLabelText(/customer/i), { target: { value: 'cust-1' } });
    fireEvent.change(screen.getByLabelText(/budget/i), { target: { value: '1234.56' } });
    fireEvent.change(screen.getByLabelText(/description/i), {
      target: { value: 'Front boundary replacement and gate works' },
    });

    mockSupabaseResponse({ data: [{ id: 'new-job-99' }], error: null });
    fireEvent.click(screen.getByRole('button', { name: /create job/i }));

    await waitFor(() => {
      const jobInsert = getSupabaseOperations().find(
        (op) => op.table === 'jobs' && op.method === 'insert',
      );
      expect(jobInsert).toBeTruthy();
      expect(jobInsert?.payload).toMatchObject({
        organization_id: 'org-1',
        job_number: 'J0042',
        name: '22 Example Street fence',
        description: 'Front boundary replacement and gate works',
        customer_id: 'cust-1',
        status: 'active',
        budget_cents: 123456,
        currency_code: 'AUD',
      });
    });

    expect(mockRefresh).toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith('/jobs/new-job-99');
  });

  it('surfaces a categorized create action error instead of a raw message', async () => {
    mockSupabaseResponse({
      data: [{ id: 'cust-1', name: 'Acme Homes', job_number: 'J0041' }],
      error: null,
    });

    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /new job/i }));

    await waitFor(() => {
      expect(screen.getByDisplayValue('J0042')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText(/1 schablon close/i), {
      target: { value: 'Blocked job' },
    });

    mockSupabaseResponse({
      data: null,
      error: { message: 'new row violates row-level security policy for table "jobs"' },
    });
    fireEvent.click(screen.getByRole('button', { name: /create job/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/could not create the job/i);
    expect(alert).toHaveTextContent(/access policy blocked this request/i);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('closes the create-job form without submitting when cancelled', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /new job/i }));

    expect(screen.getByRole('heading', { name: /create new job/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(screen.queryByRole('heading', { name: /create new job/i })).not.toBeInTheDocument();
    expect(getSupabaseOperations()).toEqual([]);
  });

  it('classifies load errors instead of showing generic failed-to-load copy', () => {
    mockError = 'Failed to fetch';

    renderPage();

    expect(
      screen.getByText(
        /could not load jobs\. network or server connection issue: failed to fetch/i,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^failed to load:/i)).not.toBeInTheDocument();
  });
});
