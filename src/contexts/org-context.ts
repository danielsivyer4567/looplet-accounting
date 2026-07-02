import { createContext } from 'react';

export type OrgRole = 'viewer' | 'employee' | 'accountant' | 'admin' | 'owner';

export interface Organization {
  id: string;
  name: string;
  organization_type: 'standard' | 'agency' | 'sub_account';
  abn?: string | null;
  /** The caller's role in this org (from their organization_memberships row). */
  role_enum?: OrgRole | null;
  /** When the caller accepted their membership; null = still pending. */
  accepted_at?: string | null;
  /** Entity structure from business_profile, if recorded. */
  entity_type?: string | null;
}

export interface OrgContextValue {
  organizations: Organization[];
  currentOrg: Organization | null;
  loading: boolean;
  setCurrentOrg: (org: Organization) => void;
  createOrganization: (name: string) => Promise<{ error: Error | null }>;
  refresh: () => Promise<void>;
  /** Orgs the caller can see purely as an accountant (role_enum === 'accountant'). */
  accountantClientOrgs: Organization[];
  /** True when the caller belongs to ≥1 org and EVERY membership is accountant. */
  isAccountantOnly: boolean;
}

export const OrgContext = createContext<OrgContextValue | undefined>(undefined);
