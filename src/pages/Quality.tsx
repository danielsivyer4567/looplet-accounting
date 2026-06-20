import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';
import { formatMoney } from '@/lib/money';

interface DupGroup {
  organization_id: string;
  supplier_id: string;
  invoice_date: string;
  total_inc_gst_cents: number;
  bill_ids: string[];
  dup_count: number;
}

interface LowConfBill {
  id: string;
  supplier_name_raw: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  total_inc_gst_cents: number | null;
  ocr_provider: string | null;
  ocr_confidence: number | null;
  status: string;
  created_at: string;
}

export function QualityPage() {
  const { currentOrg } = useOrg();
  const [duplicates, setDuplicates] = useState<DupGroup[]>([]);
  const [lowConf, setLowConf] = useState<LowConfBill[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);
    const [dupRes, lowRes] = await Promise.all([
      supabase.from('v_duplicate_bills').select('*').eq('organization_id', currentOrg.id),
      supabase.from('v_low_confidence_bills').select('*').eq('organization_id', currentOrg.id).order('created_at', { ascending: false }).limit(100),
    ]);
    setDuplicates((dupRes.data ?? []) as DupGroup[]);
    setLowConf((lowRes.data ?? []) as LowConfBill[]);
    setLoading(false);
  }, [currentOrg]);

  useEffect(() => void refresh(), [refresh]);

  if (!currentOrg) return null;

  return (
    <section>
      <h1>Data quality</h1>
      <p style={{ color: '#888', fontSize: 13 }}>
        Bills that look like duplicates, or where OCR couldn't confidently extract key fields.
        Resolve to keep your P&L and BAS clean.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12, maxWidth: 700, marginTop: 16 }}>
        <Kpi label="Duplicate groups" value={String(duplicates.length)} colour={duplicates.length > 0 ? '#e9a3a3' : '#86c7a3'} sub={duplicates.reduce((a, d) => a + d.dup_count, 0) + ' bills involved'} />
        <Kpi label="Needs review" value={String(lowConf.length)} colour={lowConf.length > 0 ? '#d2c886' : '#86c7a3'} sub="low confidence or missing fields" />
      </div>

      <h2 style={h2}>Possible duplicates</h2>
      {loading ? <p style={{ color: '#888' }}>Loading…</p> : duplicates.length === 0 ? (
        <p style={{ color: '#86c7a3', fontSize: 13 }}>✓ No duplicates detected.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {duplicates.map((d, i) => (
            <div key={i} style={{ padding: 12, background: '#1a1a1a', border: '1px solid #2a2a2a', borderRadius: 6 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontSize: 13 }}>
                    <strong>{d.dup_count} bills</strong> with same supplier, date <code style={{ color: '#888' }}>{d.invoice_date}</code>, amount <strong style={{ color: '#e9a3a3' }}>{formatMoney(d.total_inc_gst_cents)}</strong>
                  </div>
                  <div style={{ marginTop: 4, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {d.bill_ids.map((bid) => (
                      <Link key={bid} to={`/bills/${bid}`} style={{ color: '#86c7a3', fontSize: 11, textDecoration: 'none' }}>
                        bill {bid.slice(0, 8)} →
                      </Link>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <h2 style={h2}>Needs manual review</h2>
      {lowConf.length === 0 ? (
        <p style={{ color: '#86c7a3', fontSize: 13 }}>✓ All bills look clean.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead><tr style={{ borderBottom: '1px solid #2a2a2a' }}>
            <th style={th}>Supplier</th><th style={th}>Invoice #</th><th style={th}>Date</th>
            <th style={thRight}>Total</th><th style={th}>OCR</th><th style={th}>Status</th><th style={th}>Issues</th>
          </tr></thead>
          <tbody>
            {lowConf.map((b) => {
              const issues: string[] = [];
              if (!b.supplier_name_raw) issues.push('no supplier');
              if (b.total_inc_gst_cents == null) issues.push('no total');
              if (b.total_inc_gst_cents === 0) issues.push('$0');
              if (b.ocr_confidence != null && b.ocr_confidence < 0.6) issues.push(`${(b.ocr_confidence * 100).toFixed(0)}% conf`);
              if (b.invoice_date && new Date(b.invoice_date) > new Date(Date.now() + 7 * 86400000)) issues.push('future date');
              return (
                <tr key={b.id} style={{ borderBottom: '1px solid #1a1a1a' }}>
                  <td style={td}><Link to={`/bills/${b.id}`} style={{ color: '#aaa', textDecoration: 'none' }}>{b.supplier_name_raw ?? <span style={{ color: '#666' }}>—</span>}</Link></td>
                  <td style={td}><code style={{ color: '#aaa', fontSize: 11 }}>{b.invoice_number ?? '—'}</code></td>
                  <td style={td}>{b.invoice_date ?? '—'}</td>
                  <td style={tdRight}>{b.total_inc_gst_cents != null ? formatMoney(b.total_inc_gst_cents) : <span style={{ color: '#444' }}>—</span>}</td>
                  <td style={td}><code style={{ color: '#666', fontSize: 10 }}>{b.ocr_provider ?? '—'}</code></td>
                  <td style={td}>{b.status}</td>
                  <td style={td}>
                    {issues.map((iss) => <span key={iss} style={{ color: '#e9a3a3', fontSize: 10, marginRight: 4 }}>⚠ {iss}</span>)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Kpi({ label, value, colour, sub }: { label: string; value: string; colour: string; sub?: string }) {
  return (
    <div style={{ padding: 12, background: '#1a1a1a', border: '1px solid #2a2a2a', borderRadius: 6 }}>
      <div style={{ fontSize: 10, color: '#666', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ marginTop: 4, fontSize: 18, color: colour, fontWeight: 600 }}>{value}</div>
      {sub && <div style={{ marginTop: 3, fontSize: 11, color: '#888' }}>{sub}</div>}
    </div>
  );
}

const h2: React.CSSProperties = { fontSize: 14, marginTop: 24, marginBottom: 8 };
const th: React.CSSProperties = { padding: '0.4rem 0.5rem', textAlign: 'left', fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 500 };
const thRight: React.CSSProperties = { ...th, textAlign: 'right' };
const td: React.CSSProperties = { padding: '0.5rem' };
const tdRight: React.CSSProperties = { ...td, textAlign: 'right' };
