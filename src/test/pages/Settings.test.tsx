import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SettingsPage } from '@/pages/Settings';

const currentOrg = { id: 'org-1', name: 'Test Org', organization_type: 'standard' };

vi.mock('@/hooks/useOrg', () => ({
  useOrg: () => ({
    organizations: [currentOrg],
    currentOrg,
    loading: false,
    setCurrentOrg: vi.fn(),
    createOrganization: vi.fn(),
    refresh: vi.fn(),
  }),
}));

function renderSettings() {
  return render(
    <MemoryRouter initialEntries={['/settings']}>
      <Routes>
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Settings info card', () => {
  it('shows no aspirational coming-next or roadmap copy', () => {
    renderSettings();

    expect(screen.queryByText(/coming next/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/coming soon/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /open roadmap/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Accounting Preferences/i)).toBeInTheDocument();
  });
});
