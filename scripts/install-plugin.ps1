$ErrorActionPreference = "Stop"

$source = Join-Path $PSScriptRoot "..\streamdeck-plugin\com.codex.stream-monitor.sdPlugin"
$source = (Resolve-Path $source).Path
$targetRoot = Join-Path $env:APPDATA "Elgato\StreamDeck\Plugins"
$target = Join-Path $targetRoot "com.codex.stream-monitor.sdPlugin"
$streamDeckExe = "C:\Program Files\Elgato\StreamDeck\StreamDeck.exe"
$wasRunning = $false

$running = Get-Process -Name StreamDeck -ErrorAction SilentlyContinue
if ($running) {
    $wasRunning = $true
    $running | Stop-Process -Force
    Start-Sleep -Seconds 2
}

New-Item -ItemType Directory -Force -Path $targetRoot | Out-Null
if (Test-Path $target) {
    Remove-Item -LiteralPath $target -Recurse -Force
}

Copy-Item -LiteralPath $source -Destination $target -Recurse -Force

if ($wasRunning -and (Test-Path $streamDeckExe)) {
    Start-Process -FilePath $streamDeckExe
}

Write-Output "Installed plugin to $target"
