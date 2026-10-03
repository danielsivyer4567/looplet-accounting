import { useId, useState, type FormEvent } from 'react';
import { Building2, Plus } from 'lucide-react';
import { useOrg } from '@/hooks/useOrg';
import { SkeletonLine } from '@/components/Skeleton';
import { Field } from '@/components/ui/Field';

interface OrgSelectorProps {
  /** Icon-rail mode: show the organisation's initial; activating it asks the shell to expand. */
  compact?: boolean | undefined;
  onExpand?: (() => void) | undefined;
}

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join('');
}

/**
 * The organisation switcher at the top of the sidebar: a labelled select over the caller's
 * organisations, plus "New organisation" for owners. Accountants only ever see client orgs.
 */
export function OrgSelector({ compact, onExpand }: OrgSelectorProps) {
  const { organizations, currentOrg, setCurrentOrg, createOrganization, loading, isAccountantOnly } =
    useOrg();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const selectId = useId();

  if (loading) {
    return (
      <div className="org-selector" aria-busy="true" aria-label="Loading organisations">
        <SkeletonLine width="100%" height={14} />
      </div>
    );
  }

  if (compact) {
    const label = currentOrg ? `Organisation: ${currentOrg.name}. Expand the sidebar to switch.` : 'No organisation yet. Expand the sidebar to create one.';
    return (
      <button type="button" className="org-selector-compact" aria-label={label} title={currentOrg?.name ?? 'No organisation yet'} onClick={onExpand}>
        {currentOrg ? <span aria-hidden="true">{initialsOf(currentOrg.name) || <Building2 size={16} />}</span> : <Building2 size={16} aria-hidden="true" />}
      </button>
    );
  }

  if (organizations.length === 0 && !creating) {
    return (
      <div className="org-selector">
        <p className="org-selector-empty">No organisation yet</p>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setCreating(true)}>
          Create one
        </button>
      </div>
    );
  }

  if (creating) {
    const onSubmit = async (e: FormEvent) => {
      e.preventDefault();
      setBusy(true);
      setError(null);
      const { error } = await createOrganization(name);
      setBusy(false);
      if (error) {
        setError(error.message);
        return;
      }
      setCreating(false);
      setName('');
    };
    return (
      <form onSubmit={onSubmit} className="org-selector org-selector-form">
        <Field label="Business name" error={error ?? undefined}>
          <input
            type="text"
            className="form-input"
            placeholder="Business name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            minLength={2}
          />
        </Field>
        <div className="org-selector-actions">
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
            {busy ? 'Creating…' : 'Create'}
          </button>
          {organizations.length > 0 && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCreating(false)}>
              Cancel
            </button>
          )}
        </div>
      </form>
    );
  }

  return (
    <div className="org-selector">
      <label htmlFor={selectId} className="sr-only">
        Organisation
      </label>
      <select
        id={selectId}
        className="form-select org-selector-select"
        value={currentOrg?.id ?? ''}
        onChange={(e) => {
          const org = organizations.find((o) => o.id === e.target.value);
          if (org) setCurrentOrg(org);
        }}
      >
        {organizations.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
      {/* Accountants are non-billable client-only users — never nudge them to
          create their own (billable) org. See docs/ACCOUNTANT_PORTAL.md. */}
      {!isAccountantOnly && (
        <button type="button" className="btn btn-ghost btn-sm org-selector-new" onClick={() => setCreating(true)}>
          <Plus size={14} aria-hidden="true" /> New organisation
        </button>
      )}
    </div>
  );
}
