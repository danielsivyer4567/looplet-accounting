-- 0123_obligation_status.sql — SC-3.E.02 (Phase 3, guided BAS prep)
--
-- Adds the obligation-status overlay that v_tax_calendar (0089, purely computed)
-- deliberately deferred ("Status overlay arrives in the next slice"). Two parts,
-- ONE atomic unit (the view can't report status without the table):
--
-- 1. obligation_status — a per-org persisted status for one obligation-period,
--    keyed on (organization_id, obligation_key, period_label) so it joins straight
--    into v_tax_calendar's existing columns. This is the GENERIC write-back table
--    reused by super (SC-3.H.02) and Phase 7 lodgements (SC-7.E) — and Phase 7
--    SC-7.E.00 expects exactly this key, so it extends rather than recreates it.
--
-- 2. v_tax_calendar rewrite (CREATE OR REPLACE — preserves grants) — LEFT JOINs
--    obligation_status and appends a `status` column = COALESCE(persisted status,
--    the computed time-stage). Existing 16 columns are reproduced verbatim (via a
--    `base` CTE so the stage CASE isn't duplicated); `status` is appended last so
--    every existing consumer (useTaxCalendar, ask-bot context, tax-timeline) is
--    unaffected. security_invoker preserved → RLS scopes per caller.
--
-- Marking a BAS lodged = upserting obligation_status (org, 'bas', 'Q{n} FY{y}-{yy}',
-- 'lodged') — the view then reports status='lodged' for that quarter.
--
-- MIGRATION NUMBER: reassigned from the ledger's planned 0114 to 0123 per the drift
-- rule (0108–0115 legal-RAG; 0116–0122 SC-3.A/3.B/3.C/3.D/3.E.01). Verified free.

create table public.obligation_status (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  obligation_key  text not null,
  period_label    text not null,
  status          text not null check (status in ('in_progress', 'lodged', 'paid', 'done')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid references auth.users (id),
  deleted_at      timestamptz,
  -- one status row per obligation-period per org (the upsert arbiter; non-partial
  -- so PostgREST upsert onConflict resolves cleanly — re-lodge sets deleted_at=null).
  unique (organization_id, obligation_key, period_label)
);

comment on table public.obligation_status is
  'Per-org persisted status for a tax obligation-period (org, obligation_key, '
  'period_label), overlaid onto v_tax_calendar. Generic lodge/pay write-back reused '
  'by super (SC-3.H.02) and Phase 7 lodgements (SC-7.E).';

create trigger obligation_status_set_updated_at
  before update on public.obligation_status
  for each row execute function public.set_updated_at();

create trigger obligation_status_audit
  after insert or update or delete on public.obligation_status
  for each row execute function public.audit_log_trigger_v2();

alter table public.obligation_status enable row level security;

create policy obligation_status_select on public.obligation_status for select
  using (organization_id in (select get_accessible_org_ids()));
create policy obligation_status_insert on public.obligation_status for insert
  with check (organization_id in (select get_accessible_org_ids()));
create policy obligation_status_update on public.obligation_status for update
  using (organization_id in (select get_accessible_org_ids()))
  with check (organization_id in (select get_accessible_org_ids()));
create policy obligation_status_delete on public.obligation_status for delete
  using (organization_id in (select get_accessible_org_ids()));

grant select, insert, update, delete on public.obligation_status to authenticated;

-- Rewrite v_tax_calendar: same 16 columns + a status overlay. CREATE OR REPLACE
-- keeps the view's grants; the `base` CTE is the verbatim 0089 body.
create or replace view public.v_tax_calendar
  with (security_invoker = true) as
with base as (
  select o.id as organization_id,
    g.obligation_key,
    g.category,
    g.title,
    g.period_label,
    g.period_start,
    g.period_end,
    g.due_date,
    g.fy_start_year,
    t.display_name,
    t.description,
    t.cadence,
    coalesce(t.default_lead_days, 14) as default_lead_days,
    coalesce(t.sort_order, 100) as sort_order,
    g.due_date - current_date as days_until_due,
    case
      when g.due_date < current_date then 'overdue'::text
      when g.due_date <= (current_date + coalesce(t.default_lead_days, 14)) then 'due_soon'::text
      else 'upcoming'::text
    end as stage
  from organizations o
    cross join lateral generate_tax_obligations(o.id, current_date - 90, current_date + 400)
      g(obligation_key, category, title, period_label, period_start, period_end, due_date, fy_start_year)
    left join tax_obligation_types t on t.key = g.obligation_key
  where o.deleted_at is null
)
select
  base.*,
  coalesce(os.status, base.stage) as status
from base
  left join public.obligation_status os
    on os.organization_id = base.organization_id
   and os.obligation_key = base.obligation_key
   and os.period_label = base.period_label
   and os.deleted_at is null;
