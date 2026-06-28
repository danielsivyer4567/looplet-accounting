#!/usr/bin/env -S deno run --allow-env --allow-net --allow-read
import { handleReceiptSyncDispatchRequest } from '../../supabase/functions/receipt-sync-dispatch/index.ts';
import { handleReceiptWebhookRequest } from '../../supabase/functions/receipt-webhook/index.ts';

const port = Number(Deno.env.get('PORT') ?? '65432');

Deno.serve({ hostname: '127.0.0.1', port }, async (req) => {
  const url = new URL(req.url);
  if (url.pathname === '/functions/v1/receipt-webhook') {
    return handleReceiptWebhookRequest(req);
  }
  if (url.pathname === '/functions/v1/receipt-sync-dispatch') {
    return handleReceiptSyncDispatchRequest(req);
  }
  if (url.pathname === '/health') {
    return Response.json({ ok: true });
  }
  return Response.json({ ok: false, error: 'not_found' }, { status: 404 });
});
