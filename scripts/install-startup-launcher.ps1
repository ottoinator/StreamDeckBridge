$ErrorActionPreference = "Stop"

$StartupDir = [Environment]::GetFolderPath("Startup")
$LauncherPath = Join-Path $StartupDir "CodexStreamDeckMonitorBridge.vbs"
$BridgeScript = (Resolve-Path (Join-Path $PSScriptRoot "start-bridge-background.ps1")).Path
$PowerShellExe = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$RunKeyPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$RunValueName = "CodexStreamDeckMonitorBridge"

$vbs = @"
Set shell = CreateObject("WScript.Shell")
shell.Run ""$PowerShellExe"" & " -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """"$BridgeScript"""""", 0, False
"@

Set-Content -LiteralPath $LauncherPath -Value $vbs -Encoding ASCII
Write-Host "Autostart-Launcher installiert: $LauncherPath"

$runCommand = "`"$PowerShellExe`" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$BridgeScript`""
New-Item -Path $RunKeyPath -Force | Out-Null
Set-ItemProperty -Path $RunKeyPath -Name $RunValueName -Value $runCommand -Type String
Write-Host "Autostart-Run-Eintrag gesetzt: $RunValueName"
