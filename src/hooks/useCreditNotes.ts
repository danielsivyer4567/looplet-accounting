import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';

export type CreditNoteKind = 'customer' | 'supplier';

export interface CreditNoteRow {
  id: string;
  kind: CreditNoteKind;
  credit_note_number: string;
  credit_note_date: string;
  counterparty_name: string;
  source_number: string;
  status: string;
  total_inc_gst_cents: number;
  journal_entry_id: string | null;
  created_at: string;
}

export interface CreditNoteSourceOption {
  id: string;
  label: string;
  subtotal_ex_gst_cents: number;
  gst_cents: number;
  total_inc_gst_cents: number;
}

interface CustomerCreditNoteRow {
  id: string;
  credit_note_number: string;
  credit_note_date: string;
  customer_name: string;
  status: string;
  total_inc_gst_cents: number;
  journal_entry_id: string | null;
  created_at: string;
  invoice?: { invoice_number?: string | null } | null;
}

interface SupplierCreditNoteRow {
  id: string;
  credit_note_number: string;
  credit_note_date: string;
  supplier_name: string;
  status: string;
  total_inc_gst_cents: number;
  journal_entry_id: string | null;
  created_at: string;
  bill?: { invoice_number?: string | null } | null;
}

interface InvoiceSourceRow {
  id: string;
  invoice_number: string;
  issue_date: string;
  subtotal_ex_gst_cents: number;
  gst_cents: number;
  total_inc_gst_cents: number;
  customer?: { name?: string | null } | null;
}

interface BillSourceRow {
  id: string;
  invoice_number: string | null;
  invoice_date: string | null;
  subtotal_ex_gst_cents: number | null;
  gst_cents: number | null;
  total_inc_gst_cents: number | null;
  supplier_name_raw: string | null;
}

export interface CreateCustomerCreditNoteInput {
  invoiceId: string;
  creditNoteNumber: string;
  creditNoteDate: string;
  subtotalExGstCents: number;
  gstCents: number;
  revenueAccountCode?: string;
  reason?: string;
}

export interface CreateSupplierCreditNoteInput {
  billId: string;
  creditNoteNumber: string;
  creditNoteDate: string;
  subtotalExGstCents: number;
  gstCents: number;
  counterAccountCode?: string;
  reason?: string;
}

export function useCreditNotes() {
  const { currentOrg } = useOrg();
  const [notes, setNotes] = useState<CreditNoteRow[]>([]);
  const [customerSources, setCustomerSources] = useState<CreditNoteSourceOption[]>([]);
  const [supplierSources, setSupplierSources] = useState<CreditNoteSourceOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!currentOrg) {
      setNotes([]);
      setCustomerSources([]);
      setSupplierSources([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    const [customerNotesRes, supplierNotesRes, invoicesRes, billsRes] = await Promise.all([
      supabase
        .from('customer_credit_notes' as never)
        .select(
          'id, credit_note_number, credit_note_date, customer_name, status, total_inc_gst_cents, journal_entry_id, created_at, invoice:invoices!customer_credit_notes_invoice_id_fkey(invoice_number)',
        )
        .eq('organization_id', currentOrg.id)
        .is('deleted_at', null)
        .order('credit_note_date', { ascending: false }),
      supabase
        .from('supplier_credit_notes' as never)
        .select(
          'id, credit_note_number, credit_note_date, supplier_name, status, total_inc_gst_cents, journal_entry_id, created_at, bill:bills!supplier_credit_notes_bill_id_fkey(invoice_number)',
        )
        .eq('organization_id', currentOrg.id)
        .is('deleted_at', null)
        .order('credit_note_date', { ascending: false }),
      supabase
        .from('invoices')
        .select(
          'id, invoice_number, issue_date, subtotal_ex_gst_cents, gst_cents, total_inc_gst_cents, customer:customers!invoices_customer_id_fkey(name)',
        )
        .eq('organization_id', currentOrg.id)
        .is('deleted_at', null)
        .not('status', 'in', '(draft,void)')
        .order('issue_date', { ascending: false })
        .limit(50),
      supabase
        .from('bills')
        .select(
          'id, invoice_number, invoice_date, subtotal_ex_gst_cents, gst_cents, total_inc_gst_cents, supplier_name_raw',
        )
        .eq('organization_id', currentOrg.id)
        .is('deleted_at', null)
        .neq('status', 'void')
        .order('invoice_date', { ascending: false, nullsFirst: false })
        .limit(50),
    ]);

    const firstError =
      customerNotesRes.error ?? supplierNotesRes.error ?? invoicesRes.error ?? billsRes.error;
    if (firstError) {
      setError(firstError.message);
      setNotes([]);
      setCustomerSources([]);
      setSupplierSources([]);
      setLoading(false);
      return;
    }

    const customerNotes = ((customerNotesRes.data ?? []) as unknown as CustomerCreditNoteRow[]).map(
      (note) => ({
        id: note.id,
        kind: 'customer' as const,
        credit_note_number: note.credit_note_number,
        credit_note_date: note.credit_note_date,
        counterparty_name: note.customer_name,
        source_number: note.invoice?.invoice_number ?? 'Invoice',
        status: note.status,
        total_inc_gst_cents: Number(note.total_inc_gst_cents),
        journal_entry_id: note.journal_entry_id,
        created_at: note.created_at,
      }),
    );
    const supplierNotes = ((supplierNotesRes.data ?? []) as unknown as SupplierCreditNoteRow[]).map(
      (note) => ({
        id: note.id,
        kind: 'supplier' as const,
        credit_note_number: note.credit_note_number,
        credit_note_date: note.credit_note_date,
        counterparty_name: note.supplier_name,
        source_number: note.bill?.invoice_number ?? 'Bill',
        status: note.status,
        total_inc_gst_cents: Number(note.total_inc_gst_cents),
        journal_entry_id: note.journal_entry_id,
        created_at: note.created_at,
      }),
    );

    setNotes(
      [...customerNotes, ...supplierNotes].sort((a, b) =>
        b.credit_note_date.localeCompare(a.credit_note_date),
      ),
    );

    setCustomerSources(
      ((invoicesRes.data ?? []) as InvoiceSourceRow[]).map((invoice) => ({
        id: invoice.id,
        label: `${invoice.invoice_number} - ${invoice.customer?.name ?? 'Customer'}`,
        subtotal_ex_gst_cents: Number(invoice.subtotal_ex_gst_cents),
        gst_cents: Number(invoice.gst_cents),
        total_inc_gst_cents: Number(invoice.total_inc_gst_cents),
      })),
    );

    setSupplierSources(
      ((billsRes.data ?? []) as BillSourceRow[]).map((bill) => ({
        id: bill.id,
        label: `${bill.invoice_number ?? 'Bill'} - ${bill.supplier_name_raw ?? 'Supplier'}`,
        subtotal_ex_gst_cents: Number(bill.subtotal_ex_gst_cents ?? 0),
        gst_cents: Number(bill.gst_cents ?? 0),
        total_inc_gst_cents: Number(bill.total_inc_gst_cents ?? 0),
      })),
    );

    setLoading(false);
  }, [currentOrg]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const createCustomer = useCallback(
    async (input: CreateCustomerCreditNoteInput) => {
      if (!currentOrg) throw new Error('Pick an organisation first.');
      const { error: rpcError } = await supabase.rpc('create_customer_credit_note', {
        p_organization_id: currentOrg.id,
        p_invoice_id: input.invoiceId,
        p_credit_note_number: input.creditNoteNumber,
        p_credit_note_date: input.creditNoteDate,
        p_subtotal_ex_gst_cents: input.subtotalExGstCents,
        p_gst_cents: input.gstCents,
        p_revenue_account_code: input.revenueAccountCode ?? '4000',
        p_reason: input.reason ?? null,
      });
      if (rpcError) throw new Error(rpcError.message);
      await refresh();
    },
    [currentOrg, refresh],
  );

  const createSupplier = useCallback(
    async (input: CreateSupplierCreditNoteInput) => {
      if (!currentOrg) throw new Error('Pick an organisation first.');
      const { error: rpcError } = await supabase.rpc('create_supplier_credit_note', {
        p_organization_id: currentOrg.id,
        p_bill_id: input.billId,
        p_credit_note_number: input.creditNoteNumber,
        p_credit_note_date: input.creditNoteDate,
        p_subtotal_ex_gst_cents: input.subtotalExGstCents,
        p_gst_cents: input.gstCents,
        p_counter_account_code: input.counterAccountCode ?? '5000',
        p_counter_account_type: 'expense',
        p_reason: input.reason ?? null,
      });
      if (rpcError) throw new Error(rpcError.message);
      await refresh();
    },
    [currentOrg, refresh],
  );

  return {
    notes,
    customerSources,
    supplierSources,
    loading,
    error,
    refresh,
    createCustomer,
    createSupplier,
  };
}
