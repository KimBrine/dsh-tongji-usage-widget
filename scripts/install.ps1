<#
.SYNOPSIS
Installs the Tongji points widget into DSH Web, or prints desktop installation instructions.
.EXAMPLE
pwsh -File .\scripts\install.ps1 -Profile web -WhatIf
.EXAMPLE
pwsh -File .\scripts\install.ps1 -Profile web
.EXAMPLE
pwsh -File .\scripts\install.ps1 -Profile desktop
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Low')]
param(
    [ValidateSet('desktop', 'web')][string]$Profile = 'desktop',
    [string]$DshCliPath,
    [string]$NodePath,
    [Alias('h')][switch]$Help
)
$ErrorActionPreference = 'Stop'
if ($Help) {
    Write-Host 'Usage: install.ps1 [-Profile desktop|web] [-DshCliPath <absolute bin.js>] [-NodePath <absolute node.exe>] [-WhatIf]'
    Write-Host 'Default: desktop instructions only. Web installs a local link through the official DSH CLI.'
    Write-Host 'No access_token is read or passed by this installer. Keep the linked plugin directory in place.'
    exit 0
}
. (Join-Path $PSScriptRoot 'dsh-common.ps1')
try {
    $package = Get-WidgetPackage
    if ($Profile -eq 'desktop') { Write-DesktopAction 'install' $package; exit 0 }
    $profilePackage = Get-DshWebPackage
    $existing = Get-WidgetDependency $profilePackage $package.Name
    if ($existing) {
        if (-not (Test-SameWidgetLink $existing $package.Root)) {
            throw 'This bundle name is already installed from another source. Keep the current installation and review a source migration before replacing it.'
        }
        if (Test-WidgetEnabled $profilePackage $package.Name) {
            Write-Host "Already installed and enabled from this directory: $($package.Name)"
            Write-Host 'Restart DSH Web after backend source changes; refresh the page after frontend changes.'
            exit 0
        }
        throw "The package is already linked but disabled. Use plugin_manager set_bundle with target '$($package.Name)' and enabled true in the web profile."
    }
    $command = Get-DshNodeCommand $DshCliPath $NodePath
    $spec = "link:$($package.Root)"
    if ($PSCmdlet.ShouldProcess("DSH web profile: $($package.Name)", "Install local bundle $spec using the official DSH CLI")) {
        $nodeArguments = @($command.Cli, 'plugin', '--profile', 'web', 'add', $spec)
        & $command.Node @nodeArguments
        if ($LASTEXITCODE -ne 0) { throw "The DSH installer exited with code $LASTEXITCODE. Review its diagnostics before retrying." }
        $installedPackage = Get-DshWebPackage
        if (-not (Test-SameWidgetLink (Get-WidgetDependency $installedPackage $package.Name) $package.Root) -or -not (Test-WidgetEnabled $installedPackage $package.Name)) {
            throw 'The CLI completed, but the expected local link and enabled bundle were not both found. Review the web profile through plugin_manager.'
        }
        Write-Host "Installed and enabled: $($package.Name)"
        Write-Host 'Restart DSH Web, then refresh the browser. Import the token locally with node scripts/auth.mjs set-token if needed.'
    }
} catch { Write-Error $_.Exception.Message; exit 1 }
