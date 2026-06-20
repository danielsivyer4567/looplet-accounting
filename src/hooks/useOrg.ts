import { useContext } from 'react';
import { OrgContext, type OrgContextValue } from '@/contexts/org-context';

export function useOrg(): OrgContextValue {
  const ctx = useContext(OrgContext);
  if (!ctx) throw new Error('useOrg must be used within OrgProvider');
  return ctx;
}
