param(
    [Parameter(Mandatory = $true)]
    [string]$ExtensionId,

    [ValidateSet("Chrome", "Edge", "Both")]
    [string]$Browser = "Both"
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$manifestDir = Join-Path $env:LOCALAPPDATA "CDTBridge"
$manifestPath = Join-Path $manifestDir "com.cdt_bridge.json"
$launcherPath = Join-Path $repoRoot "native-host\launch-host.cmd"

if (-not (Test-Path $launcherPath)) {
    throw "Native host launcher not found at $launcherPath"
}

New-Item -ItemType Directory -Force -Path $manifestDir | Out-Null

$manifest = [ordered]@{
    name = "com.cdt_bridge"
    description = "CDT Bridge Native Messaging Host"
    path = $launcherPath
    type = "stdio"
    allowed_origins = @("chrome-extension://$ExtensionId/")
}

$manifest | ConvertTo-Json -Depth 4 | Set-Content -Encoding ASCII -Path $manifestPath

$registrations = @()
switch ($Browser) {
    "Chrome" { $registrations += "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.cdt_bridge" }
    "Edge" { $registrations += "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.cdt_bridge" }
    "Both" {
        $registrations += "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.cdt_bridge"
        $registrations += "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.cdt_bridge"
    }
}

foreach ($registryPath in $registrations) {
    New-Item -Path $registryPath -Force | Out-Null
    New-ItemProperty -Path $registryPath -Name "(default)" -Value $manifestPath -PropertyType String -Force | Out-Null
}

Write-Output "Registered native host manifest at $manifestPath"
