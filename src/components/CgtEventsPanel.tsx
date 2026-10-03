import { useState } from 'react';
import { useOrg } from '@/hooks/useOrg';
import {
  useCgtEvents,
  costBaseCents,
  type CgtEvent,
  type CgtEventInput,
  type CgtAssetType,
} from '@/hooks/useCgtEvents';
import { formatLoadError } from '@/lib/errorMessages';
import { formatMoney, centsToDollars } from '@/lib/money';
import { SkeletonTable } from '@/components/Skeleton';
import { Coins, Plus, Pencil, Trash2, X } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';

// 0138 cgt_asset_type enum -> human label (also the add/edit select options).
const ASSET_TYPES: { value: CgtAssetType; label: string }[] = [
  { value: 'share', label: 'Share' },
  { value: 'real_property', label: 'Real property' },
  { value: 'crypto', label: 'Crypto' },
  { value: 'collectable', label: 'Collectable' },
  { value: 'personal_use', label: 'Personal-use asset' },
  { value: 'business_asset', label: 'Business asset' },
  { value: 'other', label: 'Other' },
];

function assetTypeLabel(type: CgtAssetType): string {
  return ASSET_TYPES.find((t) => t.value === type)?.label ?? type;
}

// CGT-events capture/correct surface (SC-4.D.02). Lists the live cgt_events for
// the active org and lets a user record/correct/remove an event before the calc
// (SC-4.E/4.F) runs. Self-contained over useCgtEvents — embedded by the tax-return
// draft page (SC-4.I.02).
export function CgtEventsPanel() {
  const { currentOrg } = useOrg();
  const { events, loading, error, create, update, remove } = useCgtEvents();
  // null = closed; 'new' = add form; a CgtEvent = edit that event.
  const [editing, setEditing] = useState<CgtEvent | 'new' | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});

  const open = (target: CgtEvent | 'new') => {
    setFormError(null);
    setEditing(target);
  };

  const save = async (input: CgtEventInput) => {
    setBusy(true);
    setFormError(null);
    try {
      if (editing === 'new') await create(input);
      else if (editing) await update(editing.id, input);
      setEditing(null);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  const del = async (event: CgtEvent) => {
    if (!window.confirm(`Remove the CGT event "${event.asset_description}"?`)) return;
    setRowError((prev) => ({ ...prev, [event.id]: '' }));
    try {
      await remove(event.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Delete failed';
      setRowError((prev) => ({ ...prev, [event.id]: msg }));
    }
  };

  if (!currentOrg) {
    return (
      <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>
        Pick an organisation to see its CGT events.
      </p>
    );
  }

  const totalCostBase = events.reduce((sum, e) => sum + costBaseCents(e), 0);
  const totalProceeds = events.reduce((sum, e) => sum + e.proceeds_cents, 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '0.75rem',
        }}
      >
        <div>
          <h2
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              fontSize: '1.05rem',
              margin: 0,
            }}
          >
            <Coins size={18} style={{ color: 'var(--text-link)' }} />
            CGT events
          </h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', margin: '0.25rem 0 0' }}>
            {events.length} event{events.length === 1 ? '' : 's'}
            {events.length > 0 && (
              <>
                {' '}
                · {formatMoney(totalProceeds)} proceeds · {formatMoney(totalCostBase)} cost base
              </>
            )}
          </p>
        </div>
        {editing === null && (
          <button
            className="btn btn-primary"
            onClick={() => open('new')}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}
          >
            <Plus size={16} /> Add event
          </button>
        )}
      </div>

      {error && (
        <div
          className="badge badge-danger"
          style={{ display: 'block', padding: '0.75rem', textTransform: 'none' }}
        >
          {formatLoadError('CGT events', error)}
        </div>
      )}

      {editing !== null && (
        <CgtEventForm
          // Remount (fresh form state) when the edit target changes — switching
          // rows while the form is open must reset the inputs.
          key={editing === 'new' ? 'new' : editing.id}
          event={editing === 'new' ? null : editing}
          busy={busy}
          error={formError}
          onSubmit={save}
          onCancel={() => setEditing(null)}
        />
      )}

      {loading ? (
        <SkeletonTable rows={3} cols={7} />
      ) : events.length === 0 ? (
        <EmptyState icon={Coins} title="No CGT events recorded yet.">
          Record disposals (shares, property, crypto) so the gain can be calculated.
        </EmptyState>
      ) : (
        <div className="table-premium-container">
          <table className="table-premium">
            <thead>
              <tr>
                <th>Asset</th>
                <th>Type</th>
                <th>Event</th>
                <th>Acquired</th>
                <th>Disposed</th>
                <th style={{ textAlign: 'right' }}>Proceeds</th>
                <th style={{ textAlign: 'right' }}>Cost base</th>
                <th style={{ width: '70px' }}></th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <td>
                    <div style={{ fontWeight: 600, color: 'var(--text-title)' }}>
                      {e.asset_description}
                    </div>
                    {rowError[e.id] && (
                      <div
                        className="badge badge-danger"
                        style={{
                          display: 'inline-block',
                          marginTop: '0.25rem',
                          padding: '0.2rem 0.4rem',
                          textTransform: 'none',
                          fontSize: '0.7rem',
                        }}
                      >
                        {rowError[e.id]}
                      </div>
                    )}
                  </td>
                  <td>{assetTypeLabel(e.asset_type)}</td>
                  <td>
                    <code>{e.event_type}</code>
                  </td>
                  <td style={{ color: 'var(--text-muted)' }}>{e.acquisition_date ?? '—'}</td>
                  <td style={{ color: 'var(--text-muted)' }}>{e.disposal_date}</td>
                  <td style={{ textAlign: 'right' }}>{formatMoney(e.proceeds_cents)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--text-title)' }}>
                    {formatMoney(costBaseCents(e))}
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: '0.25rem', justifyContent: 'flex-end' }}>
                      <button
                        className="btn btn-ghost"
                        onClick={() => open(e)}
                        title="Edit"
                        style={{ padding: '0.3rem' }}
                      >
                        <Pencil size={15} />
                      </button>
                      <button
                        className="btn btn-ghost"
                        onClick={() => del(e)}
                        title="Remove"
                        style={{ padding: '0.3rem', color: 'var(--accent-danger)' }}
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Money fields are edited in dollars and converted to cents on submit (house
// pattern — AddDebtForm). The five cost-base elements live in their own input
// group with a running total so the s110-25 sum is visible while editing.
interface FormState {
  asset_description: string;
  asset_type: CgtAssetType;
  event_type: string;
  acquisition_date: string; // '' = none → discount-ineligible
  disposal_date: string;
  proceeds: number;
  acquisition_cost: number;
  incidental_costs: number;
  ownership_costs: number;
  capital_improvement: number;
  title_costs: number;
  notes: string;
}

function initialForm(event: CgtEvent | null): FormState {
  if (!event) {
    return {
      asset_description: '',
      asset_type: 'share',
      event_type: 'A1',
      acquisition_date: '',
      disposal_date: '',
      proceeds: 0,
      acquisition_cost: 0,
      incidental_costs: 0,
      ownership_costs: 0,
      capital_improvement: 0,
      title_costs: 0,
      notes: '',
    };
  }
  return {
    asset_description: event.asset_description,
    asset_type: event.asset_type,
    event_type: event.event_type,
    acquisition_date: event.acquisition_date ?? '',
    disposal_date: event.disposal_date,
    proceeds: centsToDollars(event.proceeds_cents),
    acquisition_cost: centsToDollars(event.acquisition_cost_cents),
    incidental_costs: centsToDollars(event.incidental_costs_cents),
    ownership_costs: centsToDollars(event.ownership_costs_cents),
    capital_improvement: centsToDollars(event.capital_improvement_cents),
    title_costs: centsToDollars(event.title_costs_cents),
    notes: event.notes ?? '',
  };
}

function CgtEventForm({
  event,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  event: CgtEvent | null;
  busy: boolean;
  error: string | null;
  onSubmit: (input: CgtEventInput) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<FormState>(() => initialForm(event));

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const costBaseTotal =
    form.acquisition_cost +
    form.incidental_costs +
    form.ownership_costs +
    form.capital_improvement +
    form.title_costs;

  const submit = () => {
    onSubmit({
      // Preserve the link to a tracked fixed asset (set by capital-purchase
      // detection); the form doesn't expose it.
      fixed_asset_id: event?.fixed_asset_id ?? null,
      asset_description: form.asset_description.trim(),
      asset_type: form.asset_type,
      event_type: form.event_type.trim().toUpperCase(),
      acquisition_date: form.acquisition_date || null,
      disposal_date: form.disposal_date,
      proceeds_cents: Math.round(form.proceeds * 100),
      acquisition_cost_cents: Math.round(form.acquisition_cost * 100),
      incidental_costs_cents: Math.round(form.incidental_costs * 100),
      ownership_costs_cents: Math.round(form.ownership_costs * 100),
      capital_improvement_cents: Math.round(form.capital_improvement * 100),
      title_costs_cents: Math.round(form.title_costs * 100),
      notes: form.notes.trim() || null,
    });
  };

  const canSave = form.asset_description.trim().length > 0 && form.disposal_date.length > 0;

  return (
    <div className="card-gradient" style={{ animation: 'fadeIn 0.2s ease-out' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '1.25rem',
        }}
      >
        <h3 style={{ margin: 0 }}>{event ? 'Edit CGT event' : 'Add CGT event'}</h3>
        <button
          className="btn btn-ghost"
          onClick={onCancel}
          aria-label="Close"
          style={{ padding: '0.25rem' }}
        >
          <X size={18} />
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: '1rem',
          }}
        >
          <div className="form-group">
            <label className="form-label">Asset description</label>
            <input
              className="form-input"
              value={form.asset_description}
              onChange={(e) => set('asset_description', e.target.value)}
              placeholder="e.g. 1,000 BHP shares"
            />
          </div>
          <div className="form-group">
            <label className="form-label">Asset type</label>
            <select
              className="form-select"
              value={form.asset_type}
              onChange={(e) => set('asset_type', e.target.value as CgtAssetType)}
            >
              {ASSET_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
            gap: '1rem',
          }}
        >
          <div className="form-group">
            <label className="form-label">CGT event code</label>
            <input
              className="form-input"
              value={form.event_type}
              onChange={(e) => set('event_type', e.target.value)}
              placeholder="A1"
            />
          </div>
          <div className="form-group">
            <label className="form-label">Acquisition date</label>
            <input
              className="form-input"
              type="date"
              value={form.acquisition_date}
              onChange={(e) => set('acquisition_date', e.target.value)}
            />
          </div>
          <div className="form-group">
            <label className="form-label">Disposal date</label>
            <input
              className="form-input"
              type="date"
              value={form.disposal_date}
              onChange={(e) => set('disposal_date', e.target.value)}
            />
          </div>
          <div className="form-group">
            <label className="form-label">Capital proceeds ($)</label>
            <input
              className="form-input"
              type="number"
              step="0.01"
              value={form.proceeds || ''}
              onChange={(e) => set('proceeds', parseFloat(e.target.value) || 0)}
              placeholder="0.00"
            />
          </div>
        </div>

        <div>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'baseline',
              marginBottom: '0.5rem',
            }}
          >
            <span
              style={{
                fontSize: '0.7rem',
                fontWeight: 700,
                color: 'var(--text-muted)',
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
              }}
            >
              Cost base (ITAA s110-25 elements)
            </span>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              Total{' '}
              <strong style={{ color: 'var(--text-title)' }}>
                {formatMoney(Math.round(costBaseTotal * 100))}
              </strong>
            </span>
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: '1rem',
            }}
          >
            <MoneyField
              label="1. Acquisition cost ($)"
              value={form.acquisition_cost}
              onChange={(v) => set('acquisition_cost', v)}
            />
            <MoneyField
              label="2. Incidental costs ($)"
              value={form.incidental_costs}
              onChange={(v) => set('incidental_costs', v)}
            />
            <MoneyField
              label="3. Ownership costs ($)"
              value={form.ownership_costs}
              onChange={(v) => set('ownership_costs', v)}
            />
            <MoneyField
              label="4. Capital improvement ($)"
              value={form.capital_improvement}
              onChange={(v) => set('capital_improvement', v)}
            />
            <MoneyField
              label="5. Title costs ($)"
              value={form.title_costs}
              onChange={(v) => set('title_costs', v)}
            />
          </div>
        </div>

        <div className="form-group">
          <label className="form-label">Notes</label>
          <textarea
            className="form-textarea"
            value={form.notes}
            onChange={(e) => set('notes', e.target.value)}
            placeholder="Optional context for this event"
            rows={2}
          />
        </div>

        <div style={{ display: 'flex', gap: '0.75rem' }}>
          <button className="btn btn-primary" onClick={submit} disabled={busy || !canSave}>
            {busy ? 'Saving…' : event ? 'Save changes' : 'Add event'}
          </button>
          <button className="btn btn-secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </div>

        {error && (
          <div
            className="badge badge-danger"
            style={{ display: 'block', padding: '0.5rem 1rem', textTransform: 'none' }}
          >
            {error}
          </div>
        )}
      </div>
    </div>
  );
}

function MoneyField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="form-group">
      <label className="form-label">{label}</label>
      <input
        className="form-input"
        type="number"
        step="0.01"
        value={value || ''}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        placeholder="0.00"
      />
    </div>
  );
}
