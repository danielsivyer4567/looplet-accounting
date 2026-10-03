/**
 * LODGE-01: nothing claims to lodge with the ATO or send to a super fund when Looplet only prepares
 * a file. No screen submits anything to the ATO (ato-lodge is a fail-closed scaffold), and
 * super-batch-send only generates a clearing-house file. The old copy said "Lodge" in the nav,
 * "Lodge BAS, tax returns" on the dashboard, "Request lodge approval" on the BAS card, offered a
 * "Lodge return" button on SMSF, and showed super batches as "sent".
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BasWorksheetPayload, BasBlockers } from '@/hooks/useBasWorksheet';
import type { SuperBatch } from '@/hooks/useSuperBatch';

const h = vi.hoisted(() => ({
  worksheet: null as unknown,
  requestLodgeApproval: vi.fn(),
  batch: null as unknown,
  send: vi.fn(),
}));

vi.mock('@/lib/supabase', () => import('@/test/mocks/supabase'));
vi.mock('@/hooks/useOrg', () => {
  const currentOrg = { id: 'org-1', name: 'Test Org', organization_type: 'standard' };
  const value = {
    organizations: [currentOrg],
    currentOrg,
    loading: false,
    setCurrentOrg: vi.fn(),
    createOrganization: vi.fn(),
    refresh: vi.fn(),
    accountantClientOrgs: [],
    isAccountantOnly: false,
  };
  return { useOrg: () => value };
});
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'user-1', email: 'owner@example.com' }, signOut: vi.fn() }),
}));
vi.mock('@/hooks/useAccountantHeartbeat', () => ({ useAccountantHeartbeat: () => undefined }));
vi.mock('@/hooks/useTaxCalendar', () => ({
  buildObligationPrompt: () => '',
  useTaxCalendar: () => ({ obligations: [], loading: false, error: null }),
}));
vi.mock('@/contexts/theme-context', () => ({
  useTheme: () => ({ theme: 'light', toggleTheme: vi.fn() }),
}));
vi.mock('@/components/OrgSelector', () => ({ OrgSelector: () => null }));
vi.mock('@/components/NotificationBell', () => ({ NotificationBell: () => null }));
vi.mock('@/hooks/useBasWorksheet', () => ({
  useBasWorksheet: () => ({
    worksheet: h.worksheet,
    blockers: {
      treatmentExceptions: 0,
      reconciliationVarianceCents: 0,
      gstCoverageReady: true,
      gstCoveragePct: 100,
      billsInScope: 1,
      billsComplete: 1,
      billsGstEstimated: 0,
    } satisfies BasBlockers,
    loading: false,
    error: null,
    refresh: vi.fn(),
    requestLodgeApproval: h.requestLodgeApproval,
  }),
}));
vi.mock('@/hooks/useSuperBatch', () => ({
  useSuperBatch: () => ({
    batch: h.batch,
    loading: false,
    error: null,
    refresh: vi.fn(),
    generate: vi.fn(),
    send: h.send,
  }),
}));
vi.mock('@/hooks/useLodgements', () => ({
  useLodgements: () => ({ lodgements: [], loading: false, error: null, refresh: vi.fn() }),
}));
vi.mock('@/hooks/useBasLodgementPack', () => ({
  useBasLodgementPack: () => ({ busyId: null, error: null, downloadPack: vi.fn() }),
}));

import { Layout } from '@/components/Layout';
import { IntentLauncher } from '@/components/IntentLauncher';
import { BasPrepCard } from '@/pages/reports/Bas';
import { SuperBatchSection } from '@/pages/Payroll';
import { LodgementsPage } from '@/pages/Lodgements';

// Copy that says or implies Looplet lodges, submits or sends on the user's behalf.
const CLAIMS = [
  /label: 'Lodge'/,
  /Lodge BAS, tax returns/,
  /Request lodge approval/,
  /approved lodge flow/,
  />\s*Lodge return\s*</,
  /approve and lodge the return \(Phase 7\)/,
  /Submitted payload/,
  /lodgement ledger rows/,
  /SuperStream clearing-house file exported/,
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.tsx') ? [path] : [];
  });
}

const BATCH: SuperBatch = {
  id: 'batch-1',
  status: 'file_prepared',
  total_super_cents: 12000,
  line_count: 1,
  fy_start_year: 2026,
  quarter: 1,
  lines: [
    {
      id: 'line-1',
      employee_id: 'emp-1',
      employee_name: 'Emp A',
      super_cents: 12000,
      fund_name: 'Aware Super',
      fund_usi: 'USI1',
      member_number: 'MEM1',
      validation_errors: [],
    },
  ],
};

describe('nothing claims to lodge or send when it only prepares (LODGE-01)', () => {
  beforeEach(() => {
    localStorage.clear();
    h.requestLodgeApproval = vi.fn().mockResolvedValue(undefined);
    h.send = vi.fn();
    h.batch = null;
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  it('the navigation says Prepare, not Lodge', () => {
    render(
      <MemoryRouter initialEntries={['/lodgements']}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/lodgements" element={<div>body</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    const link = screen.getByRole('link', { name: /^Prepare$/ });
    expect(link).toHaveAttribute('href', '/lodgements');
    expect(screen.queryByRole('link', { name: /^Lodge$/ })).not.toBeInTheDocument();
  });

  it('the dashboard quick action prepares tax rather than lodging it', () => {
    render(
      <MemoryRouter>
        <IntentLauncher />
      </MemoryRouter>,
    );
    expect(screen.getByText('Prepare tax').closest('a')).toHaveAttribute('href', '/lodgements');
    expect(screen.getByText('Prepare BAS and returns to lodge')).toBeInTheDocument();
    expect(screen.queryByText(/^Lodge /)).not.toBeInTheDocument();
  });

  it('the prepared-returns page says Looplet does not lodge', () => {
    render(<LodgementsPage />);
    expect(screen.getByRole('heading', { name: 'Prepared returns' })).toBeInTheDocument();
    expect(screen.getByText(/Looplet does not lodge with the ATO/)).toBeInTheDocument();
  });

  it('approving a BAS says it is prepared, and that the user lodges it', async () => {
    h.worksheet = {
      organization_id: 'org-1',
      fy_start_year: 2025,
      quarter: 4,
      quarter_start: '2026-04-01',
      quarter_end: '2026-06-30',
      due_date: '2026-07-28',
      gst: { G1: 110000, G10: 0, G11: 55000, '1A': 10000, '1B': 5000 },
      payg_withholding: { W1: 0, W2: 0, W4: 0, W5: 0, '4': 0 },
      payg_instalment: null,
      summary: { '9_net_amount_cents': 5000 },
    } satisfies BasWorksheetPayload;
    render(<BasPrepCard fy={2025} quarter={4} quarterName="Q4 (Apr-Jun)" dueDate="2026-07-28" />);
    expect(screen.getByText(/Looplet prepares the BAS; it does not lodge it/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /request approval of prepared bas/i }));
    await waitFor(() => expect(h.requestLodgeApproval).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Looplet does not lodge with the ATO/)).toBeInTheDocument();
  });

  it('a prepared super batch shows as file prepared, not sent or paid', async () => {
    h.batch = BATCH;
    h.send = vi.fn().mockResolvedValue({
      ok: true,
      already_prepared: true,
      file_prepared: true,
      status: 'file_prepared',
      payload: { schema_version: 'build_superstream_payload:v1' },
    });
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:superstream');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    render(<SuperBatchSection fy={2026} quarter={1} />);

    expect(screen.getByText('File prepared, not paid')).toBeInTheDocument();
    expect(screen.queryByText(/^sent$/i)).not.toBeInTheDocument();
    expect(
      screen.getByText(/does not send contributions to funds or pay them/),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /download file again/i }));
    await waitFor(() => expect(h.send).toHaveBeenCalledTimes(1));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/has not sent or paid anything/)).toBeInTheDocument();
    createObjectURL.mockRestore();
    revokeObjectURL.mockRestore();
  });

  it('a newly prepared super file says nothing was sent or paid', async () => {
    h.batch = { ...BATCH, status: 'approved' };
    h.send = vi.fn().mockResolvedValue({
      ok: true,
      file_prepared: true,
      status: 'file_prepared',
      payload: { schema_version: 'build_superstream_payload:v1' },
    });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:superstream');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    render(<SuperBatchSection fy={2026} quarter={1} />);

    fireEvent.click(screen.getByRole('button', { name: /approve & export/i }));
    expect(await screen.findByText(/Looplet has not sent it or paid anything/)).toBeInTheDocument();
  });

  it('no page, the nav or the quick actions carry the old lodge/send claims', () => {
    const files = [
      ...sourceFiles(join(process.cwd(), 'src/pages')),
      join(process.cwd(), 'src/components/IntentLauncher.tsx'),
      join(process.cwd(), 'src/components/Layout.tsx'),
    ];
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const claim of CLAIMS) if (claim.test(text)) offenders.push(`${file}: ${claim}`);
    }
    expect(offenders).toEqual([]);
  });
});
