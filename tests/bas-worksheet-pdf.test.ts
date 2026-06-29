import { describe, it, expect } from 'vitest';
import { createClient } from '@supabase/supabase-js';

/**
 * bas-worksheet-pdf integration smoke test (SC-3.D.01).
 *
 * Exercises the DEPLOYED `bas-worksheet-pdf` edge function against a live
 * Supabase as a real user: POST {organization_id, fy_start_year, quarter} →
 * expects HTTP 200, application/pdf, and a non-empty %PDF body. Also cross-checks
 * that the generate_bas_worksheet payload the PDF is rendered from exposes the
 * completed GST/PAYG labels, source drilldown, and 9 total the worksheet prints.
 *
 * Skip-safe (NOT a CI hard-gate, unlike the legal-rag suites): the fn is deployed
 * separately and this needs a real user JWT + an accessible org id, neither of
 * which exists in CI — so it skips cleanly until those are provided. Run locally
 * with VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY + TEST_USER_JWT + TEST_ORG_ID
 * (optionally TEST_BAS_FY / TEST_BAS_QUARTER) once the fn + 0120-0122 are live.
 */

const SUPABASE_URL = process.env['VITE_SUPABASE_URL'] ?? process.env['SUPABASE_URL'] ?? '';
const ANON_KEY = process.env['VITE_SUPABASE_ANON_KEY'] ?? process.env['SUPABASE_ANON_KEY'] ?? '';
const USER_JWT = process.env['TEST_USER_JWT'] ?? '';
const ORG_ID = process.env['TEST_ORG_ID'] ?? '';
const FY = Number(process.env['TEST_BAS_FY'] ?? '2025');
const QUARTER = Number(process.env['TEST_BAS_QUARTER'] ?? '4');

const HAS_ENV = Boolean(SUPABASE_URL && ANON_KEY && USER_JWT && ORG_ID);

if (!HAS_ENV) {
  console.warn(
    '[bas-worksheet-pdf] SKIPPED: needs VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY + ' +
      'TEST_USER_JWT + TEST_ORG_ID (deployed fn + 0120-0122 live + an accessible org).',
  );
}

describe.skipIf(!HAS_ENV)('bas-worksheet-pdf (integration, deploy-gated)', () => {
  it('returns a non-empty PDF (HTTP 200) for the requested quarter', async () => {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/bas-worksheet-pdf`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${USER_JWT}`,
        apikey: ANON_KEY,
      },
      body: JSON.stringify({ organization_id: ORG_ID, fy_start_year: FY, quarter: QUARTER }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/pdf');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(0);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
  });

  it('renders from a generate_bas_worksheet payload exposing completed labels and evidence', async () => {
    const client = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${USER_JWT}` } },
    });
    const { data, error } = await client.rpc('generate_bas_worksheet', {
      p_org: ORG_ID,
      p_fy_start_year: FY,
      p_quarter: QUARTER,
    });
    expect(error).toBeNull();
    const payload = data as {
      gst?: Record<string, number>;
      summary?: Record<string, number>;
    } | null;
    expect(payload).toBeTruthy();
    expect(typeof payload?.gst?.['G2']).toBe('number');
    expect(typeof payload?.gst?.['G3']).toBe('number');
    expect(typeof payload?.gst?.['G10']).toBe('number');
    expect(typeof payload?.gst?.['1A']).toBe('number');
    expect(typeof payload?.gst?.['1B']).toBe('number');
    expect(typeof payload?.summary?.['9_net_amount_cents']).toBe('number');
    expect(typeof (payload as { source_drilldown?: unknown })?.source_drilldown).toBe('object');
  });
});
