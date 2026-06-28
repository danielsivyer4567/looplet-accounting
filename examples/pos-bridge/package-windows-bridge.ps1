[CmdletBinding()]
param(
  [string]$OutputDir = '.claude\scratch\pos-bridge-package',
  [string]$PackageName = 'looplet-pos-bridge'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$SourceDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PackageRoot = Join-Path $OutputDir $PackageName
$ZipPath = Join-Path $OutputDir "$PackageName.zip"
$Files = @(
  'README.md',
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
  'sample-pos-export-bad-lines.csv'
)

function Get-RelativeHash {
  param(
    [string]$BaseDir,
    [string]$RelativePath
  )

  $path = Join-Path $BaseDir $RelativePath
  [ordered]@{
    path = $RelativePath
    sha256 = Get-Sha256Hex $path
    bytes = (Get-Item -LiteralPath $path).Length
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

foreach ($file in $Files) {
  $path = Join-Path $SourceDir $file
  if (-not (Test-Path -LiteralPath $path)) {
    throw "Required package file is missing: $path"
  }
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
if (Test-Path -LiteralPath $PackageRoot) {
  Remove-Item -LiteralPath $PackageRoot -Recurse -Force
}
if (Test-Path -LiteralPath $ZipPath) {
  Remove-Item -LiteralPath $ZipPath -Force
}
New-Item -ItemType Directory -Force -Path $PackageRoot | Out-Null

foreach ($file in $Files) {
  Copy-Item -LiteralPath (Join-Path $SourceDir $file) -Destination (Join-Path $PackageRoot $file) -Force
}

$Manifest = [ordered]@{
  name = $PackageName
  package_created_at = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  runtime = 'Node.js 20+'
  install_command = 'powershell -NoProfile -ExecutionPolicy Bypass -File .\install-windows-task.ps1 -Apply'
  readiness_command = 'node readiness.mjs --env-file C:\ProgramData\Looplet\pos-bridge.env'
  status_command = 'node status.mjs --env-file C:\ProgramData\Looplet\pos-bridge.env'
  files = @($Files | ForEach-Object { Get-RelativeHash -BaseDir $PackageRoot -RelativePath $_ })
}
$ManifestPath = Join-Path $PackageRoot 'MANIFEST.json'
$ManifestJson = $Manifest | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText(
  [System.IO.Path]::GetFullPath($ManifestPath),
  $ManifestJson,
  [System.Text.UTF8Encoding]::new($false)
)

Compress-Archive -Path (Join-Path $PackageRoot '*') -DestinationPath $ZipPath -Force

[ordered]@{
  ok = $true
  package_root = (Resolve-Path $PackageRoot).Path
  zip_path = (Resolve-Path $ZipPath).Path
  file_count = $Files.Count + 1
  manifest = (Resolve-Path $ManifestPath).Path
  zip_bytes = (Get-Item -LiteralPath $ZipPath).Length
} | ConvertTo-Json -Depth 4
