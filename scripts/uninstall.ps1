<#
.SYNOPSIS
Removes this bundle from DSH Web, or prints desktop removal instructions.
.EXAMPLE
pwsh -File .\scripts\uninstall.ps1 -Profile web -WhatIf
.EXAMPLE
pwsh -File .\scripts\uninstall.ps1 -Profile desktop
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
    Write-Host 'Usage: uninstall.ps1 [-Profile desktop|web] [-DshCliPath <absolute bin.js>] [-NodePath <absolute node.exe>] [-WhatIf]'
    Write-Host 'Default: desktop instructions only. Web removes this bundle through the official DSH CLI.'
    Write-Host 'Plugin source files, saved token, and settings are retained.'
    exit 0
}
. (Join-Path $PSScriptRoot 'dsh-common.ps1')
try {
    $package = Get-WidgetPackage
    if ($Profile -eq 'desktop') { Write-DesktopAction 'uninstall' $package; exit 0 }
    $profilePackage = Get-DshWebPackage
    $existing = Get-WidgetDependency $profilePackage $package.Name
    $enabled = Test-WidgetEnabled $profilePackage $package.Name
    if (-not $existing -and -not $enabled) {
        Write-Host "Already absent from the web profile: $($package.Name)"
        exit 0
    }
    if (-not $existing -or -not (Test-SameWidgetLink $existing $package.Root)) {
        throw 'The web profile does not contain the local link owned by this directory. Review the exact installed bundle and source in plugin_manager before removing it.'
    }
    $command = Get-DshNodeCommand $DshCliPath $NodePath
    if ($PSCmdlet.ShouldProcess("DSH web profile: $($package.Name)", 'Remove the local bundle using the official DSH CLI')) {
        $nodeArguments = @($command.Cli, 'plugin', '--profile', 'web', 'remove', $package.Name)
        & $command.Node @nodeArguments
        if ($LASTEXITCODE -ne 0) { throw "The DSH uninstaller exited with code $LASTEXITCODE. Review its diagnostics before retrying." }
        $remaining = Get-DshWebPackage
        if ((Get-WidgetDependency $remaining $package.Name) -or (Test-WidgetEnabled $remaining $package.Name)) {
            throw 'The CLI completed, but the bundle is still declared. Review the web profile through plugin_manager.'
        }
        Write-Host "Removed from the web profile: $($package.Name)"
        Write-Host 'Restart DSH Web and refresh the page. Plugin source files, saved token, and settings were retained.'
    }
} catch { Write-Error $_.Exception.Message; exit 1 }
