import { assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  ingestBill,
  ingestDocument,
  ingestInvoice,
  ingestPayment,
  ValidationError,
} from './handlers.ts';

// Minimal chainable fake of the supabase-js client. Query-builder methods return
// `this`; terminal methods (maybeSingle/single) pop the next queued result for
// that table (FIFO, in call order). rpc() records its args and pops from its own
// queue. Only the surface these handler tests touch is modelled.
interface Res {
  data: unknown;
  error: { message?: string; code?: string } | null;
}

class FakeBuilder {
  constructor(
    private readonly table: string,
    private readonly db: FakeDb,
  ) {}
  select(): this {
    return this;
  }
  insert(v: unknown): this {
    this.db.inserts.push([this.table, v]);
    return this;
  }
  upsert(): this {
    return this;
  }
  eq(): this {
    return this;
  }
  in(): this {
    return this;
  }
  is(): this {
    return this;
  }
  order(): this {
    return this;
  }
  limit(): this {
    return this;
  }
  maybeSingle(): Promise<Res> {
    return Promise.resolve(this.db.next(this.table));
  }
  single(): Promise<Res> {
    return Promise.resolve(this.db.next(this.table));
  }
}

class FakeDb {
  readonly inserts: [string, unknown][] = [];
  readonly rpcCalls: [string, Record<string, unknown>][] = [];
  private readonly queues: Record<string, Res[]> = {};
  private readonly rpcQueue: Res[] = [];

  queue(table: string, res: Res): this {
    (this.queues[table] ??= []).push(res);
    return this;
  }
  queueRpc(res: Res): this {
    this.rpcQueue.push(res);
    return this;
  }
  next(table: string): Res {
    const q = this.queues[table];
    if (q && q.length > 0) {
      const next = q.shift();
      if (next) return next;
    }
    return { data: null, error: null };
  }
  from(table: string): FakeBuilder {
    return new FakeBuilder(table, this);
  }
  rpc(name: string, args: Record<string, unknown>): Promise<Res> {
    this.rpcCalls.push([name, args]);
    return Promise.resolve(this.rpcQueue.shift() ?? { data: null, error: null });
  }
}

const ORG = 'org-1';
const okStorageKey = `org-${ORG}/2026/receipt.pdf`;

Deno.test('document push creates a bill and enqueues bill_extract (feeds B1)', async () => {
  const db = new FakeDb()
    .queue('automation_jobs', { data: null, error: null }) // no existing job (dedup miss)
    .queue('bills', { data: null, error: null }) // no existing bill for storage_key
    .queue('bills', { data: { id: 'bill-new' }, error: null }) // insert().select().single()
    .queueRpc({ data: { id: 'job-new' }, error: null }); // enqueue_automation_job

  const res = await ingestDocument(
    db as unknown as Parameters<typeof ingestDocument>[0],
    ORG,
    {
      storage_key: okStorageKey,
      original_filename: 'receipt.pdf',
      mime_type: 'application/pdf',
    },
    'idem-key-1',
  );

  assertEquals(res.status, 202);
  assertEquals(res.body, {
    ok: true,
    job_id: 'job-new',
    bill_id: 'bill-new',
    type: 'document',
    deduped: false,
  });

  // A bill row was created under the pinned org.
  assertEquals(db.inserts.length, 1);
  const [table, row] = db.inserts[0];
  assertEquals(table, 'bills');
  assertEquals((row as Record<string, unknown>).organization_id, ORG);
  assertEquals((row as Record<string, unknown>).source, 'api');

  // Exactly one bill_extract job enqueued, targeting that bill → this is the
  // edge that feeds the extraction queue (B1).
  assertEquals(db.rpcCalls.length, 1);
  const [rpcName, rpcArgs] = db.rpcCalls[0];
  assertEquals(rpcName, 'enqueue_automation_job');
  assertEquals(rpcArgs.p_job_kind, 'bill_extract');
  assertEquals(rpcArgs.p_source_kind, 'document');
  assertEquals((rpcArgs.p_payload as Record<string, unknown>).bill_id, 'bill-new');
});

Deno.test(
  'document push is idempotent: replay returns the existing job, no re-enqueue',
  async () => {
    const db = new FakeDb().queue('automation_jobs', {
      data: { id: 'job-existing', payload: { bill_id: 'bill-existing' } },
      error: null,
    });

    const res = await ingestDocument(
      db as unknown as Parameters<typeof ingestDocument>[0],
      ORG,
      { storage_key: okStorageKey },
      'idem-key-1',
    );

    assertEquals(res.status, 200);
    assertEquals(res.body, {
      ok: true,
      job_id: 'job-existing',
      bill_id: 'bill-existing',
      type: 'document',
      deduped: true,
    });
    // No second bill, no second job — the replay short-circuits on the dedup hit.
    assertEquals(db.inserts.length, 0);
    assertEquals(db.rpcCalls.length, 0);
  },
);

Deno.test('document push rejects a storage_key outside the caller org (tenant pin)', async () => {
  const db = new FakeDb();
  await assertRejects(
    () =>
      ingestDocument(
        db as unknown as Parameters<typeof ingestDocument>[0],
        ORG,
        { storage_key: 'org-someone-else/secret.pdf' },
        'idem-key-2',
      ),
    ValidationError,
    'storage_key must belong to this organization',
  );
  // Rejected before any DB write.
  assertEquals(db.inserts.length, 0);
  assertEquals(db.rpcCalls.length, 0);
});

Deno.test('document push requires an idempotency key', async () => {
  const db = new FakeDb();
  await assertRejects(
    () =>
      ingestDocument(
        db as unknown as Parameters<typeof ingestDocument>[0],
        ORG,
        { storage_key: okStorageKey },
        undefined,
      ),
    ValidationError,
    'Idempotency-Key',
  );
});

Deno.test('bill push rejects supplier_id outside the caller org before writing', async () => {
  const db = new FakeDb().queue('suppliers', { data: null, error: null });

  await assertRejects(
    () =>
      ingestBill(db as unknown as Parameters<typeof ingestBill>[0], ORG, {
        supplier_id: 'supplier-other',
        invoice_number: 'INV-1',
      }),
    ValidationError,
    'supplier not found for this organization',
  );

  assertEquals(db.inserts.length, 0);
  assertEquals(db.rpcCalls.length, 0);
});

Deno.test('bill push rejects job_id outside the caller org before writing', async () => {
  const db = new FakeDb().queue('jobs', { data: null, error: null });

  await assertRejects(
    () =>
      ingestBill(db as unknown as Parameters<typeof ingestBill>[0], ORG, {
        job_id: 'job-other',
        invoice_number: 'INV-1',
      }),
    ValidationError,
    'job not found for this organization',
  );

  assertEquals(db.inserts.length, 0);
  assertEquals(db.rpcCalls.length, 0);
});

Deno.test('invoice push rejects customer_id outside the caller org before writing', async () => {
  const db = new FakeDb().queue('customers', { data: null, error: null });

  await assertRejects(
    () =>
      ingestInvoice(db as unknown as Parameters<typeof ingestInvoice>[0], ORG, {
        invoice_number: 'INV-2',
        customer_id: 'customer-other',
        due_date: '2026-07-31',
      }),
    ValidationError,
    'customer not found for this organization',
  );

  assertEquals(db.inserts.length, 0);
  assertEquals(db.rpcCalls.length, 0);
});

Deno.test('invoice push rejects job_id outside the caller org before writing', async () => {
  const db = new FakeDb()
    .queue('customers', { data: { id: 'customer-1' }, error: null })
    .queue('jobs', { data: null, error: null });

  await assertRejects(
    () =>
      ingestInvoice(db as unknown as Parameters<typeof ingestInvoice>[0], ORG, {
        invoice_number: 'INV-3',
        customer_id: 'customer-1',
        job_id: 'job-other',
        due_date: '2026-07-31',
      }),
    ValidationError,
    'job not found for this organization',
  );

  assertEquals(db.inserts.length, 0);
  assertEquals(db.rpcCalls.length, 0);
});

Deno.test('payment push rejects invoice_id outside the caller org before enqueueing', async () => {
  const db = new FakeDb()
    .queue('automation_jobs', { data: null, error: null })
    .queue('invoices', { data: null, error: null });

  await assertRejects(
    () =>
      ingestPayment(
        db as unknown as Parameters<typeof ingestPayment>[0],
        ORG,
        {
          invoice_id: 'invoice-other',
          amount_cents: 12300,
          payment_date: '2026-07-01',
        },
        'payment-idem-1',
      ),
    ValidationError,
    'invoice not found for this organization',
  );

  assertEquals(db.inserts.length, 0);
  assertEquals(db.rpcCalls.length, 0);
});
