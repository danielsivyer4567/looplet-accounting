[CmdletBinding()]
param(
  [string]$InstallRoot = 'C:\ProgramData\Looplet\pos-bridge',
  [string]$EnvFile = 'C:\ProgramData\Looplet\pos-bridge.env',
  [string]$InboxDir = 'C:\ProgramData\Looplet\receipts-inbox',
  [string]$TaskName = 'Looplet POS Receipt Bridge',
  [ValidateRange(1, 60)]
  [int]$ScheduleMinutes = 1,
  [string]$NodePath = 'node',
  [switch]$Apply,
  [switch]$NoRegister
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$SourceDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RequiredFiles = @(
  'README.md',
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
  'field-sample-reconciliation.mjs',
  'reconcile-pilot-evidence.mjs',
  'pilot-evidence.mjs',
  'verify-pilot-evidence.mjs',
  'go-live.mjs',
  'pilot-report.mjs',
  'pilot-bundle.mjs',
  'completion-audit.mjs',
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
$OptionalFiles = @(
  'MANIFEST.json'
)

function Resolve-NodePath {
  param([string]$Candidate)

  $command = Get-Command $Candidate -ErrorAction SilentlyContinue
  if ($null -ne $command) {
    return $command.Source
  }
  return $Candidate
}

function Assert-Node20 {
  param([string]$ResolvedNodePath)

  $version = (& $ResolvedNodePath --version 2>$null)
  if ($LASTEXITCODE -ne 0 -or -not $version) {
    throw "Node.js was not found at '$ResolvedNodePath'. Install Node.js 20+ before installing the bridge."
  }

  $major = [int]($version.Trim().TrimStart('v').Split('.')[0])
  if ($major -lt 20) {
    throw "Node.js 20+ is required. Found $version at '$ResolvedNodePath'."
  }
  return $version.Trim()
}

function Protect-LoopletSecretFile {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    throw "Secret file does not exist and cannot be protected: $Path"
  }

  $resolvedPath = (Resolve-Path -LiteralPath $Path).Path
  $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $administrators = ([System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')).Translate([System.Security.Principal.NTAccount]).Value
  $system = ([System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')).Translate([System.Security.Principal.NTAccount]).Value
  $principals = @($currentUser, $administrators, $system) | Select-Object -Unique

  $security = [System.Security.AccessControl.FileSecurity]::new()
  foreach ($principal in $principals) {
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
      $principal,
      [System.Security.AccessControl.FileSystemRights]::FullControl,
      [System.Security.AccessControl.InheritanceFlags]::None,
      [System.Security.AccessControl.PropagationFlags]::None,
      [System.Security.AccessControl.AccessControlType]::Allow
    )
    $security.AddAccessRule($rule)
  }
  $security.SetAccessRuleProtection($true, $false)
  [System.IO.File]::SetAccessControl($resolvedPath, $security)

  $applied = [System.IO.File]::GetAccessControl($resolvedPath)
  [ordered]@{
    ok = [bool]$applied.AreAccessRulesProtected
    protected = [bool]$applied.AreAccessRulesProtected
    path = $resolvedPath
    allowed_principals = @($principals)
  }
}

function ConvertTo-EnvTemplate {
  param(
    [string[]]$Lines,
    [string]$TargetInboxDir
  )

  $result = foreach ($line in $Lines) {
    if ($line -like 'LOOPLET_BRIDGE_INBOX_DIR=*') {
      "LOOPLET_BRIDGE_INBOX_DIR=$TargetInboxDir"
    } elseif ($line -like 'LOOPLET_BRIDGE_QUEUE_FILE=*') {
      "LOOPLET_BRIDGE_QUEUE_FILE=$InstallRoot\.looplet-pos-queue.jsonl"
    } elseif ($line -like 'LOOPLET_BRIDGE_DEAD_LETTER_FILE=*') {
      "LOOPLET_BRIDGE_DEAD_LETTER_FILE=$InstallRoot\.looplet-pos-dead.jsonl"
    } elseif ($line -like 'LOOPLET_BRIDGE_LOG_DIR=*') {
      "LOOPLET_BRIDGE_LOG_DIR=$InstallRoot\logs"
    } elseif ($line -like 'LOOPLET_READINESS_SAMPLE=*') {
      "LOOPLET_READINESS_SAMPLE=$InstallRoot\sample-receipt.json"
    } else {
      $line
    }
  }
  return $result
}

foreach ($file in $RequiredFiles) {
  $path = Join-Path $SourceDir $file
  if (-not (Test-Path -LiteralPath $path)) {
    throw "Required bridge file is missing: $path"
  }
}

$ResolvedNodePath = Resolve-NodePath $NodePath
$BridgePath = Join-Path $InstallRoot 'bridge.mjs'
$RunnerPath = Join-Path $InstallRoot 'run-watch-once.ps1'
$LogDir = Join-Path $InstallRoot 'logs'
$TaskArguments = "-NoProfile -ExecutionPolicy Bypass -File `"$RunnerPath`" -NodePath `"$ResolvedNodePath`" -BridgePath `"$BridgePath`" -EnvFile `"$EnvFile`" -InboxDir `"$InboxDir`" -LogDir `"$LogDir`""
$Plan = [ordered]@{
  ok = $true
  apply = [bool]$Apply
  install_root = $InstallRoot
  env_file = $EnvFile
  inbox_dir = $InboxDir
  task_name = $TaskName
  schedule_minutes = $ScheduleMinutes
  node_path = $ResolvedNodePath
  log_dir = $LogDir
  task_command = "powershell.exe $TaskArguments"
  will_register_task = [bool]($Apply -and -not $NoRegister)
  will_harden_env_acl = [bool]$Apply
}

if (-not $Apply) {
  $Plan | ConvertTo-Json -Depth 4
  return
}

$nodeVersion = Assert-Node20 $ResolvedNodePath
New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
New-Item -ItemType Directory -Force -Path $InboxDir | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $EnvFile) | Out-Null

foreach ($file in $RequiredFiles) {
  Copy-Item -LiteralPath (Join-Path $SourceDir $file) -Destination (Join-Path $InstallRoot $file) -Force
}
foreach ($file in $OptionalFiles) {
  $path = Join-Path $SourceDir $file
  if (Test-Path -LiteralPath $path) {
    Copy-Item -LiteralPath $path -Destination (Join-Path $InstallRoot $file) -Force
  }
}

if (-not (Test-Path -LiteralPath $EnvFile)) {
  $template = ConvertTo-EnvTemplate -Lines (Get-Content -LiteralPath (Join-Path $SourceDir '.env.example')) -TargetInboxDir $InboxDir
  Set-Content -LiteralPath $EnvFile -Value $template -Encoding UTF8
}
$envAcl = Protect-LoopletSecretFile $EnvFile

if (-not $NoRegister) {
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $TaskArguments -WorkingDirectory $InstallRoot
  $trigger = New-ScheduledTaskTrigger `
    -Once `
    -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes $ScheduleMinutes) `
    -RepetitionDuration (New-TimeSpan -Days 3650)
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew
  Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description 'Looplet POS receipt bridge: scans completed POS export receipts and posts them to Looplet.' `
    -Force | Out-Null
}

[ordered]@{
  ok = $true
  installed = $true
  registered_task = [bool](-not $NoRegister)
  node_version = $nodeVersion
  install_root = $InstallRoot
  env_file = $EnvFile
  env_acl = $envAcl
  inbox_dir = $InboxDir
  log_dir = $LogDir
  task_name = $TaskName
  task_command = "powershell.exe $TaskArguments"
  next_steps = @(
    'Edit the env file with the real Looplet webhook URL, API key, and optional fallback/readiness receipt identity token.',
    "Review: `"$InstallRoot\PILOT_CHECKLIST.md`"",
    "Run: $ResolvedNodePath `"$InstallRoot\readiness.mjs`" --env-file `"$EnvFile`"",
    "Run the fit check: $ResolvedNodePath `"$InstallRoot\integration-fit.mjs`" `"C:\ProgramData\Looplet\pos-integration-profile.json`"",
    "Generate the pilot kit after the fit check passes: $ResolvedNodePath `"$InstallRoot\pilot-kit.mjs`" `"C:\ProgramData\Looplet\pos-integration-profile.json`" --output-dir `"C:\ProgramData\Looplet\pilot-kit`"",
    "Copy: `"C:\ProgramData\Looplet\pilot-kit\pos-pilot-site.template.json`" to `"C:\ProgramData\Looplet\pos-pilot-site.json`" and replace every placeholder with real business/POS pilot details.",
    "After exporting real POS sale/refund/void JSON files, run the one-command go-live evidence flow: $ResolvedNodePath `"$InstallRoot\go-live.mjs`" --env-file `"$EnvFile`" --site-file `"C:\ProgramData\Looplet\pos-pilot-site.json`" --fit-profile `"C:\ProgramData\Looplet\pos-integration-profile.json`" --sale `"C:\ProgramData\Looplet\field-sale.json`" --refund `"C:\ProgramData\Looplet\field-refund.json`" --void `"C:\ProgramData\Looplet\field-void.json`" --output `"C:\ProgramData\Looplet\pos-pilot-evidence.json`"",
    "Generate a redacted support report after go-live evidence passes: $ResolvedNodePath `"$InstallRoot\pilot-report.mjs`" `"C:\ProgramData\Looplet\pos-pilot-evidence.json`" --output `"C:\ProgramData\Looplet\pos-pilot-report.json`" --markdown `"C:\ProgramData\Looplet\pos-pilot-report.md`"",
    "Verify the final archive bundle before handover: $ResolvedNodePath `"$InstallRoot\pilot-bundle.mjs`" --evidence `"C:\ProgramData\Looplet\pos-pilot-evidence.json`" --site `"C:\ProgramData\Looplet\pos-pilot-site.json`" --fit `"C:\ProgramData\Looplet\pos-integration-profile.json`" --sale `"C:\ProgramData\Looplet\field-sale.json`" --refund `"C:\ProgramData\Looplet\field-refund.json`" --void `"C:\ProgramData\Looplet\field-void.json`" --report-json `"C:\ProgramData\Looplet\pos-pilot-report.json`" --report-markdown `"C:\ProgramData\Looplet\pos-pilot-report.md`" --output `"C:\ProgramData\Looplet\pos-pilot-bundle.json`"",
    "Final production-readiness gate: $ResolvedNodePath `"$InstallRoot\completion-audit.mjs`" --require-production --local-json `"C:\ProgramData\Looplet\pos-full-trial.json`" --evidence `"C:\ProgramData\Looplet\pos-pilot-evidence.json`" --site `"C:\ProgramData\Looplet\pos-pilot-site.json`" --fit `"C:\ProgramData\Looplet\pos-integration-profile.json`" --sale `"C:\ProgramData\Looplet\field-sale.json`" --refund `"C:\ProgramData\Looplet\field-refund.json`" --void `"C:\ProgramData\Looplet\field-void.json`" --report-json `"C:\ProgramData\Looplet\pos-pilot-report.json`" --report-markdown `"C:\ProgramData\Looplet\pos-pilot-report.md`" --output `"C:\ProgramData\Looplet\completion-audit.json`"",
    "Support/debug only: $ResolvedNodePath `"$InstallRoot\verify-pilot-evidence.mjs`" `"C:\ProgramData\Looplet\pos-pilot-evidence.json`" --sale `"C:\ProgramData\Looplet\field-sale.json`" --refund `"C:\ProgramData\Looplet\field-refund.json`" --void `"C:\ProgramData\Looplet\field-void.json`"",
    "To match a local field file to verifier evidence, run: $ResolvedNodePath `"$InstallRoot\sample-fingerprint.mjs`" `"C:\ProgramData\Looplet\field-sale.json`" --expected <sale-fingerprint-from-verifier-summary>",
    "Support/debug only: $ResolvedNodePath `"$InstallRoot\reconcile-pilot-evidence.mjs`" `"C:\ProgramData\Looplet\pos-pilot-evidence.json`" --sale `"C:\ProgramData\Looplet\field-sale.json`" --refund `"C:\ProgramData\Looplet\field-refund.json`" --void `"C:\ProgramData\Looplet\field-void.json`"",
    "Check scheduled task logs under: $LogDir",
    "Drop completed POS receipt JSON files into: $InboxDir"
  )
} | ConvertTo-Json -Depth 5
