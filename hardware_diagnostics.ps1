[CmdletBinding()]
param(
    [Parameter()]
    [string]$OutputDirectory = (Join-Path -Path (Get-Location) -ChildPath "logs"),
    [Parameter()]
    [ValidateRange(1,365)]
    [int]$EventLogLookbackDays = 7,
    [Parameter()]
    [ValidateRange(5,500)]
    [int]$MaxEventsPerSection = 30
)

$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)

if (-not (Test-Path -LiteralPath $OutputDirectory)) {
    New-Item -Path $OutputDirectory -ItemType Directory -Force | Out-Null
}

$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$logFile = Join-Path -Path $OutputDirectory -ChildPath ("hardware_diagnostics_{0}.log" -f $timestamp)

New-Item -Path $logFile -ItemType File -Force | Out-Null

$script:issueCount = 0
$script:issueAdvices = [System.Collections.Generic.HashSet[string]]::new()

$script:systemManufacturer = 'Unknown'
$script:systemModel = 'Unknown'
$script:sensorDiscovery = @{
    FanClasses = [System.Collections.Generic.HashSet[string]]::new()
    ThermalClasses = [System.Collections.Generic.HashSet[string]]::new()
}
$null = $script:sensorDiscovery.FanClasses.Add('Win32_Fan')
$null = $script:sensorDiscovery.ThermalClasses.Add('MSAcpi_ThermalZoneTemperature')
$null = $script:sensorDiscovery.ThermalClasses.Add('Win32_PerfFormattedData_Counters_ThermalZoneInformation')

function Write-Log {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true, Position=0)]
        [string]$Message,
        [switch]$Issue
    )

    $entryType = if ($Issue.IsPresent) { "[ISSUE]" } else { "[INFO]" }
    $line = "{0} {1} {2}" -f (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd HH:mm:ss"), $entryType, $Message
    Write-Output $line
    Add-Content -Path $logFile -Value $line -Encoding UTF8
    if ($Issue.IsPresent) {
        $script:issueCount++
    }
}

function Write-Section {
    param(
        [Parameter(Mandatory=$true, Position=0)]
        [string]$Title
    )

    Write-Output ""
    Add-Content -Path $logFile -Value "" -Encoding UTF8
    Write-Log -Message ("===== {0} =====" -f $Title)
}

function Add-IssueAdvice {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Advice
    )

    if (-not $Advice) { return }
    $trimmed = $Advice.Trim()
    if (-not $trimmed) { return }
    $null = $script:issueAdvices.Add($trimmed)
}

function Convert-FromRawKelvin {
    param(
        [Parameter()]
        [double]$Value
    )

    if ($null -eq $Value -or $Value -le 0) { return $null }
    return [math]::Round((($Value / 10) - 273.15), 1)
}

function Format-OptionalNumber {
    param(
        [Parameter()]
        [object]$Number,
        [Parameter()]
        [string]$Format = 'N1',
        [Parameter()]
        [string]$Suffix = ''
    )

    if ($null -eq $Number) { return 'Unknown' }
    $converted = $null
    try {
        $converted = [double]$Number
    }
    catch {
        return 'Unknown'
    }
    try {
        $formatted = ('{0:' + $Format + '}' -f $converted)
    }
    catch {
        return 'Unknown'
    }
    if ($Suffix) { return "{0} {1}" -f $formatted, $Suffix }
    return $formatted
}

function Test-WmiPatterns {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Namespace,
        [Parameter(Mandatory=$true)]
        [string[]]$Patterns
    )

    $matches = [System.Collections.Generic.HashSet[string]]::new()
    $errors = New-Object System.Collections.Generic.List[string]
    $namespaceMissing = $false
    $namespaceError = $null

    foreach ($pattern in $Patterns) {
        try {
            $classes = Get-CimClass -Namespace $Namespace -ClassName $pattern -ErrorAction Stop
            if ($classes) {
                foreach ($class in $classes) {
                    $null = $matches.Add($class.CimClassName)
                }
            }
        }
        catch [Microsoft.Management.Infrastructure.CimException] {
            switch ($_.Exception.StatusCode) {
                0x8004100E {
                    $namespaceMissing = $true
                    $namespaceError = $_.Exception.Message
                }
                0x80041002 { }
                default {
                    $errorMessage = if ($_.Exception.Message) { $_.Exception.Message } else { 'Unknown error' }
                    $errors.Add("$($pattern): $errorMessage")
                }
            }
            if ($namespaceMissing) { break }
        }
        catch {
            $errorMessage = if ($_.Exception.Message) { $_.Exception.Message } else { 'Unknown error' }
            $errors.Add("$($pattern): $errorMessage")
        }
    }

    [pscustomobject]@{
        Namespace = $Namespace
        NamespaceMissing = $namespaceMissing
        NamespaceError = $namespaceError
        Matches = $matches
        Errors = $errors
    }
}

function Register-SensorClasses {
    param(
        [Parameter(Mandatory=$true)]
        [System.Collections.Generic.HashSet[string]]$Classes,
        [Parameter(Mandatory=$true)]
        [string]$Category
    )

    if ($Classes.Count -eq 0) { return }
    switch ($Category.ToUpperInvariant()) {
        'FAN' { foreach ($name in $Classes) { $null = $script:sensorDiscovery.FanClasses.Add($name) } }
        'THERMAL' { foreach ($name in $Classes) { $null = $script:sensorDiscovery.ThermalClasses.Add($name) } }
    }
}



$codeDescriptions = @{
    1 = "Device is not configured correctly (Code 1)"
    3 = "Driver may be corrupted or missing (Code 3)"
    10 = "Device cannot start (Code 10)"
    12 = "Device cannot find enough free resources (Code 12)"
    14 = "Device needs restart (Code 14)"
    16 = "Device cannot find required resources (Code 16)"
    18 = "Reinstall the drivers (Code 18)"
    19 = "Registry may be corrupted (Code 19)"
    21 = "Device not working properly (Code 21)"
    22 = "Device is disabled (Code 22)"
    24 = "Device is not present or not working (Code 24)"
    28 = "No drivers installed (Code 28)"
    29 = "Device disabled due to firmware (Code 29)"
    31 = "Device not working properly (Code 31)"
    32 = "Driver not loaded (Code 32)"
    33 = "Driver may be wrong or missing (Code 33)"
    34 = "Hardware configuration issue (Code 34)"
    35 = "System BIOS needs update (Code 35)"
    36 = "IRQ conflict (Code 36)"
    37 = "Driver failed to initialize (Code 37)"
    38 = "Driver instance still in memory (Code 38)"
    39 = "Driver may be corrupt (Code 39)"
    40 = "Driver or registry entry corrupt (Code 40)"
    41 = "Hardware not working (Code 41)"
    43 = "Device reported problems (Code 43)"
    44 = "Application or service has locked the device (Code 44)"
    45 = "Device not connected (Code 45)"
    47 = "Device needs restart (Code 47)"
    48 = "Driver blocked (Code 48)"
    49 = "Driver information inconsistent (Code 49)"
    50 = "Device waiting on another device (Code 50)"
    51 = "Device currently busy (Code 51)"
}

Write-Log -Message ("Hardware diagnostics started on {0} at {1}" -f $env:COMPUTERNAME, (Get-Date).ToString("u"))
Write-Log -Message ("Log file: {0}" -f $logFile)

Write-Section "System Overview"
try {
    $system = Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction Stop
    $os = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
    if ($system) {
        $script:systemManufacturer = if ($system.Manufacturer) { $system.Manufacturer.Trim() } else { 'Unknown' }
        $script:systemModel = if ($system.Model) { $system.Model.Trim() } else { 'Unknown' }
    }
    $manufacturerText = if ($script:systemManufacturer) { $script:systemManufacturer } else { 'Unknown' }
    $modelText = if ($script:systemModel) { $script:systemModel } else { 'Unknown' }
    Write-Log -Message ("Manufacturer: {0}" -f $manufacturerText)
    Write-Log -Message ("Model: {0}" -f $modelText)
    Write-Log -Message ("Total Physical Memory (GB): {0:N2}" -f ($system.TotalPhysicalMemory / 1GB))
    Write-Log -Message ("OS: {0} {1}" -f $os.Caption, $os.Version)
    Write-Log -Message ("Last Boot Up: {0}" -f $os.LastBootUpTime)
    Write-Log -Message ("System Type: {0}" -f $system.SystemType)
}
catch {
    Write-Log -Message ("Unable to read system overview: {0}" -f $_.Exception.Message) -Issue
}

Write-Section "Sensor Provider Availability"
try {
    $acpiDevices = Get-CimInstance -ClassName Win32_PnPEntity -ErrorAction Stop | Where-Object { $_.PNPDeviceID -like 'ACPI*' }
    $acpiCount = if ($acpiDevices) { $acpiDevices.Count } else { 0 }
    if ($acpiCount -gt 0) {
        $examples = $acpiDevices | Select-Object -First 3
        $labels = $examples | ForEach-Object {
            if ($_.Name) { $_.Name.Trim() }
            elseif ($_.PNPDeviceID) { $_.PNPDeviceID }
            else { 'ACPI device' }
        }
        $exampleText = if ($labels) { $labels -join '; ' } else { 'No sample descriptors' }
        Write-Log -Message ("ACPI PnP devices detected: {0}. Example entries: {1}" -f $acpiCount, $exampleText)
    }
    else {
        Write-Log -Message "No ACPI PnP devices were detected via Win32_PnPEntity." -Issue
        Add-IssueAdvice "Install motherboard/chipset drivers or update BIOS/UEFI firmware to restore ACPI device enumeration."
    }
}
catch {
    Write-Log -Message ("Unable to enumerate ACPI devices: {0}" -f $_.Exception.Message) -Issue
    Add-IssueAdvice "Check ACPI driver installation; rerun diagnostics once WMI queries succeed."
}

$sensorChecks = @(
    [pscustomobject]@{ Label = 'Win32_Fan'; Namespace = 'root/cimv2'; Patterns = @('Win32_Fan'); Category = 'Fan'; MissingAdvice = 'Win32_Fan class absent; install chipset/ACPI drivers or vendor utilities to expose fan RPM.' },
    [pscustomobject]@{ Label = 'ACPI Thermal Zones'; Namespace = 'root/wmi'; Patterns = @('MSAcpi_ThermalZoneTemperature*'); Category = 'Thermal'; MissingAdvice = 'ACPI thermal zone classes missing; update BIOS or ACPI firmware to expose thermal sensors.' },
    [pscustomobject]@{ Label = 'Thermal Performance Counters'; Namespace = 'root/cimv2'; Patterns = @('Win32_PerfFormattedData_Counters_ThermalZoneInformation'); Category = 'Thermal'; MissingAdvice = 'Thermal performance counters unavailable; enable thermal performance counters or repair the WMI repository.' }
)

foreach ($check in $sensorChecks) {
    $result = Test-WmiPatterns -Namespace $check.Namespace -Patterns $check.Patterns
    if ($result.NamespaceMissing) {
        Write-Log -Message ("Namespace {0} not available when checking {1}: {2}" -f $check.Namespace, $check.Label, $result.NamespaceError) -Issue
        continue
    }

    foreach ($err in $result.Errors) {
        Write-Log -Message ("Unable to enumerate {0} in {1}: {2}" -f $check.Label, $check.Namespace, $err) -Issue
    }

    if ($result.Matches.Count -gt 0) {
        $classText = ([string[]]$result.Matches | Sort-Object) -join ', '
        Write-Log -Message ("{0} exposed via {1}: {2}" -f $check.Label, $check.Namespace, $classText)
        Register-SensorClasses -Classes $result.Matches -Category $check.Category
    }
    else {
        Write-Log -Message ("{0} not exposed via namespace {1}." -f $check.Label, $check.Namespace)
        if ($check.MissingAdvice) { Add-IssueAdvice $check.MissingAdvice }
    }
}

$normalizedManufacturer = if ($script:systemManufacturer) { $script:systemManufacturer.ToUpperInvariant() } else { 'UNKNOWN' }
$vendorProfiles = @(
    [pscustomobject]@{ Key = 'LENOVO'; Vendor = 'Lenovo'; Namespaces = @('root/Lenovo', 'root/wmi'); Patterns = @('*Lenovo*Fan*', '*Lenovo*Therm*', '*Lenovo*Temp*', '*EC*Fan*'); Advice = 'Install Lenovo System Interface Foundation or Lenovo Commercial Vantage to expose embedded-controller telemetry.' },
    [pscustomobject]@{ Key = 'DELL'; Vendor = 'Dell'; Namespaces = @('root/dcim', 'root/wmi'); Patterns = @('*Dell*Fan*', '*Dell*Therm*', '*Dell*Temp*', 'DCIM_Thermal*'); Advice = 'Install Dell Command | Monitor or OMSA to expose Dell thermal sensors.' },
    [pscustomobject]@{ Key = 'HP'; Vendor = 'HP'; Namespaces = @('root/HPQ', 'root/HP'); Patterns = @('*HP*Fan*', '*HPQ*Therm*', 'HP_Thermal*', 'HPQ_Thermal*'); Advice = 'Install HP Client or Server Management utilities to expose HP thermal telemetry.' },
    [pscustomobject]@{ Key = 'ASUS'; Vendor = 'ASUS'; Namespaces = @('root/wmi'); Patterns = @('*ASUS*Fan*', '*ASUSTeK*Therm*', '*ATK*Fan*'); Advice = 'Install ASUS WMI/Armoury utilities to expose ASUS fan sensors.' },
    [pscustomobject]@{ Key = 'ACER'; Vendor = 'Acer'; Namespaces = @('root/wmi'); Patterns = @('*Acer*Fan*', '*Acer*Therm*'); Advice = 'Install Acer Care Center or chipset drivers to expose Acer thermal telemetry.' },
    [pscustomobject]@{ Key = 'MSI'; Vendor = 'MSI'; Namespaces = @('root/wmi'); Patterns = @('*MSI*Fan*', '*MSI*Therm*'); Advice = 'Install MSI Center utilities or firmware updates to expose MSI fan telemetry.' },
    [pscustomobject]@{ Key = 'GIGABYTE'; Vendor = 'Gigabyte'; Namespaces = @('root/wmi'); Patterns = @('*Gigabyte*Fan*', '*Gigabyte*Therm*', '*Aorus*Fan*'); Advice = 'Install Gigabyte Control Center or vendor sensor drivers to expose Gigabyte telemetry.' },
    [pscustomobject]@{ Key = 'ASROCK'; Vendor = 'ASRock'; Namespaces = @('root/wmi'); Patterns = @('*ASROCK*Fan*', '*ASRock*Therm*'); Advice = 'Install ASRock tuning utilities to expose ASRock telemetry.' }
)

$activeVendors = @()
foreach ($profile in $vendorProfiles) {
    if ($normalizedManufacturer -like ("{0}*" -f $profile.Key)) {
        $activeVendors += $profile
    }
}
if (-not $activeVendors) {
    foreach ($profile in $vendorProfiles) {
        if ($normalizedManufacturer -match $profile.Key) {
            $activeVendors += $profile
            break
        }
    }
}

foreach ($profile in $activeVendors | Sort-Object { $_.Vendor }) {
    $combinedMatches = [System.Collections.Generic.HashSet[string]]::new()
    $missingNamespaces = [System.Collections.Generic.HashSet[string]]::new()

    foreach ($ns in $profile.Namespaces) {
        $result = Test-WmiPatterns -Namespace $ns -Patterns $profile.Patterns
        if ($result.NamespaceMissing) {
            $null = $missingNamespaces.Add($ns)
            continue
        }

        foreach ($err in $result.Errors) {
            Write-Log -Message ("Unable to enumerate {0} sensors in {1}: {2}" -f $profile.Vendor, $ns, $err) -Issue
        }

        foreach ($className in $result.Matches) {
            $null = $combinedMatches.Add(("{0}:{1}" -f $ns, $className))
            if ($className -match '(?i)fan') { $null = $script:sensorDiscovery.FanClasses.Add($className) }
            if ($className -match '(?i)therm|temp|cool') { $null = $script:sensorDiscovery.ThermalClasses.Add($className) }
        }
    }

    if ($combinedMatches.Count -gt 0) {
        $display = [string[]]$combinedMatches | Sort-Object
        $limit = 6
        $displayText = ($display | Select-Object -First $limit) -join ', '
        if ($display.Count -gt $limit) {
            $displayText += (" (+{0} more)" -f ($display.Count - $limit))
        }
        Write-Log -Message ("{0} vendor sensor classes detected: {1}" -f $profile.Vendor, $displayText)
    }
    else {
        Write-Log -Message ("No {0} vendor-specific fan/thermal classes detected in namespaces {1}." -f $profile.Vendor, ($profile.Namespaces -join ', '))
        if ($profile.Advice) { Add-IssueAdvice $profile.Advice }
    }
}

Write-Section "Device Manager Errors"
try {
    $devices = Get-CimInstance -ClassName Win32_PnPEntity -ErrorAction Stop | Where-Object { $_.ConfigManagerErrorCode -ne 0 }
    if ($devices) {
        foreach ($device in $devices) {
            $code = [int]$device.ConfigManagerErrorCode
            $description = if ($codeDescriptions.ContainsKey($code)) { $codeDescriptions[$code] } else { "ConfigManager error code {0}" -f $code }
            Write-Log -Message ("{0} | Status: {1} | Error: {2}" -f $device.Name, $device.Status, $description) -Issue
        }
    }
    else {
        Write-Log -Message "No device configuration errors detected."
    }
}
catch {
    Write-Log -Message ("Unable to query plug and play devices: {0}" -f $_.Exception.Message) -Issue
}

Write-Section "Disk Health"
try {
    $disks = Get-CimInstance -ClassName Win32_DiskDrive -ErrorAction Stop
    if ($disks) {
        foreach ($disk in $disks) {
            $status = if ($disk.Status) { $disk.Status } else { "Unknown" }
            $sizeGb = if ($disk.Size) { $disk.Size / 1GB } else { 0 }
            Write-Log -Message ("{0} | Model: {1} | Status: {2} | Size (GB): {3:N2}" -f $disk.DeviceID, $disk.Model, $status, $sizeGb)
            if ($status -and ($status.Trim() -match "(?i)error|degraded|fail|critical|nonrecoverable|stressed")) {
                Write-Log -Message ("Disk {0} reports status {1}" -f $disk.DeviceID, $status) -Issue
            }
            if ($disk.LastErrorCode) {
                Write-Log -Message ("Disk {0} last error code: {1}" -f $disk.DeviceID, $disk.LastErrorCode) -Issue
            }
        }
    }
    else {
        Write-Log -Message "No disks returned from Win32_DiskDrive." -Issue
    }
}
catch {
    Write-Log -Message ("Unable to query disk health: {0}" -f $_.Exception.Message) -Issue
}

Write-Section "SMART Predictions"
try {
    $smartData = Get-CimInstance -Namespace "root\wmi" -ClassName MSStorageDriver_FailurePredictStatus -ErrorAction Stop
    if ($smartData) {
        foreach ($smart in $smartData) {
            if ($smart.PredictFailure) {
                $reason = if ($smart.Reason) { $smart.Reason } else { "Reason code unavailable" }
                Write-Log -Message ("SMART predicts failure for {0} | Reason: {1}" -f $smart.InstanceName, $reason) -Issue
            }
        }
        if (-not ($smartData | Where-Object { $_.PredictFailure })) {
            Write-Log -Message "SMART data indicates no imminent failures."
        }
    }
    else {
        Write-Log -Message "SMART data not available from MSStorageDriver_FailurePredictStatus."
    }
}
catch {
    Write-Log -Message ("Unable to query SMART data: {0}" -f $_.Exception.Message)
}

function Write-EventLogSection {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Title,
        [Parameter(Mandatory=$true)]
        [string[]]$Providers
    )

    Write-Section $Title

    $sectionName = if ($Title) { ($Title -replace '(?i)\bevents?\b', '').Trim() } else { 'section' }
    if (-not $sectionName) { $sectionName = 'section' }
    $normalizedTitle = $sectionName.ToLower()

    $availableProviders = @()
    $missingProviders = @()
    foreach ($provider in $Providers) {
        try {
            $null = Get-WinEvent -ListProvider $provider -ErrorAction Stop
            $availableProviders += $provider
        }
        catch {
            $missingProviders += $provider
        }
    }

    if ($missingProviders) {
        Write-Log -Message ("Skipping missing event providers: {0}" -f ($missingProviders -join ", "))
    }

    if (-not $availableProviders) {
        Write-Log -Message ("No {0} event providers are available on this system." -f $normalizedTitle)
        return
    }

    try {
        $events = Get-WinEvent -FilterHashtable @{
            LogName = "System"
            ProviderName = $availableProviders
            StartTime = (Get-Date).AddDays(-$EventLogLookbackDays)
        } -ErrorAction SilentlyContinue
    }
    catch {
        Write-Log -Message ("Unable to read event log for providers {0}: {1}" -f ($availableProviders -join ", "), $_.Exception.Message) -Issue
        return
    }

    if (-not $events) {
        Write-Log -Message ("No {0} events detected in the last {1} day(s)." -f $normalizedTitle, $EventLogLookbackDays)
        return
    }

    $filteredEvents = $events | Where-Object { $_.LevelDisplayName -in @("Critical", "Error", "Warning") }

    if (-not $filteredEvents) {
        Write-Log -Message ("No {0} events at Critical/Error/Warning level in the last {1} day(s)." -f $normalizedTitle, $EventLogLookbackDays)
        return
    }

    $ordered = @($filteredEvents | Sort-Object TimeCreated -Descending)
    $selected = $ordered | Select-Object -First $MaxEventsPerSection

    foreach ($event in $selected) {
        $timeStamp = if ($event.TimeCreated) { $event.TimeCreated.ToString("u") } else { "Unknown time" }
        $message = if ($event.Message) { $event.Message.Replace("`r", " ").Replace("`n", " ").Trim() } else { "No message text." }
        $line = "{0} | Provider: {1} | Id: {2} | Level: {3} | {4}" -f $timeStamp, $event.ProviderName, $event.Id, $event.LevelDisplayName, $message
        if ($event.LevelDisplayName -in @("Critical", "Error")) {
            Write-Log -Message $line -Issue
        }
        else {
            Write-Log -Message $line
        }
    }

    if ($ordered.Count -gt $MaxEventsPerSection) {
        Write-Log -Message ("Event output truncated to {0} of {1} entries." -f $MaxEventsPerSection, $ordered.Count)
    }
}
Write-EventLogSection -Title "Storage Events" -Providers @("Disk", "Ntfs", "atapi", "storahci", "stornvme", "iaStorV", "iaStorA")
Write-EventLogSection -Title "Hardware Error Events" -Providers @("Microsoft-Windows-WHEA-Logger", "WHEA-Logger")
Write-EventLogSection -Title "Thermal and Fan Events" -Providers @("Microsoft-Windows-Kernel-Power", "Microsoft-Windows-ACPI", "ACPI", "Microsoft-Windows-Thermal-UI", "Microsoft-Windows-ThermalState")

Write-Section "Processor Status"
try {
    $processors = Get-CimInstance -ClassName Win32_Processor -ErrorAction Stop
    foreach ($cpu in $processors) {
        Write-Log -Message ("Processor: {0} | Status: {1} | Current Clock (MHz): {2}" -f $cpu.Name, $cpu.Status, $cpu.CurrentClockSpeed)
        if ($cpu.Status -and ($cpu.Status.Trim() -match "(?i)error|degraded|fail|critical|nonrecoverable|stressed")) {
            Write-Log -Message ("Processor {0} reports status {1}" -f $cpu.DeviceID, $cpu.Status) -Issue
        }
        if ($cpu.LastErrorCode) {
            Write-Log -Message ("Processor {0} last error code: {1}" -f $cpu.DeviceID, $cpu.LastErrorCode) -Issue
        }
    }
}
catch {
    Write-Log -Message ("Unable to query processor status: {0}" -f $_.Exception.Message) -Issue
}

Write-Section "Memory Module Status"
try {
    $memoryModules = Get-CimInstance -ClassName Win32_PhysicalMemory -ErrorAction Stop
    if ($memoryModules) {
        foreach ($module in $memoryModules) {
            $rawStatus = if ($module.Status) { $module.Status.Trim() } else { "" }
            $status = if ($rawStatus) { $rawStatus } else { "Unknown" }
            Write-Log -Message ("Bank: {0} | Capacity (GB): {1:N2} | Speed (MHz): {2} | Status: {3}" -f $module.BankLabel, ($module.Capacity / 1GB), $module.Speed, $status)
            if ($rawStatus -and ($rawStatus -match "(?i)error|degraded|fail|critical|nonrecoverable|stressed")) {
                Write-Log -Message ("Memory module {0} reports status {1}" -f $module.BankLabel, $status) -Issue
            }
        }
    }
    else {
        Write-Log -Message "No physical memory modules returned."
    }
}
catch {
    Write-Log -Message ("Unable to query memory modules: {0}" -f $_.Exception.Message) -Issue
}

Write-Section "Fan Status"
try {
    $fans = Get-CimInstance -ClassName Win32_Fan -ErrorAction Stop
    if ($fans) {
        $availabilityMap = @{
            1 = "Other"
            2 = "Unknown"
            3 = "Running or Full Power"
            4 = "Warning"
            5 = "In Test"
            6 = "Not Applicable"
            7 = "Power Off"
            8 = "Off Line"
            9 = "Off Duty"
            10 = "Degraded"
            11 = "Not Installed"
            12 = "Install Error"
            13 = "Power Save - Unknown"
            14 = "Power Save - Low Power Mode"
            15 = "Power Save - Standby"
            16 = "Power Cycle"
            17 = "Power Save - Warning"
            18 = "Paused"
            19 = "Not Ready"
            20 = "Not Configured"
            21 = "Quiesced"
        }
        $currentFanReadings = @()
        $fanLogCache = [System.Collections.Generic.HashSet[string]]::new()
        foreach ($fan in $fans) {
            $name = if ($fan.Name) { $fan.Name.Trim() } elseif ($fan.DeviceID) { $fan.DeviceID } else { "Unknown fan" }
            $statusText = if ($fan.Status) { $fan.Status.Trim() } else { "Unknown" }
            $availabilityCode = $fan.Availability
            $availability = if ($availabilityCode -ne $null -and $availabilityMap.ContainsKey([int]$availabilityCode)) { $availabilityMap[[int]$availabilityCode] } else { "Unknown" }

            $desiredSpeedValue = $null
            $desiredSpeedDisplay = "Unknown"
            if ($fan.PSObject.Properties['DesiredSpeed'] -and $fan.DesiredSpeed -ne $null) {
                $parsedDesired = 0.0
                if ([double]::TryParse($fan.DesiredSpeed.ToString(), [ref]$parsedDesired)) {
                    $desiredSpeedValue = $parsedDesired
                    $desiredSpeedDisplay = "{0} RPM" -f [math]::Round($desiredSpeedValue, 0)
                }
            }

            $actualSpeedValue = $null
            $actualSpeedDisplay = "Unknown"
            if ($fan.PSObject.Properties['Speed'] -and $fan.Speed -ne $null) {
                $parsedActual = 0.0
                if ([double]::TryParse($fan.Speed.ToString(), [ref]$parsedActual)) {
                    $actualSpeedValue = $parsedActual
                    $actualSpeedDisplay = "{0} RPM" -f [math]::Round($actualSpeedValue, 0)
                }
            }

            $variableSpeed = if ($fan.PSObject.Properties['VariableSpeed']) { if ($fan.VariableSpeed) { "Yes" } else { "No" } } else { "Unknown" }
            $line = "Fan: {0} | Status: {1} | Availability: {2} | Desired Speed: {3} | Actual Speed: {4} | Variable Speed: {5}" -f $name, $statusText, $availability, $desiredSpeedDisplay, $actualSpeedDisplay, $variableSpeed

            $logAsIssue = $false
            if ($statusText -match "(?i)error|degraded|fail|critical|nonrecoverable|stressed|fault") {
                $logAsIssue = $true
            }
            elseif ($availabilityCode -in 4,7,8,9,10,11,12,16,17,18,19,20,21) {
                $logAsIssue = $true
            }
            elseif ($actualSpeedValue -eq 0 -and $statusText -match "(?i)ok|running") {
                $logAsIssue = $true
            }

            if ($fanLogCache.Add($line)) {
                if ($logAsIssue) {
                    Write-Log -Message $line -Issue
                }
                else {
                    Write-Log -Message $line
                }
            }

            if ($fan.PSObject.Properties['LastErrorCode'] -and $fan.LastErrorCode) {
                $lastErrorLine = "Fan {0} last error code: {1}" -f $name, $fan.LastErrorCode
                if ($fanLogCache.Add($lastErrorLine)) {
                    Write-Log -Message $lastErrorLine -Issue
                }
            }

            if ($fan.PSObject.Properties['ConfigManagerErrorCode']) {
                $configRaw = $fan.ConfigManagerErrorCode
                if ($null -ne $configRaw) {
                    $configText = $configRaw.ToString().Trim()
                    if ($configText) {
                        $configCode = 0
                        if ([int]::TryParse($configText, [ref]$configCode)) {
                            if ($configCode -ne 0) {
                                $configDescription = if ($codeDescriptions.ContainsKey($configCode)) { $codeDescriptions[$configCode] } else { "ConfigManager error code {0}" -f $configCode }
                                $configLine = "Fan {0} configuration error code {1}: {2}" -f $name, $configCode, $configDescription
                                if ($fanLogCache.Add($configLine)) {
                                    Write-Log -Message $configLine -Issue
                                }
                            }
                        }
                        else {
                            $configLine = "Fan {0} reported configuration state: {1}" -f $name, $configText
                            if ($fanLogCache.Add($configLine)) {
                                Write-Log -Message $configLine -Issue
                            }
                        }
                    }
                }
            }

            $currentFanReadings += [pscustomobject]@{
                Name = $name
                ActualSpeed = $actualSpeedValue
                DesiredSpeed = $desiredSpeedValue
            }
        }

        $trendFile = Join-Path -Path $OutputDirectory -ChildPath 'fan_status_cache.json'
        $previousFanData = $null
        if (Test-Path -LiteralPath $trendFile) {
            try {
                $json = Get-Content -Path $trendFile -Raw -Encoding UTF8 -ErrorAction Stop
                if ($json) {
                    $previousFanData = $json | ConvertFrom-Json -ErrorAction Stop
                }
            }
            catch {
                Write-Log -Message ("Unable to read previous fan status cache: {0}" -f $_.Exception.Message)
            }
        }

        if ($previousFanData -and $previousFanData.Fans) {
            foreach ($current in $currentFanReadings) {
                $previous = $previousFanData.Fans | Where-Object { $_.Name -eq $current.Name } | Select-Object -First 1
                if (-not $previous) { continue }

                $previousSpeed = $previous.ActualSpeed
                $currentSpeed = $current.ActualSpeed

                if ($previousSpeed -ne $null -and $currentSpeed -eq $null) {
                    Write-Log -Message ("Fan trend: {0} previously reported {1} RPM but now reports no speed reading." -f $current.Name, [math]::Round($previousSpeed, 0)) -Issue
                    Add-IssueAdvice ("Fan {0} no longer reports RPM; verify chipset drivers or run vendor diagnostics." -f $current.Name)
                }
                elseif ($previousSpeed -gt 0 -and $currentSpeed -eq 0) {
                    Write-Log -Message ("Fan trend: {0} speed dropped from {1} RPM to 0 RPM since last run. Possible stall or sensor error." -f $current.Name, [math]::Round($previousSpeed, 0)) -Issue
                    Add-IssueAdvice ("Inspect fan {0} for obstruction or replace if the device continues to report 0 RPM." -f $current.Name)
                }
                elseif ($previousSpeed -gt 0 -and $currentSpeed -ne $null) {
                    $changeRatio = 0
                    if ([math]::Abs($previousSpeed) -gt 0) {
                        $changeRatio = [math]::Abs($currentSpeed - $previousSpeed) / [math]::Abs($previousSpeed)
                    }

                    if ($changeRatio -ge 0.5) {
                        Write-Log -Message ("Fan trend: {0} speed changed significantly (from {1} RPM to {2} RPM; delta {3:P0})." -f $current.Name, [math]::Round($previousSpeed, 0), [math]::Round($currentSpeed, 0), $changeRatio) -Issue
                        Add-IssueAdvice ("Large RPM swings detected for {0}; check cooling profiles or firmware updates." -f $current.Name)
                    }
                }
            }
        }
        else {
            Write-Log -Message "Fan trend baseline captured for future comparisons."
        }

        $cacheObject = @{ Timestamp = (Get-Date).ToString('o'); Fans = @() }
        foreach ($record in $currentFanReadings) {
            $cacheObject.Fans += [pscustomobject]@{
                Name = $record.Name
                ActualSpeed = $record.ActualSpeed
                DesiredSpeed = $record.DesiredSpeed
            }
        }

        try {
            $cacheJson = $cacheObject | ConvertTo-Json -Depth 3
            Set-Content -Path $trendFile -Value $cacheJson -Encoding UTF8
        }
        catch {
            Write-Log -Message ("Unable to update fan status cache: {0}" -f $_.Exception.Message)
        }
    }
    else {
        Write-Log -Message "No fans were returned by Win32_Fan."
        Add-IssueAdvice "Win32_Fan returned no data; use manufacturer diagnostics if fan telemetry is expected."
        $alternativeFanClasses = $script:sensorDiscovery.FanClasses | Where-Object { $_ -ne 'Win32_Fan' } | Sort-Object
        if ($alternativeFanClasses -and $alternativeFanClasses.Count -gt 0) {
            Write-Log -Message ("Other fan-related classes discovered: {0}" -f ($alternativeFanClasses -join ', '))
        }
        $trendFile = Join-Path -Path $OutputDirectory -ChildPath 'fan_status_cache.json'
        try {
            $cacheObject = @{ Timestamp = (Get-Date).ToString('o'); Fans = @() }
            $cacheJson = $cacheObject | ConvertTo-Json -Depth 3
            Set-Content -Path $trendFile -Value $cacheJson -Encoding UTF8
        }
        catch {
            Write-Log -Message ("Unable to update fan status cache after empty result: {0}" -f $_.Exception.Message)
        }
    }
}
catch {
    Write-Log -Message ("Unable to query fan information: {0}" -f $_.Exception.Message) -Issue
    if ($_.Exception.Message -match '(?i)access|zugriff') {
        Add-IssueAdvice "Run the diagnostics in an elevated PowerShell session to grant access to hardware sensors."
    }
}
Write-Section "Thermal Zone Status"
try {
    $thermalZones = Get-CimInstance -Namespace "root/wmi" -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction Stop
    if ($thermalZones) {
        foreach ($zone in $thermalZones) {
            $name = if ($zone.InstanceName) { $zone.InstanceName } else { "ThermalZone" }

            $currentC = $null
            if ($zone.PSObject.Properties['CurrentTemperature'] -and $zone.CurrentTemperature -ne $null) {
                try { $currentC = Convert-FromRawKelvin -Value ([double]$zone.CurrentTemperature) } catch { $currentC = $null }
            }

            $criticalC = $null
            if ($zone.PSObject.Properties['CriticalTripPoint'] -and $zone.CriticalTripPoint -ne $null) {
                try { $criticalC = Convert-FromRawKelvin -Value ([double]$zone.CriticalTripPoint) } catch { $criticalC = $null }
            }

            $passiveC = $null
            if ($zone.PSObject.Properties['PassiveTripPoint'] -and $zone.PassiveTripPoint -ne $null) {
                try { $passiveC = Convert-FromRawKelvin -Value ([double]$zone.PassiveTripPoint) } catch { $passiveC = $null }
            }

            $activeState = "Unknown"
            if ($zone.PSObject.Properties['Active']) {
                $activeState = if ($zone.Active) { "Active" } else { "Inactive" }
            }

            $line = "Thermal Zone: {0} | Temp (degC): {1} | Critical Trip (degC): {2} | Passive Trip (degC): {3} | Cooling State: {4}" -f $name, (Format-OptionalNumber $currentC), (Format-OptionalNumber $criticalC), (Format-OptionalNumber $passiveC), $activeState

            $loggedIssue = $false
            if ($criticalC -ne $null -and $currentC -ne $null -and $currentC -ge $criticalC) {
                Write-Log -Message ("Thermal zone {0} temperature {1} degC has reached or exceeded the critical trip point {2} degC." -f $name, (Format-OptionalNumber $currentC), (Format-OptionalNumber $criticalC)) -Issue
                Add-IssueAdvice ("Thermal zone {0} exceeded its critical trip point; inspect the cooling solution immediately." -f $name)
                $loggedIssue = $true
            }
            elseif ($currentC -ne $null -and $currentC -ge 90) {
                Write-Log -Message ("Thermal zone {0} temperature {1} degC exceeds the warning threshold (90 degC)." -f $name, (Format-OptionalNumber $currentC)) -Issue
                Add-IssueAdvice ("Thermal zone {0} reached 90 degC; clean air pathways or review fan profiles." -f $name)
                $loggedIssue = $true
            }

            if ($loggedIssue) {
                Write-Log -Message $line -Issue
            }
            else {
                Write-Log -Message $line
            }
        }
    }
    else {
        Write-Log -Message "No ACPI thermal zones were returned by MSAcpi_ThermalZoneTemperature."
    }
}
catch {
    Write-Log -Message ("Unable to query thermal zone information: {0}" -f $_.Exception.Message) -Issue
    if ($_.Exception.Message -match '(?i)access|zugriff') {
        Add-IssueAdvice "Run the diagnostics in an elevated PowerShell session to read ACPI thermal zone sensors."
    }
}

try {
    $thermalPerf = Get-CimInstance -ClassName Win32_PerfFormattedData_Counters_ThermalZoneInformation -ErrorAction Stop
    if ($thermalPerf) {
        foreach ($entry in $thermalPerf) {
            $tempC = $null
            if ($entry.PSObject.Properties['HighPrecisionTemperature'] -and $entry.HighPrecisionTemperature -ne $null -and $entry.HighPrecisionTemperature -gt 0) {
                $tempC = [math]::Round((($entry.HighPrecisionTemperature / 10) - 273.15), 1)
            }
            elseif ($entry.PSObject.Properties['Temperature'] -and $entry.Temperature -ne $null) {
                try { $tempC = [double]$entry.Temperature } catch { $tempC = $null }
            }

            $coolingState = "Unknown"
            if ($entry.PSObject.Properties['Active'] -and $entry.Active -ne $null) {
                $coolingState = if ($entry.Active) { "Active" } else { "Inactive" }
            }

            $tempDisplay = Format-OptionalNumber $tempC
            $infoLine = "Thermal Sensor: {0} | Temp (degC): {1} | Cooling State: {2}" -f $entry.Name, $tempDisplay, $coolingState
            if ($tempC -ne $null -and $tempC -ge 90) {
                Write-Log -Message $infoLine -Issue
                Add-IssueAdvice ("Thermal sensor {0} reported {1} degC; check for dust buildup or aggressive workloads." -f $entry.Name, $tempDisplay)
            }
            else {
                Write-Log -Message $infoLine
            }
        }
    }
    else {
        Write-Log -Message "No entries returned by Win32_PerfFormattedData_Counters_ThermalZoneInformation."
    }
}
catch {
    Write-Log -Message ("Unable to query performance counter thermal information: {0}" -f $_.Exception.Message) -Issue
}

Write-Section "Temperature Probes"
try {
    $probes = Get-CimInstance -ClassName Win32_TemperatureProbe -ErrorAction Stop
    if ($probes) {
        foreach ($probe in $probes) {
            $name = if ($probe.Name) { $probe.Name } elseif ($probe.DeviceID) { $probe.DeviceID } else { "TemperatureProbe" }
            $currentC = $null
            if ($probe.PSObject.Properties['CurrentReading'] -and $probe.CurrentReading -ne $null) {
                try { $currentC = Convert-FromRawKelvin -Value ([double]$probe.CurrentReading) } catch { $currentC = $null }
            }
            $warningC = $null
            if ($probe.PSObject.Properties['UpperThresholdNonCritical'] -and $probe.UpperThresholdNonCritical -ne $null) {
                try { $warningC = Convert-FromRawKelvin -Value ([double]$probe.UpperThresholdNonCritical) } catch { $warningC = $null }
            }
            $fatalC = $null
            if ($probe.PSObject.Properties['UpperThresholdFatal'] -and $probe.UpperThresholdFatal -ne $null) {
                try { $fatalC = Convert-FromRawKelvin -Value ([double]$probe.UpperThresholdFatal) } catch { $fatalC = $null }
            }
            $statusText = if ($probe.Status) { $probe.Status.Trim() } else { "Unknown" }

            $line = "Temperature Probe: {0} | Temp (degC): {1} | Warning Threshold (degC): {2} | Fatal Threshold (degC): {3} | Status: {4}" -f $name, (Format-OptionalNumber $currentC), (Format-OptionalNumber $warningC), (Format-OptionalNumber $fatalC), $statusText
            $logAsIssue = $false
            if ($fatalC -ne $null -and $currentC -ne $null -and $currentC -ge $fatalC) {
                Write-Log -Message ("Temperature probe {0} reached fatal threshold {1} degC." -f $name, (Format-OptionalNumber $fatalC)) -Issue
                Add-IssueAdvice ("Temperature probe {0} triggered a fatal threshold; shut down and service the hardware." -f $name)
                $logAsIssue = $true
            }
            elseif ($warningC -ne $null -and $currentC -ne $null -and $currentC -ge $warningC) {
                Write-Log -Message ("Temperature probe {0} exceeded warning threshold {1} degC." -f $name, (Format-OptionalNumber $warningC)) -Issue
                Add-IssueAdvice ("Temperature probe {0} exceeded its warning limit; verify cooling and update firmware if available." -f $name)
                $logAsIssue = $true
            }
            elseif ($statusText -match '(?i)error|degraded|fail|critical|nonrecoverable|stressed') {
                $logAsIssue = $true
            }

            if ($logAsIssue) {
                Write-Log -Message $line -Issue
            }
            else {
                Write-Log -Message $line
            }
        }
    }
    else {
        Write-Log -Message "No temperature probes were returned by Win32_TemperatureProbe."
    }
}
catch {
    Write-Log -Message ("Unable to query temperature probes: {0}" -f $_.Exception.Message) -Issue
}

Write-Section "GPU Status"
$gpuTelemetryLogged = $false
try {
    $gpuAdapters = Get-CimInstance -Namespace "root/StandardCimv2" -ClassName MSFT_GPUAdapter -ErrorAction Stop
    if ($gpuAdapters) {
        $gpuTelemetryLogged = $true
        foreach ($gpu in $gpuAdapters) {
            $name = if ($gpu.Name) { $gpu.Name } else { $gpu.InstanceName }
            $vendor = if ($gpu.VendorID) { $gpu.VendorID } else { 'Unknown' }
            $driverVersion = if ($gpu.DriverVersion) { $gpu.DriverVersion } else { 'Unknown' }

            $tempC = $null
            if ($gpu.PSObject.Properties['Temperature'] -and $gpu.Temperature -ne $null) {
                try { $tempC = [double]$gpu.Temperature } catch { $tempC = $null }
            }
            $utilization = $null
            if ($gpu.PSObject.Properties['UtilizationPercentage'] -and $gpu.UtilizationPercentage -ne $null) {
                try { $utilization = [double]$gpu.UtilizationPercentage } catch { $utilization = $null }
            }

            $line = "GPU: {0} | Vendor: {1} | Driver: {2} | Utilization (%): {3} | Temp (degC): {4}" -f $name, $vendor, $driverVersion, (Format-OptionalNumber $utilization 'N0'), (Format-OptionalNumber $tempC)
            if ($tempC -ne $null -and $tempC -ge 90) {
                Write-Log -Message $line -Issue
                Add-IssueAdvice ("GPU {0} reported {1} degC; clean the cooling solution or update the driver profile." -f $name, (Format-OptionalNumber $tempC))
            }
            else {
                Write-Log -Message $line
            }
        }
    }
}
catch {
    Write-Log -Message ("Unable to query MSFT_GPUAdapter telemetry: {0}" -f $_.Exception.Message)
}

if (-not $gpuTelemetryLogged) {
    try {
        $videoControllers = Get-CimInstance -ClassName Win32_VideoController -ErrorAction Stop
        if ($videoControllers) {
            foreach ($controller in $videoControllers) {
                $name = if ($controller.Name) { $controller.Name } else { $controller.DeviceID }
                $statusText = if ($controller.Status) { $controller.Status } else { 'Unknown' }
                $driverVersion = if ($controller.DriverVersion) { $controller.DriverVersion } else { 'Unknown' }
                $adapterRam = $null
                if ($controller.AdapterRAM -ne $null) {
                    try { $adapterRam = [double]$controller.AdapterRAM / 1MB } catch { $adapterRam = $null }
                }
                $line = "GPU (Win32_VideoController): {0} | Status: {1} | Driver: {2} | Memory (MB): {3}" -f $name, $statusText, $driverVersion, (Format-OptionalNumber $adapterRam 'N0')
                if ($statusText -match '(?i)error|degraded|fail|critical|nonrecoverable|stressed') {
                    Write-Log -Message $line -Issue
                }
                else {
                    Write-Log -Message $line
                }
            }
        }
        else {
            Write-Log -Message "No GPU adapters were returned by Win32_VideoController."
        }
    }
    catch {
        Write-Log -Message ("Unable to query fallback GPU information: {0}" -f $_.Exception.Message) -Issue
    }
}

Write-Section "Storage Extended Health"
try {
    $physicalDisks = Get-CimInstance -Namespace "root/Microsoft/Windows/Storage" -ClassName MSFT_PhysicalDisk -ErrorAction Stop
    if ($physicalDisks) {
        foreach ($disk in $physicalDisks) {
            $name = if ($disk.FriendlyName) { $disk.FriendlyName } elseif ($disk.DeviceId) { $disk.DeviceId } else { 'PhysicalDisk' }
            $mediaType = if ($disk.MediaType) { $disk.MediaType } else { 'Unknown' }
            $healthStatus = if ($disk.HealthStatus) { $disk.HealthStatus } else { 'Unknown' }
            $operational = 'Unknown'
            if ($disk.OperationalStatus) {
                $operational = ($disk.OperationalStatus | ForEach-Object { $_ }) -join '/'
            }
            $tempC = $null
            if ($disk.PSObject.Properties['Temperature'] -and $disk.Temperature -ne $null) {
                try { $tempC = [double]$disk.Temperature } catch { $tempC = $null }
            }
            $wearRemaining = $null
            if ($disk.PSObject.Properties['Wear'] -and $disk.Wear -ne $null) {
                try { $wearRemaining = [double]$disk.Wear } catch { $wearRemaining = $null }
            }
            $lifeRemaining = $null
            if ($disk.PSObject.Properties['PercentLifeRemaining'] -and $disk.PercentLifeRemaining -ne $null) {
                try { $lifeRemaining = [double]$disk.PercentLifeRemaining } catch { $lifeRemaining = $null }
            }
            $line = "Physical Disk: {0} | Media: {1} | Health: {2} | Operational: {3} | Temp (degC): {4} | Wear Remaining (%): {5} | Life Remaining (%): {6}" -f $name, $mediaType, $healthStatus, $operational, (Format-OptionalNumber $tempC), (Format-OptionalNumber $wearRemaining 'N0'), (Format-OptionalNumber $lifeRemaining 'N0')
            $logAsIssue = $false
            if ($healthStatus -match '(?i)warning|unhealthy|critical|degraded') {
                $logAsIssue = $true
            }
            if ($tempC -ne $null -and $tempC -ge 70) {
                Write-Log -Message ("Disk {0} temperature {1} degC exceeds the safe threshold (70 degC)." -f $name, (Format-OptionalNumber $tempC)) -Issue
                Add-IssueAdvice ("Disk {0} is running hot ({1} degC); improve airflow or relocate the drive." -f $name, (Format-OptionalNumber $tempC))
                $logAsIssue = $true
            }
            if ($lifeRemaining -ne $null -and $lifeRemaining -le 20) {
                Write-Log -Message ("Disk {0} reports only {1}% life remaining." -f $name, (Format-OptionalNumber $lifeRemaining 'N0')) -Issue
                Add-IssueAdvice ("Disk {0} is nearing end-of-life; schedule replacement and ensure backups." -f $name)
                $logAsIssue = $true
            }
            if ($wearRemaining -ne $null -and $wearRemaining -le 20) {
                $logAsIssue = $true
            }
            if ($logAsIssue) {
                Write-Log -Message $line -Issue
            }
            else {
                Write-Log -Message $line
            }

            if (Get-Command Get-StorageReliabilityCounter -ErrorAction SilentlyContinue) {
                try {
                    $reliabilityData = $null
                    try {
                        $physicalDiskObj = Get-PhysicalDisk -ErrorAction Stop | Where-Object { $_.UniqueId -eq $disk.UniqueId } | Select-Object -First 1
                    }
                    catch {
                        $physicalDiskObj = $null
                    }
                    if ($physicalDiskObj) {
                        $reliabilityData = $physicalDiskObj | Get-StorageReliabilityCounter -ErrorAction Stop
                    }
                    if ($reliabilityData) {
                        $reliabilityTemp = $null
                        if ($reliabilityData.PSObject.Properties['Temperature'] -and $reliabilityData.Temperature -ne $null) {
                            try { $reliabilityTemp = [double]$reliabilityData.Temperature } catch { $reliabilityTemp = $null }
                        }
                        $mediaWear = $null
                        if ($reliabilityData.PSObject.Properties['Wear'] -and $reliabilityData.Wear -ne $null) {
                            try { $mediaWear = [double]$reliabilityData.Wear } catch { $mediaWear = $null }
                        }
                        $powerOnHours = $null
                        if ($reliabilityData.PSObject.Properties['PowerOnHours'] -and $reliabilityData.PowerOnHours -ne $null) {
                            try { $powerOnHours = [double]$reliabilityData.PowerOnHours } catch { $powerOnHours = $null }
                        }
                        $lineReliability = "Reliability ({0}): Temp (degC): {1} | Wear (% used): {2} | Power-On Hours: {3}" -f $name, (Format-OptionalNumber $reliabilityTemp), (Format-OptionalNumber $mediaWear 'N0'), (Format-OptionalNumber $powerOnHours 'N0')
                        if (($reliabilityTemp -ne $null -and $reliabilityTemp -ge 70) -or ($mediaWear -ne $null -and $mediaWear -ge 80)) {
                            Write-Log -Message $lineReliability -Issue
                        }
                        else {
                            Write-Log -Message $lineReliability
                        }
                    }
                }
                catch {
                    Write-Log -Message ("Unable to query storage reliability counters for {0}: {1}" -f $name, $_.Exception.Message)
                    if ($_.Exception.Message -match '(?i)access|zugriff') {
                        Add-IssueAdvice ("Run the diagnostics in an elevated session to collect storage reliability counters for {0}." -f $name)
                    }
                }
            }
        }
    }
    else {
        Write-Log -Message "No physical disks returned from MSFT_PhysicalDisk."
    }
}
catch {
    Write-Log -Message ("Unable to query storage extended health: {0}" -f $_.Exception.Message) -Issue
}

Write-Section "Power and Voltage Status"
$powerDataFound = $false
try {
    $voltageProbes = Get-CimInstance -ClassName Win32_VoltageProbe -ErrorAction Stop
    if ($voltageProbes) {
        $powerDataFound = $true
        foreach ($probe in $voltageProbes) {
            $name = if ($probe.Name) { $probe.Name } elseif ($probe.DeviceID) { $probe.DeviceID } else { 'VoltageProbe' }
            $currentVoltage = $null
            if ($probe.PSObject.Properties['CurrentReading'] -and $probe.CurrentReading -ne $null) {
                try { $currentVoltage = [double]$probe.CurrentReading } catch { $currentVoltage = $null }
            }
            $statusText = if ($probe.Status) { $probe.Status } else { 'Unknown' }
            $line = "Voltage Probe: {0} | Voltage (volts): {1} | Status: {2}" -f $name, (Format-OptionalNumber $currentVoltage 'N1'), $statusText
            if ($probe.Status -match '(?i)error|degraded|fail|critical|nonrecoverable|stressed') {
                Write-Log -Message $line -Issue
            }
            else {
                Write-Log -Message $line
            }
        }
    }
}
catch {
    Write-Log -Message ("Unable to query voltage probes: {0}" -f $_.Exception.Message)
}

try {
    $currentProbes = Get-CimInstance -ClassName Win32_CurrentProbe -ErrorAction Stop
    if ($currentProbes) {
        $powerDataFound = $true
        foreach ($probe in $currentProbes) {
            $name = if ($probe.Name) { $probe.Name } elseif ($probe.DeviceID) { $probe.DeviceID } else { 'CurrentProbe' }
            $currentValue = $null
            if ($probe.PSObject.Properties['CurrentReading'] -and $probe.CurrentReading -ne $null) {
                try { $currentValue = [double]$probe.CurrentReading } catch { $currentValue = $null }
            }
            $statusText = if ($probe.Status) { $probe.Status } else { 'Unknown' }
            $line = "Current Probe: {0} | Current (amperes): {1} | Status: {2}" -f $name, (Format-OptionalNumber $currentValue 'N1'), $statusText
            if ($probe.Status -match '(?i)error|degraded|fail|critical|nonrecoverable|stressed') {
                Write-Log -Message $line -Issue
            }
            else {
                Write-Log -Message $line
            }
        }
    }
}
catch {
    Write-Log -Message ("Unable to query current probes: {0}" -f $_.Exception.Message)
}

try {
    $upsDevices = Get-CimInstance -ClassName Win32_UninterruptiblePowerSupply -ErrorAction Stop
    if ($upsDevices) {
        $powerDataFound = $true
        foreach ($ups in $upsDevices) {
            $statusText = if ($ups.Status) { $ups.Status } else { 'Unknown' }
            $upsName = if ($ups.Name) { $ups.Name } elseif ($ups.DeviceID) { $ups.DeviceID } else { 'UPS' }
            $line = "UPS: {0} | Availability: {1} | Remaining Capacity (%): {2} | Status: {3}" -f $upsName, (Format-OptionalNumber $ups.Availability 'N0'), (Format-OptionalNumber $ups.RemainingCapacity 'N0'), $statusText
            if ($statusText -match '(?i)error|degraded|fail|critical|nonrecoverable|stressed') {
                Write-Log -Message $line -Issue
            }
            else {
                Write-Log -Message $line
            }
        }
    }
}
catch {
    Write-Log -Message ("Unable to query UPS status: {0}" -f $_.Exception.Message)
}

try {
    $powerSupplies = Get-CimInstance -ClassName Win32_PowerSupply -ErrorAction Stop
    if ($powerSupplies) {
        $powerDataFound = $true
        foreach ($supply in $powerSupplies) {
            $statusText = if ($supply.Status) { $supply.Status } else { 'Unknown' }
            $supplyName = if ($supply.Name) { $supply.Name } elseif ($supply.DeviceID) { $supply.DeviceID } else { 'PowerSupply' }
            $line = "Power Supply: {0} | Status: {1} | Input Voltage (V): {2} | Output Voltage (V): {3}" -f $supplyName, $statusText, (Format-OptionalNumber $supply.InputVoltage 'N1'), (Format-OptionalNumber $supply.OutputVoltage 'N1')
            if ($statusText -match '(?i)error|degraded|fail|critical|nonrecoverable|stressed') {
                Write-Log -Message $line -Issue
            }
            else {
                Write-Log -Message $line
            }
        }
    }
}
catch {
    Write-Log -Message ("Unable to query power supply information: {0}" -f $_.Exception.Message)
}

if (-not $powerDataFound) {
    Write-Log -Message "No power-related sensors were reported by Win32 power probe classes."
}

Write-Section "Reliability Monitor Events"
$reliabilityStart = (Get-Date).AddDays(-$EventLogLookbackDays)
try {
    $records = Get-CimInstance -Namespace "root/cimv2" -ClassName Win32_ReliabilityRecords -ErrorAction Stop
    if ($records) {
        $validRecords = @()
        $invalidCount = 0
        foreach ($record in $records) {
            if (-not $record.TimeGenerated) { continue }
            $eventTime = $null
            try {
                $eventTime = [System.Management.ManagementDateTimeConverter]::ToDateTime($record.TimeGenerated)
            }
            catch {
                $invalidCount++
                continue
            }
            if ($eventTime -lt $reliabilityStart) { continue }
            $validRecords += [pscustomobject]@{
                Record = $record
                EventTime = $eventTime
            }
        }

        if ($invalidCount -gt 0) {
            Write-Log -Message ("Skipped {0} reliability entries with invalid timestamps." -f $invalidCount)
        }

        if ($validRecords) {
            $ordered = $validRecords | Sort-Object EventTime -Descending
            $selected = $ordered | Select-Object -First $MaxEventsPerSection
            foreach ($entry in $selected) {
                $record = $entry.Record
                $eventTimeText = $entry.EventTime.ToString('u')
                $entryType = if ($record.EntryType) { $record.EntryType } else { 'Unknown' }
                $source = if ($record.SourceName) { $record.SourceName } else { 'Unknown' }
                $eventId = if ($record.EventIdentifier -ne $null) { $record.EventIdentifier } else { 'Unknown' }
                $message = if ($record.Message) { $record.Message.Replace("`r", ' ').Replace("`n", ' ').Trim() } else { 'No message text.' }
                $line = "Reliability Event: {0} | Source: {1} | Type: {2} | Id: {3} | {4}" -f $eventTimeText, $source, $entryType, $eventId, $message
                if ($entryType -match '(?i)error|critical') {
                    Write-Log -Message $line -Issue
                }
                else {
                    Write-Log -Message $line
                }
            }

            if ($ordered.Count -gt $MaxEventsPerSection) {
                Write-Log -Message ("Reliability output truncated to {0} of {1} entries." -f $MaxEventsPerSection, $ordered.Count)
            }
        }
        else {
            Write-Log -Message ("No reliability events recorded in the last {0} day(s)." -f $EventLogLookbackDays)
        }
    }
    else {
        Write-Log -Message ("No reliability events recorded in the last {0} day(s)." -f $EventLogLookbackDays)
    }
}
catch {
    Write-Log -Message ("Unable to query reliability history: {0}" -f $_.Exception.Message)
    if ($_.Exception.Message -match '(?i)access|zugriff') {
        Add-IssueAdvice "Reliability history requires elevated rights; rerun the script as Administrator to collect these records."
    }
}

Write-Section "Battery Status"
try {
    $batteries = Get-CimInstance -ClassName Win32_Battery -ErrorAction Stop
    if ($batteries) {
        foreach ($battery in $batteries) {
            Write-Log -Message ("Name: {0} | Status: {1} | Estimated Charge Remaining: {2}% | Battery Status Code: {3}" -f $battery.Name, $battery.Status, $battery.EstimatedChargeRemaining, $battery.BatteryStatus)
            if ($battery.Status -and ($battery.Status.Trim() -match "(?i)error|degraded|fail|critical|nonrecoverable|stressed")) {
                Write-Log -Message ("Battery {0} reports status {1}" -f $battery.Name, $battery.Status) -Issue
            }
            if ($battery.BatteryStatus -in 4,10,11) {
                Write-Log -Message ("Battery {0} status code {1} indicates a degraded condition" -f $battery.Name, $battery.BatteryStatus) -Issue
            }
        }
    }
    else {
        Write-Log -Message "No batteries detected."
    }
}
catch {
    Write-Log -Message ("Unable to query battery information: {0}" -f $_.Exception.Message)
}

Write-Section "Network Adapter Status"
try {
    $networkAdapters = Get-CimInstance -ClassName Win32_NetworkAdapter -ErrorAction Stop | Where-Object { $_.PhysicalAdapter -eq $true }
    if ($networkAdapters) {
        foreach ($adapter in $networkAdapters) {
            $netStatus = if ($adapter.NetConnectionStatus -ne $null) { $adapter.NetConnectionStatus } else { -1 }
            $connectionState = switch ($netStatus) {
                0 { "Disconnected" }
                1 { "Connecting" }
                2 { "Connected" }
                3 { "Disconnecting" }
                4 { "Hardware not present" }
                5 { "Hardware disabled" }
                6 { "Hardware malfunction" }
                7 { "Media disconnected" }
                8 { "Authenticating" }
                9 { "Authentication succeeded" }
                10 { "Authentication failed" }
                11 { "Invalid address" }
                12 { "Credentials required" }
                Default { "Unknown" }
            }
            $adapterStatus = if ($adapter.Status) { $adapter.Status.Trim() } else { "" }
            $statusText = if ($adapterStatus) { $adapterStatus } else { "Unknown" }
            Write-Log -Message ("Adapter: {0} | Status: {1} | Connection: {2}" -f $adapter.Name, $statusText, $connectionState)
            if ($adapterStatus -and ($adapterStatus -match "(?i)error|degraded|fail|critical|nonrecoverable|stressed|fault")) {
                Write-Log -Message ("Adapter {0} reports status {1}" -f $adapter.Name, $statusText) -Issue
            }
            if ($netStatus -in 4,5,6,10,11) {
                Write-Log -Message ("Adapter {0} connection issue detected: {1}" -f $adapter.Name, $connectionState) -Issue
            }
        }
    }
    else {
        Write-Log -Message "No physical network adapters returned."
    }
}
catch {
    Write-Log -Message ("Unable to query network adapters: {0}" -f $_.Exception.Message) -Issue
}

Write-Section "Summary"
if ($script:issueCount -gt 0) {
    Write-Log -Message ("Detected {0} potential hardware issue(s). Review the log at {1}." -f $script:issueCount, $logFile)
}
else {
    Write-Log -Message ("No obvious hardware issues detected. Detailed log saved to {0}." -f $logFile)
}

if ($script:issueAdvices -and $script:issueAdvices.Count -gt 0) {
    Write-Log -Message "Recommended follow-up actions:"
    foreach ($advice in $script:issueAdvices) {
        Write-Log -Message ("- {0}" -f $advice)
    }
}

Write-Log -Message "Hardware diagnostics completed."

return $logFile
