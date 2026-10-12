# Shared helper for the native-host registration scripts.
#
# Chrome derives an unpacked extension's ID from the "key" field in its
# manifest: the first 16 bytes of SHA-256(DER public key), with each nibble
# mapped to 'a'-'p'. Dot-source this file, then call Get-DerivedExtensionId.
# Returns $null when the manifest or key is missing.

function Get-DerivedExtensionId {
    param([string]$ManifestPath)

    if (-not (Test-Path $ManifestPath)) {
        return $null
    }
    $manifest = Get-Content $ManifestPath -Raw | ConvertFrom-Json
    if (-not $manifest.key) {
        return $null
    }
    $der = [Convert]::FromBase64String($manifest.key)
    $digest = [System.Security.Cryptography.SHA256]::Create().ComputeHash($der)
    $id = -join ((0..15 | ForEach-Object {
        $byte = $digest[$_]
        [char](97 + (($byte -shr 4) -band 0x0f)) + [char](97 + ($byte -band 0x0f))
    }))
    return $id
}
