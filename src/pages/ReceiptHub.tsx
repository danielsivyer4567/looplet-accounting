import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type FormEvent,
} from 'react';
import { supabase } from '@/lib/supabase';
import { formatMoney } from '@/lib/money';
import { code128Bars } from '@/lib/code128';
import {
  buildPosBridgeEnv,
  loopletSecretPrefix,
  receiptWebhookUrlFromSupabaseUrl,
} from '@/lib/receiptBridgeSetup';
import {
  buildManualReceiptPayload,
  buildReceiptPayloadFromExtraction,
  type ExtractedBillData,
} from '@/lib/receiptCapture';
import { useOrg } from '@/hooks/useOrg';
import { orgTimeZone, todayLocal } from '@/lib/localDates';
import {
  CheckCircle,
  CreditCard,
  DatabaseZap,
  FileCheck2,
  KeyRound,
  Loader2,
  Nfc,
  PlugZap,
  RadioTower,
  ReceiptText,
  Route,
  ScanLine,
  ShieldCheck,
  Store,
  Smartphone,
  WalletCards,
  Webhook,
  X,
  type LucideIcon,
} from 'lucide-react';
import { JobPicker } from '@/components/JobPicker';

type CaptureChannel = 'phone-pass' | 'tag' | 'pos' | 'eftpos';
type SyncProvider = 'xero' | 'myob' | 'quickbooks' | 'generic_api';
type ReceiptEventType = 'sale' | 'refund' | 'void';

interface ReceiptEventRow {
  id: string;
  bill_id: string | null;
  related_receipt_event_id: string | null;
  event_type: ReceiptEventType | null;
  merchant_name: string;
  receipt_number: string | null;
  purchase_at: string | null;
  source_channel: string;
  status: string;
  business_use: string;
  deductibility_status: string;
  gst_cents: number | null;
  total_inc_gst_cents: number;
  payment_method: string | null;
  payment_last4: string | null;
  payment_reference: string | null;
  terminal_id: string | null;
  store_id: string | null;
}

interface ReceiptSyncJobRow {
  id: string;
  receipt_event_id: string;
  bill_id: string | null;
  provider: SyncProvider;
  status: string;
  last_error: string | null;
  created_at: string;
}

interface IdentityRpcRow {
  id: string;
  receipt_token: string;
  token_prefix: string;
}

interface ReceiptIdentityRow {
  id: string;
  label: string | null;
  channel: string | null;
  token_prefix: string | null;
  status: string;
  last_used_at: string | null;
  created_at: string;
}

interface ReceiptLineItemRow {
  id: string;
  line_number: number;
  description: string;
  quantity: number;
  unit_price_cents: number;
  total_inc_gst_cents: number;
  gst_cents: number;
  category: string | null;
}

interface ReceiptAuditPackageRow {
  id: string;
  bill_id: string | null;
  gst_status: string;
  deductibility_status: string;
  decision_path: Record<string, unknown>;
  storage_key: string | null;
}

interface ApiKeyRpcRow {
  id: string;
  api_key: string;
  key_prefix: string;
}

interface ReceiptWebhookResult {
  receipt_event_id: string;
  event_type?: ReceiptEventType;
  related_receipt_event_id?: string | null;
  bill_id: string | null;
  audit_package_id?: string;
  classification?: {
    business_use?: string;
    deductibility_status?: string;
    gst_status?: 'supplied' | 'none' | 'review';
    job_id?: string | null;
    reason?: string;
  };
  sync_jobs?: { id: string; provider: SyncProvider; status: string }[];
}

interface Channel {
  id: CaptureChannel;
  title: string;
  detail: string;
  icon: LucideIcon;
  tone: string;
}

const defaultChannel: Channel = {
  id: 'phone-pass',
  title: 'Phone pass',
  detail: 'Wallet token identifies the buyer at checkout.',
  icon: Smartphone,
  tone: 'var(--accent-success)',
};

const channels: Channel[] = [
  defaultChannel,
  {
    id: 'tag',
    title: 'Key fob / tag',
    detail: 'NFC tag or QR fallback for trade counters.',
    icon: KeyRound,
    tone: 'var(--accent-info)',
  },
  {
    id: 'pos',
    title: 'POS webhook',
    detail: 'Merchant sends the receipt payload to Looplet.',
    icon: Store,
    tone: 'var(--accent-warning)',
  },
  {
    id: 'eftpos',
    title: 'EFTPOS signal',
    detail: 'Tender proof only; itemised receipts still come from POS data.',
    icon: RadioTower,
    tone: 'var(--accent-primary)',
  },
];

// Web NFC (NDEFReader) is experimental and Android-Chrome only; presence does not
// change at runtime, so a module-level const keeps the check out of render.
const nfcSupported = typeof window !== 'undefined' && 'NDEFReader' in window;

// Narrows the unknown NFC failure to a friendly message without any `any`.
function nfcErrorMessage(err: unknown): string {
  if (err instanceof DOMException) {
    if (err.name === 'AbortError')
      return 'Tag not detected — hold the tag to the phone and try again.';
    if (err.name === 'NotAllowedError')
      return 'NFC permission denied. Allow NFC and tap the button again.';
    if (err.name === 'NotSupportedError') return 'This tag type is not supported.';
  }
  if (err instanceof Error) return err.message;
  return 'NFC operation failed.';
}

const pipeline = [
  { title: 'Capture', detail: 'Pass, tag, POS, email, or photo', icon: Nfc },
  { title: 'Normalize', detail: 'Merchant, total, GST, line items', icon: ReceiptText },
  { title: 'Classify', detail: 'Business, personal, project, job', icon: Route },
  { title: 'Decide', detail: 'Deductible, flagged, or review', icon: ShieldCheck },
  { title: 'Sync', detail: 'Xero, MYOB, QuickBooks, API', icon: Webhook },
];

const businessInstallChecks = [
  'POS webhook/API, vendor plugin, cloud connector, or Looplet bridge installed',
  'Node.js 20+ for the local bridge, or an equivalent connector runtime',
  'Outbound HTTPS access to the Looplet Supabase functions endpoint',
  'Local bridge scheduled task enabled with healthy run logs',
  'Scoped POS API key with write:receipts stored outside source code',
  'Stable POS receipt/payment event id used as the Idempotency-Key',
  'Customer-scanned Looplet identity_token captured on each receipt',
  'Site manifest records POS merchant_name, identity capture method, completed POS trigger, source format, and field capture method',
  'Integration profile passes integration-fit.mjs and proves the POS path is not EFTPOS-only',
  'Final itemised sale/refund/void payloads include GST, subtotal, total, payment reference, and refund/void original sale references',
];

const pilotEvidenceChecks = [
  'Run readiness and credential probe without storing a receipt',
  'Keep pos-integration-profile.json for --fit-profile and archive pos-integration-fit.json as the fit result',
  'Capture real POS sale, refund, and void field samples from the business',
  'Run acceptance with duplicate retry, refund/void linking, and negative controls',
  'Connector mode, receipt source format, and field capture method match before any acceptance send',
  'Refund and void field samples point back to the sale field sample before any acceptance send',
  'Run go-live.mjs with --fit-profile pos-integration-profile.json for acceptance plus strict verification with original POS files',
  'Verifier field-file reconciliation matches redacted and identity-stripped fingerprints',
];

export function ReceiptHubPage() {
  const { currentOrg } = useOrg();
  const [activeChannel, setActiveChannel] = useState<CaptureChannel>('phone-pass');

  const [events, setEvents] = useState<ReceiptEventRow[]>([]);
  const [syncJobs, setSyncJobs] = useState<ReceiptSyncJobRow[]>([]);
  const [identities, setIdentities] = useState<ReceiptIdentityRow[]>([]);
  const [identityCount, setIdentityCount] = useState(0);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [detailEventId, setDetailEventId] = useState<string | null>(null);
  const [detailLines, setDetailLines] = useState<ReceiptLineItemRow[]>([]);
  const [detailAudit, setDetailAudit] = useState<ReceiptAuditPackageRow | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [attaching, setAttaching] = useState(false);
  const [manualMerchant, setManualMerchant] = useState('');
  const [manualTotal, setManualTotal] = useState('');
  const [manualGst, setManualGst] = useState('');
  const [manualDate, setManualDate] = useState('');
  const [manualJobRef, setManualJobRef] = useState('');
  const [manualSubmitting, setManualSubmitting] = useState(false);
  const [manualMessage, setManualMessage] = useState<string | null>(null);
  const [photoUploading, setPhotoUploading] = useState(false);
  const [photoMessage, setPhotoMessage] = useState<string | null>(null);
  const [identityToken, setIdentityToken] = useState<string | null>(null);
  const [tagWriting, setTagWriting] = useState(false);
  const [tagScanning, setTagScanning] = useState(false);
  const [tagMessage, setTagMessage] = useState<string | null>(null);
  const [tagError, setTagError] = useState<string | null>(null);
  const [bridgeEnv, setBridgeEnv] = useState<string | null>(null);
  const [bridgeApiKeyPrefix, setBridgeApiKeyPrefix] = useState<string | null>(null);
  const [bridgeIdentityPrefix, setBridgeIdentityPrefix] = useState<string | null>(null);
  const [dispatchMessage, setDispatchMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [issuing, setIssuing] = useState(false);
  const [provisioningBridge, setProvisioningBridge] = useState(false);
  const [dispatching, setDispatching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const channel = useMemo(
    () => channels.find((item) => item.id === activeChannel) ?? defaultChannel,
    [activeChannel],
  );
  const ActiveIcon = channel.icon;

  const coreStatus = useMemo(() => {
    const latestEvent = events[0] ?? null;
    const failed = syncJobs.filter((job) => job.status === 'failed').length;
    const synced = syncJobs.filter((job) => job.status === 'synced').length;
    const queued = syncJobs.length - failed - synced;
    return {
      identityCount,
      latestEventAt: latestEvent?.purchase_at ?? null,
      latestMerchant: latestEvent?.merchant_name ?? null,
      eventCount: events.length,
      syncSynced: synced,
      syncQueued: queued,
      syncFailed: failed,
    };
  }, [events, syncJobs, identityCount]);

  const detailEvent = useMemo(
    () => events.find((event) => event.id === detailEventId) ?? null,
    [events, detailEventId],
  );

  const refreshReceiptHub = useCallback(async () => {
    if (!currentOrg) {
      setEvents([]);
      setSyncJobs([]);
      setIdentities([]);
      setIdentityCount(0);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    const [identityRes, eventRes, syncRes] = await Promise.all([
      supabase
        .from('receipt_identities')
        .select('id,label,channel,token_prefix,status,last_used_at,created_at', {
          count: 'exact',
        })
        .eq('organization_id', currentOrg.id)
        .order('created_at', { ascending: false })
        .limit(6),
      supabase
        .from('receipt_events')
        .select(
          'id,bill_id,related_receipt_event_id,event_type,merchant_name,receipt_number,purchase_at,source_channel,status,business_use,deductibility_status,gst_cents,total_inc_gst_cents,payment_method,payment_last4,payment_reference,terminal_id,store_id',
        )
        .eq('organization_id', currentOrg.id)
        .order('created_at', { ascending: false })
        .limit(8),
      supabase
        .from('receipt_sync_jobs')
        .select('id,receipt_event_id,bill_id,provider,status,last_error,created_at')
        .eq('organization_id', currentOrg.id)
        .order('created_at', { ascending: false })
        .limit(8),
    ]);

    const firstError = identityRes.error ?? eventRes.error ?? syncRes.error;
    if (firstError) {
      setError(firstError.message);
      setLoading(false);
      return;
    }

    setEvents((eventRes.data ?? []) as ReceiptEventRow[]);
    setSyncJobs((syncRes.data ?? []) as ReceiptSyncJobRow[]);
    setIdentities((identityRes.data ?? []) as ReceiptIdentityRow[]);
    setIdentityCount(identityRes.count ?? 0);
    setLoading(false);
  }, [currentOrg]);

  useEffect(() => {
    void refreshReceiptHub();
  }, [refreshReceiptHub]);

  useEffect(() => {
    if (!currentOrg) return;
    const channel = supabase
      .channel(`receipt-events-${currentOrg.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'receipt_events',
          filter: `organization_id=eq.${currentOrg.id}`,
        },
        () => {
          void refreshReceiptHub();
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [currentOrg, refreshReceiptHub]);

  const issueIdentity = useCallback(async (): Promise<string | null> => {
    if (!currentOrg) {
      setError('Pick an organisation before issuing a receipt identity.');
      return null;
    }

    setIssuing(true);
    setError(null);
    const { data, error: rpcError } = await supabase.rpc('issue_receipt_identity', {
      p_organization_id: currentOrg.id,
      p_label: channel.title,
      p_channel: activeChannel,
    });
    setIssuing(false);

    if (rpcError) {
      const schemaCacheMiss =
        rpcError.message.toLowerCase().includes('schema cache') ||
        rpcError.message.toLowerCase().includes('could not find the function');
      setError(
        schemaCacheMiss
          ? 'Receipt Hub database migration is not applied yet, or Supabase needs a schema-cache reload for issue_receipt_identity.'
          : rpcError.message,
      );
      return null;
    }

    const rows = Array.isArray(data) ? data : [data];
    const issued = rows[0] as IdentityRpcRow | null | undefined;
    if (!issued?.receipt_token) {
      setError('Receipt identity was not returned by the database.');
      return null;
    }

    setIdentityToken(issued.receipt_token);
    await refreshReceiptHub();
    return issued.receipt_token;
  }, [activeChannel, channel.title, currentOrg, refreshReceiptHub]);

  // Receipt Tag — write the current rhp_ token to a tapped blank tag. If no pass
  // has been issued yet, issue one first (same pattern the capture flows use).
  const programTag = useCallback(async () => {
    if (!nfcSupported) return;
    setTagError(null);
    setTagMessage(null);

    let token = identityToken;
    if (!token) {
      token = await issueIdentity();
    }
    if (!token) {
      setTagError('Issue a receipt pass first, then tap a blank tag to program it.');
      return;
    }

    setTagWriting(true);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const reader = new NDEFReader();
      await reader.write(
        { records: [{ recordType: 'text', data: token, encoding: 'utf-8', lang: 'en' }] },
        { signal: controller.signal },
      );
      setTagMessage('Tag programmed. Tap it at the counter to identify yourself.');
    } catch (err) {
      setTagError(nfcErrorMessage(err));
    } finally {
      clearTimeout(timeout);
      controller.abort();
      setTagWriting(false);
    }
  }, [identityToken, issueIdentity]);

  // Receipt Tag — scan a programmed tag, validate the rhp_<…>.<…> shape (same
  // check the webhook's resolveReceiptIdentity uses), and reuse it as the pass.
  const tapToIdentify = useCallback(async () => {
    if (!nfcSupported) return;
    setTagError(null);
    setTagMessage(null);
    setTagScanning(true);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);

    const cleanup = () => {
      clearTimeout(timeout);
      controller.abort();
      setTagScanning(false);
    };

    let detach: (() => void) | undefined;
    try {
      const reader = new NDEFReader();
      const readPromise = new Promise<void>((resolve, reject) => {
        function finish() {
          reader.removeEventListener('reading', onReading);
          controller.signal.removeEventListener('abort', onAbort);
        }

        function onAbort() {
          finish();
          reject(new DOMException('Tag not detected.', 'AbortError'));
        }

        function onReading(event: NDEFReadingEvent) {
          for (const record of event.message.records) {
            if (record.recordType !== 'text' || !record.data) continue;
            const decoder = new TextDecoder(record.encoding ?? 'utf-8');
            const value = decoder.decode(record.data).trim();
            if (value.startsWith('rhp_') && value.includes('.')) {
              setIdentityToken(value);
              setTagMessage('Tag identified. Capture a receipt and it will use this pass.');
              finish();
              resolve();
              return;
            }
          }
          finish();
          reject(new Error('That tag is not a Looplet Receipt Tag.'));
        }

        detach = finish;
        reader.addEventListener('reading', onReading);
        controller.signal.addEventListener('abort', onAbort, { once: true });
      });
      await reader.scan({ signal: controller.signal });
      await readPromise;
    } catch (err) {
      detach?.();
      setTagError(nfcErrorMessage(err));
    } finally {
      cleanup();
    }
  }, []);

  const revokeIdentity = useCallback(
    async (identityId: string) => {
      if (!currentOrg) return;
      setRevokingId(identityId);
      setError(null);
      const { error: updateError } = await supabase
        .from('receipt_identities')
        .update({ status: 'revoked', revoked_at: new Date().toISOString() })
        .eq('id', identityId)
        .eq('organization_id', currentOrg.id);
      setRevokingId(null);
      if (updateError) {
        setError(updateError.message);
        return;
      }
      await refreshReceiptHub();
    },
    [currentOrg, refreshReceiptHub],
  );

  const openEventDetail = useCallback(
    async (eventId: string) => {
      if (!currentOrg) return;
      setDetailEventId(eventId);
      setDetailLines([]);
      setDetailAudit(null);
      setDetailError(null);
      setDetailLoading(true);
      const [lineRes, auditRes] = await Promise.all([
        supabase
          .from('receipt_event_line_items')
          .select(
            'id,line_number,description,quantity,unit_price_cents,total_inc_gst_cents,gst_cents,category',
          )
          .eq('organization_id', currentOrg.id)
          .eq('receipt_event_id', eventId)
          .order('line_number', { ascending: true }),
        supabase
          .from('receipt_audit_packages')
          .select('id,bill_id,gst_status,deductibility_status,decision_path,storage_key')
          .eq('organization_id', currentOrg.id)
          .eq('receipt_event_id', eventId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);
      setDetailLoading(false);
      const firstError = lineRes.error ?? auditRes.error;
      if (firstError) {
        setDetailError(firstError.message);
        return;
      }
      setDetailLines((lineRes.data ?? []) as ReceiptLineItemRow[]);
      setDetailAudit((auditRes.data ?? null) as ReceiptAuditPackageRow | null);
    },
    [currentOrg],
  );

  const closeEventDetail = useCallback(() => {
    setDetailEventId(null);
    setDetailLines([]);
    setDetailAudit(null);
    setDetailError(null);
  }, []);

  const attachEventToJob = useCallback(
    async (billId: string, jobId: string) => {
      setAttaching(true);
      setDetailError(null);
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (!session) throw new Error('Not signed in');
        const response = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/bills-attach`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${session.access_token}`,
            },
            body: JSON.stringify({ bill_id: billId, job_id: jobId }),
          },
        );
        const body = (await response.json()) as { ok?: boolean; error?: string };
        if (!response.ok || !body.ok) {
          throw new Error(body.error ?? `Attach failed (${response.status})`);
        }
        await refreshReceiptHub();
      } catch (err) {
        setDetailError(err instanceof Error ? err.message : String(err));
      } finally {
        setAttaching(false);
      }
    },
    [refreshReceiptHub],
  );

  const provisionPosBridge = useCallback(async () => {
    if (!currentOrg) {
      setError('Pick an organisation before provisioning the POS bridge.');
      return;
    }

    setProvisioningBridge(true);
    setBridgeEnv(null);
    setBridgeApiKeyPrefix(null);
    setBridgeIdentityPrefix(null);
    setError(null);

    try {
      const identityRes = await supabase.rpc('issue_receipt_identity', {
        p_organization_id: currentOrg.id,
        p_label: 'POS receipt bridge',
        p_channel: 'pos',
      });

      if (identityRes.error) {
        const schemaCacheMiss =
          identityRes.error.message.toLowerCase().includes('schema cache') ||
          identityRes.error.message.toLowerCase().includes('could not find the function');
        throw new Error(
          schemaCacheMiss
            ? 'Receipt Hub database migrations are not applied yet, or Supabase needs a schema-cache reload for the setup RPCs.'
            : identityRes.error.message,
        );
      }

      const apiKeyRes = await supabase.rpc('issue_api_key', {
        p_organization_id: currentOrg.id,
        p_name: 'POS receipt bridge',
        p_scopes: ['write:receipts'],
        p_expires_at: null,
        p_rate_limit_per_min: 120,
      });

      if (apiKeyRes.error) {
        const schemaCacheMiss =
          apiKeyRes.error.message.toLowerCase().includes('schema cache') ||
          apiKeyRes.error.message.toLowerCase().includes('could not find the function');
        throw new Error(
          schemaCacheMiss
            ? 'Receipt Hub database migrations are not applied yet, or Supabase needs a schema-cache reload for the setup RPCs.'
            : apiKeyRes.error.message,
        );
      }

      const apiKeyRows = Array.isArray(apiKeyRes.data) ? apiKeyRes.data : [apiKeyRes.data];
      const identityRows = Array.isArray(identityRes.data) ? identityRes.data : [identityRes.data];
      const apiKey = apiKeyRows[0] as ApiKeyRpcRow | null | undefined;
      const identity = identityRows[0] as IdentityRpcRow | null | undefined;

      if (!apiKey?.api_key || !apiKey.key_prefix) {
        throw new Error('POS API key was not returned by the database.');
      }
      if (!identity?.receipt_token) {
        throw new Error('POS receipt identity was not returned by the database.');
      }

      const env = buildPosBridgeEnv({
        supabaseUrl: import.meta.env.VITE_SUPABASE_URL,
        apiKey: apiKey.api_key,
        receiptIdentityToken: identity.receipt_token,
      });

      setIdentityToken(identity.receipt_token);
      setBridgeApiKeyPrefix(apiKey.key_prefix);
      setBridgeIdentityPrefix(identity.token_prefix || loopletSecretPrefix(identity.receipt_token));
      setBridgeEnv(env);
      await refreshReceiptHub();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setProvisioningBridge(false);
    }
  }, [currentOrg, refreshReceiptHub]);

  const dispatchSyncQueue = async () => {
    if (!currentOrg) {
      setError('Pick an organisation before dispatching receipt sync.');
      return;
    }

    setDispatching(true);
    setError(null);
    setDispatchMessage(null);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in');
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/receipt-sync-dispatch`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            organization_id: currentOrg.id,
            limit: 10,
          }),
        },
      );
      const body = (await response.json()) as {
        ok?: boolean;
        error?: string;
        processed?: number;
        results?: { status: string }[];
      };
      if (!response.ok || !body.ok) throw new Error(body.error ?? 'Receipt sync dispatch failed');

      const synced = body.results?.filter((item) => item.status === 'synced').length ?? 0;
      const failed = body.results?.filter((item) => item.status === 'failed').length ?? 0;
      setDispatchMessage(
        `${body.processed ?? 0} jobs processed · ${synced} synced · ${failed} failed`,
      );
      await refreshReceiptHub();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDispatching(false);
    }
  };

  const submitManualCapture = async (e: FormEvent) => {
    e.preventDefault();
    if (!currentOrg) {
      setManualMessage('Pick an organisation before capturing a receipt.');
      return;
    }
    const totalDollars = Number.parseFloat(manualTotal);
    if (!manualMerchant.trim() || !Number.isFinite(totalDollars) || totalDollars <= 0) {
      setManualMessage('Enter a merchant and a positive total.');
      return;
    }
    setManualSubmitting(true);
    setManualMessage(null);
    setError(null);
    try {
      let token = identityToken;
      if (!token) {
        token = await issueIdentity();
        if (!token) throw new Error('Receipt identity could not be issued.');
      }
      const totalCents = Math.round(totalDollars * 100);
      // Only the GST printed on the receipt. A blank field means GST unknown: the receipt is
      // recorded for review and no GST credit is assumed.
      const gstDollars = Number.parseFloat(manualGst);
      const gstCents = Number.isFinite(gstDollars) ? Math.round(gstDollars * 100) : null;
      const purchaseAt = manualDate ? new Date(manualDate).toISOString() : new Date().toISOString();
      const receiptNumber = `MAN-${Date.now().toString().slice(-8)}`;
      const payload = buildManualReceiptPayload({
        merchant: manualMerchant.trim(),
        totalCents,
        gstCents,
        purchaseAt,
        receiptNumber,
        jobReference: manualJobRef.trim(),
        organizationId: currentOrg.id,
      });
      const result = await postReceiptWebhook({
        organizationId: currentOrg.id,
        identityToken: token,
        idempotencyKey: `manual:${receiptNumber}`,
        sourceChannel: 'epost',
        payload,
      });
      setManualMessage(`Captured receipt event ${result.receipt_event_id.slice(0, 8)}.`);
      setManualMerchant('');
      setManualTotal('');
      setManualGst('');
      setManualDate('');
      setManualJobRef('');
      await refreshReceiptHub();
    } catch (err) {
      setManualMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setManualSubmitting(false);
    }
  };

  const captureFromPhoto = async (file: File) => {
    if (!currentOrg) {
      setPhotoMessage('Pick an organisation before uploading a receipt.');
      return;
    }
    const allowed = new Set([
      'application/pdf',
      'image/png',
      'image/jpeg',
      'image/jpg',
      'image/heic',
      'image/webp',
    ]);
    if (!allowed.has(file.type)) {
      setPhotoMessage(
        `Unsupported file type: ${file.type || 'unknown'}. Use PDF, PNG, JPG, HEIC, or WEBP.`,
      );
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      setPhotoMessage('File too large (max 25 MB).');
      return;
    }
    setPhotoUploading(true);
    setPhotoMessage('Uploading…');
    setError(null);
    try {
      // 1. Store the original file (provenance) in the bills bucket.
      const today = todayLocal(orgTimeZone(currentOrg));
      const rand = crypto.randomUUID().slice(0, 8);
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80);
      const storageKey = `org-${currentOrg.id}/${today}/${rand}-${safeName}`;
      const { error: uploadErr } = await supabase.storage.from('bills').upload(storageKey, file, {
        contentType: file.type,
        cacheControl: '3600',
        upsert: false,
      });
      if (uploadErr) throw new Error(`Upload failed: ${uploadErr.message}`);

      // 2. OCR the stored file WITHOUT creating a bill (extract_only) — the
      //    receipt-webhook owns the single bill the structured payload creates.
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in');
      setPhotoMessage('Reading receipt…');
      const extractRes = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/bills-extract`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            extract_only: true,
            storage_key: storageKey,
            mime_type: file.type,
            organization_id: currentOrg.id,
          }),
        },
      );
      const extractBody = (await extractRes.json()) as {
        ok?: boolean;
        error?: string;
        extracted?: ExtractedBillData;
      };
      if (!extractRes.ok || !extractBody.ok || !extractBody.extracted) {
        throw new Error(extractBody.error ?? `OCR failed (${extractRes.status})`);
      }

      // 3. Issue an identity if needed, then feed the OCR result into the webhook.
      let token = identityToken;
      if (!token) {
        token = await issueIdentity();
        if (!token) throw new Error('Receipt identity could not be issued.');
      }
      setPhotoMessage('Creating receipt…');
      const payload = buildReceiptPayloadFromExtraction(
        extractBody.extracted,
        currentOrg.id,
        storageKey,
      );
      const result = await postReceiptWebhook({
        organizationId: currentOrg.id,
        identityToken: token,
        idempotencyKey: `photo:${storageKey}`,
        sourceChannel: 'photo',
        payload,
      });
      setPhotoMessage(`Captured receipt event ${result.receipt_event_id.slice(0, 8)}.`);
      await refreshReceiptHub();
    } catch (err) {
      setPhotoMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setPhotoUploading(false);
    }
  };

  return (
    <section className="receipt-hub-page animated-fade-in">
      <div className="receipt-hub-hero">
        <div>
          <div className="receipt-hub-kicker">
            <ReceiptText size={16} />
            Receipt app MVP
          </div>
          <h1>Receipt Hub</h1>
          <p>
            The first stage is a phone-first receipt identity layer: tap, scan, or pass a token at
            checkout, then let the merchant/POS send a structured receipt into Looplet.
          </p>
          <div className="receipt-hub-actions">
            <button
              className="btn btn-primary"
              onClick={() => void issueIdentity()}
              disabled={!currentOrg || issuing}
            >
              {issuing ? <Loader2 size={16} className="spin" /> : <WalletCards size={16} />}
              {issuing ? 'Generating' : 'Generate pass'}
            </button>
          </div>
          {error ? (
            <div className="receipt-alert" role="alert">
              {error}
            </div>
          ) : null}
        </div>

        <div className="receipt-flow-panel" aria-label="Receipt pass">
          {identityToken ? (
            <ReceiptIdentityPass token={identityToken} />
          ) : (
            <div className="receipt-empty">
              No pass on screen yet. Generate a pass, then show its barcode at the counter so the
              POS can attach it to your itemised receipt.
            </div>
          )}
        </div>
      </div>

      <div className="receipt-channel-strip">
        {channels.map((item) => {
          const Icon = item.icon;
          const selected = item.id === activeChannel;
          return (
            <button
              key={item.id}
              type="button"
              className={selected ? 'receipt-channel is-active' : 'receipt-channel'}
              onClick={() => setActiveChannel(item.id)}
              style={{ '--channel-color': item.tone } as CSSProperties}
            >
              <Icon size={18} />
              <span>{item.title}</span>
            </button>
          );
        })}
      </div>

      <div className="receipt-grid">
        <section className="receipt-flow-panel">
          <div className="receipt-panel-heading">
            <ActiveIcon size={18} style={{ color: channel.tone }} />
            <div>
              <span>Best first connection</span>
              <h2>{channel.title}</h2>
            </div>
          </div>
          <p>
            Start with a Looplet Receipt Pass token and POS webhook. NFC behaves like the Rewards
            tap, but receipt extraction happens through the merchant event, not by reading a payment
            card.
          </p>
          <div className="receipt-signal-row">
            <span>
              <CreditCard size={14} /> Pay
            </span>
            <i />
            <span>
              <Nfc size={14} /> Identify
            </span>
            <i />
            <span>
              <ReceiptText size={14} /> Receive
            </span>
            <i />
            <span>
              <CheckCircle size={14} /> Classify
            </span>
          </div>
        </section>

        <section className="receipt-flow-panel">
          <div className="receipt-panel-heading">
            <ShieldCheck size={18} style={{ color: 'var(--accent-success)' }} />
            <div>
              <span>Stage 1 live state</span>
              <h2>Receipt machine core</h2>
            </div>
          </div>
          {loading ? (
            <div className="receipt-loading">
              <Loader2 size={16} className="spin" /> Loading receipt state
            </div>
          ) : (
            <dl className="receipt-core-status">
              <div className="receipt-core-metric">
                <dt>Receipt identities</dt>
                <dd>{coreStatus.identityCount}</dd>
              </div>
              <div className="receipt-core-metric">
                <dt>Latest receipt</dt>
                <dd>
                  {coreStatus.latestEventAt ? (
                    <>
                      {formatReceiptTime(coreStatus.latestEventAt)}
                      {coreStatus.latestMerchant ? (
                        <small> · {coreStatus.latestMerchant}</small>
                      ) : null}
                    </>
                  ) : (
                    'No receipts yet'
                  )}
                </dd>
              </div>
              <div className="receipt-core-metric">
                <dt>Recent sync jobs</dt>
                <dd>
                  {syncJobs.length === 0 ? (
                    'None queued'
                  ) : (
                    <>
                      {coreStatus.syncSynced} synced · {coreStatus.syncQueued} queued ·{' '}
                      <span
                        style={
                          coreStatus.syncFailed > 0
                            ? { color: 'var(--accent-danger, var(--text-danger))' }
                            : undefined
                        }
                      >
                        {coreStatus.syncFailed} failed
                      </span>
                    </>
                  )}
                </dd>
              </div>
            </dl>
          )}
        </section>

        <section className="receipt-flow-panel">
          <div className="receipt-panel-heading">
            <KeyRound size={18} style={{ color: 'var(--accent-info)' }} />
            <div>
              <span>Issued identities</span>
              <h2>Receipt Pass tokens</h2>
            </div>
          </div>
          {loading ? (
            <div className="receipt-loading">
              <Loader2 size={16} className="spin" /> Loading identities
            </div>
          ) : identities.length === 0 ? (
            <div className="receipt-empty">No receipt identities issued yet.</div>
          ) : (
            <div className="receipt-identity-list">
              {identities.map((identity) => {
                const revoked = identity.status === 'revoked';
                return (
                  <div className="receipt-identity-row" key={identity.id}>
                    <div className="receipt-identity-meta">
                      <strong>{identity.label || 'Receipt identity'}</strong>
                      <small>
                        {identity.channel ?? 'unknown'} ·{' '}
                        {identity.token_prefix ? `${identity.token_prefix}…` : 'no prefix'} ·{' '}
                        {identity.last_used_at
                          ? `used ${formatReceiptTime(identity.last_used_at)}`
                          : 'never used'}
                      </small>
                    </div>
                    <span
                      className="receipt-identity-status"
                      style={revoked ? { color: 'var(--text-muted)' } : undefined}
                    >
                      {identity.status}
                    </span>
                    <button
                      type="button"
                      className="receipt-panel-action"
                      onClick={() => void revokeIdentity(identity.id)}
                      disabled={revoked || revokingId === identity.id}
                    >
                      {revokingId === identity.id ? <Loader2 size={14} className="spin" /> : null}
                      {revoked ? 'Revoked' : 'Revoke'}
                    </button>
                  </div>
                );
              })}
              {identityCount > identities.length ? (
                <small className="receipt-identity-more">
                  Showing {identities.length} of {identityCount} identities.
                </small>
              ) : null}
            </div>
          )}
        </section>

        <section className="receipt-flow-panel receipt-bridge-setup-panel">
          <div className="receipt-panel-heading">
            <Nfc size={18} style={{ color: 'var(--accent-info)' }} />
            <div>
              <span>Tap to identify</span>
              <h2>Receipt Tag</h2>
            </div>
          </div>
          <p>
            Carry your receipt pass on a $0.20 NFC tag — like a gym fob. It is an identity, not a
            payment card: a lost tag is harmless and can be revoked above. Program a blank tag with
            your current pass, then tap it to identify yourself for the next capture.
          </p>

          {nfcSupported ? (
            <div className="receipt-tag-actions">
              <button
                type="button"
                className="receipt-panel-action receipt-panel-action-info"
                onClick={() => void programTag()}
                disabled={!currentOrg || tagWriting || tagScanning || issuing}
              >
                {tagWriting ? <Loader2 size={14} className="spin" /> : <Nfc size={14} />}
                {tagWriting ? 'Hold tag to phone' : 'Program tag'}
              </button>
              <button
                type="button"
                className="receipt-panel-action receipt-panel-action-info"
                onClick={() => void tapToIdentify()}
                disabled={tagWriting || tagScanning}
              >
                {tagScanning ? <Loader2 size={14} className="spin" /> : <ScanLine size={14} />}
                {tagScanning ? 'Tap a tag…' : 'Tap to identify'}
              </button>
            </div>
          ) : (
            <div className="receipt-tag-fallback">
              Tap-to-tag needs Android Chrome. On iPhone or desktop, use the scannable barcode pass
              shown after “Generate pass”.
            </div>
          )}

          {tagMessage ? <div className="receipt-tag-message">{tagMessage}</div> : null}
          {tagError ? (
            <div className="receipt-alert" role="alert">
              {tagError}
            </div>
          ) : null}
        </section>

        <section className="receipt-flow-panel receipt-bridge-setup-panel">
          <div className="receipt-panel-heading">
            <KeyRound size={18} style={{ color: 'var(--accent-info)' }} />
            <div>
              <span>Business install</span>
              <h2>POS bridge setup</h2>
            </div>
            <button
              type="button"
              className="receipt-panel-action receipt-panel-action-info"
              onClick={() => void provisionPosBridge()}
              disabled={!currentOrg || provisioningBridge}
            >
              {provisioningBridge ? <Loader2 size={14} className="spin" /> : <KeyRound size={14} />}
              Generate config
            </button>
          </div>
          <p>
            Use this when the POS cannot call Looplet directly. It creates the scoped
            `write:receipts` API key and a fallback/readiness receipt identity token; production POS
            exports should include the customer's scanned Looplet identity per receipt.
          </p>
          <div className="receipt-bridge-endpoint">
            <span>Webhook endpoint</span>
            <code>{receiptWebhookUrlFromSupabaseUrl(import.meta.env.VITE_SUPABASE_URL)}</code>
          </div>
          <div className="receipt-ops-grid" aria-label="POS pilot readiness">
            <div className="receipt-ops-panel">
              <div className="receipt-ops-heading">
                <Store size={16} />
                <strong>Business side must have</strong>
              </div>
              <ul>
                {businessInstallChecks.map((check) => (
                  <li key={check}>{check}</li>
                ))}
              </ul>
            </div>
            <div className="receipt-ops-panel">
              <div className="receipt-ops-heading">
                <FileCheck2 size={16} />
                <strong>Go-live evidence must prove</strong>
              </div>
              <ul>
                {pilotEvidenceChecks.map((check) => (
                  <li key={check}>{check}</li>
                ))}
              </ul>
              <p>
                EFTPOS-only data can confirm payment, but Looplet still needs the POS basket,
                receipt lines, GST split, and scanned customer identity.
              </p>
            </div>
          </div>
          {bridgeEnv ? (
            <div className="receipt-env-panel">
              <div className="receipt-env-heading">
                <span>Save once</span>
                <strong>
                  Key {bridgeApiKeyPrefix} · Identity {bridgeIdentityPrefix}
                </strong>
              </div>
              <pre>{bridgeEnv}</pre>
            </div>
          ) : (
            <div className="receipt-empty">
              Generate config after the bridge package is installed on the POS/back-office machine,
              then save it into the installer-created protected env file. The API secret is only
              visible immediately after creation.
            </div>
          )}
        </section>
      </div>

      <div className="receipt-live-grid">
        <section className="receipt-flow-panel">
          <div className="receipt-panel-heading">
            <ReceiptText size={18} style={{ color: 'var(--accent-success)' }} />
            <div>
              <span>Manual capture (epost)</span>
              <h2>Type a receipt in</h2>
            </div>
          </div>
          <form className="receipt-manual-form" onSubmit={(e) => void submitManualCapture(e)}>
            <label>
              <span>Merchant</span>
              <input
                type="text"
                value={manualMerchant}
                onChange={(e) => setManualMerchant(e.target.value)}
                placeholder="Supplier or store name"
                disabled={manualSubmitting}
                required
              />
            </label>
            <div className="receipt-manual-row">
              <label>
                <span>Total (inc GST)</span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={manualTotal}
                  onChange={(e) => setManualTotal(e.target.value)}
                  placeholder="360.00"
                  disabled={manualSubmitting}
                  required
                />
              </label>
              <label>
                <span>GST shown on receipt</span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={manualGst}
                  onChange={(e) => setManualGst(e.target.value)}
                  placeholder="as shown"
                  aria-describedby="receipt-manual-gst-help"
                  disabled={manualSubmitting}
                />
              </label>
            </div>
            <small
              id="receipt-manual-gst-help"
              style={{ color: 'var(--text-muted)', fontSize: '0.76rem', lineHeight: 1.45 }}
            >
              Enter 0 if there is no GST (GST-free, or the supplier isn't registered for GST). Leave
              it blank if the receipt doesn't show GST: it is saved for review and no GST credit is
              claimed.
            </small>
            <div className="receipt-manual-row">
              <label>
                <span>Date</span>
                <input
                  type="date"
                  value={manualDate}
                  onChange={(e) => setManualDate(e.target.value)}
                  disabled={manualSubmitting}
                />
              </label>
              <label>
                <span>Job reference (optional)</span>
                <input
                  type="text"
                  value={manualJobRef}
                  onChange={(e) => setManualJobRef(e.target.value)}
                  placeholder="JOB-1024"
                  disabled={manualSubmitting}
                />
              </label>
            </div>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={!currentOrg || manualSubmitting}
            >
              {manualSubmitting ? (
                <Loader2 size={16} className="spin" />
              ) : (
                <ReceiptText size={16} />
              )}
              {manualSubmitting ? 'Capturing' : 'Capture receipt'}
            </button>
            {manualMessage ? (
              <div className="receipt-result" role="status">
                <FileCheck2 size={16} />
                <span>{manualMessage}</span>
              </div>
            ) : null}
          </form>

          <div className="receipt-photo-capture">
            <label className="btn btn-secondary receipt-photo-button">
              {photoUploading ? <Loader2 size={16} className="spin" /> : <ReceiptText size={16} />}
              {photoUploading ? 'Reading photo' : 'Upload receipt photo / PDF'}
              <input
                type="file"
                accept="application/pdf,image/png,image/jpeg,image/jpg,image/heic,image/webp"
                disabled={!currentOrg || photoUploading}
                style={{ display: 'none' }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void captureFromPhoto(file);
                }}
              />
            </label>
            <small>OCR reads merchant, total, GST and line items, then files the receipt.</small>
            {photoMessage ? (
              <div className="receipt-result" role="status">
                <FileCheck2 size={16} />
                <span>{photoMessage}</span>
              </div>
            ) : null}
          </div>
        </section>

        <section className="receipt-flow-panel">
          <div className="receipt-panel-heading">
            <ReceiptText size={18} style={{ color: 'var(--accent-info)' }} />
            <div>
              <span>Mobile capture to bills</span>
              <h2>Recent receipt events</h2>
            </div>
          </div>
          <div className="receipt-table" aria-label="Recent receipt events">
            {loading ? (
              <div className="receipt-loading">
                <Loader2 size={16} className="spin" /> Loading receipt events
              </div>
            ) : events.length === 0 ? (
              <div className="receipt-empty">
                No receipts captured yet. Type one in, upload a photo or PDF, or connect a POS with
                the bridge setup above.
              </div>
            ) : (
              events.map((event) => {
                const eventType = event.event_type ?? 'sale';
                const paymentLabel = paymentDescriptor(event);
                const provenance = [event.store_id, event.terminal_id].filter(Boolean).join(' · ');
                return (
                  <button
                    type="button"
                    className={`receipt-table-row receipt-table-row-button receipt-event-${eventType} ${event.id === detailEventId ? 'is-active' : ''}`}
                    key={event.id}
                    onClick={() => void openEventDetail(event.id)}
                  >
                    <div>
                      <strong>
                        <span className={`receipt-event-chip ${eventType}`}>{eventType}</span>
                        {event.merchant_name}
                      </strong>
                      <span>
                        {event.receipt_number ?? event.id.slice(0, 8)} · {event.source_channel}
                      </span>
                      {event.related_receipt_event_id ? (
                        <span>Original {event.related_receipt_event_id.slice(0, 8)}</span>
                      ) : null}
                    </div>
                    <div>
                      <strong>{formatMoney(event.total_inc_gst_cents)}</strong>
                      <span>GST {formatReceiptGst(event.gst_cents)}</span>
                      {paymentLabel ? <span>{paymentLabel}</span> : null}
                    </div>
                    <div>
                      <strong>{event.status.replaceAll('_', ' ')}</strong>
                      <span>
                        {event.bill_id ? `Bill ${event.bill_id.slice(0, 8)}` : event.business_use}
                      </span>
                      {event.payment_reference ? <span>Ref {event.payment_reference}</span> : null}
                      {provenance ? <span>{provenance}</span> : null}
                      {!event.payment_reference && !provenance ? (
                        <span>{event.deductibility_status.replaceAll('_', ' ')}</span>
                      ) : null}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </section>

        <section className="receipt-flow-panel">
          <div className="receipt-panel-heading">
            <DatabaseZap size={18} style={{ color: 'var(--accent-warning)' }} />
            <div>
              <span>Accounting sync</span>
              <h2>Xero, MYOB, QuickBooks queue</h2>
            </div>
            <button
              type="button"
              className="receipt-panel-action"
              onClick={() => void dispatchSyncQueue()}
              disabled={!currentOrg || dispatching || syncJobs.length === 0}
            >
              {dispatching ? <Loader2 size={14} className="spin" /> : <PlugZap size={14} />}
              Dispatch
            </button>
          </div>
          <div className="receipt-sync-list">
            {loading ? (
              <div className="receipt-loading">
                <Loader2 size={16} className="spin" /> Loading sync queue
              </div>
            ) : syncJobs.length === 0 ? (
              <div className="receipt-empty">No provider jobs queued yet.</div>
            ) : (
              syncJobs.map((job) => {
                const unsupported = job.provider === 'myob' || job.provider === 'quickbooks';
                return (
                  <div className="receipt-sync-job" key={job.id}>
                    <span>
                      {providerLabel(job.provider)}
                      {unsupported ? <em className="receipt-coming-soon"> not supported</em> : null}
                    </span>
                    <strong>{job.status}</strong>
                    <small>
                      {job.bill_id ? `Bill ${job.bill_id.slice(0, 8)}` : 'No bill attached'}
                    </small>
                  </div>
                );
              })
            )}
          </div>
          {dispatchMessage ? (
            <div className="receipt-result">
              <DatabaseZap size={16} />
              <span>{dispatchMessage}</span>
            </div>
          ) : null}
        </section>
      </div>

      <div className="receipt-pipeline">
        {pipeline.map((step, index) => {
          const Icon = step.icon;
          return (
            <div key={step.title} className="receipt-pipeline-node">
              <span>{String(index + 1).padStart(2, '0')}</span>
              <Icon size={20} />
              <strong>{step.title}</strong>
              <p>{step.detail}</p>
            </div>
          );
        })}
      </div>

      {detailEventId ? (
        <ReceiptEventDrawer
          event={detailEvent}
          lines={detailLines}
          audit={detailAudit}
          loading={detailLoading}
          error={detailError}
          attaching={attaching}
          onClose={closeEventDetail}
          onAttach={attachEventToJob}
        />
      ) : null}
    </section>
  );
}

interface ReceiptEventDrawerProps {
  event: ReceiptEventRow | null;
  lines: ReceiptLineItemRow[];
  audit: ReceiptAuditPackageRow | null;
  loading: boolean;
  error: string | null;
  attaching: boolean;
  onClose: () => void;
  onAttach: (billId: string, jobId: string) => void | Promise<void>;
}

function ReceiptEventDrawer({
  event,
  lines,
  audit,
  loading,
  error,
  attaching,
  onClose,
  onAttach,
}: ReceiptEventDrawerProps) {
  const billId = event?.bill_id ?? audit?.bill_id ?? null;
  const classificationReason =
    typeof audit?.decision_path?.['reason'] === 'string'
      ? (audit.decision_path['reason'] as string)
      : null;

  const downloadAuditPackage = async (storageKey: string | null) => {
    if (!storageKey) return;
    const { data, error: signErr } = await supabase.storage
      .from('receipt-audit')
      .createSignedUrl(storageKey, 60);
    if (signErr || !data?.signedUrl) return;
    window.open(data.signedUrl, '_blank', 'noopener');
  };

  return (
    <>
      <div className="receipt-drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <aside className="receipt-drawer" role="dialog" aria-label="Receipt event detail">
        <div className="receipt-drawer-head">
          <div>
            <span>Receipt event</span>
            <h3>{event?.merchant_name ?? 'Receipt'}</h3>
          </div>
          <button type="button" className="receipt-panel-action" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {loading ? (
          <div className="receipt-loading">
            <Loader2 size={16} className="spin" /> Loading receipt detail
          </div>
        ) : (
          <div className="receipt-drawer-body">
            {error ? (
              <div className="receipt-alert" role="alert">
                {error}
              </div>
            ) : null}
            <dl className="receipt-core-status">
              <div className="receipt-core-metric">
                <dt>Total / GST</dt>
                <dd>
                  {event ? formatMoney(event.total_inc_gst_cents) : '—'}
                  <small> · GST {event ? formatReceiptGst(event.gst_cents) : '—'}</small>
                </dd>
              </div>
              <div className="receipt-core-metric">
                <dt>GST status</dt>
                <dd>{gstStatusLabel(audit?.gst_status)}</dd>
              </div>
              <div className="receipt-core-metric">
                <dt>Deductibility</dt>
                <dd>
                  {(
                    audit?.deductibility_status ??
                    event?.deductibility_status ??
                    'unknown'
                  ).replaceAll('_', ' ')}
                </dd>
              </div>
              {classificationReason ? (
                <div className="receipt-core-metric">
                  <dt>Classification reason</dt>
                  <dd>{classificationReason}</dd>
                </div>
              ) : null}
            </dl>

            <div className="receipt-drawer-section">
              <h4>Line items</h4>
              {lines.length === 0 ? (
                <div className="receipt-empty">No line items captured.</div>
              ) : (
                <div className="receipt-line-list">
                  {lines.map((line) => (
                    <div className="receipt-line-row" key={line.id}>
                      <span>{line.description}</span>
                      <small>
                        {line.quantity}× · GST {formatMoney(line.gst_cents)}
                      </small>
                      <strong>{formatMoney(line.total_inc_gst_cents)}</strong>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="receipt-drawer-section">
              <h4>
                Audit decision path
                {audit?.storage_key ? (
                  <button
                    type="button"
                    className="receipt-panel-action receipt-audit-download"
                    onClick={() => void downloadAuditPackage(audit.storage_key)}
                  >
                    <FileCheck2 size={14} /> Download
                  </button>
                ) : null}
              </h4>
              {audit && Object.keys(audit.decision_path).length > 0 ? (
                <pre className="receipt-decision-path">
                  {JSON.stringify(audit.decision_path, null, 2)}
                </pre>
              ) : (
                <div className="receipt-empty">No decision path recorded.</div>
              )}
            </div>

            <div className="receipt-drawer-section">
              <h4>Attach to job</h4>
              {!billId ? (
                <div className="receipt-empty">
                  This event has no bill yet, so it cannot be attached to a job.
                </div>
              ) : (
                <JobPicker
                  onPick={(job) => void onAttach(billId, job.id)}
                  busy={attaching}
                  placeholder="Search jobs to attach this receipt's bill…"
                />
              )}
            </div>
          </div>
        )}
      </aside>
    </>
  );
}

function providerLabel(provider: SyncProvider) {
  if (provider === 'generic_api') return 'Generic API';
  return provider.toUpperCase();
}

function ReceiptIdentityPass({ token }: { token: string }) {
  const barcode = useMemo(() => code128Bars(token), [token]);

  return (
    <div className="receipt-pass-card">
      <div className="receipt-pass-heading">
        <span>New receipt identity</span>
        <strong>Scan this at POS</strong>
      </div>
      <svg
        role="img"
        aria-label="POS scannable receipt identity barcode"
        className="receipt-pass-barcode"
        viewBox={`0 0 ${barcode.width} 72`}
        preserveAspectRatio="none"
      >
        <rect width={barcode.width} height="72" fill="#ffffff" />
        {barcode.bars.map((bar) => (
          <rect key={`${bar.x}-${bar.width}`} x={bar.x} y="8" width={bar.width} height="44" />
        ))}
      </svg>
      <code>{token}</code>
      <small>
        Cashier scans this Looplet identity before tender; the POS attaches it to the itemised
        sale/refund/void receipt.
      </small>
    </div>
  );
}

function formatReceiptTime(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// A receipt with no GST figure is "not shown", never $0.00: zero would claim the sale had no GST.
function formatReceiptGst(cents: number | null): string {
  return cents == null ? 'not shown' : formatMoney(cents);
}

function gstStatusLabel(status: string | null | undefined): string {
  if (status === 'supplied') return 'From the receipt';
  if (status === 'none') return 'No GST (no credit)';
  if (status === 'review') return 'Not shown: needs review, no credit claimed';
  if (status === 'estimated') return 'Estimated (older receipt): check before relying on it';
  return 'unknown';
}

function paymentDescriptor(event: ReceiptEventRow) {
  const method = event.payment_method?.trim();
  const last4 = event.payment_last4?.trim();
  if (!method && !last4) return null;
  return [method, last4 ? `**** ${last4}` : null].filter(Boolean).join(' ');
}

interface ReceiptWebhookArgs {
  organizationId: string;
  identityToken: string;
  idempotencyKey: string;
  sourceChannel: string;
  payload: unknown;
  syncTargets?: SyncProvider[];
}

async function postReceiptWebhook(args: ReceiptWebhookArgs): Promise<ReceiptWebhookResult> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Idempotency-Key': args.idempotencyKey,
  };
  if (session) {
    headers['Authorization'] = `Bearer ${session.access_token}`;
  }
  const response = await fetch(
    `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/receipt-webhook`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        organization_id: args.organizationId,
        identity_token: args.identityToken,
        idempotency_key: args.idempotencyKey,
        event_type: 'sale',
        source_channel: args.sourceChannel,
        payload: args.payload,
        sync_targets: args.syncTargets ?? ['xero', 'myob', 'quickbooks', 'generic_api'],
      }),
    },
  );
  const body = (await response.json()) as { ok?: boolean; error?: string } & ReceiptWebhookResult;
  if (!response.ok || !body.ok) throw new Error(body.error ?? 'Receipt webhook failed');
  return body;
}
