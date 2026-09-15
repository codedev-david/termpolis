/**
 * The reported bug, end to end: a prompt that abbreviates the directory to `~`.
 *
 * The renderer has no `process`, so it had no home directory to expand a tilde against.
 * `normalizeShellPath` left a shell-reported `~/repos/x` verbatim, `git -C '~/repos/x'` could
 * not chdir to it, git:change-counts answered null, and the mark read a dirty repository as
 * "not a repository". The fix carries os.homedir() across the platform-info bridge.
 *
 * Why this needs a spec of its own rather than another case in git-dot.spec.ts:
 *
 *  - It runs with shell integration switched OFF (TERMPOLIS_DISABLE_SHELL_INTEGRATION, the
 *    app's own documented escape hatch). That is the whole point. Integration reports an
 *    ABSOLUTE path on every prompt — bash emits "$PWD", cmd $p, PowerShell ProviderPath — so
 *    with it on, the store gets a good path no matter what the tilde does, and a test here
 *    would pass whether or not the expansion works. Turning it off leaves prompt TEXT as the
 *    only thing reporting a directory, which is the one route a tilde can travel.
 *  - git-dot.spec.ts's `cd` test asserts the opposite arrangement on purpose — that OSC 7/9;9
 *    carries a later `cd` — so the two cannot share an app instance without one weakening the
 *    other.
 *
 * Windows-only, and that is substance rather than a limitation: main resolves a shell's real
 * directory from its pid on every status poll, and on Windows that probe returns null. So on
 * Windows the prompt is the only directory reporter, which is exactly why the bug reproduced
 * here and not on the Linux CI box. On POSIX the probe would answer with the real absolute
 * path every 5s and race the prompt — genuine flake, so it is skipped rather than fudged.
 *
 * Git Bash rather than a redefined PowerShell prompt function, because `~` is what bash's own
 * `\w` produces — the abbreviation under test is the shell's, not a string this test typed.
 *
 * The test PINS the prompt rather than inheriting the one the machine happens to have. A prompt is
 * a personal dotfile, so inheriting it makes the result depend on whose machine is running. What
 * the inherited prompt here actually rendered, observed rather than assumed, was:
 *
 *     termpolis-gitdot-home-6YdmpO (main) $
 *
 * — the directory's BASENAME and a branch, with no path and so no tilde anywhere in it. Nothing
 * about a tilde could be under test against that prompt, and `parsePromptFromOutput` correctly
 * reports no directory for it: a bare basename must match nothing, or git would resolve it against
 * the app's own working directory and report another repository's changes as this terminal's.
 *
 * Pinning takes TWO statements, and the order matters. `unset PROMPT_COMMAND` has to come first:
 * a PROMPT_COMMAND that rebuilds PS1 before every prompt discards a plain `PS1=...` assignment,
 * and `bash --login` re-reads the login files that install one, so clearing it in the environment
 * this process inherits does not reach the shell. An earlier version of this test set PS1 alone;
 * the assignment ran, the prompt did not change, and the run failed as though the product were
 * broken. Hence the assertion that the pin actually took before anything depends on it — a test
 * that cannot tell a broken premise from a broken product is worse than no test.
 *
 * The two-line shape (`\w\n$ `) is fine: GIT_BASH_PROMPT keys off the `MINGW` token and does not
 * need a `$` terminator on the path line.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { execSync, execFileSync } from 'child_process'
import { ensureGitOnPath } from '../tests/gitPath'

// The same executable shellDetector looks for; checked here so a machine without Git for
// Windows skips cleanly instead of failing in beforeAll on a missing shell.
const GIT_BASH_PATHS = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
]

let app: ElectronApplication | undefined
let page: Page
let isolatedUserData: string | undefined
let homeRepo: string | undefined
let plainDir: string | undefined

const anyDot = '[data-testid^="git-dot-"][data-repo="true"]'

const runnable = process.platform === 'win32' && GIT_BASH_PATHS.some((p) => fs.existsSync(p))
const describeMaybe = runnable ? test.describe : test.describe.skip

describeMaybe('the git mark in a `~`-abbreviated directory', () => {
  test.beforeAll(async () => {
    const gitOnPath = ensureGitOnPath()
    if (gitOnPath.status === 'unresolved') {
      throw new Error('git-dot-tilde.spec needs a real git to build its fixture repo')
    }

    execSync('npx electron-vite build', { cwd: path.resolve('.'), stdio: 'pipe' })

    // The repo has to live under the REAL home directory: a tilde abbreviates to $HOME and to
    // nothing else, so os.tmpdir() cannot stand in for it. Removed in afterAll, so a
    // developer's home is left as it was found.
    homeRepo = fs.mkdtempSync(path.join(os.homedir(), 'termpolis-gitdot-home-'))
    // argv form, not a shell string: the identity flags carry '@' and '='.
    const git = (...args: string[]) => execFileSync('git', args, { cwd: homeRepo!, stdio: 'pipe' })
    git('init')
    fs.writeFileSync(path.join(homeRepo, 'committed.txt'), 'tracked\n')
    git('add', 'committed.txt')
    git('-c', 'user.email=e2e@termpolis.test', '-c', 'user.name=e2e', 'commit', '-m', 'init')
    // One untracked file, so a mark that finds this repo has something to pulse about — and so
    // the title assertion below can prove git actually ran IN the expanded directory.
    fs.writeFileSync(path.join(homeRepo, 'untracked.txt'), 'work in progress\n')

    isolatedUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-gitdot-tilde-ud-'))
    fs.writeFileSync(
      path.join(isolatedUserData, 'session.json'),
      JSON.stringify({ terminals: [], workspaces: [], defaultShell: 'gitbash', viewMode: 'tabs' }),
    )

    app = await electron.launch({
      args: [path.resolve('out/main/index.js'), `--user-data-dir=${isolatedUserData}`],
      // Integration off: no OSC 7 to hand the app an absolute path behind the test's back.
      env: {
        ...process.env,
        NODE_ENV: 'test',
        TERMPOLIS_TEST_AGENTS: '1',
        TERMPOLIS_TEST_TIMING: '1',
        TERMPOLIS_DISABLE_SHELL_INTEGRATION: '1',
      },
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(1500)

    await page.evaluate(() => {
      try {
        localStorage.setItem('termpolis.onboarding.seen.v1', '1')
        localStorage.setItem('termpolis.telemetry.optIn', '0')
      } catch { /* ignore */ }
    })
    const onboardDialog = page.locator('[aria-labelledby="onboarding-title"]')
    if (await onboardDialog.isVisible({ timeout: 5000 }).catch(() => false)) {
      await page.locator('button:has-text("Skip tour")').first().click({ force: true }).catch(() => {})
      await onboardDialog.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {})
    }
  })

  test.afterAll(async () => {
    if (app) await app.close()
    for (const dir of [isolatedUserData, homeRepo, plainDir]) {
      if (dir) {
        try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
      }
    }
  })

  test('a Git Bash prompt that abbreviates the repo to `~` still lights the mark', async () => {
    // Starts OUTSIDE any repository, and deliberately stays there as far as the shell's real
    // directory is concerned until the cd below.
    plainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-gitdot-tilde-plain-'))
    const before = await page.locator(anyDot).count()

    await page.locator('button:has-text("+ Add Terminal")').click()
    const folderInput = page.getByPlaceholder('Home directory')
    await expect(folderInput).toBeVisible({ timeout: 10000 })
    await folderInput.fill(plainDir)
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(folderInput).toBeHidden({ timeout: 10000 })

    // Nothing to report outside a repo, so the count must not move yet — which makes the
    // delta asserted below a real one.
    await expect(page.locator(anyDot)).toHaveCount(before, { timeout: 10000 })

    const term = page.locator('.xterm:visible').first()
    await term.click()

    // The app's own read-only hook. It reads xterm's buffer, so it works whichever renderer
    // paints; a DOM query does not, because this build paints to a canvas.
    const screen = async (): Promise<string> =>
      await page.evaluate(() => {
        const read = (window as unknown as { __termpolis_terminal_text?: (id?: string) => string })
          .__termpolis_terminal_text
        return read ? read() : ''
      })

    // Pin the prompt. Both halves are load-bearing:
    //  - `unset PROMPT_COMMAND` FIRST. A PROMPT_COMMAND that rewrites PS1 on every prompt
    //    silently discards the assignment below, and `bash --login` re-reads the login files
    //    that install one, so clearing it in the parent environment does not help. This was
    //    observed directly: the assignment ran and the prompt did not change.
    //  - then PS1, to the shape Git Bash ships. `\w` is bash's own home-abbreviating token,
    //    so the `~` under test is produced by the shell, not typed by this test.
    await page.keyboard.type(`unset PROMPT_COMMAND; PS1='MINGW64 \\w\\n$ '`)
    await page.keyboard.press('Enter')

    // Prove the pin took before depending on it. Without this the test can fail later for a
    // reason that merely resembles the bug, which is how two earlier runs were misdiagnosed.
    await expect(async () => {
      expect(await screen()).toMatch(/MINGW64\s+\S/)
    }).toPass({ timeout: 20000 })

    // A plain cd, typed as a person would. The repo sits directly under $HOME, so bash renders
    // the directory as `~/<name>` — the exact shape that reached the store unexpanded before.
    const repoName = path.basename(homeRepo!)
    await page.keyboard.type(`cd ~/${repoName}`)
    await page.keyboard.press('Enter')

    // The tilde must actually appear on screen, or nothing below is evidence about tildes.
    await expect(async () => {
      expect(await screen()).toMatch(new RegExp(`MINGW64\\s+~/${repoName}`))
    }).toPass({ timeout: 20000 })

    // Prompt parsing is driven by shell OUTPUT and throttled to one parse per 500ms, so a
    // prompt landing in the same window as the command echo can be dropped — and an idle
    // shell then emits nothing further to re-trigger it. A bare Enter redraws the prompt,
    // which is both something people really do and a fresh parse opportunity, so this keeps
    // offering one until the mark appears rather than betting on one chunk's arrival timing.
    // The mark's own poll is 5s, so the budget covers several redraws plus a poll.
    await expect(async () => {
      await page.keyboard.press('Enter')
      await page.waitForTimeout(900)
      expect(await page.locator(anyDot).count()).toBe(before + 1)
    }).toPass({ timeout: 90000 })

    // Not merely live: reading the untracked file proves git was handed the EXPANDED absolute
    // path and ran there, rather than the mark lighting up for some unrelated reason.
    await expect(page.locator(`${anyDot}[data-dirty="true"]`).first()).toHaveAttribute(
      'title',
      /untracked/,
      { timeout: 30000 },
    )
  })
})
