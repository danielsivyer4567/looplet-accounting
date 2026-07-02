import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QualityPage } from '@/pages/Quality';

const mocks = vi.hoisted(() => ({
  enqueueJob: vi.fn(),
  booksHealthError: null as string | null,
  periodCloseError: null as string | null,
}));

vi.mock('@/lib/automationJobs', () => ({
  enqueueJob: mocks.enqueueJob,
}));

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

vi.mock('@/hooks/useBooksHealth', () => ({
  useBooksHealth: () => ({
    score: mocks.booksHealthError ? null : 76,
    components: {
      uncoded_count: 2,
      unreconciled_count: 3,
      open_period_count: 1,
      coverage_pct: 72.5,
    },
    blocking: true,
    loading: false,
    error: mocks.booksHealthError,
  }),
}));

vi.mock('@/hooks/usePeriodClose', () => ({
  usePeriodClose: () => ({
    period: '2026-06-01',
    checks: [],
    blockers: [],
    canClose: false,
    close: vi.fn(),
    closing: false,
    loading: false,
    error: mocks.periodCloseError,
    refresh: vi.fn(),
  }),
}));

vi.mock('@/lib/supabase', () => {
  const tableData: Record<string, unknown[]> = {
    v_duplicate_bills: [],
    v_low_confidence_bills: [
      {
        id: 'bill-1',
        supplier_name_raw: 'Reece Plumbing',
        invoice_number: 'INV-100',
        invoice_date: '2026-06-01',
        total_inc_gst_cents: null,
        ocr_provider: 'groq',
        ocr_confidence: 0.41,
        status: 'received',
        created_at: '2026-06-01T00:00:00Z',
      },
    ],
  };

  function makeQuery(table: string) {
    const chain: Record<string, unknown> = {};
    const terminal = () => Promise.resolve({ data: tableData[table] ?? [], error: null });
    const pass = () => chain;
    [
      'select',
      'eq',
      'neq',
      'gt',
      'lt',
      'gte',
      'lte',
      'like',
      'ilike',
      'in',
      'is',
      'not',
      'or',
      'filter',
      'order',
      'limit',
      'range',
      'match',
      'returns',
    ].forEach((method) => {
      chain[method] = pass;
    });
    chain['single'] = () =>
      terminal().then(({ data, error }) => ({
        data: Array.isArray(data) ? (data[0] ?? null) : data,
        error,
      }));
    chain['maybeSingle'] = chain['single'];
    chain['then'] = (resolve: (v: unknown) => unknown) => terminal().then(resolve);
    return chain;
  }

  return {
    supabase: {
      from: vi.fn((table: string) => makeQuery(table)),
      rpc: vi.fn(() => Promise.resolve({ data: [], error: null })),
    },
  };
});

function renderPage() {
  return render(
    <MemoryRouter>
      <QualityPage />
    </MemoryRouter>,
  );
}

describe('QualityPage OCR repair queue', () => {
  beforeEach(() => {
    mocks.enqueueJob.mockReset();
    mocks.booksHealthError = null;
    mocks.periodCloseError = null;
    mocks.enqueueJob.mockResolvedValue({
      id: 'job-12345678',
      organization_id: 'org-1',
      job_kind: 'bill_extract',
      status: 'pending',
    });
  });

  it('queues a repair-mode bill extraction batch for the current organization', async () => {
    renderPage();

    expect(screen.getByLabelText(/loading duplicate bill checks/i)).toHaveAttribute(
      'aria-busy',
      'true',
    );
    // Rendered in both the desktop table and the mobile card deck.
    await screen.findAllByText('Reece Plumbing');
    const queueButton = screen.getByRole('button', { name: /queue ocr repair/i });
    await waitFor(() => expect(queueButton).toBeEnabled());
    fireEvent.click(queueButton);

    await waitFor(() => expect(mocks.enqueueJob).toHaveBeenCalledTimes(1));
    expect(mocks.enqueueJob).toHaveBeenCalledWith({
      organizationId: 'org-1',
      jobKind: 'bill_extract',
      sourceKind: null,
      sourceId: null,
      priority: 3,
      maxAttempts: 3,
      payload: {
        mode: 'repair',
        max: 20,
        delay_ms: 2000,
        source: 'quality_page',
      },
    });
    expect(await screen.findByText(/OCR repair queued \(job-1234\)/)).toBeInTheDocument();
  });

  it('classifies quality score and check load errors by resource', async () => {
    mocks.booksHealthError = 'permission denied for table v_books_health';
    mocks.periodCloseError = 'failed to fetch period close checks';

    renderPage();

    await screen.findByText(/No duplicate bills detected/i);

    expect(
      screen.getByText(
        /could not load quality dashboard\. authentication or permission issue: permission denied for table v_books_health/i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /could not load quality checks\. network or server connection issue: failed to fetch period close checks/i,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^failed to load:/i)).not.toBeInTheDocument();
  });

  it('renders low-confidence bills as mobile cards alongside the desktop table', async () => {
    const { container } = renderPage();

    const cards = await screen.findByLabelText('Low confidence bill cards');
    expect(cards).toHaveClass('quality-card-view');
    expect(container.querySelector('.quality-mobile-card')).toBeInTheDocument();
    expect(within(cards).getByText('Reece Plumbing')).toBeInTheDocument();
    expect(within(cards).getByText('missing total')).toBeInTheDocument();
    expect(within(cards).getByText('41% OCR confidence')).toBeInTheDocument();

    const table = screen.getByRole('table');
    expect(table.closest('.quality-table-view')).toBeInTheDocument();
  });

  it('has a max-width: 768px breakpoint that swaps the quality table for the card deck', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');
    expect(css).toMatch(
      /@media \(max-width: 768px\)[\s\S]*\.quality-table-view[\s\S]*\{[\s\S]*display: none/,
    );
    expect(css).toMatch(
      /@media \(max-width: 768px\)[\s\S]*\.quality-card-view[\s\S]*\{[\s\S]*display: grid/,
    );
  });
});
