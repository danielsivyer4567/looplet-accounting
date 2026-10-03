import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BankFeedLink, type FeedAccountView } from '@/components/settings/BankFeedLink';
import { defaultImportFrom, todayAest } from '@/lib/bankFeedDates';

const mocks = vi.hoisted(() => ({
  enqueueJob: vi.fn(),
}));

vi.mock('@/lib/automationJobs', () => ({ enqueueJob: mocks.enqueueJob }));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(() =>
        Promise.resolve({ data: { session: { access_token: 'user-token' } }, error: null }),
      ),
    },
  },
}));

const ORG = 'org-1';

const account = (overrides: Partial<FeedAccountView>): FeedAccountView => ({
  account_id: 'acct-main',
  connection_id: 'rb-conn-1',
  name: 'Business Transaction',
  institution: 'Commonwealth Bank',
  account_last4: '2894',
  account_type: 'transaction',
  currency: 'AUD',
  status: 'available',
  link: null,
  ...overrides,
});

const ACCOUNTS: FeedAccountView[] = [
  account({}),
  account({
    account_id: 'acct-saver',
    name: 'Business Saver',
    account_last4: '2069',
    status: 'linked',
    link: {
      bank_connection_id: 'bc-1',
      bank_account_id: 'ba-1',
      sync_from: '2026-07-01',
      covered_through: '2026-10-02',
    },
  }),
  account({
    account_id: 'acct-other',
    connection_id: 'rb-conn-2',
    name: 'Other business',
    institution: 'NAB',
    account_last4: '1111',
    status: 'linked_elsewhere',
  }),
  account({
    account_id: 'acct-usd',
    name: 'USD Account',
    account_last4: '7777',
    currency: 'USD',
    status: 'not_aud',
  }),
];

interface Reply {
  status?: number;
  body: unknown;
}

function mockFunctions(replies: Record<string, Reply[]>) {
  const calls: { name: string; body: Record<string, unknown>; auth: string | null }[] = [];
  const fetchMock = vi.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
    const name = String(input).split('/functions/v1/')[1] ?? '';
    const headers = new Headers(init?.headers);
    calls.push({
      name,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      auth: headers.get('Authorization'),
    });
    const queue = replies[name] ?? [];
    const reply = queue.length > 1 ? queue.shift() : queue[0];
    if (!reply) throw new Error(`unexpected call to ${name}`);
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
  });
  return { calls, fetchMock };
}

describe('BankFeedLink', () => {
  beforeEach(() => {
    mocks.enqueueJob.mockReset();
    mocks.enqueueJob.mockResolvedValue({ id: 'job-1' });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists the Redbark accounts only when asked, with each account's link state", async () => {
    const { calls } = mockFunctions({
      'bank-feed-accounts': [{ body: { ok: true, accounts: ACCOUNTS } }],
    });
    render(<BankFeedLink organizationId={ORG} />);
    expect(calls).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: /show redbark accounts/i }));
    const list = await screen.findByRole('list', { name: /redbark accounts/i });
    expect(calls).toEqual([
      { name: 'bank-feed-accounts', body: { organization_id: ORG }, auth: 'Bearer user-token' },
    ]);

    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(4);
    const [available, linked, elsewhere, foreign] = items as [
      HTMLElement,
      HTMLElement,
      HTMLElement,
      HTMLElement,
    ];
    expect(available).toHaveTextContent('Commonwealth Bank · Business Transaction');
    expect(available).toHaveTextContent('•••• 2894');
    expect(within(available).getByLabelText('Import from')).toHaveValue(defaultImportFrom());
    expect(within(available).getByLabelText('Import from')).toHaveAttribute('max', todayAest());
    expect(linked).toHaveTextContent(
      'Linked · importing from 2026-07-01 · history imported through 2026-10-02',
    );
    expect(elsewhere).toHaveTextContent('Linked to another organisation');
    expect(foreign).toHaveTextContent('Not an Australian dollar account');
    // Only the available account can be linked.
    expect(within(list).getAllByRole('button', { name: /^link /i })).toHaveLength(1);
  });

  it('links an account with the chosen import-from date, then queues its first import and says so plainly', async () => {
    const linked = ACCOUNTS.map((a) =>
      a.account_id === 'acct-main'
        ? {
            ...a,
            status: 'linked' as const,
            link: {
              bank_connection_id: 'bc-1',
              bank_account_id: 'ba-2',
              sync_from: '2026-08-01',
              covered_through: null,
            },
          }
        : a,
    );
    const { calls } = mockFunctions({
      'bank-feed-accounts': [
        { body: { ok: true, accounts: ACCOUNTS } },
        { body: { ok: true, accounts: linked } },
      ],
      'bank-feed-link': [
        {
          body: {
            ok: true,
            bank_connection_id: 'bc-1',
            bank_account_id: 'ba-2',
            sync_from: '2026-08-01',
          },
        },
      ],
    });
    const onLinked = vi.fn();
    render(<BankFeedLink organizationId={ORG} onLinked={onLinked} />);
    fireEvent.click(screen.getByRole('button', { name: /show redbark accounts/i }));
    fireEvent.change(await screen.findByLabelText('Import from'), {
      target: { value: '2026-08-01' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Link Business Transaction' }));

    const notice = await screen.findByRole('status');
    expect(notice).toHaveTextContent(
      'Linked Business Transaction. Its first import, from 2026-08-01, is queued; transactions appear once it has run.',
    );
    expect(notice.textContent).not.toMatch(/synced|imported \d/i);
    expect(calls.find((c) => c.name === 'bank-feed-link')?.body).toEqual({
      organization_id: ORG,
      connection_id: 'rb-conn-1',
      account_id: 'acct-main',
      sync_from: '2026-08-01',
    });
    expect(mocks.enqueueJob).toHaveBeenCalledWith({
      organizationId: ORG,
      jobKind: 'bank_sync',
      sourceKind: 'bank_connection',
      sourceId: 'bc-1',
      priority: 3,
      payload: { bank_connection_id: 'bc-1', source: 'bank_feed_link' },
    });
    await waitFor(() => expect(onLinked).toHaveBeenCalled());
    expect(
      await screen.findByText(/importing from 2026-08-01 · first import not finished yet/),
    ).toBeInTheDocument();
  });

  it('shows the server refusal for someone who is not an admin, and nothing is listed', async () => {
    mockFunctions({
      'bank-feed-accounts': [
        { status: 403, body: { ok: false, error: 'This action needs the admin role or higher' } },
      ],
    });
    render(<BankFeedLink organizationId={ORG} />);
    fireEvent.click(screen.getByRole('button', { name: /show redbark accounts/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not load Redbark accounts: This action needs the admin role or higher',
    );
    expect(screen.queryByRole('list', { name: /redbark accounts/i })).not.toBeInTheDocument();
  });

  it('reports a connection failure through the shared error wording', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    render(<BankFeedLink organizationId={ORG} />);
    fireEvent.click(screen.getByRole('button', { name: /show redbark accounts/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not load Redbark accounts. Network or server connection issue: Failed to fetch',
    );
  });

  it('does not queue an import when the link is refused, and says when the queue itself fails', async () => {
    mockFunctions({
      'bank-feed-accounts': [{ body: { ok: true, accounts: ACCOUNTS } }],
      'bank-feed-link': [
        {
          status: 409,
          body: {
            ok: false,
            error: 'This Redbark connection is already linked to another organisation.',
          },
        },
      ],
    });
    render(<BankFeedLink organizationId={ORG} />);
    fireEvent.click(screen.getByRole('button', { name: /show redbark accounts/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Link Business Transaction' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not link Business Transaction: This Redbark connection is already linked to another organisation.',
    );
    expect(mocks.enqueueJob).not.toHaveBeenCalled();
    vi.restoreAllMocks();

    mocks.enqueueJob.mockRejectedValue(new Error('organization not accessible'));
    mockFunctions({
      'bank-feed-accounts': [{ body: { ok: true, accounts: ACCOUNTS } }],
      'bank-feed-link': [
        {
          body: {
            ok: true,
            bank_connection_id: 'bc-1',
            bank_account_id: 'ba-2',
            sync_from: '2026-07-01',
          },
        },
      ],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Link Business Transaction' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Linked Business Transaction, but its first import could not be queued (organization not accessible). Use Sync on the connection to start it.',
    );
  });

  it('defaults the import-from date to 1 July of the current Australian financial year', () => {
    expect(defaultImportFrom(new Date('2026-10-03T00:00:00Z'))).toBe('2026-07-01');
    expect(defaultImportFrom(new Date('2027-03-01T00:00:00Z'))).toBe('2026-07-01');
    // 14:30 UTC on 30 June is 00:30 on 1 July in Brisbane: the new financial year has started.
    expect(defaultImportFrom(new Date('2026-06-30T14:30:00Z'))).toBe('2026-07-01');
    expect(defaultImportFrom(new Date('2026-06-30T13:30:00Z'))).toBe('2025-07-01');
    expect(todayAest(new Date('2026-06-30T14:30:00Z'))).toBe('2026-07-01');
  });
});
