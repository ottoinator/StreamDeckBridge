[CmdletBinding()]
param(
    [ValidateSet("register", "progress", "heartbeat", "needs_input", "done", "error", "clear", "watch-start", "watch-stop", "watch-loop")]
    [string]$Action = "heartbeat",
    [string]$ThreadId = $env:CODEX_THREAD_ID,
    [string]$Label = "",
    [string]$Detail = "",
    [string]$BridgeUrl = $(if ($env:CODEX_MONITOR_BASE_URL) { $env:CODEX_MONITOR_BASE_URL } else { "http://127.0.0.1:4567" }),
    [int]$Slot = 0,
    [int]$ExitCode = 1,
    [int]$IntervalSeconds = 20,
    [int]$IdleDoneSeconds = $(if ($env:CODEX_MONITOR_THREAD_IDLE_DONE_SECONDS) { [int]$env:CODEX_MONITOR_THREAD_IDLE_DONE_SECONDS } else { 0 }),
    [switch]$Watch
)

$ErrorActionPreference = "Stop"

function Get-NowIso {
    return [DateTime]::UtcNow.ToString("o")
}

function Get-DefaultLabel {
    $leaf = Split-Path -Leaf (Get-Location).Path
    if ([string]::IsNullOrWhiteSpace($leaf)) {
        return "Codex Chat"
    }
    return $leaf
}

function Get-NormalizedThreadId {
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) {
        throw "CODEX_THREAD_ID fehlt. Setze -ThreadId explizit oder starte das Script in einem Codex-Chat."
    }
    return $Value.Trim()
}

function Get-ThreadUri {
    param([string]$BaseUrl, [string]$CurrentThreadId)
    $trimmedBase = $BaseUrl.TrimEnd("/")
    $encodedThreadId = [Uri]::EscapeDataString($CurrentThreadId)
    return "$trimmedBase/threads/$encodedThreadId"
}

function Get-WatcherDirectory {
    $appData = if ($env:APPDATA) { $env:APPDATA } else { Join-Path $HOME "AppData\\Roaming" }
    return Join-Path $appData "CodexStreamDeckMonitor\\watchers"
}

function Get-WatcherStatePath {
    param([string]$CurrentThreadId)
    return Join-Path (Get-WatcherDirectory) "$CurrentThreadId.json"
}

function Get-CodexSessionsRoot {
    return Join-Path $HOME ".codex\\sessions"
}

function Invoke-WithRetry {
    param(
        [scriptblock]$ScriptBlock,
        [int]$MaxAttempts = 5,
        [int]$DelayMilliseconds = 75
    )
    $lastError = $null
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        try {
            return & $ScriptBlock
        } catch {
            $lastError = $_
            if ($attempt -ge $MaxAttempts) {
                throw
            }
            Start-Sleep -Milliseconds ($DelayMilliseconds * $attempt)
        }
    }
    if ($null -ne $lastError) {
        throw $lastError
    }
}

function Find-CodexSessionLog {
    param([string]$CurrentThreadId)
    $sessionsRoot = Get-CodexSessionsRoot
    if (-not (Test-Path -LiteralPath $sessionsRoot)) {
        return $null
    }
    try {
        return Get-ChildItem -Path $sessionsRoot -Recurse -File -Filter "*$CurrentThreadId.jsonl" -ErrorAction Stop |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 1 -ExpandProperty FullName
    } catch {
        return $null
    }
}

function Get-CodexTurnState {
    param([string]$SessionLogPath)
    if ([string]::IsNullOrWhiteSpace($SessionLogPath) -or -not (Test-Path -LiteralPath $SessionLogPath)) {
        return $null
    }
    try {
        $lines = Invoke-WithRetry -ScriptBlock { Get-Content -LiteralPath $SessionLogPath -Tail 250 }
    } catch {
        return $null
    }

    $lastUserMessageAt = $null
    $lastFinalAnswerAt = $null

    foreach ($line in $lines) {
        if ([string]::IsNullOrWhiteSpace($line)) {
            continue
        }
        try {
            $entry = $line | ConvertFrom-Json
        } catch {
            continue
        }
        try {
            $entryTimestamp =
                if ($entry.timestamp -is [DateTimeOffset]) {
                    [DateTimeOffset]$entry.timestamp
                } elseif ($entry.timestamp -is [DateTime]) {
                    [DateTimeOffset]::new([DateTime]$entry.timestamp)
                } else {
                    [DateTimeOffset]::Parse([string]$entry.timestamp)
                }
        } catch {
            continue
        }

        if ($entry.type -eq "event_msg" -and $entry.payload.type -eq "user_message") {
            if ($null -eq $lastUserMessageAt -or $entryTimestamp -gt $lastUserMessageAt) {
                $lastUserMessageAt = $entryTimestamp
            }
            continue
        }

        if (
            $entry.type -eq "response_item" -and
            $entry.payload.type -eq "message" -and
            $entry.payload.role -eq "assistant" -and
            $entry.payload.phase -eq "final_answer"
        ) {
            if ($null -eq $lastFinalAnswerAt -or $entryTimestamp -gt $lastFinalAnswerAt) {
                $lastFinalAnswerAt = $entryTimestamp
            }
        }
    }

    return [pscustomobject]@{
        lastUserMessageAt = $lastUserMessageAt
        lastFinalAnswerAt = $lastFinalAnswerAt
    }
}

function Read-WatcherState {
    param([string]$CurrentThreadId)
    $path = Get-WatcherStatePath -CurrentThreadId $CurrentThreadId
    if (-not (Test-Path -LiteralPath $path)) {
        return $null
    }
    try {
        return Invoke-WithRetry -ScriptBlock { Get-Content -Raw -LiteralPath $path | ConvertFrom-Json }
    } catch {
        return $null
    }
}

function Write-WatcherState {
    param(
        [string]$CurrentThreadId,
        [string]$CurrentLabel,
        [string]$CurrentDetail,
        [int]$CurrentSlot,
        [int]$CurrentIntervalSeconds,
        [int]$CurrentIdleDoneSeconds,
        [string]$LastActivityAt = "",
        [int]$WatcherPid = 0
    )
    $directory = Get-WatcherDirectory
    if (-not (Test-Path -LiteralPath $directory)) {
        New-Item -ItemType Directory -Path $directory | Out-Null
    }
    $state = [ordered]@{
        threadId = $CurrentThreadId
        label = $CurrentLabel
        detail = $CurrentDetail
        slot = $(if ($CurrentSlot -gt 0) { $CurrentSlot } else { $null })
        intervalSeconds = $CurrentIntervalSeconds
        idleDoneSeconds = $(if ($CurrentIdleDoneSeconds -gt 0) { $CurrentIdleDoneSeconds } else { 0 })
        lastActivityAt = $(if ([string]::IsNullOrWhiteSpace($LastActivityAt)) { Get-NowIso } else { $LastActivityAt })
        pid = $(if ($WatcherPid -gt 0) { $WatcherPid } else { $null })
        updatedAt = Get-NowIso
    }
    $path = Get-WatcherStatePath -CurrentThreadId $CurrentThreadId
    $tempPath = "$path.tmp"
    $json = $state | ConvertTo-Json -Depth 5
    Invoke-WithRetry -ScriptBlock {
        Set-Content -LiteralPath $tempPath -Value $json -Encoding UTF8
        Move-Item -LiteralPath $tempPath -Destination $path -Force
    } | Out-Null
}

function Remove-WatcherState {
    param([string]$CurrentThreadId)
    $path = Get-WatcherStatePath -CurrentThreadId $CurrentThreadId
    if (Test-Path -LiteralPath $path) {
        Invoke-WithRetry -ScriptBlock {
            if (Test-Path -LiteralPath $path) {
                Remove-Item -LiteralPath $path -Force
            }
        } | Out-Null
    }
}

function Update-WatcherMetadata {
    param(
        [string]$CurrentThreadId,
        [string]$CurrentLabel,
        [string]$CurrentDetail,
        [int]$CurrentSlot,
        [int]$CurrentIntervalSeconds,
        [int]$CurrentIdleDoneSeconds,
        [switch]$RefreshActivity
    )
    $existing = Read-WatcherState -CurrentThreadId $CurrentThreadId
    if ($null -eq $existing) {
        return
    }
    $labelToWrite = if ([string]::IsNullOrWhiteSpace($CurrentLabel)) { [string]$existing.label } else { $CurrentLabel }
    $detailToWrite = if ([string]::IsNullOrWhiteSpace($CurrentDetail)) { [string]$existing.detail } else { $CurrentDetail }
    $existingSlot = if ($null -ne $existing.slot) { [int]$existing.slot } else { 0 }
    $existingInterval = if ($null -ne $existing.intervalSeconds) { [int]$existing.intervalSeconds } else { 20 }
    $existingIdleDone = if ($null -ne $existing.idleDoneSeconds) { [int]$existing.idleDoneSeconds } else { 0 }
    $existingLastActivityAt = if ($null -ne $existing.lastActivityAt) { [string]$existing.lastActivityAt } else { Get-NowIso }
    $existingPid = if ($null -ne $existing.pid) { [int]$existing.pid } else { 0 }
    $slotToWrite = if ($CurrentSlot -gt 0) { $CurrentSlot } else { $existingSlot }
    $intervalToWrite = if ($CurrentIntervalSeconds -gt 0) { $CurrentIntervalSeconds } else { $existingInterval }
    $idleDoneToWrite = if ($CurrentIdleDoneSeconds -gt 0) { $CurrentIdleDoneSeconds } else { $existingIdleDone }
    $lastActivityAtToWrite = if ($RefreshActivity) { Get-NowIso } else { $existingLastActivityAt }
    $pidToWrite = $existingPid
    Write-WatcherState -CurrentThreadId $CurrentThreadId -CurrentLabel $labelToWrite -CurrentDetail $detailToWrite -CurrentSlot $slotToWrite -CurrentIntervalSeconds $intervalToWrite -CurrentIdleDoneSeconds $idleDoneToWrite -LastActivityAt $lastActivityAtToWrite -WatcherPid $pidToWrite
}

function Test-WatcherRunning {
    param([string]$CurrentThreadId)
    $state = Read-WatcherState -CurrentThreadId $CurrentThreadId
    if ($null -eq $state -or -not $state.pid) {
        return $false
    }
    try {
        $null = Get-Process -Id ([int]$state.pid) -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Invoke-BridgePost {
    param(
        [string]$Uri,
        [hashtable]$Body
    )
    $json = $Body | ConvertTo-Json -Depth 6 -Compress
    return Invoke-RestMethod -Method Post -Uri $Uri -ContentType "application/json" -Body $json
}

function ConvertTo-SingleQuotedPowerShellLiteral {
    param([string]$Value)
    if ($null -eq $Value) {
        return "''"
    }
    return "'$($Value.Replace("'", "''"))'"
}

function Start-Watcher {
    param(
        [string]$CurrentThreadId,
        [string]$CurrentLabel,
        [string]$CurrentDetail,
        [string]$CurrentBridgeUrl,
        [int]$CurrentSlot,
        [int]$CurrentIntervalSeconds,
        [int]$CurrentIdleDoneSeconds
    )
    if (Test-WatcherRunning -CurrentThreadId $CurrentThreadId) {
        Update-WatcherMetadata -CurrentThreadId $CurrentThreadId -CurrentLabel $CurrentLabel -CurrentDetail $CurrentDetail -CurrentSlot $CurrentSlot -CurrentIntervalSeconds $CurrentIntervalSeconds -CurrentIdleDoneSeconds $CurrentIdleDoneSeconds -RefreshActivity
        return Read-WatcherState -CurrentThreadId $CurrentThreadId
    }

    Write-WatcherState -CurrentThreadId $CurrentThreadId -CurrentLabel $CurrentLabel -CurrentDetail $CurrentDetail -CurrentSlot $CurrentSlot -CurrentIntervalSeconds $CurrentIntervalSeconds -CurrentIdleDoneSeconds $CurrentIdleDoneSeconds
    $watchCommand = @(
        "& $(ConvertTo-SingleQuotedPowerShellLiteral -Value $PSCommandPath)",
        "-Action watch-loop",
        "-ThreadId $(ConvertTo-SingleQuotedPowerShellLiteral -Value $CurrentThreadId)",
        "-BridgeUrl $(ConvertTo-SingleQuotedPowerShellLiteral -Value $CurrentBridgeUrl)",
        "-IntervalSeconds $CurrentIntervalSeconds",
        "-IdleDoneSeconds $CurrentIdleDoneSeconds"
    ) -join " "
    $encodedWatchCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($watchCommand))
    $commandLine = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand $encodedWatchCommand"
    $createResult = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
        CommandLine = $commandLine
        CurrentDirectory = (Get-Location).Path
    }
    if ($createResult.ReturnValue -ne 0 -or -not $createResult.ProcessId) {
        throw "Watcher konnte nicht gestartet werden (Win32_Process.Create ReturnValue=$($createResult.ReturnValue))."
    }
    Write-WatcherState -CurrentThreadId $CurrentThreadId -CurrentLabel $CurrentLabel -CurrentDetail $CurrentDetail -CurrentSlot $CurrentSlot -CurrentIntervalSeconds $CurrentIntervalSeconds -CurrentIdleDoneSeconds $CurrentIdleDoneSeconds -WatcherPid ([int]$createResult.ProcessId)
    return Read-WatcherState -CurrentThreadId $CurrentThreadId
}

function Stop-Watcher {
    param([string]$CurrentThreadId)
    $state = Read-WatcherState -CurrentThreadId $CurrentThreadId
    Remove-WatcherState -CurrentThreadId $CurrentThreadId
    if ($null -ne $state -and $state.pid) {
        try {
            Stop-Process -Id ([int]$state.pid) -ErrorAction SilentlyContinue
        } catch {
        }
    }
}

function Invoke-WatchLoop {
    param(
        [string]$CurrentThreadId,
        [string]$CurrentBridgeUrl,
        [int]$CurrentIntervalSeconds,
        [int]$CurrentIdleDoneSeconds
    )
    $threadUri = Get-ThreadUri -BaseUrl $CurrentBridgeUrl -CurrentThreadId $CurrentThreadId
    $sessionLogPath = $null
    while ($true) {
        $state = Read-WatcherState -CurrentThreadId $CurrentThreadId
        if ($null -eq $state) {
            break
        }
        if ([string]::IsNullOrWhiteSpace($sessionLogPath) -or -not (Test-Path -LiteralPath $sessionLogPath)) {
            $sessionLogPath = Find-CodexSessionLog -CurrentThreadId $CurrentThreadId
        }
        if (-not [string]::IsNullOrWhiteSpace($sessionLogPath)) {
            $turnState = Get-CodexTurnState -SessionLogPath $sessionLogPath
            if (
                $null -ne $turnState -and
                $null -ne $turnState.lastFinalAnswerAt -and
                ($null -eq $turnState.lastUserMessageAt -or $turnState.lastFinalAnswerAt -gt $turnState.lastUserMessageAt)
            ) {
                $donePayload = @{
                    status = "done"
                    exitCode = 0
                    source = "codex-app"
                    label = if ([string]::IsNullOrWhiteSpace([string]$state.label)) { Get-DefaultLabel } else { [string]$state.label }
                    detail = "Antwort gesendet"
                }
                if ($state.slot) {
                    $donePayload.slot = [int]$state.slot
                }
                try {
                    Invoke-BridgePost -Uri $threadUri -Body $donePayload | Out-Null
                } catch {
                }
                Remove-WatcherState -CurrentThreadId $CurrentThreadId
                break
            }
        }
        $idleDoneToUse = if ($null -ne $state.idleDoneSeconds -and [int]$state.idleDoneSeconds -gt 0) { [int]$state.idleDoneSeconds } else { $CurrentIdleDoneSeconds }
        $lastActivityAt = if ($null -ne $state.lastActivityAt) { [string]$state.lastActivityAt } else { "" }
        $lastActivityMs = if ([string]::IsNullOrWhiteSpace($lastActivityAt)) { 0 } else { [DateTimeOffset]::Parse($lastActivityAt).ToUnixTimeMilliseconds() }
        $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        if ($idleDoneToUse -gt 0 -and $lastActivityMs -gt 0 -and ($nowMs - $lastActivityMs) -ge ($idleDoneToUse * 1000)) {
            $donePayload = @{
                status = "done"
                exitCode = 0
                source = "codex-app"
                label = if ([string]::IsNullOrWhiteSpace([string]$state.label)) { Get-DefaultLabel } else { [string]$state.label }
                detail = "Warten auf Nachricht"
            }
            if ($state.slot) {
                $donePayload.slot = [int]$state.slot
            }
            try {
                Invoke-BridgePost -Uri $threadUri -Body $donePayload | Out-Null
            } catch {
            }
            Remove-WatcherState -CurrentThreadId $CurrentThreadId
            break
        }
        $payload = @{
            status = "running"
            heartbeat = $true
            source = "codex-app"
            label = if ([string]::IsNullOrWhiteSpace([string]$state.label)) { Get-DefaultLabel } else { [string]$state.label }
            detail = if ([string]::IsNullOrWhiteSpace([string]$state.detail)) { "Codex arbeitet" } else { [string]$state.detail }
        }
        if ($state.slot) {
            $payload.slot = [int]$state.slot
        }
        try {
            Invoke-BridgePost -Uri "$threadUri/heartbeat" -Body $payload | Out-Null
        } catch {
        }
        Start-Sleep -Seconds ([Math]::Max(1, [Math]::Min(5, $CurrentIntervalSeconds)))
    }
}

$resolvedThreadId = Get-NormalizedThreadId -Value $ThreadId
$resolvedLabel = if ([string]::IsNullOrWhiteSpace($Label)) { Get-DefaultLabel } else { $Label.Trim() }
$threadUri = Get-ThreadUri -BaseUrl $BridgeUrl -CurrentThreadId $resolvedThreadId

switch ($Action) {
    "watch-start" {
        $state = Start-Watcher -CurrentThreadId $resolvedThreadId -CurrentLabel $resolvedLabel -CurrentDetail $Detail.Trim() -CurrentBridgeUrl $BridgeUrl -CurrentSlot $Slot -CurrentIntervalSeconds $IntervalSeconds -CurrentIdleDoneSeconds $IdleDoneSeconds
        $state | ConvertTo-Json -Depth 5
        return
    }
    "watch-stop" {
        Stop-Watcher -CurrentThreadId $resolvedThreadId
        @{ threadId = $resolvedThreadId; watcher = "stopped" } | ConvertTo-Json -Depth 5
        return
    }
    "watch-loop" {
        Invoke-WatchLoop -CurrentThreadId $resolvedThreadId -CurrentBridgeUrl $BridgeUrl -CurrentIntervalSeconds $IntervalSeconds -CurrentIdleDoneSeconds $IdleDoneSeconds
        return
    }
}

$payload = @{
    label = $resolvedLabel
    source = "codex-app"
}

if (-not [string]::IsNullOrWhiteSpace($Detail)) {
    $payload.detail = $Detail.Trim()
}
if ($Slot -gt 0) {
    $payload.slot = $Slot
}

$stopWatcher = $false
$useHeartbeatEndpoint = $false

switch ($Action) {
    "register" {
        $payload.status = "running"
        $payload.heartbeat = $true
        $payload.startedAt = Get-NowIso
        $useHeartbeatEndpoint = $true
    }
    "progress" {
        $payload.status = "running"
        $payload.heartbeat = $true
        $useHeartbeatEndpoint = $true
    }
    "heartbeat" {
        $payload.status = "running"
        $payload.heartbeat = $true
        $useHeartbeatEndpoint = $true
    }
    "needs_input" {
        if (-not $payload.detail) {
            $payload.detail = "Rueckfrage offen"
        }
        $payload.status = "needs_input"
        $stopWatcher = $true
    }
    "done" {
        if (-not $payload.detail) {
            $payload.detail = "Erfolgreich beendet"
        }
        $payload.status = "done"
        $payload.exitCode = 0
        $stopWatcher = $true
    }
    "error" {
        $payload.status = "error"
        $payload.exitCode = $ExitCode
        if (-not $payload.detail) {
            $payload.detail = "Fehler"
        }
        $stopWatcher = $true
    }
    "clear" {
        $payload.clear = $true
        $stopWatcher = $true
    }
}

if ($stopWatcher) {
    Stop-Watcher -CurrentThreadId $resolvedThreadId
}

if ($Action -eq "clear") {
    Invoke-BridgePost -Uri $threadUri -Body $payload | ConvertTo-Json -Depth 6
    return
}

$targetUri = if ($useHeartbeatEndpoint) { "$threadUri/heartbeat" } else { $threadUri }
$response = Invoke-BridgePost -Uri $targetUri -Body $payload

if ($Action -in @("register", "progress", "heartbeat")) {
    $resolvedSlot = if ($null -ne $response.slot -and [int]$response.slot -gt 0) { [int]$response.slot } else { $Slot }
    $resolvedDetail = if ($payload.detail) { [string]$payload.detail } elseif ($null -ne $response.detail -and -not [string]::IsNullOrWhiteSpace([string]$response.detail)) { [string]$response.detail } else { "Codex arbeitet" }
    Update-WatcherMetadata -CurrentThreadId $resolvedThreadId -CurrentLabel $resolvedLabel -CurrentDetail $resolvedDetail -CurrentSlot $resolvedSlot -CurrentIntervalSeconds $IntervalSeconds -CurrentIdleDoneSeconds $IdleDoneSeconds -RefreshActivity
    if ($Watch -or -not (Test-WatcherRunning -CurrentThreadId $resolvedThreadId)) {
        Start-Watcher -CurrentThreadId $resolvedThreadId -CurrentLabel $resolvedLabel -CurrentDetail $resolvedDetail -CurrentBridgeUrl $BridgeUrl -CurrentSlot $resolvedSlot -CurrentIntervalSeconds $IntervalSeconds -CurrentIdleDoneSeconds $IdleDoneSeconds | Out-Null
    }
}

$response | ConvertTo-Json -Depth 6
