// Minimal DB-client surface used by the gl/ modules — narrower than the real
// supabase-js SupabaseClient so unit tests can stub it directly (same
// convention as advisoryFacts.ts's AdvisoryFactsClient). A real SupabaseClient
// satisfies this structurally; nothing here changes runtime behaviour.

export interface QueryResult<T> {
  data: T | null;
  error: { message: string } | null;
}

export interface GlQuery<T = unknown> extends PromiseLike<QueryResult<T>> {
  select(columns: string): GlQuery<T>;
  eq(column: string, value: unknown): GlQuery<T>;
  is(column: string, value: unknown): GlQuery<T>;
  insert(payload: unknown): GlQuery<T>;
  delete(): GlQuery<T>;
  single(): PromiseLike<QueryResult<T>>;
  maybeSingle(): PromiseLike<QueryResult<T>>;
}

export interface GlAdminClient {
  from<T = unknown>(table: string): GlQuery<T>;
}

export interface GlOrgClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ error: { message: string } | null }>;
}
