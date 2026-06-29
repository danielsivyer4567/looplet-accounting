[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Root = Join-Path (Resolve-Path '.').Path '.claude\scratch\pos-bridge-package-trial'
$Builder = Join-Path (Resolve-Path '.').Path 'examples\pos-bridge\package-windows-bridge.ps1'
$OutputDir = Join-Path $Root 'out'
$PackageName = 'looplet-pos-bridge-trial'
$ExtractDir = Join-Path $Root 'extract'
$ExpandedRoot = Join-Path $ExtractDir $PackageName
$InstalledRoot = Join-Path $Root 'installed'
$InstalledEnvFile = Join-Path $Root 'installed-pos-bridge.env'
$InstalledInboxDir = Join-Path $Root 'installed-inbox'
$InstalledLogDir = Join-Path $InstalledRoot 'logs'
$EnvFile = Join-Path $ExpandedRoot 'trial.env'
$InboxDir = Join-Path $Root 'inbox'
$LogDir = Join-Path $Root 'logs'

function Assert-True {
  param(
    [bool]$Condition,
    [string]$Message
  )
  if (-not $Condition) {
    throw $Message
  }
}

function Get-Sha256Hex {
  param([string]$Path)

  $sha = [System.Security.Cryptography.SHA256]::Create()
  $stream = [System.IO.File]::OpenRead((Resolve-Path -LiteralPath $Path).Path)
  try {
    $hash = $sha.ComputeHash($stream)
    return -join ($hash | ForEach-Object { $_.ToString('x2') })
  } finally {
    $stream.Dispose()
    $sha.Dispose()
  }
}

if (Test-Path -LiteralPath $Root) {
  Remove-Item -LiteralPath $Root -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $Root | Out-Null

$packageJson = & powershell -NoProfile -ExecutionPolicy Bypass -File $Builder -OutputDir $OutputDir -PackageName $PackageName
$package = $packageJson | ConvertFrom-Json
Assert-True ($package.ok -eq $true) 'package builder should succeed'
Assert-True (Test-Path -LiteralPath $package.zip_path) 'package zip should exist'
Assert-True (Test-Path -LiteralPath $package.manifest) 'manifest should exist in package root'
Assert-True ($package.zip_bytes -gt 1000) 'package zip should be non-empty'

New-Item -ItemType Directory -Force -Path $ExtractDir | Out-Null
Expand-Archive -LiteralPath $package.zip_path -DestinationPath $ExpandedRoot -Force

$required = @(
  'README.md',
  'MERCHANT_INTEGRATION_DESIGN.md',
  'PILOT_CHECKLIST.md',
  '.env.example',
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
  'MANIFEST.json'
)
foreach ($file in $required) {
  Assert-True (Test-Path -LiteralPath (Join-Path $ExpandedRoot $file)) "expanded package missing $file"
}
$checklist = Get-Content -LiteralPath (Join-Path $ExpandedRoot 'PILOT_CHECKLIST.md') -Raw
$design = Get-Content -LiteralPath (Join-Path $ExpandedRoot 'MERCHANT_INTEGRATION_DESIGN.md') -Raw
Assert-True ($design -match 'Direct POS Webhook/API') 'merchant design must describe direct POS webhook/API mode'
Assert-True ($design -match 'Looplet Bridge Watch Folder') 'merchant design must describe bridge watch-folder mode'
Assert-True ($design -match 'Node\.js 20\+') 'merchant design must name Node.js 20+ bridge runtime'
Assert-True ($design -match 'EFTPOS terminal events alone are not enough') 'merchant design must explain EFTPOS limitation'
Assert-True ($design -match 'customer-scanned `identity_token`') 'merchant design must require scanned identity token'
Assert-True ($design -match 'Idempotency-Key') 'merchant design must require idempotency header/key'
Assert-True ($checklist -match 'Go-live requires `ok: true`') 'pilot checklist must include go-live verifier requirement'
Assert-True ($checklist -match '--preflight-only') 'pilot checklist must include non-sending go-live preflight command'
Assert-True ($checklist -match 'pos-pilot-preflight\.json') 'pilot checklist must save go-live preflight evidence'
Assert-True ($checklist -match 'summary\.acceptance_skipped: true') 'pilot checklist must require preflight acceptance skip proof'
Assert-True ($checklist -match 'field-sample-capture\.mjs') 'pilot checklist must include raw field-sample capture staging command'
Assert-True ($checklist -match 'field-sample-capture\.json') 'pilot checklist must save raw field-sample capture manifest'
Assert-True ($checklist -match 'unresolved refund/void original sale references rejected') 'pilot checklist must include unresolved original-sale negative control'
Assert-True ($checklist -match 'same idempotency key with changed receipt facts rejected') 'pilot checklist must include idempotency mismatch negative control'
Assert-True ($checklist -match 'conflicting `Idempotency-Key` header/body values rejected') 'pilot checklist must include idempotency source mismatch negative control'
Assert-True ($checklist -match 'missing merchant name rejected') 'pilot checklist must include missing merchant negative control'
Assert-True ($checklist -match 'missing GST rejected') 'pilot checklist must include missing GST negative control'
Assert-True ($checklist -match 'missing subtotal rejected') 'pilot checklist must include missing subtotal negative control'
Assert-True ($checklist -match 'inconsistent GST/subtotal breakdown rejected') 'pilot checklist must include bad GST/subtotal negative control'
Assert-True ($checklist -match 'bad line GST totals rejected') 'pilot checklist must include bad line GST negative control'
Assert-True ($checklist -match 'receipt-webhook API request logs persist') 'pilot checklist must include API request log persistence proof'
Assert-True ($checklist -match 'checks\.bridge_files\.manifest\.ok: true') 'pilot checklist must include installed manifest verification'
Assert-True ($checklist -match 'bridge-retry-drill\.mjs') 'pilot checklist must include retry drill command'
Assert-True ($checklist -match 'queued_after_outage: true') 'pilot checklist must include retry drill outage proof'
Assert-True ($checklist -match 'renaming `sample-receipt\.json`') 'pilot checklist must reject renamed bundled samples'
Assert-True (-not (Test-Path -LiteralPath (Join-Path $ExpandedRoot 'status-trial.mjs'))) 'package should not include local-only status trial'
Assert-True (-not (Test-Path -LiteralPath (Join-Path $ExpandedRoot 'local-edge-trial.mjs'))) 'package should not include local-only edge trial'
Assert-True (-not (Test-Path -LiteralPath (Join-Path $ExpandedRoot 'local-edge-server.ts'))) 'package should not include local-only edge server'
Assert-True (-not (Test-Path -LiteralPath (Join-Path $ExpandedRoot 'full-trial-plan.mjs'))) 'package should not include local-only full trial command plan'

$fitJson = & node (Join-Path $ExpandedRoot 'integration-fit.mjs') (Join-Path $ExpandedRoot 'integration-fit.example.json')
$fit = $fitJson | ConvertFrom-Json
Assert-True ($fit.ok -eq $true) 'expanded package integration fit should pass'
Assert-True ($fit.recommendation.connector_mode -eq 'bridge_watch_folder') 'expanded package integration fit should recommend bridge watch folder for the example'
Assert-True ($fit.recommendation.receipt_source_format -eq 'pos_json_export') 'expanded package integration fit should emit the site receipt source format'
Assert-True ($fit.recommendation.field_sample_capture_method -eq 'pos_native_json_export') 'expanded package integration fit should emit the site field sample capture method'
Assert-True ($fit.webhook_config.headers.Authorization -eq 'Bearer llp_<prefix>.<secret>') 'expanded package integration fit should emit safe webhook header template'
Assert-True (($fit.next_steps -join ' ') -match 'go-live\.mjs') 'expanded package integration fit should point to go-live evidence'

$PilotKitDir = Join-Path $Root 'expanded-pilot-kit'
$pilotKitJson = & node (Join-Path $ExpandedRoot 'pilot-kit.mjs') (Join-Path $ExpandedRoot 'integration-fit.example.json') `
  --output-dir $PilotKitDir `
  --pilot-id 'package-trial' `
  --looplet-organization-id '11111111-1111-4111-8111-111111111111'
$pilotKit = $pilotKitJson | ConvertFrom-Json
Assert-True ($pilotKit.ok -eq $true) 'expanded package pilot-kit should pass'
Assert-True ($pilotKit.connector_mode -eq 'bridge_watch_folder') 'expanded package pilot-kit should carry connector recommendation'
Assert-True (Test-Path -LiteralPath (Join-Path $PilotKitDir 'pos-pilot-site.template.json')) 'expanded package pilot-kit should write site template'
Assert-True (Test-Path -LiteralPath (Join-Path $PilotKitDir 'PILOT_RUNBOOK.md')) 'expanded package pilot-kit should write runbook'
Assert-True (Test-Path -LiteralPath (Join-Path $PilotKitDir 'go-live-command.ps1')) 'expanded package pilot-kit should write go-live command'

$manifest = Get-Content -LiteralPath (Join-Path $ExpandedRoot 'MANIFEST.json') -Raw | ConvertFrom-Json
Assert-True ($manifest.files.Count -eq ($required.Count - 1)) 'manifest file count mismatch'
foreach ($entry in $manifest.files) {
  $path = Join-Path $ExpandedRoot $entry.path
  Assert-True (Test-Path -LiteralPath $path) "manifest file missing: $($entry.path)"
  $actualHash = Get-Sha256Hex $path
  Assert-True ($actualHash -eq $entry.sha256) "manifest hash mismatch: $($entry.path)"
}

$configureJson = & node (Join-Path $ExpandedRoot 'configure-env.mjs') `
  --output $EnvFile `
  --webhook-url 'http://127.0.0.1:55321/functions/v1/receipt-webhook' `
  --api-key 'llp_trial.secret' `
  --identity-token 'rhp_trial.receiptsecret' `
  --sync-targets 'xero,myob' `
  --queue-file "$Root\queue.jsonl" `
  --dead-letter-file "$Root\dead.jsonl" `
  --inbox-dir $InboxDir `
  --log-dir $LogDir `
  --readiness-sample "$ExpandedRoot\sample-receipt.json"
$configured = $configureJson | ConvertFrom-Json
Assert-True ($configured.ok -eq $true) 'expanded package configure-env should pass'
Assert-True ($configured.secret_file_protected -eq $true) 'expanded package configure-env should protect env file'
Assert-True ($configured.secret_file_protection.ok -eq $true) 'expanded package configure-env should report env file protection details'
Assert-True (-not ($configureJson -match 'llp_trial.secret')) 'configure-env stdout should redact API key'
Assert-True (-not ($configureJson -match 'rhp_trial.receiptsecret')) 'configure-env stdout should redact receipt token'
$envAcl = [System.IO.File]::GetAccessControl((Resolve-Path -LiteralPath $EnvFile).Path)
Assert-True ($envAcl.AreAccessRulesProtected -eq $true) 'expanded package configure-env should disable inherited env file ACLs'
$envAccessSids = @($envAcl.Access | ForEach-Object {
  try {
    $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
  } catch {
    $_.IdentityReference.Value
  }
})
Assert-True (-not ($envAccessSids -contains 'S-1-1-0')) 'expanded package env file ACL must not allow Everyone'
Assert-True (-not ($envAccessSids -contains 'S-1-5-11')) 'expanded package env file ACL must not allow Authenticated Users'
Assert-True (-not ($envAccessSids -contains 'S-1-5-32-545')) 'expanded package env file ACL must not allow built-in Users'
Add-Content -LiteralPath $EnvFile -Value 'LOOPLET_READINESS_SKIP_NETWORK=1'

$readinessJson = & node (Join-Path $ExpandedRoot 'readiness.mjs') --env-file $EnvFile --skip-network
$readiness = $readinessJson | ConvertFrom-Json
Assert-True ($readiness.ok -eq $true) 'expanded package readiness should pass'
Assert-True ($readiness.checks.bridge_files.ok -eq $true) 'expanded package readiness should prove bridge files complete'
Assert-True ($readiness.checks.bridge_files.missing.Count -eq 0) 'expanded package readiness should report no missing bridge files'
Assert-True ($readiness.checks.bridge_files.manifest.present -eq $true) 'expanded package readiness should detect MANIFEST.json'
Assert-True ($readiness.checks.bridge_files.manifest.ok -eq $true) 'expanded package readiness should verify manifest hashes'
Assert-True ($readiness.checks.bridge_files.manifest.checked_files -eq $manifest.files.Count) 'expanded package readiness should verify every manifest file'

$retryDrillJson = & node (Join-Path $ExpandedRoot 'bridge-retry-drill.mjs') --env-file $EnvFile --sample (Join-Path $ExpandedRoot 'sample-receipt.json')
$retryDrill = $retryDrillJson | ConvertFrom-Json
Assert-True ($retryDrill.ok -eq $true) 'expanded package bridge retry drill should pass'
Assert-True ($retryDrill.non_sending -eq $true) 'expanded package bridge retry drill must be non-sending'
Assert-True ($retryDrill.failed_requests_seen -ge 2) 'expanded package bridge retry drill should prove transient retries'
Assert-True ($retryDrill.queued_after_outage -eq $true) 'expanded package bridge retry drill should prove outage queueing'
Assert-True ($retryDrill.queue_flushed_after_recovery -eq $true) 'expanded package bridge retry drill should prove recovery flush'
Assert-True ($retryDrill.accepted_after_recovery -eq $true) 'expanded package bridge retry drill should prove accepted receipt after recovery'
Assert-True ($retryDrill.secrets_redacted -eq $true) 'expanded package bridge retry drill should prove redaction'

$TamperedRoot = Join-Path $Root 'tampered-package'
Copy-Item -LiteralPath $ExpandedRoot -Destination $TamperedRoot -Recurse -Force
Add-Content -LiteralPath (Join-Path $TamperedRoot 'README.md') -Value 'tampered after packaging'
$tamperedReadinessJson = & node (Join-Path $TamperedRoot 'readiness.mjs') --env-file $EnvFile --skip-network
$tamperedReadiness = $tamperedReadinessJson | ConvertFrom-Json
Assert-True ($LASTEXITCODE -ne 0) 'tampered package readiness should exit non-zero'
Assert-True ($tamperedReadiness.ok -eq $false) 'tampered package readiness should fail'
Assert-True ($tamperedReadiness.checks.bridge_files.manifest.ok -eq $false) 'tampered package readiness should fail manifest verification'
Assert-True (($tamperedReadiness.checks.bridge_files.manifest.errors -join ' ') -match 'manifest hash mismatch') 'tampered package readiness should explain manifest hash mismatch'

$installJson = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ExpandedRoot 'install-windows-task.ps1') `
  -Apply `
  -NoRegister `
  -InstallRoot $InstalledRoot `
  -EnvFile $InstalledEnvFile `
  -InboxDir $InstalledInboxDir `
  -NodePath node
$install = $installJson | ConvertFrom-Json
Assert-True ($install.ok -eq $true) 'expanded package installer should pass'
Assert-True (Test-Path -LiteralPath (Join-Path $InstalledRoot 'MANIFEST.json')) 'expanded package installer should preserve MANIFEST.json'
Set-Content -LiteralPath $InstalledEnvFile -Encoding UTF8 -Value @(
  'LOOPLET_RECEIPT_WEBHOOK_URL=http://127.0.0.1:55321/functions/v1/receipt-webhook',
  'LOOPLET_POS_API_KEY=llp_trial.secret',
  'LOOPLET_RECEIPT_IDENTITY_TOKEN=rhp_trial.receiptsecret',
  'LOOPLET_SYNC_TARGETS=xero,myob',
  "LOOPLET_BRIDGE_QUEUE_FILE=$InstalledRoot\.looplet-pos-queue.jsonl",
  "LOOPLET_BRIDGE_DEAD_LETTER_FILE=$InstalledRoot\.looplet-pos-dead.jsonl",
  "LOOPLET_BRIDGE_INBOX_DIR=$InstalledInboxDir",
  "LOOPLET_BRIDGE_LOG_DIR=$InstalledLogDir",
  'LOOPLET_BRIDGE_STALE_AFTER_MINUTES=10',
  "LOOPLET_READINESS_SAMPLE=$InstalledRoot\sample-receipt.json",
  'LOOPLET_READINESS_SKIP_NETWORK=1'
)
$installedReadinessJson = & node (Join-Path $InstalledRoot 'readiness.mjs') --env-file $InstalledEnvFile --skip-network
$installedReadiness = $installedReadinessJson | ConvertFrom-Json
Assert-True ($installedReadiness.ok -eq $true) 'installed package readiness should pass'
Assert-True ($installedReadiness.checks.bridge_files.manifest.present -eq $true) 'installed package readiness should detect MANIFEST.json'
Assert-True ($installedReadiness.checks.bridge_files.manifest.ok -eq $true) 'installed package readiness should verify manifest hashes'
Assert-True ($installedReadiness.checks.bridge_files.manifest.checked_files -eq $manifest.files.Count) 'installed package readiness should verify every manifest file'
Add-Content -LiteralPath (Join-Path $InstalledRoot 'README.md') -Value 'tampered after install'
$tamperedInstallReadinessJson = & node (Join-Path $InstalledRoot 'readiness.mjs') --env-file $InstalledEnvFile --skip-network
$tamperedInstallReadiness = $tamperedInstallReadinessJson | ConvertFrom-Json
Assert-True ($LASTEXITCODE -ne 0) 'tampered installed readiness should exit non-zero'
Assert-True ($tamperedInstallReadiness.ok -eq $false) 'tampered installed readiness should fail'
Assert-True ($tamperedInstallReadiness.checks.bridge_files.manifest.ok -eq $false) 'tampered installed readiness should fail manifest verification'
Assert-True (($tamperedInstallReadiness.checks.bridge_files.manifest.errors -join ' ') -match 'manifest hash mismatch') 'tampered installed readiness should explain manifest hash mismatch'

$pilotPassPath = Join-Path $Root 'pilot-pass.html'
$pilotPassJson = & node (Join-Path $ExpandedRoot 'pilot-pass.mjs') `
  --identity-token 'rhp_trial.receiptsecret' `
  --output $pilotPassPath `
  --business-name 'Expanded Package Trial' `
  --pilot-id 'package-trial'
$pilotPass = $pilotPassJson | ConvertFrom-Json
Assert-True ($pilotPass.ok -eq $true) 'expanded package pilot-pass should pass'
Assert-True (-not ($pilotPassJson -match 'rhp_trial\.receiptsecret')) 'pilot-pass stdout should redact receipt token'
$pilotPassHtml = Get-Content -LiteralPath $pilotPassPath -Raw
Assert-True ($pilotPassHtml -match 'POS scannable receipt identity barcode') 'pilot-pass output must include barcode'
Assert-True ($pilotPassHtml -match 'rhp_trial\.receiptsecret') 'pilot-pass output must contain scannable token'
Assert-True ($pilotPassHtml -match 'class="bar"') 'pilot-pass barcode bars must be styled separately from the background'
Assert-True ($pilotPassHtml -match '\.barcode \.bar') 'pilot-pass CSS must not color every SVG rect'

$fingerprintJson = & node (Join-Path $ExpandedRoot 'sample-fingerprint.mjs') (Join-Path $ExpandedRoot 'sample-receipt.json')
$fingerprint = $fingerprintJson | ConvertFrom-Json
Assert-True ($fingerprint.ok -eq $true) 'expanded package sample-fingerprint should pass'
Assert-True (-not ($fingerprintJson -match 'rhp_customer\.receiptsecret')) 'sample-fingerprint stdout should redact receipt token'
$fingerprintSample = @($fingerprint.samples)[0]
Assert-True ($fingerprintSample.redacted_sample_sha256 -match '^[0-9a-f]{64}$') 'sample-fingerprint should emit a SHA-256 fingerprint'
$fingerprintMatchJson = & node (Join-Path $ExpandedRoot 'sample-fingerprint.mjs') `
  (Join-Path $ExpandedRoot 'sample-receipt.json') `
  --expected $fingerprintSample.redacted_sample_sha256
$fingerprintMatch = $fingerprintMatchJson | ConvertFrom-Json
Assert-True ($fingerprintMatch.ok -eq $true) 'expanded package sample-fingerprint should match expected fingerprint'

& node --check (Join-Path $ExpandedRoot 'reconcile-pilot-evidence.mjs') | Out-Null
Assert-True ($LASTEXITCODE -eq 0) 'expanded package reconcile-pilot-evidence should parse'

& node --check (Join-Path $ExpandedRoot 'field-sample-reconciliation.mjs') | Out-Null
Assert-True ($LASTEXITCODE -eq 0) 'expanded package field-sample-reconciliation should parse'

& node --check (Join-Path $ExpandedRoot 'field-sample-capture.mjs') | Out-Null
Assert-True ($LASTEXITCODE -eq 0) 'expanded package field-sample-capture should parse'

& node --check (Join-Path $ExpandedRoot 'go-live.mjs') | Out-Null
Assert-True ($LASTEXITCODE -eq 0) 'expanded package go-live runner should parse'

& node --check (Join-Path $ExpandedRoot 'pilot-report.mjs') | Out-Null
Assert-True ($LASTEXITCODE -eq 0) 'expanded package pilot-report should parse'

& node --check (Join-Path $ExpandedRoot 'pilot-bundle.mjs') | Out-Null
Assert-True ($LASTEXITCODE -eq 0) 'expanded package pilot-bundle should parse'

& node --check (Join-Path $ExpandedRoot 'completion-audit.mjs') | Out-Null
Assert-True ($LASTEXITCODE -eq 0) 'expanded package completion-audit should parse'
$completionAuditSmokeJson = & node (Join-Path $ExpandedRoot 'completion-audit.mjs') --skip-local
Assert-True ($LASTEXITCODE -eq 1) 'expanded package completion-audit runtime smoke should fail expected local proof gate'
$completionAuditSmoke = $completionAuditSmokeJson | ConvertFrom-Json
Assert-True ($completionAuditSmoke.ok -eq $false) 'expanded package completion-audit runtime smoke should emit failure JSON'
Assert-True (($completionAuditSmoke.failures -join ' ') -match 'local full POS trial must pass') 'expanded package completion-audit runtime smoke should prove local gate ran'

& node --check (Join-Path $ExpandedRoot 'integration-fit.mjs') | Out-Null
Assert-True ($LASTEXITCODE -eq 0) 'expanded package integration fit should parse'

& node --check (Join-Path $ExpandedRoot 'pilot-kit.mjs') | Out-Null
Assert-True ($LASTEXITCODE -eq 0) 'expanded package pilot-kit should parse'

& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ExpandedRoot 'run-watch-once.ps1') `
  -NodePath node `
  -BridgePath (Join-Path $ExpandedRoot 'bridge.mjs') `
  -EnvFile $EnvFile `
  -InboxDir $InboxDir `
  -LogDir $LogDir | Out-Null
Assert-True ($LASTEXITCODE -eq 0) 'expanded package logging runner should execute watch-once'

$statusJson = & node (Join-Path $ExpandedRoot 'status.mjs') --env-file $EnvFile
$status = $statusJson | ConvertFrom-Json
Assert-True ($status.ok -eq $true) 'expanded package clean status should pass'
Assert-True ($status.scheduler.ok -eq $true) 'expanded package status should prove scheduled task log is fresh'

$pilotEvidenceFile = Join-Path $Root 'pilot-evidence.json'
$pilotJson = & node (Join-Path $ExpandedRoot 'pilot-evidence.mjs') --env-file $EnvFile --output $pilotEvidenceFile --skip-network
$pilot = $pilotJson | ConvertFrom-Json
Assert-True ($pilot.ok -eq $true) 'expanded package pilot evidence should pass'
Assert-True ($pilot.acceptance.skipped -eq $true) 'expanded package pilot evidence should not send receipts by default'
Assert-True (Test-Path -LiteralPath $pilotEvidenceFile) 'expanded package pilot evidence should write output'

$verifyJson = & node (Join-Path $ExpandedRoot 'verify-pilot-evidence.mjs') $pilotEvidenceFile --evidence-only
$verify = $verifyJson | ConvertFrom-Json
Assert-True ($verify.ok -eq $false) 'expanded package verifier should reject preflight-only evidence'
Assert-True (($verify.failures -join ' ') -match 'acceptance') 'expanded package verifier should explain missing acceptance'

[ordered]@{
  ok = $true
  package_zip = $package.zip_path
  zip_bytes = $package.zip_bytes
  expanded_files_checked = $required.Count
  manifest_hashes_verified = $manifest.files.Count
  readiness_ok = $readiness.ok
  readiness_bridge_files_ok = $readiness.checks.bridge_files.ok
  readiness_manifest_ok = $readiness.checks.bridge_files.manifest.ok
  retry_drill_ok = $retryDrill.ok
  tampered_package_rejected = ($tamperedReadiness.ok -eq $false)
  installed_manifest_ok = $installedReadiness.checks.bridge_files.manifest.ok
  tampered_install_rejected = ($tamperedInstallReadiness.ok -eq $false)
  status_ok = $status.ok
  scheduler_status_ok = $status.scheduler.ok
  pilot_evidence_ok = $pilot.ok
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
  verify_pilot_evidence_rejected_preflight = ($verify.ok -eq $false)
  configure_env_ok = $configured.ok
  configure_env_secret_file_protected = $configured.secret_file_protected
  configure_env_acl_protected = $envAcl.AreAccessRulesProtected
  configure_env_acl_excludes_everyone = -not ($envAccessSids -contains 'S-1-1-0')
  configure_env_acl_excludes_authenticated_users = -not ($envAccessSids -contains 'S-1-5-11')
  configure_env_acl_excludes_builtin_users = -not ($envAccessSids -contains 'S-1-5-32-545')
  local_only_trials_excluded = $true
} | ConvertTo-Json -Depth 4
