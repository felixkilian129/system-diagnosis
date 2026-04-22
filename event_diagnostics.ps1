[CmdletBinding()]
param(
    [Parameter()]
    [string]$OutputDirectory = (Join-Path -Path (Get-Location) -ChildPath "logs"),
    [Parameter()]
    [ValidateRange(1,240)]
    [int]$LookbackHours = 6,
    [Parameter()]
    [ValidateRange(10,1000)]
    [int]$MaxEventsPerLog = 200,
    [Parameter()]
    [string[]]$LogNames = @(
        'Application',
        'System',
        'Microsoft-Windows-WER-SystemErrorReporting/Operational'
    ),
    [Parameter()]
    [string[]]$ProviderNames = @(),
    [Parameter()]
    [int[]]$EventIds = @(),
    [Parameter()]
    [string[]]$MessageContains = @(),
    [switch]$IncludeWarnings,
    [switch]$IncludeInformation,
    [switch]$IncludeVerbose
)

Set-StrictMode -Version Latest

$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
if (-not (Test-Path -LiteralPath $OutputDirectory)) {
    New-Item -Path $OutputDirectory -ItemType Directory -Force | Out-Null
}

$timestamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$logFile = Join-Path -Path $OutputDirectory -ChildPath ("event_diagnostics_{0}.log" -f $timestamp)
New-Item -Path $logFile -ItemType File -Force | Out-Null

function Write-Log {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)]
        [string]$Message,
        [ValidateSet('INFO','WARN','ERROR')]
        [string]$Severity = 'INFO'
    )

    $timestamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm:ss')
    $line = "{0} [{1}] {2}" -f $timestamp, $Severity, $Message
    Write-Output $line
    Add-Content -Path $logFile -Value $line -Encoding UTF8
}

function Write-Section {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)]
        [string]$Title
    )

    Write-Output ''
    Add-Content -Path $logFile -Value '' -Encoding UTF8
    Write-Log -Message ("===== {0} =====" -f $Title)
}

function Get-FlatMessage {
    [CmdletBinding()]
    param(
        [Parameter()] [string]$Message
    )

    if (-not $Message) { return 'No message text.' }
    $text = $Message.Replace("`r", ' ').Replace("`n", ' ').Trim()
    if ($text) { return $text }
    return 'No message text.'
}

function Test-MessageMatch {
    [CmdletBinding()]
    param(
        [Parameter()] [string]$Message,
        [Parameter()] [string[]]$Filters
    )

    if (-not $Filters -or $Filters.Count -eq 0) { return $true }
    if (-not $Message) { return $false }

    foreach ($filter in $Filters) {
        if (-not $filter) { continue }
        if ($Message.IndexOf($filter, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
            return $true
        }
    }

    return $false
}

$targetLogs = New-Object System.Collections.Generic.List[string]
foreach ($logName in $LogNames) {
    if ($null -eq $logName) { continue }
    $cleanLog = $logName.Trim()
    if (-not $cleanLog) { continue }
    if (-not $targetLogs.Contains($cleanLog)) {
        $targetLogs.Add($cleanLog) | Out-Null
    }
}
if ($targetLogs.Count -eq 0) {
    throw "No log names were provided after trimming input."
}
$targetLogArray = $targetLogs.ToArray()

$providerFilter = New-Object System.Collections.Generic.List[string]
foreach ($provider in $ProviderNames) {
    if ($null -eq $provider) { continue }
    $cleanProvider = $provider.Trim()
    if (-not $cleanProvider) { continue }
    if (-not $providerFilter.Contains($cleanProvider)) {
        $providerFilter.Add($cleanProvider) | Out-Null
    }
}
$providerArray = $providerFilter.ToArray()

$messageFilterList = New-Object System.Collections.Generic.List[string]
foreach ($messageFragment in $MessageContains) {
    if ($null -eq $messageFragment) { continue }
    $cleanFragment = $messageFragment.Trim()
    if (-not $cleanFragment) { continue }
    if (-not $messageFilterList.Contains($cleanFragment)) {
        $messageFilterList.Add($cleanFragment) | Out-Null
    }
}
$messageFilters = $messageFilterList.ToArray()

$levelSet = [System.Collections.Generic.HashSet[int]]::new()
$null = $levelSet.Add(1) # Critical
$null = $levelSet.Add(2) # Error
if ($IncludeWarnings.IsPresent) { $null = $levelSet.Add(3) }
if ($IncludeInformation.IsPresent) { $null = $levelSet.Add(4) }
if ($IncludeVerbose.IsPresent) { $null = $levelSet.Add(5) }
$levelFilter = $levelSet.ToArray()

$startTime = (Get-Date).AddHours(-1 * $LookbackHours)
$summaryAdvice = [System.Collections.Generic.HashSet[string]]::new()
$totalEventCount = 0

Write-Section 'Run Context'
Write-Log -Message ("Output file: {0}" -f $logFile)
Write-Log -Message ("Lookback window: last {0} hour(s) starting {1:u}" -f $LookbackHours, $startTime)
Write-Log -Message ("Logs requested: {0}" -f ($targetLogArray -join ', '))
if ($providerArray.Count -gt 0) {
    Write-Log -Message ("Provider filter: {0}" -f ($providerArray -join ', '))
}
if ($EventIds.Count -gt 0) {
    Write-Log -Message ("EventId filter: {0}" -f ($EventIds -join ', '))
}
if ($messageFilters.Count -gt 0) {
    Write-Log -Message ("Message filter fragment(s): {0}" -f ($messageFilters -join ', '))
}

foreach ($logName in $targetLogArray) {
    Write-Section ("Log: {0}" -f $logName)

    $filter = @{ LogName = $logName; StartTime = $startTime }
    if ($levelFilter.Length -gt 0) { $filter['Level'] = $levelFilter }
    if ($providerArray.Count -gt 0) { $filter['ProviderName'] = $providerArray }
    if ($EventIds.Count -gt 0) { $filter['Id'] = $EventIds }

    try {
        $events = Get-WinEvent -FilterHashtable $filter -ErrorAction Stop
    }
    catch {
        Write-Log -Message ("Failed to query log {0}: {1}" -f $logName, $_.Exception.Message) -Severity 'WARN'
        if ($_.Exception -and $_.Exception.Message -match '(?i)access|zugriff|privilege') {
            $null = $summaryAdvice.Add("Access denied reading {0}. Run PowerShell as Administrator." -f $logName)
        }
        continue
    }

    if (-not $events -or $events.Count -eq 0) {
        Write-Log -Message ("No events found in the last {0} hour(s)." -f $LookbackHours)
        continue
    }

    if ($messageFilters.Count -gt 0) {
        $filteredEvents = New-Object System.Collections.Generic.List[object]
        foreach ($record in $events) {
            if (Test-MessageMatch -Message $record.Message -Filters $messageFilters) {
                [void]$filteredEvents.Add($record)
            }
        }
        $events = $filteredEvents.ToArray()
    }

    if (-not $events -or $events.Count -eq 0) {
        Write-Log -Message "Events were found but none matched the message filters."
        continue
    }

    $orderedEvents = @($events | Sort-Object -Property TimeCreated -Descending)
    if ($orderedEvents.Count -eq 0) {
        Write-Log -Message "No events remained after sorting."
        continue
    }

    $selectedEvents = @($orderedEvents | Select-Object -First $MaxEventsPerLog)
    Write-Log -Message ("Captured {0} event(s); showing the most recent {1}." -f $orderedEvents.Count, $selectedEvents.Count)
    if ($orderedEvents.Count -gt $selectedEvents.Count) {
        Write-Log -Message ("Event output truncated to the most recent {0} entries." -f $selectedEvents.Count) -Severity 'WARN'
    }

    $logSummary = @{}
    foreach ($record in $orderedEvents) {
        $idText = if ($null -ne $record.Id) { $record.Id } else { 'Unknown' }
        $providerText = if ($record.ProviderName) { $record.ProviderName } else { 'Unknown' }
        $levelText = if ($record.LevelDisplayName) { $record.LevelDisplayName } else { 'Unknown' }
        $key = "{0}|{1}|{2}" -f $idText, $providerText, $levelText
        if ($logSummary.ContainsKey($key)) {
            $logSummary[$key]++
        }
        else {
            $logSummary[$key] = 1
        }
    }

    foreach ($record in $selectedEvents) {
        $timeText = 'Unknown time'
        if ($record.TimeCreated) {
            $timeText = $record.TimeCreated.ToUniversalTime().ToString('yyyy-MM-dd HH:mm:ss')
        }
        $recordId = if ($null -ne $record.RecordId) { $record.RecordId } else { 'Unknown' }
        $eventId = if ($null -ne $record.Id) { $record.Id } else { 'Unknown' }
        $levelText = if ($record.LevelDisplayName) { $record.LevelDisplayName } else { 'Unknown' }
        $providerText = if ($record.ProviderName) { $record.ProviderName } else { 'Unknown' }
        $messageText = Get-FlatMessage -Message $record.Message
        Write-Log -Message ("{0} | RecordId {1} | EventId {2} | Level {3} | Source {4} | Message: {5}" -f $timeText, $recordId, $eventId, $levelText, $providerText, $messageText)
        $totalEventCount++
    }

    if ($logSummary.Count -gt 0) {
        Write-Log -Message 'Top repeating events:'
        $topEntries = $logSummary.GetEnumerator() | Sort-Object -Property Value -Descending | Select-Object -First 5
        foreach ($entry in $topEntries) {
            $parts = $entry.Key.Split('|', 3)
            $eventIdText = $parts[0]
            $sourceText = $parts[1]
            $levelText = $parts[2]
            Write-Log -Message ("{0} hit(s) | EventId {1} | Level {2} | Source {3}" -f $entry.Value, $eventIdText, $levelText, $sourceText)
        }
    }
}

Write-Section 'Summary'
if ($totalEventCount -gt 0) {
    Write-Log -Message ("Logged {0} event(s) across {1} log(s)." -f $totalEventCount, $targetLogArray.Count)
}
else {
    Write-Log -Message "No matching events were captured."
}

if ($summaryAdvice.Count -gt 0) {
    Write-Log -Message 'Follow-up actions:'
    foreach ($advice in $summaryAdvice) {
        Write-Log -Message ("- {0}" -f $advice)
    }
}

Write-Log -Message ("Event capture completed. Detailed output stored at {0}." -f $logFile)
return $logFile
