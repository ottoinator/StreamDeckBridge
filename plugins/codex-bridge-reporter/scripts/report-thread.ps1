[CmdletBinding()]
param(
    [string]$Action = "",
    [string]$ThreadId = "",
    [string]$Label = "",
    [string]$Detail = "",
    [string]$BridgeUrl = "",
    [int]$Slot = 0,
    [int]$ExitCode = 1,
    [int]$IntervalSeconds = 20,
    [switch]$Watch
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\\..")
$targetScript = Join-Path $repoRoot "scripts\\codex-bridge-thread.ps1"

if (-not (Test-Path -LiteralPath $targetScript)) {
    throw "Bridge script nicht gefunden: $targetScript"
}

$forwardArgs = @()
if ($Action) { $forwardArgs += @("-Action", $Action) }
if ($ThreadId) { $forwardArgs += @("-ThreadId", $ThreadId) }
if ($Label) { $forwardArgs += @("-Label", $Label) }
if ($Detail) { $forwardArgs += @("-Detail", $Detail) }
if ($BridgeUrl) { $forwardArgs += @("-BridgeUrl", $BridgeUrl) }
if ($Slot -gt 0) { $forwardArgs += @("-Slot", $Slot) }
if ($ExitCode -ne 1) { $forwardArgs += @("-ExitCode", $ExitCode) }
if ($IntervalSeconds -ne 20) { $forwardArgs += @("-IntervalSeconds", $IntervalSeconds) }
if ($Watch) { $forwardArgs += "-Watch" }

$invokeArgs = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", $targetScript
) + $forwardArgs

& powershell.exe @invokeArgs
exit $LASTEXITCODE
