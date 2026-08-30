$ErrorActionPreference = "Stop"

$StartupDir = [Environment]::GetFolderPath("Startup")
$LauncherPath = Join-Path $StartupDir "CodexStreamDeckMonitorBridge.vbs"
$RunKeyPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$RunValueName = "CodexStreamDeckMonitorBridge"

if (Test-Path $LauncherPath) {
    Remove-Item -LiteralPath $LauncherPath -Force
    Write-Host "Autostart-Launcher entfernt: $LauncherPath"
} else {
    Write-Host "Autostart-Launcher nicht vorhanden: $LauncherPath"
}

if (Get-ItemProperty -Path $RunKeyPath -Name $RunValueName -ErrorAction SilentlyContinue) {
    Remove-ItemProperty -Path $RunKeyPath -Name $RunValueName
    Write-Host "Autostart-Run-Eintrag entfernt: $RunValueName"
} else {
    Write-Host "Autostart-Run-Eintrag nicht vorhanden: $RunValueName"
}
