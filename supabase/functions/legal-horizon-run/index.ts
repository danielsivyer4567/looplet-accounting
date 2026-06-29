// Edge function: legal-horizon-run
//
// User-invoked proxy for the backend-only legal-horizon-scan function. The browser
// never receives LEGAL_SCAN_SECRET or SUPABASE_SERVICE_ROLE_KEY; it presents a user
// JWT here, this function verifies accountant/admin/owner membership, then invokes
// legal-horizon-scan with the service-role bearer.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, preflight } from '../_shared/cors.ts';
import { requireEnv } from '../_shared/env.ts';

type OrgRole = 'viewer' | 'employee' | 'accountant' | 'admin' | 'owner';
type LegacyRole = 'member' | 'manager' | 'admin' | 'owner';

interface MembershipRow {
  role_enum: OrgRole | null;
  role: LegacyRole | null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function canRunScan(memberships: MembershipRow[] | null): boolean {
  return (memberships ?? []).some(
    (m) =>
      m.role_enum === 'accountant' ||
      m.role_enum === 'admin' ||
      m.role_enum === 'owner' ||
      m.role === 'manager' ||
      m.role === 'admin' ||
      m.role === 'owner',
  );
}

function scanUrl(supabaseUrl: string): string {
  return `${supabaseUrl.replace(/\/+$/, '')}/functions/v1/legal-horizon-scan`;
}

async function parseScannerBody(resp: Response): Promise<Record<string, unknown>> {
  const text = await resp.text();
  try {
    const body = JSON.parse(text) as unknown;
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
  } catch {
    // Fall through to a normalized error payload below.
  }
  return {
    ok: false,
    error: text.trim() || `legal-horizon-scan returned ${resp.status}`,
  };
}

Deno.serve(async (req: Request) => {
  const pre = preflight(req);
  if (pre) return pre;

  if (req.method !== 'POST') {
    return json({ ok: false, error: 'Method not allowed' }, 405);
  }

  try {
    const supabaseUrl = requireEnv('SUPABASE_URL');
    const anonKey = requireEnv('SUPABASE_ANON_KEY');
    const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

    const authHeader = req.headers.get('Authorization') ?? '';
    if (!/^Bearer\s+\S+/i.test(authHeader)) {
      return json({ ok: false, error: 'Unauthorized' }, 401);
    }

    const userClient = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: authHeader } },
    });

    const {
      data: { user },
      error: userErr,
    } = await userClient.auth.getUser();
    if (userErr || !user) return json({ ok: false, error: 'Unauthorized' }, 401);

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: memberships, error: membershipErr } = await admin
      .from('organization_memberships')
      .select('role_enum, role')
      .eq('user_id', user.id)
      .not('accepted_at', 'is', null)
      .limit(100);

    if (membershipErr) {
      console.error('[legal-horizon-run] membership check failed', membershipErr.message);
      return json({ ok: false, error: 'Failed to verify role' }, 500);
    }

    if (!canRunScan((memberships ?? []) as MembershipRow[])) {
      return json(
        { ok: false, error: 'Only accountants, admins, or owners can run legal horizon scans.' },
        403,
      );
    }

    // Do not forward arbitrary user JSON. The operator/test-only `items` and
    // `topics` overrides on legal-horizon-scan remain backend-only.
    const scanner = await fetch(scanUrl(supabaseUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        apikey: anonKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    const body = await parseScannerBody(scanner);

    if (!scanner.ok) {
      return json(
        {
          ok: false,
          error:
            typeof body['error'] === 'string'
              ? body['error']
              : `legal-horizon-scan failed (${scanner.status})`,
        },
        scanner.status,
      );
    }

    return json(body, scanner.status);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ ok: false, error: msg }, 500);
  }
});
