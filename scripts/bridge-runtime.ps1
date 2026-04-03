$ErrorActionPreference = "Stop"

function Get-BridgeRuntimeRoot {
    return (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}

function Get-BridgeRuntimeConfigPath {
    param(
        [string]$Root = (Get-BridgeRuntimeRoot)
    )

    return Join-Path $Root "bridge.runtime.json"
}

function Get-BridgeDefaultDataDir {
    $programData = $env:ProgramData
    if (-not $programData) {
        $programData = Join-Path $env:SystemDrive "ProgramData"
    }

    return Join-Path $programData "CodexStreamDeckMonitor"
}

function Get-BridgeRuntimeEnvironment {
    $values = [ordered]@{}

    foreach ($scope in @("Machine", "User", "Process")) {
        $scopeValues = [Environment]::GetEnvironmentVariables($scope)
        foreach ($key in $scopeValues.Keys) {
            if ($key -like "CODEX_MONITOR_*") {
                $values[$key] = [string]$scopeValues[$key]
            }
        }
    }

    if (-not $values.Contains("CODEX_MONITOR_HOST") -or [string]::IsNullOrWhiteSpace($values["CODEX_MONITOR_HOST"])) {
        $values["CODEX_MONITOR_HOST"] = "127.0.0.1"
    }

    if (-not $values.Contains("CODEX_MONITOR_PORT") -or [string]::IsNullOrWhiteSpace($values["CODEX_MONITOR_PORT"])) {
        $values["CODEX_MONITOR_PORT"] = "4567"
    }

    if (-not $values.Contains("CODEX_MONITOR_DATA_DIR") -or [string]::IsNullOrWhiteSpace($values["CODEX_MONITOR_DATA_DIR"])) {
        $values["CODEX_MONITOR_DATA_DIR"] = Get-BridgeDefaultDataDir
    }

    return $values
}

function Save-BridgeRuntimeConfig {
    param(
        [string]$Path = (Get-BridgeRuntimeConfigPath)
    )

    $config = Get-BridgeRuntimeEnvironment
    $directory = Split-Path -Parent $Path
    if ($directory) {
        New-Item -ItemType Directory -Force -Path $directory | Out-Null
    }

    $config | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $Path -Encoding ASCII
    return $config
}

function Import-BridgeRuntimeConfig {
    param(
        [string]$Path = (Get-BridgeRuntimeConfigPath)
    )

    if (Test-Path -LiteralPath $Path) {
        $raw = Get-Content -LiteralPath $Path -Raw
        if (-not [string]::IsNullOrWhiteSpace($raw)) {
            $config = ConvertFrom-Json -InputObject $raw
            foreach ($entry in $config.PSObject.Properties) {
                [Environment]::SetEnvironmentVariable($entry.Name, [string]$entry.Value, "Process")
            }
        }
    }

    if (-not $env:CODEX_MONITOR_HOST) {
        $env:CODEX_MONITOR_HOST = "127.0.0.1"
    }
    if (-not $env:CODEX_MONITOR_PORT) {
        $env:CODEX_MONITOR_PORT = "4567"
    }
    if (-not $env:CODEX_MONITOR_DATA_DIR) {
        $env:CODEX_MONITOR_DATA_DIR = Get-BridgeDefaultDataDir
    }

    New-Item -ItemType Directory -Force -Path $env:CODEX_MONITOR_DATA_DIR | Out-Null
}
