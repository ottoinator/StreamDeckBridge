$ErrorActionPreference = "Stop"

$StartupDir = [Environment]::GetFolderPath("Startup")
$LauncherPath = Join-Path $StartupDir "CodexStreamDeckMonitorBridge.vbs"

if (Test-Path $LauncherPath) {
    Remove-Item -LiteralPath $LauncherPath -Force
    Write-Host "Autostart-Launcher entfernt: $LauncherPath"
} else {
    Write-Host "Autostart-Launcher nicht vorhanden: $LauncherPath"
}
