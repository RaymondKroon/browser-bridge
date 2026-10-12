param(
    [string]$ExtensionId,

    [ValidateSet("Chrome", "Edge", "Both")]
    [string]$Browser = "Both"
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$manifestDir = Join-Path $env:LOCALAPPDATA "BrowserBridge"
$manifestPath = Join-Path $manifestDir "com.browser_bridge.json"
$launcherPath = Join-Path $repoRoot "native-host\launch-host.cmd"

if (-not (Test-Path $launcherPath)) {
    throw "Native host launcher not found at $launcherPath"
}

. (Join-Path $PSScriptRoot "Get-ExtensionId.ps1")

$derivedId = Get-DerivedExtensionId -ManifestPath (Join-Path $repoRoot "extension\manifest.json")

if ($ExtensionId) {
    if ($ExtensionId -notmatch "^[a-p]{32}$") {
        throw "Extension IDs should be 32 lowercase characters in the a-p range."
    }
    if ($derivedId -and $derivedId -ne $ExtensionId) {
        throw "Extension ID mismatch: -ExtensionId is $ExtensionId, but extension\manifest.json derives to $derivedId. Check that you are registering the right extension."
    }
}
elseif ($derivedId) {
    $ExtensionId = $derivedId
    Write-Output "Derived extension ID from manifest key: $ExtensionId"
}
else {
    throw "extension\manifest.json has no stable 'key' field; -ExtensionId is required."
}

New-Item -ItemType Directory -Force -Path $manifestDir | Out-Null

$manifest = [ordered]@{
    name = "com.browser_bridge"
    description = "Browser Bridge Native Messaging Host"
    path = $launcherPath
    type = "stdio"
    allowed_origins = @("chrome-extension://$ExtensionId/")
}

$manifest | ConvertTo-Json -Depth 4 | Set-Content -Encoding ASCII -Path $manifestPath

$registrations = @()
switch ($Browser) {
    "Chrome" { $registrations += "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.browser_bridge" }
    "Edge" { $registrations += "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.browser_bridge" }
    "Both" {
        $registrations += "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.browser_bridge"
        $registrations += "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.browser_bridge"
    }
}

foreach ($registryPath in $registrations) {
    New-Item -Path $registryPath -Force | Out-Null
    New-ItemProperty -Path $registryPath -Name "(default)" -Value $manifestPath -PropertyType String -Force | Out-Null
}

Write-Output "Registered native host manifest at $manifestPath"
