import type { Organization, OrgRole } from '@/contexts/org-context';
import { formatActionError } from '@/lib/errorMessages';

/**
 * Who may write what, as the database decides it. The RESTRICTIVE policies of
 * 20261003120000_money_table_write_roles (and the definer functions of 20261003121000) refuse a
 * write below the minimum role; a refused UPDATE changes 0 rows and supabase-js returns no error,
 * so pages use these helpers to show a read-only state up front and to treat "0 rows changed" as
 * a failure. Nothing here is a security check: the database remains the authority.
 */
export type WriteArea = 'books' | 'pay' | 'time';

export const ROLE_RANK: Record<OrgRole, number> = {
  viewer: 0,
  employee: 1,
  accountant: 2,
  admin: 3,
  owner: 4,
};

/** Lowest role that may write each area. */
export const MIN_WRITE_ROLE: Record<WriteArea, OrgRole> = {
  /** Bills, invoices, journals, suppliers, customers, the chart of accounts. */
  books: 'accountant',
  /** Employees, payment runs, super batches, leave balances (0045). */
  pay: 'admin',
  /** Timesheets and jobs: any staff member, not a viewer. */
  time: 'employee',
};

export function roleAtLeast(role: OrgRole | null | undefined, min: OrgRole): boolean {
  if (!role) return false;
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

/** The caller's role in an organisation, from the membership row OrgContext loads. */
export function roleFor(org: Pick<Organization, 'role_enum'> | null | undefined): OrgRole | null {
  return org?.role_enum ?? null;
}

/**
 * Whether a role may write an area. An unknown role (membership row without role_enum) is not
 * treated as read-only: the controls stay enabled and the database decides, with writeProblem
 * reporting a refusal.
 */
export function canWrite(role: OrgRole | null | undefined, area: WriteArea): boolean {
  if (!role) return true;
  return roleAtLeast(role, MIN_WRITE_ROLE[area]);
}

const WHO_GRANTS: Record<WriteArea, string> = {
  books: 'an admin for the accountant role',
  pay: 'an owner or admin for the admin role',
  time: 'an admin for the employee role',
};

/** The short notice shown to roles below the threshold. */
export function readOnlyNotice(area: WriteArea): string {
  return `You can view this page. Ask ${WHO_GRANTS[area]} to make changes.`;
}

export const NO_ROWS_CHANGED =
  'nothing was changed. Your role in this organisation does not allow it, or the record no longer exists';

/**
 * The message to show for a write that did not happen, or null when it did. Pass the result of
 * `.update(...).eq(...).select('id')` (or an insert with `.select()`), so the changed rows are
 * known: Postgres row-level security silently filters refused rows, leaving an empty array and
 * no error.
 */
export function writeProblem(
  action: string,
  result: { data: unknown; error: { message: string } | null },
): string | null {
  if (result.error) return formatActionError(action, result.error.message);
  if (!Array.isArray(result.data) || result.data.length === 0) {
    return `Could not ${action}: ${NO_ROWS_CHANGED}.`;
  }
  return null;
}
