/**
 * Chainable Supabase client mock.
 *
 * Returns a fluent builder that resolves to { data, error } just like the real
 * Supabase JS client.  Tests configure the response before rendering:
 *
 *   import { mockSupabaseResponse } from '@/test/mocks/supabase';
 *   mockSupabaseResponse({ data: [{ id: '1', name: 'Acme' }], error: null });
 *
 * The mock is registered via vi.mock('@/lib/supabase') at the top of each
 * test file — Vitest hoists vi.mock() calls automatically.
 *
 * Usage pattern in a test file:
 *
 *   vi.mock('@/lib/supabase', () => import('@/test/mocks/supabase'));
 *
 * Or, if you need to configure responses per-test, import mockSupabaseResponse
 * and call it in beforeEach / within each test.
 */

import { vi } from 'vitest';

// ---------------------------------------------------------------------------
// Shared mutable response state
// ---------------------------------------------------------------------------

let _pendingResponse: { data: unknown; error: { message: string } | null } = {
  data: [],
  error: null,
};

interface SupabaseOperation {
  table: string;
  method: 'insert' | 'update' | 'delete' | 'upsert';
  payload?: unknown;
}

let _operations: SupabaseOperation[] = [];

/**
 * Call this before rendering to control what the next Supabase query returns.
 * @example
 *   mockSupabaseResponse({ data: null, error: { message: 'Forbidden' } });
 */
export function mockSupabaseResponse(response: {
  data: unknown;
  error: { message: string } | null;
}) {
  _pendingResponse = response;
}

export function clearSupabaseOperations() {
  _operations = [];
}

export function getSupabaseOperations(): SupabaseOperation[] {
  return _operations.slice();
}

// ---------------------------------------------------------------------------
// Chainable builder — mirrors PostgREST fluent API surface
// ---------------------------------------------------------------------------

function makeBuilder(table: string): ReturnType<typeof buildChain> {
  return buildChain(table);
}

function buildChain(table: string) {
  const chain: Record<string, unknown> = {};

  // All terminal methods resolve to the pending response.
  const terminal = () => Promise.resolve(_pendingResponse);

  // Non-terminal methods return the same chain so calls can continue.
  const passthrough = () => chain;

  ['insert', 'update', 'upsert'].forEach((method) => {
    chain[method] = (payload: unknown) => {
      _operations.push({
        table,
        method: method as SupabaseOperation['method'],
        payload,
      });
      return chain;
    };
  });

  chain['delete'] = () => {
    _operations.push({ table, method: 'delete' });
    return chain;
  };

  [
    'select',
    'eq',
    'neq',
    'gt',
    'lt',
    'gte',
    'lte',
    'like',
    'ilike',
    'in',
    'is',
    'not',
    'or',
    'filter',
    'order',
    'limit',
    'range',
    'match',
    'returns',
  ].forEach((method) => {
    chain[method] = passthrough;
  });

  // .single() and .maybeSingle() unwrap { data: T[] } → { data: T | null }
  chain['single'] = () =>
    Promise.resolve({
      data: Array.isArray(_pendingResponse.data)
        ? (_pendingResponse.data[0] ?? null)
        : _pendingResponse.data,
      error: _pendingResponse.error,
    });

  chain['maybeSingle'] = chain['single'];

  // Allow await directly on the builder (like the real client)
  chain['then'] = (resolve: (v: unknown) => unknown) => terminal().then(resolve);

  return chain as unknown as QueryChain;
}

// Minimal structural type so TypeScript is happy inside test files.
interface QueryChain {
  select: (...args: unknown[]) => QueryChain;
  insert: (...args: unknown[]) => QueryChain;
  update: (...args: unknown[]) => QueryChain;
  delete: (...args: unknown[]) => QueryChain;
  upsert: (...args: unknown[]) => QueryChain;
  eq: (...args: unknown[]) => QueryChain;
  neq: (...args: unknown[]) => QueryChain;
  order: (...args: unknown[]) => QueryChain;
  limit: (...args: unknown[]) => QueryChain;
  filter: (...args: unknown[]) => QueryChain;
  single: () => Promise<{ data: unknown; error: { message: string } | null }>;
  maybeSingle: () => Promise<{ data: unknown; error: { message: string } | null }>;
  then: (resolve: (v: unknown) => unknown) => Promise<unknown>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Exported mock client — shape matches the subset the app uses
// ---------------------------------------------------------------------------

export const supabase = {
  from: vi.fn((table: string) => makeBuilder(table)),
  rpc: vi.fn(() => Promise.resolve(_pendingResponse)),

  auth: {
    getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: null }),
    getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
    onAuthStateChange: vi.fn().mockReturnValue({
      data: { subscription: { unsubscribe: vi.fn() } },
    }),
    signInWithPassword: vi.fn().mockResolvedValue({ data: {}, error: null }),
    signOut: vi.fn().mockResolvedValue({ error: null }),
  },

  storage: {
    from: vi.fn().mockReturnValue({
      upload: vi.fn().mockResolvedValue({ data: {}, error: null }),
      getPublicUrl: vi.fn().mockReturnValue({ data: { publicUrl: 'https://example.com/file' } }),
      createSignedUrl: vi
        .fn()
        .mockResolvedValue({ data: { signedUrl: 'https://example.com/signed' }, error: null }),
    }),
  },

  channel: vi.fn().mockReturnValue({
    on: vi.fn().mockReturnThis(),
    subscribe: vi.fn().mockReturnThis(),
    unsubscribe: vi.fn(),
  }),
  removeChannel: vi.fn().mockResolvedValue('ok'),
};
