# Cron health: heartbeat + no-success-window monitor (P1-01)

Background cron jobs can fail **silently**. There are two distinct blind spots,
and we now monitor both:

| Layer | What it sees | Blind spot it leaves |
| --- | --- | --- |
| `cron.job_run_details` (pg_cron) | "the HTTP request was enqueued" | marks the job succeeded the instant the request is *queued*, before any response |
| `net._http_response` (pg_net) | the **transport** status code | a job that returns **HTTP 200 yet did nothing useful** still looks green |
| **`cron_heartbeat_*` (this slice)** | the job's own **body-level** success | — |

The third layer is what 0211 adds: a **durable, application-level heartbeat**
each cron edge function can write at the end of its run, carrying an explicit
`success` boolean parsed from its own outcome — independent of HTTP status.

> **Soft failure** is the key concept. A run can be `HTTP 200` yet
> `success = false` (an edge fn that catches its own error and returns
> `{ ok: false }` with a 200; a sweep that processed 0 orgs because of a config
> problem). Transport-level monitoring (`0057_cron_health_monitoring`) calls that
> a success. It is not. The heartbeat records `http_status` (transport) and
> `success` (body-level) as **separate** columns, and only `success` drives the
> staleness verdict.

## What ships in 0211 (infrastructure only)

`supabase/migrations/0211_cron_heartbeat.sql`:

- **`cron_heartbeat_jobs`** — registry, one row per monitored job. Holds the
  freshness SLA: `expected_interval` (how often the job should succeed) +
  `grace_period` (slack before it is flagged). `enabled = false` mutes a job
  (e.g. an inert / not-yet-deployed cron) without losing history.
- **`cron_heartbeat_runs`** — append-only heartbeat log. `success` is the
  body-level outcome; `http_status` is transport-only, kept for correlation with
  0057 / `net._http_response`.
- **`record_cron_heartbeat(job_name, success, http_status, detail, expected_interval)`**
  — the recorder. Inserts a run and self-registers the job on its first
  heartbeat. `service_role` only.
- **`cron_no_success_windows()`** — the monitor. Returns one row per **enabled,
  stale** job: any job with **no `success = true` run** inside
  `expected_interval + grace_period`, *including jobs that have never succeeded*.
  Each row also reports the most-recent run of any kind, so an operator can
  distinguish "never ran / stale" from "ran but **reported failure**".
  `service_role` only.

`supabase/functions/_shared/cron/heartbeat.ts`:

- **`recordHeartbeat(client, jobName, { ok, httpStatus?, detail?, expectedInterval? })`**
  — a helper edge functions import to write a heartbeat. It **never throws**: a
  monitoring write must not be able to fail the job it observes, so all errors
  are swallowed and returned in the result.

`src/components/ops/OperatorHealth.tsx`:

- A self-contained, **read-only** panel over `cron_no_success_windows()`. It
  renders stale jobs, and flags `HTTP 200 + success=false` rows as
  "Ran, reported failure (HTTP 200)" distinct from "Never ran" / "No success in
  window". **Not routed** in this slice.

## What this slice deliberately does NOT do

- **It does not wire `recordHeartbeat()` into any existing cron function.**
  Adoption is a later slice — each function must opt in at the end of its run.
  Until then `cron_heartbeat_runs` is empty and `cron_no_success_windows()`
  returns nothing (no registered jobs).
- **It does not route `OperatorHealth`.** Mounting it behind an admin route comes
  later.
- The monitor / recorder are `service_role`-only. In production the
  `OperatorHealth` panel should read `cron_no_success_windows()` through a
  service-role ops edge function (the same pattern `cron_health_summary()` uses),
  not the anon client.

## Adoption sketch (later slice)

At the end of a cron edge function's run, with the service-role admin client:

```ts
import { recordHeartbeat } from '../_shared/cron/heartbeat.ts';

await recordHeartbeat(admin, 'notifications-cron', {
  ok: result.errors.length === 0, // body-level outcome, NOT the HTTP status
  httpStatus: 200,
  detail: { orgs: result.orgCount, errors: result.errors.length },
  expectedInterval: '1 day', // used only on first heartbeat to self-register
});
```

## Live proof (deploy-gated)

Cannot be live-tested from the worktree. After 0211 is applied:

1. Register a job with a short window and record a single **failed** heartbeat
   (no success):

   ```sql
   select public.record_cron_heartbeat(
     'demo-cron', false, 200, '{"reason":"token expired"}'::jsonb, interval '1 minute');
   ```

2. The job has had **no success in its window**, so it appears in the monitor:

   ```sql
   select job_name, last_success_at, last_run_success, last_run_http_status, seconds_overdue
   from public.cron_no_success_windows();
   -- => demo-cron | NULL | f | 200 | <positive>
   ```

   Note `last_run_http_status = 200` with `last_run_success = false` — the
   HTTP-200-but-failed soft failure is correctly surfaced as stale.

3. Recording a **successful** heartbeat clears it from the monitor:

   ```sql
   select public.record_cron_heartbeat('demo-cron', true, 200, '{}'::jsonb, null);
   select count(*) from public.cron_no_success_windows() where job_name = 'demo-cron';
   -- => 0
   ```

Run the above inside a single `BEGIN … ROLLBACK` on prod (per the rolled-back
live-test recipe) so it leaves no residue.
