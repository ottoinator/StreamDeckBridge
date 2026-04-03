$ErrorActionPreference = "Stop"

$TaskNames = @(
    "Codex Stream Deck Monitor Bridge",
    "Codex Stream Deck Monitor Bridge (Logon)"
)

foreach ($TaskName in $TaskNames) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Entfernt: $TaskName"
    } else {
        Write-Host "Task nicht vorhanden: $TaskName"
    }
}

& (Join-Path $PSScriptRoot "uninstall-startup-launcher.ps1")
