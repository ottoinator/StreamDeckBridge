$ErrorActionPreference = "Stop"

$TaskName = "Codex Stream Deck Monitor Bridge"

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Entfernt: $TaskName"
} else {
    Write-Host "Task nicht vorhanden: $TaskName"
}

& (Join-Path $PSScriptRoot "uninstall-startup-launcher.ps1")
