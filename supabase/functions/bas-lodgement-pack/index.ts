// Edge function: bas-lodgement-pack
//
// Builds a review pack for an existing BAS lodgement draft/submission row:
// JSON bundle + worksheet PDF base64. This is not an ATO transport function.
//
// AUTH: user-invokable. The caller JWT is forwarded into a Supabase anon client,
// so lodgements RLS scopes the row to the caller's organizations.
//
// Request body: { lodgement_id: uuid }
// Response: { ok, bundle, pdf_base64, filename }.

import {
  createClient,
  type SupabaseClient,
} from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, preflight } from "../_shared/cors.ts";
import { requireEnv } from "../_shared/env.ts";
import { renderWorksheetPdf } from "../_shared/pdf/worksheet.ts";
import {
  basLodgementFilename,
  buildBasLodgementBundle,
  type BasLodgementRow,
  toBase64,
  toBasLodgementWorksheetDoc,
} from "./pack.ts";

interface RequestBody {
  lodgement_id?: string;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const LODGEMENT_COLUMNS =
  "id, organization_id, lodgement_type, period_label, payload_hash, payload, " +
  "ato_receipt_id, status, submitted_at, response, error_message, created_at, updated_at, created_by";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function loadLodgement(
  client: SupabaseClient,
  lodgementId: string,
): Promise<BasLodgementRow> {
  const { data, error } = await client
    .from("lodgements")
    .select(LODGEMENT_COLUMNS)
    .eq("id", lodgementId)
    .single();

  if (error) {
    const notFound = error.code === "PGRST116";
    throw new Response(
      JSON.stringify({ ok: false, error: notFound ? "lodgement not found" : error.message }),
      {
        status: notFound ? 404 : 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  if (!data) {
    throw new Response(JSON.stringify({ ok: false, error: "lodgement not found" }), {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  return data as unknown as BasLodgementRow;
}

export async function handleBasLodgementPack(req: Request): Promise<Response> {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ ok: false, error: "Unauthorized" }, 401);

    const body = (await req.json().catch(() => ({}))) as RequestBody;
    const lodgementId = (body.lodgement_id ?? "").trim();
    if (!UUID_RE.test(lodgementId)) {
      return json({ ok: false, error: "valid lodgement_id is required" }, 400);
    }

    const supabaseUrl = requireEnv("SUPABASE_URL");
    const anonKey = requireEnv("SUPABASE_ANON_KEY");
    const client = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });

    const lodgement = await loadLodgement(client, lodgementId);
    if (lodgement.lodgement_type !== "bas") {
      return json({ ok: false, error: "only BAS lodgements can be packed by this endpoint" }, 400);
    }

    const bundle = buildBasLodgementBundle(lodgement, new Date().toISOString());
    const pdf = await renderWorksheetPdf(toBasLodgementWorksheetDoc(lodgement, bundle));

    return json({
      ok: bundle.complete,
      bundle,
      pdf_base64: toBase64(pdf),
      filename: basLodgementFilename(lodgement),
    });
  } catch (err) {
    if (err instanceof Response) return err;
    const msg = err instanceof Error ? err.message : String(err);
    return json({ ok: false, error: msg }, 500);
  }
}

if (import.meta.main) {
  Deno.serve(handleBasLodgementPack);
}
