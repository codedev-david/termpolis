# Fail the release when a Windows binary we are about to ship is unsigned.
#
# An unsigned Termpolis.exe is not a cosmetic downgrade. Defender's cloud ML
# calls it Trojan:Win32/Cinjo.O!cl and quarantines it, along with the Start
# menu and desktop shortcuts, the moment it is installed. v1.49.1 went out that
# way on 2026-10-01: the app vanished mid-update and its shortcut answered
# "The parameter is incorrect".
#
# This reads the signature on the file itself instead of trusting the eSigner
# action's outcome, which is only a string match over CodeSignTool's console
# output.
#
# Usage (release.yml, after each eSigner step):
#   pwsh -File scripts/verify-windows-signature.ps1 -Path <file> -Label <name>
#
# Exit 1 when the file carries no usable signature (unsigned, altered after
# signing, not a signable file). Any other non-Valid status is a warning: the
# signature is there, and only this runner's trust store can't vouch for it.

param(
    [Parameter(Mandatory = $true)][string]$Path,
    [string]$Label = ''
)

$ErrorActionPreference = 'Stop'
if (-not $Label) { $Label = Split-Path -Leaf $Path }

if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    Write-Host "::error::$Label not found at $Path, so there is nothing to verify."
    exit 1
}

# Load the cmdlet from this PowerShell's own copy of the module. Windows
# PowerShell started by a process that itself runs under PowerShell 7 (vitest
# on the CI runner) inherits 7's PSModulePath, and autoloading then fails with
# "the module could not be loaded".
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security')

$sig = Get-AuthenticodeSignature -LiteralPath $Path
$status = [string]$sig.Status
$fatal = @('NotSigned', 'HashMismatch', 'NotSupportedFileFormat')

if (($fatal -contains $status) -or ($null -eq $sig.SignerCertificate)) {
    Write-Host "::error::$Label is NOT signed (Authenticode status: $status). Shipping it would get Termpolis.exe quarantined by Defender, so this build stops here and the release stays an unpublished draft. The eSigner step above has the cause. Once it is fixed, resume with: gh run rerun <run-id> --failed"
    exit 1
}

$signer = $sig.SignerCertificate.Subject
if ($status -ne 'Valid') {
    Write-Host "::warning::$Label is signed by $signer, but this runner reports '$status': $($sig.StatusMessage)"
} else {
    Write-Host "$Label is signed by $signer."
}

if ($null -eq $sig.TimeStamperCertificate) {
    Write-Host "::warning::$Label has no timestamp, so its signature stops validating when the certificate expires."
} else {
    Write-Host "Timestamped by $($sig.TimeStamperCertificate.Subject)."
}
exit 0
