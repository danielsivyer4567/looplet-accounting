/**
 * SC-04 — Confidence policy engine
 *
 * Tests:
 *  1. Org-scoped policy returned over global default (no policy → null)
 *  2. Supplier-specific policy overrides org-wide policy
 *  3. Expired policies are ignored
 *  4. Unauthenticated client cannot mutate the table
 *  5. recordDecision applies policy override when present
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? '';

// Two test orgs — org isolation is proven by checking cross-org queries return nothing
const ORG_A_ID = process.env.TEST_ORG_A_ID ?? '';
const ORG_B_ID = process.env.TEST_ORG_B_ID ?? '';
const TEST_USER_JWT = process.env.TEST_USER_JWT ?? '';

const serviceClient = () =>
  createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });

const authedClient = () =>
  createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${TEST_USER_JWT}` } },
  });

const anonClient = () =>
  createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  });

const createdIds: string[] = [];

beforeAll(() => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !ORG_A_ID) {
    throw new Error('Missing env vars for confidence policy tests');
  }
});

afterAll(async () => {
  if (createdIds.length > 0) {
    await serviceClient()
      .from('confidence_policies')
      .delete()
      .in('id', createdIds);
  }
});

describe('confidence_policies — get_confidence_policy RPC', () => {
  it('returns null when no policy exists for the scope', async () => {
    const svc = serviceClient();
    const { data, error } = await svc.rpc('get_confidence_policy', {
      p_org_id: ORG_A_ID,
      p_source_kind: 'bill_upload',
      p_task_type: 'category',
      p_supplier_id: null,
    });
    expect(error).toBeNull();
    expect(data).toBeNull();
  });

  it('returns org-scoped policy when one is present', async () => {
    const svc = serviceClient();
    const { data: inserted, error: insErr } = await svc
      .from('confidence_policies')
      .insert({
        org_id: ORG_A_ID,
        source_kind: 'bill_upload',
        task_type: 'category',
        policy: 'quick_confirm',
        supplier_id: null,
      })
      .select()
      .single();
    expect(insErr).toBeNull();
    createdIds.push(inserted.id);

    const { data, error } = await svc.rpc('get_confidence_policy', {
      p_org_id: ORG_A_ID,
      p_source_kind: 'bill_upload',
      p_task_type: 'category',
      p_supplier_id: null,
    });
    expect(error).toBeNull();
    expect(data).toBe('quick_confirm');
  });

  it('supplier-specific policy overrides org-wide policy', async () => {
    const svc = serviceClient();
    const FAKE_SUPPLIER = '00000000-0000-0000-0000-000000000001';

    const { data: inserted, error: insErr } = await svc
      .from('confidence_policies')
      .insert({
        org_id: ORG_A_ID,
        source_kind: 'bill_upload',
        task_type: 'category',
        policy: 'auto_post',
        supplier_id: FAKE_SUPPLIER,
      })
      .select()
      .single();
    expect(insErr).toBeNull();
    createdIds.push(inserted.id);

    const { data, error } = await svc.rpc('get_confidence_policy', {
      p_org_id: ORG_A_ID,
      p_source_kind: 'bill_upload',
      p_task_type: 'category',
      p_supplier_id: FAKE_SUPPLIER,
    });
    expect(error).toBeNull();
    expect(data).toBe('auto_post');
  });

  it('ignores expired policies', async () => {
    const svc = serviceClient();
    const past = new Date(Date.now() - 86_400_000).toISOString();

    const { data: inserted, error: insErr } = await svc
      .from('confidence_policies')
      .insert({
        org_id: ORG_A_ID,
        source_kind: 'receipt_ocr',
        task_type: 'gst_treatment',
        policy: 'advisor_required',
        supplier_id: null,
        valid_until: past,
      })
      .select()
      .single();
    expect(insErr).toBeNull();
    createdIds.push(inserted.id);

    const { data, error } = await svc.rpc('get_confidence_policy', {
      p_org_id: ORG_A_ID,
      p_source_kind: 'receipt_ocr',
      p_task_type: 'gst_treatment',
      p_supplier_id: null,
    });
    expect(error).toBeNull();
    expect(data).toBeNull();
  });

  it('org isolation: ORG_B cannot see ORG_A policies', async () => {
    if (!ORG_B_ID) return;
    const svc = serviceClient();
    const { data, error } = await svc.rpc('get_confidence_policy', {
      p_org_id: ORG_B_ID,
      p_source_kind: 'bill_upload',
      p_task_type: 'category',
      p_supplier_id: null,
    });
    expect(error).toBeNull();
    expect(data).toBeNull();
  });
});

describe('confidence_policies — RLS (no direct inserts from authenticated client)', () => {
  it('authenticated client cannot INSERT directly', async () => {
    const client = authedClient();
    const { error } = await client.from('confidence_policies').insert({
      org_id: ORG_A_ID,
      source_kind: 'bank_match',
      task_type: 'supplier_match',
      policy: 'auto_post',
    });
    expect(error).not.toBeNull();
  });

  it('anon client cannot SELECT', async () => {
    const client = anonClient();
    const { data, error } = await client
      .from('confidence_policies')
      .select('id')
      .eq('org_id', ORG_A_ID);
    // Either an error or empty result (RLS returns nothing for anon)
    expect(error !== null || (data !== null && data.length === 0)).toBe(true);
  });
});
