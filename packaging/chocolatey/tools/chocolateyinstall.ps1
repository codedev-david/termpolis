$ErrorActionPreference = 'Stop'

$packageArgs = @{
  packageName    = 'termpolis'
  fileType       = 'exe'
  url64bit       = 'https://github.com/codedev-david/termpolis/releases/download/v1.4.1/Termpolis.Setup.1.4.1.exe'
  silentArgs     = '/S'
  validExitCodes = @(0)
  softwareName   = 'Termpolis*'
  checksumType64 = 'sha256'
  checksum64     = 'REPLACE_WITH_SHA256'
}

Install-ChocolateyPackage @packageArgs
