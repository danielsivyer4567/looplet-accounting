// Per-user limits on paid AI features.
//
// Public sign-up lets anyone create an account and an organisation, so membership alone does not stop
// someone spending our Groq, Perplexity, OpenAI, Anthropic or MiniMax credit. Before a paid call, a
// function that has verified a signed-in user takes one unit of that user's hourly quota for the
// feature. The count lives in Postgres (public.consume_ai_quota, migration 20261003160100), so it holds
// across isolates and regions. Service-role and cron callers are not limited.
//
// Defaults are below; AI_RATE_LIMIT_<FEATURE> (for example AI_RATE_LIMIT_ASK_BOT=30) overrides one.

export type AiFeature =
  | 'ask_bot'
  | 'bank_statement_extract'
  | 'staged_entities_enrich'
  | 'gmail_classify_ai'
  | 'bills_extract'
  | 'advisor'
  | 'bank_transaction_classifier';

/** Calls per user per hour. Each unit is one request; the comment says what one request spends. */
export const AI_HOURLY_LIMITS: Readonly<Record<AiFeature, number>> = {
  ask_bot: 60, // one question: routing, SQL and answer calls, sometimes a Perplexity lookup
  bank_statement_extract: 200, // one statement page sent to the vision model
  staged_entities_enrich: 20, // one run: up to 10 Perplexity batches
  gmail_classify_ai: 20, // one run: up to 40 model batches
  bills_extract: 200, // one document read by OCR
  advisor: 60, // one advice request with Perplexity citations
  bank_transaction_classifier: 30, // one run: up to 500 transactions
};

const WINDOW_SECONDS = 3600;

type EnvReader = Pick<typeof Deno.env, 'get'>;

export function hourlyLimit(feature: AiFeature, env: EnvReader = Deno.env): number {
  const override = Number(env.get(`AI_RATE_LIMIT_${feature.toUpperCase()}`));
  return Number.isInteger(override) && override > 0 ? override : AI_HOURLY_LIMITS[feature];
}

export interface QuotaRpc {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
}

interface QuotaRow {
  allowed: boolean;
  used: number;
  retry_after_seconds: number;
}

function minutes(seconds: number): string {
  const m = Math.max(1, Math.ceil(seconds / 60));
  return m === 1 ? '1 minute' : `${m} minutes`;
}

/**
 * Takes one unit of the user's hourly quota for a paid AI feature. Returns null when the call may go
 * ahead, or the response to send instead: 429 with Retry-After when the quota is used up, 503 when the
 * quota cannot be checked. Until migration 20261003160100 is applied (functions deploy first), a missing
 * consume_ai_quota is logged and the call is allowed, as it was before limits existed.
 */
export async function enforceAiQuota(
  admin: QuotaRpc,
  userId: string,
  feature: AiFeature,
  headers: Record<string, string>,
  env: EnvReader = Deno.env,
): Promise<Response | null> {
  const limit = hourlyLimit(feature, env);
  const { data, error } = await admin.rpc('consume_ai_quota', {
    p_user_id: userId,
    p_feature: feature,
    p_limit: limit,
    p_window_seconds: WINDOW_SECONDS,
  });
  if (error) {
    if (error.code === 'PGRST202' || error.code === '42883') {
      console.warn(`[ai-quota] consume_ai_quota is not installed yet; ${feature} is not rate limited`);
      return null;
    }
    console.error(`[ai-quota] could not check the ${feature} quota: ${error.message}`);
    return new Response(JSON.stringify({ ok: false, error: 'AI features are unavailable right now. Please try again shortly.' }), {
      status: 503,
      headers: { ...headers, 'Content-Type': 'application/json', 'Retry-After': '60' },
    });
  }
  const row = (Array.isArray(data) ? data[0] : data) as QuotaRow | undefined;
  if (row?.allowed) return null;
  const retryAfter = Math.max(1, Math.round(Number(row?.retry_after_seconds) || WINDOW_SECONDS));
  return new Response(
    JSON.stringify({
      ok: false,
      code: 'rate_limited',
      error: `You have reached the limit of ${limit} uses an hour for this feature. Try again in ${minutes(retryAfter)}.`,
      retry_after_seconds: retryAfter,
    }),
    { status: 429, headers: { ...headers, 'Content-Type': 'application/json', 'Retry-After': String(retryAfter) } },
  );
}
