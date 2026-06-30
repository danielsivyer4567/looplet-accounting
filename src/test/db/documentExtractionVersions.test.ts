import { describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';

/**
 * document_extraction_versions DB integration test.
 *
 * Validates:
 *   - Table exists with expected columns
 *   - service_role can insert version rows
 *   - Multiple version rows for the same bill are preserved (append-only)
 *   - enqueue_automation_job can queue a bill_extract job (the Rerun path)
 *
 * Requires live Supabase with migrations 0211 + 0215 applied.
 * Skipped when SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are absent.
 */

const SUPABASE_URL = process.env['VITE_SUPABASE_URL'] ?? process.env['SUPABASE_URL'] ?? '';
const SERVICE_ROLE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';

const HAS_LIVE = Boolean(SUPABASE_URL && SERVICE_ROLE_KEY);
const itLive = it.skipIf(!HAS_LIVE);

describe('document_extraction_versions DB', () => {
  itLive('table exists with expected columns', async () => {
    const client = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data, error } = await client
      .from('document_extraction_versions')
      .select(
        'id, bill_id, organization_id, provider, method, confidence, extracted_json, field_confidence, created_at',
      )
      .limit(0);
    expect(error).toBeNull();
    expect(Array.isArray(data)).toBe(true);
  });

  itLive('service_role can insert a version row', async () => {
    const client = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: bills } = await client.from('bills').select('id, organization_id').limit(1);
    if (!bills || bills.length === 0) return;
    const billRow = (bills as { id: string; organization_id: string }[])[0];
    if (!billRow) return;
    const bill = billRow;

    const { data, error } = await client
      .from('document_extraction_versions')
      .insert({
        bill_id: bill.id,
        organization_id: bill.organization_id,
        provider: 'test-provider',
        method: 'vision',
        confidence: 0.85,
        extracted_json: { supplier_name: 'Test Supplier' },
      })
      .select('id, method, confidence')
      .single();

    expect(error).toBeNull();
    const row = data as { id: string; method: string; confidence: number };
    expect(row.method).toBe('vision');
    expect(Number(row.confidence)).toBeCloseTo(0.85, 2);
  });

  itLive('multiple version rows for same bill are preserved', async () => {
    const client = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: bills } = await client.from('bills').select('id, organization_id').limit(1);
    if (!bills || bills.length === 0) return;
    const billRow2 = (bills as { id: string; organization_id: string }[])[0];
    if (!billRow2) return;
    const bill = billRow2;

    const countBefore = await client
      .from('document_extraction_versions')
      .select('id', { count: 'exact', head: true })
      .eq('bill_id', bill.id)
      .then(({ count }) => count ?? 0);

    await client.from('document_extraction_versions').insert([
      {
        bill_id: bill.id,
        organization_id: bill.organization_id,
        provider: 'groq',
        method: 'vision',
        confidence: 0.41,
        extracted_json: { supplier_name: 'Run A' },
      },
      {
        bill_id: bill.id,
        organization_id: bill.organization_id,
        provider: 'openai',
        method: 'vision',
        confidence: 0.9,
        extracted_json: { supplier_name: 'Run B' },
      },
    ]);

    const { count: countAfter } = await client
      .from('document_extraction_versions')
      .select('id', { count: 'exact', head: true })
      .eq('bill_id', bill.id);

    expect((countAfter ?? 0) - countBefore).toBeGreaterThanOrEqual(2);
  });

  itLive('enqueue_automation_job queues a bill_extract job (Rerun path)', async () => {
    const client = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: bills } = await client.from('bills').select('id, organization_id').limit(1);
    if (!bills || bills.length === 0) return;
    const billRow3 = (bills as { id: string; organization_id: string }[])[0];
    if (!billRow3) return;
    const bill = billRow3;

    const { data, error } = await client.rpc('enqueue_automation_job', {
      p_org_id: bill.organization_id,
      p_job_kind: 'bill_extract',
      p_source_kind: 'bill',
      p_source_id: bill.id,
      p_priority: 5,
      p_payload: { force: true },
    });

    expect(error).toBeNull();
    const job = data as Record<string, unknown>;
    expect(job.job_kind).toBe('bill_extract');
    expect(job.source_id).toBe(bill.id);
    expect(job.status).toBe('pending');
  });
});
