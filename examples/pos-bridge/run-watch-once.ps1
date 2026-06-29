[CmdletBinding()]
param(
  [string]$NodePath = 'node',
  [string]$BridgePath = 'C:\ProgramData\Looplet\pos-bridge\bridge.mjs',
  [string]$EnvFile = 'C:\ProgramData\Looplet\pos-bridge.env',
  [string]$InboxDir = 'C:\ProgramData\Looplet\receipts-inbox',
  [string]$LogDir = 'C:\ProgramData\Looplet\pos-bridge\logs',
  [ValidateRange(1, 365)]
  [int]$RetainDays = 30
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Redact-LoopletSecrets {
  param([string]$Value)

  return ($Value -replace 'llp_[^\s"'',}]+', 'llp_[redacted]' -replace 'rhp_[^\s"'',}]+', 'rhp_[redacted]')
}

function Protect-LoopletLogFile {
  param([string]$Path)

  $resolvedParent = Resolve-Path -LiteralPath (Split-Path -Parent $Path)
  $resolvedPath = [System.IO.Path]::GetFullPath((Join-Path $resolvedParent.Path (Split-Path -Leaf $Path)))
  if (-not (Test-Path -LiteralPath $resolvedPath)) {
    $stream = [System.IO.File]::Open(
      $resolvedPath,
      [System.IO.FileMode]::OpenOrCreate,
      [System.IO.FileAccess]::Write,
      [System.IO.FileShare]::Read
    )
    $stream.Dispose()
  }

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
}

function Write-BridgeLog {
  param(
    [string]$Path,
    [string]$Message
  )

  Protect-LoopletLogFile -Path $Path
  $line = "$(Get-Date -Format o) $(Redact-LoopletSecrets $Message)"
  Add-Content -LiteralPath $Path -Value $line -Encoding UTF8
  Protect-LoopletLogFile -Path $Path
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$logPath = Join-Path $LogDir ("bridge-{0}.log" -f (Get-Date -Format 'yyyy-MM-dd'))

try {
  $cutoff = (Get-Date).AddDays(-$RetainDays)
  Get-ChildItem -LiteralPath $LogDir -Filter 'bridge-*.log' -File -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt $cutoff } |
    Remove-Item -Force
} catch {
  Write-BridgeLog -Path $logPath -Message "log_retention_warning $($_.Exception.Message)"
}

$exitCode = 1
Write-BridgeLog -Path $logPath -Message "watch_once_start bridge=$BridgePath inbox=$InboxDir"
try {
  $output = & $NodePath $BridgePath --env-file $EnvFile --watch-once $InboxDir 2>&1
  $exitCode = if ($null -eq $LASTEXITCODE) { 0 } else { [int]$LASTEXITCODE }
  foreach ($line in @($output)) {
    if ($null -ne $line -and [string]$line -ne '') {
      Write-BridgeLog -Path $logPath -Message ([string]$line)
    }
  }
} catch {
  Write-BridgeLog -Path $logPath -Message "watch_once_error $($_.Exception.Message)"
  $exitCode = 1
}

Write-BridgeLog -Path $logPath -Message "watch_once_end exit_code=$exitCode"
exit $exitCode
