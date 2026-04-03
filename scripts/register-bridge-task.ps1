$ErrorActionPreference = "Stop"

$TaskName = "Codex Stream Deck Monitor Bridge"
$FallbackTaskName = "Codex Stream Deck Monitor Bridge (Logon)"
$PowerShellExe = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$ScriptPath = Join-Path $PSScriptRoot "run-bridge.ps1"
$CurrentUser = whoami

. (Join-Path $PSScriptRoot "bridge-runtime.ps1")

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function New-BridgeTaskAction {
    return New-ScheduledTaskAction `
      -Execute $PowerShellExe `
      -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ScriptPath`""
}

function New-BridgeTaskSettings {
    return New-ScheduledTaskSettingsSet `
      -AllowStartIfOnBatteries `
      -DontStopIfGoingOnBatteries `
      -RestartCount 3 `
      -RestartInterval (New-TimeSpan -Minutes 1) `
      -ExecutionTimeLimit (New-TimeSpan -Days 3650)
}

function Remove-TaskIfPresent {
    param(
        [string]$Name
    )

    if (Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $Name -Confirm:$false
    }
}

Save-BridgeRuntimeConfig | Out-Null

try {
    $action = New-BridgeTaskAction
    $settings = New-BridgeTaskSettings
    $isAdmin = Test-IsAdministrator

    if ($isAdmin) {
        Remove-TaskIfPresent -Name $FallbackTaskName

        $trigger = New-ScheduledTaskTrigger -AtStartup
        Register-ScheduledTask `
          -TaskName $TaskName `
          -Action $action `
          -Trigger $trigger `
          -Settings $settings `
          -Description "Starts the Codex Stream Deck Monitor Bridge at Windows startup before user sign-in." `
          -User "SYSTEM" `
          -RunLevel Highest `
          -Force | Out-Null

        & (Join-Path $PSScriptRoot "uninstall-startup-launcher.ps1")
        Write-Host "Registriert fuer Systemstart: $TaskName"
    }
    else {
        Remove-TaskIfPresent -Name $TaskName

        $trigger = New-ScheduledTaskTrigger -AtLogOn
        Register-ScheduledTask `
          -TaskName $FallbackTaskName `
          -Action $action `
          -Trigger $trigger `
          -Settings $settings `
          -Description "Starts the Codex Stream Deck Monitor Bridge at user logon without a visible console window." `
          -User $CurrentUser `
          -RunLevel Limited `
          -Force | Out-Null

        & (Join-Path $PSScriptRoot "install-startup-launcher.ps1")
        Write-Warning "Systemstart ohne Anmeldung braucht Admin-Rechte. Es wurde ein Login-Fallback eingerichtet."
        Write-Host "Registriert fuer Benutzer-Login: $FallbackTaskName"
    }
}
catch {
    Write-Warning ("Scheduled Task konnte nicht registriert werden: {0}. Fallback auf Startup-Launcher." -f $_.Exception.Message)
    & (Join-Path $PSScriptRoot "install-startup-launcher.ps1")
}
