<#
.SYNOPSIS
  Update Termpolis over a running copy the way the in-app updater does, and check what the
  installer did. CI only: it switches on process-creation auditing and installs software.

.DESCRIPTION
  Installs Termpolis from -Installer (unless it is installed already), starts it, starts a second
  process running as Node from the same Termpolis.exe (how Termpolis runs its MCP adapter when there
  is no Node), then runs the installer again with /S --updated, as electron-updater does. Fails if:
    - the update does not exit 0, or Termpolis.exe is missing afterwards;
    - either running process is still running afterwards;
    - anything the installer started, directly or through the uninstaller it runs, was PowerShell,
      tasklist or wmic. build/installer.nsh closes the app without listing processes; on a monitored
      work computer a process query started under Termpolis.exe reads as discovery.
  Process-creation auditing (event 4688) lists what the installer started, so this needs an
  administrator, which a GitHub runner is.

.PARAMETER Installer
  The Termpolis setup .exe to install and update with.
.PARAMETER UserDataDir
  A throwaway profile folder for the running app.
.PARAMETER Out
  Where to write the result as JSON (optional).
#>
param(
  [Parameter(Mandatory)][string]$Installer,
  [Parameter(Mandatory)][string]$UserDataDir,
  [string]$Out
)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') {
  throw 'test-installer-update.ps1 runs only on a CI runner: it switches on process auditing and installs software.'
}

$Installer = (Resolve-Path $Installer).Path
$exe = Join-Path $env:LOCALAPPDATA 'Programs\termpolis\Termpolis.exe'
$result = [ordered]@{ installer = $Installer; failures = @() }
function Add-Failure([string]$why) { $script:result.failures += $why }

function Save-Result {
  $json = $script:result | ConvertTo-Json -Depth 4
  if ($Out) { $json | Set-Content -Encoding utf8 $Out }
  $json
}

# Process creation (by subcategory GUID, so the runner's display language doesn't matter), with
# command lines.
auditpol /set /subcategory:'{0CCE922B-69AE-11D9-BED3-505054503030}' /success:enable | Out-Null
if ($LASTEXITCODE -ne 0) { throw "auditpol failed ($LASTEXITCODE)" }
$auditKey = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Policies\System\Audit'
if (-not (Test-Path $auditKey)) { New-Item -Path $auditKey | Out-Null }
New-ItemProperty -Path $auditKey -Name ProcessCreationIncludeCmdLine_Enabled -Value 1 -PropertyType DWord -Force | Out-Null

if (-not (Test-Path $exe)) {
  $first = Start-Process -FilePath $Installer -ArgumentList '/S' -PassThru -Wait
  $result.installExit = $first.ExitCode
  if ($first.ExitCode -ne 0) { Add-Failure "the first install exited $($first.ExitCode)" }
}
if (-not (Test-Path $exe)) {
  Add-Failure "Termpolis.exe is not installed at $exe"
  Save-Result
  exit 1
}

# What runs from Termpolis.exe when the update comes.
$app = Start-Process -FilePath $exe -ArgumentList "--user-data-dir=`"$UserDataDir`"" -PassThru
$env:ELECTRON_RUN_AS_NODE = '1'
$helper = Start-Process -FilePath $exe -ArgumentList '-e', 'setTimeout(()=>{},600000)' -PassThru
Remove-Item Env:ELECTRON_RUN_AS_NODE
Start-Sleep -Seconds 20
$result.appRunningBefore = -not $app.HasExited
$result.helperRunningBefore = -not $helper.HasExited
if ($app.HasExited) { Add-Failure "the app exited by itself before the update (exit $($app.ExitCode))" }
if ($helper.HasExited) { Add-Failure "the Node-mode helper exited by itself before the update (exit $($helper.ExitCode))" }

$since = (Get-Date).AddSeconds(-1)
$update = Start-Process -FilePath $Installer -ArgumentList '/S', '--updated' -PassThru -Wait
$result.updateExit = $update.ExitCode
$result.updateSeconds = [int]((Get-Date) - $since).TotalSeconds
if ($update.ExitCode -ne 0) { Add-Failure "the update exited $($update.ExitCode)" }
Start-Sleep -Seconds 2
$result.appClosed = $app.HasExited
$result.helperClosed = $helper.HasExited
if (-not $app.HasExited) { Add-Failure 'the update left the running app open' }
if (-not $helper.HasExited) { Add-Failure 'the update left the Node-mode helper running' }
if (-not (Test-Path $exe)) { Add-Failure 'Termpolis.exe is missing after the update' }

# Everything the installer started, and everything those started, in the order it happened.
$created = @(
  Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = 4688; StartTime = $since } -ErrorAction SilentlyContinue |
    Sort-Object TimeCreated |
    ForEach-Object {
      $data = @{}
      foreach ($d in ([xml]$_.ToXml()).Event.EventData.Data) { $data[$d.Name] = $d.'#text' }
      [pscustomobject]@{
        Id = [Convert]::ToInt64($data.NewProcessId, 16)
        ParentId = [Convert]::ToInt64($data.ProcessId, 16)
        Exe = $data.NewProcessName
        CommandLine = $data.CommandLine
      }
    }
)
$tree = [System.Collections.Generic.HashSet[long]]::new()
[void]$tree.Add([long]$update.Id)
$installerSeen = $false
$started = foreach ($p in $created) {
  if ($p.Id -eq $update.Id) { $installerSeen = $true; continue }
  if ($tree.Contains($p.ParentId)) {
    [void]$tree.Add($p.Id)
    $p
  }
}
$result.auditSawInstaller = $installerSeen
$result.startedByInstaller = @($started | ForEach-Object { "$($_.Exe) :: $($_.CommandLine)" })
if (-not $installerSeen) { Add-Failure 'process auditing did not record the installer, so what it started cannot be checked' }
$queries = @($started | Where-Object { $_.Exe -match '\\(powershell|pwsh|tasklist|wmic)\.exe$' })
if ($queries) {
  Add-Failure ('the installer ran a process query: ' + (($queries | ForEach-Object { "$($_.Exe) $($_.CommandLine)" }) -join ' | '))
}

foreach ($p in @($app, $helper)) { if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } }

Save-Result
if ($result.failures.Count -gt 0) { exit 1 }
