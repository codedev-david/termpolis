# Polls open GitHub issues labelled `bug` that haven't yet been auto-triaged,
# spins up a worktree, runs Claude Code headlessly to attempt a fix, runs
# typecheck + the full vitest suite, and if everything is green, pushes a
# branch and opens a DRAFT pull request labelled `auto-triage`.
#
# A separate GitHub Actions workflow watches for PRs with that label and
# emails the user. Nothing is ever merged automatically - the user reviews
# every PR.
#
# Designed to be run by Windows Task Scheduler. All output goes to a log
# file under %LOCALAPPDATA%\termpolis\auto-triage so failed runs leave a
# diagnosable trail even when no human is watching.

# PS 5.1 promotes native-command stderr to terminating errors under
# 'Stop', which fights us across git/gh/npx calls. Use 'Continue' and rely
# on $LASTEXITCODE / explicit throw statements for control flow.
$ErrorActionPreference = 'Continue'

$RepoRoot   = Split-Path -Parent $PSScriptRoot
$LogDir     = Join-Path $env:LOCALAPPDATA 'termpolis\auto-triage'
$LogFile    = Join-Path $LogDir ("run-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".log")
$Gh         = "C:\Program Files\GitHub CLI\gh.exe"

# Scheduled Task launches PS with a minimal PATH that does not include
# Node or per-user npm globals. Prepend them so npx/tsc/vitest resolve.
# Sentry issues #9/#10 surfaced as "term 'npx' is not recognized" in the
# triage failure comment because of this gap.
$nodeDir   = 'C:\Program Files\nodejs'
$npmGlobal = Join-Path $env:APPDATA 'npm'
foreach ($p in @($nodeDir, $npmGlobal)) {
    if ((Test-Path $p) -and ($env:PATH -notlike "*$p*")) { $env:PATH = "$p;$env:PATH" }
}
$Claude     = Join-Path $env:USERPROFILE '.local\bin\claude.cmd'
if (-not (Test-Path $Claude)) {
    # PS 5.1 has no ?. null-conditional, so do this the long way.
    $cmd = Get-Command claude -ErrorAction SilentlyContinue
    if ($cmd) { $Claude = $cmd.Source } else { $Claude = $null }
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Log($msg) {
    $line = "[$(Get-Date -Format 'HH:mm:ss')] $msg"
    Write-Host $line
    Add-Content -Path $LogFile -Value $line
}

if (-not (Test-Path $Gh))     { Log "ERROR: gh.exe not found at $Gh"; exit 1 }
if (-not $Claude)             { Log "ERROR: claude CLI not found"; exit 1 }
if (-not (Test-Path $RepoRoot)) { Log "ERROR: repo root missing: $RepoRoot"; exit 1 }

Log "Starting auto-triage scan in $RepoRoot"
Set-Location $RepoRoot

# Pull latest main so we branch from current state.
& git fetch origin main 2>&1 | Out-Null
& git checkout main 2>&1 | Out-Null
& git pull --ff-only origin main 2>&1 | Out-Null

# Pick the next open `bug` issue that hasn't already been attempted.
$issuesJson = & $Gh issue list --state open --label bug --limit 20 --json number,title,labels,body
if ($LASTEXITCODE -ne 0) { Log "gh issue list failed: $issuesJson"; exit 1 }
$issues = $issuesJson | ConvertFrom-Json

$candidate = $null
foreach ($iss in $issues) {
    $labelNames = @($iss.labels | ForEach-Object { $_.name })
    if ($labelNames -notcontains 'auto-triage-attempted') {
        $candidate = $iss
        break
    }
}

if (-not $candidate) {
    Log "No untriaged bug issues - running post-release notifier and exiting."
    $notifyScript = Join-Path $PSScriptRoot 'notify-issue-openers.ps1'
    & (Join-Path $PSHOME 'powershell.exe') -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $notifyScript 2>&1 | Tee-Object -Append -FilePath $LogFile
    exit 0
}

$issueNum = $candidate.number
$issueTitle = $candidate.title
$branchName = "auto-triage/issue-$issueNum"
Log "Selected issue #${issueNum}: $issueTitle"

# Mark it attempted FIRST so two concurrent runs can't double-process. If the
# label doesn't exist yet on the repo, create it.
& $Gh label create auto-triage-attempted --description "Auto-triage script has tried to fix this issue" --color BFD4F2 2>&1 | Out-Null
& $Gh label create auto-triage --description "PR opened by the auto-triage script - needs human review" --color 0E8A16 2>&1 | Out-Null
& $Gh issue edit $issueNum --add-label auto-triage-attempted 2>&1 | Out-Null

# Work in a throwaway worktree so the user's main checkout stays clean.
$worktreeRoot = Join-Path $env:TEMP ("termpolis-triage-" + [guid]::NewGuid().ToString().Substring(0,8))
Log "Creating worktree: $worktreeRoot"
& git worktree add -b $branchName $worktreeRoot main 2>&1 | Tee-Object -Append -FilePath $LogFile | Out-Null
if ($LASTEXITCODE -ne 0) { Log "git worktree add failed"; exit 1 }

try {
    Set-Location $worktreeRoot

    # Build a focused prompt. Headless Claude reads the issue, writes the fix,
    # writes tests, runs the suite, commits. --dangerously-skip-permissions
    # is required for non-interactive tool use; safe here because we're in
    # an isolated worktree.
    $issueUrl = "https://github.com/codedev-david/termpolis/issues/$issueNum"
    $prompt = @"
You are working on the Termpolis repo in a fresh worktree. Fix this GitHub issue:

$issueUrl

Title: $issueTitle

Body:
$($candidate.body)

Workflow:
1. Read the issue carefully and find the root cause in the codebase.
2. Write the minimal correct fix.
3. Add or update unit tests that would catch this exact regression next time.
4. Run ``npx tsc --noEmit -p tsconfig.web.json`` - must pass.
5. Run ``npx vitest run`` - every test must pass.
6. Commit with a clear message referencing ``#$issueNum``. Do NOT push.

If the issue is unclear, unreproducible, or the fix is high-risk, commit nothing and exit with a single-line summary explaining why.
"@

    Log "Invoking Claude Code (this can take several minutes)..."
    & $Claude -p $prompt --dangerously-skip-permissions 2>&1 | Tee-Object -Append -FilePath $LogFile

    # Final independent verification - never trust the agent's self-report.
    Log "Running final typecheck..."
    & npx tsc --noEmit -p tsconfig.web.json 2>&1 | Tee-Object -Append -FilePath $LogFile
    if ($LASTEXITCODE -ne 0) { throw "typecheck failed after Claude run" }

    Log "Running full test suite..."
    & npx vitest run 2>&1 | Tee-Object -Append -FilePath $LogFile
    if ($LASTEXITCODE -ne 0) { throw "vitest failed after Claude run" }

    # Did Claude actually make a commit? If not, nothing to PR.
    $commitsAhead = (& git rev-list --count "origin/main..HEAD").Trim()
    if ($commitsAhead -eq '0') {
        Log "Claude made no commits - likely declined to fix. Commenting on issue and skipping PR."
        & $Gh issue comment $issueNum --body "Auto-triage attempted but no fix was committed. The issue may need human investigation. See run log on the maintainer's machine: ``$LogFile``" 2>&1 | Out-Null
        exit 0
    }

    Log "Pushing branch $branchName"
    & git push -u origin $branchName 2>&1 | Tee-Object -Append -FilePath $LogFile
    if ($LASTEXITCODE -ne 0) { throw "git push failed" }

    Log "Opening draft PR"
    $prBody = @"
Auto-generated fix attempt for issue #$issueNum.

This PR was opened by ``scripts/auto-triage.ps1``. Tests + typecheck were green at push time.

**Do not auto-merge.** A human must review the diff before merging - passing tests can hide an incorrect fix (e.g., changed test expectations).

Closes #$issueNum
"@
    & $Gh pr create --draft --base main --head $branchName --title "auto-triage: fix #$issueNum - $issueTitle" --body $prBody --label auto-triage 2>&1 | Tee-Object -Append -FilePath $LogFile
    if ($LASTEXITCODE -ne 0) { throw "gh pr create failed" }

    Log "Done. Draft PR opened with label 'auto-triage' - email notification will fire from GitHub Actions."
}
catch {
    Log "FAILED: $_"
    & $Gh issue comment $issueNum --body "Auto-triage attempt failed: $_. Run log on maintainer's machine: ``$LogFile``" 2>&1 | Out-Null
    exit 1
}
finally {
    Set-Location $RepoRoot
    Log "Cleaning up worktree $worktreeRoot"
    & git worktree remove --force $worktreeRoot 2>&1 | Out-Null
}
