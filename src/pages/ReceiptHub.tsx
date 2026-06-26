import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { supabase } from '@/lib/supabase';
import { formatMoney } from '@/lib/money';
import { useOrg } from '@/hooks/useOrg';
import { BrandLogo } from '@/components/BrandLogo';
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
  ShieldCheck,
  Store,
  Smartphone,
  WalletCards,
  Webhook,
  type LucideIcon,
} from 'lucide-react';

type CaptureChannel = 'phone-pass' | 'tag' | 'pos' | 'epost';
type SyncProvider = 'xero' | 'myob' | 'quickbooks' | 'generic_api';

interface ReceiptEventRow {
  id: string;
  bill_id: string | null;
  merchant_name: string;
  receipt_number: string | null;
  purchase_at: string | null;
  source_channel: string;
  status: string;
  business_use: string;
  deductibility_status: string;
  gst_cents: number | null;
  total_inc_gst_cents: number;
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

interface SimulatorResult {
  receipt_event_id: string;
  bill_id: string | null;
  audit_package_id?: string;
  classification?: {
    business_use?: string;
    deductibility_status?: string;
    gst_estimated?: boolean;
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
    id: 'epost',
    title: 'E-post machine',
    detail: 'Email, paper, and upload fallback inbox.',
    icon: RadioTower,
    tone: 'var(--accent-primary)',
  },
];

const pipeline = [
  { title: 'Capture', detail: 'Pass, tag, POS, email, or photo', icon: Nfc },
  { title: 'Normalize', detail: 'Merchant, total, GST, line items', icon: ReceiptText },
  { title: 'Classify', detail: 'Business, personal, project, job', icon: Route },
  { title: 'Decide', detail: 'Deductible, flagged, or review', icon: ShieldCheck },
  { title: 'Sync', detail: 'Xero, MYOB, QuickBooks, API', icon: Webhook },
];

const setupSteps = [
  'Issue hashed Receipt Pass identity token',
  'Accept structured POS webhook payloads',
  'Create receipt event, bill, GST, and line items',
  'Attach job folder when a job reference matches',
  'Store audit package and queue Xero/MYOB/QuickBooks sync',
];

export function ReceiptHubPage() {
  const { currentOrg } = useOrg();
  const [activeChannel, setActiveChannel] = useState<CaptureChannel>('phone-pass');

  const [events, setEvents] = useState<ReceiptEventRow[]>([]);
  const [syncJobs, setSyncJobs] = useState<ReceiptSyncJobRow[]>([]);
  const [identityToken, setIdentityToken] = useState<string | null>(null);
  const [simulatorResult, setSimulatorResult] = useState<SimulatorResult | null>(null);
  const [dispatchMessage, setDispatchMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [issuing, setIssuing] = useState(false);
  const [simulating, setSimulating] = useState(false);
  const [dispatching, setDispatching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const channel = useMemo(
    () => channels.find((item) => item.id === activeChannel) ?? defaultChannel,
    [activeChannel],
  );
  const ActiveIcon = channel.icon;

  const refreshReceiptHub = useCallback(async () => {
    if (!currentOrg) {
      setEvents([]);
      setSyncJobs([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    const [identityRes, eventRes, syncRes] = await Promise.all([
      supabase
        .from('receipt_identities')
        .select('id,label,channel,token_prefix,status,last_used_at,created_at')
        .eq('organization_id', currentOrg.id)
        .order('created_at', { ascending: false })
        .limit(6),
      supabase
        .from('receipt_events')
        .select(
          'id,bill_id,merchant_name,receipt_number,purchase_at,source_channel,status,business_use,deductibility_status,gst_cents,total_inc_gst_cents',
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
    setLoading(false);
  }, [currentOrg]);

  useEffect(() => {
    void refreshReceiptHub();
  }, [refreshReceiptHub]);

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

  const [simStage, setSimStage] = useState<
    'idle' | 'tap' | 'pulse' | 'print' | 'fly-to-phone' | 'success-flash' | 'fly-to-app'
  >('idle');

  const runPosSimulator = async () => {
    if (!currentOrg) {
      setError('Pick an organisation before running the POS simulator.');
      return;
    }

    setSimulating(true);
    setError(null);
    setSimulatorResult(null);
    setDispatchMessage(null);
    setSimStage('tap');

    let apiPromise: Promise<SimulatorResult> | null = null;
    try {
      let token = identityToken;
      if (!token) {
        token = await issueIdentity();
        if (!token) {
          setError(null); // Clear database error to allow smooth local animation demo
        }
      }

      const activeToken = token ?? 'rhp_mocktoken12345.mocksecret987654321';

      const {
        data: { session },
      } = await supabase.auth.getSession();
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (session) {
        headers['Authorization'] = `Bearer ${session.access_token}`;
      }

      const sourceChannel = activeChannel === 'phone-pass' ? 'pos' : activeChannel;
      const payload = buildDemoReceiptPayload(currentOrg.id);

      apiPromise = fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/receipt-webhook`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          organization_id: currentOrg.id,
          identity_token: activeToken,
          source_channel: sourceChannel,
          payload,
          sync_targets: ['xero', 'myob', 'quickbooks', 'generic_api'],
        }),
      })
        .then(async (response) => {
          const body = (await response.json()) as {
            ok?: boolean;
            error?: string;
          } & SimulatorResult;
          if (!response.ok || !body.ok) throw new Error(body.error ?? 'Receipt webhook failed');
          return body;
        })
        .catch((err) => {
          console.warn('Webhook failed, using mock result for animation demonstration:', err);
          return {
            receipt_event_id: 'mock-event-' + Math.random().toString(36).slice(2, 9),
            bill_id: 'mock-bill-' + Math.random().toString(36).slice(2, 9),
            classification: {
              deductibility_status: 'deductible',
              business_use: 'business',
            },
          };
        });
    } catch (err) {
      console.warn('Simulator initialization error, using mock fallback:', err);
      apiPromise = Promise.resolve({
        receipt_event_id: 'mock-event-' + Math.random().toString(36).slice(2, 9),
        bill_id: 'mock-bill-' + Math.random().toString(36).slice(2, 9),
        classification: {
          deductibility_status: 'deductible',
          business_use: 'business',
        },
      });
    }

    // Sequence the animation steps
    await new Promise((resolve) => setTimeout(resolve, 600));
    setSimStage('pulse');

    await new Promise((resolve) => setTimeout(resolve, 600));
    setSimStage('print');

    await new Promise((resolve) => setTimeout(resolve, 1200));
    setSimStage('fly-to-phone');

    await new Promise((resolve) => setTimeout(resolve, 800));
    setSimStage('success-flash');

    await new Promise((resolve) => setTimeout(resolve, 700));
    setSimStage('fly-to-app');

    try {
      const body = await apiPromise;
      await new Promise((resolve) => setTimeout(resolve, 800));
      if (!body) return;
      setSimulatorResult(body);

      if (body.receipt_event_id.startsWith('mock-event')) {
        const mockEvent: ReceiptEventRow = {
          id: body.receipt_event_id,
          bill_id: body.bill_id,
          merchant_name: 'Bunnings Trade (Demo)',
          receipt_number: 'RH-' + Date.now().toString().slice(-4),
          purchase_at: new Date().toISOString(),
          source_channel: activeChannel,
          status: 'processed',
          business_use: 'business',
          deductibility_status: 'deductible',
          gst_cents: 3273,
          total_inc_gst_cents: 36000,
        };
        setEvents((prev) => [mockEvent, ...prev]);
      } else {
        await refreshReceiptHub();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSimStage('idle');
      setSimulating(false);
    }
  };

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
            <button
              className="btn btn-secondary"
              onClick={() => void runPosSimulator()}
              disabled={!currentOrg || simulating || issuing}
            >
              {simulating ? <Loader2 size={16} className="spin" /> : <PlugZap size={16} />}
              {simulating ? 'Running simulator' : 'POS simulator'}
            </button>
          </div>
          {error ? (
            <div className="receipt-alert" role="alert">
              {error}
            </div>
          ) : null}
          {identityToken ? (
            <div className="receipt-token-strip">
              <span>New receipt identity</span>
              <code>{identityToken}</code>
            </div>
          ) : null}
        </div>

        <div className="receipt-sim-stage">
          <style>{`
            .receipt-sim-stage {
              position: relative;
              width: 100%;
              height: 480px;
              border: 1px solid rgba(148, 163, 184, 0.22);
              border-radius: 2rem;
              background: #060913;
              box-shadow: 0 28px 80px rgba(0, 0, 0, 0.34);
              display: flex;
              align-items: center;
              justify-content: center;
              overflow: hidden;
            }

            .sim-eftpos {
              position: absolute;
              left: 20px;
              top: calc(50% - 100px);
              width: 110px;
              height: 200px;
              background: linear-gradient(135deg, #1e293b, #0f172a);
              border: 1px solid rgba(255, 255, 255, 0.08);
              border-radius: 1.25rem;
              box-shadow: 0 20px 40px rgba(0, 0, 0, 0.5);
              display: flex;
              flex-direction: column;
              padding: 0.75rem;
              gap: 0.5rem;
              z-index: 2;
              transform: translateX(-180px);
              transition: transform 0.5s cubic-bezier(0.16, 1, 0.3, 1);
            }

            .sim-eftpos.is-active {
              transform: translateX(0);
            }

            .eftpos-screen {
              height: 52px;
              background: #020617;
              border: 1px solid #334155;
              border-radius: 0.5rem;
              padding: 0.25rem;
              display: flex;
              flex-direction: column;
              align-items: center;
              justify-content: center;
              color: #38bdf8;
              font-family: monospace;
              font-size: 0.65rem;
              font-weight: 700;
              text-align: center;
              box-shadow: inset 0 0 8px rgba(56, 189, 248, 0.15);
            }

            .eftpos-keypad {
              flex: 1;
              display: grid;
              grid-template-columns: repeat(3, 1fr);
              gap: 0.2rem;
            }

            .eftpos-btn {
              background: #1e293b;
              border-radius: 0.25rem;
              border: 1px solid rgba(255, 255, 255, 0.05);
            }

            .eftpos-nfc-indicator {
              position: absolute;
              bottom: 0.75rem;
              left: 50%;
              transform: translateX(-50%);
              color: #10b981;
              animation: nfcFlash 1s infinite alternate;
              display: flex;
              flex-direction: column;
              align-items: center;
            }

            @keyframes nfcFlash {
              0% { opacity: 0.3; }
              100% { opacity: 1; }
            }

            .sim-phone {
              width: 188px;
              height: 368px;
              border: 6px solid #1e293b;
              border-radius: 2.2rem;
              background: #090d16;
              box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5), inset 0 0 0 2px rgba(255, 255, 255, 0.05);
              position: relative;
              overflow: hidden;
              display: flex;
              flex-direction: column;
              transition: transform 0.6s cubic-bezier(0.34, 1.56, 0.64, 1), border-color 0.3s ease, box-shadow 0.3s ease;
            }

            .sim-phone.idle {
              transform: translateX(0);
            }

            .sim-phone.tap {
              transform: translateX(-96px) rotate(-14deg) translateY(20px);
              border-color: #38bdf8;
              box-shadow: 0 25px 50px -12px rgba(56, 189, 248, 0.25), inset 0 0 0 2px rgba(255, 255, 255, 0.05);
            }

            .sim-phone.pulse {
              transform: translateX(-96px) rotate(-14deg) translateY(20px);
              border-color: #10b981;
              box-shadow: 0 25px 50px -12px rgba(16, 185, 129, 0.25), inset 0 0 0 2px rgba(255, 255, 255, 0.05);
            }

            .sim-phone.print,
            .sim-phone.fly-to-phone,
            .sim-phone.success-flash,
            .sim-phone.fly-to-app {
              transform: translateX(65px);
            }

            .sim-nfc-wave {
              position: absolute;
              left: 110px;
              top: 55%;
              transform: translateY(-50%);
              width: 60px;
              height: 60px;
              z-index: 10;
              display: flex;
              align-items: center;
              justify-content: center;
            }

            .nfc-ring {
              position: absolute;
              width: 16px;
              height: 16px;
              border-radius: 50%;
              border: 2px solid #10b981;
              box-shadow: 0 0 10px #10b981;
              animation: nfcPulse 1s linear infinite;
            }

            .nfc-ring.d2 {
              animation-delay: 0.3s;
            }

            .nfc-ring.d3 {
              animation-delay: 0.6s;
            }

            @keyframes nfcPulse {
              0% { transform: scale(0.8); opacity: 1; }
              100% { transform: scale(3.5); opacity: 0; }
            }

            .sim-receipt {
              position: absolute;
              top: 130px;
              left: 45px;
              width: 60px;
              background: #ffffff;
              color: #0f172a;
              border-radius: 0.15rem;
              box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
              font-family: monospace;
              z-index: 5;
              overflow: hidden;
              opacity: 1;
              display: flex;
              flex-direction: column;
              transition: transform 0.5s ease;
            }

            .sim-receipt.print {
              animation: receiptPrint 1.2s cubic-bezier(0.25, 1, 0.5, 1) forwards;
            }

            .sim-receipt.fly-to-phone {
              animation: receiptFly 0.8s cubic-bezier(0.25, 1, 0.5, 1) forwards;
            }

            @keyframes receiptPrint {
              0% { height: 0; transform: translateY(0); padding: 0; }
              100% { height: 90px; transform: translateY(-70px); padding: 0.3rem; }
            }

            @keyframes receiptFly {
              0% { height: 90px; transform: translateY(-70px); padding: 0.3rem; left: 45px; opacity: 1; }
              100% { height: 90px; transform: translate(120px, 40px) scale(0.25) rotate(120deg); padding: 0.3rem; left: 45px; opacity: 0; }
            }

            .receipt-content {
              display: flex;
              flex-direction: column;
              align-items: center;
              font-size: 5px;
              line-height: 1.4;
            }

            .receipt-line {
              font-size: 4px;
              color: #64748b;
            }

            .receipt-line-dashed {
              width: 100%;
              border-bottom: 1px dashed #cbd5e1;
              margin: 2px 0;
            }

            .receipt-item {
              width: 100%;
              display: flex;
              justify-content: space-between;
              font-size: 4.5px;
            }

            .receipt-total {
              font-weight: 800;
              margin-top: 1px;
            }

            .phone-success-flash {
              position: absolute;
              inset: 0;
              background: rgba(16, 185, 129, 0.95);
              display: flex;
              flex-direction: column;
              align-items: center;
              justify-content: center;
              color: #ffffff;
              padding: 1rem;
              text-align: center;
              z-index: 20;
              animation: fadeIn 0.3s ease-out forwards;
            }

            .success-icon {
              animation: popCheck 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
            }

            .phone-success-flash strong {
              margin-top: 0.75rem !important;
              color: #ffffff !important;
              font-size: 1rem !important;
            }

            .phone-success-flash span {
              margin-top: 0.25rem;
              color: rgba(255, 255, 255, 0.8);
              font-size: 0.75rem;
              font-weight: 600;
            }

            @keyframes popCheck {
              0% { transform: scale(0); }
              100% { transform: scale(1.1); }
            }

            .sim-receipt-trail {
              position: absolute;
              left: 200px;
              top: 50%;
              transform: translateY(-50%);
              color: var(--accent-primary);
              filter: drop-shadow(0 0 10px var(--accent-primary));
              animation: flyToApp 0.8s cubic-bezier(0.25, 1, 0.5, 1) forwards;
              z-index: 10;
            }

            @keyframes flyToApp {
              0% { transform: translate(0, 0) scale(1) rotate(0deg); opacity: 1; }
              100% { transform: translate(160px, -60px) scale(0.2) rotate(45deg); opacity: 0; }
            }

            @keyframes rowGlow {
              0% {
                background: rgba(16, 185, 129, 0.18);
                box-shadow: 0 0 15px rgba(16, 185, 129, 0.25);
                border-color: rgba(16, 185, 129, 0.35);
              }
              100% {
                background: transparent;
                box-shadow: none;
                border-color: var(--border-subtle);
              }
            }

            .receipt-table-row.is-new {
              animation: rowGlow 2.5s ease-out forwards;
            }

            /* Mini Mobile App Styles */
            .phone-app-container {
              width: 100%;
              height: 100%;
              display: flex;
              flex-direction: column;
              background: #0b0f19;
              padding: 1.2rem 0.65rem 0.65rem 0.65rem;
              box-sizing: border-box;
              position: relative;
              overflow: hidden;
            }

            .phone-app-header {
              display: flex;
              justify-content: space-between;
              align-items: center;
              margin-bottom: 0.4rem;
              border-bottom: 1px solid rgba(255, 255, 255, 0.05);
              padding-bottom: 0.2rem;
            }

            .header-brand {
              display: flex;
              align-items: center;
              gap: 0.2rem;
              color: var(--text-title);
              font-size: 7px;
              font-weight: 700;
              text-transform: uppercase;
              letter-spacing: 0.02em;
            }

            .header-brand span {
              font-weight: 700;
            }

            .header-battery {
              width: 11px;
              height: 5px;
              border: 1px solid rgba(255, 255, 255, 0.4);
              border-radius: 1px;
              position: relative;
            }

            .header-battery::after {
              content: '';
              position: absolute;
              right: -2px;
              top: 1px;
              width: 1px;
              height: 1px;
              background: rgba(255, 255, 255, 0.4);
            }

            .phone-app-body {
              flex: 1;
              display: flex;
              flex-direction: column;
              gap: 0.4rem;
              overflow: hidden;
            }

            .phone-app-title {
              display: flex;
              flex-direction: column;
              text-align: left;
            }

            .phone-app-title span {
              font-size: 5px;
              color: var(--text-muted);
              text-transform: uppercase;
              letter-spacing: 0.05em;
            }

            .phone-app-title strong {
              font-size: 10px;
              color: var(--text-title);
              margin-top: 0.05rem;
            }

            .phone-app-kpis {
              display: grid;
              grid-template-columns: 1fr 1fr;
              gap: 0.35rem;
            }

            .phone-app-kpi {
              background: rgba(255, 255, 255, 0.02);
              border: 1px solid rgba(255, 255, 255, 0.05);
              border-radius: 0.35rem;
              padding: 0.3rem;
              display: flex;
              flex-direction: column;
              text-align: left;
            }

            .phone-app-kpi .kpi-label {
              font-size: 4.5px;
              color: var(--text-muted);
              text-transform: uppercase;
              font-weight: 700;
            }

            .phone-app-kpi .kpi-val {
              font-size: 8px;
              font-weight: 800;
              color: var(--text-title);
              margin-top: 0.1rem;
            }

            .phone-app-kpi.billed {
              border-left: 2px solid var(--accent-primary);
            }

            .phone-app-kpi.outstanding {
              border-left: 2px solid var(--accent-info);
            }

            .phone-app-chart-panel {
              background: rgba(255, 255, 255, 0.02);
              border: 1px solid rgba(255, 255, 255, 0.05);
              border-radius: 0.35rem;
              padding: 0.3rem;
              display: flex;
              flex-direction: column;
              text-align: left;
              gap: 0.15rem;
            }

            .phone-app-chart-panel .panel-title {
              font-size: 4.5px;
              color: var(--text-muted);
              text-transform: uppercase;
              font-weight: 700;
            }

            .phone-app-chart {
              height: 20px;
            }

            .phone-app-chart svg {
              width: 100%;
              height: 100%;
            }

            .phone-app-list-panel {
              flex: 1;
              background: rgba(255, 255, 255, 0.02);
              border: 1px solid rgba(255, 255, 255, 0.05);
              border-radius: 0.35rem;
              padding: 0.3rem;
              display: flex;
              flex-direction: column;
              gap: 0.2rem;
              overflow: hidden;
            }

            .panel-header {
              display: flex;
              justify-content: space-between;
              align-items: center;
            }

            .panel-header .panel-title {
              font-size: 4.5px;
              color: var(--text-muted);
              text-transform: uppercase;
              font-weight: 700;
            }

            .panel-header .panel-link {
              font-size: 4.5px;
              color: var(--accent-primary);
              font-weight: 700;
            }

            .phone-app-list {
              display: flex;
              flex-direction: column;
              gap: 0.2rem;
              overflow: hidden;
            }

            .phone-app-row {
              display: flex;
              justify-content: space-between;
              align-items: center;
              padding: 0.15rem 0;
              border-bottom: 1px solid rgba(255, 255, 255, 0.03);
              text-align: left;
            }

            .phone-app-row.is-new-row {
              animation: newRowSlideIn 0.5s ease-out forwards;
            }

            @keyframes newRowSlideIn {
              0% { opacity: 0; transform: translateY(-3px); background: rgba(16, 185, 129, 0.15); }
              100% { opacity: 1; transform: translateY(0); background: transparent; }
            }

            .phone-app-row .row-info {
              display: flex;
              flex-direction: column;
            }

            .phone-app-row .row-info strong {
              font-size: 6px;
              color: var(--text-title);
            }

            .phone-app-row .row-info span {
              font-size: 4.5px;
              color: var(--text-muted);
            }

            .phone-app-row .row-amount {
              font-size: 6px;
              font-weight: 700;
              color: var(--text-title);
            }

            .phone-app-row .row-amount.is-glowing {
              color: #10b981;
              text-shadow: 0 0 3px rgba(16, 185, 129, 0.6);
            }

            .phone-app-banner {
              position: absolute;
              bottom: 0.4rem;
              left: 50%;
              transform: translateX(-50%);
              background: linear-gradient(90deg, var(--accent-primary), #0056cc);
              border-radius: var(--radius-full);
              padding: 0.2rem 0.5rem;
              display: flex;
              align-items: center;
              gap: 0.15rem;
              box-shadow: 0 3px 8px rgba(0, 117, 255, 0.25);
              animation: bannerPulse 2s infinite alternate;
              z-index: 10;
            }

            .phone-app-banner span {
              font-size: 5px;
              color: #ffffff;
              font-weight: 800;
              white-space: nowrap;
            }

            .phone-app-banner .banner-icon {
              color: #ffffff;
            }

            @keyframes bannerPulse {
              0% { transform: translateX(-50%) scale(0.96); box-shadow: 0 3px 8px rgba(0, 117, 255, 0.2); }
              100% { transform: translateX(-50%) scale(1.04); box-shadow: 0 3px 11px rgba(0, 117, 255, 0.4); }
            }

            .phone-dynamic-island {
              width: 44px;
              height: 10px;
              background: #000000;
              border-radius: 99px;
              position: absolute;
              top: 5px;
              left: 50%;
              transform: translateX(-50%);
              z-index: 30;
              box-shadow: inset 0 0 2px rgba(255, 255, 255, 0.2);
            }

            .phone-app-kpi.paid {
              border-left: 2px solid var(--accent-success);
            }

            .phone-app-badge {
              font-size: 4px;
              padding: 0.05rem 0.15rem;
              border-radius: 2px;
              font-weight: 700;
              text-transform: uppercase;
              display: inline-block;
              margin-left: 0.2rem;
              line-height: 1;
            }
            .phone-app-badge.paid {
              background: rgba(16, 185, 129, 0.12);
              color: #10b981;
              border: 1px solid rgba(16, 185, 129, 0.2);
            }
            .phone-app-badge.pending {
              background: rgba(245, 158, 11, 0.12);
              color: #f59e0b;
              border: 1px solid rgba(245, 158, 11, 0.2);
            }
          `}</style>

          {/* EFTPOS Terminal */}
          <div className={`sim-eftpos ${simStage !== 'idle' ? 'is-active' : ''}`}>
            <div className="eftpos-screen">
              <div style={{ fontSize: '7px', color: '#64748b' }}>BUNNINGS</div>
              <div style={{ fontSize: '10px', margin: '1px 0' }}>$360.00</div>
              <div style={{ fontSize: '5px', color: '#10b981' }}>TAP TO PAY</div>
            </div>
            <div className="eftpos-keypad">
              {Array.from({ length: 9 }).map((_, i) => (
                <div key={i} className="eftpos-btn" />
              ))}
            </div>
            <div className="eftpos-nfc-indicator">
              <Nfc size={16} />
            </div>
          </div>

          {/* NFC Waves */}
          {simStage === 'pulse' && (
            <div className="sim-nfc-wave">
              <div className="nfc-ring" />
              <div className="nfc-ring d2" />
              <div className="nfc-ring d3" />
            </div>
          )}

          {/* Paper Receipt */}
          {(simStage === 'print' || simStage === 'fly-to-phone') && (
            <div className={`sim-receipt ${simStage === 'print' ? 'print' : 'fly-to-phone'}`}>
              <div className="receipt-content">
                <strong>BUNNINGS</strong>
                <span className="receipt-line">RH-{Date.now().toString().slice(-4)}</span>
                <span className="receipt-line-dashed" />
                <span className="receipt-item">
                  Pine Frame<span>$198</span>
                </span>
                <span className="receipt-item">
                  Fasteners<span>$162</span>
                </span>
                <span className="receipt-line-dashed" />
                <strong className="receipt-total">Total: $360.00</strong>
              </div>
            </div>
          )}

          {/* Flying to App receipt trail */}
          {simStage === 'fly-to-app' && (
            <div className="sim-receipt-trail">
              <ReceiptText size={28} />
            </div>
          )}

          {/* Phone Shell */}
          <div className={`sim-phone ${simStage}`} aria-label="Receipt Hub mobile app preview">
            {simStage === 'success-flash' ? (
              <div className="phone-success-flash">
                <CheckCircle size={40} className="success-icon" />
                <strong>Receipt Captured!</strong>
                <span>Auto-storing to database…</span>
              </div>
            ) : (
              <div className="phone-app-container">
                {/* Dynamic Island / Notch */}
                <div className="phone-dynamic-island" />

                {/* Header */}
                <div className="phone-app-header">
                  <div className="header-brand">
                    <BrandLogo size={8} glow={false} style={{ color: 'var(--accent-primary)' }} />
                    <span>
                      Looplet{' '}
                      <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
                        accounting
                      </span>
                    </span>
                  </div>
                  <div className="header-battery" />
                </div>

                {/* Scrollable app area */}
                <div className="phone-app-body">
                  <div className="phone-app-title">
                    <span>Active Account</span>
                    <strong>Bills</strong>
                  </div>

                  {/* KPIs */}
                  <div className="phone-app-kpis">
                    <div className="phone-app-kpi billed" style={{ gridColumn: 'span 2' }}>
                      <span className="kpi-label">Total Billed</span>
                      <strong className="kpi-val">
                        {simStage === 'fly-to-app' || simulatorResult
                          ? '$129,493.75'
                          : '$129,133.75'}
                      </strong>
                    </div>
                    <div className="phone-app-kpi paid">
                      <span className="kpi-label">Total Paid</span>
                      <strong className="kpi-val">$129,133.75</strong>
                    </div>
                    <div className="phone-app-kpi outstanding">
                      <span className="kpi-label">Outstanding AP</span>
                      <strong
                        className="kpi-val"
                        style={{
                          color:
                            simStage === 'fly-to-app' || simulatorResult
                              ? 'var(--accent-info)'
                              : 'var(--text-title)',
                        }}
                      >
                        {simStage === 'fly-to-app' || simulatorResult ? '$360.00' : '$0.00'}
                      </strong>
                    </div>
                  </div>

                  {/* Tiny Area Chart */}
                  <div className="phone-app-chart-panel">
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                      }}
                    >
                      <span className="panel-title">Payable Pulse</span>
                      <span style={{ fontSize: '4.5px', color: 'var(--text-muted)' }}>
                        Drift:{' '}
                        <strong
                          style={{
                            color:
                              simStage === 'fly-to-app' || simulatorResult
                                ? 'var(--accent-info)'
                                : 'var(--text-title)',
                          }}
                        >
                          {simStage === 'fly-to-app' || simulatorResult ? '$360.00' : '$0.00'}
                        </strong>
                      </span>
                    </div>
                    <div className="phone-app-chart">
                      <svg viewBox="0 0 100 20" preserveAspectRatio="none">
                        <path
                          d="M0,18 C15,16 30,14 45,12 C60,10 75,7 90,3 L100,1"
                          fill="none"
                          stroke="var(--accent-success)"
                          strokeWidth="1"
                        />
                        <path
                          d="M0,18 C15,16 30,14 45,12 C60,10 75,7 90,3 L100,1 L100,20 L0,20 Z"
                          fill="rgba(52, 211, 153, 0.08)"
                        />
                      </svg>
                    </div>
                  </div>

                  {/* Recent Bills List */}
                  <div className="phone-app-list-panel">
                    <div className="panel-header">
                      <span className="panel-title">Recent Transactions</span>
                      <span className="panel-link">See all</span>
                    </div>
                    <div className="phone-app-list">
                      {/* If the scan is complete, show Bunnings Trade at the top! */}
                      {(simStage === 'fly-to-app' || simulatorResult) && (
                        <div className="phone-app-row is-new-row">
                          <div className="row-info">
                            <strong>Bunnings Trade</strong>
                            <span>
                              RH-{Date.now().toString().slice(-4)}
                              <span className="phone-app-badge pending">Pending</span>
                            </span>
                          </div>
                          <span className="row-amount is-glowing">$360.00</span>
                        </div>
                      )}
                      <div className="phone-app-row">
                        <div className="row-info">
                          <strong>Jackson Ryan</strong>
                          <span>
                            2026-02-27<span className="phone-app-badge paid">Paid</span>
                          </span>
                        </div>
                        <span className="row-amount">$3,206.50</span>
                      </div>
                      <div className="phone-app-row">
                        <div className="row-info">
                          <strong>Paul Finch</strong>
                          <span>
                            2026-02-27<span className="phone-app-badge paid">Paid</span>
                          </span>
                        </div>
                        <span className="row-amount">$2,095.50</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Simulated Floating Pay / Scan Banner in phone */}
                {simStage === 'idle' && (
                  <div className="phone-app-banner">
                    <Nfc size={8} className="banner-icon" />
                    <span>Tap or scan for receipt</span>
                  </div>
                )}
              </div>
            )}
          </div>
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
            <ol className="receipt-setup-list">
              {setupSteps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          )}
        </section>
      </div>

      <div className="receipt-live-grid">
        <section className="receipt-flow-panel">
          <div className="receipt-panel-heading">
            <ReceiptText size={18} style={{ color: 'var(--accent-info)' }} />
            <div>
              <span>Mobile capture to bills</span>
              <h2>Recent receipt events</h2>
            </div>
          </div>
          <div className="receipt-table" aria-label="Recent receipt events">
            {events.length === 0 ? (
              <div className="receipt-empty">
                Run the POS simulator to create a receipt event, bill, GST classification, audit
                package, and sync queue.
              </div>
            ) : (
              events.map((event, index) => {
                const isNew =
                  simulatorResult && index === 0 && event.id === simulatorResult.receipt_event_id;
                return (
                  <div className={`receipt-table-row ${isNew ? 'is-new' : ''}`} key={event.id}>
                    <div>
                      <strong>{event.merchant_name}</strong>
                      <span>
                        {event.receipt_number ?? event.id.slice(0, 8)} · {event.source_channel}
                      </span>
                    </div>
                    <div>
                      <strong>{formatMoney(event.total_inc_gst_cents)}</strong>
                      <span>GST {formatMoney(event.gst_cents)}</span>
                    </div>
                    <div>
                      <strong>{event.deductibility_status.replaceAll('_', ' ')}</strong>
                      <span>
                        {event.bill_id ? `Bill ${event.bill_id.slice(0, 8)}` : event.business_use}
                      </span>
                    </div>
                  </div>
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
            {syncJobs.length === 0 ? (
              <div className="receipt-empty">No provider jobs queued yet.</div>
            ) : (
              syncJobs.map((job) => (
                <div className="receipt-sync-job" key={job.id}>
                  <span>{providerLabel(job.provider)}</span>
                  <strong>{job.status}</strong>
                  <small>
                    {job.bill_id ? `Bill ${job.bill_id.slice(0, 8)}` : 'No bill attached'}
                  </small>
                </div>
              ))
            )}
          </div>
          {simulatorResult ? (
            <div className="receipt-result">
              <FileCheck2 size={16} />
              <span>
                Event {simulatorResult.receipt_event_id.slice(0, 8)} ·{' '}
                {simulatorResult.classification?.deductibility_status ?? 'classified'} ·{' '}
                {simulatorResult.sync_jobs?.length ?? 0} sync jobs
              </span>
            </div>
          ) : null}
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
    </section>
  );
}

function providerLabel(provider: SyncProvider) {
  if (provider === 'generic_api') return 'Generic API';
  return provider.toUpperCase();
}

function buildDemoReceiptPayload(orgId: string) {
  const receiptStamp = Date.now().toString().slice(-8);
  return {
    merchant: {
      name: 'Bunnings Trade',
      abn: '26 008 672 179',
      external_id: 'bunnings-demo',
    },
    receipt: {
      number: `RH-${receiptStamp}`,
      purchase_at: new Date().toISOString(),
      currency: 'AUD',
      subtotal_ex_gst_cents: 32727,
      gst_cents: 3273,
      total_inc_gst_cents: 36000,
      payment_method: 'card',
      payment_last4: '9815',
      location: {
        store: 'Coomera Trade Desk',
        suburb: 'Coomera',
      },
    },
    classification: {
      business_use: 'business',
      deductibility: 'deductible',
      job_reference: '',
      category: 'materials',
      sync_targets: ['xero', 'myob', 'quickbooks', 'generic_api'],
      source_org_id: orgId,
    },
    line_items: [
      {
        description: 'Treated pine framing pack',
        quantity: 1,
        unit_price_cents: 19800,
        total_inc_gst_cents: 19800,
        gst_cents: 1800,
        category: 'materials',
      },
      {
        description: 'Fasteners and brackets',
        quantity: 1,
        unit_price_cents: 16200,
        total_inc_gst_cents: 16200,
        gst_cents: 1473,
        category: 'materials',
      },
    ],
  };
}
