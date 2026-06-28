import process from 'node:process';
import { requiredLocalTrialNames } from './full-trial-manifest.mjs';

export const posTrials = [
  ['syntax:pilot-evidence', process.execPath, ['--check', 'examples/pos-bridge/pilot-evidence.mjs']],
  ['syntax:go-live', process.execPath, ['--check', 'examples/pos-bridge/go-live.mjs']],
  ['syntax:pilot-report', process.execPath, ['--check', 'examples/pos-bridge/pilot-report.mjs']],
  ['syntax:pilot-bundle', process.execPath, ['--check', 'examples/pos-bridge/pilot-bundle.mjs']],
  ['syntax:completion-audit', process.execPath, ['--check', 'examples/pos-bridge/completion-audit.mjs']],
  ['syntax:pilot-kit', process.execPath, ['--check', 'examples/pos-bridge/pilot-kit.mjs']],
  ['syntax:integration-fit', process.execPath, ['--check', 'examples/pos-bridge/integration-fit.mjs']],
  [
    'syntax:field-sample-reconciliation',
    process.execPath,
    ['--check', 'examples/pos-bridge/field-sample-reconciliation.mjs'],
  ],
  ['syntax:pilot-go-live-trial', process.execPath, ['--check', 'examples/pos-bridge/pilot-go-live-trial.mjs']],
  ['deno-check:receipt-webhook', 'deno', ['check', 'supabase/functions/receipt-webhook/index.ts']],
  ['deno-check:receipt-sync-dispatch', 'deno', ['check', 'supabase/functions/receipt-sync-dispatch/index.ts']],
  ['deno-test:pos-reliability', 'deno', ['test', 'supabase/functions/receipt-webhook/posReliability.test.ts']],
  [
    'validate',
    process.execPath,
    [
      'examples/pos-bridge/validate.mjs',
      'examples/pos-bridge/sample-receipt.json',
      'examples/pos-bridge/sample-refund.json',
      'examples/pos-bridge/sample-void.json',
    ],
  ],
  ['configure-env-trial', process.execPath, ['examples/pos-bridge/configure-env-trial.mjs']],
  ['integration-fit-trial', process.execPath, ['examples/pos-bridge/integration-fit-trial.mjs']],
  ['pilot-kit-trial', process.execPath, ['examples/pos-bridge/pilot-kit-trial.mjs']],
  ['csv-trial', process.execPath, ['examples/pos-bridge/csv-adapter-trial.mjs']],
  ['readiness-trial', process.execPath, ['examples/pos-bridge/readiness-trial.mjs']],
  ['credential-probe-trial', process.execPath, ['examples/pos-bridge/credential-probe-trial.mjs']],
  ['pilot-evidence-trial', process.execPath, ['examples/pos-bridge/pilot-evidence-trial.mjs']],
  ['verify-pilot-evidence-trial', process.execPath, ['examples/pos-bridge/verify-pilot-evidence-trial.mjs']],
  ['pilot-go-live-trial', process.execPath, ['examples/pos-bridge/pilot-go-live-trial.mjs']],
  ['pilot-report-trial', process.execPath, ['examples/pos-bridge/pilot-report-trial.mjs']],
  ['pilot-bundle-trial', process.execPath, ['examples/pos-bridge/pilot-bundle-trial.mjs']],
  ['completion-audit-trial', process.execPath, ['examples/pos-bridge/completion-audit-trial.mjs']],
  ['pilot-pass-trial', process.execPath, ['examples/pos-bridge/pilot-pass-trial.mjs']],
  ['sample-fingerprint-trial', process.execPath, ['examples/pos-bridge/sample-fingerprint-trial.mjs']],
  ['reconcile-pilot-evidence-trial', process.execPath, ['examples/pos-bridge/reconcile-pilot-evidence-trial.mjs']],
  ['status-trial', process.execPath, ['examples/pos-bridge/status-trial.mjs']],
  [
    'package-trial',
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'examples/pos-bridge/package-windows-bridge-trial.ps1'],
  ],
  [
    'install-trial',
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'examples/pos-bridge/install-windows-task-trial.ps1'],
  ],
  ['bridge-trial', process.execPath, ['examples/pos-bridge/trial.mjs']],
  ['watch-trial', process.execPath, ['examples/pos-bridge/watch-trial.mjs']],
  ['receipt-hub-visual-smoke', process.execPath, ['examples/pos-bridge/receipt-hub-visual-smoke.mjs']],
  [
    'receipt-hub-cross-browser-smoke',
    process.execPath,
    ['examples/pos-bridge/receipt-hub-visual-smoke.mjs', '--browsers', 'chromium,firefox'],
  ],
  ['acceptance-trial', process.execPath, ['examples/pos-bridge/acceptance-trial.mjs']],
];

const plannedTrialNames = posTrials.map(([name]) => name);
const missingFromPlan = requiredLocalTrialNames.filter((name) => !plannedTrialNames.includes(name));
const extraInPlan = plannedTrialNames.filter((name) => !requiredLocalTrialNames.includes(name));
if (missingFromPlan.length > 0 || extraInPlan.length > 0) {
  throw new Error(
    `full-trial manifest mismatch: missing_from_plan=${missingFromPlan.join(',')}; extra_in_plan=${extraInPlan.join(',')}`,
  );
}
