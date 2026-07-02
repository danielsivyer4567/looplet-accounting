// Standard CORS headers for all Looplet Accounting edge functions.
// Browser auth header is required so we can verify_jwt before running.
//
// Deploys should set APP_ORIGIN or SITE_URL to the production app origin. Local
// and unprovisioned environments fall back to "*" so CLI previews and server-to-
// server connector calls keep working until the origin is provisioned.
const allowedOrigin = Deno.env.get('APP_ORIGIN') ?? Deno.env.get('SITE_URL') ?? '*';

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
