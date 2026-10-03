import { describe, expect, it } from 'vitest';
import {
  MIN_WRITE_ROLE,
  NO_ROWS_CHANGED,
  canWrite,
  readOnlyNotice,
  roleAtLeast,
  roleFor,
  writeProblem,
} from '@/lib/roles';
import type { OrgRole } from '@/contexts/org-context';

const ROLES: OrgRole[] = ['viewer', 'employee', 'accountant', 'admin', 'owner'];

describe('lib/roles', () => {
  it('mirrors the database write matrix: books accountant+, pay admin+, time employee+', () => {
    expect(MIN_WRITE_ROLE).toEqual({ books: 'accountant', pay: 'admin', time: 'employee' });
    const table = ROLES.map((role) => [
      role,
      canWrite(role, 'books'),
      canWrite(role, 'pay'),
      canWrite(role, 'time'),
    ]);
    expect(table).toEqual([
      ['viewer', false, false, false],
      ['employee', false, false, true],
      ['accountant', true, false, true],
      ['admin', true, true, true],
      ['owner', true, true, true],
    ]);
  });

  it('ranks roles owner > admin > accountant > employee > viewer', () => {
    expect(roleAtLeast('owner', 'admin')).toBe(true);
    expect(roleAtLeast('accountant', 'admin')).toBe(false);
    expect(roleAtLeast('viewer', 'viewer')).toBe(true);
    expect(roleAtLeast(null, 'viewer')).toBe(false);
  });

  it('reads the role from the membership row OrgContext loads', () => {
    expect(roleFor({ role_enum: 'accountant' })).toBe('accountant');
    expect(roleFor({ role_enum: null })).toBeNull();
    expect(roleFor(null)).toBeNull();
  });

  it('leaves the controls enabled when the role is unknown; the database still decides', () => {
    expect(canWrite(null, 'pay')).toBe(true);
    expect(canWrite(undefined, 'books')).toBe(true);
  });

  it('writes the notice in plain Australian English, naming who grants the role', () => {
    expect(readOnlyNotice('books')).toBe(
      'You can view this page. Ask an admin for the accountant role to make changes.',
    );
    expect(readOnlyNotice('pay')).toBe(
      'You can view this page. Ask an owner or admin for the admin role to make changes.',
    );
    expect(readOnlyNotice('time')).toBe(
      'You can view this page. Ask an admin for the employee role to make changes.',
    );
  });

  it('treats an update that changed no rows as a failure, and a changed row as success', () => {
    expect(writeProblem('save this bill', { data: [{ id: 'b1' }], error: null })).toBeNull();
    expect(writeProblem('save this bill', { data: [], error: null })).toBe(
      `Could not save this bill: ${NO_ROWS_CHANGED}.`,
    );
    expect(writeProblem('save this bill', { data: null, error: null })).toContain(
      'nothing was changed',
    );
    expect(
      writeProblem('save this bill', {
        data: null,
        error: { message: 'new row violates row-level security policy' },
      }),
    ).toBe(
      'Could not save this bill. Access policy blocked this request: new row violates row-level security policy',
    );
  });
});
