$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "bridge-runtime.ps1")

$Root = Get-BridgeRuntimeRoot
$PowerShellExe = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$RunScript = Join-Path $PSScriptRoot "run-bridge.ps1"
$LogDir = Join-Path $Root "logs"
$OutLog = Join-Path $LogDir "bridge.out.log"
$ErrLog = Join-Path $LogDir "bridge.err.log"

Save-BridgeRuntimeConfig | Out-Null
Import-BridgeRuntimeConfig | Out-Null

try {
    $healthUrl = "http://{0}:{1}/health" -f $env:CODEX_MONITOR_HOST, $env:CODEX_MONITOR_PORT
    $health = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 2
    if ($health.StatusCode -eq 200) {
        Write-Host "Codex Monitor Bridge laeuft bereits."
        exit 0
    }
} catch {
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

Start-Process `
  -FilePath $PowerShellExe `
  -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", "`"$RunScript`"") `
  -WorkingDirectory $Root `
  -WindowStyle Hidden `
  -RedirectStandardOutput $OutLog `
  -RedirectStandardError $ErrLog

Write-Host "Codex Monitor Bridge im Hintergrund gestartet."
