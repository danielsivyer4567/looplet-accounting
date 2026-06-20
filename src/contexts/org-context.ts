import { createContext } from 'react';

export interface Organization {
  id: string;
  name: string;
  organization_type: 'standard' | 'agency' | 'sub_account';
}

export interface OrgContextValue {
  organizations: Organization[];
  currentOrg: Organization | null;
  loading: boolean;
  setCurrentOrg: (org: Organization) => void;
  createOrganization: (name: string) => Promise<{ error: Error | null }>;
  refresh: () => Promise<void>;
}

export const OrgContext = createContext<OrgContextValue | undefined>(undefined);
