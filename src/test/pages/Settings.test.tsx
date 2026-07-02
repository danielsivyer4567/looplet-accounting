import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SettingsPage } from '@/pages/Settings';
import { RoadmapPage } from '@/pages/Roadmap';

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
        <Route path="/roadmap" element={<RoadmapPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Settings roadmap link', () => {
  it('links users to the roadmap instead of showing a static coming-next note', () => {
    renderSettings();

    expect(screen.queryByText(/coming next/i)).not.toBeInTheDocument();

    const roadmapLink = screen.getByRole('link', { name: /open roadmap/i });
    expect(roadmapLink).toHaveAttribute('href', '/roadmap');

    fireEvent.click(roadmapLink);

    expect(screen.getByRole('heading', { name: 'Roadmap' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /quality queue/i })).toHaveAttribute(
      'href',
      '/quality',
    );
  });
});
