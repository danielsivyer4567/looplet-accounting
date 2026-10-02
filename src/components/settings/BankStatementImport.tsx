import { useState, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';

type AccountType = 'checking' | 'savings' | 'credit_card' | 'loan' | 'investment' | 'other';

interface ExtractedRow {
  posted_at: string;
  description: string;
  amount_cents: number;
  balance_cents: number | null;
}

interface ImportResult {
  imported: number;
  duplicates: number;
  insert_errors: number;
  parse_errors: string[];
  pages_processed: number;
  rows_extracted: number;
}

const PDFJS_VERSION = '4.7.76';

// Minimal structural types for the bits of pdfjs-dist we use (the package's
// own types are not bundled and we load it dynamically via import()).
interface PdfPageViewport {
  width: number;
  height: number;
}
interface PdfPage {
  getViewport(opts: { scale: number }): PdfPageViewport;
  render(opts: { canvasContext: CanvasRenderingContext2D; viewport: PdfPageViewport }): {
    promise: Promise<void>;
  };
}
interface PdfDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPage>;
}
interface PdfjsModule {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument(opts: { data: Uint8Array }): { promise: Promise<PdfDocument> };
}

export function BankStatementImport({ onImported }: { onImported?: () => void }) {
  const { currentOrg } = useOrg();
  const [open, setOpen] = useState(false);
  const [bank, setBank] = useState('CommBank');
  const [accountName, setAccountName] = useState('Business Cheque');
  const [accountType, setAccountType] = useState<AccountType>('checking');
  const [bsb, setBsb] = useState('');
  const [last4, setLast4] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef(false);

  if (!currentOrg) return null;

  const handleImport = async () => {
    if (files.length === 0) {
      setError('Pick one or more PDF statements first');
      return;
    }
    setError(null);
    setResult(null);
    setBusy(true);
    cancelRef.current = false;
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in');

      const pdfjs = await loadPdfjs();
      const allRows: ExtractedRow[] = [];
      let totalPages = 0;
      let pagesDone = 0;
      const parseErrors: string[] = [];

      // First pass: count total pages so we can show "X / Y" progress
      const docs: { doc: PdfDocument; name: string }[] = [];
      for (const f of files) {
        const buf = await f.arrayBuffer();
        const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
        docs.push({ doc, name: f.name });
        totalPages += doc.numPages;
      }

      const extractUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/bank-statement-extract`;

      for (const { doc, name } of docs) {
        for (let p = 1; p <= doc.numPages; p += 1) {
          if (cancelRef.current) throw new Error('Cancelled');
          setProgress(`${name} · page ${p}/${doc.numPages} · ${pagesDone}/${totalPages} done`);

          const page = await doc.getPage(p);
          const viewport = page.getViewport({ scale: 1.8 }); // higher scale = better OCR
          const canvas = document.createElement('canvas');
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('Could not get 2D canvas context for PDF rendering');
          await page.render({ canvasContext: ctx, viewport }).promise;
          const blob: Blob = await new Promise((resolve, reject) =>
            canvas.toBlob(
              (b) => (b ? resolve(b) : reject(new Error('canvas.toBlob returned null'))),
              'image/png',
            ),
          );
          const base64 = await blobToBase64(blob);

          try {
            const r = await fetch(extractUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${session.access_token}`,
              },
              body: JSON.stringify({ image_base64: base64, mime_type: 'image/png' }),
            });
            const body = await r.json();
            if (!r.ok || !body.ok) {
              parseErrors.push(`${name} p${p}: ${body.error ?? r.status}`);
            } else {
              allRows.push(...((body.rows ?? []) as ExtractedRow[]));
            }
          } catch (e) {
            parseErrors.push(`${name} p${p}: ${e instanceof Error ? e.message : String(e)}`);
          }
          pagesDone += 1;
        }
      }

      if (allRows.length === 0) {
        throw new Error(
          `Extracted 0 rows across ${pagesDone} pages. ${parseErrors[0] ?? 'No transactions found.'}`,
        );
      }

      // Convert extracted rows → synthetic generic CSV the existing import understands
      setProgress(`Importing ${allRows.length} transactions…`);
      const csvHeader = 'Date,Description,Amount,Balance';
      const csvBody = allRows
        .map((r) => {
          const date = r.posted_at; // YYYY-MM-DD; bank-csv-import accepts this
          const desc = `"${r.description.replace(/"/g, '""')}"`;
          const amt = (r.amount_cents / 100).toFixed(2);
          const bal = r.balance_cents != null ? (r.balance_cents / 100).toFixed(2) : '';
          return `${date},${desc},${amt},${bal}`;
        })
        .join('\n');
      const csvText = `${csvHeader}\n${csvBody}`;

      const importUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/bank-csv-import`;
      const importRes = await fetch(importUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          organization_id: currentOrg.id,
          institution_name: bank,
          account_name: accountName,
          account_type: accountType,
          bsb: bsb || undefined,
          account_number_last4: last4 || undefined,
          format: 'generic',
          csv_text: csvText,
        }),
      });
      const importBody = await importRes.json();
      if (!importRes.ok || !importBody.ok) {
        throw new Error(importBody.error ?? `Import failed: ${importRes.status}`);
      }

      setResult({
        imported: importBody.imported,
        duplicates: importBody.duplicates,
        insert_errors: importBody.insert_errors,
        parse_errors: parseErrors,
        pages_processed: pagesDone,
        rows_extracted: allRows.length,
      });
      setProgress(null);
      onImported?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setProgress(null);
    } finally {
      setBusy(false);
      cancelRef.current = false;
    }
  };

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="bank-import-open-button" style={openBtn}>
        ⬆ Import PDF statement
      </button>
    );
  }

  return (
    <div className="bank-import-card" style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h3 style={{ fontSize: 14, margin: 0 }}>Import PDF bank statement</h3>
        <button onClick={() => setOpen(false)} style={closeBtn}>
          ×
        </button>
      </div>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>
        Drop CommBank/NAB/Westpac/ANZ statement PDFs. Each page is rendered to an image and sent to
        vision-OCR; transactions are deduped against existing rows.
      </p>

      <div className="bank-import-grid" style={grid2}>
        <Field label="Bank">
          <input value={bank} onChange={(e) => setBank(e.target.value)} style={inp} />
        </Field>
        <Field label="Account name">
          <input value={accountName} onChange={(e) => setAccountName(e.target.value)} style={inp} />
        </Field>
      </div>
      <div className="bank-import-grid" style={grid2}>
        <Field label="Account type">
          <select
            value={accountType}
            onChange={(e) => setAccountType(e.target.value as AccountType)}
            style={inp}
          >
            <option value="checking">Transaction (checking)</option>
            <option value="savings">Savings</option>
            <option value="credit_card">Credit card</option>
            <option value="loan">Loan</option>
            <option value="investment">Investment</option>
            <option value="other">Other</option>
          </select>
        </Field>
        <Field label="BSB / last 4 (optional)">
          <div className="bank-import-split">
            <input
              value={bsb}
              onChange={(e) => setBsb(e.target.value)}
              placeholder="062-001"
              style={{ ...inp, flex: 1 }}
            />
            <input
              value={last4}
              onChange={(e) => setLast4(e.target.value)}
              placeholder="1234"
              maxLength={4}
              style={{ ...inp, width: 80 }}
            />
          </div>
        </Field>
      </div>

      <Field label={`PDF statements (${files.length} selected)`}>
        <input
          type="file"
          accept="application/pdf,.pdf"
          multiple
          onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
          style={{ ...inp, padding: '6px 0' }}
        />
      </Field>

      <div className="bank-import-actions">
        <button onClick={handleImport} disabled={busy || files.length === 0} style={primaryBtn}>
          {busy
            ? 'Working…'
            : `Extract & import ${files.length ? `(${files.length} file${files.length === 1 ? '' : 's'})` : ''}`}
        </button>
        {busy && (
          <button
            onClick={() => {
              cancelRef.current = true;
            }}
            style={{ ...ghostBtn, marginLeft: 8 }}
          >
            Cancel
          </button>
        )}
      </div>

      {progress && <p style={{ marginTop: 8, fontSize: 12, color: 'var(--text-muted)' }}>⏳ {progress}</p>}
      {error && (
        <div
          role="alert"
          className="badge badge-danger"
          style={{ display: 'block', width: 'fit-content', marginTop: 8, textTransform: 'none' }}
        >
          {error}
        </div>
      )}
      {result && (
        <div style={successBox}>
          ✓ Imported <strong>{result.imported}</strong> transactions
          {result.duplicates > 0 && <> · {result.duplicates} duplicates skipped</>}
          {result.insert_errors > 0 && <> · {result.insert_errors} insert errors</>}
          <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text-muted)' }}>
            {result.pages_processed} pages processed · {result.rows_extracted} rows extracted
          </div>
          {result.parse_errors.length > 0 && (
            <details style={{ marginTop: 6 }}>
              <summary style={{ color: 'var(--text-danger)', cursor: 'pointer', fontSize: 11 }}>
                {result.parse_errors.length} extraction issue
                {result.parse_errors.length === 1 ? '' : 's'}
              </summary>
              <ul style={{ marginTop: 4, color: 'var(--text-danger)', fontSize: 11 }}>
                {result.parse_errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

// Lazy-load pdfjs once and configure worker via CDN to avoid bundling it
let pdfjsCache: PdfjsModule | null = null;
async function loadPdfjs(): Promise<PdfjsModule> {
  if (pdfjsCache) return pdfjsCache;
  const mod = (await import('pdfjs-dist')) as unknown as PdfjsModule;
  // Vite-friendly worker URL via unpkg CDN to avoid bundler config
  mod.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.mjs`;
  pdfjsCache = mod;
  return mod;
}

async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const dataUrl = String(r.result ?? '');
      const idx = dataUrl.indexOf(',');
      resolve(idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl);
    };
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
      <div style={{ marginBottom: 3 }}>{label}</div>
      {children}
    </label>
  );
}

const inp: React.CSSProperties = {
  width: '100%',
  padding: '6px 8px',
  background: 'var(--bg-panel)',
  color: 'var(--text-body)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 3,
  fontSize: 12,
};
const grid2: React.CSSProperties = { gap: 12 };
const card: React.CSSProperties = {
  marginTop: 16,
  padding: 16,
  background: 'var(--bg-panel)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 4,
  maxWidth: 720,
};
const openBtn: React.CSSProperties = {
  marginTop: 12,
  marginLeft: 8,
  padding: '0.4rem 1rem',
  background: 'transparent',
  color: 'var(--text-muted)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 3,
  fontSize: 12,
  cursor: 'pointer',
};
const closeBtn: React.CSSProperties = {
  background: 'transparent',
  color: 'var(--text-muted)',
  border: 'none',
  fontSize: 18,
  cursor: 'pointer',
  padding: 0,
};
const primaryBtn: React.CSSProperties = {
  marginTop: 12,
  padding: '0.5rem 1rem',
  background: 'var(--bg-info-subtle)',
  color: 'var(--text-title)',
  border: '1px solid var(--accent-info)',
  borderRadius: 4,
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
};
const ghostBtn: React.CSSProperties = {
  padding: '0.5rem 0.75rem',
  background: 'transparent',
  color: 'var(--text-muted)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 4,
  fontSize: 12,
  cursor: 'pointer',
};
const successBox: React.CSSProperties = {
  marginTop: 12,
  padding: 8,
  background: 'var(--bg-success-subtle)',
  border: '1px solid var(--accent-success)',
  borderRadius: 3,
  fontSize: 12,
};
