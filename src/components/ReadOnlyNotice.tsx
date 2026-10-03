import type { ReactNode } from 'react';
import { Eye } from 'lucide-react';
import { Alert } from '@/components/ui/Alert';
import { readOnlyNotice, type WriteArea } from '@/lib/roles';

/**
 * Tells a role below an area's write threshold that the page is view-only (lib/roles.ts). Shown
 * above the page content; the write controls are disabled alongside it.
 */
export function ReadOnlyNotice({ area, children }: { area: WriteArea; children?: ReactNode }) {
  return (
    <Alert
      tone="info"
      icon={Eye}
      role="status"
      className="read-only-notice"
      style={{ marginBottom: '1rem' }}
    >
      {children ?? readOnlyNotice(area)}
    </Alert>
  );
}
