-- Migration: advisor_work_proofs
-- SC-09 / P0-05 — Deploy-gated; must be applied live before proof capture.
-- Tracks proof-of-work records emitted by the accountant-session-digest edge function.

create table if not exists public.advisor_work_proofs (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organisations(id) on delete cascade,
  session_id    uuid not null,
  advisor_id    uuid references auth.users(id),
  proof_type    text not null check (proof_type in ('session_digest', 'review_decision', 'lodgement_prep')),
  payload       jsonb not null default '{}',
  captured_at   timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

alter table public.advisor_work_proofs enable row level security;

-- Org members can read their own org's proof records
create policy "org members can read advisor_work_proofs"
  on public.advisor_work_proofs for select
  using (
    org_id in (
      select organisation_id from public.organisation_users
      where user_id = auth.uid()
    )
  );

-- Only service_role / edge functions may insert proofs
revoke insert, update, delete on public.advisor_work_proofs from authenticated, anon;

comment on table public.advisor_work_proofs is
  'Immutable proof-of-work records produced by advisor edge functions (SC-09). '
  'Deploy-gated: apply migration then run accountant-session-digest to generate seed proofs.';
