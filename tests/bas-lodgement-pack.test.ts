import { describe, expect, it } from 'vitest';

/**
 * bas-lodgement-pack integration smoke.
 *
 * Exercises the DEPLOYED `bas-lodgement-pack` edge function against a real
 * caller-visible BAS lodgement row. It expects JSON with a complete bundle,
 * a non-empty PDF base64 string, and guardrails showing no ATO transmission.
 *
 * Skip-safe: needs a deployed function, user JWT, anon key, and a real
 * TEST_BAS_LODGEMENT_ID created by prepare_bas_lodgement_draft.
 */

const SUPABASE_URL = process.env['VITE_SUPABASE_URL'] ?? process.env['SUPABASE_URL'] ?? '';
const ANON_KEY = process.env['VITE_SUPABASE_ANON_KEY'] ?? process.env['SUPABASE_ANON_KEY'] ?? '';
const USER_JWT = process.env['TEST_USER_JWT'] ?? '';
const LODGEMENT_ID = process.env['TEST_BAS_LODGEMENT_ID'] ?? '';

const HAS_ENV = Boolean(SUPABASE_URL && ANON_KEY && USER_JWT && LODGEMENT_ID);

if (!HAS_ENV) {
  console.warn(
    '[bas-lodgement-pack] SKIPPED: needs VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY + ' +
      'TEST_USER_JWT + TEST_BAS_LODGEMENT_ID (deployed fn + caller-visible BAS lodgement).',
  );
}

describe.skipIf(!HAS_ENV)('bas-lodgement-pack (integration, deploy-gated)', () => {
  it('returns a complete review bundle and PDF without ATO transmission', async () => {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/bas-lodgement-pack`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${USER_JWT}`,
        apikey: ANON_KEY,
      },
      body: JSON.stringify({ lodgement_id: LODGEMENT_ID }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok?: boolean;
      bundle?: {
        lodgement_id?: string;
        checks?: {
          ato_transmission_included?: boolean;
          human_declaration_required?: boolean;
          has_required_bas_totals?: boolean;
        };
      };
      pdf_base64?: string;
      filename?: string;
    };

    expect(body.ok).toBe(true);
    expect(body.bundle?.lodgement_id).toBe(LODGEMENT_ID);
    expect(body.bundle?.checks?.ato_transmission_included).toBe(false);
    expect(body.bundle?.checks?.human_declaration_required).toBe(true);
    expect(body.bundle?.checks?.has_required_bas_totals).toBe(true);
    expect(body.pdf_base64?.length).toBeGreaterThan(0);
    expect(body.filename).toMatch(/^bas-lodgement-pack-.*\.pdf$/);
  });
});
