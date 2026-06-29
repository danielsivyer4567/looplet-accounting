[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Root = Join-Path (Resolve-Path '.').Path '.claude\scratch\pos-install-trial'
$InstallRoot = Join-Path $Root 'install'
$EnvFile = Join-Path $Root 'pos-bridge.env'
$InboxDir = Join-Path $Root 'receipts-inbox'
$LogDir = Join-Path $InstallRoot 'logs'
$Installer = Join-Path (Resolve-Path '.').Path 'examples\pos-bridge\install-windows-task.ps1'

function Assert-True {
  param(
    [bool]$Condition,
    [string]$Message
  )
  if (-not $Condition) {
    throw $Message
  }
}

if (Test-Path -LiteralPath $Root) {
  Remove-Item -LiteralPath $Root -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $Root | Out-Null

$planJson = & powershell -NoProfile -ExecutionPolicy Bypass -File $Installer `
  -InstallRoot $InstallRoot `
  -EnvFile $EnvFile `
  -InboxDir $InboxDir `
  -NodePath node `
  -NoRegister
$plan = $planJson | ConvertFrom-Json
Assert-True ($plan.ok -eq $true) 'installer plan should be ok'
Assert-True ($plan.apply -eq $false) 'installer should default to plan mode'
Assert-True ($plan.will_register_task -eq $false) 'plan mode must not register a scheduled task'
Assert-True ([string]$plan.task_command -like '*run-watch-once.ps1*') 'task command must use the logging runner'
Assert-True ([string]$plan.task_command -like '*-InboxDir*') 'task command must pass the inbox directory to the logging runner'
Assert-True ($plan.will_harden_env_acl -eq $false) 'plan mode must report no ACL changes'

$installJson = & powershell -NoProfile -ExecutionPolicy Bypass -File $Installer `
  -Apply `
  -NoRegister `
  -InstallRoot $InstallRoot `
  -EnvFile $EnvFile `
  -InboxDir $InboxDir `
  -NodePath node
$install = $installJson | ConvertFrom-Json
Assert-True ($install.ok -eq $true) 'installer apply should be ok'
Assert-True ($install.registered_task -eq $false) 'trial must not register a scheduled task'
Assert-True ($install.env_acl.ok -eq $true) 'installer must harden env file ACL'
Assert-True ($install.env_acl.protected -eq $true) 'installer must disable inherited env file ACLs'

$InstalledFiles = @(
  'README.md',
  'MERCHANT_INTEGRATION_DESIGN.md',
  'PILOT_CHECKLIST.md',
  'bridge.mjs',
  'bridge-retry-drill.mjs',
  'integration-fit.mjs',
  'pilot-kit.mjs',
  'run-watch-once.ps1',
  'contract.mjs',
  'readiness.mjs',
  'status.mjs',
  'pilot-pass.mjs',
  'sample-fingerprint.mjs',
  'field-sample-capture.mjs',
  'field-sample-reconciliation.mjs',
  'reconcile-pilot-evidence.mjs',
  'pilot-evidence.mjs',
  'verify-pilot-evidence.mjs',
  'go-live.mjs',
  'pilot-report.mjs',
  'pilot-bundle.mjs',
  'completion-audit.mjs',
  'full-trial-manifest.mjs',
  'credential-probe.mjs',
  'configure-env.mjs',
  'validate.mjs',
  'csv-adapter.mjs',
  'acceptance.mjs',
  'install-windows-task.ps1',
  'sample-receipt.json',
  'sample-refund.json',
  'sample-void.json',
  'sample-invalid-pending.json',
  'integration-fit.example.json',
  'pilot-site.example.json',
  'sample-pos-export.csv',
  'sample-pos-export-bad-lines.csv',
  '.env.example'
)
foreach ($file in $InstalledFiles) {
  Assert-True (Test-Path -LiteralPath (Join-Path $InstallRoot $file)) "missing installed file $file"
}
Assert-True (-not (Test-Path -LiteralPath (Join-Path $InstallRoot 'full-trial-plan.mjs'))) 'installer should not copy local-only full trial command plan'
$checklist = Get-Content -LiteralPath (Join-Path $InstallRoot 'PILOT_CHECKLIST.md') -Raw
$design = Get-Content -LiteralPath (Join-Path $InstallRoot 'MERCHANT_INTEGRATION_DESIGN.md') -Raw
Assert-True ($design -match 'Direct POS Webhook/API') 'installed merchant design must describe direct POS webhook/API mode'
Assert-True ($design -match 'Looplet Bridge Watch Folder') 'installed merchant design must describe bridge watch-folder mode'
Assert-True ($design -match 'Node\.js 20\+') 'installed merchant design must name Node.js 20+ bridge runtime'
Assert-True ($design -match 'EFTPOS terminal events alone are not enough') 'installed merchant design must explain EFTPOS limitation'
Assert-True ($design -match 'customer-scanned `identity_token`') 'installed merchant design must require scanned identity token'
Assert-True ($design -match 'Idempotency-Key') 'installed merchant design must require idempotency header/key'
Assert-True ($checklist -match 'Go-live requires `ok: true`') 'installed pilot checklist must include go-live verifier requirement'
Assert-True ($checklist -match '--preflight-only') 'installed pilot checklist must include non-sending go-live preflight command'
Assert-True ($checklist -match 'pos-pilot-preflight\.json') 'installed pilot checklist must save go-live preflight evidence'
Assert-True ($checklist -match 'summary\.acceptance_skipped: true') 'installed pilot checklist must require preflight acceptance skip proof'
Assert-True ($checklist -match 'field-sample-capture\.mjs') 'installed pilot checklist must include raw field-sample capture staging command'
Assert-True ($checklist -match 'field-sample-capture\.json') 'installed pilot checklist must save raw field-sample capture manifest'
Assert-True ($checklist -match 'unresolved refund/void original sale references rejected') 'installed pilot checklist must include unresolved original-sale negative control'
Assert-True ($checklist -match 'same idempotency key with changed receipt facts rejected') 'installed pilot checklist must include idempotency mismatch negative control'
Assert-True ($checklist -match 'conflicting `Idempotency-Key` header/body values rejected') 'installed pilot checklist must include idempotency source mismatch negative control'
Assert-True ($checklist -match 'missing merchant name rejected') 'installed pilot checklist must include missing merchant negative control'
Assert-True ($checklist -match 'missing GST rejected') 'installed pilot checklist must include missing GST negative control'
Assert-True ($checklist -match 'missing subtotal rejected') 'installed pilot checklist must include missing subtotal negative control'
Assert-True ($checklist -match 'inconsistent GST/subtotal breakdown rejected') 'installed pilot checklist must include bad GST/subtotal negative control'
Assert-True ($checklist -match 'bad line GST totals rejected') 'installed pilot checklist must include bad line GST negative control'
Assert-True ($checklist -match 'receipt-webhook API request logs persist') 'installed pilot checklist must include API request log persistence proof'
Assert-True ($checklist -match 'checks\.bridge_files\.manifest\.ok: true') 'installed pilot checklist must include installed manifest verification'
Assert-True ($checklist -match 'bridge-retry-drill\.mjs') 'installed pilot checklist must include retry drill command'
Assert-True ($checklist -match 'queued_after_outage: true') 'installed pilot checklist must include retry drill outage proof'
Assert-True ($checklist -match 'renaming `sample-receipt\.json`') 'installed pilot checklist must reject renamed bundled samples'
Assert-True (Test-Path -LiteralPath $EnvFile) 'env template should be created'
Assert-True (Test-Path -LiteralPath $InboxDir) 'inbox directory should be created'
$envAcl = [System.IO.File]::GetAccessControl((Resolve-Path -LiteralPath $EnvFile).Path)
Assert-True ($envAcl.AreAccessRulesProtected -eq $true) 'env file ACL should be protected from inherited broad access'
$envAccessSids = @($envAcl.Access | ForEach-Object {
  try {
    $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
  } catch {
    $_.IdentityReference.Value
  }
})
Assert-True (-not ($envAccessSids -contains 'S-1-1-0')) 'env file ACL must not allow Everyone'
Assert-True (-not ($envAccessSids -contains 'S-1-5-11')) 'env file ACL must not allow Authenticated Users'
Assert-True (-not ($envAccessSids -contains 'S-1-5-32-545')) 'env file ACL must not allow built-in Users'

Set-Content -LiteralPath $EnvFile -Encoding UTF8 -Value @(
  'LOOPLET_RECEIPT_WEBHOOK_URL=http://127.0.0.1:55321/functions/v1/receipt-webhook',
  'LOOPLET_POS_API_KEY=llp_trial.secret',
  'LOOPLET_RECEIPT_IDENTITY_TOKEN=rhp_trial.receiptsecret',
  'LOOPLET_SYNC_TARGETS=xero,myob',
  "LOOPLET_BRIDGE_QUEUE_FILE=$InstallRoot\.looplet-pos-queue.jsonl",
  "LOOPLET_BRIDGE_DEAD_LETTER_FILE=$InstallRoot\.looplet-pos-dead.jsonl",
  "LOOPLET_BRIDGE_INBOX_DIR=$InboxDir",
  "LOOPLET_BRIDGE_LOG_DIR=$LogDir",
  'LOOPLET_BRIDGE_STALE_AFTER_MINUTES=10',
  "LOOPLET_READINESS_SAMPLE=$InstallRoot\sample-receipt.json",
  'LOOPLET_READINESS_SKIP_NETWORK=1'
)

$readinessJson = & node (Join-Path $InstallRoot 'readiness.mjs') --env-file $EnvFile --skip-network
$readiness = $readinessJson | ConvertFrom-Json
Assert-True ($readiness.ok -eq $true) 'installed readiness check should pass'
Assert-True ($readiness.checks.node.ok -eq $true) 'readiness should prove Node 20+'
Assert-True ($readiness.checks.config.ok -eq $true) 'readiness should prove config shape'
Assert-True ($readiness.checks.bridge_files.ok -eq $true) 'readiness should prove installed bridge files complete'
Assert-True ($readiness.checks.bridge_files.missing.Count -eq 0) 'readiness should report no missing installed bridge files'
Assert-True ($readiness.checks.bridge_files.manifest.present -eq $false) 'direct installer readiness should report no package manifest'
Assert-True ($readiness.checks.inbox.ok -eq $true) 'readiness should prove inbox is writable'
Assert-True ($readiness.checks.contract.ok -eq $true) 'readiness should prove sample contract'
Assert-True ($readiness.checks.network.skipped -eq $true) 'trial should skip external network'

$retryDrillJson = & node (Join-Path $InstallRoot 'bridge-retry-drill.mjs') --env-file $EnvFile --sample (Join-Path $InstallRoot 'sample-receipt.json')
$retryDrill = $retryDrillJson | ConvertFrom-Json
Assert-True ($retryDrill.ok -eq $true) 'installed bridge retry drill should pass'
Assert-True ($retryDrill.non_sending -eq $true) 'installed bridge retry drill must be non-sending'
Assert-True ($retryDrill.failed_requests_seen -ge 2) 'installed bridge retry drill should prove transient retries'
Assert-True ($retryDrill.queued_after_outage -eq $true) 'installed bridge retry drill should prove outage queueing'
Assert-True ($retryDrill.queue_flushed_after_recovery -eq $true) 'installed bridge retry drill should prove recovery flush'
Assert-True ($retryDrill.accepted_after_recovery -eq $true) 'installed bridge retry drill should prove accepted receipt after recovery'
Assert-True ($retryDrill.secrets_redacted -eq $true) 'installed bridge retry drill should prove redaction'

$fitJson = & node (Join-Path $InstallRoot 'integration-fit.mjs') (Join-Path $InstallRoot 'integration-fit.example.json')
$fit = $fitJson | ConvertFrom-Json
Assert-True ($fit.ok -eq $true) 'installed integration fit should pass'
Assert-True ($fit.recommendation.connector_mode -eq 'bridge_watch_folder') 'installed integration fit should recommend bridge watch folder for the example'
Assert-True ($fit.recommendation.receipt_source_format -eq 'pos_json_export') 'installed integration fit should emit the site receipt source format'
Assert-True ($fit.recommendation.field_sample_capture_method -eq 'pos_native_json_export') 'installed integration fit should emit the site field sample capture method'
Assert-True (($fit.next_steps -join ' ') -match 'go-live\.mjs') 'installed integration fit should point to go-live evidence'

$PilotKitDir = Join-Path $Root 'installed-pilot-kit'
$pilotKitJson = & node (Join-Path $InstallRoot 'pilot-kit.mjs') (Join-Path $InstallRoot 'integration-fit.example.json') `
  --output-dir $PilotKitDir `
  --pilot-id 'install-trial' `
  --looplet-organization-id '11111111-1111-4111-8111-111111111111'
$pilotKit = $pilotKitJson | ConvertFrom-Json
Assert-True ($pilotKit.ok -eq $true) 'installed pilot-kit should pass'
Assert-True ($pilotKit.connector_mode -eq 'bridge_watch_folder') 'installed pilot-kit should carry connector recommendation'
Assert-True (Test-Path -LiteralPath (Join-Path $PilotKitDir 'pos-pilot-site.template.json')) 'installed pilot-kit should write site template'
Assert-True (Test-Path -LiteralPath (Join-Path $PilotKitDir 'PILOT_RUNBOOK.md')) 'installed pilot-kit should write runbook'
Assert-True (Test-Path -LiteralPath (Join-Path $PilotKitDir 'go-live-command.ps1')) 'installed pilot-kit should write go-live command'

$pilotPassPath = Join-Path $Root 'installed-pilot-pass.html'
$pilotPassJson = & node (Join-Path $InstallRoot 'pilot-pass.mjs') `
  --env-file $EnvFile `
  --output $pilotPassPath `
  --business-name 'Installed Package Trial' `
  --pilot-id 'install-trial'
$pilotPass = $pilotPassJson | ConvertFrom-Json
Assert-True ($pilotPass.ok -eq $true) 'installed pilot-pass should pass'
Assert-True (-not ($pilotPassJson -match 'rhp_trial\.receiptsecret')) 'installed pilot-pass stdout should redact token'
$pilotPassHtml = Get-Content -LiteralPath $pilotPassPath -Raw
Assert-True ($pilotPassHtml -match 'POS scannable receipt identity barcode') 'installed pilot-pass output must include barcode'
Assert-True ($pilotPassHtml -match 'rhp_trial\.receiptsecret') 'installed pilot-pass output must contain scannable token'
Assert-True ($pilotPassHtml -match 'class="bar"') 'installed pilot-pass barcode bars must be styled separately from the background'
Assert-True ($pilotPassHtml -match '\.barcode \.bar') 'installed pilot-pass CSS must not color every SVG rect'

$fingerprintJson = & node (Join-Path $InstallRoot 'sample-fingerprint.mjs') (Join-Path $InstallRoot 'sample-receipt.json')
$fingerprint = $fingerprintJson | ConvertFrom-Json
Assert-True ($fingerprint.ok -eq $true) 'installed sample-fingerprint should pass'
Assert-True (-not ($fingerprintJson -match 'rhp_customer\.receiptsecret')) 'installed sample-fingerprint stdout should redact token'
$fingerprintSample = @($fingerprint.samples)[0]
Assert-True ($fingerprintSample.redacted_sample_sha256 -match '^[0-9a-f]{64}$') 'installed sample-fingerprint should emit a SHA-256 fingerprint'
$fingerprintMatchJson = & node (Join-Path $InstallRoot 'sample-fingerprint.mjs') `
  (Join-Path $InstallRoot 'sample-receipt.json') `
  --expected $fingerprintSample.redacted_sample_sha256
$fingerprintMatch = $fingerprintMatchJson | ConvertFrom-Json
Assert-True ($fingerprintMatch.ok -eq $true) 'installed sample-fingerprint should match expected fingerprint'

& node --check (Join-Path $InstallRoot 'reconcile-pilot-evidence.mjs') | Out-Null
Assert-True ($LASTEXITCODE -eq 0) 'installed reconcile-pilot-evidence should parse'

& node --check (Join-Path $InstallRoot 'field-sample-reconciliation.mjs') | Out-Null
Assert-True ($LASTEXITCODE -eq 0) 'installed field-sample-reconciliation should parse'

& node --check (Join-Path $InstallRoot 'field-sample-capture.mjs') | Out-Null
Assert-True ($LASTEXITCODE -eq 0) 'installed field-sample-capture should parse'

& node --check (Join-Path $InstallRoot 'go-live.mjs') | Out-Null
Assert-True ($LASTEXITCODE -eq 0) 'installed go-live runner should parse'

& node --check (Join-Path $InstallRoot 'pilot-report.mjs') | Out-Null
Assert-True ($LASTEXITCODE -eq 0) 'installed pilot-report should parse'

& node --check (Join-Path $InstallRoot 'pilot-bundle.mjs') | Out-Null
Assert-True ($LASTEXITCODE -eq 0) 'installed pilot-bundle should parse'

& node --check (Join-Path $InstallRoot 'completion-audit.mjs') | Out-Null
Assert-True ($LASTEXITCODE -eq 0) 'installed completion-audit should parse'
$completionAuditSmokeJson = & node (Join-Path $InstallRoot 'completion-audit.mjs') --skip-local
Assert-True ($LASTEXITCODE -eq 1) 'installed completion-audit runtime smoke should fail expected local proof gate'
$completionAuditSmoke = $completionAuditSmokeJson | ConvertFrom-Json
Assert-True ($completionAuditSmoke.ok -eq $false) 'installed completion-audit runtime smoke should emit failure JSON'
Assert-True (($completionAuditSmoke.failures -join ' ') -match 'local full POS trial must pass') 'installed completion-audit runtime smoke should prove local gate ran'

& node --check (Join-Path $InstallRoot 'integration-fit.mjs') | Out-Null
Assert-True ($LASTEXITCODE -eq 0) 'installed integration fit should parse'

& node --check (Join-Path $InstallRoot 'pilot-kit.mjs') | Out-Null
Assert-True ($LASTEXITCODE -eq 0) 'installed pilot-kit should parse'

& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $InstallRoot 'run-watch-once.ps1') `
  -NodePath node `
  -BridgePath (Join-Path $InstallRoot 'bridge.mjs') `
  -EnvFile $EnvFile `
  -InboxDir $InboxDir `
  -LogDir $LogDir | Out-Null
Assert-True ($LASTEXITCODE -eq 0) 'installed logging runner should execute watch-once'
$logFiles = @(Get-ChildItem -LiteralPath $LogDir -Filter 'bridge-*.log' -File)
Assert-True ($logFiles.Count -eq 1) 'logging runner should create one daily log'
$logAcl = [System.IO.File]::GetAccessControl($logFiles[0].FullName)
Assert-True ($logAcl.AreAccessRulesProtected -eq $true) 'logging runner should protect the scheduled-task log ACL'
$logAccessSids = @($logAcl.Access | ForEach-Object {
  try {
    $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
  } catch {
    $_.IdentityReference.Value
  }
})
Assert-True (-not ($logAccessSids -contains 'S-1-1-0')) 'scheduled-task log ACL must not allow Everyone'
Assert-True (-not ($logAccessSids -contains 'S-1-5-11')) 'scheduled-task log ACL must not allow Authenticated Users'
Assert-True (-not ($logAccessSids -contains 'S-1-5-32-545')) 'scheduled-task log ACL must not allow built-in Users'
$logContent = Get-Content -LiteralPath $logFiles[0].FullName -Raw
Assert-True ($logContent -like '*watch_once_start*') 'log should include watch start'
Assert-True ($logContent -like '*watch_once_processed 0*') 'log should include watch result'
Assert-True ($logContent -like '*watch_once_end exit_code=0*') 'log should include exit code'
Assert-True (-not ($logContent -match 'llp_trial\.secret')) 'log should not expose POS API key'
Assert-True (-not ($logContent -match 'rhp_trial\.receiptsecret')) 'log should not expose receipt identity token'

$statusJson = & node (Join-Path $InstallRoot 'status.mjs') --env-file $EnvFile
$status = $statusJson | ConvertFrom-Json
Assert-True ($status.ok -eq $true) 'installed status should pass after logged watch-once'
Assert-True ($status.scheduler.ok -eq $true) 'installed status should prove scheduled task log is fresh'

$pilotEvidenceFile = Join-Path $Root 'installed-pilot-evidence.json'
$pilotJson = & node (Join-Path $InstallRoot 'pilot-evidence.mjs') --env-file $EnvFile --output $pilotEvidenceFile --skip-network
$pilot = $pilotJson | ConvertFrom-Json
Assert-True ($pilot.ok -eq $true) 'installed pilot evidence preflight should pass'
Assert-True ($pilot.acceptance.skipped -eq $true) 'installed pilot evidence should skip acceptance by default'
Assert-True (Test-Path -LiteralPath $pilotEvidenceFile) 'installed pilot evidence should write output'

$verifyJson = & node (Join-Path $InstallRoot 'verify-pilot-evidence.mjs') $pilotEvidenceFile --evidence-only
$verify = $verifyJson | ConvertFrom-Json
Assert-True ($verify.ok -eq $false) 'installed verifier should reject preflight-only evidence'
Assert-True (($verify.failures -join ' ') -match 'acceptance') 'installed verifier should explain missing acceptance'

& node --check (Join-Path $InstallRoot 'acceptance.mjs') | Out-Null
Assert-True ($LASTEXITCODE -eq 0) 'installed acceptance runner should parse'

[ordered]@{
  ok = $true
  plan_mode_safe = $true
  installed_without_registering_task = $true
  env_acl_protected = $envAcl.AreAccessRulesProtected
  env_acl_excludes_everyone = -not ($envAccessSids -contains 'S-1-1-0')
  env_acl_excludes_authenticated_users = -not ($envAccessSids -contains 'S-1-5-11')
  env_acl_excludes_builtin_users = -not ($envAccessSids -contains 'S-1-5-32-545')
  install_root = $InstallRoot
  env_file = $EnvFile
  inbox_dir = $InboxDir
  readiness_ok = $readiness.ok
  readiness_bridge_files_ok = $readiness.checks.bridge_files.ok
  retry_drill_ok = $retryDrill.ok
  pilot_pass_ok = $pilotPass.ok
  sample_fingerprint_ok = $fingerprint.ok
  reconcile_pilot_evidence_parse_ok = $true
  field_sample_reconciliation_parse_ok = $true
  go_live_parse_ok = $true
  pilot_report_parse_ok = $true
  pilot_bundle_parse_ok = $true
  completion_audit_parse_ok = $true
  completion_audit_runtime_smoke_ok = ($completionAuditSmoke.ok -eq $false)
  integration_fit_ok = $fit.ok
  integration_fit_parse_ok = $true
  pilot_kit_ok = $pilotKit.ok
  pilot_kit_parse_ok = $true
  pilot_evidence_ok = $pilot.ok
  verifier_rejected_preflight = ($verify.ok -eq $false)
  acceptance_runner_parse_ok = $true
  logging_runner_ok = $true
  log_acl_protected = $logAcl.AreAccessRulesProtected
  log_acl_excludes_everyone = -not ($logAccessSids -contains 'S-1-1-0')
  log_acl_excludes_authenticated_users = -not ($logAccessSids -contains 'S-1-5-11')
  log_acl_excludes_builtin_users = -not ($logAccessSids -contains 'S-1-5-32-545')
  status_scheduler_ok = $status.scheduler.ok
  log_file = $logFiles[0].FullName
  installed_files_checked = $InstalledFiles.Count
} | ConvertTo-Json -Depth 4
