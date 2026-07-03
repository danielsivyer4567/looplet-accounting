import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LodgementRow } from '@/hooks/useLodgements';

const h = vi.hoisted(() => ({
  lodgements: [] as LodgementRow[],
  loading: false,
  error: null as string | null,
  refresh: vi.fn(),
  downloadPack: vi.fn(),
  packBusyId: null as string | null,
  packError: null as string | null,
}));

vi.mock('@/hooks/useLodgements', () => ({
  useLodgements: () => ({
    lodgements: h.lodgements,
    loading: h.loading,
    error: h.error,
    refresh: h.refresh,
  }),
}));

vi.mock('@/hooks/useBasLodgementPack', () => ({
  useBasLodgementPack: () => ({
    busyId: h.packBusyId,
    error: h.packError,
    downloadPack: h.downloadPack,
  }),
}));

import { LodgementsPage } from '@/pages/Lodgements';

const ROW: LodgementRow = {
  id: 'lodgement-1',
  organization_id: 'org-1',
  lodgement_type: 'bas',
  period_label: 'Q4 FY2025-26',
  payload_hash: 'abcdef1234567890abcdef1234567890',
  payload: { document: 'BAS', period: 'Q4 FY2025-26', net_gst_cents: 24000 },
  ato_receipt_id: 'ATO-123',
  status: 'accepted',
  submitted_at: '2026-06-27T10:00:00Z',
  response: { outcome: 'accepted' },
  error_message: null,
  created_at: '2026-06-27T09:55:00Z',
  updated_at: '2026-06-27T10:00:00Z',
  created_by: 'user-1',
};

describe('LodgementsPage', () => {
  beforeEach(() => {
    h.lodgements = [ROW];
    h.loading = false;
    h.error = null;
    h.refresh = vi.fn();
    h.downloadPack = vi.fn();
    h.packBusyId = null;
    h.packError = null;
  });

  it('lists lodgements and opens submitted payload details', () => {
    render(<LodgementsPage />);

    expect(screen.getByRole('heading', { name: 'Lodgements' })).toBeInTheDocument();
    expect(screen.getByText('Q4 FY2025-26')).toBeInTheDocument();
    expect(screen.getAllByText('Accepted').length).toBeGreaterThan(0);
    expect(screen.getByText('ATO-123')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /View payload/i }));

    expect(screen.getByRole('heading', { name: 'Submitted payload' })).toBeInTheDocument();
    expect(screen.getByText(/net_gst_cents/)).toBeInTheDocument();
    expect(screen.getByText(/accepted/)).toBeInTheDocument();
  });

  it('downloads a BAS review pack for the selected lodgement', () => {
    render(<LodgementsPage />);

    fireEvent.click(screen.getByRole('button', { name: /View payload/i }));
    fireEvent.click(screen.getByRole('button', { name: /Download BAS pack/i }));

    expect(h.downloadPack).toHaveBeenCalledWith(ROW);
  });

  it('refreshes without mutating lodgements', () => {
    render(<LodgementsPage />);

    fireEvent.click(screen.getByRole('button', { name: /Refresh/i }));

    expect(h.refresh).toHaveBeenCalledTimes(1);
  });
});
