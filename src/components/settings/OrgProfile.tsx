import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';

interface OrgSettings {
  tax_rate_percent?: number;
  gst_registered?: boolean;
  fiscal_year_start_month?: number;
  bas_quarter_offset?: number;
  default_invoice_terms_days?: number;
  default_invoice_notes?: string;
}

interface Org {
  id: string;
  name: string;
  abn: string | null;
  settings: OrgSettings | null;
}

export function OrgProfileForm() {
  const { currentOrg, refreshOrgs } = useOrg() as { currentOrg: Org | null; refreshOrgs?: () => void };
  const [org, setOrg] = useState<Org | null>(null);
  const [draft, setDraft] = useState<{ name: string; abn: string; settings: OrgSettings }>({
    name: '', abn: '', settings: {},
  });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!currentOrg) return;
    void (async () => {
      const { data } = await supabase
        .from('organizations')
        .select('id, name, abn, settings')
        .eq('id', currentOrg.id)
        .maybeSingle();
      setOrg(data as Org);
      setDraft({
        name: data?.name ?? '',
        abn: data?.abn ?? '',
        settings: (data?.settings ?? {}) as OrgSettings,
      });
    })();
  }, [currentOrg]);

  if (!currentOrg) return null;
  if (!org) return <p style={{ color: '#888', fontSize: 13 }}>Loading org…</p>;

  const save = async () => {
    setErr(null);
    setMsg(null);
    setBusy(true);
    const { error } = await supabase
      .from('organizations')
      .update({
        name: draft.name.trim(),
        abn: draft.abn.trim() || null,
        settings: draft.settings,
      })
      .eq('id', org.id);
    setBusy(false);
    if (error) { setErr(error.message); return; }
    setMsg('Saved.');
    refreshOrgs?.();
    setTimeout(() => setMsg(null), 2000);
  };

  const sset = (patch: Partial<OrgSettings>) => setDraft((d) => ({ ...d, settings: { ...d.settings, ...patch } }));

  return (
    <div style={{ marginTop: '0.5rem' }}>
      <h2 style={{ fontSize: 16, marginBottom: 4 }}>Organisation profile</h2>
      <p style={{ color: '#888', fontSize: 12, marginBottom: 12 }}>
        Drives BAS reporting, tax set-aside %, and invoice defaults.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, maxWidth: 720 }}>
        <Field label="Trading name">
          <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} style={inp} />
        </Field>
        <Field label="ABN">
          <input value={draft.abn} onChange={(e) => setDraft({ ...draft, abn: e.target.value })} placeholder="12 345 678 901" style={inp} />
        </Field>
      </div>

      <h3 style={{ fontSize: 13, marginTop: 18 }}>Tax & BAS</h3>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, maxWidth: 720 }}>
        <Field label="GST registered?">
          <select
            value={draft.settings.gst_registered === false ? 'false' : 'true'}
            onChange={(e) => sset({ gst_registered: e.target.value === 'true' })}
            style={inp}
          >
            <option value="true">Yes — collect 10% GST on sales, claim input credits</option>
            <option value="false">No — turnover under $75k threshold</option>
          </select>
        </Field>
        <Field label="Income tax set-aside %">
          <input
            type="number" min={0} max={100} step={1}
            value={draft.settings.tax_rate_percent ?? 25}
            onChange={(e) => sset({ tax_rate_percent: Number(e.target.value) })}
            style={inp}
          />
        </Field>
      </div>

      <h3 style={{ fontSize: 13, marginTop: 18 }}>Invoice defaults</h3>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, maxWidth: 720 }}>
        <Field label="Default payment terms (days)">
          <input
            type="number" min={0}
            value={draft.settings.default_invoice_terms_days ?? 14}
            onChange={(e) => sset({ default_invoice_terms_days: Number(e.target.value) })}
            style={inp}
          />
        </Field>
        <Field label="Default invoice footer note">
          <input
            value={draft.settings.default_invoice_notes ?? ''}
            onChange={(e) => sset({ default_invoice_notes: e.target.value })}
            placeholder="EFT to BSB 062-001 Acc 1234567"
            style={inp}
          />
        </Field>
      </div>

      <div style={{ marginTop: 16, display: 'flex', gap: 8, alignItems: 'center' }}>
        <button onClick={save} disabled={busy} style={btnPrim}>{busy ? 'Saving…' : 'Save profile'}</button>
        {msg && <span style={{ color: '#86c7a3', fontSize: 12 }}>{msg}</span>}
        {err && <span style={{ color: 'salmon', fontSize: 12 }}>{err}</span>}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block', fontSize: 11, color: '#888' }}>
      <div style={{ marginBottom: 3 }}>{label}</div>
      {children}
    </label>
  );
}
const inp: React.CSSProperties = {
  width: '100%', padding: '6px 8px',
  background: '#000', color: '#ddd', border: '1px solid #333', borderRadius: 3, fontSize: 12,
};
const btnPrim: React.CSSProperties = {
  padding: '0.5rem 1rem',
  background: '#1c4868', color: '#fff',
  border: '1px solid #5096d8', borderRadius: 4,
  fontSize: 13, fontWeight: 600, cursor: 'pointer',
};
