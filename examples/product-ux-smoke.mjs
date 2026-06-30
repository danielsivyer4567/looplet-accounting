#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, relative } from 'node:path';
import process from 'node:process';
import { chromium, firefox } from 'playwright';

const rootDir = process.cwd();
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const scratchDir = join(rootDir, '.claude', 'scratch', 'product-ux-smoke', runId);
const screenshotsDir = join(scratchDir, 'screenshots');
const browserTypes = { chromium, firefox };
const defaultBrowsers = ['chromium', 'firefox'];
const args = parseArgs(process.argv.slice(2));
const browsers = args.browsers.length ? args.browsers : defaultBrowsers;

const viewports = [
  { name: 'desktop', viewport: { width: 1440, height: 1000 } },
  { name: 'tablet', viewport: { width: 820, height: 1100 } },
  { name: 'mobile', viewport: { width: 390, height: 980 } },
];

const routes = [
  { path: '/', label: 'dashboard', expected: 'Cash pulse' },
  { path: '/bills', label: 'bills', expected: 'No bills found' },
  { path: '/invoices', label: 'invoices', expected: 'No invoices yet' },
  { path: '/credit-notes', label: 'credit-notes', expected: 'No credit notes posted yet' },
  { path: '/reports', label: 'reports', expected: 'BAS Quarterly (GST)' },
  { path: '/settings', label: 'settings', expected: 'Settings' },
];

const user = {
  id: 'user-1',
  aud: 'authenticated',
  role: 'authenticated',
  email: 'owner@example.test',
  app_metadata: {},
  user_metadata: {},
  created_at: '2026-06-29T00:00:00.000Z',
};

const org = {
  id: 'org-1',
  name: 'Demo Org',
  abn: '12123456789',
  organization_type: 'standard',
  business_profile: [{ entity_type: 'company' }],
};

await main();

async function main() {
  await mkdir(screenshotsDir, { recursive: true });
  const port = args.baseUrl ? null : await findFreePort();
  const vite = args.baseUrl ? null : startVite(port);
  const baseUrl = args.baseUrl ?? `http://127.0.0.1:${port}`;

  try {
    if (!args.baseUrl) await waitForHttp(baseUrl);
    const evidence = await runSmoke(baseUrl);
    await writeFile(join(scratchDir, 'report.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence, null, 2));
    if (!evidence.ok) {
      throw new Error(`product UX smoke failed: ${evidence.failed.join(', ')}`);
    }
  } finally {
    if (vite) await stopProcess(vite);
  }
}

async function runSmoke(baseUrl) {
  const results = [];
  for (const browserName of browsers) {
    const browserType = browserTypes[browserName];
    if (!browserType) throw new Error(`unsupported browser: ${browserName}`);
    const browser = await browserType.launch({ headless: true });
    try {
      for (const viewportCase of viewports) {
        const result = await runViewportSmoke(browser, browserName, viewportCase, baseUrl);
        results.push(result);
      }
    } finally {
      await browser.close();
    }
  }

  const failed = results.filter((result) => !result.ok);
  const evidence = {
    ok: failed.length === 0,
    report: toRelativePath(join(scratchDir, 'report.json')),
    browsers,
    viewports: viewports.map((item) => item.name),
    failed: failed.map((item) => item.id),
    results,
  };
  return evidence;
}

async function runViewportSmoke(browser, browserName, viewportCase, baseUrl) {
  const id = `${browserName}-${viewportCase.name}`;
  const context = await browser.newContext({ viewport: viewportCase.viewport });
  await seedAuth(context);
  await installMocks(context);
  const page = await context.newPage();
  const consoleMessages = [];
  const pageErrors = [];
  const failedResponses = [];
  const expectedErrorResponses = [];
  const screenshots = {};
  let billsErrorMode = false;

  page.on('console', (msg) => {
    const text = msg.text();
    if (
      text.includes('React DevTools') ||
      text.includes('React Router Future Flag Warning') ||
      text.includes('[vite]') ||
      text.includes('downloadable font: download failed') ||
      (billsErrorMode && text.includes('the server responded with a status of 500'))
    ) {
      return;
    }
    consoleMessages.push(`${msg.type()}: ${text}`);
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('response', (response) => {
    if (response.status() < 400) return;
    const detail = `${response.status()} ${response.url()}`;
    if (billsErrorMode && response.url().includes('/rest/v1/bills')) {
      expectedErrorResponses.push(detail);
      return;
    }
    failedResponses.push(detail);
  });
  page.on('dialog', (dialog) => dialog.accept());
  page.__setBillsErrorMode = (value) => {
    billsErrorMode = value;
  };

  try {
    for (const route of routes) {
      await visit(page, baseUrl, route.path);
      await page.getByText(route.expected).first().waitFor({ state: 'visible', timeout: 15000 });
      const blank = await page.locator('body').innerText();
      if (blank.trim().length < 20) throw new Error(`${id} ${route.label} rendered blank`);
      if (!(await noHorizontalOverflow(page))) throw new Error(`${id} ${route.label} overflowed`);
      screenshots[route.label] = await screenshot(page, `${id}-${route.label}.png`);
    }

    await exerciseKeyboardFocus(page, baseUrl);
    if (viewportCase.name === 'mobile') await exerciseMobileDrawer(page, baseUrl);
    await exerciseErrorState(page, baseUrl, (value) => {
      billsErrorMode = value;
    });

    return {
      id,
      ok: consoleMessages.length === 0 && pageErrors.length === 0 && failedResponses.length === 0,
      browser: browserName,
      viewport: viewportCase.name,
      screenshots,
      checks: {
        routes: routes.map((route) => route.label),
        emptyStates: ['bills', 'invoices', 'credit-notes'],
        errorState: 'bills forced query error',
        keyboardFocus: true,
        mobileDrawer: viewportCase.name === 'mobile' ? true : 'not applicable',
        horizontalOverflow: false,
      },
      consoleMessages,
      pageErrors,
      failedResponses,
      expectedErrorResponses,
    };
  } finally {
    await context.close();
  }
}

async function seedAuth(context) {
  await context.addInitScript(() => {
    const now = Math.floor(Date.now() / 1000);
    const seededUser = {
      id: 'user-1',
      aud: 'authenticated',
      role: 'authenticated',
      email: 'owner@example.test',
      app_metadata: {},
      user_metadata: {},
      created_at: '2026-06-29T00:00:00.000Z',
    };
    localStorage.setItem(
      'sb-dxoikltymmknxqpkpyhi-auth-token',
      JSON.stringify({
        access_token: 'mock-access-token',
        refresh_token: 'mock-refresh-token',
        expires_in: 3600,
        expires_at: now + 3600,
        token_type: 'bearer',
        user: seededUser,
      }),
    );
    localStorage.setItem('looplet:current-org-id', 'org-1');
  });
}

async function installMocks(context) {
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = request.url();
    if (request.method() === 'OPTIONS') return json(route, {});
    if (url.includes('/images/')) return transparentPng(route);
    if (url.includes('/auth/v1/token')) return json(route, session());
    if (url.includes('/auth/v1/user')) return json(route, user);
    if (url.includes('/rest/v1/rpc/list_advice_notes')) return json(route, adviceNotes());
    if (url.includes('/rest/v1/rpc/onboarding_progress')) {
      return json(route, [
        {
          total_entities: 20,
          pending_count: 9,
          needs_review_count: 3,
          approved_count: 8,
          dismissed_count: 0,
          pct_complete: 40,
          is_complete: false,
        },
      ]);
    }
    if (url.includes('/rest/v1/rpc/issue_api_key')) {
      return json(route, [
        { id: 'key-2', key_prefix: 'llp_new1234', api_key: 'llp_new1234.secret' },
      ]);
    }
    if (url.includes('/rest/v1/rpc/')) return json(route, []);
    if (url.includes('/rest/v1/organization_memberships')) {
      return json(route, [
        { role_enum: 'owner', accepted_at: '2026-06-29T00:00:00.000Z', organizations: org },
      ]);
    }
    if (url.includes('/rest/v1/v_organization_realtime_pnl')) return json(route, realtimePnl());
    if (url.includes('/rest/v1/v_tax_calendar')) return json(route, taxCalendar());
    if (url.includes('/rest/v1/api_keys')) return json(route, apiKeys());
    if (url.includes('/rest/v1/api_request_log')) return json(route, apiRequestLog());
    if (url.includes('/rest/v1/organizations')) return json(route, org);
    if (url.includes('/rest/v1/business_profile')) return json(route, []);
    if (url.includes('/rest/v1/bills') && request.headers()['x-looplet-force-error'] === '1') {
      return json(route, { message: 'forced bills smoke error' }, 500);
    }
    if (url.includes('/rest/v1/')) return json(route, []);
    return route.continue();
  });
}

async function visit(page, baseUrl, path) {
  const response = await page.goto(`${baseUrl}${path}`, {
    waitUntil: 'networkidle',
    timeout: 45000,
  });
  if (!response || !response.ok()) {
    throw new Error(`navigation failed for ${path}: ${response?.status() ?? 'no response'}`);
  }
}

async function exerciseKeyboardFocus(page, baseUrl) {
  await visit(page, baseUrl, '/settings');
  for (let i = 0; i < 6; i += 1) await page.keyboard.press('Tab');
  const focus = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    const rect = el.getBoundingClientRect();
    return { tag: el.tagName, width: rect.width, height: rect.height };
  });
  if (!focus || focus.width <= 0 || focus.height <= 0) {
    throw new Error('keyboard focus did not land on a visible control');
  }
}

async function exerciseMobileDrawer(page, baseUrl) {
  await visit(page, baseUrl, '/settings');
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('link', { name: /Bills/ }).click();
  await page.getByText('No bills found').first().waitFor({ state: 'visible', timeout: 15000 });
  if (!(await noHorizontalOverflow(page))) throw new Error('mobile drawer route overflowed');
}

async function exerciseErrorState(page, baseUrl, setBillsErrorMode) {
  setBillsErrorMode(true);
  await page.setExtraHTTPHeaders({ 'x-looplet-force-error': '1' });
  await visit(page, baseUrl, '/bills');
  await page
    .getByText(/Failed: forced bills smoke error/)
    .waitFor({ state: 'visible', timeout: 15000 });
  await page.setExtraHTTPHeaders({});
  setBillsErrorMode(false);
}

async function screenshot(page, fileName) {
  const path = join(screenshotsDir, fileName);
  await page.screenshot({ path, fullPage: true });
  return toRelativePath(path);
}

async function noHorizontalOverflow(page) {
  return await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}

function session() {
  const now = Math.floor(Date.now() / 1000);
  return {
    access_token: 'mock-access-token',
    refresh_token: 'mock-refresh-token',
    expires_in: 3600,
    expires_at: now + 3600,
    token_type: 'bearer',
    user,
  };
}

function realtimePnl() {
  return {
    organization_id: 'org-1',
    organization_name: 'Demo Org',
    revenue_inc_gst_cents: 12500000,
    revenue_ex_gst_cents: 11363636,
    gst_collected_cents: 1136364,
    gst_input_credit_cents: 250000,
    gst_set_aside_cents: 886364,
    cost_bills_cents: 2500000,
    cost_wages_cents: 3000000,
    cost_overhead_cents: 1250000,
    total_cost_cents: 6750000,
    gross_profit_cents: 4613636,
    tax_set_aside_cents: 1153409,
    really_yours_cents: 2573863,
  };
}

function taxCalendar() {
  return [
    {
      organization_id: 'org-1',
      obligation_key: 'year-end',
      category: 'income_tax',
      title: 'Year-end planning',
      period_label: 'FY2026',
      period_start: '2025-07-01',
      period_end: '2026-06-30',
      due_date: '2026-06-30',
      fy_start_year: 2025,
      display_name: null,
      description: null,
      cadence: null,
      default_lead_days: 30,
      sort_order: 1,
      days_until_due: 1,
      stage: 'due_soon',
      status: 'due_soon',
    },
  ];
}

function adviceNotes() {
  const base = {
    organization_id: 'org-1',
    inputs: {},
    assumptions: {},
    citations: [],
    disclaimer: 'General information only.',
    registered_agent_signoff_by: null,
    registered_agent_signoff_at: null,
    status: 'draft',
    created_by: 'user-1',
    deleted_at: null,
  };
  return [
    {
      ...base,
      id: 'advice-1',
      kind: 'year_end',
      title: 'Year-end planning levers',
      summary: 'Review deductions before 30 June.',
      numbers: { tax_diff_cents: 1200000 },
      created_at: '2026-06-27T01:00:00Z',
      updated_at: '2026-06-27T01:00:00Z',
    },
  ];
}

function apiKeys() {
  return [
    {
      id: 'key-1',
      name: 'POS bridge',
      key_prefix: 'llp_pos1234',
      scopes: ['write:receipts'],
      created_at: '2026-06-29T00:00:00.000Z',
      last_used_at: '2026-06-29T01:00:00.000Z',
      expires_at: null,
      revoked_at: null,
      rate_limit_per_min: 120,
    },
  ];
}

function apiRequestLog() {
  return [
    {
      id: 'audit-1',
      api_key_id: 'key-1',
      key_prefix: 'llp_pos1234',
      endpoint: 'receipt-webhook',
      method: 'POST',
      ingest_type: 'receipt',
      status: 202,
      ts: '2026-06-29T02:00:00.000Z',
    },
  ];
}

function json(route, data, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    },
    body: JSON.stringify(data),
  });
}

function transparentPng(route) {
  return route.fulfill({
    status: 200,
    contentType: 'image/gif',
    body: Buffer.from('R0lGODlhAQABAPAAAP///wAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64'),
  });
}

function startVite(port) {
  const command = process.platform === 'win32' ? 'cmd.exe' : 'npx';
  const args =
    process.platform === 'win32'
      ? ['/d', '/s', '/c', `npx vite --host 127.0.0.1 --port ${port}`]
      : ['vite', '--host', '127.0.0.1', '--port', String(port)];
  return spawn(command, args, {
    cwd: rootDir,
    env: {
      ...process.env,
      VITE_SUPABASE_URL:
        process.env.VITE_SUPABASE_URL || 'https://dxoikltymmknxqpkpyhi.supabase.co',
      VITE_SUPABASE_ANON_KEY: process.env.VITE_SUPABASE_ANON_KEY || 'product-smoke-anon-key',
      VITE_SUPABASE_PROJECT_REF: process.env.VITE_SUPABASE_PROJECT_REF || 'dxoikltymmknxqpkpyhi',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function stopProcess(child) {
  if (child.exitCode != null) return;
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
    });
    await new Promise((resolve) => {
      killer.once('exit', resolve);
      setTimeout(resolve, 3000);
    });
    return;
  }
  child.kill();
  await new Promise((resolve) => {
    child.once('exit', resolve);
    setTimeout(resolve, 2000);
  });
}

async function findFreePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('could not determine free port')));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

async function waitForHttp(url) {
  const deadline = Date.now() + 30000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastError ?? new Error(`timeout waiting for ${url}`);
}

function parseArgs(argv) {
  const parsed = { browsers: [], baseUrl: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--browsers') {
      parsed.browsers = (argv[i + 1] ?? '').split(',').filter(Boolean);
      i += 1;
      continue;
    }
    if (arg.startsWith('--browsers=')) {
      parsed.browsers = arg.slice('--browsers='.length).split(',').filter(Boolean);
      continue;
    }
    if (arg === '--base-url') {
      parsed.baseUrl = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (arg.startsWith('--base-url=')) {
      parsed.baseUrl = arg.slice('--base-url='.length);
      continue;
    }
    throw new Error(`unsupported argument: ${arg}`);
  }
  return parsed;
}

function toRelativePath(path) {
  return relative(rootDir, path).replace(/\\/g, '/');
}
