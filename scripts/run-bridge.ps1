$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "bridge-runtime.ps1")

$Root = Get-BridgeRuntimeRoot
$NodeExe = "C:\Program Files\nodejs\node.exe"
$BridgeScript = Join-Path $Root "bridge\monitor-bridge.mjs"

Import-BridgeRuntimeConfig | Out-Null

if (-not (Test-Path -LiteralPath $NodeExe)) {
    throw "Node.js nicht gefunden: $NodeExe"
}

if (-not (Test-Path -LiteralPath $BridgeScript)) {
    throw "Bridge-Script nicht gefunden: $BridgeScript"
}

Set-Location $Root
& $NodeExe $BridgeScript serve
exit $LASTEXITCODE
