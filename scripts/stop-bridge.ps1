$ErrorActionPreference = "Stop"

$processes = Get-CimInstance Win32_Process | Where-Object {
    $_.Name -match 'powershell(.exe)?|pwsh(.exe)?|node(.exe)?' -and
    $_.CommandLine -match 'monitor-bridge\.mjs|run-bridge-loop\.ps1'
}

if (-not $processes) {
    Write-Host "Keine laufende Codex Monitor Bridge gefunden."
    exit 0
}

$processes | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force
}

Write-Host "Codex Monitor Bridge gestoppt."
