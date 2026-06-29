/**
 * Tests for src/pages/Clients.tsx — the accountant client picker.
 *
 * We mock:
 *   - @/hooks/useOrg     — control accountantClientOrgs / currentOrg / setCurrentOrg
 *   - react-router-dom   — stub useNavigate to assert navigation on card click
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ClientsPage } from '@/pages/Clients';
import type { Organization } from '@/contexts/org-context';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

const mockSetCurrentOrg = vi.fn();
let _clients: Organization[] = [];
let _currentOrg: Organization | null = null;
let _loading = false;

vi.mock('@/hooks/useOrg', () => ({
  useOrg: () => ({
    organizations: _clients,
    accountantClientOrgs: _clients,
    currentOrg: _currentOrg,
    setCurrentOrg: mockSetCurrentOrg,
    createOrganization: vi.fn(),
    refresh: vi.fn(),
    isAccountantOnly: true,
    loading: _loading,
  }),
}));

const SAMPLE: Organization[] = [
  {
    id: 'org-acme',
    name: 'Acme Plumbing',
    organization_type: 'standard',
    abn: '12 345 678 901',
    role_enum: 'accountant',
    accepted_at: '2026-06-01T00:00:00Z',
    entity_type: 'company',
  },
  {
    id: 'org-beta',
    name: 'Beta Builders',
    organization_type: 'standard',
    abn: null,
    role_enum: 'accountant',
    accepted_at: '2026-06-02T00:00:00Z',
    entity_type: null,
  },
];

describe('ClientsPage', () => {
  beforeEach(() => {
    _clients = [];
    _currentOrg = null;
    _loading = false;
    mockNavigate.mockClear();
    mockSetCurrentOrg.mockClear();
  });

  it('renders the page heading', () => {
    render(<ClientsPage />);
    expect(screen.getByRole('heading', { name: /clients/i })).toBeInTheDocument();
  });

  it('shows the empty state when there are no clients', () => {
    render(<ClientsPage />);
    expect(screen.getByText(/no clients yet/i)).toBeInTheDocument();
  });

  it('renders a card per client with name, entity type and ABN', () => {
    _clients = SAMPLE;
    render(<ClientsPage />);

    expect(screen.getByText('Acme Plumbing')).toBeInTheDocument();
    expect(screen.getByText('Beta Builders')).toBeInTheDocument();
    // entity label mapping
    expect(screen.getByText('Company')).toBeInTheDocument();
    expect(screen.getByText('Entity type not set')).toBeInTheDocument();
    // ABN present vs missing
    expect(screen.getByText('ABN 12 345 678 901')).toBeInTheDocument();
    expect(screen.getByText('ABN not set')).toBeInTheDocument();
  });

  it('switches org and navigates home when a card is clicked', () => {
    _clients = SAMPLE;
    render(<ClientsPage />);

    fireEvent.click(screen.getByText('Acme Plumbing'));

    expect(mockSetCurrentOrg).toHaveBeenCalledWith(expect.objectContaining({ id: 'org-acme' }));
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  it('marks the current org card as "Current — open"', () => {
    _clients = SAMPLE;
    _currentOrg = SAMPLE[0] ?? null;
    render(<ClientsPage />);
    expect(screen.getByText(/current — open/i)).toBeInTheDocument();
  });
});
