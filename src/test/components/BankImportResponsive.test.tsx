import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BankCsvImport } from '@/components/settings/BankCsvImport';
import { BankStatementImport } from '@/components/settings/BankStatementImport';

const mocks = vi.hoisted(() => ({
  org: { id: 'org-1', name: 'Test Org', organization_type: 'standard' },
  getSession: vi.fn(),
  onImported: vi.fn(),
}));

vi.mock('@/hooks/useOrg', () => ({
  useOrg: () => ({
    organizations: [mocks.org],
    currentOrg: mocks.org,
    loading: false,
    setCurrentOrg: vi.fn(),
    createOrganization: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: mocks.getSession,
    },
  },
}));

describe('Bank import responsive layouts', () => {
  beforeEach(() => {
    mocks.getSession.mockResolvedValue({ data: { session: null }, error: null });
    mocks.onImported.mockReset();
  });

  it('renders CSV import as responsive form grids and shows auth errors as alerts', async () => {
    const { container } = render(<BankCsvImport onImported={mocks.onImported} />);

    fireEvent.click(screen.getByRole('button', { name: /import csv/i }));

    expect(screen.getByRole('heading', { name: /import bank csv/i })).toBeInTheDocument();
    expect(container.querySelector('.bank-import-card')).toBeTruthy();
    expect(container.querySelectorAll('.bank-import-grid')).toHaveLength(3);

    fireEvent.change(screen.getByLabelText(/or paste csv/i), {
      target: { value: '01/05/2026,-50.00,EFTPOS WOOLWORTHS,1234.56' },
    });
    fireEvent.click(screen.getByRole('button', { name: /import transactions/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Not signed in');
  });

  it('renders PDF statement import as responsive form grids', () => {
    const { container } = render(<BankStatementImport onImported={mocks.onImported} />);

    fireEvent.click(screen.getByRole('button', { name: /import pdf statement/i }));

    expect(screen.getByRole('heading', { name: /import pdf bank statement/i })).toBeInTheDocument();
    expect(container.querySelector('.bank-import-card')).toBeTruthy();
    expect(container.querySelectorAll('.bank-import-grid')).toHaveLength(2);
    expect(container.querySelector('.bank-import-split')).toBeTruthy();
    expect(container.querySelector('.bank-import-actions')).toBeTruthy();
  });

  it('shows an explicit zero-statements empty state with the extract action disabled', () => {
    render(<BankStatementImport onImported={mocks.onImported} />);

    fireEvent.click(screen.getByRole('button', { name: /import pdf statement/i }));

    // With no PDFs picked, the count reads 0 and the extract button cannot fire.
    expect(screen.getByText(/pdf statements \(0 selected\)/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /extract & import/i })).toBeDisabled();
  });

  it('has a breakpoint contract for bank import forms', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');

    expect(css).toMatch(/\.bank-import-grid\s*\{[\s\S]*grid-template-columns: repeat\(2/);
    expect(css).toMatch(
      /@media \(max-width: 768px\)[\s\S]*\.bank-import-grid\s*\{[\s\S]*grid-template-columns: 1fr/,
    );
    expect(css).toMatch(
      /@media \(max-width: 768px\)[\s\S]*\.bank-import-open-button\s*\{[\s\S]*width: 100%/,
    );
  });
});
