param(
    [ValidateSet("Chrome", "Edge", "Both")]
    [string]$Browser = "Both"
)

$ErrorActionPreference = "Stop"

$manifestPath = Join-Path (Join-Path $env:LOCALAPPDATA "BrowserBridge") "com.browser_bridge.json"
$registrations = @()
$otherRegistrations = @()

switch ($Browser) {
    "Chrome" {
        $registrations += "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.browser_bridge"
        $otherRegistrations += "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.browser_bridge"
    }
    "Edge" {
        $registrations += "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.browser_bridge"
        $otherRegistrations += "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.browser_bridge"
    }
    "Both" {
        $registrations += "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.browser_bridge"
        $registrations += "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.browser_bridge"
    }
}

foreach ($registryPath in $registrations) {
    if (Test-Path $registryPath) {
        Remove-Item -Path $registryPath -Recurse -Force
    }
}

$manifestStillReferenced = $false
foreach ($registryPath in $otherRegistrations) {
    if (-not (Test-Path $registryPath)) {
        continue
    }

    $defaultValue = (Get-Item -Path $registryPath).GetValue("")
    if ($defaultValue -eq $manifestPath) {
        $manifestStillReferenced = $true
        break
    }
}

if (-not $manifestStillReferenced -and (Test-Path $manifestPath)) {
    Remove-Item -Path $manifestPath -Force
}

Write-Output "Unregistered native host for $Browser"
