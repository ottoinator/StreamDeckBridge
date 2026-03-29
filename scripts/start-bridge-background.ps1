$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$NodeExe = "C:\Program Files\nodejs\node.exe"
$BridgeScript = Join-Path $Root "bridge\monitor-bridge.mjs"
$LogDir = Join-Path $Root "logs"
$OutLog = Join-Path $LogDir "bridge.out.log"
$ErrLog = Join-Path $LogDir "bridge.err.log"

try {
    $health = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:4567/health" -TimeoutSec 2
    if ($health.StatusCode -eq 200) {
        Write-Host "Codex Monitor Bridge laeuft bereits."
        exit 0
    }
} catch {
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
