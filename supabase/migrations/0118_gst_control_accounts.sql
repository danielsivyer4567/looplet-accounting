-- 0118_gst_control_accounts.sql — SC-3.B.01 (Phase 3, GST reconciliation)
--
-- system_accounts: a per-org map designating which GL account fills a SYSTEM role
-- (gst_collected / gst_paid to start). This is the GST control-account designation
-- that SC-3.B.02's v_gst_reconciliation joins v_trial_balance to. chart_of_accounts
-- (0071) carries only account_type and has no GST-control concept, so the
-- org→role→account mapping is added here.
--
-- Mechanism choice (the ledger left it open: system_accounts map vs reserved
-- codes): an explicit map table, because (a) it references account_id (uuid),
-- exactly how journal_lines / v_trial_balance key accounts — so the reconciliation
-- view joins on account_id with referential integrity; (b) reserved per-org code
-- conventions are fragile (every org names its COA differently); (c) it generalises
-- to future system roles without another table. NOT folded into system_defaults —
-- that table is GLOBAL (no organization_id) and jsonb-valued, wrong for a per-org,
-- FK-backed designation.
--
-- MIGRATION NUMBER: reassigned from the ledger's planned 0109 to 0118 per the drift
-- rule (0108–0115 = legal-RAG epic; 0116/0117 = SC-3.A). Verified 0118 free on disk + live.

create table public.system_accounts (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  role            text not null check (role in ('gst_collected', 'gst_paid')),
  account_id      uuid not null references public.chart_of_accounts (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid references auth.users (id),
  deleted_at      timestamptz
);

comment on table public.system_accounts is
  'Per-org designation of the GL account that fills a system role (gst_collected, '
  'gst_paid; extend the role CHECK as more roles land). One live account per role '
  'per org. account_id -> chart_of_accounts. Read by GST reconciliation (SC-3.B.02).';

-- Exactly one LIVE designation per (org, role) — the "one GST-collected / one
-- GST-paid control account resolves per org" guarantee. Soft-deleted rows are
-- excluded so a re-designation (delete old, insert new) doesn't collide.
create unique index system_accounts_org_role_uniq
  on public.system_accounts (organization_id, role)
  where deleted_at is null;

create trigger system_accounts_set_updated_at
  before update on public.system_accounts
  for each row execute function public.set_updated_at();

create trigger system_accounts_audit
  after insert or update or delete on public.system_accounts
  for each row execute function public.audit_log_trigger_v2();

-- RLS: org-scoped via get_accessible_org_ids() — the 4-policy shape of
-- chart_of_accounts and the other org-scoped GL tables.
alter table public.system_accounts enable row level security;

create policy system_accounts_select on public.system_accounts for select
  using (organization_id in (select get_accessible_org_ids()));
create policy system_accounts_insert on public.system_accounts for insert
  with check (organization_id in (select get_accessible_org_ids()));
create policy system_accounts_update on public.system_accounts for update
  using (organization_id in (select get_accessible_org_ids()))
  with check (organization_id in (select get_accessible_org_ids()));
create policy system_accounts_delete on public.system_accounts for delete
  using (organization_id in (select get_accessible_org_ids()));

grant select, insert, update, delete on public.system_accounts to authenticated;
