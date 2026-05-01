/**
 * xero-oauth-callback — exchanges the OAuth code for tokens, fetches the
 * tenant list, stores encrypted tokens in `xero_integrations`.
 *
 * Input:  { organization_id: UUID, code: string, redirect_uri: string, state: string }
 * Output: { ok: true, tenants: [...], auto_selected?: boolean }
 *
 * STATUS: skeleton. Port from Loopletnumero `xero.controller.ts authCallback`.
 *
 * Critical TODOs (Phase 3):
 *   - [ ] Verify state matches what xero-oauth-start issued (CSRF)
 *   - [ ] Exchange code → access_token + refresh_token at /connect/token
 *   - [ ] Fetch /connections to list tenants
 *   - [ ] Encrypt tokens with ENCRYPTION_KEY before insert
 *   - [ ] Upsert xero_integrations row (organization_id, xero_tenant_id)
 *   - [ ] If multiple tenants, return list and require explicit pick via select-tenant fn
 *   - [ ] If single tenant, auto-select
 */

import { corsHeaders, preflight } from '../_shared/cors.ts';

Deno.serve((_req) => {
  const pre = preflight(_req);
  if (pre) return pre;

  return new Response(
    JSON.stringify({
      ok: false,
      error: 'Not implemented yet. Phase 3 of docs/ROADMAP.md.',
    }),
    {
      status: 501,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    },
  );
});
