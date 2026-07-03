import { assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { existingGmailAttachmentIds, hasExistingGmailBill } from './dedupe.ts';

class FakeQuery {
  readonly calls: unknown[][];

  constructor(
    calls: unknown[][],
    private readonly result: { data: unknown; error: { message?: string } | null },
  ) {
    this.calls = calls;
  }

  select(columns: string): FakeQuery {
    this.calls.push(['select', columns]);
    return this;
  }

  eq(column: string, value: unknown): FakeQuery {
    this.calls.push(['eq', column, value]);
    return this;
  }

  filter(column: string, operator: string, value: unknown): FakeQuery {
    this.calls.push(['filter', column, operator, value]);
    return this;
  }

  limit(count: number): FakeQuery {
    this.calls.push(['limit', count]);
    return this;
  }

  async maybeSingle(): Promise<{ data: unknown; error: { message?: string } | null }> {
    this.calls.push(['maybeSingle']);
    return this.result;
  }
}

class FakeAdmin {
  readonly calls: unknown[][] = [];

  constructor(private readonly result: { data: unknown; error: { message?: string } | null }) {}

  from(table: string): FakeQuery {
    this.calls.push(['from', table]);
    return new FakeQuery(this.calls, this.result);
  }
}

Deno.test('hasExistingGmailBill queries the per-org gmail message id', async () => {
  const admin = new FakeAdmin({ data: { id: 'bill-1' }, error: null });

  const exists = await hasExistingGmailBill(admin, 'org-1', 'gmail-message-1');

  assertEquals(exists, true);
  assertEquals(admin.calls, [
    ['from', 'bills'],
    ['select', 'id'],
    ['eq', 'organization_id', 'org-1'],
    ['filter', 'intake_metadata->>gmail_message_id', 'eq', 'gmail-message-1'],
    ['limit', 1],
    ['maybeSingle'],
  ]);
});

Deno.test('hasExistingGmailBill returns false when no row exists', async () => {
  const admin = new FakeAdmin({ data: null, error: null });

  assertEquals(await hasExistingGmailBill(admin, 'org-1', 'gmail-message-2'), false);
});

Deno.test('hasExistingGmailBill fails closed when the lookup errors', async () => {
  const admin = new FakeAdmin({ data: null, error: { message: 'permission denied' } });

  await assertRejects(
    () => hasExistingGmailBill(admin, 'org-1', 'gmail-message-3'),
    Error,
    'gmail duplicate check failed: permission denied',
  );
});

// --- existingGmailAttachmentIds (per-attachment dedup) ---

class FakeListQuery {
  constructor(private readonly result: { data: unknown; error: { message?: string } | null }) {}
  select(): FakeListQuery {
    return this;
  }
  eq(): FakeListQuery {
    return this;
  }
  filter(): FakeListQuery {
    return this;
  }
  then<T>(
    onfulfilled: (v: { data: unknown; error: { message?: string } | null }) => T,
  ): Promise<T> {
    return Promise.resolve(this.result).then(onfulfilled);
  }
}
class FakeListAdmin {
  constructor(private readonly result: { data: unknown; error: { message?: string } | null }) {}
  from(): FakeListQuery {
    return new FakeListQuery(this.result);
  }
}

Deno.test('existingGmailAttachmentIds collects recorded attachment ids', async () => {
  const admin = new FakeListAdmin({
    data: [
      { intake_metadata: { gmail_attachment_id: 'att-1' } },
      { intake_metadata: { gmail_attachment_id: 'att-2' } },
    ],
    error: null,
  });
  const r = await existingGmailAttachmentIds(admin, 'org-1', 'msg-1');
  assertEquals(r.hasAnyBill, true);
  assertEquals(r.attachmentIds.size, 2);
  assertEquals(r.attachmentIds.has('att-1'), true);
  assertEquals(r.attachmentIds.has('att-2'), true);
});

Deno.test('existingGmailAttachmentIds flags legacy bills (no attachment id) as hasAnyBill with empty set', async () => {
  const admin = new FakeListAdmin({
    data: [{ intake_metadata: { gmail_message_id: 'msg-1' } }],
    error: null,
  });
  const r = await existingGmailAttachmentIds(admin, 'org-1', 'msg-1');
  assertEquals(r.hasAnyBill, true);
  assertEquals(r.attachmentIds.size, 0);
});

Deno.test('existingGmailAttachmentIds returns empty for a fresh message', async () => {
  const admin = new FakeListAdmin({ data: [], error: null });
  const r = await existingGmailAttachmentIds(admin, 'org-1', 'msg-2');
  assertEquals(r.hasAnyBill, false);
  assertEquals(r.attachmentIds.size, 0);
});

Deno.test('existingGmailAttachmentIds fails closed on a lookup error', async () => {
  const admin = new FakeListAdmin({ data: null, error: { message: 'permission denied' } });
  await assertRejects(
    () => existingGmailAttachmentIds(admin, 'org-1', 'msg-3'),
    Error,
    'gmail duplicate check failed: permission denied',
  );
});
