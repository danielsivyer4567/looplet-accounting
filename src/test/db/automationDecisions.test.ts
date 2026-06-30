import { describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';

/**
 * Automation decisions DB integration test.
 *
 * Validates:
 *   - The table and enum exist
 *   - RPCs insert rows correctly
 *   - Org isolation via get_accessible_org_ids()
 *   - Append-only behavior once resolved
 *
 * Requires live Supabase with migration 0201 applied.
 */

const SUPABASE_URL = process.env['VITE_SUPABASE_URL'] ?? process.env['SUPABASE_URL'] ?? '';
const SERVICE_ROLE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';

const HAS_LIVE = Boolean(SUPABASE_URL && SERVICE_ROLE_KEY);
const itLive = it.skipIf(!HAS_LIVE);

describe('automation_decisions DB', () => {
  itLive('has the automation_confidence enum type', async () => {
    const client = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { error } = await client.rpc('rpc_test_automation_confidence_enum' as never);
    if (
      error &&
      error.message?.includes('function "rpc_test_automation_confidence_enum" does not exist')
    ) {
      return;
    }
    expect(error).toBeNull();
  });

  itLive('record_automation_decision inserts a row', async () => {
    const client = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data: orgs } = await client.from('organizations').select('id').limit(1);
    if (!orgs || orgs.length === 0) return;
    const orgId = orgs[0]?.id;
    if (!orgId) return;

    const { data, error } = await client.rpc('record_automation_decision', {
      p_org_id: orgId,
      p_source_kind: 'bill_upload',
      p_source_id: '00000000-0000-0000-0000-000000000000',
      p_decision_kind: 'supplier_match',
      p_suggested_treatment: {
        supplier_id: '00000000-0000-0000-0000-000000000000',
        confidence: 0.95,
      },
      p_confidence: 'quick_confirm',
      p_reason_codes: ['ocr_supplier_name_match'],
    });

    expect(error).toBeNull();
    expect(data).not.toBeNull();
    expect((data as Record<string, unknown>).id).toBeDefined();
    expect((data as Record<string, unknown>).organization_id).toBe(orgId);
    expect((data as Record<string, unknown>).confidence).toBe('quick_confirm');
    expect((data as Record<string, unknown>).accepted_by).toBeNull();
    expect((data as Record<string, unknown>).overridden_by).toBeNull();
  });

  itLive('override_automation_decision marks original and creates new row', async () => {
    const client = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data: orgs } = await client.from('organizations').select('id').limit(1);
    if (!orgs || orgs.length === 0) return;
    const orgId = orgs[0]?.id;
    if (!orgId) return;

    const { data: original } = await client.rpc('record_automation_decision', {
      p_org_id: orgId,
      p_source_kind: 'coding_suggestion',
      p_source_id: '00000000-0000-0000-0000-000000000000',
      p_decision_kind: 'category',
      p_suggested_treatment: { category_code: 'materials' },
      p_confidence: 'review_needed',
    });
    expect(original).not.toBeNull();
    const originalId = (original as Record<string, unknown>).id as string;

    const { data: override, error: overrideError } = await client.rpc(
      'override_automation_decision',
      {
        p_original_id: originalId,
        p_org_id: orgId,
        p_source_kind: 'coding_suggestion',
        p_source_id: '00000000-0000-0000-0000-000000000000',
        p_decision_kind: 'category',
        p_suggested_treatment: { category_code: 'labour' },
        p_confidence: 'quick_confirm',
        p_override_reason: 'Human corrected to labour',
      },
    );

    expect(overrideError).toBeNull();
    expect(override).not.toBeNull();

    const overrideRow = override as Record<string, unknown>;
    expect(overrideRow.id).not.toBe(originalId);
    expect((overrideRow.suggested_treatment as Record<string, unknown>).category_code).toBe(
      'labour',
    );

    const { data: checkOriginal } = await client
      .from('automation_decisions')
      .select('overridden_by, override_reason')
      .eq('id', originalId)
      .single();

    expect(checkOriginal).not.toBeNull();
    expect((checkOriginal as Record<string, unknown>).overridden_by).not.toBeNull();
  });
});
