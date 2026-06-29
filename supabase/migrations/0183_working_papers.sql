-- 0183_working_papers.sql - SC-7.G.01 (working-papers manifest RPC)
--
-- Read-only manifest compiler for a closed accounting period. It does not build
-- a downloadable bundle; SC-7.G.02 turns this manifest into files. This RPC only
-- gathers evidence already in the books: period locks, bank reconciliation lines,
-- period journals, trial-balance schedule rows, receipt audit packages and audit
-- log references.
--
-- MIGRATION NUMBER: ledger planned 0175, but 0175-0182 are already assigned.
-- Reassigned to 0183 per the drift rule; sequential repo head is 0182.

create or replace function public.compile_working_papers(
  p_org uuid,
  p_period_start date,
  p_period_end date
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_period_closed boolean;
  v_unreconciled_count integer;
  v_reconciled_count integer;
  v_journal_count integer;
  v_reconciliation_set jsonb;
  v_period_journals jsonb;
  v_trial_balance jsonb;
  v_receipt_packages jsonb;
  v_audit_log jsonb;
begin
  if p_org is null then
    raise exception 'p_org is required' using errcode = '22004';
  end if;

  if p_period_start is null or p_period_end is null or p_period_end < p_period_start then
    raise exception 'valid p_period_start and p_period_end are required' using errcode = '22007';
  end if;

  select exists (
    select 1
      from public.period_locks pl
     where pl.organization_id = p_org
       and pl.period_start <= p_period_start
       and pl.period_end >= p_period_end
       and pl.unlocked_at is null
  )
    into v_period_closed;

  select
    count(*) filter (
      where bt.is_personal is not true
        and bt.matched_bill_id is null
        and bt.matched_invoice_id is null
    )::integer,
    count(*) filter (
      where bt.is_personal is not true
        and (bt.matched_bill_id is not null or bt.matched_invoice_id is not null)
    )::integer
    into v_unreconciled_count, v_reconciled_count
    from public.bank_transactions bt
   where bt.organization_id = p_org
     and bt.posted_at::date between p_period_start and p_period_end;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', bt.id,
        'posted_at', bt.posted_at,
        'description', bt.description,
        'amount_cents', bt.amount_cents,
        'is_personal', bt.is_personal,
        'manually_matched', bt.manually_matched,
        'matched_bill_id', bt.matched_bill_id,
        'matched_invoice_id', bt.matched_invoice_id,
        'reconciled', bt.is_personal is true
          or bt.matched_bill_id is not null
          or bt.matched_invoice_id is not null,
        'source_document', case
          when b.id is not null then jsonb_build_object(
            'type', 'bill',
            'id', b.id,
            'invoice_number', b.invoice_number,
            'storage_key', b.storage_key,
            'original_filename', b.original_filename,
            'receipt_audit_package_ids', coalesce((
              select jsonb_agg(rap.id order by rap.created_at)
                from public.receipt_audit_packages rap
               where rap.organization_id = p_org
                 and rap.bill_id = b.id
            ), '[]'::jsonb)
          )
          when i.id is not null then jsonb_build_object(
            'type', 'invoice',
            'id', i.id,
            'invoice_number', i.invoice_number
          )
          else null
        end
      )
      order by bt.posted_at, bt.id
    ),
    '[]'::jsonb
  )
    into v_reconciliation_set
    from public.bank_transactions bt
    left join public.bills b
      on b.id = bt.matched_bill_id
     and b.organization_id = bt.organization_id
    left join public.invoices i
      on i.id = bt.matched_invoice_id
     and i.organization_id = bt.organization_id
   where bt.organization_id = p_org
     and bt.posted_at::date between p_period_start and p_period_end;

  select
    count(*)::integer,
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', je.id,
          'entry_date', je.entry_date,
          'memo', je.memo,
          'source_type', je.source_type,
          'source_id', je.source_id,
          'status', je.status,
          'posted_at', je.posted_at,
          'lines', coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'id', jl.id,
                'account_id', jl.account_id,
                'debit_cents', jl.debit_cents,
                'credit_cents', jl.credit_cents,
                'description', jl.description
              )
              order by jl.created_at, jl.id
            )
              from public.journal_lines jl
             where jl.journal_entry_id = je.id
          ), '[]'::jsonb)
        )
        order by je.entry_date, je.id
      ),
      '[]'::jsonb
    )
    into v_journal_count, v_period_journals
    from public.journal_entries je
   where je.organization_id = p_org
     and je.entry_date between p_period_start and p_period_end;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'account_id', account_id,
        'account_code', account_code,
        'account_name', account_name,
        'account_type', account_type,
        'total_debit_cents', total_debit_cents,
        'total_credit_cents', total_credit_cents,
        'net_cents', net_cents
      )
      order by account_code
    ),
    '[]'::jsonb
  )
    into v_trial_balance
    from public.v_trial_balance
   where organization_id = p_org;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', rap.id,
        'receipt_event_id', rap.receipt_event_id,
        'bill_id', rap.bill_id,
        'storage_key', rap.storage_key,
        'gst_status', rap.gst_status,
        'deductibility_status', rap.deductibility_status,
        'created_at', rap.created_at
      )
      order by rap.created_at, rap.id
    ),
    '[]'::jsonb
  )
    into v_receipt_packages
    from public.receipt_audit_packages rap
   where rap.organization_id = p_org
     and (
       rap.created_at::date between p_period_start and p_period_end
       or rap.bill_id in (
         select bt.matched_bill_id
           from public.bank_transactions bt
          where bt.organization_id = p_org
            and bt.posted_at::date between p_period_start and p_period_end
            and bt.matched_bill_id is not null
       )
     );

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', al.id,
        'table_name', al.table_name,
        'record_id', al.record_id,
        'operation', al.operation,
        'actor_user_id', al.actor_user_id,
        'occurred_at', al.occurred_at
      )
      order by al.occurred_at, al.id
    ),
    '[]'::jsonb
  )
    into v_audit_log
    from public.audit_log al
   where al.organization_id = p_org
     and al.occurred_at::date between p_period_start and p_period_end
     and al.table_name in (
       'bank_transactions',
       'journal_entries',
       'journal_lines',
       'bills',
       'invoices',
       'receipt_audit_packages',
       'period_locks'
     );

  return jsonb_build_object(
    'ok', v_period_closed and v_unreconciled_count = 0,
    'organization_id', p_org,
    'period_start', p_period_start,
    'period_end', p_period_end,
    'checks', jsonb_build_object(
      'period_closed', jsonb_build_object(
        'passed', v_period_closed,
        'message', case
          when v_period_closed then 'The requested period is covered by an active period lock.'
          else 'The requested period is not covered by an active period lock.'
        end
      ),
      'reconciliation_complete', jsonb_build_object(
        'passed', v_unreconciled_count = 0,
        'unreconciled_count', v_unreconciled_count,
        'reconciled_count', v_reconciled_count
      ),
      'period_journals', jsonb_build_object(
        'journal_count', v_journal_count
      )
    ),
    'manifest', jsonb_build_object(
      'reconciliation_set', v_reconciliation_set,
      'period_journals', v_period_journals,
      'schedules', jsonb_build_object(
        'trial_balance', v_trial_balance
      ),
      'receipt_audit_packages', v_receipt_packages,
      'audit_log', v_audit_log
    )
  );
end;
$$;

comment on function public.compile_working_papers(uuid, date, date) is
  'SC-7.G.01 read-only working-papers manifest for a closed period. Returns checks plus '
  'bank reconciliation lines, period journals, trial-balance schedule rows, receipt audit '
  'packages and audit-log evidence. SECURITY INVOKER; no bundle generation or external I/O.';

revoke all on function public.compile_working_papers(uuid, date, date) from public, anon;
grant execute on function public.compile_working_papers(uuid, date, date) to authenticated;
