import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';

/**
 * A real money event for the dashboard feed, merged from bills (money out),
 * invoices (money in) and bank transactions (either direction).
 */
export interface ActivityItem {
  id: string;
  kind: 'bill' | 'invoice' | 'bank';
  label: string;
  sub: string;
  dateISO: string;
  /** Signed cents: negative = money out, positive = money in. */
  amountCents: number;
}

const FEED_LIMIT = 15;
const PER_SOURCE_LIMIT = 12;

function formatFeedDay(dateISO: string): string {
  const dt = new Date(dateISO);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function useRecentActivity() {
  const { currentOrg } = useOrg();
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!currentOrg) {
      setItems([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);

    const [billsRes, invoicesRes, bankRes] = await Promise.all([
      supabase
        .from('bills')
        .select('id, supplier_name_raw, invoice_number, invoice_date, total_inc_gst_cents, status')
        .eq('organization_id', currentOrg.id)
        .is('deleted_at', null)
        .neq('status', 'void')
        .not('invoice_date', 'is', null)
        .order('invoice_date', { ascending: false })
        .limit(PER_SOURCE_LIMIT),
      supabase
        .from('invoices')
        .select(
          'id, invoice_number, issue_date, total_inc_gst_cents, status, customer:customers!invoices_customer_id_fkey(name)',
        )
        .eq('organization_id', currentOrg.id)
        .is('deleted_at', null)
        .neq('status', 'void')
        .order('issue_date', { ascending: false })
        .limit(PER_SOURCE_LIMIT),
      supabase
        .from('bank_transactions')
        .select('id, posted_at, description, amount_cents')
        .eq('organization_id', currentOrg.id)
        .order('posted_at', { ascending: false })
        .limit(PER_SOURCE_LIMIT),
    ]);

    const firstError = billsRes.error ?? invoicesRes.error ?? bankRes.error;
    if (firstError) setError(firstError.message);

    const merged: ActivityItem[] = [];

    for (const b of billsRes.data ?? []) {
      merged.push({
        id: `bill-${b.id}`,
        kind: 'bill',
        label: b.supplier_name_raw?.trim() || 'Supplier bill',
        sub: `${formatFeedDay(b.invoice_date as string)} • Bill${b.invoice_number ? ` ${b.invoice_number}` : ''}`,
        dateISO: b.invoice_date as string,
        amountCents: -Math.abs(b.total_inc_gst_cents ?? 0),
      });
    }

    for (const i of invoicesRes.data ?? []) {
      const customer = (i.customer as { name?: string } | null)?.name;
      merged.push({
        id: `invoice-${i.id}`,
        kind: 'invoice',
        label: customer?.trim() || 'Customer invoice',
        sub: `${formatFeedDay(i.issue_date as string)} • Invoice${i.invoice_number ? ` ${i.invoice_number}` : ''}`,
        dateISO: i.issue_date as string,
        amountCents: Math.abs(i.total_inc_gst_cents ?? 0),
      });
    }

    for (const t of bankRes.data ?? []) {
      merged.push({
        id: `bank-${t.id}`,
        kind: 'bank',
        label: t.description?.trim() || 'Bank transaction',
        sub: `${formatFeedDay(t.posted_at as string)} • Bank`,
        dateISO: t.posted_at as string,
        amountCents: t.amount_cents ?? 0,
      });
    }

    merged.sort((a, b) => b.dateISO.localeCompare(a.dateISO));
    setItems(merged.slice(0, FEED_LIMIT));
    setLoading(false);
  }, [currentOrg]);

  useEffect(() => void refresh(), [refresh]);

  return { items, loading, error, refresh };
}
