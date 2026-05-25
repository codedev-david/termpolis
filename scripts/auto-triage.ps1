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
#
# Failure-mode design ("work no matter what"):
#   - Top-level try/catch around the entire body. Uncaught exceptions still
#     get logged + leave a FATAL.log sentinel so silent failures stop being
#     a thing.
#   - Preflight checks (gh / claude / node / npx / git / gh-auth) run BEFORE
#     any issue is touched. If a dep is broken, we exit early without
#     burning the issue.
#   - Transient failures (network, gh rate limit, git push glitch) DO NOT
#     label the issue. The next scheduled run will retry. Only definitive
#     outcomes (PR opened OR Claude looked + declined to fix) add the
#     `auto-triage-attempted` label.
#   - Retry helper wraps gh calls with bounded backoff.

# PS 5.1 promotes native-command stderr to terminating errors under
# 'Stop', which fights us across git/gh/npx calls. Use 'Continue' and rely
# on $LASTEXITCODE / explicit throw statements for control flow.
$ErrorActionPreference = 'Continue'

$RepoRoot   = Split-Path -Parent $PSScriptRoot
$LogDir     = Join-Path $env:LOCALAPPDATA 'termpolis\auto-triage'
$LogFile    = Join-Path $LogDir ("run-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".log")
$FatalLog   = Join-Path $LogDir 'FATAL.log'
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

# Bounded-retry wrapper for flaky external commands (gh API, git push, etc).
# Block must return $LASTEXITCODE-conscious behavior. Returns the last block
# output regardless of success; caller checks $LASTEXITCODE.
function Invoke-WithRetry {
    param([scriptblock]$Block, [int]$MaxAttempts = 3, [int]$DelaySec = 15, [string]$Label = 'command')
    $result = $null
    for ($i = 1; $i -le $MaxAttempts; $i++) {
        $result = & $Block 2>&1
        if ($LASTEXITCODE -eq 0) { return $result }
        Log "[$Label] attempt $i/$MaxAttempts failed (exit $LASTEXITCODE)"
        if ($i -lt $MaxAttempts) { Start-Sleep -Seconds $DelaySec }
    }
    return $result
}

# Verify every dependency the script needs BEFORE we touch any issue.
# Returns a list of problem strings; empty means good to go.
function Test-Preflight {
    $problems = @()
    if (-not (Test-Path $Gh))     { $problems += "gh.exe missing at $Gh" }
    if (-not $Claude)             { $problems += "claude CLI not found in expected paths" }
    if (-not (Test-Path $RepoRoot)) { $problems += "repo root missing: $RepoRoot" }

    # gh auth is the most common silent failure - token expires, user has
    # to re-auth interactively, and the scheduled run can't do that.
    if (Test-Path $Gh) {
        & $Gh auth status 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { $problems += "gh auth status failed - run 'gh auth login' interactively" }
    }

    foreach ($exe in @('node', 'npx', 'git')) {
        $found = Get-Command $exe -ErrorAction SilentlyContinue
        if (-not $found) { $problems += "$exe not resolvable on PATH" }
    }

    # PS 5.1 returns a single string when only one item is in the array;
    # the comma forces it to stay an array.
    return ,$problems
}

# Track worktree state for the finally block. Set after creation succeeds.
$worktreeRoot = $null
$labelOnExit  = $false  # only set true on definitive outcomes
$issueNum     = $null

try {
    Log "Starting auto-triage scan in $RepoRoot"
    Set-Location $RepoRoot

    $preflight = Test-Preflight
    if ($preflight.Count -gt 0) {
        Log "PREFLIGHT FAILED:"
        foreach ($p in $preflight) { Log "  - $p" }
        Log "Skipping this run. Next scheduled run will retry once the deps are healthy."
        exit 1
    }

    # Pull latest main so we branch from current state. Network glitches here
    # are transient - retry rather than skipping the whole run.
    Invoke-WithRetry -Label 'git-fetch' -Block { & git fetch origin main 2>&1 | Out-Null; $LASTEXITCODE } | Out-Null
    & git checkout main 2>&1 | Out-Null
    Invoke-WithRetry -Label 'git-pull' -Block { & git pull --ff-only origin main 2>&1 | Out-Null; $LASTEXITCODE } | Out-Null

    # Pick the next open `bug` issue that hasn't already been attempted.
    $issuesJson = Invoke-WithRetry -Label 'gh-issue-list' -Block {
        & $Gh issue list --state open --label bug --limit 20 --json number,title,labels,body
    }
    if ($LASTEXITCODE -ne 0) {
        Log "gh issue list failed after retries - treating as transient and exiting clean."
        exit 0
    }
    # gh's multi-line JSON arrives as string[]; join + parse.
    $issuesJson = ($issuesJson -join '')
    $parsed = $issuesJson | ConvertFrom-Json
    $issues = @(if ($parsed) { $parsed })

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

    # Make sure both labels exist on the repo. Failures here are non-fatal
    # (labels are nice-to-have for filtering).
    & $Gh label create auto-triage-attempted --description "Auto-triage script has tried to fix this issue" --color BFD4F2 2>&1 | Out-Null
    & $Gh label create auto-triage --description "PR opened by the auto-triage script - needs human review" --color 0E8A16 2>&1 | Out-Null

    # If a stale auto-triage branch from a previous interrupted run exists on
    # origin, delete it so worktree-add can re-create it cleanly. Idempotent.
    & git push origin --delete $branchName 2>&1 | Out-Null

    # Work in a throwaway worktree so the user's main checkout stays clean.
    $worktreeRoot = Join-Path $env:TEMP ("termpolis-triage-" + [guid]::NewGuid().ToString().Substring(0,8))
    Log "Creating worktree: $worktreeRoot"
    & git worktree add -b $branchName $worktreeRoot main 2>&1 | Tee-Object -Append -FilePath $LogFile | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Log "git worktree add failed - transient, will retry on next run."
        exit 1
    }

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
    if ($LASTEXITCODE -ne 0) {
        # Typecheck failure means Claude's fix was incomplete. This is
        # definitive (Claude's output was wrong), so we DO label the issue
        # as attempted - no point retrying the same prompt that produced
        # broken output. A human needs to look.
        Log "Typecheck failed after Claude run - marking issue attempted and commenting."
        $labelOnExit = $true
        & $Gh issue comment $issueNum --body "Auto-triage attempted but the candidate fix failed ``npx tsc``. Human review needed. Log: ``$LogFile``" 2>&1 | Out-Null
        exit 1
    }

    Log "Running full test suite..."
    & npx vitest run 2>&1 | Tee-Object -Append -FilePath $LogFile
    if ($LASTEXITCODE -ne 0) {
        Log "Tests failed after Claude run - marking issue attempted and commenting."
        $labelOnExit = $true
        & $Gh issue comment $issueNum --body "Auto-triage attempted but tests failed under the candidate fix. Human review needed. Log: ``$LogFile``" 2>&1 | Out-Null
        exit 1
    }

    # Did Claude actually make a commit? If not, nothing to PR.
    $commitsAhead = (& git rev-list --count "origin/main..HEAD").Trim()
    if ($commitsAhead -eq '0') {
        Log "Claude made no commits - declined to fix. Marking issue attempted and commenting."
        $labelOnExit = $true
        & $Gh issue comment $issueNum --body "Auto-triage attempted but no fix was committed. The issue may need human investigation. Log: ``$LogFile``" 2>&1 | Out-Null
        exit 0
    }

    Log "Pushing branch $branchName"
    $pushResult = Invoke-WithRetry -Label 'git-push' -Block {
        & git push -u origin $branchName 2>&1
    }
    if ($LASTEXITCODE -ne 0) {
        # Push failed transiently. Don't label - the worktree gets nuked in
        # finally, but the diff is in git history under the branch. Next run
        # will re-create the worktree and re-attempt.
        Log "git push failed after retries - transient, leaving issue unlabeled for retry."
        exit 1
    }

    Log "Opening draft PR"
    $prBody = @"
Auto-generated fix attempt for issue #$issueNum.

This PR was opened by ``scripts/auto-triage.ps1``. Tests + typecheck were green at push time.

**Do not auto-merge.** A human must review the diff before merging - passing tests can hide an incorrect fix (e.g., changed test expectations).

Closes #$issueNum
"@
    $prResult = Invoke-WithRetry -Label 'gh-pr-create' -Block {
        & $Gh pr create --draft --base main --head $branchName --title "auto-triage: fix #$issueNum - $issueTitle" --body $prBody --label auto-triage 2>&1
    }
    if ($LASTEXITCODE -ne 0) {
        Log "gh pr create failed after retries - branch is pushed; next run won't re-create it but will skip via auto-triage-attempted only after labeling now."
        # The branch is pushed but no PR - label so we don't loop on this.
        $labelOnExit = $true
        & $Gh issue comment $issueNum --body "Auto-triage pushed branch ``$branchName`` but ``gh pr create`` failed. Open the PR manually: ``gh pr create --base main --head $branchName``. Log: ``$LogFile``" 2>&1 | Out-Null
        exit 1
    }

    $labelOnExit = $true
    Log "Done. Draft PR opened with label 'auto-triage' - email notification will fire from GitHub Actions."
}
catch {
    # Last-resort handler for anything not caught above. Write a sentinel
    # file the maintainer can spot in the log directory so silent script
    # crashes stop being a thing.
    $stamp = (Get-Date -Format 'o')
    $errMsg = "$_"
    Log "FATAL UNCAUGHT: $errMsg"
    Add-Content -Path $FatalLog -Value "[$stamp] $errMsg (run log: $LogFile)"
    if ($issueNum) {
        & $Gh issue comment $issueNum --body "Auto-triage hit an unexpected error: $errMsg. Log: ``$LogFile``" 2>&1 | Out-Null
    }
    exit 1
}
finally {
    Set-Location $RepoRoot
    if ($worktreeRoot -and (Test-Path $worktreeRoot)) {
        Log "Cleaning up worktree $worktreeRoot"
        & git worktree remove --force $worktreeRoot 2>&1 | Out-Null
    }
    # Label only on definitive outcomes - never on transient failures.
    if ($labelOnExit -and $issueNum) {
        & $Gh issue edit $issueNum --add-label auto-triage-attempted 2>&1 | Out-Null
        Log "Marked issue #$issueNum as auto-triage-attempted."
    }
}
