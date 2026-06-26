-- 0124_super_batch.sql — SC-3.F.01 (Phase 3, super batch)
--
-- A quarterly super-guarantee (SG) batch model + builder. pay_slips carries
-- super_guarantee_cents but no payment status, so batch state lives on the new
-- tables. Pure data + RPC, no external calls (the gated SuperStream SEND is
-- SC-3.G).
--
--   super_batches      — one SG batch per org+FY-quarter, status
--                        draft → approved → sent → confirmed, with the rolled-up
--                        total and line count.
--   super_batch_lines  — one line per employee: name snapshot + summed SG.
--                        SuperStream needs a fund USI + member number too, but
--                        `employees` has NO fund columns yet (documented gap), so
--                        fund_usi / member_number are nullable and unpopulated —
--                        a later slice adds employee fund details and backfills.
--
--   generate_super_batch(org, fy_start_year, quarter) — sums each employee's
--     super_guarantee_cents over the finalised (approved/paid) pay runs whose
--     pay_date falls in the AU FY quarter (same au_bas_quarter mapper as the BAS
--     PAYG fn), builds a fresh draft batch + lines, and returns the batch id.
--     Idempotent: replaces any existing draft/approved batch for the quarter;
--     refuses if a sent/confirmed batch already exists.
--
-- SECURITY INVOKER: writes go through the caller's RLS (org-scoped), reads of
-- pay_slips/pay_runs are RLS-scoped too — a caller can only build a batch for an
-- org they can access. Money-movement (send) is gated by approvals in SC-3.G.
--
-- MIGRATION NUMBER: reassigned from the ledger's planned 0115 to 0124 per the
-- drift rule (0108–0115 legal-RAG; 0116–0123 SC-3.A..3.E). Verified free.

do $$ begin
  create type public.super_batch_status as enum ('draft', 'approved', 'sent', 'confirmed');
exception when duplicate_object then null; end $$;

create table public.super_batches (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations (id) on delete cascade,
  fy_start_year     integer not null,
  quarter           integer not null check (quarter between 1 and 4),
  status            public.super_batch_status not null default 'draft',
  total_super_cents bigint not null default 0,
  line_count        integer not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid references auth.users (id),
  deleted_at        timestamptz
);

comment on table public.super_batches is
  'Quarterly super-guarantee batch per org+FY-quarter (status draft→approved→sent→confirmed). '
  'Built by generate_super_batch from pay_slips SG; sent (gated) by SC-3.G.';

create index super_batches_org_period_idx
  on public.super_batches (organization_id, fy_start_year, quarter)
  where deleted_at is null;

create table public.super_batch_lines (
  id              uuid primary key default gen_random_uuid(),
  batch_id        uuid not null references public.super_batches (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  employee_id     uuid not null references public.employees (id),
  employee_name   text not null,
  super_cents     bigint not null,
  fund_usi        text,  -- SuperStream fund USI — null until employee fund details land (gap)
  member_number   text,  -- SuperStream member number — null until employee fund details land (gap)
  created_at      timestamptz not null default now()
);

comment on table public.super_batch_lines is
  'Per-employee line of a super_batch: name snapshot + summed SG. fund_usi/member_number '
  'are nullable (employees has no fund details yet — a later slice backfills for SuperStream).';

create index super_batch_lines_batch_idx on public.super_batch_lines (batch_id);

-- updated_at + audit on the parent batch (lines are immutable, rebuilt wholesale).
create trigger super_batches_set_updated_at
  before update on public.super_batches
  for each row execute function public.set_updated_at();
create trigger super_batches_audit
  after insert or update or delete on public.super_batches
  for each row execute function public.audit_log_trigger_v2();

-- RLS: org-scoped via get_accessible_org_ids() on both tables.
alter table public.super_batches enable row level security;
alter table public.super_batch_lines enable row level security;

create policy super_batches_select on public.super_batches for select
  using (organization_id in (select get_accessible_org_ids()));
create policy super_batches_insert on public.super_batches for insert
  with check (organization_id in (select get_accessible_org_ids()));
create policy super_batches_update on public.super_batches for update
  using (organization_id in (select get_accessible_org_ids()))
  with check (organization_id in (select get_accessible_org_ids()));
create policy super_batches_delete on public.super_batches for delete
  using (organization_id in (select get_accessible_org_ids()));

create policy super_batch_lines_select on public.super_batch_lines for select
  using (organization_id in (select get_accessible_org_ids()));
create policy super_batch_lines_insert on public.super_batch_lines for insert
  with check (organization_id in (select get_accessible_org_ids()));
create policy super_batch_lines_delete on public.super_batch_lines for delete
  using (organization_id in (select get_accessible_org_ids()));

grant select, insert, update, delete on public.super_batches to authenticated;
grant select, insert, delete on public.super_batch_lines to authenticated;

-- ---------------------------------------------------------------------------
-- generate_super_batch — build a fresh draft batch from quarterly SG.
-- ---------------------------------------------------------------------------
create or replace function public.generate_super_batch(
  p_org uuid,
  p_fy_start_year integer,
  p_quarter integer
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_batch_id uuid;
begin
  -- Don't clobber a batch that has already been sent/confirmed for this quarter.
  if exists (
    select 1 from super_batches
    where organization_id = p_org and fy_start_year = p_fy_start_year and quarter = p_quarter
      and status in ('sent', 'confirmed') and deleted_at is null
  ) then
    raise exception 'super batch for FY% Q% is already sent/confirmed', p_fy_start_year, p_quarter;
  end if;

  -- Replace any prior in-progress (draft/approved) batch for the quarter (lines cascade).
  delete from super_batches
  where organization_id = p_org and fy_start_year = p_fy_start_year and quarter = p_quarter
    and status in ('draft', 'approved') and deleted_at is null;

  insert into super_batches (organization_id, fy_start_year, quarter, status, created_by)
  values (p_org, p_fy_start_year, p_quarter, 'draft', auth.uid())
  returning id into v_batch_id;

  -- One line per employee with SG > 0 over the finalised pay runs in the quarter,
  -- rolling the inserted lines up onto the batch in the same statement: the CTE's
  -- RETURNING set is the rollup source, so super_batch_lines is never re-scanned.
  with ins as (
    insert into super_batch_lines (batch_id, organization_id, employee_id, employee_name, super_cents)
    select v_batch_id, p_org, ps.employee_id, e.full_name, sum(ps.super_guarantee_cents)
    from pay_slips ps
      join pay_runs pr on pr.id = ps.pay_run_id
      join employees e on e.id = ps.employee_id
      cross join lateral au_bas_quarter(pr.pay_date)
        q(fy_start_year, quarter_num, quarter_start, quarter_end, due_date)
    where ps.organization_id = p_org
      and pr.status in ('approved', 'paid')
      and q.fy_start_year = p_fy_start_year
      and q.quarter_num = p_quarter
      and ps.super_guarantee_cents > 0
    group by ps.employee_id, e.full_name
    returning super_cents
  )
  update super_batches b
  set total_super_cents = coalesce((select sum(super_cents) from ins), 0),
      line_count = (select count(*) from ins)
  where b.id = v_batch_id;

  return v_batch_id;
end;
$$;

comment on function public.generate_super_batch(uuid, integer, integer) is
  'Build a fresh draft super_batch for an org+FY-quarter from pay_slips SG over the '
  'finalised pay runs in that quarter. Idempotent (replaces a prior draft/approved '
  'batch; refuses if already sent/confirmed). Returns the batch id. SECURITY INVOKER.';

revoke all on function public.generate_super_batch(uuid, integer, integer) from public, anon;
grant execute on function public.generate_super_batch(uuid, integer, integer) to authenticated;
