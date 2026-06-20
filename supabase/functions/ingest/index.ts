// Edge function: ingest  (SCAFFOLD — see AUDIT.md §5, B5)
// Generic external ingestion endpoint so ANY source can push records in.
//   POST { type: 'bill' | 'bank_transaction' | 'invoice', payload: {...} }
// Authenticated by an external API key; writes under service-role AFTER pinning
// organization_id to the key's org (org is never trusted from the body). Dedupe
// makes re-pushes idempotent.
//
// REQUIRES: supabase/config.toml -> [functions.ingest] verify_jwt = false
import { authenticateApiKey, hasScope, serviceClient, sha256Hex } from "../_shared/apiKeys.ts";

const SCOPE_FOR: Record<string, string> = {
  bill: "write:bills",
  bank_transaction: "write:bank",
  invoice: "write:invoices",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const ctx = await authenticateApiKey(req.headers.get("authorization"));
  if (!ctx) return json({ error: "invalid_api_key" }, 401);

  let body: { type?: string; payload?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const type = body.type ?? "";
  const payload = body.payload;
  if (!payload || !(type in SCOPE_FOR)) return json({ error: "unsupported_type" }, 400);
  if (!hasScope(ctx, SCOPE_FOR[type])) return json({ error: "insufficient_scope" }, 403);

  const db = serviceClient();
  const orgId = ctx.organizationId; // pinned from the key

  // TODO: route each type through the SAME validation + dedupe + bill router used
  // by the Gmail/CSV importers (_shared/bills/router.ts and the bank-csv dedupe),
  // so API-pushed records get identical auto-attach / auto-route treatment.
  if (type === "bill") {
    const contentHash = await sha256Hex(JSON.stringify({ o: orgId, p: payload }));
    const { data, error } = await db
      .from("bills")
      .upsert(
        { organization_id: orgId, source: "api", content_hash: contentHash, ...payload },
        { onConflict: "content_hash", ignoreDuplicates: true },
      )
      .select("id")
      .maybeSingle();
    if (error) return json({ error: error.message }, 400);
    return json({ ok: true, id: data?.id ?? null, deduped: !data });
  }

  // bank_transaction / invoice: same pattern — pin organization_id, dedupe, insert.
  return json({ error: "not_implemented", note: `handler for ${type} is scaffolded; wire to shared importer` }, 501);
});
