/**
 * FAKE-02: the Scan page describes only the checks it really runs.
 *
 * The old page showed an "AI AUDIT ACTIVE" badge and, while one database call ran, a progress bar
 * that cycled invented steps ("Checking supplier tax file declarations…", "Cross-referencing ledger
 * entries against ATO rules…") and held the result back for at least 2.4 seconds. The only thing it
 * ran was public.run_data_completeness_scan, a fixed set of SQL checks. The page now lists those
 * checks, and this test keeps the list in step with the latest SQL definition.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ScanPage } from '@/pages/Scan';
import { mockSupabaseResponse, supabase } from '@/test/mocks/supabase';

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
  };
  return { useOrg: () => value };
});

const INVENTED_STEPS = [
  /ai audit/i,
  /auditing invoice integrity/i,
  /supplier tax file declarations/i,
  /payroll superannuation compliance/i,
  /cross-referencing ledger entries/i,
  /compliance risk score/i,
  /audit complete/i,
  /tax-ready/i,
  /against australian tax regulations/i,
];

/** The check codes the latest migration's run_data_completeness_scan inserts findings for. */
function sqlCheckCodes(): { file: string; body: string; codes: string[] } {
  const dir = join(process.cwd(), 'supabase/migrations');
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const definitions = files
    .map((file) => ({ file, sql: readFileSync(join(dir, file), 'utf8') }))
    .filter(({ sql }) => /CREATE OR REPLACE FUNCTION public\.run_data_completeness_scan\(/.test(sql));
  const latest = definitions[definitions.length - 1];
  if (!latest) throw new Error('no migration defines run_data_completeness_scan');
  const start = latest.sql.search(/CREATE OR REPLACE FUNCTION public\.run_data_completeness_scan\(/);
  const end = latest.sql.indexOf('$function$;', start);
  const body = latest.sql.slice(start, end);
  const codes = [...body.matchAll(/SELECT p_org_id, '([a-z0-9_]+)'/g)].map((m) => m[1] as string);
  return { file: latest.file, body, codes };
}

function renderScan() {
  return render(
    <MemoryRouter>
      <ScanPage />
    </MemoryRouter>,
  );
}

describe('Scan page describes only the checks it runs (FAKE-02)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSupabaseResponse({ data: [], error: null });
  });

  it('lists exactly the checks run_data_completeness_scan runs', async () => {
    renderScan();
    await screen.findByRole('heading', { name: /what these checks look at/i });

    const listed = Array.from(document.querySelectorAll('[data-check-code]')).map((li) =>
      li.getAttribute('data-check-code'),
    );
    const { codes } = sqlCheckCodes();
    expect(codes.length).toBeGreaterThan(0);
    expect([...listed].sort()).toEqual([...codes].sort());
    expect(screen.getByText(new RegExp(`runs ${codes.length} fixed checks`, 'i'))).toBeInTheDocument();
    expect(screen.getByText(/not an audit and does not check every tax rule/i)).toBeInTheDocument();
  });

  it('shows no AI-audit badge or invented scan steps, before, during or after a run', async () => {
    let finish: (value: unknown) => void = () => undefined;
    (supabase.rpc as unknown as Mock).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    renderScan();
    await screen.findByRole('button', { name: /run checks now/i });
    for (const step of INVENTED_STEPS) expect(document.body.textContent).not.toMatch(step);

    fireEvent.click(screen.getByRole('button', { name: /run checks now/i }));
    expect(await screen.findByRole('button', { name: /running checks/i })).toBeDisabled();
    await new Promise((resolve) => setTimeout(resolve, 400));
    for (const step of INVENTED_STEPS) expect(document.body.textContent).not.toMatch(step);
    expect(document.body.textContent).not.toMatch(/\d+%/);

    finish({
      data: {
        ok: true,
        critical: 0,
        warning: 1,
        info: 0,
        resolved_this_run: 0,
        scanned_at: '2026-10-03T00:00:00Z',
      },
      error: null,
    });
    // The result shows as soon as the database answers: no padded "thorough" delay.
    expect(await screen.findByText(/last run: 0 critical, 1 warnings/i)).toBeInTheDocument();
    for (const step of INVENTED_STEPS) expect(document.body.textContent).not.toMatch(step);
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    expect(supabase.rpc).toHaveBeenCalledWith('run_data_completeness_scan', { p_org_id: 'org-1' });
  });

  it('an empty result claims only that these checks found nothing', async () => {
    renderScan();
    expect(await screen.findByText(/no open findings from these checks/i)).toBeInTheDocument();
    expect(screen.getByText(/it is not a full tax review/i)).toBeInTheDocument();
  });

  it('the SQL finding text says what each check tests', () => {
    const { body } = sqlCheckCodes();
    // bill_high_value_no_attachment tests bills.attached_at (attached to a job), not a missing document.
    expect(body).not.toMatch(/no attached invoice\/receipt/);
    expect(body).not.toMatch(/no source document attached/);
    expect(body).toMatch(/is not attached to a job/);
    // bill_gst_mismatch compares with 1/11; mixed taxable and GST-free bills legitimately differ.
    expect(body).not.toMatch(/GST should be ~/);
    expect(body).toMatch(/mixes taxable and GST-free items/);
  });
});
