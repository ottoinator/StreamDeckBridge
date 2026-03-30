$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$NodeExe = "C:\Program Files\nodejs\node.exe"
$BridgeScript = Join-Path $Root "bridge\monitor-bridge.mjs"
$LogDir = Join-Path $Root "logs"
$OutLog = Join-Path $LogDir "bridge.out.log"
$ErrLog = Join-Path $LogDir "bridge.err.log"
$UserHost = [Environment]::GetEnvironmentVariable("CODEX_MONITOR_HOST", "User")
$UserPushOnly = [Environment]::GetEnvironmentVariable("CODEX_MONITOR_AGENT_PUSH_ONLY", "User")
$UserPushToken = [Environment]::GetEnvironmentVariable("CODEX_MONITOR_AGENT_PUSH_TOKEN", "User")

try {
    $health = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:4567/health" -TimeoutSec 2
    if ($health.StatusCode -eq 200) {
        Write-Host "Codex Monitor Bridge laeuft bereits."
        exit 0
    }
} catch {
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

if ($UserHost) {
    $env:CODEX_MONITOR_HOST = $UserHost
}
if ($UserPushOnly) {
    $env:CODEX_MONITOR_AGENT_PUSH_ONLY = $UserPushOnly
}
if ($UserPushToken) {
    $env:CODEX_MONITOR_AGENT_PUSH_TOKEN = $UserPushToken
}

Start-Process `
  -FilePath $NodeExe `
  -ArgumentList @("`"$BridgeScript`"", "serve") `
  -WorkingDirectory $Root `
  -WindowStyle Hidden `
  -RedirectStandardOutput $OutLog `
  -RedirectStandardError $ErrLog

Write-Host "Codex Monitor Bridge im Hintergrund gestartet."
