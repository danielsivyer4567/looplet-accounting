/**
 * Contract test for the tag-draft upsert arbiter (slice P0-02).
 *
 * saveTagDraft (src/services/tags/tag-service.ts) upserts into tag_drafts with
 *
 *     { onConflict: 'user_id,organization_id,page_url' }
 *
 * For PostgREST to honour that ON CONFLICT, the DB needs a UNIQUE index over
 * EXACTLY those columns. Migration 0204_tag_draft_contract.sql adds it. This
 * file pins both sides of that contract:
 *
 *   1. Static SQL assertion — read 0204's text and assert it declares a UNIQUE
 *      index whose key is exactly (user_id, organization_id, page_url), with
 *      NULLS NOT DISTINCT so a no-page draft dedupes too.
 *   2. Mocked-supabase upsert shape — drive saveTagDraft through a local mock
 *      that captures the upsert options, and assert the onConflict column list
 *      it sends matches the unique key the migration declares (so the two never
 *      drift apart).
 *
 * The local mock is self-contained (it must capture the 2nd .upsert() arg,
 * which the shared @/test/mocks/supabase builder does not record) and is reset
 * per test.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Local capturing supabase mock — records the upsert payload AND options.
// ---------------------------------------------------------------------------

interface UpsertCall {
  table: string;
  payload: Record<string, unknown>;
  options?: { onConflict?: string } | undefined;
}

const upsertCalls: UpsertCall[] = [];
let nextResponse: { data: unknown; error: { message: string } | null } = {
  data: { id: 'draft-1' },
  error: null,
};

vi.mock('@/lib/supabase', () => {
  const makeChain = (table: string) => {
    const chain: Record<string, unknown> = {};
    chain.upsert = (payload: Record<string, unknown>, options?: { onConflict?: string }) => {
      upsertCalls.push({ table, payload, options });
      return chain;
    };
    chain.select = () => chain;
    chain.single = () => Promise.resolve(nextResponse);
    return chain;
  };
  return { supabase: { from: (table: string) => makeChain(table) } };
});

// Imported after the mock is declared (vi.mock is hoisted regardless).
import { saveTagDraft } from '@/services/tags/tag-service';

// ---------------------------------------------------------------------------
// The canonical conflict-key columns. Both the SQL and the frontend onConflict
// string must agree on this exact list, in this order.
// ---------------------------------------------------------------------------
const CONFLICT_COLUMNS = ['user_id', 'organization_id', 'page_url'] as const;

// 0204 lives three levels up from src/test/db/.
const MIGRATION_SQL = readFileSync(
  path.resolve(__dirname, '../../../supabase/migrations/0204_tag_draft_contract.sql'),
  'utf8',
);

beforeEach(() => {
  upsertCalls.length = 0;
  nextResponse = { data: { id: 'draft-1' }, error: null };
});

// ---------------------------------------------------------------------------
// 1. Static SQL assertion — the migration declares the right arbiter.
// ---------------------------------------------------------------------------

describe('0204 migration — tag_drafts unique arbiter', () => {
  it('declares a UNIQUE INDEX on tag_drafts over exactly (user_id, organization_id, page_url)', () => {
    // Find the primary arbiter index declaration and capture its column list.
    const match = MIGRATION_SQL.match(
      /CREATE\s+UNIQUE\s+INDEX[\s\S]*?ON\s+public\.tag_drafts\s*\(([^)]*)\)/i,
    );
    expect(match, 'no CREATE UNIQUE INDEX ... ON public.tag_drafts found').not.toBeNull();

    const columns = (match?.[1] ?? '')
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);

    expect(columns).toEqual([...CONFLICT_COLUMNS]);
  });

  it('targets tag_drafts (not some other table) for the arbiter', () => {
    expect(MIGRATION_SQL).toMatch(/ON\s+public\.tag_drafts/i);
  });

  it('collapses NULL page_url so no-page drafts dedupe (NULLS NOT DISTINCT)', () => {
    expect(MIGRATION_SQL).toMatch(/NULLS\s+NOT\s+DISTINCT/i);
  });

  it('is idempotent / prod-safe (IF NOT EXISTS + to_regclass guard)', () => {
    expect(MIGRATION_SQL).toMatch(/CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS/i);
    expect(MIGRATION_SQL).toMatch(/to_regclass\(\s*'public\.tag_drafts'\s*\)/i);
  });
});

// ---------------------------------------------------------------------------
// 2. Mocked-supabase upsert shape — the frontend sends the matching onConflict.
// ---------------------------------------------------------------------------

describe('saveTagDraft — upsert conflict-key contract', () => {
  it('upserts tag_drafts with onConflict matching the migration unique key', async () => {
    const res = await saveTagDraft({
      userId: 'u1',
      organizationId: 'org-1',
      pageUrl: '/clients',
      comment: 'hello',
    });

    expect(res.error).toBeNull();
    expect(res.data).toEqual({ id: 'draft-1' });

    expect(upsertCalls).toHaveLength(1);
    const call = upsertCalls[0];
    expect(call?.table).toBe('tag_drafts');

    // The onConflict string must be exactly the migration's unique-key columns.
    expect(call?.options?.onConflict).toBe(CONFLICT_COLUMNS.join(','));

    // And the payload must actually carry every conflict-key column so the
    // arbiter can match an existing row (otherwise the upsert can't dedupe).
    for (const col of CONFLICT_COLUMNS) {
      expect(call?.payload, `payload missing conflict-key column ${col}`).toHaveProperty(col);
    }
  });

  it('maps the draft fields onto the row columns the table expects', async () => {
    await saveTagDraft({
      userId: 'u1',
      organizationId: 'org-1',
      pageUrl: '/jobs/7',
      taggedStaffIds: ['s1', 's2'],
      requiresApproval: true,
      jobId: 'job-7',
    });

    const payload = upsertCalls[0]?.payload ?? {};
    expect(payload.user_id).toBe('u1');
    expect(payload.organization_id).toBe('org-1');
    expect(payload.page_url).toBe('/jobs/7');
    expect(payload.tagged_staff_ids).toEqual(['s1', 's2']);
    expect(payload.requires_approval).toBe(true);
    expect(payload.job_id).toBe('job-7');
    expect(payload).toHaveProperty('updated_at');
  });

  it('surfaces a DB error without throwing', async () => {
    nextResponse = { data: null, error: { message: 'duplicate key' } };
    const res = await saveTagDraft({ userId: 'u1', organizationId: 'org-1' });
    expect(res.data).toBeNull();
    expect(res.error?.message).toBe('duplicate key');
  });
});
