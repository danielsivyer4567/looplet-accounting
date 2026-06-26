/**
 * PayerBankDetails — settings section for the organisation's own bank account
 * used as the "from" side of ABA (Cemtex) payment run files.
 *
 * Saves to organizations.settings: { payer_bsb, payer_account, payer_name, payer_apca_id }
 */

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';

interface PayerSettings {
  payer_bsb?: string;
  payer_account?: string;
  payer_name?: string;
  payer_apca_id?: string;
}

const BSB_RE = /^\d{3}-\d{3}$/;

export function PayerBankDetails() {
  const { currentOrg } = useOrg();
  const [draft, setDraft] = useState<PayerSettings>({
    payer_bsb: '',
    payer_account: '',
    payer_name: '',
    payer_apca_id: '',
  });
  const [existing, setExisting] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!currentOrg) return;
    void (async () => {
      const { data } = await supabase
        .from('organizations')
        .select('settings')
        .eq('id', currentOrg.id)
        .maybeSingle();
      const s =
        ((data as Record<string, unknown> | null)?.['settings'] as Record<string, unknown>) ?? {};
      setExisting(s);
      setDraft({
        payer_bsb: (s['payer_bsb'] as string | undefined) ?? '',
        payer_account: (s['payer_account'] as string | undefined) ?? '',
        payer_name: (s['payer_name'] as string | undefined) ?? '',
        payer_apca_id: (s['payer_apca_id'] as string | undefined) ?? '',
      });
    })();
  }, [currentOrg]);

  if (!currentOrg) return null;

  const validate = (): string | null => {
    if (!draft.payer_bsb?.trim()) return 'BSB is required.';
    if (!BSB_RE.test(draft.payer_bsb.trim()))
      return 'BSB must be in NNN-NNN format (e.g. 062-001).';
    if (!draft.payer_account?.trim()) return 'Account number is required.';
    if (!/^\d{5,9}$/.test(draft.payer_account.trim())) return 'Account number must be 5–9 digits.';
    if (!draft.payer_name?.trim()) return 'Account name is required.';
    if (draft.payer_name.trim().length > 26) return 'Account name max 26 characters.';
    if (draft.payer_apca_id && !/^\d{0,6}$/.test(draft.payer_apca_id.trim())) {
      return 'APCA ID must be up to 6 digits (or leave blank for 000000).';
    }
    return null;
  };

  const save = async () => {
    const v = validate();
    if (v) {
      setErr(v);
      return;
    }

    setErr(null);
    setMsg(null);
    setBusy(true);

    const newSettings = {
      ...existing,
      payer_bsb: draft.payer_bsb?.trim() ?? '',
      payer_account: draft.payer_account?.trim() ?? '',
      payer_name: draft.payer_name?.trim() ?? '',
      payer_apca_id: draft.payer_apca_id?.trim() || '000000',
    };

    const { error: saveErr } = await supabase
      .from('organizations')
      .update({ settings: newSettings })
      .eq('id', currentOrg.id);

    setBusy(false);
    if (saveErr) {
      setErr(saveErr.message);
      return;
    }
    setExisting(newSettings);
    setMsg('Saved.');
    setTimeout(() => setMsg(null), 2000);
  };

  const isComplete = !!(draft.payer_bsb && draft.payer_account && draft.payer_name);

  return (
    <div>
      <h2 style={{ fontSize: 16, marginBottom: 4 }}>Payer bank details</h2>
      <p style={{ color: '#888', fontSize: 12, marginBottom: 12 }}>
        Your bank account used as the <em>from</em> side in ABA (Cemtex) payment run files. Required
        before you can export a payment run.
        {!isComplete && (
          <span style={{ color: '#f4a261', marginLeft: 6 }}>
            Incomplete — fill in all fields before creating a payment run.
          </span>
        )}
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, maxWidth: 720 }}>
        <Field label="Your BSB (NNN-NNN)">
          <input
            value={draft.payer_bsb ?? ''}
            onChange={(e) => setDraft((d) => ({ ...d, payer_bsb: e.target.value }))}
            placeholder="062-001"
            style={inp}
          />
        </Field>
        <Field label="Your account number (digits only)">
          <input
            value={draft.payer_account ?? ''}
            onChange={(e) =>
              setDraft((d) => ({ ...d, payer_account: e.target.value.replace(/\D/g, '') }))
            }
            placeholder="12345678"
            style={inp}
          />
        </Field>
        <Field label="Account name (max 26 chars)">
          <input
            value={draft.payer_name ?? ''}
            onChange={(e) => setDraft((d) => ({ ...d, payer_name: e.target.value.slice(0, 26) }))}
            placeholder="ACME TRADE PTY LTD"
            style={inp}
          />
        </Field>
        <Field label="APCA user ID (optional, 6-digit)">
          <input
            value={draft.payer_apca_id ?? ''}
            onChange={(e) =>
              setDraft((d) => ({
                ...d,
                payer_apca_id: e.target.value.replace(/\D/g, '').slice(0, 6),
              }))
            }
            placeholder="000000"
            style={inp}
          />
        </Field>
      </div>

      <div style={{ marginTop: 14, display: 'flex', gap: 8, alignItems: 'center' }}>
        <button onClick={() => void save()} disabled={busy} style={btnPrim}>
          {busy ? 'Saving…' : 'Save payer details'}
        </button>
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
  width: '100%',
  padding: '6px 8px',
  background: '#000',
  color: '#ddd',
  border: '1px solid #333',
  borderRadius: 3,
  fontSize: 12,
};
const btnPrim: React.CSSProperties = {
  padding: '0.5rem 1rem',
  background: '#1c4868',
  color: '#fff',
  border: '1px solid #5096d8',
  borderRadius: 4,
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
};
