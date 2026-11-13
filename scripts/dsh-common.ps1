Set-StrictMode -Version Latest

function Get-WidgetPackage {
    $root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    $manifestPath = Join-Path $root 'package.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "Plugin manifest not found: $manifestPath"
    }
    try { $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json }
    catch { throw 'The plugin package.json is not valid JSON.' }
    $nameProperty = $manifest.PSObject.Properties['name']
    $mainProperty = $manifest.PSObject.Properties['main']
    $dshProperty = $manifest.PSObject.Properties['dsh']
    if (-not $nameProperty -or [string]$nameProperty.Value -notmatch '^(?:@[a-z0-9][a-z0-9._~-]*/)?[a-z0-9][a-z0-9._~-]*$') {
        throw 'The plugin package name is missing or invalid.'
    }
    if (-not $mainProperty -or -not $dshProperty) { throw 'The manifest must declare main and dsh.bundle.patch.' }
    try { $patch = [string]$manifest.dsh.bundle.patch }
    catch { throw 'The manifest must declare dsh.bundle.patch.' }
    foreach ($relative in @([string]$mainProperty.Value, $patch)) {
        if ([string]::IsNullOrWhiteSpace($relative) -or [IO.Path]::IsPathRooted($relative)) { throw 'Plugin entry paths must be package-relative.' }
        $entry = [IO.Path]::GetFullPath((Join-Path $root $relative))
        if (-not $entry.StartsWith($root.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'A plugin entry path points outside the package.'
        }
        if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) { throw "Plugin entry file not found: $entry" }
    }
    return [pscustomobject]@{ Root = $root; Name = [string]$nameProperty.Value }
}

function Get-DshHomePath {
    $candidate = $env:DSH_HOME
    if ([string]::IsNullOrWhiteSpace($candidate)) { $candidate = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.dsh' }
    if (-not [IO.Path]::IsPathRooted($candidate)) { throw 'DSH_HOME must be an absolute filesystem path.' }
    return [IO.Path]::GetFullPath($candidate)
}

function Get-DshWebPackage {
    $manifestPath = Join-Path (Get-DshHomePath) 'profiles\web\package.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { return $null }
    try { return Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json }
    catch { throw 'The web profile package.json could not be parsed. No profile changes were made.' }
}

function Get-WidgetDependency($Manifest, [string]$Name) {
    if (-not $Manifest) { return $null }
    foreach ($section in @('dependencies', 'devDependencies', 'optionalDependencies')) {
        $sectionProperty = $Manifest.PSObject.Properties[$section]
        if ($sectionProperty -and $sectionProperty.Value) {
            $dependency = $sectionProperty.Value.PSObject.Properties[$Name]
            if ($dependency) { return [string]$dependency.Value }
        }
    }
    return $null
}

function Test-WidgetEnabled($Manifest, [string]$Name) {
    if (-not $Manifest) { return $false }
    try { return @($Manifest.dsh.profile.bundles) -contains $Name }
    catch { return $false }
}

function Test-SameWidgetLink([string]$Spec, [string]$PackageRoot) {
    if (-not $Spec -or -not $Spec.StartsWith('link:')) { return $false }
    $source = $Spec.Substring(5)
    if (-not [IO.Path]::IsPathRooted($source)) {
        $source = Join-Path (Join-Path (Get-DshHomePath) 'profiles\web') $source
    }
    try { return [IO.Path]::GetFullPath($source).TrimEnd('\', '/') -eq $PackageRoot.TrimEnd('\', '/') }
    catch { return $false }
}

function Get-DshNodeCommand([string]$DshCliPath, [string]$NodePath) {
    if ([string]::IsNullOrWhiteSpace($NodePath)) {
        $nodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $nodeCommand) { throw 'Node.js was not found on PATH. Install Node.js or pass -NodePath.' }
        $NodePath = $nodeCommand.Source
    }
    if (-not [IO.Path]::IsPathRooted($NodePath) -or -not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
        throw 'NodePath must identify an existing node executable using an absolute path.'
    }
    if ([string]::IsNullOrWhiteSpace($DshCliPath)) {
        $candidates = @((Join-Path (Get-DshHomePath) 'profiles\node_modules\@deepseek-ai\dsh\lib\bin.js'))
        if ($env:APPDATA) { $candidates += Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\lib\bin.js' }
        foreach ($candidate in $candidates) {
            if (Test-Path -LiteralPath $candidate -PathType Leaf) { $DshCliPath = $candidate; break }
        }
    }
    if ([string]::IsNullOrWhiteSpace($DshCliPath) -or -not [IO.Path]::IsPathRooted($DshCliPath) -or -not (Test-Path -LiteralPath $DshCliPath -PathType Leaf)) {
        throw 'DSH CLI not found. Pass -DshCliPath with the absolute path to @deepseek-ai/dsh/lib/bin.js.'
    }
    return [pscustomobject]@{ Node = [IO.Path]::GetFullPath($NodePath); Cli = [IO.Path]::GetFullPath($DshCliPath) }
}

function Write-DesktopAction([string]$Action, $Package) {
    Write-Host 'The official Electron application manages the desktop profile.'
    Write-Host 'Open a DSH desktop chat and ask its built-in plugin_manager to list bundles first:'
    Write-Host '{"action":"list_bundles","limit":100}'
    if ($Action -eq 'install') {
        Write-Host 'If the package is not installed, request:'
        Write-Host (@{ action = 'install_bundle'; target = "link:$($Package.Root)"; enabled = $true } | ConvertTo-Json -Compress)
        Write-Host 'If already installed from this path, keep the source and enable it with set_bundle if needed.'
    } else {
        Write-Host 'After verifying the exact installed bundle name, request:'
        Write-Host (@{ action = 'remove_bundle'; target = $Package.Name } | ConvertTo-Json -Compress)
    }
    Write-Host 'Report the actual result. Fully exit and reopen DSH if restart is required or the widget does not appear.'
    Write-Host 'No desktop profile files were changed by this script.'
}
