import { assert, assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { ingestDocument, ValidationError } from './handlers.ts';

// Minimal chainable fake of the supabase-js client. Query-builder methods return
// `this`; terminal methods (maybeSingle/single) pop the next queued result for
// that table (FIFO, in call order). rpc() records its args and pops from its own
// queue. Only the surface ingestDocument touches is modelled.
type Res = { data: unknown; error: { message?: string; code?: string } | null };

class FakeBuilder {
  constructor(
    private readonly table: string,
    private readonly db: FakeDb,
  ) {}
  select(_c?: string): this { return this; }
  insert(v: unknown): this { this.db.inserts.push([this.table, v]); return this; }
  upsert(_v: unknown, _o?: unknown): this { return this; }
  eq(_c: string, _v: unknown): this { return this; }
  in(_c: string, _v: unknown): this { return this; }
  is(_c: string, _v: unknown): this { return this; }
  order(_c: string, _o?: unknown): this { return this; }
  limit(_n: number): this { return this; }
  maybeSingle(): Promise<Res> { return Promise.resolve(this.db.next(this.table)); }
  single(): Promise<Res> { return Promise.resolve(this.db.next(this.table)); }
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
    return q && q.length > 0 ? q.shift()! : { data: null, error: null };
  }
  // deno-lint-ignore no-explicit-any
  from(table: string): any {
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
    { storage_key: okStorageKey, original_filename: 'receipt.pdf', mime_type: 'application/pdf' },
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

Deno.test('document push is idempotent: replay returns the existing job, no re-enqueue', async () => {
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
});

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
