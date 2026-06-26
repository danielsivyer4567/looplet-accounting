/**
 * payment-runs-aba-export
 *
 * Generates an ABA (Cemtex) file for a payment run and returns it as a string.
 *
 * Input:
 *   { organization_id: string, payment_run_id: string }
 *
 * Output:
 *   { ok: true, filename: string, content: string }
 * | { ok: false, error: string }
 *
 * ABA format (Cemtex):
 *   - 120-byte fixed-width records, CRLF terminated
 *   - Type 0: File Descriptive Record (1 per file, first)
 *   - Type 1: Detail Record (1 per payee)
 *   - Type 7: File Total Record (1 per file, last)
 *   - All text: UPPERCASE ASCII only
 *
 * Type 0 layout (120 chars):
 *   Pos 1      (1)  : '0'
 *   Pos 2-18   (17) : BSB (blank) + spaces
 *   Pos 19-20  (2)  : '01'
 *   Pos 21-23  (3)  : Bank mnemonic (3 upper alpha, e.g. 'CBA')
 *   Pos 24-30  (7)  : spaces
 *   Pos 31-56  (26) : User preferred name (padded right with spaces)
 *   Pos 57-62  (6)  : APCA user ID (zero-padded, we use '000000' default)
 *   Pos 63-74  (12) : Description (padded right)
 *   Pos 75-80  (6)  : Process date DDMMYY
 *   Pos 81-120 (40) : spaces (reserved)
 *
 * Type 1 layout (120 chars):
 *   Pos 1      (1)  : '1'
 *   Pos 2-8    (7)  : BSB (NNN-NNN)
 *   Pos 9-17   (9)  : Account number, right-justified, blank-padded
 *   Pos 18     (1)  : Indicator (' ')
 *   Pos 19-20  (2)  : Transaction code '53'
 *   Pos 21-30  (10) : Amount in cents, right-justified, zero-padded
 *   Pos 31-62  (32) : Account name, left-justified, blank-padded
 *   Pos 63-80  (18) : Lodgement reference, left-justified, blank-padded
 *   Pos 81-87  (7)  : User BSB
 *   Pos 88-96  (9)  : User account number, right-justified, blank-padded
 *   Pos 97-112 (16) : User name, left-justified, blank-padded
 *   Pos 113-120(8)  : Amount in cents (re-stated), right-justified, zero-padded
 *
 * Type 7 layout (120 chars):
 *   Pos 1      (1)  : '7'
 *   Pos 2-8    (7)  : '999-999'
 *   Pos 9-20   (12) : spaces
 *   Pos 21-30  (10) : Net total amount, right-justified, zero-padded (same as credit total for one-direction)
 *   Pos 31-40  (10) : Credit total, right-justified, zero-padded
 *   Pos 41-50  (10) : Debit total ('0000000000')
 *   Pos 51-74  (24) : spaces
 *   Pos 75-80  (6)  : Record count, right-justified, zero-padded
 *   Pos 81-120 (40) : spaces
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, preflight } from '../_shared/cors.ts';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// ABA formatting helpers
// ---------------------------------------------------------------------------

/** Pad string to exactly `len` chars by right-filling with spaces. */
function padRight(s: string, len: number): string {
  return s.slice(0, len).padEnd(len, ' ');
}

/** Pad string to exactly `len` chars by left-filling with spaces. */
function padLeft(s: string, len: number): string {
  return s.slice(0, len).padStart(len, ' ');
}

/** Pad number to exactly `len` chars with leading zeros. */
function padNum(n: number, len: number): string {
  return String(Math.abs(Math.floor(n))).padStart(len, '0').slice(0, len);
}

/** Strip non-ASCII printable chars and commas; uppercase. */
function toAsciiUpper(s: string): string {
  return s
    .toUpperCase()
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/,/g, ' ')
    .trim();
}

/** Format BSB as NNN-NNN if not already. */
function normaliseBsb(bsb: string): string {
  const digits = bsb.replace(/\D/g, '');
  if (digits.length !== 6) return bsb.slice(0, 7).padEnd(7, ' ');
  return `${digits.slice(0, 3)}-${digits.slice(3)}`;
}

/** Format process date as DDMMYY from ISO date string. */
function formatDateDDMMYY(iso: string): string {
  // iso: 'YYYY-MM-DD'
  const parts = iso.split('-');
  if (parts.length !== 3) return '010101';
  const [yyyy, mm, dd] = parts;
  return `${dd}${mm}${(yyyy ?? '').slice(2)}`;
}

/** Extract a 3-letter bank mnemonic from a BSB prefix.
 *  Very minimal mapping; extend as needed. ABA spec says any 3 upper alpha. */
function bankMnemonic(bsb: string): string {
  const prefix = bsb.replace(/\D/g, '').slice(0, 3);
  const map: Record<string, string> = {
    '062': 'CBA', // Commonwealth Bank
    '063': 'CBA',
    '012': 'ANZ',
    '013': 'ANZ',
    '032': 'WBC', // Westpac
    '033': 'WBC',
    '082': 'NAB', // NAB
    '083': 'NAB',
    '484': 'STG', // St George (Westpac subsidiary)
    '736': 'BSA', // Bendigo
    '633': 'BOQ', // Bank of Queensland
    '923': 'ING',
    '880': 'MAC', // Macquarie
    '302': 'CUA',
  };
  return map[prefix] ?? 'GEN';
}

// ---------------------------------------------------------------------------
// Record builders
// ---------------------------------------------------------------------------

interface PayerDetails {
  bsb: string;       // NNN-NNN
  account: string;   // numeric
  name: string;      // max 16 chars uppercase ASCII
  apca_id: string;   // 6-digit zero-padded (default '000000')
}

function buildType0(payer: PayerDetails, payDate: string): string {
  // Total must be exactly 120 chars
  const mnemonic = bankMnemonic(payer.bsb);
  const userName = padRight(toAsciiUpper(payer.name).slice(0, 26), 26);
  const apcaId   = padLeft(payer.apca_id.slice(0, 6), 6);
  const desc     = padRight('PAYMENT RUN', 12);
  const date     = formatDateDDMMYY(payDate);

  // Pos  1      (1)  : '0'
  // Pos  2-18   (17) : BSB field is blank for header (spec says spaces here)
  // Pos  19-20  (2)  : '01'
  // Pos  21-23  (3)  : bank mnemonic
  // Pos  24-30  (7)  : spaces
  // Pos  31-56  (26) : user preferred name
  // Pos  57-62  (6)  : APCA user ID
  // Pos  63-74  (12) : description
  // Pos  75-80  (6)  : process date DDMMYY
  // Pos  81-120 (40) : spaces
  const rec =
    '0' +
    '                 ' +      // 17 spaces (BSB area blank)
    '01' +
    mnemonic +
    '       ' +                // 7 spaces
    userName +
    apcaId +
    desc +
    date +
    ''.padEnd(40, ' ');        // 40 trailing spaces

  if (rec.length !== 120) {
    throw new Error(`Type 0 record length error: expected 120, got ${rec.length}`);
  }
  return rec;
}

interface DetailItem {
  payeeBsb: string;
  payeeAccount: string;
  payeeName: string;
  amountCents: number;
  reference: string;
  payer: PayerDetails;
}

function buildType1(item: DetailItem): string {
  const bsb        = normaliseBsb(item.payeeBsb);               // 7 chars
  const acct       = padLeft(item.payeeAccount.replace(/\D/g, '').slice(0, 9), 9);  // 9 chars right-padded
  const indicator  = ' ';                                        // 1 char
  const txCode     = '53';                                       // 2 chars
  const amount     = padNum(item.amountCents, 10);               // 10 chars
  const name       = padRight(toAsciiUpper(item.payeeName).slice(0, 32), 32); // 32 chars
  const ref        = padRight(toAsciiUpper(item.reference).slice(0, 18), 18); // 18 chars
  const userBsb    = normaliseBsb(item.payer.bsb);               // 7 chars
  const userAcct   = padLeft(item.payer.account.replace(/\D/g, '').slice(0, 9), 9); // 9 chars
  const userName   = padRight(toAsciiUpper(item.payer.name).slice(0, 16), 16); // 16 chars
  const amtRestate = padNum(item.amountCents, 8);                // 8 chars

  const rec =
    '1' +
    bsb +
    acct +
    indicator +
    txCode +
    amount +
    name +
    ref +
    userBsb +
    userAcct +
    userName +
    amtRestate;

  if (rec.length !== 120) {
    throw new Error(`Type 1 record length error: expected 120, got ${rec.length} for payee ${item.payeeName}`);
  }
  return rec;
}

function buildType7(creditTotalCents: number, recordCount: number): string {
  // Net total = credit total (no debits in a payment run)
  const netTotal    = padNum(creditTotalCents, 10);   // 10 chars
  const creditTotal = padNum(creditTotalCents, 10);   // 10 chars
  const debitTotal  = '0000000000';                   // 10 chars
  const count       = padNum(recordCount, 6);          // 6 chars

  const rec =
    '7' +
    '999-999' +                 // 7 chars
    '            ' +            // 12 spaces
    netTotal +
    creditTotal +
    debitTotal +
    ''.padEnd(24, ' ') +
    count +
    ''.padEnd(40, ' ');

  if (rec.length !== 120) {
    throw new Error(`Type 7 record length error: expected 120, got ${rec.length}`);
  }
  return rec;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const anonKey     = Deno.env.get('SUPABASE_ANON_KEY');

  if (!supabaseUrl || !serviceKey || !anonKey) {
    return json({ ok: false, error: 'Server config missing' }, 500);
  }

  // Authenticate
  const authHeader = req.headers.get('Authorization') ?? '';
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: authErr } = await userClient.auth.getUser();
  if (authErr || !user) {
    return json({ ok: false, error: 'Unauthenticated' }, 401);
  }

  let body: { organization_id: string; payment_run_id: string };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  const { organization_id, payment_run_id } = body;
  if (!organization_id || !payment_run_id) {
    return json({ ok: false, error: 'organization_id and payment_run_id are required' }, 400);
  }

  const admin = createClient(supabaseUrl, serviceKey);

  // Verify membership
  const { data: membership } = await admin
    .from('organization_memberships')
    .select('id')
    .eq('user_id', user.id)
    .eq('organization_id', organization_id)
    .maybeSingle();

  if (!membership) {
    return json({ ok: false, error: 'Forbidden' }, 403);
  }

  // Load payment_run
  const { data: run, error: runErr } = await admin
    .from('payment_runs')
    .select('id, organization_id, pay_date, status, payer_bank_account_id')
    .eq('id', payment_run_id)
    .eq('organization_id', organization_id)
    .maybeSingle();

  if (runErr || !run) {
    return json({ ok: false, error: 'Payment run not found' }, 404);
  }

  const runRow = run as Record<string, unknown>;
  if (runRow['status'] === 'cancelled') {
    return json({ ok: false, error: 'Cannot export a cancelled payment run' }, 409);
  }

  // Load org settings for payer bank details
  const { data: org } = await admin
    .from('organizations')
    .select('settings')
    .eq('id', organization_id)
    .maybeSingle();

  const settings = (org as Record<string, unknown> | null)?.['settings'] as Record<string, unknown> ?? {};
  const payerBsb     = settings['payer_bsb'] as string | undefined;
  const payerAccount = settings['payer_account'] as string | undefined;
  const payerName    = settings['payer_name'] as string | undefined;

  if (!payerBsb || !payerAccount || !payerName) {
    return json({
      ok: false,
      error: 'Organisation payer bank details are incomplete. Set them in Settings → Payer bank details.',
    }, 422);
  }

  const payer: PayerDetails = {
    bsb:     payerBsb,
    account: payerAccount,
    name:    payerName.slice(0, 26),
    apca_id: (settings['payer_apca_id'] as string | undefined) ?? '000000',
  };

  // Load payment_run_items
  const { data: items, error: itemsErr } = await admin
    .from('payment_run_items')
    .select('id, amount_cents, payee_bsb, payee_account_number, payee_account_name, reference')
    .eq('payment_run_id', payment_run_id)
    .order('created_at', { ascending: true });

  if (itemsErr) {
    return json({ ok: false, error: `Failed to load items: ${itemsErr.message}` }, 500);
  }
  if (!items || items.length === 0) {
    return json({ ok: false, error: 'Payment run has no items' }, 422);
  }

  // ---- Tier-2 approval gate -------------------------------------------------
  // Bind the approval to EXACTLY the item set being paid: build a deterministic
  // payload (sorted by item id; per-field order is irrelevant — Postgres jsonb
  // normalises keys) and let Postgres hash it via the jsonb overload of
  // is_action_approved, so we never depend on Deno JSON.stringify matching
  // Postgres jsonb::text. Editing the run after approval changes the hash, which
  // silently invalidates the stale approval (the approve-then-mutate guard).
  const approvalPayload = {
    payment_run_id,
    items: (items as Record<string, unknown>[])
      .map((it) => ({
        id: it['id'] as string,
        amount_cents: it['amount_cents'] as number,
        payee_bsb: (it['payee_bsb'] as string) ?? '',
        payee_account_number: (it['payee_account_number'] as string) ?? '',
        payee_account_name: (it['payee_account_name'] as string) ?? '',
        reference: (it['reference'] as string) ?? '',
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };

  const { data: approved, error: approvedErr } = await admin.rpc('is_action_approved', {
    p_org: organization_id,
    p_resource_type: 'payment_run',
    p_resource_id: payment_run_id,
    p_payload: approvalPayload,
  });
  if (approvedErr) {
    return json({ ok: false, error: `Approval check failed: ${approvedErr.message}` }, 500);
  }

  if (!approved) {
    // No matching Tier-2 approval yet. Record a pending request bound to this exact
    // payload (idempotent) so an admin can approve it, then refuse. request_approval
    // needs a user context (auth.uid()), so it goes through userClient, not admin.
    const { data: approvalId, error: reqErr } = await userClient.rpc('request_approval', {
      p_org: organization_id,
      p_resource_type: 'payment_run',
      p_resource_id: payment_run_id,
      p_risk_tier: 'tier2_approve',
      p_payload: approvalPayload,
    });
    if (reqErr) {
      // The refusal still stands (fail-closed), but distinguish "couldn't record the
      // request" from "pending approval" so the cause is debuggable, not a silent null.
      console.error('request_approval failed', reqErr);
      return json(
        { ok: false, error: `Approval required, but the approval request could not be recorded: ${reqErr.message}` },
        403,
      );
    }
    return json(
      {
        ok: false,
        error: 'Approval required before exporting this payment run.',
        approval_id: approvalId ?? null,
      },
      403,
    );
  }

  // Build ABA content
  const payDate = runRow['pay_date'] as string;
  const lines: string[] = [];

  try {
    lines.push(buildType0(payer, payDate));

    let creditTotal = 0;
    for (const item of items) {
      const iRow = item as Record<string, unknown>;
      const amount = iRow['amount_cents'] as number;
      creditTotal += amount;
      lines.push(buildType1({
        payeeBsb:     (iRow['payee_bsb'] as string) ?? '',
        payeeAccount: (iRow['payee_account_number'] as string) ?? '',
        payeeName:    (iRow['payee_account_name'] as string) ?? 'UNKNOWN',
        amountCents:  amount,
        reference:    (iRow['reference'] as string) ?? '',
        payer,
      }));
    }

    lines.push(buildType7(creditTotal, items.length));
  } catch (buildErr) {
    const msg = buildErr instanceof Error ? buildErr.message : String(buildErr);
    return json({ ok: false, error: `ABA build error: ${msg}` }, 500);
  }

  // CRLF terminated, with a final CRLF
  const content = lines.join('\r\n') + '\r\n';
  const sizeBytes = new TextEncoder().encode(content).length;

  // Generate filename: looplet-aba-YYYYMMDD-{first 8 chars of run_id}.aba
  const datePart = payDate.replace(/-/g, '');
  const idShort  = payment_run_id.replace(/-/g, '').slice(0, 8);
  const filename = `looplet-aba-${datePart}-${idShort}.aba`;

  // Update payment_run: status → exported, record file metadata
  await admin
    .from('payment_runs')
    .update({
      status: 'exported',
      aba_file_generated_at: new Date().toISOString(),
      aba_file_size_bytes: sizeBytes,
    })
    .eq('id', payment_run_id);

  return json({ ok: true, filename, content });
});
