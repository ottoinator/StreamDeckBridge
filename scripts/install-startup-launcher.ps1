$ErrorActionPreference = "Stop"

$StartupDir = [Environment]::GetFolderPath("Startup")
$LauncherPath = Join-Path $StartupDir "CodexStreamDeckMonitorBridge.vbs"
$BridgeScript = (Resolve-Path (Join-Path $PSScriptRoot "start-bridge-background.ps1")).Path
$PowerShellExe = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"

$vbs = @"
Set shell = CreateObject("WScript.Shell")
shell.Run ""$PowerShellExe"" & " -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """"$BridgeScript"""""", 0, False
"@

Set-Content -LiteralPath $LauncherPath -Value $vbs -Encoding ASCII
Write-Host "Autostart-Launcher installiert: $LauncherPath"
