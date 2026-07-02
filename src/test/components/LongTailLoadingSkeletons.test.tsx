import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BankTransactionCodingQueue } from '@/components/BankTransactionCodingQueue';
import { DocumentPreviewModal } from '@/components/DocumentPreviewModal';
import { OrgSelector } from '@/components/OrgSelector';

const mocks = vi.hoisted(() => ({
  orgLoading: false,
  bankQueueLoading: false,
  getBillFileUrl: vi.fn(),
}));

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  version: 'test',
  getDocument: vi.fn(),
}));

vi.mock('@/hooks/useOrg', () => ({
  useOrg: () => ({
    organizations: [{ id: 'org-1', name: 'Test Org', organization_type: 'standard' }],
    currentOrg: { id: 'org-1', name: 'Test Org', organization_type: 'standard' },
    loading: mocks.orgLoading,
    setCurrentOrg: vi.fn(),
    createOrganization: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock('@/hooks/useBankCodingQueue', () => ({
  useBankCodingQueue: () => ({
    rows: [],
    loading: mocks.bankQueueLoading,
    error: null,
    busyId: null,
    refresh: vi.fn(),
    postDecision: vi.fn(),
    confirmAll: vi.fn(),
  }),
}));

vi.mock('@/hooks/useBill', () => ({
  getBillFileUrl: mocks.getBillFileUrl,
}));

describe('long-tail loading skeletons', () => {
  beforeEach(() => {
    mocks.orgLoading = false;
    mocks.bankQueueLoading = false;
    mocks.getBillFileUrl.mockReset();
    mocks.getBillFileUrl.mockReturnValue(new Promise(() => undefined));
  });

  it('uses a skeleton while organizations hydrate', () => {
    mocks.orgLoading = true;

    render(<OrgSelector />);

    expect(screen.getByLabelText(/loading organisations/i)).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByText(/loading orgs/i)).not.toBeInTheDocument();
  });

  it('uses a table skeleton while the bank coding queue loads', () => {
    mocks.bankQueueLoading = true;

    render(<BankTransactionCodingQueue />);

    expect(screen.getByLabelText(/loading coding queue/i)).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByText(/loading coding queue/i)).not.toBeInTheDocument();
  });

  it('uses a card skeleton while document preview is resolving', () => {
    render(
      <DocumentPreviewModal
        bill={{
          id: 'bill-1',
          storage_key: 'org-1/bills/bill-1.pdf',
          mime_type: 'application/pdf',
          original_filename: 'bill-1.pdf',
          supplier_name_raw: 'Acme',
        }}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByLabelText(/loading document preview/i)).toHaveAttribute(
      'aria-busy',
      'true',
    );
    expect(screen.queryByText(/loading document/i)).not.toBeInTheDocument();
  });
});
