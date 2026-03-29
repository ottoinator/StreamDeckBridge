$ErrorActionPreference = "Stop"

$TaskName = "Codex Stream Deck Monitor Bridge"
$PowerShellExe = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$ScriptPath = Join-Path $PSScriptRoot "start-bridge-background.ps1"

$Action = New-ScheduledTaskAction `
  -Execute $PowerShellExe `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ScriptPath`""

$Trigger = New-ScheduledTaskTrigger -AtLogOn
$Settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Days 3650)

try {
    Register-ScheduledTask `
      -TaskName $TaskName `
      -Action $Action `
      -Trigger $Trigger `
      -Settings $Settings `
      -Description "Starts the Codex Stream Deck Monitor Bridge at user logon without a visible console window." `
      -User $env:USERNAME `
      -RunLevel Limited `
      -Force | Out-Null

    Write-Host "Registriert: $TaskName"
}
catch {
    Write-Warning "Scheduled Task konnte nicht registriert werden. Fallback auf Startup-Launcher."
    & (Join-Path $PSScriptRoot "install-startup-launcher.ps1")
}
