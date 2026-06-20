/**
 * bank-csv-import — manual import of bank transactions from a CSV export.
 *
 * For users on Basiq tiers without CDR Connections, or for one-off historical
 * backfills. Populates the same bank_connections / bank_accounts /
 * bank_transactions tables that Basiq sync writes to, so the reconciliation
 * matcher and per-job P&L work identically.
 *
 * Input:
 *   {
 *     organization_id,
 *     institution_name,           // e.g. "CommBank"
 *     account_name,               // e.g. "Business Cheque"
 *     account_type,               // bank_account_type enum
 *     bsb?, account_number_last4?,
 *     format: 'commbank' | 'nab' | 'westpac' | 'anz' | 'generic',
 *     csv_text                    // raw CSV string
 *   }
 *
 * Output: { ok, imported, duplicates, parse_errors, bank_connection_id, bank_account_id }
 *
 * Dedupe key: external_id = sha256(posted_at|amount_cents|description). Same
 * row imported twice (e.g. overlapping date ranges) is upserted, not duplicated.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, preflight } from '../_shared/cors.ts';

interface RequestBody {
  organization_id: string;
  institution_name: string;
  account_name: string;
  account_type: 'checking' | 'savings' | 'credit_card' | 'loan' | 'investment' | 'other';
  bsb?: string;
  account_number_last4?: string;
  format: 'commbank' | 'nab' | 'westpac' | 'anz' | 'generic';
  csv_text: string;
}

interface ParsedRow {
  posted_at: string;        // ISO date
  description: string;
  amount_cents: number;     // signed: negative = money out
  balance_cents?: number;
  reference?: string;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ ok: false, error: 'Unauthorized' }, 401);

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    if (!supabaseUrl || !serviceKey || !anonKey) {
      return json({ ok: false, error: 'Server config missing' }, 500);
    }

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const body = (await req.json()) as RequestBody;
    if (!body.organization_id || !body.csv_text || !body.account_name) {
      return json({ ok: false, error: 'organization_id, account_name, csv_text required' }, 400);
    }

    // RLS check via user client
    const { data: org } = await userClient
      .from('organizations')
      .select('id')
      .eq('id', body.organization_id)
      .maybeSingle();
    if (!org) return json({ ok: false, error: 'Organisation not accessible' }, 403);

    // Parse
    const rows = parseCsv(body.csv_text, body.format);
    if (rows.errors.length > 0 && rows.parsed.length === 0) {
      return json({
        ok: false,
        error: 'Could not parse any rows',
        parse_errors: rows.errors.slice(0, 10),
      }, 400);
    }

    // Get-or-create the manual bank_connections row for this institution
    let connectionId: string;
    const { data: existingConn } = await admin
      .from('bank_connections')
      .select('id')
      .eq('organization_id', body.organization_id)
      .eq('provider', 'manual')
      .eq('institution_name', body.institution_name)
      .maybeSingle();

    if (existingConn) {
      connectionId = existingConn.id;
    } else {
      const { data: newConn, error: connErr } = await admin
        .from('bank_connections')
        .insert({
          organization_id: body.organization_id,
          provider: 'manual',
          institution_name: body.institution_name,
          status: 'active',
          encrypted_access_token: '', // unused for manual
          metadata: { source: 'csv_import' },
        })
        .select('id')
        .single();
      if (connErr || !newConn) {
        return json({ ok: false, error: `connection create: ${connErr?.message}` }, 500);
      }
      connectionId = newConn.id;
    }

    // Get-or-create the bank_accounts row
    const acctExternalId = `manual:${slugify(body.account_name)}${body.account_number_last4 ? `:${body.account_number_last4}` : ''}`;
    const { data: acctRow, error: acctErr } = await admin
      .from('bank_accounts')
      .upsert(
        {
          organization_id: body.organization_id,
          bank_connection_id: connectionId,
          external_id: acctExternalId,
          name: body.account_name,
          account_type: body.account_type,
          bsb: body.bsb ?? null,
          account_number_last4: body.account_number_last4 ?? null,
          currency_code: 'AUD',
          is_active: true,
        },
        { onConflict: 'organization_id,bank_connection_id,external_id' },
      )
      .select('id')
      .single();
    if (acctErr || !acctRow) {
      return json({ ok: false, error: `account upsert: ${acctErr?.message}` }, 500);
    }
    const accountId = acctRow.id;

    // Insert transactions, dedupe by hash(date|amount|description)
    let imported = 0;
    const duplicates = 0;
    let insertErrors = 0;
    const importedTxnIds: string[] = [];
    for (const r of rows.parsed) {
      const externalId = await hashKey(`${r.posted_at}|${r.amount_cents}|${r.description}`);
      const { data: upserted, error: txnErr } = await admin
        .from('bank_transactions')
        .upsert(
          {
            organization_id: body.organization_id,
            bank_account_id: accountId,
            external_id: externalId,
            posted_at: r.posted_at,
            description: r.description,
            amount_cents: r.amount_cents,
            running_balance_cents: r.balance_cents ?? null,
            reference: r.reference ?? null,
            raw: { source: 'csv_import', format: body.format },
          },
          { onConflict: 'bank_account_id,external_id', ignoreDuplicates: false },
        )
        .select('id')
        .single();
      if (txnErr) insertErrors += 1;
      else {
        imported += 1;
        if (upserted?.id) importedTxnIds.push(upserted.id as string);
      }
    }

    // Update last_synced_at on the connection
    await admin
      .from('bank_connections')
      .update({ last_synced_at: new Date().toISOString(), last_error: null })
      .eq('id', connectionId);

    // Fire-and-forget subscription detection
    try {
      await fetch(`${supabaseUrl}/functions/v1/subscriptions-detect`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ organization_id: body.organization_id }),
      });
    } catch { /* swallow */ }

    // Fire-and-forget intake rule routing — auto-apply user-curated rules
    // (descriptor_regex / amount_range) to the freshly-imported txns. Batch
    // call so we only load active rules once.
    if (importedTxnIds.length > 0) {
      try {
        await fetch(`${supabaseUrl}/functions/v1/intake-routing-apply`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            organization_id: body.organization_id,
            target: 'bank_transaction',
            target_ids: importedTxnIds,
          }),
        });
      } catch { /* swallow */ }
    }

    return json({
      ok: true,
      imported,
      duplicates,
      insert_errors: insertErrors,
      parse_errors: rows.errors.slice(0, 5),
      bank_connection_id: connectionId,
      bank_account_id: accountId,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ ok: false, error: msg }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function parseCsv(text: string, format: RequestBody['format']): { parsed: ParsedRow[]; errors: string[] } {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const parsed: ParsedRow[] = [];
  const errors: string[] = [];

  // Detect & skip header for formats that have one
  const hasHeader = format === 'nab' || format === 'westpac' || format === 'generic';
  const startIdx = hasHeader ? 1 : 0;

  for (let i = startIdx; i < lines.length; i += 1) {
    const cols = parseCsvLine(lines[i]);
    try {
      const row = parseRow(cols, format);
      if (row) parsed.push(row);
    } catch (err) {
      errors.push(`Line ${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { parsed, errors };
}

function parseRow(cols: string[], format: RequestBody['format']): ParsedRow | null {
  switch (format) {
    case 'commbank': {
      // Date,Amount,Description,Balance — no header — dd/mm/yyyy
      const [d, amt, desc, bal] = cols;
      return {
        posted_at: parseDmyDate(d),
        amount_cents: parseAmountCents(amt),
        description: cleanDescription(desc),
        balance_cents: bal ? parseAmountCents(bal) : undefined,
      };
    }
    case 'nab': {
      // Date,Amount,Description,Balance,Category,Merchant Name
      const [d, amt, desc, bal] = cols;
      return {
        posted_at: parseDmyDate(d),
        amount_cents: parseAmountCents(amt),
        description: cleanDescription(desc),
        balance_cents: bal ? parseAmountCents(bal) : undefined,
      };
    }
    case 'westpac': {
      // Date,Description,Debit,Credit,Balance — has header
      const [d, desc, debit, credit, bal] = cols;
      const amount = credit && credit.trim() ? parseAmountCents(credit) : -Math.abs(parseAmountCents(debit ?? '0'));
      return {
        posted_at: parseDmyDate(d),
        description: cleanDescription(desc),
        amount_cents: amount,
        balance_cents: bal ? parseAmountCents(bal) : undefined,
      };
    }
    case 'anz': {
      // Date,Amount,Description — no header — dd/mm/yyyy
      const [d, amt, ...rest] = cols;
      return {
        posted_at: parseDmyDate(d),
        amount_cents: parseAmountCents(amt),
        description: cleanDescription(rest.join(',')),
      };
    }
    case 'generic': {
      // Generic with header: assumes columns named Date, Description, Amount (or Debit+Credit), Balance
      // We've already skipped the header; assume positional Date,Description,Amount[,Balance]
      const [d, desc, amt, bal] = cols;
      return {
        posted_at: parseDmyDate(d),
        description: cleanDescription(desc),
        amount_cents: parseAmountCents(amt),
        balance_cents: bal ? parseAmountCents(bal) : undefined,
      };
    }
  }
}

/** Minimal RFC-4180-ish CSV split. Handles double-quoted strings with embedded commas. */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i += 1; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else {
      if (c === ',') { out.push(cur); cur = ''; }
      else if (c === '"') inQ = true;
      else cur += c;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** Accept "dd/mm/yyyy" or "dd-mm-yyyy" or "yyyy-mm-dd". Return YYYY-MM-DD. */
function parseDmyDate(input: string): string {
  if (!input) throw new Error('empty date');
  const s = input.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/);
  if (!m) throw new Error(`bad date "${s}"`);
  const [, dd, mm, yyRaw] = m;
  const yy = yyRaw.length === 2 ? `20${yyRaw}` : yyRaw;
  return `${yy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}

/** "$-1,234.56" / "(50.00)" / "50.00" → cents int (signed). */
function parseAmountCents(input: string): number {
  if (!input) return 0;
  const raw = input.trim();
  if (!raw) return 0;
  const negParens = /^\(.*\)$/.test(raw);
  const cleaned = raw.replace(/[$,()\s]/g, '');
  const n = parseFloat(cleaned);
  if (!Number.isFinite(n)) throw new Error(`bad amount "${input}"`);
  return Math.round(n * 100) * (negParens ? -1 : 1);
}

function cleanDescription(s: string): string {
  return (s ?? '').replace(/\s+/g, ' ').trim() || '(no description)';
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64);
}

async function hashKey(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}
