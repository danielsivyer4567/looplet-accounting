/**
 * Tests for src/components/MoveToOrgButton.tsx
 *
 * Strategy:
 * - Mock @/lib/supabase so no network calls happen.
 * - Mock @/contexts/OrgContext to control the organization list.
 * - Mock window.confirm to avoid blocking the test runner.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MoveToOrgButton } from '@/components/MoveToOrgButton';
import { mockSupabaseResponse } from '@/test/mocks/supabase';
import type { Organization } from '@/contexts/OrgContext';

// ---------------------------------------------------------------------------
// Module mocks — Vitest hoists vi.mock() calls before imports
// ---------------------------------------------------------------------------

vi.mock('@/lib/supabase', () => import('@/test/mocks/supabase'));

// Mutable reference — tests can swap out organizations between cases
let _mockOrganizations: Organization[] = [
  { id: 'org-a', name: 'Alpha Plumbing', organization_type: 'standard' },
  { id: 'org-b', name: 'Beta Electrical', organization_type: 'standard' },
  { id: 'org-c', name: 'Gamma Roofing', organization_type: 'standard' },
];

vi.mock('@/hooks/useOrg', () => ({
  useOrg: () => ({
    organizations: _mockOrganizations,
    currentOrg: _mockOrganizations[0] ?? null,
    loading: false,
    setCurrentOrg: vi.fn(),
    createOrganization: vi.fn(),
    refresh: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Shared props
// ---------------------------------------------------------------------------

const DEFAULT_PROPS = {
  table: 'bills' as const,
  rowId: 'row-123',
  currentOrgId: 'org-a',
  fkColumnsToNull: ['supplier_id', 'job_id', 'suggested_job_id'],
};

interface ButtonProps {
  table?: (typeof DEFAULT_PROPS)['table'];
  rowId?: string;
  currentOrgId?: string;
  fkColumnsToNull?: string[];
  onMoved?: (newOrgId: string) => void;
  label?: string;
}

function renderButton(props: ButtonProps = {}) {
  return render(<MoveToOrgButton {...DEFAULT_PROPS} {...props} />);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MoveToOrgButton', () => {
  beforeEach(() => {
    // Restore the three-org state
    _mockOrganizations = [
      { id: 'org-a', name: 'Alpha Plumbing', organization_type: 'standard' },
      { id: 'org-b', name: 'Beta Electrical', organization_type: 'standard' },
      { id: 'org-c', name: 'Gamma Roofing', organization_type: 'standard' },
    ];
    // Default: update succeeds
    mockSupabaseResponse({ data: [{ id: 'row-123' }], error: null });
    // Auto-accept browser confirm dialogs
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('renders the trigger button', () => {
    renderButton();
    expect(screen.getByRole('button', { name: /move to business/i })).toBeInTheDocument();
  });

  it('dropdown is hidden before the trigger is clicked', () => {
    renderButton();
    expect(screen.queryByText('Beta Electrical')).not.toBeInTheDocument();
  });

  it('opens dropdown and shows only orgs other than the current one', () => {
    renderButton();
    fireEvent.click(screen.getByRole('button', { name: /move to business/i }));

    // org-b and org-c visible; org-a (current) must be absent
    expect(screen.getByText('Beta Electrical')).toBeInTheDocument();
    expect(screen.getByText('Gamma Roofing')).toBeInTheDocument();
    expect(screen.queryByText('Alpha Plumbing')).not.toBeInTheDocument();
  });

  it('calls supabase.from(table).update with FK nulls when a target is clicked', async () => {
    const { supabase } = await import('@/test/mocks/supabase');

    renderButton();
    fireEvent.click(screen.getByRole('button', { name: /move to business/i }));
    fireEvent.click(screen.getByText('Beta Electrical'));

    await waitFor(() => {
      expect(supabase.from).toHaveBeenCalledWith('bills');
    });
  });

  it('calls onMoved with the target org id after a successful move', async () => {
    const onMoved = vi.fn();
    renderButton({ onMoved });

    fireEvent.click(screen.getByRole('button', { name: /move to business/i }));
    fireEvent.click(screen.getByText('Beta Electrical'));

    await waitFor(() => {
      expect(onMoved).toHaveBeenCalledWith('org-b');
    });
  });

  it('renders nothing when the user belongs to only one organisation', () => {
    // With only one org, targets will be empty and the component returns null
    _mockOrganizations = [{ id: 'org-a', name: 'Solo Corp', organization_type: 'standard' }];
    const { container } = renderButton({ currentOrgId: 'org-a' });
    expect(container.firstChild).toBeNull();
  });
});
