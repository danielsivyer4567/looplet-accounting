/**
 * bills-extract-batch — sequential drainer for the OCR queue.
 *
 * The original gmail-backfill fired bills-extract per bill in parallel, which
 * hit Groq's RPM limit and left bills stuck in status='received'. This worker
 * processes bills one at a time with a 2s delay (Groq Llama-4 Scout free tier
 * is ~30 RPM = one every 2 seconds is safe).
 *
 * Input:  { organization_id, max?: 20 }
 * Output: { ok, processed, succeeded, failed, errors[] }
 *
 * Frontend calls repeatedly until processed=0 (queue drained).
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, preflight } from '../_shared/cors.ts';

interface RequestBody {
  organization_id?: string;
  max?: number;
  delay_ms?: number;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ ok: false, error: 'Unauthorized' }, 401);

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    if (!supabaseUrl || !serviceKey || !anonKey) {
      return json({ ok: false, error: 'Server config missing' }, 500);
    }

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const body = (await req.json()) as RequestBody;
    if (!body.organization_id) return json({ ok: false, error: 'organization_id required' }, 400);

    // RLS check
    const { data: org, error: orgErr } = await userClient
      .from('organizations')
      .select('id')
      .eq('id', body.organization_id)
      .maybeSingle();
    if (orgErr || !org) return json({ ok: false, error: 'Organisation not accessible' }, 403);

    const max = Math.max(1, Math.min(50, body.max ?? 20));
    const delay_ms = Math.max(500, Math.min(5000, body.delay_ms ?? 2000));

    // Pull queue
    const { data: queue } = await admin
      .from('bills')
      .select('id, original_filename')
      .eq('organization_id', body.organization_id)
      .eq('status', 'received')
      .order('created_at', { ascending: true })
      .limit(max);

    const stats = { processed: 0, succeeded: 0, failed: 0, errors: [] as Array<{ bill_id: string; error: string }> };
    if (!queue || queue.length === 0) {
      const { count: stillReceived } = await admin
        .from('bills')
        .select('*', { count: 'exact', head: true })
        .eq('organization_id', body.organization_id)
        .eq('status', 'received');
      return json({ ok: true, stats, remaining: stillReceived ?? 0 });
    }

    const billsExtractUrl = `${supabaseUrl}/functions/v1/bills-extract`;

    for (let i = 0; i < queue.length; i++) {
      const bill = queue[i]!;
      stats.processed += 1;
      try {
        const r = await fetch(billsExtractUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${serviceKey}`,
          },
          body: JSON.stringify({ bill_id: bill.id }),
        });
        if (r.ok) {
          const j = await r.json();
          if (j?.ok) stats.succeeded += 1;
          else {
            stats.failed += 1;
            stats.errors.push({ bill_id: bill.id, error: j?.error ?? 'unknown' });
          }
        } else {
          stats.failed += 1;
          stats.errors.push({ bill_id: bill.id, error: `HTTP ${r.status}` });
        }
      } catch (err) {
        stats.failed += 1;
        const msg = err instanceof Error ? err.message : String(err);
        stats.errors.push({ bill_id: bill.id, error: msg });
      }

      // Rate-limit pause between bills (skip after last)
      if (i < queue.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, delay_ms));
      }
    }

    // Count remaining
    const { count: remaining } = await admin
      .from('bills')
      .select('*', { count: 'exact', head: true })
      .eq('organization_id', body.organization_id)
      .eq('status', 'received');

    return json({
      ok: true,
      stats,
      remaining: remaining ?? 0,
      delay_ms,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ ok: false, error: msg }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
