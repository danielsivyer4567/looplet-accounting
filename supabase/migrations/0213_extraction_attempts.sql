-- 0213_extraction_attempts.sql - SLICE P1-03 (OCR repair + accuracy gate)
--
-- A durable, append-only audit of every OCR/extraction run against a bill. The
-- production audit found bills-extract flipped status to 'verified' before OCR
-- even ran, so a null-amount, ~0.41-confidence read still looked "verified" and
-- there was NO record of how a bill's fields were (or weren't) produced.
--
-- This table records each attempt with the provider used, the numeric quality
-- score, the gate outcome (verified | needs_review | rejected | error), and the
-- raw model output, so:
--   * a failed/low-confidence extraction is visible (the bill stays an exception
--     for manual review rather than silently "verified"),
--   * re-extraction history is auditable (which provider, when, what score),
--   * the accuracy gate can be measured over time (coverage can't regress
--     silently).
--
-- Writes come only from the service_role edge function (bills-extract); members
-- may read their org's attempts (the BillDetail exception UI shows the latest).
-- It is system-owned audit data, never user-editable.
--
-- MIGRATION NUMBER: sequential repo head is 0210_require_role_accepted; 0211/0212
-- are reserved by sibling finish-line slices. 0213 per the slice spec.

create table public.extraction_attempts (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations (id) on delete cascade,
  bill_id            uuid not null references public.bills (id) on delete cascade,
  -- Which OCR adapter/route produced this attempt (e.g. 'anthropic', 'minimax',
  -- 'text-only', or 'none' when the file could not be read at all).
  provider           text not null check (length(btrim(provider)) > 0),
  -- 'text' | 'vision' | 'cache' | 'manual' — how the data was obtained.
  method             text not null default 'vision'
                       check (method in ('text', 'vision', 'cache', 'manual', 'none')),
  -- 0–1 quality score from quality.ts::scoreExtraction.
  confidence         numeric(4, 3) check (confidence is null or (confidence between 0 and 1)),
  -- The verification gate's verdict for this attempt.
  status             text not null
                       check (status in ('verified', 'needs_review', 'rejected', 'error')),
  -- Human-readable reasons the gate did not auto-verify (surfaced in the UI).
  reasons            jsonb not null default '[]'::jsonb check (jsonb_typeof(reasons) = 'array'),
  -- Raw model output / error text. Capped by the writer; kept for audit + debug.
  raw                text,
  -- Structured extracted payload as the gate saw it (for replay / regression).
  extracted          jsonb not null default '{}'::jsonb check (jsonb_typeof(extracted) = 'object'),
  created_at         timestamptz not null default now(),
  created_by         uuid references auth.users (id)
);

comment on table public.extraction_attempts is
  'Append-only audit of every OCR/extraction run against a bill (SLICE P1-03). '
  'Records provider, method, 0-1 quality score, gate outcome '
  '(verified|needs_review|rejected|error), reasons, and raw output so a '
  'failed/low-confidence extraction is visible as an exception rather than '
  'silently "verified". Written by the service_role bills-extract function only.';

comment on column public.extraction_attempts.confidence is
  '0-1 quality score from quality.ts::scoreExtraction. NULL when the file could not be read at all.';
comment on column public.extraction_attempts.status is
  'Gate outcome: verified (books can trust it), needs_review (real bill we could '
  'not fully read - an exception), rejected (not a financial document), error (the run threw).';

create index extraction_attempts_bill_idx
  on public.extraction_attempts (bill_id, created_at desc);

create index extraction_attempts_org_status_idx
  on public.extraction_attempts (organization_id, status, created_at desc);

-- Append-only: forbid UPDATE and DELETE so the audit trail cannot be rewritten.
create or replace function public.extraction_attempts_append_only()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'extraction_attempts is append-only (% forbidden)', tg_op
    using errcode = 'insufficient_privilege';
  return null;
end;
$$;

create trigger extraction_attempts_append_only
  before update or delete on public.extraction_attempts
  for each row execute function public.extraction_attempts_append_only();

create trigger extraction_attempts_audit
  after insert on public.extraction_attempts
  for each row execute function public.audit_log_trigger_v2();

alter table public.extraction_attempts enable row level security;

-- Members of the org may read their attempts (the exception UI needs the
-- latest). No member INSERT/UPDATE/DELETE policy: only service_role (which
-- bypasses RLS) writes, and the append-only trigger blocks rewrites regardless.
create policy extraction_attempts_select on public.extraction_attempts for select
  using (organization_id in (select get_accessible_org_ids()));

revoke all on table public.extraction_attempts from public, anon, authenticated;
grant select on table public.extraction_attempts to authenticated;
