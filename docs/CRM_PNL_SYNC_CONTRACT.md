# Contract: Looplet Accounting → Looplet CRM live P&L push

**Status:** Accounting side built; CRM receiver not yet built. This doc is the
interface both sides build against. Hand it to the CRM team.
**Owner of this contract:** Accounting (it controls what leaves the system).
**Last updated:** 2026-07-03. **Payload `schema_version`: 1.**

Two **separate** Supabase projects — no shared DB, no shared auth. The only
connection is a plain server-to-server HTTPS POST from Accounting to a CRM
endpoint, carrying a shared secret. (There is no SSH tunnel or DB link, by
design — those would be fragile between two managed projects.)

---

## 1. Direction & responsibilities

```
ACCOUNTING (built)                                    CRM (to build)
------------------                                    --------------
pg_cron every 15 min                                  1 HTTPS endpoint that:
  → enqueue_crm_pnl_sync_jobs()   durable queue         - verifies the bearer secret
    → automation-worker           retries x3            - reads the JSON body
      → crm-pnl-sync-push  ── HTTPS POST ──────────────►- UPSERTS by crm_organization_id
         (reads views only)        Bearer secret        - returns 2xx after persisting
```

- **Accounting pushes; CRM receives.** The CRM never pulls from Accounting for
  this feature. (A separate inbound path — CRM → Accounting via the
  `crm_sync_log` table — exists as scaffolding but is out of scope here.)
- Accounting reads **only two views** (`v_job_pnl`,
  `v_organization_realtime_pnl`), never raw tables, so Accounting's internal
  schema can change without breaking the CRM. **The CRM must only depend on the
  payload below, never on Accounting's tables.**

---

## 2. Transport & auth

| | |
|---|---|
| Method | `POST` |
| URL | CRM provides it → Accounting sets it as secret `CRM_SYNC_ENDPOINT_URL` |
| `Content-Type` | `application/json` |
| Auth header | `Authorization: Bearer <shared secret>` |
| Shared secret | Both sides store the **same value**. Accounting reads it from `CRM_SYNC_SECRET`; the CRM must reject any request whose bearer token ≠ that value. |
| TLS | HTTPS only. The secret travels in the header, never in the URL. |

**CRM must:** compare the bearer token with a **constant-time** comparison (not
`==`), return `401` on mismatch, and treat the secret as rotatable (read it from
its own env/secret store, not hard-coded). Rotation = set the new value on both
sides; there is no handshake.

### The two secrets to coordinate (the only blocker to going live)

1. `CRM_SYNC_ENDPOINT_URL` — the CRM gives Accounting its receiver URL.
2. `CRM_SYNC_SECRET` — a shared random string both sides store under this name
   (Accounting) / whatever the CRM calls its equivalent.

Until both are set on the Accounting side, `crm-pnl-sync-push` returns `503`
**by design** and the job retries/dead-letters visibly — it never silently
no-ops. So "not configured yet" is safe, not lossy.

---

## 3. Payload (exact shape, `schema_version: 1`)

Every field below is what Accounting emits today (verified against
`crm-pnl-sync-push/index.ts`). **All money is integer cents** — never floats.
Divide by 100 for dollars at display time.

```jsonc
{
  "schema_version": 1,                       // int. Only bumps on a BREAKING change.
  "crm_organization_id": "8f3c…-uuid",       // string(uuid). THE JOIN KEY → the CRM org/customer.
  "updated_at": "2026-07-03T04:15:02.331Z",  // ISO-8601 UTC. Snapshot time = the version stamp.
  "idempotency_key": "…orgId:2026-07-03T04:15:02.331Z", // string. See §5 — a VERSION stamp, not a forever-dedupe key.

  "organization": {                          // object | null  (null if the org P&L view has no row yet)
    "revenue_inc_gst_cents": 1234500,        // int. Revenue INCLUDING GST.
    "total_cost_cents": 780000,              // int. All attributed costs.
    "gross_profit_cents": 454500,            // int. revenue − cost.
    "tax_set_aside_cents": 90000,            // int. Estimated tax to reserve.
    "really_yours_cents": 364500             // int. Owner's take after tax set-aside ("really yours").
  },

  "jobs": [                                  // array. FULL current set for this org each push (may be []).
    {
      "job_id": "a1b2…-uuid",                // string(uuid). Stable per job.
      "job_number": "AFG-1042",              // string | null
      "job_name": "Smith fence — 42 Oak St", // string | null
      "job_status": "in_progress",           // string | null (Accounting's status text)
      "revenue_inc_gst_cents": 550000,       // int (incl GST)
      "total_cost_cents": 320000,            // int
      "gross_profit_cents": 230000,          // int
      "budget_cents": 500000                 // int | null
    }
  ]
}
```

**Nullability that matters:** `organization` can be `null`; `job_number`,
`job_name`, `job_status`, `budget_cents` can each be `null`. `jobs` can be an
empty array. The receiver must not assume any of these are present.

**Unknown fields:** the CRM must **ignore fields it doesn't recognise** rather
than reject — that's what lets Accounting add fields without a `schema_version`
bump. Only a *breaking* change (renamed/removed/retyped field) bumps the
version.

---

## 4. Receiver requirements (the CRM side)

The single most important rule:

> **Upsert, last-writer-wins. Never append.**

Because the same org is pushed repeatedly (every 15 min, plus on-event later),
an append-only receiver would pile up duplicates. Concretely:

- **Org summary:** one row per `crm_organization_id`. Upsert on that key.
- **Jobs:** one row per `(crm_organization_id, job_id)`. Upsert on that pair.
- **Persist before you 2xx.** Return a 2xx status code **only after** the data
  is durably stored (or safely queued). Accounting treats a 2xx as "delivered"
  and will not resend that snapshot; a non-2xx triggers retry (§6).

### Response contract

| CRM returns | Accounting does |
|---|---|
| `2xx` | Marks the job done. |
| `401` / `403` | Retries up to 3×, then dead-letters (misconfigured secret — fix and it drains). |
| `4xx` (malformed) | Retries up to 3×, then dead-letters (visible in `automation_jobs`). |
| `5xx` / timeout / network error | Retries up to 3×, then dead-letters. |

There is no partial-success protocol: accept the whole payload or fail it. Keep
the endpoint fast (persist-and-ack; do heavy CRM-side fan-out asynchronously) so
Accounting's worker isn't held open.

---

## 5. Ordering & idempotency (read this carefully)

`idempotency_key` is `"<organization_id>:<updated_at>"`, where `updated_at` is
generated **at push time**. Consequences the CRM must design around:

- **It is a snapshot *version* stamp, not a stable dedupe key.** Two pushes of
  the *same underlying numbers* carry *different* keys (different timestamps).
  So do NOT use `idempotency_key` to decide "have I seen this data before" — you
  can't dedupe identical snapshots by it, and a retry of one job produces a *new*
  key (the function re-runs and re-stamps).
- **Use `updated_at` for ordering.** To be safe against out-of-order delivery,
  store the last-applied `updated_at` per org and **ignore a payload whose
  `updated_at` is older** than what you've already applied. That gives you
  monotonic last-writer-wins regardless of retries or reordering.
- The upsert-by-org / upsert-by-(org,job) model in §4 is already
  replay-safe: re-applying the same or a newer snapshot is a no-op or an
  overwrite, never a duplicate. The `updated_at` guard just prevents an old
  retry from clobbering a newer snapshot.

**Vanished jobs (one open decision):** the `jobs` array is the *full current
set* for the org each push. If a job is archived/deleted in Accounting it simply
stops appearing. Decide with Accounting whether the CRM should (a) leave stale
job rows as-is, or (b) reconcile — mark/remove CRM job-P&L rows for that org not
present in the latest snapshot. **(b) is cleaner** but needs the CRM to key its
delete on "not in this push's `job_id` set for this org." Recommend (b).

---

## 6. Delivery model & cadence (Accounting side, for CRM's awareness)

- **Durable queue, not fire-and-forget.** Each push is a row in
  `automation_jobs`; a worker crash mid-push loses nothing — the job is
  re-claimed.
- **Retries:** `max_attempts = 3`, then the job dead-letters and is visible for
  operators. No silent loss.
- **Cadence today:** `pg_cron` enqueues every **15 minutes** for every org that
  has a `crm_organization_id`. So worst-case staleness is ~15 min.
- **Roadmap → near-real-time:** Accounting will add **event-driven enqueue** —
  when a P&L-affecting event lands (bill posts to GL, invoice paid, bank txn
  attributed to a job) it enqueues the sync immediately (`run_after = now()`),
  so the CRM updates within seconds. The 15-min cron stays as a safety-net
  reconciliation sweep. **This changes cadence only — the payload/contract above
  is unchanged**, so the CRM receiver built today keeps working as-is.

---

## 7. CRM receiver — reference pseudocode

```ts
// POST /looplet-accounting/pnl   (whatever path the CRM chooses → CRM_SYNC_ENDPOINT_URL)
export async function handler(req) {
  // 1. Auth — constant-time compare against the shared secret.
  const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  if (!timingSafeEqual(token, env.LOOPLET_ACCOUNTING_SYNC_SECRET)) return status(401);

  // 2. Parse.
  const p = await req.json();
  if (p.schema_version !== 1) return status(400, 'unsupported schema_version');
  if (!p.crm_organization_id) return status(400, 'missing crm_organization_id');

  // 3. Ordering guard — ignore stale snapshots.
  const last = await getLastAppliedUpdatedAt(p.crm_organization_id);
  if (last && p.updated_at <= last) return status(200); // already have newer/equal — no-op

  // 4. Upsert, last-writer-wins. Persist BEFORE returning 2xx.
  await tx(async (db) => {
    if (p.organization) await db.upsertOrgPnl(p.crm_organization_id, p.organization);
    const seen = new Set();
    for (const j of p.jobs ?? []) {
      await db.upsertJobPnl(p.crm_organization_id, j); // key: (crm_organization_id, job_id)
      seen.add(j.job_id);
    }
    await db.deleteJobPnlNotIn(p.crm_organization_id, seen); // §5 option (b) — recommended
    await db.setLastAppliedUpdatedAt(p.crm_organization_id, p.updated_at);
  });

  // 5. Ack only after durable persist.
  return status(200);
}
```

---

## 8. What each side must do to go live

**CRM:**
1. Build the endpoint above; return 2xx only after persisting.
2. Store its copy of the shared secret; verify the bearer constant-time.
3. Give Accounting the endpoint URL.
4. Confirm the "vanished jobs" decision (§5) — recommend option (b).
5. Confirm the join: `crm_organization_id` maps to which CRM entity (org? customer?).

**Accounting:**
1. Set `CRM_SYNC_ENDPOINT_URL` and `CRM_SYNC_SECRET` (unblocks the `503`).
2. Confirm the migration + cron are **live on prod** (this may currently be
   repo-only — verify before expecting pushes).
3. (Roadmap) add the event-driven enqueue trigger for near-real-time.

**Both:** agree the shared secret value out-of-band (not in git).

---

## 9. Worked example

Request Accounting sends:

```
POST https://crm.looplet.app/integrations/accounting/pnl
Authorization: Bearer 7f9a…redacted
Content-Type: application/json

{
  "schema_version": 1,
  "crm_organization_id": "8f3c2b10-…-uuid",
  "updated_at": "2026-07-03T04:15:02.331Z",
  "idempotency_key": "8f3c2b10-…-uuid:2026-07-03T04:15:02.331Z",
  "organization": {
    "revenue_inc_gst_cents": 1234500, "total_cost_cents": 780000,
    "gross_profit_cents": 454500, "tax_set_aside_cents": 90000,
    "really_yours_cents": 364500
  },
  "jobs": [
    { "job_id": "a1b2…-uuid", "job_number": "AFG-1042",
      "job_name": "Smith fence — 42 Oak St", "job_status": "in_progress",
      "revenue_inc_gst_cents": 550000, "total_cost_cents": 320000,
      "gross_profit_cents": 230000, "budget_cents": 500000 }
  ]
}
```

Successful CRM response: `200 OK` (body ignored by Accounting).
