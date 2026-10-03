import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const h = vi.hoisted(() => ({
  createSignedUrl: vi.fn(),
}));

vi.mock('@/lib/supabase', () => {
  const billLookup = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn(() =>
      Promise.resolve({
        data: { storage_key: 'org-1/bills/bill-1.pdf', mime_type: 'application/pdf' },
        error: null,
      }),
    ),
  };

  return {
    supabase: {
      from: vi.fn(() => billLookup),
      storage: {
        from: vi.fn(() => ({
          createSignedUrl: h.createSignedUrl,
        })),
      },
      auth: {
        getSession: vi.fn(() => Promise.resolve({ data: { session: null } })),
      },
    },
  };
});

vi.mock('@/hooks/useOrg', () => ({
  useOrg: () => ({
    organizations: [{ id: 'org-1', name: 'Test Org', organization_type: 'standard' }],
    currentOrg: { id: 'org-1', name: 'Test Org', organization_type: 'standard' },
    loading: false,
    setCurrentOrg: vi.fn(),
    createOrganization: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock('@/hooks/useAllocationQueue', () => ({
  useAllocationQueue: vi.fn(() => ({
    queue: [
      {
        bill_id: 'bill-1',
        organization_id: 'org-1',
        status: 'received',
        supplier_name_raw: 'Steel Co',
        invoice_number: 'B-100',
        invoice_date: '2026-06-03',
        total_inc_gst_cents: 250000,
        job_reference_raw: 'J0001',
        suggested_job_id: 'job-1',
        score: 0.91,
        suggested_job_number: 'J0001',
        suggested_job_name: 'Fence install',
        suggested_job_status: 'active',
        created_at: '2026-06-03T00:00:00Z',
      },
    ],
    loading: false,
    error: null,
    refresh: vi.fn(),
  })),
}));

vi.mock('@/hooks/useJobs', () => ({
  useJobs: () => ({
    jobs: [{ id: 'job-1', job_number: 'J0001', name: 'Fence install', status: 'active' }],
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

import { AllocationsPage } from '@/pages/Allocations';
import { supabase } from '@/lib/supabase';

function renderPage() {
  return render(
    <MemoryRouter>
      <AllocationsPage />
    </MemoryRouter>,
  );
}

describe('AllocationsPage', () => {
  beforeEach(() => {
    h.createSignedUrl.mockReset();
    h.createSignedUrl.mockResolvedValue({
      data: { signedUrl: 'https://signed.example/bill-1.pdf' },
      error: null,
    });
  });

  it('opens a signed PDF preview side pane from the allocation queue', async () => {
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: /show pdf/i }));

    const pane = screen.getByRole('complementary', { name: /bill pdf preview/i });
    expect(pane).toBeInTheDocument();
    expect(within(pane).getByText('Steel Co')).toBeInTheDocument();
    expect(within(pane).getByText(/2026-06-03/)).toBeInTheDocument();

    const frame = await within(pane).findByTitle(/bill preview/i);
    await waitFor(() => {
      expect(h.createSignedUrl).toHaveBeenCalledWith('org-1/bills/bill-1.pdf', 300);
    });
    expect(frame).toHaveAttribute('src', 'https://signed.example/bill-1.pdf');
  });

  it('classifies allocation queue load errors instead of showing generic failed-to-load copy', async () => {
    const { useAllocationQueue } = await import('@/hooks/useAllocationQueue');
    vi.mocked(useAllocationQueue).mockReturnValueOnce({
      queue: [],
      loading: false,
      error: 'null value violates not-null constraint',
      stats: { total: 0, high_confidence: 0, needs_review: 0, no_suggestion: 0 },
      runAutoAccept: vi.fn(),
      runRematch: vi.fn(),
      runFull: vi.fn(),
      refresh: vi.fn(),
    });

    renderPage();

    expect(
      screen.getByText(
        /could not load allocation queue\. data validation issue: null value violates not-null constraint/i,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^failed to load:/i)).not.toBeInTheDocument();
  });

  it('surfaces a categorized action error when a suggestion write fails instead of failing silently', async () => {
    // Next supabase.from('bills').update(...).eq(...).select('id') call resolves to an RLS error.
    vi.mocked(supabase.from).mockReturnValueOnce({
      update: vi.fn(() => ({
        eq: vi.fn(() => ({
          select: vi.fn(() =>
            Promise.resolve({
              data: null,
              error: { message: 'new row violates row-level security policy for table "bills"' },
            }),
          ),
        })),
      })),
    } as unknown as ReturnType<typeof supabase.from>);

    renderPage();

    fireEvent.click(screen.getByRole('button', { name: /^wrong$/i }));

    expect(
      await screen.findByText(
        /could not reject this suggestion\. access policy blocked this request/i,
      ),
    ).toBeInTheDocument();
  });

  it('tags the main section and preview pane so the pane overlays instead of shoving content on mobile', () => {
    const { container } = renderPage();

    expect(container.querySelector('.allocations-main')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /show pdf/i }));
    const pane = screen.getByRole('complementary', { name: /bill pdf preview/i });
    expect(pane).toHaveClass('allocation-preview-pane');
  });

  it('has a max-width: 768px breakpoint that clears the content margin and full-widths the preview pane', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');

    expect(css).toMatch(
      /@media \(max-width: 768px\)[\s\S]*\.allocations-main\s*\{[\s\S]*margin-right: 0/,
    );
    expect(css).toMatch(
      /@media \(max-width: 768px\)[\s\S]*\.allocation-preview-pane\s*\{[\s\S]*width: 100%/,
    );
  });
});
