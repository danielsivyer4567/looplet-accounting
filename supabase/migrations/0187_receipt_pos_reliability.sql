-- 0187_receipt_pos_reliability.sql
-- Strengthen POS receipt retries and completed-sale provenance.
-- POS terminals and webhook clients can provide Idempotency-Key / idempotency_key; when absent,
-- receipt-webhook derives a key from merchant + receipt number. The unique partial index makes
-- retry handling database-enforced per organisation + source channel + event type. Refund/void
-- events are stored as auditable evidence and do not create bills until an explicit accounting
-- credit workflow exists.

alter table public.receipt_events
  add column if not exists idempotency_key text,
  add column if not exists event_type text not null default 'sale',
  add column if not exists related_receipt_event_id uuid references public.receipt_events(id) on delete set null,
  add column if not exists payment_reference text,
  add column if not exists terminal_id text,
  add column if not exists store_id text;

comment on column public.receipt_events.idempotency_key is
  'Retry-safe POS receipt idempotency key. Explicit keys come from Idempotency-Key/body/payload; '
  'otherwise receipt-webhook derives one from merchant + receipt number.';
comment on column public.receipt_events.event_type is
  'POS receipt lifecycle event: sale, refund, or void. Only sale events create bills.';
comment on column public.receipt_events.related_receipt_event_id is
  'For refund/void events, optional pointer to the original sale receipt event when the POS payload can identify it.';
comment on column public.receipt_events.payment_reference is
  'POS/EFTPOS payment, authorisation, transaction, or refund reference supplied by the merchant system.';
comment on column public.receipt_events.terminal_id is
  'POS/EFTPOS terminal identifier supplied by the merchant system.';
comment on column public.receipt_events.store_id is
  'Merchant store/location identifier supplied by the POS system.';

alter table public.receipt_events
  drop constraint if exists receipt_events_event_type_check,
  add constraint receipt_events_event_type_check
    check (event_type in ('sale', 'refund', 'void'));

alter table public.receipt_events
  drop constraint if exists receipt_events_status_check,
  add constraint receipt_events_status_check
    check (status in ('received', 'processed', 'flagged', 'personal', 'failed', 'refunded', 'voided'));

drop index if exists receipt_events_org_source_idempotency_uniq;
create unique index if not exists receipt_events_org_source_event_idempotency_uniq
  on public.receipt_events (organization_id, source_channel, event_type, idempotency_key)
  where idempotency_key is not null;

drop index if exists receipt_events_org_merchant_receipt_uniq;
create unique index if not exists receipt_events_org_source_event_merchant_receipt_uniq
  on public.receipt_events (organization_id, source_channel, event_type, merchant_name, receipt_number)
  where receipt_number is not null;

create index if not exists receipt_events_org_event_type_time_idx
  on public.receipt_events (organization_id, event_type, purchase_at desc);

create index if not exists receipt_events_related_event_idx
  on public.receipt_events (related_receipt_event_id)
  where related_receipt_event_id is not null;

create index if not exists receipt_sync_jobs_org_retry_idx
  on public.receipt_sync_jobs (organization_id, status, next_attempt_at, created_at)
  where status in ('pending', 'queued', 'failed');
