#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { chromium, firefox, webkit } from 'playwright';

const rootDir = process.cwd();
const supabaseUrl = 'https://looplet.supabase.co';
const browserTypes = { chromium, firefox, webkit };
const args = process.argv.slice(2);
const requestedBrowsers = readBrowserNames(args);
if (args.length > 0) throw new Error(`unsupported arguments: ${args.join(' ')}`);
const scratchRootDir = join(rootDir, '.claude', 'scratch', 'receipt-hub-visual-smoke');
const scratchDir = join(scratchRootDir, requestedBrowsers.join('-'));
const srcDir = join(scratchDir, 'src');
const viewportCases = [
  {
    name: 'desktop',
    viewport: { width: 1440, height: 1200 },
  },
  {
    name: 'mobile',
    viewport: { width: 390, height: 1200 },
  },
];

await main();

async function main() {
  await prepareHarness();
  const port = await findFreePort();
  const vite = startVite(port);

  try {
    await waitForHttp(`http://127.0.0.1:${port}/`);
    const evidence = await runBrowserSmoke(port);
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    await stopProcess(vite);
  }
}

async function prepareHarness() {
  await rm(scratchDir, { recursive: true, force: true });
  await mkdir(srcDir, { recursive: true });

  await writeFile(join(scratchDir, 'index.html'), [
    '<!doctype html>',
    '<html lang="en">',
    '  <head>',
    '    <meta charset="UTF-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    '    <title>ReceiptHub visual smoke</title>',
    '  </head>',
    '  <body>',
    '    <div id="root"></div>',
    '    <script type="module" src="/src/main.tsx"></script>',
    '  </body>',
    '</html>',
    '',
  ].join('\n'));

  await writeFile(join(scratchDir, 'vite.config.mjs'), `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const projectRoot = ${JSON.stringify(toVitePath(rootDir))};
const harnessSrc = ${JSON.stringify(toVitePath(srcDir))};

export default defineConfig({
  plugins: [react()],
  envDir: projectRoot,
  resolve: {
    alias: [
      { find: '@/lib/supabase', replacement: \`\${harnessSrc}/supabase-mock.ts\` },
      { find: '@/hooks/useOrg', replacement: \`\${harnessSrc}/use-org-mock.ts\` },
      { find: '@', replacement: \`\${projectRoot}/src\` },
    ],
  },
});
`);

  await writeFile(join(srcDir, 'main.tsx'), `import React from 'react';
import { createRoot } from 'react-dom/client';
import { ReceiptHubPage } from '@/pages/ReceiptHub';
import '@/index.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root not found');

createRoot(rootEl).render(
  <React.StrictMode>
    <ReceiptHubPage />
  </React.StrictMode>,
);
`);

  await writeFile(join(srcDir, 'use-org-mock.ts'), `const org = {
  id: 'org-pos-visual',
  name: 'Looplet Trades Demo',
  organization_type: 'standard',
};

export function useOrg() {
  return {
    organizations: [org],
    currentOrg: org,
    loading: false,
    setCurrentOrg: () => undefined,
    createOrganization: async () => ({ error: null }),
    refresh: async () => undefined,
  };
}
`);

  await writeFile(join(srcDir, 'supabase-mock.ts'), `const receiptEvents = [
  {
    id: 'evt-sale-1',
    bill_id: 'bill-1',
    related_receipt_event_id: null,
    event_type: 'sale',
    merchant_name: 'Bunnings Trade',
    receipt_number: 'RH-9001',
    purchase_at: '2026-06-28T05:00:00.000Z',
    source_channel: 'pos',
    status: 'classified',
    business_use: 'business',
    deductibility_status: 'deductible',
    gst_cents: 3273,
    total_inc_gst_cents: 36000,
    payment_method: 'card',
    payment_last4: '9815',
    payment_reference: 'auth-visual-001',
    terminal_id: 'TERM-01',
    store_id: 'QLD-TRADE-01',
  },
  {
    id: 'evt-refund-1',
    bill_id: 'bill-refund-1',
    related_receipt_event_id: 'evt-sale-1',
    event_type: 'refund',
    merchant_name: 'Bunnings Trade',
    receipt_number: 'RH-9001',
    purchase_at: '2026-06-28T05:08:00.000Z',
    source_channel: 'pos',
    status: 'classified',
    business_use: 'business',
    deductibility_status: 'deductible',
    gst_cents: -545,
    total_inc_gst_cents: -6000,
    payment_method: 'card',
    payment_last4: '9815',
    payment_reference: 'refund-visual-001',
    terminal_id: 'TERM-01',
    store_id: 'QLD-TRADE-01',
  },
  {
    id: 'evt-void-1',
    bill_id: null,
    related_receipt_event_id: 'evt-sale-1',
    event_type: 'void',
    merchant_name: 'Bunnings Trade',
    receipt_number: 'RH-9001',
    purchase_at: '2026-06-28T05:10:00.000Z',
    source_channel: 'pos',
    status: 'voided',
    business_use: 'business',
    deductibility_status: 'non_deductible',
    gst_cents: 0,
    total_inc_gst_cents: 0,
    payment_method: 'card',
    payment_last4: '9815',
    payment_reference: 'void-visual-001',
    terminal_id: 'TERM-01',
    store_id: 'QLD-TRADE-01',
  },
];

const tableData = {
  receipt_identities: [
    {
      id: 'identity-1',
      label: 'POS receipt bridge',
      channel: 'pos',
      token_prefix: 'rhp_visual',
      status: 'active',
      last_used_at: '2026-06-28T05:00:00.000Z',
      created_at: '2026-06-28T04:50:00.000Z',
    },
  ],
  receipt_events: receiptEvents,
  receipt_sync_jobs: [
    {
      id: 'sync-xero-1',
      receipt_event_id: 'evt-sale-1',
      bill_id: 'bill-1',
      provider: 'xero',
      status: 'queued',
      last_error: null,
      created_at: '2026-06-28T05:01:00.000Z',
    },
    {
      id: 'sync-myob-1',
      receipt_event_id: 'evt-sale-1',
      bill_id: 'bill-1',
      provider: 'myob',
      status: 'queued',
      last_error: null,
      created_at: '2026-06-28T05:01:00.000Z',
    },
    {
      id: 'sync-qbo-1',
      receipt_event_id: 'evt-sale-1',
      bill_id: 'bill-1',
      provider: 'quickbooks',
      status: 'queued',
      last_error: null,
      created_at: '2026-06-28T05:01:00.000Z',
    },
  ],
};

function makeQuery(table) {
  const query = {
    select: () => query,
    eq: () => query,
    order: () => query,
    limit: () => query,
    then: (resolve, reject) => Promise.resolve({
      data: tableData[table] ?? [],
      error: null,
    }).then(resolve, reject),
    single: () => Promise.resolve({
      data: (tableData[table] ?? [])[0] ?? null,
      error: null,
    }),
  };
  return query;
}

export const supabase = {
  from: (table) => makeQuery(table),
  rpc: async (name) => {
    if (name === 'issue_receipt_identity') {
      return {
        data: [{
          id: 'identity-issued-1',
          receipt_token: 'rhp_visual.receiptsecret',
          token_prefix: 'rhp_visual',
        }],
        error: null,
      };
    }
    if (name === 'issue_api_key') {
      return {
        data: [{
          id: 'key-issued-1',
          api_key: 'llp_visual.apisecret',
          key_prefix: 'llp_visual',
        }],
        error: null,
      };
    }
    return { data: null, error: { message: \`unexpected rpc \${name}\` } };
  },
  auth: {
    getSession: async () => ({
      data: {
        session: {
          access_token: 'visual-session-token',
          user: { id: 'user-visual' },
        },
      },
      error: null,
    }),
  },
};
`);
}

function startVite(port) {
  const viteBin = resolve(rootDir, 'node_modules', 'vite', 'bin', 'vite.js');
  const child = spawn(process.execPath, [
    viteBin,
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--strictPort',
  ], {
    cwd: scratchDir,
    env: {
      ...process.env,
      VITE_SUPABASE_URL: supabaseUrl,
      VITE_SUPABASE_ANON_KEY: 'visual-anon-key',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return child;
}

async function runBrowserSmoke(port) {
  const browsers = [];
  for (const browserName of requestedBrowsers) {
    browsers.push(await runBrowserCase(port, browserName));
  }
  const runs = browsers.flatMap((browserRun) => browserRun.viewports);
  const first = runs[0];
  return {
    ok: true,
    requested_browsers: requestedBrowsers,
    status: first.status,
    final_url: first.final_url,
    screenshots: Object.fromEntries(
      runs.map((run) => [`${run.browser}_${run.name}`, run.screenshot]),
    ),
    browsers,
    viewports: runs,
    rendered_receipt_hub: runs.every((run) => run.rendered_receipt_hub),
    rendered_pos_bridge_setup: runs.every((run) => run.rendered_pos_bridge_setup),
    rendered_business_install_requirements: runs.every((run) => run.rendered_business_install_requirements),
    rendered_sample_receipt_events: runs.every((run) => run.rendered_sample_receipt_events),
    generated_bridge_env: runs.every((run) => run.generated_bridge_env),
    generated_scannable_pass: runs.every((run) => run.generated_scannable_pass),
    keyboard_required_controls_reached: runs.every((run) => run.keyboard_required_controls_reached),
    no_horizontal_document_overflow: runs.every((run) => run.no_horizontal_document_overflow),
    console_errors: runs.reduce((sum, run) => sum + run.console_errors, 0),
    page_errors: runs.reduce((sum, run) => sum + run.page_errors, 0),
  };
}

async function runBrowserCase(port, browserName) {
  const browserType = browserTypes[browserName];
  const browser = await browserType.launch({ headless: true });
  try {
    const runs = [];
    for (const viewportCase of viewportCases) {
      runs.push(await runViewportSmoke(browser, port, browserName, viewportCase));
    }
    return {
      name: browserName,
      ok: runs.every((run) => run.ok),
      viewports: runs,
      console_errors: runs.reduce((sum, run) => sum + run.console_errors, 0),
      page_errors: runs.reduce((sum, run) => sum + run.page_errors, 0),
    };
  } finally {
    await browser.close();
  }
}

async function runViewportSmoke(browser, port, browserName, viewportCase) {
  const page = await browser.newPage({ viewport: viewportCase.viewport });
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  try {
    const response = await page.goto(`http://127.0.0.1:${port}/`, {
      waitUntil: 'networkidle',
      timeout: 30_000,
    });
    await page.getByRole('heading', { name: 'Receipt Hub' }).waitFor({ timeout: 15_000 });
    await page.locator('text=Bunnings Trade').first().waitFor({ timeout: 15_000 });
    const keyboard = await assertKeyboardReachableControls(page, viewportCase.name);
    await page.getByRole('button', { name: /POS webhook/i }).click();
    await page.getByRole('button', { name: /Generate config/i }).click();
    await page.locator('text=LOOPLET_RECEIPT_WEBHOOK_URL=').waitFor({ timeout: 15_000 });
    await page.getByRole('button', { name: /Generate pass/i }).click();
    await page.getByText('Scan this at POS').waitFor({ timeout: 15_000 });

    const overflow = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
    }));
    const noHorizontalDocumentOverflow =
      overflow.scrollWidth <= overflow.clientWidth + 2 &&
      overflow.bodyScrollWidth <= overflow.clientWidth + 2;

    const screenshotPath = join(
      scratchDir,
      `receipt-hub-authenticated-${browserName}-${viewportCase.name}.png`,
    );
    await page.screenshot({ path: screenshotPath, fullPage: true });

    if (consoleErrors.length > 0 || pageErrors.length > 0 || !noHorizontalDocumentOverflow) {
      throw new Error(`ReceiptHub ${browserName}/${viewportCase.name} visual smoke failed: ${JSON.stringify({
        consoleErrors,
        pageErrors,
        overflow,
      })}`);
    }

    return {
      ok: true,
      browser: browserName,
      name: viewportCase.name,
      status: response?.status() ?? null,
      final_url: page.url(),
      screenshot: toRelativePath(screenshotPath),
      viewport: viewportCase.viewport,
      rendered_receipt_hub: true,
      rendered_pos_bridge_setup: await page.getByText('POS bridge setup').isVisible(),
      rendered_business_install_requirements: await page.getByText('Business side must have').isVisible(),
      rendered_sample_receipt_events: await page.locator('text=Bunnings Trade').first().isVisible(),
      generated_bridge_env: await page.locator('text=LOOPLET_RECEIPT_WEBHOOK_URL=').isVisible(),
      generated_scannable_pass: await page.getByText('Scan this at POS').isVisible(),
      keyboard_required_controls_reached: keyboard.ok,
      keyboard_reached_controls: keyboard.reached,
      no_horizontal_document_overflow: noHorizontalDocumentOverflow,
      document_width: overflow,
      console_errors: consoleErrors.length,
      page_errors: pageErrors.length,
    };
  } finally {
    await page.close();
  }
}

async function assertKeyboardReachableControls(page, viewportName) {
  const required = [
    'Generate pass',
    'POS simulator',
    'Phone pass',
    'Key fob / tag',
    'POS webhook',
    'EFTPOS signal',
    'Generate config',
    'Dispatch',
  ];
  const reached = [];

  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    window.scrollTo(0, 0);
  });

  for (let index = 0; index < 18; index += 1) {
    await page.keyboard.press('Tab');
    const active = await page.evaluate(() => {
      const element = document.activeElement;
      if (!(element instanceof HTMLElement)) return null;
      const rect = element.getBoundingClientRect();
      return {
        tag: element.tagName.toLowerCase(),
        text: element.innerText?.replace(/\s+/g, ' ').trim() ?? '',
        ariaLabel: element.getAttribute('aria-label'),
        disabled: element.hasAttribute('disabled'),
        visible: rect.width > 0 && rect.height > 0,
      };
    });
    if (!active?.visible || active.disabled || active.tag !== 'button') continue;
    const label = active.ariaLabel || active.text;
    if (label && !reached.includes(label)) reached.push(label);
  }

  const missing = required.filter((label) => !reached.some((reachedLabel) => reachedLabel.includes(label)));
  if (missing.length > 0) {
    throw new Error(`ReceiptHub ${viewportName} keyboard traversal missed controls: ${missing.join(', ')}; reached=${JSON.stringify(reached)}`);
  }
  return { ok: true, reached };
}

function readBrowserNames(args) {
  const value = readOption(args, '--browsers') ?? process.env.LOOPLET_RECEIPT_HUB_BROWSERS ?? 'chromium';
  const names = value.split(',').map((name) => name.trim()).filter(Boolean);
  if (names.length === 0) throw new Error('--browsers must include at least one browser');
  for (const name of names) {
    if (!Object.prototype.hasOwnProperty.call(browserTypes, name)) {
      throw new Error(`unsupported browser ${name}; expected chromium, firefox, or webkit`);
    }
  }
  return [...new Set(names)];
}

function readOption(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value) throw new Error(`${name} requires a value`);
  args.splice(index, 2);
  return value;
}

async function waitForHttp(url) {
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Keep polling until Vite has finished booting.
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function findFreePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  if (!address || typeof address === 'string') throw new Error('Could not allocate a free port');
  return address.port;
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.killed) return;
  child.kill();
  await new Promise((resolve) => child.once('exit', resolve));
}

function toVitePath(path) {
  return resolve(path).replaceAll('\\', '/');
}

function toRelativePath(path) {
  return resolve(path).replace(resolve(rootDir), '').replace(/^[/\\]/, '').replaceAll('\\', '/');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
