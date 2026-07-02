#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, relative } from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';

const rootDir = process.cwd();
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const scratchDir = join(rootDir, '.claude', 'scratch', 'wrap-up-local-visual-smoke', runId);
const srcDir = join(scratchDir, 'src');
const screenshotsDir = join(scratchDir, 'screenshots');

await main();

async function main() {
  await prepareHarness();
  const port = await findFreePort();
  const vite = startVite(port);

  try {
    await waitForHttp(`http://127.0.0.1:${port}/`);
    const evidence = await runSmoke(port);
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    await stopProcess(vite);
  }
}

async function prepareHarness() {
  await rm(scratchDir, { recursive: true, force: true });
  await mkdir(srcDir, { recursive: true });
  await mkdir(screenshotsDir, { recursive: true });

  await writeFile(
    join(scratchDir, 'index.html'),
    [
      '<!doctype html>',
      '<html lang="en">',
      '  <head>',
      '    <meta charset="UTF-8" />',
      '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
      '    <title>Looplet wrap-up visual smoke</title>',
      '  </head>',
      '  <body>',
      '    <div id="root"></div>',
      '    <script type="module" src="/src/main.tsx"></script>',
      '  </body>',
      '</html>',
      '',
    ].join('\n'),
  );

  await writeFile(
    join(scratchDir, 'vite.config.mjs'),
    `import { defineConfig } from 'vite';
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
      { find: '@/hooks/useRealtimePnl', replacement: \`\${harnessSrc}/use-realtime-pnl-mock.ts\` },
      { find: '@/hooks/useAdviceNotes', replacement: \`\${harnessSrc}/use-advice-notes-mock.ts\` },
      { find: '@/hooks/useTaxCalendar', replacement: \`\${harnessSrc}/use-tax-calendar-mock.ts\` },
      { find: '@/hooks/onboarding/useStagedEntities', replacement: \`\${harnessSrc}/use-staged-entities-mock.ts\` },
      { find: '@', replacement: \`\${projectRoot}/src\` },
    ],
  },
});
`,
  );

  await writeFile(
    join(srcDir, 'main.tsx'),
    `import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';
import { DashboardPage } from '@/pages/Dashboard';
import { DebtDetailPage } from '@/pages/DebtDetail';
import { EmployeeDetailPage } from '@/pages/EmployeeDetail';
import { SubscriptionDetailPage } from '@/pages/SubscriptionDetail';
import { BasReportPage } from '@/pages/reports/Bas';
import { NotificationsPage } from '@/pages/Notifications';
import { QualityPage } from '@/pages/Quality';
import { OrgProfileForm } from '@/components/settings/OrgProfile';
import { ConnectorApiKeys } from '@/components/settings/ConnectorApiKeys';
import { MoveToOrgButton } from '@/components/MoveToOrgButton';
import '@/index.css';

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main style={{ padding: 24, maxWidth: 1440, margin: '0 auto' }}>
      <nav style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
        <Link to="/dashboard">Dashboard</Link>
        <Link to="/settings-org">Org profile</Link>
        <Link to="/connector-keys">Connector keys</Link>
        <Link to="/debts/debt-1">Debt</Link>
        <Link to="/subscriptions/sub-1">Subscription</Link>
        <Link to="/employees/emp-1">Employee</Link>
        <Link to="/reports/bas">BAS</Link>
        <Link to="/quality">Quality</Link>
        <Link to="/notifications">Alerts</Link>
        <Link to="/move">Move</Link>
      </nav>
      {children}
    </main>
  );
}

function MoveProbe() {
  return (
    <section>
      <h1>Move proof</h1>
      <MoveToOrgButton
        table="bills"
        rowId="bill-1"
        currentOrgId="org-1"
        fkColumnsToNull={['supplier_id', 'job_id', 'suggested_job_id']}
      />
    </section>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Shell>
        <Routes>
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/settings-org" element={<OrgProfileForm />} />
          <Route path="/connector-keys" element={<ConnectorApiKeys organizationId="org-1" />} />
          <Route path="/debts/:id" element={<DebtDetailPage />} />
          <Route path="/subscriptions/:id" element={<SubscriptionDetailPage />} />
          <Route path="/employees/:id" element={<EmployeeDetailPage />} />
          <Route path="/reports/bas" element={<BasReportPage />} />
          <Route path="/quality" element={<QualityPage />} />
          <Route path="/notifications" element={<NotificationsPage />} />
          <Route path="/move" element={<MoveProbe />} />
          <Route path="*" element={<DashboardPage />} />
        </Routes>
      </Shell>
    </BrowserRouter>
  </React.StrictMode>,
);
`,
  );

  await writeFile(
    join(srcDir, 'use-org-mock.ts'),
    `const organizations = [
  { id: 'org-1', name: 'Affordable Fencing', organization_type: 'standard' },
  { id: 'org-2', name: 'Second Org', organization_type: 'standard' },
  { id: 'org-3', name: 'Third Org', organization_type: 'standard' },
];

export function useOrg() {
  return {
    organizations,
    currentOrg: organizations[0],
    loading: false,
    setCurrentOrg: () => undefined,
    createOrganization: async () => ({ error: null }),
    refresh: async () => undefined,
  };
}
`,
  );

  await writeFile(
    join(srcDir, 'use-realtime-pnl-mock.ts'),
    `export function useRealtimePnl() {
  return {
    loading: false,
    error: null,
    pnl: {
      organization_id: 'org-1',
      organization_name: 'Affordable Fencing',
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
    },
  };
}
`,
  );

  await writeFile(
    join(srcDir, 'use-advice-notes-mock.ts'),
    `const base = {
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

export function useAdviceNotes() {
  return {
    loading: false,
    actionBusy: false,
    error: null,
    refresh: async () => undefined,
    createNote: async () => undefined,
    signOff: async () => true,
    dismiss: async () => true,
    notes: [
      { ...base, id: 'year-end', kind: 'year_end', title: 'Year-end planning levers', summary: 'Review deductions before 30 June.', numbers: { tax_diff_cents: 1200000 }, created_at: '2026-06-27T01:00:00Z', updated_at: '2026-06-27T01:00:00Z' },
      { ...base, id: 'structuring', kind: 'structuring', title: 'Structuring tax comparison', summary: 'Compare current and company structures.', numbers: { tax_diff_cents: 900000 }, created_at: '2026-06-27T02:00:00Z', updated_at: '2026-06-27T02:00:00Z' },
      { ...base, id: 'forecast', kind: 'forecast', title: 'Cash-flow forecast', summary: 'Eight weeks of runway at current spend.', numbers: { runway_weeks: 8 }, created_at: '2026-06-27T03:00:00Z', updated_at: '2026-06-27T03:00:00Z' },
    ],
  };
}
`,
  );

  await writeFile(
    join(srcDir, 'use-tax-calendar-mock.ts'),
    `export function useTaxCalendar() {
  return {
    loading: false,
    error: null,
    obligations: [
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
        days_until_due: 3,
        stage: 'due_soon',
        status: 'due_soon',
      },
    ],
  };
}
`,
  );

  await writeFile(
    join(srcDir, 'use-staged-entities-mock.ts'),
    `export function useOnboardingProgress() {
  return {
    loading: false,
    refresh: async () => undefined,
    progress: {
      total_entities: 20,
      pending_count: 9,
      needs_review_count: 3,
      approved_count: 8,
      dismissed_count: 0,
      pct_complete: 40,
      is_complete: false,
    },
  };
}

export function useStagedEntities() {
  return {
    entities: [],
    progress: null,
    loading: false,
    refresh: async () => undefined,
  };
}
`,
  );

  await writeFile(
    join(srcDir, 'supabase-mock.ts'),
    `type Result = { data: unknown; error: { message: string } | null };

const org = {
  id: 'org-1',
  name: 'Affordable Fencing',
  abn: null,
  settings: { tax_rate_percent: 25, gst_registered: true, default_invoice_terms_days: 14 },
};

const debt = {
  id: 'debt-1',
  organization_id: 'org-1',
  name: 'Visa Business Card',
  kind: 'credit_card',
  lender_name: 'Bank Test',
  account_number_last4: '1234',
  original_balance_cents: 1000000,
  current_balance_cents: 500000,
  interest_rate_pct: 18.99,
  minimum_payment_cents: 12500,
  payment_due_day: 15,
  start_date: '2025-01-01',
  end_date: null,
  is_personal: false,
  notes: 'Business card',
};

const subscription = {
  id: 'sub-1',
  organization_id: 'org-1',
  merchant_canonical_key: 'adobe',
  merchant_name: 'Adobe Creative Cloud',
  cadence: 'monthly',
  amount_cents: 7990,
  currency_code: 'AUD',
  status: 'detected',
  confidence: 0.91,
  first_seen_at: '2026-01-01',
  last_seen_at: '2026-06-01',
  next_expected_at: '2026-07-01',
  observed_count: 6,
  total_spent_cents: 47940,
  detection_reason: 'Monthly merchant pattern',
  is_personal: false,
  is_business: true,
  notes: null,
};

const employee = {
  id: 'emp-1',
  organization_id: 'org-1',
  full_name: 'Jane Doe',
  email: 'jane@example.com',
  role: 'Foreperson',
  is_active: true,
  modern_award: 'MA000003',
  classification_level: 'Level 1',
  wage_components: {
    base_hourly_rate: 24,
    super_pct: 11.5,
    workcover_pct: 1.5,
    leave_loading_pct: 8,
    loaded_hourly_rate_cents: 10000,
  },
  created_at: '2024-01-01T00:00:00Z',
};

const timesheet = {
  id: 'ts-1',
  employee_id: 'emp-1',
  job_id: 'job-1',
  work_date: '2026-06-20',
  hours: 4,
  loaded_hourly_rate_cents: 10000,
  total_cost_cents: 40000,
  is_billable: true,
  notes: 'Initial install',
  entry_type: 'ordinary',
  job: { job_number: 'J-001', name: 'Fence repair' },
};

const job = { id: 'job-1', job_number: 'J-001', name: 'Fence repair' };

const basQuarter = {
  organization_id: 'org-1',
  fy_start_year: 2025,
  quarter_num: 4,
  quarter_start: '2026-04-01',
  quarter_end: '2026-06-30',
  due_date: '2026-07-28',
  gst_collected_cents: 10000,
  gst_paid_cents: 5000,
  net_gst_cents: 5000,
  sales_ex_gst_cents: 100000,
  purchases_ex_gst_cents: 50000,
  invoice_count: 2,
  bill_count: 40,
};

const basCoverage = {
  organization_id: 'org-1',
  fy_start_year: 2025,
  quarter_num: 4,
  bills_in_scope: 40,
  bills_complete: 29,
  bills_gst_estimated: 0,
  coverage_pct: 72.5,
  gst_ready: false,
};

const booksHealth = {
  organization_id: 'org-1',
  uncoded_count: 8,
  unreconciled_count: 12,
  open_period_count: 2,
  coverage_pct: 72.5,
  score: 76,
  blocking: true,
};

const duplicateBill = {
  organization_id: 'org-1',
  supplier_id: 'supplier-1',
  invoice_date: '2026-06-14',
  total_inc_gst_cents: 242000,
  bill_ids: ['bill-dup-1', 'bill-dup-2'],
  dup_count: 2,
};

const lowConfidenceBill = {
  id: 'bill-low-1',
  supplier_name_raw: 'Reece Plumbing',
  invoice_number: 'INV-1042',
  invoice_date: '2026-06-12',
  total_inc_gst_cents: null,
  ocr_provider: 'groq',
  ocr_confidence: 0.41,
  status: 'received',
  created_at: '2026-06-12T00:00:00Z',
};

const basWorksheet = {
  organization_id: 'org-1',
  fy_start_year: 2025,
  quarter: 4,
  quarter_start: '2026-04-01',
  quarter_end: '2026-06-30',
  due_date: '2026-07-28',
  gst: { G1: 110000, G10: 0, G11: 55000, '1A': 10000, '1B': 5000 },
  payg_withholding: { W1: 800000, W2: 160000, W4: 0, W5: 160000, '4': 160000 },
  payg_instalment: null,
  summary: { '9_net_amount_cents': 5000 },
};

const gmailDisconnectNotification = {
  id: 'notif-gmail-1',
  organization_id: 'org-1',
  user_id: null,
  category: 'gmail_disconnected',
  severity: 'error',
  title: 'Reconnect Gmail',
  body: 'accounts@example.com stopped syncing because Google rejected the refresh token. Reconnect Gmail to resume automatic bill capture.',
  link: '/settings',
  resource_type: 'gmail_integrations',
  resource_id: 'gmail-int-1',
  read_at: null,
  dismissed_at: null,
  created_at: '2026-06-30T20:00:00.000Z',
  metadata: { gmail_address: 'accounts@example.com' },
};

const connectorKey = {
  id: 'key-1',
  organization_id: 'org-1',
  name: 'Main connector',
  key_prefix: 'llp_main',
  scopes: ['read:financials', 'write:bills'],
  last_used_at: '2026-07-01T01:00:00Z',
  expires_at: null,
  revoked_at: null,
  created_at: '2026-07-01T00:00:00Z',
  rate_limit_per_min: 120,
};

const apiRequestLog = {
  id: 1,
  organization_id: 'org-1',
  api_key_id: 'key-1',
  key_prefix: 'llp_main',
  endpoint: 'ingest',
  method: 'POST',
  ingest_type: 'bill',
  status: 200,
  ts: '2026-07-01T01:01:00Z',
};

const tableData: Record<string, unknown[]> = {
  organizations: [org],
  debts: [debt],
  debt_payments: [],
  subscriptions: [subscription],
  bank_transactions: [],
  employees: [employee],
  timesheet_entries: [timesheet],
  jobs: [job],
  leave_balances: [],
  pay_slips: [],
  v_award_rate_exceptions: [],
  allocation_splits: [],
  v_bas_quarterly: [basQuarter],
  v_bas_gst_coverage: [basCoverage],
  v_books_health: [booksHealth],
  v_duplicate_bills: [duplicateBill],
  v_low_confidence_bills: [lowConfidenceBill],
  v_gst_treatment_exceptions: [],
  v_gst_reconciliation: [{ organization_id: 'org-1', variance_cents: 0 }],
  notifications: [gmailDisconnectNotification],
  api_keys: [connectorKey],
  api_request_log: [apiRequestLog],
};

function mutations() {
  const w = window as unknown as { __loopletVisualMutations?: unknown[] };
  w.__loopletVisualMutations ??= [];
  return w.__loopletVisualMutations;
}

function makeQuery(table: string) {
  let op: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select';
  let payload: unknown;
  const query: Record<string, unknown> = {};
  const pass = () => query;
  const selectResult = (): Result => ({ data: tableData[table] ?? [], error: null });
  const terminal = (): Promise<Result> => {
    if (op !== 'select') {
      mutations().push({ table, method: op, payload });
      return Promise.resolve({ data: null, error: null });
    }
    return Promise.resolve(selectResult());
  };

  [
    'select',
    'eq',
    'neq',
    'gt',
    'lt',
    'gte',
    'lte',
    'is',
    'not',
    'order',
    'limit',
    'in',
    'match',
    'returns',
  ].forEach((method) => {
    query[method] = pass;
  });
  query.insert = (p: unknown) => {
    op = 'insert';
    payload = p;
    return query;
  };
  query.update = (p: unknown) => {
    op = 'update';
    payload = p;
    return query;
  };
  query.upsert = (p: unknown) => {
    op = 'upsert';
    payload = p;
    return query;
  };
  query.delete = () => {
    op = 'delete';
    return query;
  };
  query.maybeSingle = () => {
    const result = selectResult();
    return Promise.resolve({
      data: Array.isArray(result.data) ? (result.data[0] ?? null) : result.data,
      error: result.error,
    });
  };
  query.single = query.maybeSingle;
  query.then = (resolve: (value: Result) => unknown, reject?: (reason: unknown) => unknown) =>
    terminal().then(resolve, reject);
  return query;
}

export const supabase = {
  from: (table: string) => makeQuery(table),
  rpc: async (name: string, args?: unknown) => {
    if (name === 'generate_bas_worksheet') return { data: basWorksheet, error: null };
    if (name === 'period_close_checks') {
      return {
        data: [
          { check_name: 'trial_balance_balanced', passed: true, detail: { message: 'Balanced' } },
          {
            check_name: 'uncoded_transactions',
            passed: false,
            detail: { message: '8 transactions still need coding' },
          },
        ],
        error: null,
      };
    }
    if (name === 'enqueue_automation_job') {
      mutations().push({ table: 'automation_jobs', method: 'rpc', payload: args });
      return {
        data: {
          id: 'job-repair-1',
          organization_id: 'org-1',
          job_kind: 'bill_extract',
          status: 'pending',
        },
        error: null,
      };
    }
    if (name === 'issue_api_key') {
      mutations().push({ table: 'api_keys', method: 'rpc', payload: args });
      return {
        data: [{ id: 'key-new', api_key: 'llp_new.visualsecret', key_prefix: 'llp_new' }],
        error: null,
      };
    }
    if (name === 'revoke_api_key') {
      mutations().push({ table: 'api_keys', method: 'rpc', payload: args });
      return { data: true, error: null };
    }
    if (name === 'request_approval') {
      mutations().push({ table: 'approval_requests', method: 'rpc', payload: args });
      return { data: null, error: null };
    }
    return { data: [], error: null };
  },
  auth: {
    getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }),
    getSession: async () => ({
      data: { session: { access_token: 'visual-smoke-token', user: { id: 'user-1' } } },
      error: null,
    }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }),
  },
  channel: () => {
    const channel = {
      on: () => channel,
      subscribe: () => channel,
      unsubscribe: () => undefined,
    };
    return channel;
  },
  removeChannel: async () => 'ok',
  storage: {
    from: () => ({
      createSignedUrl: async () => ({ data: { signedUrl: 'https://example.test/file' }, error: null }),
      getPublicUrl: () => ({ data: { publicUrl: 'https://example.test/file' } }),
      upload: async () => ({ data: {}, error: null }),
    }),
  },
};
`,
  );
}

async function runSmoke(port) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const consoleErrors = [];
  const pageErrors = [];
  const screenshots = {};
  const checks = {};

  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('dialog', (dialog) => dialog.accept());

  try {
    await visit(page, port, '/dashboard');
    await expectVisible(page, 'text=Onboarding triage');
    await expectVisible(page, 'text=Review 12 staged senders');
    checks.dashboardTriage = await noHorizontalOverflow(page);
    screenshots.dashboard = await screenshot(page, 'dashboard.png');

    await visit(page, port, '/reports/bas');
    await expectVisible(page, 'text=BAS Quarterly (GST)');
    await expectVisible(page, 'text=GST Data Incomplete:');
    await expectVisible(page, 'text=GST coverage is 72.5% (29/40 bills)');
    checks.basCoverageLodgeDisabled = await page
      .getByRole('button', { name: /request lodge approval/i })
      .isDisabled();
    checks.basCoverageNoOverflow = await noHorizontalOverflow(page);
    screenshots.basCoverageGate = await screenshot(page, 'bas-coverage-gate.png');

    await visit(page, port, '/quality');
    await expectVisible(page, 'text=Data Quality');
    await expectVisible(page, 'text=Reece Plumbing');
    await page.getByRole('button', { name: /queue ocr repair/i }).click();
    await expectVisible(page, 'text=OCR repair queued (job-repa).');
    checks.qualityRepairJobQueued = await hasMutation(page, 'automation_jobs', {
      p_org_id: 'org-1',
      p_job_kind: 'bill_extract',
      p_source_kind: null,
      p_source_id: null,
      p_priority: 3,
      p_max_attempts: 3,
      p_payload: {
        mode: 'repair',
        max: 20,
        delay_ms: 2000,
        source: 'quality_page',
      },
    });
    checks.qualityNoOverflow = await noHorizontalOverflow(page);
    screenshots.qualityRepair = await screenshot(page, 'quality-repair.png');

    await visit(page, port, '/notifications');
    await expectVisible(page, 'text=Reconnect Gmail');
    await expectVisible(page, 'text=Gmail disconnected');
    await expectVisible(page, 'text=accounts@example.com stopped syncing');
    checks.gmailDisconnectNotificationNoOverflow = await noHorizontalOverflow(page);
    screenshots.gmailDisconnectNotification = await screenshot(
      page,
      'gmail-disconnect-notification.png',
    );

    await visit(page, port, '/settings-org');
    await expectVisible(page, 'text=Organisation profile');
    await page.getByLabel('ABN').fill('12 345 678 901');
    await page.getByLabel('Income tax set-aside %').fill('31');
    await page.getByRole('button', { name: /save profile/i }).click();
    await expectVisible(page, 'text=Saved.');
    checks.orgProfileMutation = await hasMutation(page, 'organizations', {
      abn: '12 345 678 901',
      settings: { tax_rate_percent: 31 },
    });
    screenshots.orgProfile = await screenshot(page, 'org-profile.png');

    await visit(page, port, '/connector-keys');
    await expectVisible(page, 'text=Connector API keys');
    await expectVisible(page, 'text=Main connector · llp_main');
    await expectVisible(page, 'text=ingest · 200');
    await page.getByRole('button', { name: /issue key/i }).click();
    await page.getByLabel('Name').fill('Portal connector');
    await page.getByLabel('write:bank').check();
    await page.getByRole('button', { name: /create key/i }).click();
    await expectVisible(page, 'text=llp_new.visualsecret');
    checks.connectorKeyIssued = await hasMutation(page, 'api_keys', {
      p_name: 'Portal connector',
      p_scopes: ['read:financials', 'write:bank'],
    });
    await page.getByRole('button', { name: /revoke Main connector/i }).click();
    checks.connectorKeyRevoked = await hasMutation(page, 'api_keys', { p_key_id: 'key-1' });
    checks.connectorKeysNoOverflow = await noHorizontalOverflow(page);
    screenshots.connectorKeys = await screenshot(page, 'connector-keys.png');

    await visit(page, port, '/debts/debt-1');
    await expectVisible(page, 'text=Visa Business Card');
    await page.getByRole('button', { name: /record payment/i }).click();
    const debtDialog = page.getByRole('dialog', { name: /record debt payment/i });
    await debtDialog.getByLabel('Payment Date').fill('2026-06-15');
    await debtDialog.getByLabel('Total Amount ($)').fill('250');
    await debtDialog.getByLabel('Principal portion ($)').fill('200');
    await debtDialog.getByLabel('Interest portion ($)').fill('45');
    await debtDialog.getByLabel('Fees portion ($)').fill('5');
    await debtDialog.getByLabel('Notes / Description').fill('June payoff');
    screenshots.debtPaymentDialog = await screenshot(page, 'debt-payment-dialog.png');
    await debtDialog.getByRole('button', { name: /^record payment$/i }).click();
    checks.debtPaymentInsert = await hasMutation(page, 'debt_payments', {
      total_cents: 25000,
      principal_cents: 20000,
      notes: 'June payoff',
    });
    checks.debtBalanceUpdate = await hasMutation(page, 'debts', { current_balance_cents: 480000 });

    await visit(page, port, '/subscriptions/sub-1');
    await expectVisible(page, 'text=Adobe Creative Cloud');
    await page.getByRole('button', { name: /edit details/i }).click();
    await page.getByLabel('Subscription Status').selectOption('paused');
    await page.getByLabel('Cadence Override').selectOption('yearly');
    await page.getByRole('button', { name: /personal/i }).click();
    await page.getByLabel('Notes').fill('Moved to personal card');
    await page.getByRole('button', { name: /save changes/i }).click();
    checks.subscriptionUpdate = await hasMutation(page, 'subscriptions', {
      status: 'paused',
      cadence: 'yearly',
      is_personal: true,
      is_business: false,
      notes: 'Moved to personal card',
    });
    screenshots.subscriptionEdit = await screenshot(page, 'subscription-edit.png');

    await visit(page, port, '/employees/emp-1');
    await expectVisible(page, 'text=Jane Doe');
    await page.getByRole('button', { name: /edit timesheet/i }).click();
    await page.getByLabel('Timesheet hours').fill('6.5');
    await page.getByLabel('Timesheet notes').fill('Updated install');
    await page.getByRole('button', { name: /save timesheet/i }).click();
    checks.timesheetUpdate = await hasMutation(page, 'timesheet_entries', {
      hours: 6.5,
      notes: 'Updated install',
      total_cost_cents: 65000,
    });
    await page.getByRole('button', { name: /^log time$/i }).click();
    await page.getByLabel('Work date').fill('2026-06-21');
    await page.getByLabel('Hours worked').fill('3.5');
    await page.getByLabel('Entry type').selectOption('overtime');
    await page.getByLabel('Job').selectOption('job-1');
    await page.getByLabel('Time entry notes').fill('Overtime install');
    screenshots.employeeLogTime = await screenshot(page, 'employee-log-time.png');
    await page.getByRole('button', { name: /log entry/i }).click();
    checks.timesheetInsert = await hasMutation(page, 'timesheet_entries', {
      employee_id: 'emp-1',
      job_id: 'job-1',
      hours: 3.5,
      loaded_hourly_rate_cents: 10000,
      entry_type: 'overtime',
    });

    await visit(page, port, '/move');
    await expectVisible(page, 'text=Move proof');
    await page.getByRole('button', { name: /move to business/i }).click();
    await page.getByText('Second Org').click();
    checks.moveUpdate = await hasMutation(page, 'bills', {
      organization_id: 'org-2',
      supplier_id: null,
      job_id: null,
      suggested_job_id: null,
    });
    screenshots.move = await screenshot(page, 'move.png');

    const failed = Object.entries(checks).filter(([, value]) => value !== true);
    if (failed.length > 0) {
      throw new Error(`visual smoke checks failed: ${failed.map(([k]) => k).join(', ')}`);
    }
    if (consoleErrors.length > 0 || pageErrors.length > 0) {
      throw new Error(
        `browser errors found: console=${JSON.stringify(consoleErrors)}, page=${JSON.stringify(pageErrors)}`,
      );
    }

    return {
      ok: true,
      browser: 'chromium',
      screenshots,
      checks,
      consoleErrors,
      pageErrors,
    };
  } finally {
    await withTimeout(browser.close(), 5000);
  }
}

async function visit(page, port, path) {
  const response = await page.goto(`http://127.0.0.1:${port}${path}`, {
    waitUntil: 'networkidle',
    timeout: 30000,
  });
  if (!response || !response.ok()) {
    throw new Error(`navigation failed for ${path}: ${response?.status() ?? 'no response'}`);
  }
}

async function expectVisible(page, selector) {
  await page.locator(selector).first().waitFor({ state: 'visible', timeout: 10000 });
}

async function screenshot(page, fileName) {
  const path = join(screenshotsDir, fileName);
  await page.screenshot({ path, fullPage: true });
  return toRelativePath(path);
}

async function hasMutation(page, table, expectedPayload) {
  return await page.evaluate(
    ({ table, expectedPayload }) => {
      const mutations = window.__loopletVisualMutations ?? [];
      return mutations.some((mutation) => {
        if (mutation.table !== table) return false;
        return payloadContains(mutation.payload, expectedPayload);
      });

      function payloadContains(actual, expected) {
        if (expected === null || typeof expected !== 'object') return Object.is(actual, expected);
        if (actual === null || typeof actual !== 'object') return false;
        return Object.entries(expected).every(([key, value]) =>
          payloadContains(actual[key], value),
        );
      }
    },
    { table, expectedPayload },
  );
}

async function noHorizontalOverflow(page) {
  return await page.evaluate(() => {
    const doc = document.documentElement;
    return doc.scrollWidth <= doc.clientWidth + 1;
  });
}

function startVite(port) {
  const command = process.platform === 'win32' ? 'cmd.exe' : 'npx';
  const args =
    process.platform === 'win32'
      ? ['/d', '/s', '/c', `npx vite --host 127.0.0.1 --port ${port}`]
      : ['vite', '--host', '127.0.0.1', '--port', String(port)];
  const child = spawn(command, args, {
    cwd: scratchDir,
    env: {
      ...process.env,
      VITE_SUPABASE_URL: 'https://example.supabase.co',
      VITE_SUPABASE_ANON_KEY: 'visual-smoke-anon-key',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => undefined);
  child.stderr.on('data', () => undefined);
  return child;
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

function toVitePath(path) {
  return path.replace(/\\/g, '/');
}

function toRelativePath(path) {
  return relative(rootDir, path).replace(/\\/g, '/');
}

async function withTimeout(promise, timeoutMs) {
  let timeout;
  try {
    await Promise.race([
      promise,
      new Promise((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
