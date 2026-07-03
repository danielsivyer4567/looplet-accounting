import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TriagePage } from '@/pages/onboarding/Triage';

interface MockStagedEntity {
  id: string;
  organization_id: string;
  canonical_key: string;
  display_name: string;
  primary_email: string;
  observed_emails: string[];
  observed_domains: string[];
  abn: string | null;
  message_count: number;
  attachment_count: number;
  total_amount_seen_cents: number;
  first_seen_at: string;
  last_seen_at: string;
  sample_subjects: string[];
  sample_message_ids: string[];
  predicted_kind: string;
  predicted_category: string;
  prediction_reason: string;
  confidence: number;
  status: string;
  user_kind: string | null;
  user_category: string | null;
  is_recurring: boolean;
  sonar_summary: string | null;
  sonar_suggested_kind: string | null;
  sonar_suggested_category: string | null;
  sonar_confidence: number | null;
  sonar_evidence_url: string | null;
  sonar_enriched_at: string | null;
}

const mocks = vi.hoisted(() => ({
  org: { id: 'org-1', name: 'Test Org', organization_type: 'standard' },
  refresh: vi.fn(),
  entities: [
    {
      id: 'stage-1',
      organization_id: 'org-1',
      canonical_key: 'domain:acme.example',
      display_name: 'ACME Supplies',
      primary_email: 'accounts@acme.example',
      observed_emails: ['accounts@acme.example'],
      observed_domains: ['acme.example'],
      abn: '12345678901',
      message_count: 14,
      attachment_count: 3,
      total_amount_seen_cents: 128900,
      first_seen_at: '2026-06-01T00:00:00Z',
      last_seen_at: '2026-06-28T00:00:00Z',
      sample_subjects: ['Invoice 1004 from ACME Supplies', 'Statement for June'],
      sample_message_ids: ['msg-1', 'msg-2'],
      predicted_kind: 'supplier',
      predicted_category: 'office_expenses',
      prediction_reason: 'Recurring invoices from a supplier domain',
      confidence: 0.91,
      status: 'pending',
      user_kind: null,
      user_category: null,
      is_recurring: true,
      sonar_summary: 'Office supplier with public product catalogue.',
      sonar_suggested_kind: 'supplier',
      sonar_suggested_category: 'office_expenses',
      sonar_confidence: 0.92,
      sonar_evidence_url: 'https://example.com/acme',
      sonar_enriched_at: '2026-07-01T00:00:00Z',
    },
  ] as MockStagedEntity[],
  categories: [
    {
      code: 'office_expenses',
      label: 'Office expenses',
      xero_account_code: '453',
      xero_tax_type: 'INPUT',
      description: null,
      is_business: true,
      side: 'expense',
      sort_order: 1,
    },
    {
      code: 'customer_payment',
      label: 'Customer payment',
      xero_account_code: '200',
      xero_tax_type: 'OUTPUT',
      description: null,
      is_business: true,
      side: 'income',
      sort_order: 2,
    },
  ],
  operations: [] as { table: string; method: string; payload?: unknown; args?: unknown[] }[],
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

vi.mock('@/hooks/onboarding/useStagedEntities', () => ({
  useStagedEntities: () => ({
    entities: mocks.entities,
    progress: {
      total_entities: 1,
      pending_count: 1,
      needs_review_count: 0,
      approved_count: 0,
      dismissed_count: 0,
      pct_complete: 0,
      is_complete: false,
    },
    loading: false,
    refresh: mocks.refresh,
  }),
}));

vi.mock('@/hooks/useIntakeCategories', () => ({
  useIntakeCategories: () => ({
    categories: mocks.categories,
    loading: false,
  }),
}));

vi.mock('@/lib/supabase', () => {
  const resultFor = (table: string) => {
    if (table === 'customers') return { data: { id: 'customer-1' }, error: null };
    if (table === 'suppliers') return { data: { id: 'supplier-1' }, error: null };
    return { data: null, error: null };
  };

  const builder = (table: string) => {
    const chain: Record<string, unknown> = {};
    ['select', 'eq'].forEach((method) => {
      chain[method] = (...args: unknown[]) => {
        mocks.operations.push({ table, method, args });
        return chain;
      };
    });
    ['update', 'upsert', 'insert'].forEach((method) => {
      chain[method] = (payload: unknown, ...args: unknown[]) => {
        mocks.operations.push({ table, method, payload, args });
        return chain;
      };
    });
    chain.single = () => Promise.resolve(resultFor(table));
    chain.then = (resolveValue: (value: unknown) => unknown) =>
      Promise.resolve(resultFor(table)).then(resolveValue);
    return chain;
  };

  return {
    supabase: {
      auth: {
        getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
      },
      from: vi.fn((table: string) => builder(table)),
    },
  };
});

function renderPage() {
  return render(
    <MemoryRouter>
      <TriagePage />
    </MemoryRouter>,
  );
}

describe('TriagePage', () => {
  beforeEach(() => {
    mocks.operations = [];
    mocks.refresh.mockClear();
    mocks.entities = [
      {
        id: 'stage-1',
        organization_id: 'org-1',
        canonical_key: 'domain:acme.example',
        display_name: 'ACME Supplies',
        primary_email: 'accounts@acme.example',
        observed_emails: ['accounts@acme.example'],
        observed_domains: ['acme.example'],
        abn: '12345678901',
        message_count: 14,
        attachment_count: 3,
        total_amount_seen_cents: 128900,
        first_seen_at: '2026-06-01T00:00:00Z',
        last_seen_at: '2026-06-28T00:00:00Z',
        sample_subjects: ['Invoice 1004 from ACME Supplies', 'Statement for June'],
        sample_message_ids: ['msg-1', 'msg-2'],
        predicted_kind: 'supplier',
        predicted_category: 'office_expenses',
        prediction_reason: 'Recurring invoices from a supplier domain',
        confidence: 0.91,
        status: 'pending',
        user_kind: null,
        user_category: null,
        is_recurring: true,
        sonar_summary: 'Office supplier with public product catalogue.',
        sonar_suggested_kind: 'supplier',
        sonar_suggested_category: 'office_expenses',
        sonar_confidence: 0.92,
        sonar_evidence_url: 'https://example.com/acme',
        sonar_enriched_at: '2026-07-01T00:00:00Z',
      },
    ];
  });

  it('renders staged senders as mobile cards as well as the desktop review table', () => {
    renderPage();

    const table = screen.getByRole('table');
    expect(table).toHaveClass('table-premium');
    expect(table.closest('.triage-table-view')).toBeInTheDocument();

    const cards = screen.getByLabelText(/suppliers mobile triage cards/i);
    expect(within(cards).getByText('ACME Supplies')).toBeInTheDocument();
    expect(within(cards).getByText('accounts@acme.example')).toBeInTheDocument();
    expect(within(cards).getByText('Invoice 1004 from ACME Supplies')).toBeInTheDocument();
    expect(within(cards).getByText('Emails')).toBeInTheDocument();
    expect(within(cards).getByText('14')).toBeInTheDocument();
    expect(within(cards).getByLabelText('Category for ACME Supplies')).toHaveValue(
      'office_expenses',
    );
    expect(within(cards).getByRole('button', { name: /^Approve$/i })).toBeEnabled();
    expect(within(cards).getByRole('button', { name: /dismiss/i })).toBeEnabled();
  });

  it('has a breakpoint contract for triage table-to-card layout', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');

    expect(css).toMatch(
      /@media \(max-width: 768px\)[\s\S]*\.triage-table-view\s*\{[\s\S]*display: none/,
    );
    expect(css).toMatch(
      /@media \(max-width: 768px\)[\s\S]*\.triage-card-view\s*\{[\s\S]*display: grid/,
    );
  });

  it('approves customer staged entities into customers and intake rules', async () => {
    mocks.entities = [
      {
        id: 'stage-customer-1',
        organization_id: 'org-1',
        canonical_key: 'domain:client.example',
        display_name: 'Client Build Co',
        primary_email: 'accounts@client.example',
        observed_emails: ['accounts@client.example'],
        observed_domains: ['client.example'],
        abn: null,
        message_count: 6,
        attachment_count: 0,
        total_amount_seen_cents: 330000,
        first_seen_at: '2026-06-05T00:00:00Z',
        last_seen_at: '2026-06-29T00:00:00Z',
        sample_subjects: ['Payment remittance INV-42'],
        sample_message_ids: ['msg-customer-1'],
        predicted_kind: 'customer',
        predicted_category: 'customer_payment',
        prediction_reason: 'Incoming payment remittances from customer domain',
        confidence: 0.88,
        status: 'pending',
        user_kind: null,
        user_category: null,
        is_recurring: false,
        sonar_summary: null,
        sonar_suggested_kind: null,
        sonar_suggested_category: null,
        sonar_confidence: null,
        sonar_evidence_url: null,
        sonar_enriched_at: null,
      },
    ];

    renderPage();

    const cards = screen.getByLabelText(/customers mobile triage cards/i);
    fireEvent.click(within(cards).getByRole('button', { name: /^Approve$/i }));

    await waitFor(() => {
      expect(mocks.operations).toContainEqual({
        table: 'customers',
        method: 'upsert',
        payload: {
          organization_id: 'org-1',
          name: 'Client Build Co',
          email: 'accounts@client.example',
        },
        args: [{ onConflict: 'organization_id,name', ignoreDuplicates: false }],
      });
    });
    expect(mocks.operations).toContainEqual({
      table: 'intake_rules',
      method: 'insert',
      payload: {
        organization_id: 'org-1',
        matcher_type: 'sender_domain',
        matcher_value: 'client.example',
        matcher_priority: 100,
        category_code: 'customer_payment',
        supplier_id: null,
        customer_id: 'customer-1',
        is_personal: false,
        skip_ocr: false,
        notes: 'Auto Setup — predicted customer (0.88)',
      },
      args: [],
    });
    expect(mocks.operations).toContainEqual({
      table: 'staged_entities',
      method: 'update',
      payload: expect.objectContaining({
        status: 'approved',
        user_kind: 'customer',
        user_category: 'customer_payment',
      }),
      args: [],
    });
    expect(mocks.operations).toContainEqual({
      table: 'staged_entities',
      method: 'update',
      payload: {
        resolved_supplier_id: null,
        resolved_customer_id: 'customer-1',
      },
      args: [],
    });
    expect(mocks.refresh).toHaveBeenCalled();
  });
});
