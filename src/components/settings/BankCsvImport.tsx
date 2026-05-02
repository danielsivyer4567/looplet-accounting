import { useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/contexts/OrgContext';

type Format = 'commbank' | 'nab' | 'westpac' | 'anz' | 'generic';
type AccountType = 'checking' | 'savings' | 'credit_card' | 'loan' | 'investment' | 'other';

const FORMAT_HINTS: Record<Format, string> = {
  commbank: 'CommBank: Date, Amount, Description, Balance — no header',
  nab: 'NAB: Date, Amount, Description, Balance, Category, Merchant — has header',
  westpac: 'Westpac: Date, Description, Debit, Credit, Balance — has header',
  anz: 'ANZ: Date, Amount, Description — no header',
  generic: 'Generic: Date, Description, Amount, Balance — has header',
};

interface ImportResult {
  imported: number;
  duplicates: number;
  insert_errors: number;
  parse_errors: string[];
}

export function BankCsvImport({ onImported }: { onImported?: () => void }) {
  const { currentOrg } = useOrg();
  const [open, setOpen] = useState(false);
  const [bank, setBank] = useState('CommBank');
  const [accountName, setAccountName] = useState('Business Cheque');
  const [accountType, setAccountType] = useState<AccountType>('checking');
  const [bsb, setBsb] = useState('');
  const [last4, setLast4] = useState('');
  const [format, setFormat] = useState<Format>('commbank');
  const [csvText, setCsvText] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!currentOrg) return null;

  const handleFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => setCsvText(String(reader.result ?? ''));
    reader.readAsText(file);
  };

  const handleImport = async () => {
    setError(null);
    setResult(null);
    setBusy(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in');
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/bank-csv-import`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({
          organization_id: currentOrg.id,
          institution_name: bank,
          account_name: accountName,
          account_type: accountType,
          bsb: bsb || undefined,
          account_number_last4: last4 || undefined,
          format,
          csv_text: csvText,
        }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) throw new Error(body.error ?? `${res.status}`);
      setResult({
        imported: body.imported,
        duplicates: body.duplicates,
        insert_errors: body.insert_errors,
        parse_errors: body.parse_errors ?? [],
      });
      onImported?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        style={{
          marginTop: 12, marginLeft: 8,
          padding: '0.4rem 1rem',
          background: 'transparent', color: '#bbb',
          border: '1px solid #444', borderRadius: 3,
          fontSize: 12, cursor: 'pointer',
        }}
      >
        ⬆ Import CSV
      </button>
    );
  }

  return (
    <div style={{
      marginTop: 16, padding: 16,
      background: '#0e0e0e', border: '1px solid #2a2a2a', borderRadius: 4,
      maxWidth: 720,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h3 style={{ fontSize: 14, margin: 0 }}>Import bank CSV</h3>
        <button onClick={() => setOpen(false)} style={closeBtn}>×</button>
      </div>
      <p style={{ fontSize: 12, color: '#888', marginTop: 6 }}>
        Export a CSV from your internet banking and upload it here. Same dedupe + reconciliation rules apply.
      </p>

      <div style={grid2}>
        <Field label="Bank">
          <input value={bank} onChange={(e) => setBank(e.target.value)} style={inp} />
        </Field>
        <Field label="Format">
          <select value={format} onChange={(e) => setFormat(e.target.value as Format)} style={inp}>
            <option value="commbank">CommBank</option>
            <option value="nab">NAB</option>
            <option value="westpac">Westpac</option>
            <option value="anz">ANZ</option>
            <option value="generic">Generic</option>
          </select>
        </Field>
      </div>
      <p style={{ fontSize: 11, color: '#666', margin: '4px 0 8px' }}>{FORMAT_HINTS[format]}</p>

      <div style={grid2}>
        <Field label="Account name">
          <input value={accountName} onChange={(e) => setAccountName(e.target.value)} style={inp} />
        </Field>
        <Field label="Account type">
          <select value={accountType} onChange={(e) => setAccountType(e.target.value as AccountType)} style={inp}>
            <option value="checking">Transaction (checking)</option>
            <option value="savings">Savings</option>
            <option value="credit_card">Credit card</option>
            <option value="loan">Loan</option>
            <option value="investment">Investment</option>
            <option value="other">Other</option>
          </select>
        </Field>
      </div>

      <div style={grid2}>
        <Field label="BSB (optional)">
          <input value={bsb} onChange={(e) => setBsb(e.target.value)} placeholder="062-001" style={inp} />
        </Field>
        <Field label="Account # last 4 (optional)">
          <input value={last4} onChange={(e) => setLast4(e.target.value)} placeholder="1234" style={inp} />
        </Field>
      </div>

      <Field label="CSV file">
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
          style={{ ...inp, padding: '6px 0' }}
        />
      </Field>

      <Field label={`Or paste CSV (${csvText ? csvText.split('\n').length + ' lines loaded' : 'empty'})`}>
        <textarea
          value={csvText}
          onChange={(e) => setCsvText(e.target.value)}
          rows={6}
          placeholder={'01/05/2026,-50.00,EFTPOS WOOLWORTHS,1234.56\n02/05/2026,1500.00,SALARY ACME PTY LTD,2734.56'}
          style={{ ...inp, fontFamily: 'monospace', fontSize: 11 }}
        />
      </Field>

      <button
        onClick={handleImport}
        disabled={busy || !csvText.trim()}
        style={{
          marginTop: 12,
          padding: '0.5rem 1rem',
          background: busy ? '#333' : '#1c4868',
          color: '#fff',
          border: '1px solid #5096d8',
          borderRadius: 4,
          cursor: busy ? 'wait' : 'pointer',
          fontSize: 13,
          fontWeight: 600,
        }}
      >
        {busy ? 'Importing…' : 'Import transactions'}
      </button>

      {error && (
        <p style={{ color: 'salmon', fontSize: 12, marginTop: 8 }}>{error}</p>
      )}
      {result && (
        <div style={{ marginTop: 12, padding: 8, background: '#0a1f12', border: '1px solid #2da565', borderRadius: 3, fontSize: 12 }}>
          ✓ Imported <strong>{result.imported}</strong> transactions
          {result.duplicates > 0 && <> · {result.duplicates} duplicates skipped</>}
          {result.insert_errors > 0 && <> · {result.insert_errors} insert errors</>}
          {result.parse_errors.length > 0 && (
            <details style={{ marginTop: 6 }}>
              <summary style={{ color: '#e9a3a3', cursor: 'pointer' }}>{result.parse_errors.length} parse error{result.parse_errors.length === 1 ? '' : 's'}</summary>
              <ul style={{ marginTop: 4, color: '#e9a3a3', fontSize: 11 }}>
                {result.parse_errors.map((e, i) => <li key={i}>{e}</li>)}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block', fontSize: 11, color: '#888', marginTop: 8 }}>
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
const grid2: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 12,
};
const closeBtn: React.CSSProperties = {
  background: 'transparent', color: '#888',
  border: 'none', fontSize: 18, cursor: 'pointer', padding: 0,
};
