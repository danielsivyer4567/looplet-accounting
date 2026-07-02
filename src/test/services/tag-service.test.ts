/**
 * Unit tests for the tag-drop service + constants (SC-2D).
 *
 * Covers the three done-criteria: create→staff mapping (getTaggableStaff +
 * createTag happy path), isAccountant role matching, and the rate-limit guard
 * (createTag surfacing the RPC's success:false on rate limit).
 *
 * The service imports @/lib/supabase, which throws at module load without env
 * vars — stub it with the shared chainable mock the page/hook tests use.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/supabase', () => import('@/test/mocks/supabase'));

import {
  mockSupabaseResponse,
  clearSupabaseOperations,
  getSupabaseOperations,
} from '@/test/mocks/supabase';
import { createTag, getTaggableStaff, fetchTags, type TagData } from '@/services/tags/tag-service';
import { isAccountant, ACCOUNTANT_MATCH, TAG_CONSTANTS } from '@/constants/tags';

beforeEach(() => {
  clearSupabaseOperations();
  mockSupabaseResponse({ data: [], error: null });
});

describe('isAccountant / ACCOUNTANT_MATCH', () => {
  it('matches the literal accountant role (role_enum value)', () => {
    expect(isAccountant({ role: 'accountant' })).toBe(true);
    expect(ACCOUNTANT_MATCH.test('accountant')).toBe(true);
  });

  it('tolerates decorated and capitalised labels', () => {
    expect(isAccountant({ role: 'Accountant (CPA)' })).toBe(true);
    expect(isAccountant({ role: 'Senior Accountant' })).toBe(true);
  });

  it('does not match other roles or empty values', () => {
    expect(isAccountant({ role: 'admin' })).toBe(false);
    expect(isAccountant({ role: 'bookkeeper' })).toBe(false);
    expect(isAccountant({ role: null })).toBe(false);
    expect(isAccountant({})).toBe(false);
  });
});

describe('createTag — payload validation (no I/O)', () => {
  it('rejects missing/invalid coordinates', async () => {
    const res = await createTag({
      creatorId: 'u1',
      coords: undefined as unknown as { x: number; y: number },
    });
    expect(res.data).toBeNull();
    expect(res.error?.message).toMatch(/invalid coordinates/i);
  });

  it('rejects negative coordinates', async () => {
    const res = await createTag({ creatorId: 'u1', coords: { x: -1, y: 5 } });
    expect(res.error?.message).toMatch(/non-negative/i);
  });

  it('rejects an over-length comment', async () => {
    const res = await createTag({
      creatorId: 'u1',
      coords: { x: 1, y: 1 },
      comment: 'x'.repeat(TAG_CONSTANTS.MAX_COMMENT_LENGTH + 1),
    });
    expect(res.error?.message).toMatch(/maximum length/i);
  });

  it('rejects tagging more than the staff cap', async () => {
    const res = await createTag({
      creatorId: 'u1',
      coords: { x: 1, y: 1 },
      taggedStaffIds: Array.from({ length: TAG_CONSTANTS.MAX_TAGGED_STAFF + 1 }, (_, i) => `s${i}`),
    });
    expect(res.error?.message).toMatch(/more than/i);
  });
});

describe('createTag — rate-limit guard', () => {
  it('surfaces the RPC success:false rate-limit error', async () => {
    mockSupabaseResponse({
      data: { success: false, error: { message: 'Rate limit exceeded' } },
      error: null,
    });
    const res = await createTag({
      creatorId: 'u1',
      organizationId: 'org-1',
      coords: { x: 10, y: 20 },
    });
    expect(res.data).toBeNull();
    expect(res.error?.message).toBe('Rate limit exceeded');
  });

  it('returns the new tag id/timestamp on success', async () => {
    mockSupabaseResponse({
      data: { success: true, data: { id: 'tag-1', timestamp: 1234 } },
      error: null,
    });
    const res = await createTag({
      creatorId: 'u1',
      organizationId: 'org-1',
      coords: { x: 10, y: 20 },
      taggedStaffIds: ['s1'],
    });
    expect(res.error).toBeNull();
    expect(res.data).toEqual({ id: 'tag-1', timestamp: 1234, drawingData: undefined });
  });
});

describe('getTaggableStaff — RPC mapping', () => {
  it('returns the staff rows from get_taggable_staff', async () => {
    const rows = [
      { id: 's1', email: 'a@x.com', full_name: 'Ada', role: 'accountant', avatar_url: null },
      { id: 's2', email: 'b@x.com', full_name: 'Bo', role: 'admin', avatar_url: null },
    ];
    mockSupabaseResponse({ data: rows, error: null });
    const res = await getTaggableStaff('org-1');
    expect(res.error).toBeNull();
    expect(res.data).toEqual(rows);
    expect(res.data?.some((s) => isAccountant(s))).toBe(true);
  });

  it('coerces a null RPC payload to an empty list', async () => {
    mockSupabaseResponse({ data: null, error: null });
    const res = await getTaggableStaff('org-1');
    expect(res.data).toEqual([]);
  });
});

describe('fetchTags — transform', () => {
  it('passes tag_staff/attachments through and defaults an unknown sender', async () => {
    const row: Partial<TagData> = {
      id: 'tag-1',
      organization_id: 'org-1',
      creator_id: 'u9',
      page_url: '/clients',
      coords: { x: 1, y: 2 },
      requires_approval: false,
      timestamp: 1,
      created_at: '2026-06-29T00:00:00Z',
      tag_staff: [{ staff_id: 's1', notified_at: 'now' }],
    };
    mockSupabaseResponse({ data: [row], error: null });
    // No organizationId filter → skips the staff-enrichment round-trip.
    const res = await fetchTags({ pageUrl: '/clients' });
    expect(res.error).toBeNull();
    expect(res.data).toHaveLength(1);
    expect(res.data?.[0]?.senderName).toBe('Unknown');
    expect(res.data?.[0]?.tag_staff).toEqual([{ staff_id: 's1', notified_at: 'now' }]);
    // Read-only query: no write operations recorded.
    expect(getSupabaseOperations()).toHaveLength(0);
  });
});
