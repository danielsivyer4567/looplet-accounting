# Running Tests

## Quick start

```bash
# Run all tests once (CI mode)
npm test

# Watch mode — re-runs affected tests on file save
npm run test:watch

# Coverage report (opens HTML in browser after run)
npm run test:coverage

# Unit tests only (src/test/ tree)
npm run test:unit

# Integration tests only (tests/ tree)
npm run test:integration
```

## Test environment

| Layer | Runner | Environment | Location |
|---|---|---|---|
| Unit / component | Vitest + Testing Library | jsdom | `src/test/**` |
| Integration (tenant isolation) | Vitest | Node (real Supabase) | `tests/**` |

The setup file at `src/test/setup.ts` runs before every test and provides:
- `@testing-library/jest-dom` matchers (`toBeInTheDocument`, `toHaveTextContent`, etc.)
- `window.matchMedia` stub (jsdom does not implement it)
- `ResizeObserver` stub

## Where to put new tests

Mirror the `src/` structure under `src/test/`:

```
src/
  lib/money.ts              → src/test/lib/money.test.ts
  components/Skeleton.tsx   → src/test/components/Skeleton.test.tsx
  pages/Customers.tsx       → src/test/pages/Customers.test.tsx
  hooks/useCustomers.ts     → src/test/hooks/useCustomers.test.ts
```

Name test files `*.test.ts` (pure logic) or `*.test.tsx` (components / JSX).

## Mocking Supabase

All component and hook tests must mock `@/lib/supabase` so no real network
calls are made. Use the shared mock from `src/test/mocks/supabase.ts`:

```typescript
// At the top of every test file that touches Supabase:
import { vi } from 'vitest';
import { mockSupabaseResponse } from '@/test/mocks/supabase';

vi.mock('@/lib/supabase', () => import('@/test/mocks/supabase'));
```

Then configure the response per-test:

```typescript
beforeEach(() => {
  // Happy path: returns rows
  mockSupabaseResponse({
    data: [{ id: '1', name: 'Acme' }],
    error: null,
  });
});

it('shows an error message on DB failure', () => {
  mockSupabaseResponse({ data: null, error: { message: 'Forbidden' } });
  // ... render and assert
});
```

The mock exposes a chainable builder that supports the full PostgREST fluent
API surface: `.from().select().eq().order()…` — all calls return the builder
until `.single()` or `await` resolves to `{ data, error }`.

## Mocking OrgContext

Most pages and components consume `useOrg()`. Provide a stable mock:

```typescript
vi.mock('@/contexts/OrgContext', () => ({
  useOrg: () => ({
    organizations: [{ id: 'org-1', name: 'Test Co', organization_type: 'standard' }],
    currentOrg: { id: 'org-1', name: 'Test Co', organization_type: 'standard' },
    loading: false,
    setCurrentOrg: vi.fn(),
    createOrganization: vi.fn(),
    refresh: vi.fn(),
  }),
}));
```

## Coverage targets

We are not chasing a coverage percentage gate yet. The goal is a working
foundation with high-value smoke tests. Once the product stabilises (Phase 2),
add a `coverage.thresholds` block to `vitest.config.ts`:

```typescript
coverage: {
  thresholds: {
    statements: 70,
    branches: 65,
    functions: 70,
    lines: 70,
  },
},
```

## AU FY Quarter reference

See `src/test/lib/au-bas-quarter.sql.md` for the canonical Jul-Sep=Q1 mapping,
SQL expressions, and timezone edge cases. Future SQL migration tests and BAS
report tests should reference that document.
