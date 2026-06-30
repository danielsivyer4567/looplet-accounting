# Browser Automation Runbook

## What this is

The `browser_collect` job kind lets an external headless browser (e.g. Playwright)
read pages and write results back to Looplet as structured evidence. The database
schema (`browser_sessions`, `browser_job_runs`) and the job dispatcher stub are
deployed, but **no browser runner ships inside this repo**.

Browser jobs are **opt-in only**. The automation-worker dispatcher returns
`not_supported` and completes the job gracefully when no runner is attached, so
a stale `browser_collect` job never blocks the queue.

## Opt-in rule

Browser automation MUST NOT be used for:
- Any write that affects accounting records (bills, GL entries, payments)
- Automated lodgement of any ATO, DSP, or SBR document
- Any action that cannot be reviewed by a human before it takes effect

Permitted uses: read-only data collection, screenshot evidence, form pre-fill
*preview* (not submit).

## Artifact contract

A browser runner must write results through the service_role client:

```
browser_sessions row:
  org_id      uuid    — the org the session belongs to
  purpose     text    — human-readable intent ("scrape supplier portal for invoice list")
  status      text    — pending → running → completed | failed

browser_job_runs row (one per URL visited):
  session_id       uuid    — FK to the session above
  target_url       text    — URL visited
  screenshot_path  text    — storage path (e.g. "browser/org-id/session-id/page-001.png")
  console_errors   jsonb   — array of { level, message, url, line }
  failed_responses jsonb   — array of { url, status, method }
  final_url        text    — after any redirects
  duration_ms      integer — wall-clock ms for the page load
```

The runner **never** inserts directly into `bills`, `bank_transactions`, or any
accounting table. If it collects a document, it enqueues a `bill_extract` job
via `enqueue_automation_job` and stores the raw artifact in `automation_artifacts`.

## Local runner example (pseudocode)

```js
// Not a checked-in runner — pseudocode only.
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

async function runBrowserSession(job) {
  // 1. Create a session row
  const { data: session } = await admin.from('browser_sessions').insert({
    org_id: job.organization_id,
    created_by: null,                 // system-initiated
    purpose: job.payload.purpose,
    status: 'running',
    started_at: new Date().toISOString(),
  }).select('id').single();

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // 2. Capture console errors
  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push({ level: 'error', message: msg.text() });
  });

  // 3. Visit the target URL
  const t0 = Date.now();
  const response = await page.goto(job.payload.target_url, { waitUntil: 'networkidle' });
  const durationMs = Date.now() - t0;

  // 4. Take a screenshot and upload to Storage
  const screenshotBytes = await page.screenshot({ fullPage: true });
  const screenshotPath = `browser/${job.organization_id}/${session.id}/page-001.png`;
  await admin.storage.from('artifacts').upload(screenshotPath, screenshotBytes);

  // 5. Write the run row
  await admin.from('browser_job_runs').insert({
    session_id: session.id,
    target_url: job.payload.target_url,
    screenshot_path: screenshotPath,
    console_errors: consoleErrors,
    failed_responses: [],           // populate from response interception
    final_url: page.url(),
    duration_ms: durationMs,
  });

  // 6. Close the session
  await admin.from('browser_sessions').update({
    status: 'completed',
    ended_at: new Date().toISOString(),
  }).eq('id', session.id);

  await browser.close();
}
```

## Claiming browser_collect jobs

The automation-worker returns `not_supported` for `browser_collect` and marks
the job **completed** immediately. A real runner should claim its own jobs before
the worker does, or use a separate claim loop filtered to `job_kinds: ['browser_collect']`.

```js
const { data: jobs } = await admin.rpc('claim_automation_jobs', {
  p_worker_id: 'browser-runner-001',
  p_job_kinds: ['browser_collect'],
  p_limit: 5,
  p_lock_secs: 300,
});
```

If a browser_collect job arrives and no runner is active, the worker's
`not_supported` path ensures it completes after one attempt — no dead-letter,
no queue blockage.
