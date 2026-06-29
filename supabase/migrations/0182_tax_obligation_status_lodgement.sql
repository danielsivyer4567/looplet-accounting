-- 0182_tax_obligation_status_lodgement.sql - SC-7.E.00 (Phase 7, lodgement write-back)
--
-- Extends the generic obligation_status overlay (0123) with a link to the
-- append-only lodgements ledger (0181). A real lodgement can now be tied back to
-- its computed v_tax_calendar obligation without replacing the existing
-- per-obligation status write-back used by BAS and super.
--
-- MIGRATION NUMBER: ledger planned 0173, but 0173-0181 are already assigned.
-- Reassigned to 0182 per the drift rule; sequential repo head is 0181_lodgements.

alter table public.obligation_status
  add column lodgement_id uuid references public.lodgements (id) on delete set null,
  add column lodged_at timestamptz;

alter table public.obligation_status
  drop constraint if exists obligation_status_status_check;

alter table public.obligation_status
  add constraint obligation_status_status_check
    check (status in ('in_progress', 'lodged', 'accepted', 'paid', 'done')),
  add constraint obligation_status_lodgement_requires_lodged_at
    check (lodgement_id is null or lodged_at is not null),
  add constraint obligation_status_accepted_requires_lodgement
    check (status <> 'accepted' or lodgement_id is not null);

comment on column public.obligation_status.lodgement_id is
  'Optional link to the append-only lodgements ledger row that completed this obligation.';

comment on column public.obligation_status.lodged_at is
  'Timestamp when the linked lodgement completed enough to mark this obligation as lodged/accepted.';

create index obligation_status_lodgement_idx
  on public.obligation_status (lodgement_id)
  where lodgement_id is not null and deleted_at is null;

create or replace function public.obligation_status_lodgement_org_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_lodgement_org uuid;
begin
  if new.lodgement_id is null then
    return new;
  end if;

  select l.organization_id
    into v_lodgement_org
    from public.lodgements l
   where l.id = new.lodgement_id;

  if v_lodgement_org is null then
    raise exception 'obligation_status.lodgement_id % does not reference an accessible lodgement', new.lodgement_id
      using errcode = 'foreign_key_violation';
  end if;

  if v_lodgement_org is distinct from new.organization_id then
    raise exception 'obligation_status organization_id must match linked lodgement organization_id'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger obligation_status_lodgement_org_guard
  before insert or update of organization_id, lodgement_id on public.obligation_status
  for each row execute function public.obligation_status_lodgement_org_guard();

-- Rewrite v_tax_calendar: preserve the first 17 columns from 0123, but make a
-- linked lodged/accepted row collapse the computed stage/status to "done" and
-- append lodgement metadata for Phase-7 history/UI reads.
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
  base.organization_id,
  base.obligation_key,
  base.category,
  base.title,
  base.period_label,
  base.period_start,
  base.period_end,
  base.due_date,
  base.fy_start_year,
  base.display_name,
  base.description,
  base.cadence,
  base.default_lead_days,
  base.sort_order,
  base.days_until_due,
  case
    when os.lodgement_id is not null and os.status in ('lodged', 'accepted') then 'done'::text
    else base.stage
  end as stage,
  case
    when os.lodgement_id is not null and os.status in ('lodged', 'accepted') then 'done'::text
    else coalesce(os.status, base.stage)
  end as status,
  os.lodgement_id,
  os.lodged_at
from base
  left join public.obligation_status os
    on os.organization_id = base.organization_id
   and os.obligation_key = base.obligation_key
   and os.period_label = base.period_label
   and os.deleted_at is null;
