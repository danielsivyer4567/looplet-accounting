// Standard CORS headers for all Looplet Accounting edge functions.
// Browser auth header is required so we can verify_jwt before running.
//
// These functions authenticate via a Supabase JWT or a signed secret, so AUTH —
// not CORS — is the security boundary. A permissive origin is therefore safe and
// lets the app work from all of its domains (accounting.looplet.com.au, the
// pages.dev preview, localhost). Do NOT pin this to the email SITE_URL/APP_ORIGIN:
// doing so silently blocks cross-origin API calls from any other app domain and
// surfaces as "Failed to fetch" in the UI. To deliberately pin to one origin,
// set CORS_ALLOWED_ORIGIN explicitly.
const allowedOrigin = Deno.env.get('CORS_ALLOWED_ORIGIN') ?? '*';

export const corsHeaders = {
  'Access-Control-Allow-Origin': allowedOrigin,
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-request-id',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

export function preflight(req: Request): Response | null {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  return null;
}
