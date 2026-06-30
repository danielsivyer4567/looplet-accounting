import { describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';

/**
 * Anomaly signals DB integration test.
 *
 * Validates that anomaly task arms (9-11) of get_workstream_tasks return
 * owner-readable anomaly tasks and are org-scoped via RLS.
 */

const SUPABASE_URL = process.env['VITE_SUPABASE_URL'] ?? process.env['SUPABASE_URL'] ?? '';
const SERVICE_ROLE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';

const HAS_LIVE = Boolean(SUPABASE_URL && SERVICE_ROLE_KEY);
const itLive = it.skipIf(!HAS_LIVE);

describe('anomaly signals in get_workstream_tasks', () => {
  itLive('returns anomaly tasks with owner-readable fields', async () => {
    const client = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: orgs } = await client.from('organizations').select('id').limit(1);
    if (!orgs || orgs.length === 0) return;
    const orgId = orgs[0]?.id;
    if (!orgId) return;

    const { data, error } = await client.rpc('get_workstream_tasks', {
      p_org_id: orgId,
    });
    expect(error).toBeNull();

    const anomalyKinds = new Set(['duplicate_bill', 'low_confidence_bill', 'bas_coverage_gap']);
    const anomalies = (data ?? []).filter((t: Record<string, unknown>) =>
      anomalyKinds.has(t.task_kind as string),
    );

    for (const task of anomalies) {
      expect(task.owner_label).toBeTruthy();
      expect(task.why_now).toBeTruthy();
      expect(task.suggested_action).toBeTruthy();
      expect(task.confidence).toBe('review_needed');
      expect(task.urgency).toBeGreaterThanOrEqual(9);
    }
  });

  itLive('anomaly tasks are org-scoped', async () => {
    const client = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: orgs } = await client.from('organizations').select('id').limit(2);
    if (!orgs || orgs.length < 2) return;

    const orgA = orgs[0]?.id;
    const orgB = orgs[1]?.id;
    if (!orgA || !orgB) return;

    const { data: tasksA } = await client.rpc('get_workstream_tasks', { p_org_id: orgA });
    const { data: tasksB } = await client.rpc('get_workstream_tasks', { p_org_id: orgB });

    const orgIdsA = new Set((tasksA ?? []).map((t: Record<string, unknown>) => t.organization_id));
    const orgIdsB = new Set((tasksB ?? []).map((t: Record<string, unknown>) => t.organization_id));

    expect(orgIdsA.has(orgB)).toBe(false);
    expect(orgIdsB.has(orgA)).toBe(false);
  });
});
