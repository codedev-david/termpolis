$ErrorActionPreference = 'Stop'

$packageArgs = @{
  packageName    = 'termpolis'
  softwareName   = 'Termpolis*'
  fileType       = 'exe'
  silentArgs     = '/S'
  validExitCodes = @(0)
}

[array]$key = Get-UninstallRegistryKey -SoftwareName $packageArgs['softwareName']

if ($key.Count -eq 1) {
  $key | ForEach-Object {
    $packageArgs['file'] = "$($_.UninstallString)"
    Uninstall-ChocolateyPackage @packageArgs
  }
} elseif ($key.Count -eq 0) {
  Write-Warning "Termpolis not found in Programs and Features."
} elseif ($key.Count -gt 1) {
  Write-Warning "Multiple matches found. Manual uninstall may be required."
  $key | ForEach-Object { Write-Warning "- $($_.DisplayName)" }
}
