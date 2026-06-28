import { afterAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Receipt Hub live signed-in smoke.
 *
 * This is the missing SC-13 proof path: a real member JWT issues a receipt
 * identity, invokes the deployed `receipt-webhook` in signed-in app mode, and
 * verifies the persisted event, bill, line item, audit JSON, and sync job.
 *
 * Env required:
 *   - VITE_SUPABASE_URL      (or SUPABASE_URL)
 *   - VITE_SUPABASE_ANON_KEY (or SUPABASE_ANON_KEY)
 *   - SUPABASE_SERVICE_ROLE_KEY
 *   - TEST_USER_JWT          signed-in user token for TEST_ORG_ID
 *   - TEST_ORG_ID            org where that user has access
 *
 * The service role is used only to verify and delete smoke-created rows and the
 * private receipt-audit storage object. Append-only request/audit logs are left
 * intact.
 */

interface IdentityRpcRow {
  id: string;
  receipt_token: string;
  token_prefix: string;
}

interface ReceiptWebhookBody {
  ok?: boolean;
  receipt_event_id?: string;
  bill_id?: string | null;
  audit_package_id?: string;
  sync_jobs?: { id?: string; provider?: string; status?: string }[];
  classification?: {
    business_use?: string;
    deductibility_status?: string;
    gst_estimated?: boolean;
  };
  error?: string;
}

const SUPABASE_URL = process.env['VITE_SUPABASE_URL'] ?? process.env['SUPABASE_URL'] ?? '';
const ANON_KEY = process.env['VITE_SUPABASE_ANON_KEY'] ?? process.env['SUPABASE_ANON_KEY'] ?? '';
const SERVICE_ROLE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';
const TEST_USER_JWT = process.env['TEST_USER_JWT'] ?? '';
const TEST_ORG_ID = process.env['TEST_ORG_ID'] ?? '';

const HAS_ENV = Boolean(
  SUPABASE_URL && ANON_KEY && SERVICE_ROLE_KEY && TEST_USER_JWT && TEST_ORG_ID,
);
const IS_CI = Boolean(process.env['CI']);
const SKIP_REASON =
  'Receipt Hub live smoke requires VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY + ' +
  'SUPABASE_SERVICE_ROLE_KEY + TEST_USER_JWT + TEST_ORG_ID.';

if (IS_CI && !HAS_ENV) {
  throw new Error(`[receipt-hub-live-smoke] FATAL: ${SKIP_REASON}`);
}

const itLive = it.skipIf(!HAS_ENV);
const FN_URL = `${SUPABASE_URL}/functions/v1/receipt-webhook`;
const RUN_ID = Date.now().toString(36);
const RECEIPT_NUMBER = `RH-SMOKE-${RUN_ID}`;
const IDEMPOTENCY_KEY = `receipt-hub-live-smoke-${RUN_ID}`;

describe('Receipt Hub live signed-in smoke', () => {
  let admin: SupabaseClient | null = null;
  let identityId = '';
  let receiptEventId = '';
  let billId = '';
  let auditStorageKey = '';

  afterAll(async () => {
    if (!admin) return;

    const cleanupErrors: string[] = [];
    const record = async (
      label: string,
      action: PromiseLike<{ error: { message: string } | null }>,
    ) => {
      const { error } = await action;
      if (error) cleanupErrors.push(`${label}: ${error.message}`);
    };

    if (auditStorageKey) {
      await record(
        'storage receipt-audit remove',
        admin.storage.from('receipt-audit').remove([auditStorageKey]),
      );
    }
    if (receiptEventId) {
      await record(
        'receipt_sync_jobs delete',
        admin.from('receipt_sync_jobs').delete().eq('receipt_event_id', receiptEventId),
      );
      await record(
        'receipt_audit_packages delete',
        admin.from('receipt_audit_packages').delete().eq('receipt_event_id', receiptEventId),
      );
      await record(
        'receipt_event_line_items delete',
        admin.from('receipt_event_line_items').delete().eq('receipt_event_id', receiptEventId),
      );
      await record(
        'receipt_events delete',
        admin.from('receipt_events').delete().eq('id', receiptEventId),
      );
    }
    if (billId) {
      await record(
        'bill_line_items delete',
        admin.from('bill_line_items').delete().eq('bill_id', billId),
      );
      await record('bills delete', admin.from('bills').delete().eq('id', billId));
    }
    if (identityId) {
      await record(
        'receipt_identities delete',
        admin.from('receipt_identities').delete().eq('id', identityId),
      );
    }

    if (cleanupErrors.length > 0) {
      throw new Error(`Receipt Hub smoke cleanup failed: ${cleanupErrors.join('; ')}`);
    }
  }, 30_000);

  itLive(
    'issues an identity, ingests a receipt, and verifies event/bill/audit/sync persistence',
    async () => {
      admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const userClient = createClient(SUPABASE_URL, ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { headers: { Authorization: `Bearer ${TEST_USER_JWT}` } },
      });

      const issued = await userClient.rpc('issue_receipt_identity', {
        p_organization_id: TEST_ORG_ID,
        p_label: 'Receipt Hub live smoke',
        p_channel: 'epost',
      });
      expect(issued.error, `issue_receipt_identity: ${issued.error?.message}`).toBeNull();
      const identityRows = Array.isArray(issued.data) ? issued.data : [issued.data];
      const identity = identityRows[0] as IdentityRpcRow | null | undefined;
      expect(identity?.id).toBeTruthy();
      expect(identity?.receipt_token).toMatch(/^rhp_[a-f0-9]{8}\.[a-f0-9]+$/);
      identityId = identity?.id ?? '';

      const response = await fetch(FN_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TEST_USER_JWT}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': IDEMPOTENCY_KEY,
        },
        body: JSON.stringify({
          organization_id: TEST_ORG_ID,
          identity_token: identity?.receipt_token,
          event_type: 'sale',
          source_channel: 'epost',
          payload: {
            merchant: {
              name: 'Receipt Hub Smoke Supplies',
              abn: '12123456789',
            },
            receipt: {
              number: RECEIPT_NUMBER,
              event_type: 'sale',
              purchase_at: new Date().toISOString(),
              currency: 'AUD',
              total_inc_gst_cents: 11_000,
              gst_cents: 1_000,
              subtotal_ex_gst_cents: 10_000,
              payment_method: 'card',
              payment_last4: '1234',
              payment_reference: `smoke-${RUN_ID}`,
            },
            classification: {
              business_use: 'business',
              deductibility: 'deductible',
              category: 'materials',
              sync_targets: ['generic_api'],
            },
            line_items: [
              {
                description: 'Smoke materials',
                quantity: 1,
                unit_price_cents: 11_000,
                total_inc_gst_cents: 11_000,
                gst_cents: 1_000,
                category: 'materials',
              },
            ],
          },
          sync_targets: ['generic_api'],
        }),
      });
      const body = (await response.json().catch(() => ({}))) as ReceiptWebhookBody;
      expect(response.status, `receipt-webhook response: ${JSON.stringify(body)}`).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.receipt_event_id).toBeTruthy();
      expect(body.bill_id).toBeTruthy();
      expect(body.audit_package_id).toBeTruthy();
      expect(body.classification).toMatchObject({
        business_use: 'business',
        deductibility_status: 'deductible',
        gst_estimated: false,
      });
      expect(body.sync_jobs?.some((job) => job.provider === 'generic_api')).toBe(true);
      receiptEventId = body.receipt_event_id ?? '';
      billId = body.bill_id ?? '';
      auditStorageKey = receiptEventId ? `receipt-hub/${TEST_ORG_ID}/${receiptEventId}.json` : '';

      const receiptEvent = await admin
        .from('receipt_events')
        .select(
          'id, organization_id, receipt_identity_id, bill_id, source_channel, status, merchant_name, receipt_number, total_inc_gst_cents, gst_cents, business_use, deductibility_status',
        )
        .eq('id', receiptEventId)
        .single();
      expect(receiptEvent.error, `select receipt_event: ${receiptEvent.error?.message}`).toBeNull();
      expect(receiptEvent.data).toMatchObject({
        organization_id: TEST_ORG_ID,
        receipt_identity_id: identityId,
        bill_id: billId,
        source_channel: 'epost',
        status: 'processed',
        merchant_name: 'Receipt Hub Smoke Supplies',
        receipt_number: RECEIPT_NUMBER,
        total_inc_gst_cents: 11_000,
        gst_cents: 1_000,
        business_use: 'business',
        deductibility_status: 'deductible',
      });

      const bill = await admin
        .from('bills')
        .select(
          'id, organization_id, source, document_kind, supplier_name_raw, invoice_number, total_inc_gst_cents',
        )
        .eq('id', billId)
        .single();
      expect(bill.error, `select bill: ${bill.error?.message}`).toBeNull();
      expect(bill.data).toMatchObject({
        organization_id: TEST_ORG_ID,
        source: 'api',
        document_kind: 'receipt',
        supplier_name_raw: 'Receipt Hub Smoke Supplies',
        invoice_number: RECEIPT_NUMBER,
        total_inc_gst_cents: 11_000,
      });

      const lineItems = await admin
        .from('receipt_event_line_items')
        .select('id, receipt_event_id, description, total_inc_gst_cents, gst_cents')
        .eq('receipt_event_id', receiptEventId);
      expect(lineItems.error, `select line items: ${lineItems.error?.message}`).toBeNull();
      expect(lineItems.data).toHaveLength(1);
      expect(lineItems.data?.[0]).toMatchObject({
        receipt_event_id: receiptEventId,
        description: 'Smoke materials',
        total_inc_gst_cents: 11_000,
        gst_cents: 1_000,
      });

      const auditPackage = await admin
        .from('receipt_audit_packages')
        .select(
          'id, organization_id, receipt_event_id, bill_id, storage_key, gst_status, deductibility_status',
        )
        .eq('receipt_event_id', receiptEventId)
        .single();
      expect(auditPackage.error, `select audit package: ${auditPackage.error?.message}`).toBeNull();
      expect(auditPackage.data).toMatchObject({
        id: body.audit_package_id,
        organization_id: TEST_ORG_ID,
        receipt_event_id: receiptEventId,
        bill_id: billId,
        gst_status: 'supplied',
        deductibility_status: 'deductible',
      });
      auditStorageKey = auditPackage.data?.storage_key ?? auditStorageKey;
      expect(auditStorageKey).toBe(`receipt-hub/${TEST_ORG_ID}/${receiptEventId}.json`);

      const auditObject = await admin.storage.from('receipt-audit').download(auditStorageKey);
      expect(auditObject.error, `download audit JSON: ${auditObject.error?.message}`).toBeNull();

      const syncJobs = await admin
        .from('receipt_sync_jobs')
        .select('id, organization_id, receipt_event_id, bill_id, provider, status')
        .eq('receipt_event_id', receiptEventId)
        .eq('provider', 'generic_api');
      expect(syncJobs.error, `select sync jobs: ${syncJobs.error?.message}`).toBeNull();
      expect(syncJobs.data).toHaveLength(1);
      expect(syncJobs.data?.[0]).toMatchObject({
        organization_id: TEST_ORG_ID,
        receipt_event_id: receiptEventId,
        bill_id: billId,
        provider: 'generic_api',
      });

      const visibleToUser = await userClient
        .from('receipt_events')
        .select('id, receipt_number, source_channel, status')
        .eq('id', receiptEventId)
        .single();
      expect(
        visibleToUser.error,
        `user receipt_events select: ${visibleToUser.error?.message}`,
      ).toBeNull();
      expect(visibleToUser.data).toMatchObject({
        id: receiptEventId,
        receipt_number: RECEIPT_NUMBER,
        source_channel: 'epost',
      });
    },
    90_000,
  );
});
