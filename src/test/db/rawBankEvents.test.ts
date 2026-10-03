/**
 * SC-06 — Raw bank event layer
 *
 * Tests:
 *  1. bank_events_raw table exists with expected columns
 *  2. Duplicate raw event (same provider/org/event_id/hash) rejected by unique constraint
 *  3. replay_bank_event RPC returns payload for service_role only
 *  4. Org isolation: authenticated client cannot read another org's raw events
 *  5. Unauthenticated client cannot INSERT directly
 */

import { describe, it, expect, afterAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env['VITE_SUPABASE_URL'] ?? process.env['SUPABASE_URL'] ?? '';
const SERVICE_ROLE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';
const SUPABASE_ANON_KEY = process.env['SUPABASE_ANON_KEY'] ?? '';
const ORG_A_ID = process.env['TEST_ORG_A_ID'] ?? '';
const ORG_B_ID = process.env['TEST_ORG_B_ID'] ?? '';
const TEST_USER_JWT = process.env['TEST_USER_JWT'] ?? '';

const HAS_LIVE = Boolean(SUPABASE_URL && SERVICE_ROLE_KEY && ORG_A_ID);
const itLive = it.skipIf(!HAS_LIVE);

const svc = () => createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const authed = () =>
  createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${TEST_USER_JWT}` } },
  });
const anon = () =>
  createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });

const createdRawEventIds: string[] = [];

afterAll(async () => {
  if (createdRawEventIds.length > 0) {
    await svc().from('bank_events_raw').delete().in('id', createdRawEventIds);
  }
});

describe('bank_events_raw — schema', () => {
  itLive('table exists with expected columns', async () => {
    const { data, error } = await svc()
      .from('bank_events_raw')
      .select(
        'id, organization_id, provider, provider_event_id, payload_hash, raw_payload, received_at',
      )
      .limit(0);
    expect(error).toBeNull();
    expect(Array.isArray(data)).toBe(true);
  });

  itLive('bank_transactions has raw_event_id column', async () => {
    const { data, error } = await svc()
      .from('bank_transactions')
      .select('id, raw_event_id')
      .limit(0);
    expect(error).toBeNull();
    expect(Array.isArray(data)).toBe(true);
  });
});

describe('bank_events_raw — idempotency', () => {
  itLive('service_role can insert a raw event', async () => {
    const { data, error } = await svc()
      .from('bank_events_raw')
      .insert({
        organization_id: ORG_A_ID,
        provider: 'redbark',
        provider_event_id: 'txn:test-dedup-001',
        payload_hash: 'aabbcc001',
        raw_payload: { amount: '10.00', description: 'Test txn' },
      })
      .select('id')
      .single();
    expect(error).toBeNull();
    const row = data as { id: string };
    expect(row.id).toBeTruthy();
    createdRawEventIds.push(row.id);
  });

  itLive('duplicate raw event (same provider/org/event_id/hash) is rejected', async () => {
    // First insert succeeds (or already done above)
    await svc()
      .from('bank_events_raw')
      .insert({
        organization_id: ORG_A_ID,
        provider: 'redbark',
        provider_event_id: 'txn:test-dedup-002',
        payload_hash: 'aabbcc002',
        raw_payload: { amount: '20.00' },
      })
      .select('id')
      .single();

    const { data: first } = await svc()
      .from('bank_events_raw')
      .select('id')
      .eq('organization_id', ORG_A_ID)
      .eq('provider_event_id', 'txn:test-dedup-002')
      .single();
    if (first?.id) createdRawEventIds.push((first as { id: string }).id);

    // Exact duplicate must fail
    const { error: dupError } = await svc()
      .from('bank_events_raw')
      .insert({
        organization_id: ORG_A_ID,
        provider: 'redbark',
        provider_event_id: 'txn:test-dedup-002',
        payload_hash: 'aabbcc002',
        raw_payload: { amount: '20.00' },
      });
    expect(dupError).not.toBeNull();
    expect(dupError?.code).toBe('23505');
  });

  itLive('different payload hash for same event_id creates new row', async () => {
    const base = {
      organization_id: ORG_A_ID,
      provider: 'redbark',
      provider_event_id: 'txn:test-dedup-003',
      raw_payload: { amount: '30.00' },
    };
    const { data: r1 } = await svc()
      .from('bank_events_raw')
      .insert({ ...base, payload_hash: 'hash-v1' })
      .select('id')
      .single();
    const { data: r2 } = await svc()
      .from('bank_events_raw')
      .insert({ ...base, payload_hash: 'hash-v2' })
      .select('id')
      .single();
    expect((r1 as { id: string } | null)?.id).toBeTruthy();
    expect((r2 as { id: string } | null)?.id).toBeTruthy();
    expect((r1 as { id: string }).id).not.toBe((r2 as { id: string }).id);
    if (r1) createdRawEventIds.push((r1 as { id: string }).id);
    if (r2) createdRawEventIds.push((r2 as { id: string }).id);
  });
});

describe('replay_bank_event RPC', () => {
  itLive('returns raw payload for a known event', async () => {
    const { data: inserted } = await svc()
      .from('bank_events_raw')
      .insert({
        organization_id: ORG_A_ID,
        provider: 'redbark',
        provider_event_id: 'txn:test-replay-001',
        payload_hash: 'replay-hash-001',
        raw_payload: { amount: '99.00', description: 'Replay test' },
      })
      .select('id')
      .single();
    const eventId = (inserted as { id: string } | null)?.id;
    if (!eventId) return;
    createdRawEventIds.push(eventId);

    const { data, error } = await svc().rpc('replay_bank_event', { p_event_id: eventId });
    expect(error).toBeNull();
    const result = data as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result.event_id).toBe(eventId);
    expect(result.provider).toBe('redbark');
    expect((result.raw_payload as Record<string, unknown>).amount).toBe('99.00');
  });

  itLive('returns ok=false for unknown event id', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000099';
    const { data, error } = await svc().rpc('replay_bank_event', { p_event_id: fakeId });
    expect(error).toBeNull();
    const result = data as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe('string');
  });

  itLive('authenticated user from ORG_A cannot execute replay_bank_event', async () => {
    if (!ORG_B_ID || !TEST_USER_JWT) return;
    // Insert an event belonging to ORG_B
    const { data: inserted } = await svc()
      .from('bank_events_raw')
      .insert({
        organization_id: ORG_B_ID,
        provider: 'redbark',
        provider_event_id: 'txn:test-replay-isolation',
        payload_hash: 'replay-iso-hash',
        raw_payload: { amount: '1.00' },
      })
      .select('id')
      .single();
    const eventId = (inserted as { id: string } | null)?.id;
    if (!eventId) return;
    createdRawEventIds.push(eventId);

    const { data, error } = await authed().rpc('replay_bank_event', { p_event_id: eventId });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error?.message ?? '').toMatch(/permission denied|not authorized|execute/i);
  });

  itLive('anon user cannot execute replay_bank_event', async () => {
    const { data: inserted } = await svc()
      .from('bank_events_raw')
      .insert({
        organization_id: ORG_A_ID,
        provider: 'redbark',
        provider_event_id: 'txn:test-replay-anon-denied',
        payload_hash: 'replay-anon-denied-hash',
        raw_payload: { amount: '2.00' },
      })
      .select('id')
      .single();
    const eventId = (inserted as { id: string } | null)?.id;
    if (!eventId) return;
    createdRawEventIds.push(eventId);

    const { data, error } = await anon().rpc('replay_bank_event', { p_event_id: eventId });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error?.message ?? '').toMatch(/permission denied|not authorized|execute/i);
  });
});

describe('bank_events_raw — unmatched (null-org) events', () => {
  itLive('service_role can insert an unmatched event with organization_id = null', async () => {
    const { data, error } = await svc()
      .from('bank_events_raw')
      .insert({
        organization_id: null,
        provider: 'redbark',
        provider_event_id: 'connection.updated:unknown-conn-001',
        payload_hash: 'unmatched-hash-001',
        raw_payload: { type: 'connection.updated', data: {} },
      })
      .select('id')
      .single();
    expect(error).toBeNull();
    const row = data as { id: string };
    expect(row.id).toBeTruthy();
    createdRawEventIds.push(row.id);
  });

  itLive(
    'duplicate unmatched event (same provider/event_id/hash, org=null) is rejected',
    async () => {
      await svc().from('bank_events_raw').insert({
        organization_id: null,
        provider: 'redbark',
        provider_event_id: 'connection.updated:unknown-conn-002',
        payload_hash: 'unmatched-hash-002',
        raw_payload: {},
      });
      const { data: first } = await svc()
        .from('bank_events_raw')
        .select('id')
        .is('organization_id', null)
        .eq('provider_event_id', 'connection.updated:unknown-conn-002')
        .single();
      if (first?.id) createdRawEventIds.push((first as { id: string }).id);

      const { error: dupError } = await svc().from('bank_events_raw').insert({
        organization_id: null,
        provider: 'redbark',
        provider_event_id: 'connection.updated:unknown-conn-002',
        payload_hash: 'unmatched-hash-002',
        raw_payload: {},
      });
      expect(dupError).not.toBeNull();
      expect(dupError?.code).toBe('23505');
    },
  );

  itLive('authenticated user cannot read null-org events via RLS', async () => {
    if (!TEST_USER_JWT) return;
    const { data: inserted } = await svc()
      .from('bank_events_raw')
      .insert({
        organization_id: null,
        provider: 'redbark',
        provider_event_id: 'connection.updated:unknown-conn-003',
        payload_hash: 'unmatched-hash-003',
        raw_payload: {},
      })
      .select('id')
      .single();
    const eventId = (inserted as { id: string } | null)?.id;
    if (!eventId) return;
    createdRawEventIds.push(eventId);

    const { data } = await authed().from('bank_events_raw').select('id').eq('id', eventId);
    expect((data ?? []).length).toBe(0);
  });

  itLive('authenticated user cannot execute replay_bank_event for a null-org event', async () => {
    if (!TEST_USER_JWT) return;
    const { data: inserted } = await svc()
      .from('bank_events_raw')
      .insert({
        organization_id: null,
        provider: 'redbark',
        provider_event_id: 'connection.updated:unknown-conn-004',
        payload_hash: 'unmatched-hash-004',
        raw_payload: {},
      })
      .select('id')
      .single();
    const eventId = (inserted as { id: string } | null)?.id;
    if (!eventId) return;
    createdRawEventIds.push(eventId);

    const { data, error } = await authed().rpc('replay_bank_event', { p_event_id: eventId });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error?.message ?? '').toMatch(/permission denied|not authorized|execute/i);
  });
});

describe('bank_events_raw — org isolation', () => {
  itLive('authenticated client cannot read another org raw events via RLS', async () => {
    if (!ORG_B_ID || !TEST_USER_JWT) return;
    // Insert an event for ORG_B
    const { data: inserted } = await svc()
      .from('bank_events_raw')
      .insert({
        organization_id: ORG_B_ID,
        provider: 'redbark',
        provider_event_id: 'txn:test-isolation-001',
        payload_hash: 'iso-hash-001',
        raw_payload: { amount: '50.00' },
      })
      .select('id')
      .single();
    const eventId = (inserted as { id: string } | null)?.id;
    if (!eventId) return;
    createdRawEventIds.push(eventId);

    // User who belongs to ORG_A should not see ORG_B's event
    const { data } = await authed().from('bank_events_raw').select('id').eq('id', eventId);
    expect((data ?? []).length).toBe(0);
  });

  itLive('anon client cannot INSERT', async () => {
    const { error } = await anon().from('bank_events_raw').insert({
      organization_id: ORG_A_ID,
      provider: 'redbark',
      provider_event_id: 'txn:anon-test',
      payload_hash: 'anon-hash',
      raw_payload: {},
    });
    expect(error).not.toBeNull();
  });
});
