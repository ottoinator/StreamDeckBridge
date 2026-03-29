$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$NodeExe = "C:\Program Files\nodejs\node.exe"
$BridgeScript = Join-Path $Root "bridge\monitor-bridge.mjs"
$LogDir = Join-Path $Root "logs"
$OutLog = Join-Path $LogDir "bridge.out.log"
$ErrLog = Join-Path $LogDir "bridge.err.log"

$existing = Get-CimInstance Win32_Process | Where-Object {
    $_.Name -match 'node(.exe)?' -and $_.CommandLine -match 'monitor-bridge\.mjs'
}
if ($existing) {
    Write-Host "Codex Monitor Bridge laeuft bereits."
    exit 0
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

Start-Process `
  -FilePath $NodeExe `
  -ArgumentList @("`"$BridgeScript`"", "serve") `
  -WorkingDirectory $Root `
  -WindowStyle Hidden `
  -RedirectStandardOutput $OutLog `
  -RedirectStandardError $ErrLog

Write-Host "Codex Monitor Bridge im Hintergrund gestartet."
