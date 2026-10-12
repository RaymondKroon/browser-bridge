param(
    [ValidateSet("Chrome", "Edge", "Both")]
    [string]$Browser = "Both",

    [ValidateRange(1024, 65535)]
    [int]$DevelopmentReloadPort = 9230
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $repoRoot "extension\manifest.json"
$configPath = Join-Path $repoRoot "native-host\development-reload.config.json"

. (Join-Path $PSScriptRoot "Get-ExtensionId.ps1")

$manifest = Get-Content -Raw -Path $manifestPath | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace($manifest.key)) {
    throw "extension/manifest.json does not contain the development public key"
}

$extensionId = Get-DerivedExtensionId -ManifestPath $manifestPath

& (Join-Path $PSScriptRoot "register-native-host.ps1") -ExtensionId $extensionId -Browser $Browser

if (-not (Test-Path $configPath)) {
    [ordered]@{
        port = $DevelopmentReloadPort
        requireToken = $false
    } | ConvertTo-Json | Set-Content -Encoding ASCII -Path $configPath
    Write-Output "Created local unauthenticated development reload configuration: $configPath"
} else {
    Write-Output "Using existing local development reload configuration: $configPath"
}

Write-Output "Browser Bridge development extension ID: $extensionId"
Write-Output "Load or reload this unpacked extension in chrome://extensions:"
Write-Output "  $(Join-Path $repoRoot 'extension')"
