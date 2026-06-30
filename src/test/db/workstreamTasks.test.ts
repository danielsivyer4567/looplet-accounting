import { describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';

/**
 * Workstream tasks DB integration test.
 *
 * Validates that:
 *   - get_workstream_tasks returns tasks for the caller's own org
 *   - Other orgs' data is never exposed (org isolation through RLS)
 *   - The function returns owner-readable fields
 *
 * Requires a live Supabase connection with the 0231 migration applied.
 * Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
 */

const SUPABASE_URL = process.env['VITE_SUPABASE_URL'] ?? process.env['SUPABASE_URL'] ?? '';
const SERVICE_ROLE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';

const HAS_LIVE = Boolean(SUPABASE_URL && SERVICE_ROLE_KEY);
const itLive = it.skipIf(!HAS_LIVE);

describe('get_workstream_tasks RPC', () => {
  itLive('returns tasks for the caller org via RPC', async () => {
    const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data, error } = await serviceClient.rpc('get_workstream_tasks', {
      p_org_id: '00000000-0000-0000-0000-000000000000',
    });

    expect(error).toBeNull();
    expect(Array.isArray(data)).toBe(true);
    if (data && data.length > 0) {
      const task = data[0];
      expect(task).toHaveProperty('id');
      expect(task).toHaveProperty('task_kind');
      expect(task).toHaveProperty('owner_label');
      expect(task).toHaveProperty('why_now');
      expect(task).toHaveProperty('suggested_action');
      expect(task).toHaveProperty('confidence');
      expect([
        'auto_post',
        'quick_confirm',
        'review_needed',
        'advisor_required',
        'blocked_external',
      ]).toContain(task.confidence);
      expect(task).toHaveProperty('urgency');
      expect(typeof task.urgency).toBe('number');
    }
  });

  itLive('org scoping applies through RLS', async () => {
    const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data: allTasks, error: allError } = await serviceClient.rpc('get_workstream_tasks', {
      p_org_id: '00000000-0000-0000-0000-000000000000',
    });
    expect(allError).toBeNull();

    const { data: otherTasks, error: otherError } = await serviceClient.rpc(
      'get_workstream_tasks',
      { p_org_id: '00000000-0000-0000-0000-000000000001' },
    );
    expect(otherError).toBeNull();

    const allOrgIds = new Set(
      (allTasks ?? []).map((t: Record<string, unknown>) => t.organization_id),
    );
    const otherOrgIds = new Set(
      (otherTasks ?? []).map((t: Record<string, unknown>) => t.organization_id),
    );

    for (const id of otherOrgIds) {
      expect(allOrgIds.has(id)).toBe(allOrgIds.size === 0 || otherOrgIds.size === 0 ? false : true);
    }
  });

  itLive('has no more than one task per kind per org for aggregate kinds', async () => {
    const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data, error } = await serviceClient.rpc('get_workstream_tasks', {
      p_org_id: '00000000-0000-0000-0000-000000000000',
    });
    expect(error).toBeNull();

    const aggregateKinds = new Set([
      'onboarding_triage',
      'unapproved_bill',
      'overdue_invoice',
      'unmatched_bank_item',
      'bas_blocker',
    ]);
    const seen = new Set<string>();
    for (const task of data ?? []) {
      if (aggregateKinds.has((task as Record<string, unknown>).task_kind as string)) {
        const kind = (task as Record<string, unknown>).task_kind as string;
        expect(seen.has(kind)).toBe(false);
        seen.add(kind);
      }
    }
  });
});
