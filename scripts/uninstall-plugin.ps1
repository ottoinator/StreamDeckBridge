$ErrorActionPreference = "Stop"

$target = Join-Path $env:APPDATA "Elgato\StreamDeck\Plugins\com.codex.stream-monitor.sdPlugin"
if (Test-Path $target) {
    Remove-Item -LiteralPath $target -Recurse -Force
    Write-Output "Removed $target"
} else {
    Write-Output "Plugin not installed: $target"
}
