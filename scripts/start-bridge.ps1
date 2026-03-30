$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $projectRoot

$userHost = [Environment]::GetEnvironmentVariable("CODEX_MONITOR_HOST", "User")
$userPushOnly = [Environment]::GetEnvironmentVariable("CODEX_MONITOR_AGENT_PUSH_ONLY", "User")
$userPushToken = [Environment]::GetEnvironmentVariable("CODEX_MONITOR_AGENT_PUSH_TOKEN", "User")

if ($userHost) {
    $env:CODEX_MONITOR_HOST = $userHost
}
if ($userPushOnly) {
    $env:CODEX_MONITOR_AGENT_PUSH_ONLY = $userPushOnly
}
if ($userPushToken) {
    $env:CODEX_MONITOR_AGENT_PUSH_TOKEN = $userPushToken
}

node .\bridge\monitor-bridge.mjs serve
