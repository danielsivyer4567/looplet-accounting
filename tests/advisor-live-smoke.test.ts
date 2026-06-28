import { describe, it, expect, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * advisor live signed-in smoke.
 *
 * This is the missing wrap-up proof for the Ask/on-demand Advisor path:
 * a real member JWT invokes the deployed `advisor` Edge Function, the function
 * creates a draft `advice_notes` row through the caller-scoped RPC, and the same
 * user can see that row through `list_advice_notes` as the Ask page does after an
 * Advisor scenario completes.
 *
 * Env required:
 *   - VITE_SUPABASE_URL      (or SUPABASE_URL)
 *   - VITE_SUPABASE_ANON_KEY (or SUPABASE_ANON_KEY)
 *   - SUPABASE_SERVICE_ROLE_KEY
 *   - TEST_USER_JWT          signed-in user token for TEST_ORG_ID
 *   - TEST_ORG_ID            org where that user has accountant/admin/owner role
 *
 * The service role is used only to verify and delete the smoke-created note.
 */

const SUPABASE_URL = process.env['VITE_SUPABASE_URL'] ?? process.env['SUPABASE_URL'] ?? '';
const ANON_KEY = process.env['VITE_SUPABASE_ANON_KEY'] ?? process.env['SUPABASE_ANON_KEY'] ?? '';
const SERVICE_ROLE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';
const TEST_USER_JWT = process.env['TEST_USER_JWT'] ?? '';
const TEST_ORG_ID = process.env['TEST_ORG_ID'] ?? '';

const HAS_ENV = Boolean(
  SUPABASE_URL && ANON_KEY && SERVICE_ROLE_KEY && TEST_USER_JWT && TEST_ORG_ID,
);
const IS_CI = Boolean(process.env['CI']);
const SKIP_REASON =
  'advisor live smoke requires VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY + ' +
  'SUPABASE_SERVICE_ROLE_KEY + TEST_USER_JWT + TEST_ORG_ID.';

if (IS_CI && !HAS_ENV) {
  throw new Error(`[advisor-live-smoke] FATAL: ${SKIP_REASON}`);
}

const itLive = it.skipIf(!HAS_ENV);
const FN_URL = `${SUPABASE_URL}/functions/v1/advisor`;

describe('advisor live signed-in smoke', () => {
  let admin: SupabaseClient | null = null;
  let noteId = '';

  afterAll(async () => {
    if (!admin || !noteId) return;
    await admin.from('advice_notes').delete().eq('id', noteId);
  }, 30_000);

  itLive(
    'creates a draft advice note and lists it through the user RPC',
    async () => {
      admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });

      const res = await fetch(FN_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TEST_USER_JWT}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          organization_id: TEST_ORG_ID,
          mode: 'forecast',
          as_at_date: new Date().toISOString().slice(0, 10),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      expect(res.status, `advisor response: ${JSON.stringify(body)}`).toBe(200);
      expect(body['ok']).toBe(true);
      expect(typeof body['advice_note_id']).toBe('string');
      noteId = body['advice_note_id'] as string;

      const note = await admin
        .from('advice_notes')
        .select('id, organization_id, kind, status, title, inputs')
        .eq('id', noteId)
        .single();
      expect(note.error, `select smoke note: ${note.error?.message}`).toBeNull();
      expect(note.data?.organization_id).toBe(TEST_ORG_ID);
      expect(note.data?.kind).toBe('forecast');
      expect(note.data?.status).toBe('draft');
      expect(note.data?.inputs?.mode).toBe('forecast');

      const userClient = createClient(SUPABASE_URL, ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { headers: { Authorization: `Bearer ${TEST_USER_JWT}` } },
      });
      const listed = await userClient.rpc('list_advice_notes', {
        p_org: TEST_ORG_ID,
        p_kind: null,
        p_status: null,
      });
      expect(listed.error, `list_advice_notes: ${listed.error?.message}`).toBeNull();
      expect(Array.isArray(listed.data)).toBe(true);
      expect((listed.data ?? []).some((row: { id?: string }) => row.id === noteId)).toBe(true);
    },
    90_000,
  );
});
