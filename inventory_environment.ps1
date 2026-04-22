<#
.SYNOPSIS
    Generates an inventory of installed applications and project dependency requirements.
.DESCRIPTION
    Collects installed applications from standard Windows registry locations and AppX packages.
    Optionally scans specified project directories for common dependency manifest formats.
    Results are written to CSV files for easy review before migrating to a new system.
.PARAMETER ApplicationsOutput
    Destination file path for the installed applications CSV.
.PARAMETER ProjectRequirementsOutput
    Destination file path for the project requirements CSV.
.PARAMETER ProjectRoots
    One or more directories containing project source to scan for dependency manifests.
.EXAMPLE
    .\inventory_environment.ps1 -ProjectRoots "C:\\Code" -ApplicationsOutput "C:\\Desktop\\apps.csv"
#>
[CmdletBinding()]
param(
    [string]$ApplicationsOutput = (Join-Path -Path (Get-Location) -ChildPath 'installed_applications.csv'),
    [string]$ProjectRequirementsOutput = (Join-Path -Path (Get-Location) -ChildPath 'project_requirements.csv'),
    [string[]]$ProjectRoots = @()
)

Set-StrictMode -Version 2.0

function Ensure-Directory {
    param([string]$DirectoryPath)
    if ([string]::IsNullOrWhiteSpace($DirectoryPath) -or $DirectoryPath -eq '.') { return }
    if (-not (Test-Path -LiteralPath $DirectoryPath)) {
        New-Item -ItemType Directory -Path $DirectoryPath -Force | Out-Null
    }
}

function Get-RelativePath {
    param(
        [Parameter(Mandatory = $true)][string]$BasePath,
        [Parameter(Mandatory = $true)][string]$TargetPath
    )
    try {
        $resolvedBase = (Resolve-Path -LiteralPath $BasePath -ErrorAction Stop).ProviderPath
        if (-not $resolvedBase.EndsWith([System.IO.Path]::DirectorySeparatorChar)) {
            $resolvedBase += [System.IO.Path]::DirectorySeparatorChar
        }
        $resolvedTarget = (Resolve-Path -LiteralPath $TargetPath -ErrorAction Stop).ProviderPath
        $baseUri = [System.Uri]::new($resolvedBase)
        $targetUri = [System.Uri]::new($resolvedTarget)
        return $baseUri.MakeRelativeUri($targetUri).ToString().Replace('/', [System.IO.Path]::DirectorySeparatorChar)
    } catch {
        return $TargetPath
    }
}

function New-DependencyRecord {
    param(
        [Parameter(Mandatory = $true)][string]$ProjectRoot,
        [Parameter(Mandatory = $true)][string]$File,
        [string]$Dependency,
        [string]$Version,
        [string]$Scope,
        [string]$Notes
    )
    $resolvedRoot = $ProjectRoot
    try {
        $resolvedRoot = (Resolve-Path -LiteralPath $ProjectRoot -ErrorAction Stop).ProviderPath
    } catch { }
    $relativeFile = Get-RelativePath -BasePath $resolvedRoot -TargetPath $File
    [PSCustomObject]@{
        ProjectRoot = $resolvedRoot
        File = $relativeFile
        Dependency = $Dependency
        Version = $Version
        Scope = $Scope
        Notes = $Notes
    }
}

function Register-UnparsedDependencyFile {
    param(
        [string]$ProjectRoot,
        [System.IO.FileInfo]$File,
        [string]$Reason
    )
    New-DependencyRecord -ProjectRoot $ProjectRoot -File $File.FullName -Dependency "" -Version "" -Scope "" -Notes $Reason
}

function Parse-RequirementsFile {
    param(
        [string]$ProjectRoot,
        [System.IO.FileInfo]$File
    )
    $records = @()
    $lines = Get-Content -Path $File.FullName -ErrorAction SilentlyContinue
    foreach ($line in $lines) {
        $entry = $line.Trim()
        if (-not $entry -or $entry.StartsWith("#") -or $entry.StartsWith(";")) { continue }
        $match = [regex]::Match($entry, "^(?<name>[^#;\s]+?)\s*(?<constraint>([!=<>~].*)?)$")
        if (-not $match.Success) { continue }
        $name = $match.Groups["name"].Value.Trim()
        if (-not $name) { continue }
        $constraint = $match.Groups["constraint"].Value.Trim()
        $records += New-DependencyRecord -ProjectRoot $ProjectRoot -File $File.FullName -Dependency $name -Version $constraint -Scope "runtime" -Notes "Parsed from requirements.txt"
    }
    if (-not $records) {
        $records += New-DependencyRecord -ProjectRoot $ProjectRoot -File $File.FullName -Dependency "" -Version "" -Scope "" -Notes "requirements.txt found but no standard entries parsed"
    }
    return $records
}

function Parse-PackageJson {
    param(
        [string]$ProjectRoot,
        [System.IO.FileInfo]$File
    )
    try {
        $raw = Get-Content -Path $File.FullName -Raw -ErrorAction Stop
        $json = $raw | ConvertFrom-Json -ErrorAction Stop
    } catch {
        return Register-UnparsedDependencyFile -ProjectRoot $ProjectRoot -File $File -Reason ("package.json unreadable: {0}" -f $_.Exception.Message)
    }

    $records = @()
    $sections = @("dependencies","devDependencies","peerDependencies","optionalDependencies","bundledDependencies")
    foreach ($section in $sections) {
        $property = $json.PSObject.Properties[$section]
        if (-not $property) { continue }
        $hashtable = $property.Value
        if (-not ($hashtable -is [System.Collections.IDictionary])) { continue }
        foreach ($key in $hashtable.Keys) {
            $records += New-DependencyRecord -ProjectRoot $ProjectRoot -File $File.FullName -Dependency $key -Version $hashtable[$key] -Scope $section -Notes "Parsed from package.json"
        }
    }
    if (-not $records) {
        $records += New-DependencyRecord -ProjectRoot $ProjectRoot -File $File.FullName -Dependency "" -Version "" -Scope "" -Notes "package.json contained no dependency sections"
    }
    return $records
}

function Parse-EnvironmentYaml {
    param(
        [string]$ProjectRoot,
        [System.IO.FileInfo]$File
    )
    if (-not (Get-Command -Name ConvertFrom-Yaml -ErrorAction SilentlyContinue)) {
        return Register-UnparsedDependencyFile -ProjectRoot $ProjectRoot -File $File -Reason "ConvertFrom-Yaml not available; install PowerShell 7 or enable YAML parsing"
    }
    try {
        $raw = Get-Content -Path $File.FullName -Raw -ErrorAction Stop
        $yaml = $raw | ConvertFrom-Yaml -ErrorAction Stop
    } catch {
        return Register-UnparsedDependencyFile -ProjectRoot $ProjectRoot -File $File -Reason ("environment.yml unreadable: {0}" -f $_.Exception.Message)
    }
    $records = @()
    if ($yaml -and $yaml.dependencies) {
        foreach ($dep in $yaml.dependencies) {
            if ($dep -is [string]) {
                $records += New-DependencyRecord -ProjectRoot $ProjectRoot -File $File.FullName -Dependency $dep -Version "" -Scope "conda" -Notes "Parsed from environment.yml"
            } elseif ($dep -is [System.Collections.IDictionary]) {
                foreach ($key in $dep.Keys) {
                    if ($key -eq "pip") {
                        foreach ($pipDep in $dep[$key]) {
                            $records += New-DependencyRecord -ProjectRoot $ProjectRoot -File $File.FullName -Dependency $pipDep -Version "" -Scope "pip (environment.yml)" -Notes "Parsed from environment.yml"
                        }
                    } else {
                        $records += New-DependencyRecord -ProjectRoot $ProjectRoot -File $File.FullName -Dependency $dep[$key] -Version "" -Scope $key -Notes "Parsed from environment.yml"
                    }
                }
            }
        }
    }
    if (-not $records) {
        $records += New-DependencyRecord -ProjectRoot $ProjectRoot -File $File.FullName -Dependency "" -Version "" -Scope "" -Notes "environment.yml contained no dependencies"
    }
    return $records
}

function Parse-DotNetProjectFile {
    param(
        [string]$ProjectRoot,
        [System.IO.FileInfo]$File
    )
    try {
        $xml = [xml](Get-Content -Path $File.FullName -Raw -ErrorAction Stop)
    } catch {
        return Register-UnparsedDependencyFile -ProjectRoot $ProjectRoot -File $File -Reason ("Unable to parse {0}: {1}" -f $File.Name, $_.Exception.Message)
    }
    $records = @()
    $packageNodes = $xml.SelectNodes('//*[local-name()="PackageReference"]')
    foreach ($node in $packageNodes) {
        $name = $node.GetAttribute("Include")
        if (-not $name) { $name = $node.GetAttribute("Update") }
        if (-not $name) { continue }
        $version = $node.GetAttribute("Version")
        if (-not $version) {
            $versionNode = $node.SelectSingleNode('./*[local-name()="Version"]')
            if ($versionNode) { $version = $versionNode.InnerText }
        }
        $records += New-DependencyRecord -ProjectRoot $ProjectRoot -File $File.FullName -Dependency $name -Version $version -Scope "runtime" -Notes "Parsed from project file"
    }
    if (-not $records) {
        $records += Register-UnparsedDependencyFile -ProjectRoot $ProjectRoot -File $File -Reason "No PackageReference entries found"
    }
    return $records
}

function Get-InstalledApplications {
    [CmdletBinding()]
    param()
    $registryPaths = @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )

    $regEntries = foreach ($path in $registryPaths) {
        Get-ItemProperty -Path $path -ErrorAction SilentlyContinue | Where-Object {
            $nameProp = $_.PSObject.Properties['DisplayName']
            if (-not $nameProp) { return $false }
            $nameValue = $nameProp.Value
            if (-not $nameValue) { return $false }
            return ($nameValue.ToString().Trim().Length -gt 0)
        }
    }

    $regApps = foreach ($entry in $regEntries) {
        $getValue = {
            param($object, $propertyName)
            $prop = $object.PSObject.Properties[$propertyName]
            if ($prop) { return $prop.Value }
            return $null
        }
        $name = & $getValue $entry 'DisplayName'
        if (-not $name) { continue }
        $version = & $getValue $entry 'DisplayVersion'
        $publisher = & $getValue $entry 'Publisher'
        $installDate = & $getValue $entry 'InstallDate'
        $installLocation = & $getValue $entry 'InstallLocation'
        $uninstallString = & $getValue $entry 'UninstallString'
        $source = if ($entry.PSPath -like '*WOW6432Node*') {
            'Registry (32-bit)'
        } elseif ($entry.PSPath -like '*HKEY_LOCAL_MACHINE*') {
            'Registry (64-bit)'
        } else {
            'Registry (Current User)'
        }

        [PSCustomObject]@{
            Name = $name
            Version = $version
            Publisher = $publisher
            InstallDateRaw = $installDate
            Source = $source
            InstallLocation = $installLocation
            UninstallString = $uninstallString
        }
    }

    $appxApps = @()
    try {
        $appxApps = Get-AppxPackage -ErrorAction Stop | ForEach-Object {
            $installDate = $null
            $installDateProp = $_.PSObject.Properties['InstallDate']
            if ($installDateProp) { $installDate = $installDateProp.Value }
            [PSCustomObject]@{
                Name = $_.Name
                Version = $_.Version.ToString()
                Publisher = $_.Publisher
                InstallDateRaw = $installDate
                Source = 'Microsoft Store (AppX)'
                InstallLocation = $_.InstallLocation
                UninstallString = ''
            }
        }
    } catch {
        Write-Warning ("Get-AppxPackage failed: {0}" -f $_.Exception.Message)
    }

    $combined = ($regApps + $appxApps) | Where-Object { $_ -and $_.Name }
    $deduped = $combined | Group-Object Name, Version, Source | ForEach-Object { $_.Group | Select-Object -First 1 }
    return $deduped | Sort-Object Name, Version
}

function Get-ProjectDependencyRecords {
    [CmdletBinding()]
    param([string]$Root)

    try {
        $resolvedRoot = (Resolve-Path -LiteralPath $Root -ErrorAction Stop).ProviderPath
    } catch {
        Write-Warning ("Project root not found: {0}" -f $Root)
        return @()
    }

    $records = @()
    $files = Get-ChildItem -Path $resolvedRoot -Recurse -File -ErrorAction SilentlyContinue
    foreach ($file in $files) {
        $lowerName = $file.Name.ToLowerInvariant()
        switch ($lowerName) {
            'requirements.txt' { $records += Parse-RequirementsFile -ProjectRoot $resolvedRoot -File $file; continue }
            'package.json' { $records += Parse-PackageJson -ProjectRoot $resolvedRoot -File $file; continue }
            'environment.yml' { $records += Parse-EnvironmentYaml -ProjectRoot $resolvedRoot -File $file; continue }
            'environment.yaml' { $records += Parse-EnvironmentYaml -ProjectRoot $resolvedRoot -File $file; continue }
        }
        if ($file.Extension -in @('.csproj','.vbproj','.fsproj')) {
            $records += Parse-DotNetProjectFile -ProjectRoot $resolvedRoot -File $file
            continue
        }
        if ($file.Name -in @('package-lock.json','yarn.lock','Pipfile','pyproject.toml','Cargo.toml','go.mod','Gemfile','composer.json','build.gradle','build.gradle.kts')) {
            $records += Register-UnparsedDependencyFile -ProjectRoot $resolvedRoot -File $file -Reason ("Support not implemented for {0}; review manually" -f $file.Name)
        }
    }
    return $records
}

$installedApplications = Get-InstalledApplications
Ensure-Directory -DirectoryPath (Split-Path -Path $ApplicationsOutput -Parent)
try {
    $installedApplications | Sort-Object Name | Export-Csv -Path $ApplicationsOutput -NoTypeInformation -Encoding UTF8 -Force
    Write-Host "Installed applications saved to: $ApplicationsOutput"
} catch {
    Write-Warning ("Failed to write installed applications CSV: {0}" -f $_.Exception.Message)
}

$dependencyRecords = @()
if ($ProjectRoots -and $ProjectRoots.Count -gt 0) {
    foreach ($root in $ProjectRoots) {
        Write-Host "Scanning project root: $root"
        $dependencyRecords += Get-ProjectDependencyRecords -Root $root
    }
    Ensure-Directory -DirectoryPath (Split-Path -Path $ProjectRequirementsOutput -Parent)
    try {
        $dependencyRecords | Export-Csv -Path $ProjectRequirementsOutput -NoTypeInformation -Encoding UTF8 -Force
        Write-Host "Project requirement records saved to: $ProjectRequirementsOutput"
    } catch {
        Write-Warning ("Failed to write project requirements CSV: {0}" -f $_.Exception.Message)
    }
} else {
    Write-Host "No project roots supplied. Skipping project dependency collection."
    if (-not (Test-Path -LiteralPath $ProjectRequirementsOutput)) {
        Ensure-Directory -DirectoryPath (Split-Path -Path $ProjectRequirementsOutput -Parent)
        try {
            @() | Export-Csv -Path $ProjectRequirementsOutput -NoTypeInformation -Encoding UTF8 -Force
        } catch {
            Write-Warning ("Failed to create empty project requirements CSV: {0}" -f $_.Exception.Message)
        }
    }
}

Write-Host "Inventory complete."
