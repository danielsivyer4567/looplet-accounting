// Edge function: working-papers  (SC-7.G.02)
//
// Turns the SC-7.G.01 compile_working_papers() manifest into a downloadable
// auditor hand-off bundle: structured JSON, a rendered PDF index, and short-lived
// signed links to every source file referenced by the manifest.
//
// AUTH: user-invokable. The Supabase client forwards the caller's JWT, so the
// SECURITY INVOKER RPC and storage.createSignedUrl calls run under the caller's
// RLS/storage policy context. No service-role fetch-by-id and no writes.
//
// Request body: { organization_id: uuid, period_start: "YYYY-MM-DD", period_end: "YYYY-MM-DD" }
// Response: { ok, bundle, pdf_base64, unresolved_source_files }.
//
// DEPLOY-GATED: requires the SC-7.G.01 migration deployed. This slice only adds
// local code + Deno checks/tests; deploy and live smoke are intentionally blocked
// by the run guardrails.

import {
  createClient,
  type SupabaseClient,
} from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, preflight } from "../_shared/cors.ts";
import { requireEnv } from "../_shared/env.ts";
import { requireSbrReady } from "../_shared/lodge/gate.ts";
import { renderWorksheetPdf } from "../_shared/pdf/worksheet.ts";
import {
  buildWorkingPapersBundle,
  collectSourceFileRefs,
  type ResolvedSourceFile,
  type SourceFileRef,
  toBase64,
  toWorkingPapersIndexDoc,
  unresolvedSourceFiles,
} from "./bundle.ts";

interface RequestBody {
  organization_id?: string;
  period_start?: string;
  period_end?: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SIGNED_URL_SECONDS = 60 * 60;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && DATE_RE.test(value);
}

async function compileManifest(
  client: SupabaseClient,
  org: string,
  periodStart: string,
  periodEnd: string,
): Promise<Record<string, unknown>> {
  const { data, error } = await client.rpc("compile_working_papers", {
    p_org: org,
    p_period_start: periodStart,
    p_period_end: periodEnd,
  });
  if (error) throw new Error(`compile_working_papers: ${error.message}`);
  return (data ?? {}) as Record<string, unknown>;
}

async function resolveSourceFile(
  client: SupabaseClient,
  ref: SourceFileRef,
): Promise<ResolvedSourceFile> {
  const { data, error } = await client.storage.from("bills").createSignedUrl(
    ref.storage_key,
    SIGNED_URL_SECONDS,
  );
  if (error || !data?.signedUrl) {
    return {
      ...ref,
      resolved: false,
      signed_url: null,
      expires_in_seconds: SIGNED_URL_SECONDS,
      error: error?.message ?? "signed URL was not returned",
    };
  }

  return {
    ...ref,
    resolved: true,
    signed_url: data.signedUrl,
    expires_in_seconds: SIGNED_URL_SECONDS,
    error: null,
  };
}

async function resolveSourceFiles(
  client: SupabaseClient,
  manifestEnvelope: Record<string, unknown>,
): Promise<ResolvedSourceFile[]> {
  const refs = collectSourceFileRefs(manifestEnvelope);
  return await Promise.all(refs.map((ref) => resolveSourceFile(client, ref)));
}

export async function handleWorkingPapers(req: Request): Promise<Response> {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ ok: false, error: "Unauthorized" }, 401);

    const body = (await req.json().catch(() => ({}))) as RequestBody;
    const org = (body.organization_id ?? "").trim();
    const periodStart = body.period_start;
    const periodEnd = body.period_end;
    if (!org) {
      return json({ ok: false, error: "organization_id is required" }, 400);
    }
    if (
      !validDate(periodStart) || !validDate(periodEnd) ||
      periodEnd < periodStart
    ) {
      return json({
        ok: false,
        error: "valid period_start and period_end are required",
      }, 400);
    }

    // Fail-closed (SC-DEPLOY-04): the auditor hand-off bundle must not be emitted
    // against an unconfigured SBR taxonomy. The bundled-subset fallback satisfies
    // the gate; full prod taxonomy is provisioned by SC-DEPLOY-03.
    const gate = requireSbrReady("working_papers_bundle");
    if (gate) return json(gate, 403);

    const supabaseUrl = requireEnv("SUPABASE_URL");
    const anonKey = requireEnv("SUPABASE_ANON_KEY");
    const client = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });

    const manifest = await compileManifest(client, org, periodStart, periodEnd);
    const sourceFiles = await resolveSourceFiles(client, manifest);
    const bundle = buildWorkingPapersBundle(
      manifest,
      sourceFiles,
      new Date().toISOString(),
    );
    const pdf = await renderWorksheetPdf(toWorkingPapersIndexDoc(bundle));
    const unresolved = unresolvedSourceFiles(sourceFiles);

    return json({
      ok: bundle.complete,
      bundle,
      pdf_base64: toBase64(pdf),
      unresolved_source_files: unresolved,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ ok: false, error: msg }, 500);
  }
}

if (import.meta.main) {
  Deno.serve(handleWorkingPapers);
}
