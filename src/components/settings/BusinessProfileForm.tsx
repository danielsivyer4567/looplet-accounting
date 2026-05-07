import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/contexts/OrgContext';

interface BusinessProfile {
  organization_id: string;
  entity_type: string | null;
  industry_code: string | null;
  industry_label: string | null;
  state_code: string | null;
  is_gst_registered: boolean;
  gst_registered_since: string | null;
  bas_frequency: string | null;
  bas_paygw_included: boolean;
  aggregated_turnover_bracket: string | null;
  estimated_annual_turnover_cents: number | null;
  is_fbt_registered: boolean;
  is_paygi_registered: boolean;
  is_paygw_registered: boolean;
  is_workcover_registered: boolean;
  employees_count: number;
  subbies_count: number;
  is_tpar_required: boolean;
  vehicle_count: number;
  primary_vehicle_business_use_pct: number | null;
  has_logbook: boolean | null;
  office_setup: string | null;
  notes: string | null;
}

const EMPTY_PROFILE: BusinessProfile = {
  organization_id: '',
  entity_type: null, industry_code: null, industry_label: null, state_code: null,
  is_gst_registered: false, gst_registered_since: null, bas_frequency: null, bas_paygw_included: false,
  aggregated_turnover_bracket: null, estimated_annual_turnover_cents: null,
  is_fbt_registered: false, is_paygi_registered: false, is_paygw_registered: false, is_workcover_registered: false,
  employees_count: 0, subbies_count: 0, is_tpar_required: false,
  vehicle_count: 0, primary_vehicle_business_use_pct: null, has_logbook: null, office_setup: null,
  notes: null,
};

export function BusinessProfileForm() {
  const { currentOrg } = useOrg();
  const [profile, setProfile] = useState<BusinessProfile>(EMPTY_PROFILE);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);
    const { data, error } = await supabase
      .from('business_profile')
      .select('*')
      .eq('organization_id', currentOrg.id)
      .maybeSingle();
    if (error) setErr(error.message);
    setProfile(data ? (data as BusinessProfile) : { ...EMPTY_PROFILE, organization_id: currentOrg.id });
    setLoading(false);
  }, [currentOrg]);

  useEffect(() => { void refresh(); }, [refresh]);

  if (!currentOrg) return null;

  const save = async () => {
    setSaving(true); setMsg(null); setErr(null);
    const payload = { ...profile, organization_id: currentOrg.id };
    const { error } = await supabase
      .from('business_profile')
      .upsert(payload, { onConflict: 'organization_id' });
    setSaving(false);
    if (error) setErr(error.message);
    else setMsg('Saved. The /ask bot will use this profile on every question.');
  };

  const set = <K extends keyof BusinessProfile>(k: K, v: BusinessProfile[K]) =>
    setProfile((p) => ({ ...p, [k]: v }));

  if (loading) return <p style={{ color: '#888' }}>Loading profile…</p>;

  return (
    <div style={{ marginTop: '2rem' }}>
      <h2 style={{ fontSize: 18, marginBottom: 4 }}>Business profile</h2>
      <p style={{ color: '#888', fontSize: 13, marginBottom: 20, maxWidth: 720 }}>
        The /ask bot reads this on every question to tailor its tax/legal answers to your specific situation.
        E.g. instant-asset-write-off advice depends on whether you're a sole trader vs company and your turnover.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(280px, 1fr))', gap: 16, maxWidth: 900 }}>
        <Section title="Entity">
          <Field label="Entity type">
            <select value={profile.entity_type ?? ''} onChange={(e) => set('entity_type', e.target.value || null)} style={selectStyle}>
              <option value="">— pick —</option>
              <option value="sole_trader">Sole trader</option>
              <option value="partnership">Partnership</option>
              <option value="company">Company (Pty Ltd)</option>
              <option value="trust">Trust</option>
              <option value="other">Other</option>
            </select>
          </Field>
          <Field label="State">
            <select value={profile.state_code ?? ''} onChange={(e) => set('state_code', e.target.value || null)} style={selectStyle}>
              <option value="">— pick —</option>
              {['QLD', 'NSW', 'VIC', 'WA', 'SA', 'TAS', 'NT', 'ACT'].map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
          <Field label="Industry (label)">
            <input
              type="text" value={profile.industry_label ?? ''}
              onChange={(e) => set('industry_label', e.target.value || null)}
              placeholder="e.g. Fencing services"
              style={inputStyle}
            />
          </Field>
          <Field label="ANZSIC code (optional)">
            <input
              type="text" value={profile.industry_code ?? ''}
              onChange={(e) => set('industry_code', e.target.value || null)}
              placeholder="e.g. 32990"
              style={inputStyle}
            />
          </Field>
        </Section>

        <Section title="Turnover & SBE eligibility">
          <Field label="Aggregated turnover bracket">
            <select value={profile.aggregated_turnover_bracket ?? ''} onChange={(e) => set('aggregated_turnover_bracket', e.target.value || null)} style={selectStyle}>
              <option value="">— pick —</option>
              <option value="under_2m">Under $2M (small business entity)</option>
              <option value="under_10m">Under $10M (small business entity)</option>
              <option value="under_50m">Under $50M (medium)</option>
              <option value="over_50m">Over $50M (large)</option>
              <option value="unknown">Not sure</option>
            </select>
          </Field>
          <Field label="Estimated annual turnover (AUD)">
            <input
              type="number" min="0" step="1000"
              value={profile.estimated_annual_turnover_cents != null ? profile.estimated_annual_turnover_cents / 100 : ''}
              onChange={(e) => set('estimated_annual_turnover_cents', e.target.value ? Math.round(parseFloat(e.target.value) * 100) : null)}
              placeholder="e.g. 850000"
              style={inputStyle}
            />
          </Field>
        </Section>

        <Section title="GST & BAS">
          <Toggle label="GST registered" value={profile.is_gst_registered} onChange={(v) => set('is_gst_registered', v)} />
          <Field label="BAS frequency">
            <select value={profile.bas_frequency ?? ''} onChange={(e) => set('bas_frequency', e.target.value || null)} style={selectStyle} disabled={!profile.is_gst_registered}>
              <option value="">— pick —</option>
              <option value="monthly">Monthly</option>
              <option value="quarterly">Quarterly</option>
              <option value="annual">Annual</option>
              <option value="not_required">Not required</option>
            </select>
          </Field>
          <Toggle label="BAS includes PAYG-W (you have employees on payroll)" value={profile.bas_paygw_included} onChange={(v) => set('bas_paygw_included', v)} />
        </Section>

        <Section title="Tax registrations">
          <Toggle label="FBT registered" value={profile.is_fbt_registered} onChange={(v) => set('is_fbt_registered', v)} />
          <Toggle label="PAYG instalments (PAYG-I)" value={profile.is_paygi_registered} onChange={(v) => set('is_paygi_registered', v)} />
          <Toggle label="PAYG withholding (PAYG-W)" value={profile.is_paygw_registered} onChange={(v) => set('is_paygw_registered', v)} />
          <Toggle label="WorkCover registered" value={profile.is_workcover_registered} onChange={(v) => set('is_workcover_registered', v)} />
        </Section>

        <Section title="Workforce">
          <Field label="Employees">
            <input type="number" min="0" value={profile.employees_count} onChange={(e) => set('employees_count', parseInt(e.target.value || '0', 10))} style={inputStyle} />
          </Field>
          <Field label="Subbies (subcontractors)">
            <input type="number" min="0" value={profile.subbies_count} onChange={(e) => set('subbies_count', parseInt(e.target.value || '0', 10))} style={inputStyle} />
          </Field>
          <Toggle label="TPAR required (you pay subbies — annual report)" value={profile.is_tpar_required} onChange={(v) => set('is_tpar_required', v)} />
        </Section>

        <Section title="Vehicles & office">
          <Field label="Vehicles (utes / vans / cars used for business)">
            <input type="number" min="0" value={profile.vehicle_count} onChange={(e) => set('vehicle_count', parseInt(e.target.value || '0', 10))} style={inputStyle} />
          </Field>
          <Field label="Primary vehicle business-use %">
            <input
              type="number" min="0" max="100"
              value={profile.primary_vehicle_business_use_pct ?? ''}
              onChange={(e) => set('primary_vehicle_business_use_pct', e.target.value ? parseInt(e.target.value, 10) : null)}
              placeholder="e.g. 80"
              style={inputStyle}
            />
          </Field>
          <Toggle label="Logbook kept (12-week or full FBT)" value={profile.has_logbook ?? false} onChange={(v) => set('has_logbook', v)} />
          <Field label="Office setup">
            <select value={profile.office_setup ?? ''} onChange={(e) => set('office_setup', e.target.value || null)} style={selectStyle}>
              <option value="">— pick —</option>
              <option value="home_office">Home office</option>
              <option value="commercial_premises">Commercial premises</option>
              <option value="mobile_only">Mobile / from ute only</option>
              <option value="mixed">Mixed</option>
            </select>
          </Field>
        </Section>

        <Section title="Notes (anything specific)" full>
          <textarea
            value={profile.notes ?? ''}
            onChange={(e) => set('notes', e.target.value || null)}
            placeholder="e.g. Bought a $35k ute on 1 Mar 2026 — primary work vehicle. Lease office space in Burleigh Heads."
            rows={3}
            style={{ ...inputStyle, fontFamily: 'inherit', resize: 'vertical' }}
          />
        </Section>
      </div>

      <div style={{ marginTop: 20, display: 'flex', gap: 12, alignItems: 'center' }}>
        <button
          onClick={save}
          disabled={saving}
          style={{
            padding: '0.5rem 1.25rem',
            background: '#1c4868', color: '#fff',
            border: '1px solid #5096d8', borderRadius: 4,
            fontSize: 13, fontWeight: 600,
            cursor: saving ? 'wait' : 'pointer',
          }}
        >
          {saving ? 'Saving…' : 'Save profile'}
        </button>
        {msg && <span style={{ color: '#86c7a3', fontSize: 12 }}>{msg}</span>}
        {err && <span style={{ color: 'salmon', fontSize: 12 }}>{err}</span>}
      </div>
    </div>
  );
}

function Section({ title, children, full }: { title: string; children: React.ReactNode; full?: boolean }) {
  return (
    <div style={{ gridColumn: full ? '1 / -1' : undefined, padding: 12, background: '#0e0e0e', border: '1px solid #2a2a2a', borderRadius: 6 }}>
      <div style={{ fontSize: 11, color: '#7fb6e8', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10, fontWeight: 600 }}>{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{children}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span style={{ fontSize: 11, color: '#888' }}>{label}</span>
      {children}
    </label>
  );
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 12, color: '#ccc' }}>
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  background: '#1a1a1a', color: '#fff',
  border: '1px solid #2a2a2a', borderRadius: 3,
  padding: '0.4rem 0.5rem', fontSize: 13,
};
const selectStyle: React.CSSProperties = { ...inputStyle };
