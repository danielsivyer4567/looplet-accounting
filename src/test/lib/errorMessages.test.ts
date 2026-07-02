import { describe, expect, it } from 'vitest';
import { classifyError, formatLoadError, formatActionError } from '@/lib/errorMessages';

describe('errorMessages', () => {
  it('classifies common load failures for clearer UI copy', () => {
    expect(classifyError('JWT expired')).toBe('auth');
    expect(classifyError('new row violates row-level security policy')).toBe('rls');
    expect(classifyError('Failed to fetch')).toBe('network');
    expect(classifyError('null value violates not-null constraint')).toBe('validation');
    expect(classifyError('relation does not exist')).toBe('database');
  });

  it('formats load errors with resource, category, and raw detail', () => {
    expect(formatLoadError('customers', 'permission denied for table customers')).toBe(
      'Could not load customers. Authentication or permission issue: permission denied for table customers',
    );
  });

  it('formats action errors with the action, category, and raw detail', () => {
    expect(
      formatActionError(
        'reject this suggestion',
        'new row violates row-level security policy for table "bills"',
      ),
    ).toBe(
      'Could not reject this suggestion. Access policy blocked this request: new row violates row-level security policy for table "bills"',
    );
  });
});
