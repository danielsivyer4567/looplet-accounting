/**
 * SC-07 — Reconciliation evidence
 *
 * Tests:
 *  1. reconciliation_evidence table exists with expected columns
 *  2. service_role can insert an evidence row
 *  3. org member can read their own evidence rows
 *  4. org isolation: authenticated user from ORG_A cannot read ORG_B evidence
 *  5. authenticated client cannot INSERT directly (service_role writes only)
 */

import { describe, it, expect, afterAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env['VITE_SUPABASE_URL'] ?? process.env['SUPABASE_URL'] ?? '';
const SERVICE_ROLE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';
const SUPABASE_ANON_KEY = process.env['SUPABASE_ANON_KEY'] ?? '';
const ORG_A_ID = process.env['TEST_ORG_A_ID'] ?? '';
const ORG_B_ID = process.env['TEST_ORG_B_ID'] ?? '';
const TEST_USER_JWT = process.env['TEST_USER_JWT'] ?? '';
const TEST_BANK_TXN_A = process.env['TEST_BANK_TXN_ID_ORG_A'] ?? '';
const TEST_BANK_TXN_B = process.env['TEST_BANK_TXN_ID_ORG_B'] ?? '';

const HAS_LIVE = Boolean(SUPABASE_URL && SERVICE_ROLE_KEY && ORG_A_ID && TEST_BANK_TXN_A);
const itLive = it.skipIf(!HAS_LIVE);

const svc = () => createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const authed = () =>
  createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${TEST_USER_JWT}` } },
  });
const anon = () =>
  createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });

const createdEvidenceIds: string[] = [];

afterAll(async () => {
  if (createdEvidenceIds.length > 0) {
    await svc().from('reconciliation_evidence').delete().in('id', createdEvidenceIds);
  }
});

describe('reconciliation_evidence — schema', () => {
  itLive('table exists with expected columns', async () => {
    const { data, error } = await svc()
      .from('reconciliation_evidence')
      .select(
        'id, bank_transaction_id, organization_id, reason_codes, score_components, auto_applied, skipped_reason, created_at',
      )
      .limit(0);
    expect(error).toBeNull();
    expect(Array.isArray(data)).toBe(true);
  });
});

describe('reconciliation_evidence — service_role writes', () => {
  itLive('service_role can insert an evidence row', async () => {
    const { data, error } = await svc()
      .from('reconciliation_evidence')
      .insert({
        bank_transaction_id: TEST_BANK_TXN_A,
        organization_id: ORG_A_ID,
        reason_codes: ['amount_exact', 'date_recent', 'name_match'],
        score_components: {
          kind: 'bill',
          score: 1.05,
          amount_diff_cents: 0,
          days_diff: 2,
          name_hit: true,
        },
        auto_applied: true,
        skipped_reason: null,
      })
      .select('id')
      .single();
    expect(error).toBeNull();
    const row = data as { id: string };
    expect(row.id).toBeTruthy();
    createdEvidenceIds.push(row.id);
  });
});

describe('reconciliation_evidence — RLS read', () => {
  itLive('org member can read their own evidence', async () => {
    if (!TEST_USER_JWT) return;
    // Insert via service_role first
    const { data: inserted } = await svc()
      .from('reconciliation_evidence')
      .insert({
        bank_transaction_id: TEST_BANK_TXN_A,
        organization_id: ORG_A_ID,
        reason_codes: ['amount_match'],
        score_components: { kind: 'bill', score: 0.75, amount_diff_cents: 10, days_diff: 5 },
        auto_applied: false,
        skipped_reason: 'rival_candidate_present',
      })
      .select('id')
      .single();
    const evidenceId = (inserted as { id: string } | null)?.id;
    if (!evidenceId) return;
    createdEvidenceIds.push(evidenceId);

    const { data, error } = await authed()
      .from('reconciliation_evidence')
      .select('id, reason_codes, auto_applied')
      .eq('id', evidenceId);
    expect(error).toBeNull();
    expect((data ?? []).length).toBe(1);
    const row = (data as { id: string; reason_codes: string[]; auto_applied: boolean }[])[0];
    expect(row).toBeDefined();
    if (!row) return;
    expect(row.auto_applied).toBe(false);
    expect(row.reason_codes).toContain('amount_match');
  });

  itLive('authenticated user from ORG_A cannot read ORG_B evidence', async () => {
    if (!ORG_B_ID || !TEST_BANK_TXN_B || !TEST_USER_JWT) return;
    const { data: inserted } = await svc()
      .from('reconciliation_evidence')
      .insert({
        bank_transaction_id: TEST_BANK_TXN_B,
        organization_id: ORG_B_ID,
        reason_codes: ['amount_exact'],
        score_components: { kind: 'invoice', score: 1.2 },
        auto_applied: true,
        skipped_reason: null,
      })
      .select('id')
      .single();
    const evidenceId = (inserted as { id: string } | null)?.id;
    if (!evidenceId) return;
    createdEvidenceIds.push(evidenceId);

    // ORG_A user must not see ORG_B evidence
    const { data } = await authed()
      .from('reconciliation_evidence')
      .select('id')
      .eq('id', evidenceId);
    expect((data ?? []).length).toBe(0);
  });
});

describe('reconciliation_evidence — write deny', () => {
  itLive('authenticated client cannot INSERT directly', async () => {
    if (!TEST_USER_JWT) return;
    const { error } = await authed()
      .from('reconciliation_evidence')
      .insert({
        bank_transaction_id: TEST_BANK_TXN_A,
        organization_id: ORG_A_ID,
        reason_codes: ['amount_match'],
        score_components: {},
        auto_applied: false,
      });
    expect(error).not.toBeNull();
  });

  itLive('anon client cannot INSERT directly', async () => {
    const { error } = await anon().from('reconciliation_evidence').insert({
      bank_transaction_id: TEST_BANK_TXN_A,
      organization_id: ORG_A_ID,
      reason_codes: [],
      score_components: {},
      auto_applied: false,
    });
    expect(error).not.toBeNull();
  });
});
