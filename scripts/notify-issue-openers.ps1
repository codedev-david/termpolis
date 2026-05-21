# After a release ships, find every issue that was closed in the lead-up to
# that release and post a comment tagging the opener. The comment links the
# release and invites them to raise anything else they hit — so reporters
# never have to wonder whether their bug actually made it into a build.
#
# Triggered by:
#   - Windows Scheduled Task (daily): scans the latest release tag and posts
#     to issues closed since the prior tag, skipping ones already notified.
#   - Manual run: `powershell -File scripts\notify-issue-openers.ps1 -Tag v1.11.58`
#
# Idempotency:
#   We add the `release-notified` label after posting. Subsequent runs skip
#   any issue already carrying that label, so re-running the script is safe.

param(
    [string]$Tag = '',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$LogDir   = Join-Path $env:LOCALAPPDATA 'termpolis\auto-triage'
$LogFile  = Join-Path $LogDir ("notify-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".log")
$Gh       = "C:\Program Files\GitHub CLI\gh.exe"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Log($msg) {
    $line = "[$(Get-Date -Format 'HH:mm:ss')] $msg"
    Write-Host $line
    Add-Content -Path $LogFile -Value $line
}

if (-not (Test-Path $Gh))       { Log "ERROR: gh.exe not found at $Gh"; exit 1 }
if (-not (Test-Path $RepoRoot)) { Log "ERROR: repo root missing"; exit 1 }

Set-Location $RepoRoot

# Resolve the target tag — default to the most recent v* tag.
if (-not $Tag) {
    $Tag = (& git describe --tags --abbrev=0 --match 'v*').Trim()
    if (-not $Tag) { Log "ERROR: no v* tags found"; exit 1 }
}
Log "Target tag: $Tag"

# Time window: from the previous tag's commit to now. Anything closed in that
# window is fair game for a "released in $Tag" notification.
$prevTag = (& git describe --tags --abbrev=0 --match 'v*' "$Tag^" 2>$null).Trim()
if ($prevTag) {
    $sinceIso = (& git log -1 --format=%cI $prevTag).Trim()
    Log "Previous tag: $prevTag (closed-since cutoff = $sinceIso)"
} else {
    # First-ever release. Look back 7 days as a safety net.
    $sinceIso = (Get-Date).AddDays(-7).ToString('yyyy-MM-ddTHH:mm:ssZ')
    Log "No previous tag found — using 7-day lookback ($sinceIso)"
}

# Ensure the dedupe label exists.
& $Gh label create release-notified --description "Opener has been notified that a release contains the fix" --color 5319E7 2>&1 | Out-Null

# Pull closed issues in the window. `--search` lets us scope by closed:>$sinceIso.
$query = "is:issue is:closed closed:>$sinceIso"
$issuesJson = & $Gh issue list --state closed --search $query --limit 50 --json number,title,author,labels,closedAt
if ($LASTEXITCODE -ne 0) { Log "gh issue list failed"; exit 1 }
$issues = $issuesJson | ConvertFrom-Json

if (-not $issues -or $issues.Count -eq 0) {
    Log "No issues closed since $sinceIso — nothing to notify."
    exit 0
}

$notified = 0
foreach ($iss in $issues) {
    $labelNames = @($iss.labels | ForEach-Object { $_.name })
    if ($labelNames -contains 'release-notified') {
        Log "Skipping #$($iss.number) — already release-notified."
        continue
    }
    $opener = $iss.author.login
    if (-not $opener -or $iss.author.is_bot) {
        Log "Skipping #$($iss.number) — no human opener."
        continue
    }

    $body = @"
Hey @$opener — a new release [$Tag](https://github.com/codedev-david/termpolis/releases/tag/$Tag) shipped with the fix for this issue.

If you hit anything else — anywhere in Termpolis — please open a new issue and we'll get on it right away. Thanks for the report!
"@

    if ($DryRun) {
        Log "[DRY-RUN] Would comment on #$($iss.number) (@$opener) about $Tag"
        continue
    }

    Log "Commenting on #$($iss.number) (@$opener) — $($iss.title)"
    & $Gh issue comment $iss.number --body $body 2>&1 | Tee-Object -Append -FilePath $LogFile | Out-Null
    if ($LASTEXITCODE -ne 0) { Log "  WARN: comment failed on #$($iss.number) — continuing"; continue }
    & $Gh issue edit $iss.number --add-label release-notified 2>&1 | Out-Null
    $notified++
}

Log "Done. Notified $notified opener(s) about $Tag."
