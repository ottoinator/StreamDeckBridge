$ErrorActionPreference = "Stop"

$source = Join-Path $PSScriptRoot "..\streamdeck-plugin\com.codex.stream-monitor.sdPlugin"
$source = (Resolve-Path $source).Path
$targetRoot = Join-Path $env:APPDATA "Elgato\StreamDeck\Plugins"
$target = Join-Path $targetRoot "com.codex.stream-monitor.sdPlugin"

New-Item -ItemType Directory -Force -Path $targetRoot | Out-Null
if (Test-Path $target) {
    Remove-Item -LiteralPath $target -Recurse -Force
}

Copy-Item -LiteralPath $source -Destination $target -Recurse -Force
Write-Output "Installed plugin to $target"
