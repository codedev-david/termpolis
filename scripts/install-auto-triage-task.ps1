# Registers a Windows Scheduled Task that runs auto-triage.ps1 every 30
# minutes, even when Termpolis / Claude Code is not open. Idempotent: safe
# to re-run; it will just overwrite the existing task definition.
#
# Run from an elevated PowerShell prompt:
#     powershell -ExecutionPolicy Bypass -File scripts\install-auto-triage-task.ps1
#
# To remove later:
#     Unregister-ScheduledTask -TaskName "Termpolis Auto-Triage" -Confirm:$false

$ErrorActionPreference = 'Stop'

$RepoRoot   = Split-Path -Parent $PSScriptRoot
$ScriptPath = Join-Path $RepoRoot 'scripts\auto-triage.ps1'
$TaskName   = "Termpolis Auto-Triage"

if (-not (Test-Path $ScriptPath)) {
    Write-Error "auto-triage.ps1 not found at $ScriptPath"
    exit 1
}

# Run powershell.exe with bypass policy, no logo/profile, pointing at the
# script. Use the absolute path - Task Scheduler doesn't reliably resolve
# bare "powershell.exe" via PATH under all logon contexts (we saw it return
# 0x80070002 file-not-found despite powershell.exe being on the user PATH).
$action = New-ScheduledTaskAction `
    -Execute (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') `
    -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$ScriptPath`""

# Every 30 minutes, indefinitely, starting now. Also runs once at user logon
# so the user gets a fresh scan when they sit down.
$triggerInterval = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
    -RepetitionInterval (New-TimeSpan -Minutes 30)
$triggerLogon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

# Only run when network is available; don't run on battery to avoid laptop
# cook-time; allow it to skip if the previous run is still going.
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -DontStopIfGoingOnBatteries:$false `
    -AllowStartIfOnBatteries:$false `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
    -MultipleInstances IgnoreNew

# Run as the current user, with their stored credentials, only when logged in.
# (Running as SYSTEM would lose access to the user's gh auth token.)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed existing task '$TaskName'"
}

Register-ScheduledTask `
    -TaskName $TaskName `
    -Description "Auto-triages new GitHub bug issues for Termpolis: opens a draft PR with a candidate fix every 30 min." `
    -Action $action `
    -Trigger @($triggerInterval, $triggerLogon) `
    -Settings $settings `
    -Principal $principal | Out-Null

Write-Host "Registered scheduled task '$TaskName'."
Write-Host "Logs: $env:LOCALAPPDATA\termpolis\auto-triage\"
Write-Host "Trigger now (smoke test): Start-ScheduledTask -TaskName '$TaskName'"
