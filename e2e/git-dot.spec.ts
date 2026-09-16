/**
 * Git dot E2E — proves the per-terminal git mark actually appears for a terminal the
 * user creates, in the repo they chose.
 *
 * This is the regression the unit suite structurally CANNOT catch: every TerminalGitDot
 * unit test hands the component a repo `cwd` prop directly, while the real bug was that
 * the creation path never gave it one — both "+ Add Terminal" handlers pinned every new
 * terminal to the home directory, where `git status` fails, so the dot rendered nothing
 * for the life of the terminal. The launch directory is no longer the only chance the dot
 * gets — shell integration (OSC 7 / OSC 9;9, injected at spawn) now reports every later
 * `cd` on every platform — but it is still the FIRST chance, and a terminal that starts
 * blind in a repo is the case people hit before they type anything at all.
 *
 * Isolated --user-data-dir so it owns its own single-instance lock and coexists with a
 * developer's running app (mirrors terminal-focus.spec.ts).
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { execSync, execFileSync } from 'child_process'
import { ensureGitOnPath } from '../tests/gitPath'

let app: ElectronApplication
let page: Page
let isolatedUserData: string
let repoDir: string
let plainDir: string | undefined
// A bare repo to push at, so the fixture has a real upstream: `ahead` is undefined
// without one, and `ahead` is the whole subject of the last test in this file.
let originDir: string | undefined

// Every terminal carries a mark now — dim and inert outside a repo — so these assertions
// select only the LIVE ones, which is what "the dot appeared" has always meant here.
const anyDot = '[data-testid^="git-dot-"][data-repo="true"]'

test.beforeAll(async () => {
  // Playwright never loads tests/setup.ts, so the harness's git resolution has to be asked
  // for by name here. Without it this spec dies in beforeAll on any shell whose PATH omits
  // git — a PowerShell session spawned by an AI tool, for one — and that failure looks
  // exactly like the bug the spec exists to catch. It also repairs PATH for the app itself,
  // which inherits this process's env.
  const gitOnPath = ensureGitOnPath()
  if (gitOnPath.status === 'unresolved') {
    throw new Error(
      'git-dot.spec needs a real git to build its fixture repo, and none was found on PATH ' +
      'or in the usual install locations',
    )
  }

  execSync('npx electron-vite build', { cwd: path.resolve('.'), stdio: 'pipe' })

  // A real repo with a commit (so the branch header is a normal branch name) plus one
  // untracked file, so the dot must not merely appear — it must report work outstanding,
  // which is the pulsing state the user was missing.
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-gitdot-repo-'))
  // argv form, not a shell string: the identity flags below carry '@' and '=' and must not
  // be re-parsed by cmd.exe.
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repoDir, stdio: 'pipe' })
  git('init')
  fs.writeFileSync(path.join(repoDir, 'committed.txt'), 'tracked\n')
  git('add', 'committed.txt')
  git('-c', 'user.email=e2e@termpolis.test', '-c', 'user.name=e2e', 'commit', '-m', 'init')
  fs.writeFileSync(path.join(repoDir, 'untracked.txt'), 'work in progress\n')

  isolatedUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-gitdot-'))
  fs.writeFileSync(path.join(isolatedUserData, 'session.json'), JSON.stringify({
    terminals: [],
    workspaces: [],
    defaultShell: process.platform === 'win32' ? 'powershell' : 'bash',
    viewMode: 'tabs',
  }))

  app = await electron.launch({
    args: [
      path.resolve('out/main/index.js'),
      `--user-data-dir=${isolatedUserData}`,
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    ],
    env: { ...process.env, NODE_ENV: 'test', TERMPOLIS_TEST_AGENTS: '1', TERMPOLIS_TEST_TIMING: '1' },
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(1500)

  // Pre-dismiss first-run onboarding so it doesn't intercept clicks.
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
  for (const dir of [isolatedUserData, repoDir, plainDir, originDir]) {
    if (dir) {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  }
})

/** Open "+ Add Terminal", optionally set the folder, and create it. */
async function createTerminal(folder?: string) {
  await page.locator('button:has-text("+ Add Terminal")').click()
  const folderInput = page.getByPlaceholder('Home directory')
  await expect(folderInput).toBeVisible({ timeout: 10000 })
  if (folder !== undefined) await folderInput.fill(folder)
  // Exact name, not has-text: the Welcome screen's "New Terminal" card also carries the
  // words "Create a terminal with custom shell and theme", and a substring match would
  // hit both buttons and fail Playwright's strict mode.
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(folderInput).toBeHidden({ timeout: 10000 })
}

test('a terminal created in a repo shows a git dot reporting outstanding work', async () => {
  await createTerminal(repoDir)

  const dot = page.locator(anyDot).first()
  await expect(dot).toBeVisible({ timeout: 30000 })
  // Amber + pulsing, not merely present: one untracked file is work waiting.
  await expect(dot).toHaveAttribute('data-dirty', 'true')
  await expect(dot).toHaveAttribute('title', /untracked/)
})

test('a second terminal inherits that repo, so its dot appears without choosing a folder', async () => {
  // The folder field is left untouched: this is the inheritance half of the fix
  // (resolveNewTerminalCwd falling through to the active terminal's directory)
  // and the reason a new tab no longer lands in the home directory.
  const before = await page.locator(anyDot).count()
  await createTerminal()

  await expect(page.locator(anyDot)).toHaveCount(before + 1, { timeout: 30000 })
  const dots = page.locator(anyDot)
  for (let i = 0; i < await dots.count(); i++) {
    await expect(dots.nth(i)).toHaveAttribute('data-dirty', 'true')
  }
})

/**
 * The scenario a person actually performs: open a plain terminal, then cd into a repo.
 * Two independent mechanisms have to fail before this test does — the shell's OSC 7/9;9
 * report (registered on xterm's parser, so it survives a PTY chunk split) and, for any
 * shell that emits neither, prompt parsing — and both funnel through normalizeShellPath,
 * so a terminal that was NOT launched in a repo must still grow a dot once it moves into
 * one. That belt-and-braces is deliberate: this is the case the feature exists for.
 * Runs last because it leaves the active terminal somewhere the other tests do not expect.
 */
test("a terminal that cd's into a repo grows a dot without being recreated", async () => {
  plainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-gitdot-plain-'))
  const before = await page.locator(anyDot).count()

  await createTerminal(plainDir)
  // Outside a repo there is nothing to report, so the count must not move yet.
  await expect(page.locator(anyDot)).toHaveCount(before, { timeout: 10000 })

  // Type a real cd into the live shell, exactly as a person would.
  const term = page.locator('.xterm:visible').first()
  await term.click()
  await page.keyboard.type(`cd "${repoDir}"`)
  await page.keyboard.press('Enter')

  // The prompt now reports the repo, so this terminal must acquire a dirty dot.
  await expect(page.locator(anyDot)).toHaveCount(before + 1, { timeout: 30000 })
})

/**
 * The other half of the loop: a mark is only worth having if it LEADS somewhere. A dot
 * that pulses but opens nothing still leaves people switching to VS Code to find out what
 * actually changed, which is the reason this feature exists at all.
 *
 * The unit suite covers the panel's rendering in isolation, handing it change data
 * directly. What it structurally cannot prove is that a real click on a real dot reaches
 * it: the dot dispatches a window CustomEvent, App.tsx listens for it and opens the rail
 * on that terminal, and the panel then has to resolve the repo root from the terminal's
 * cwd and shell out to git for both the status and the diff. Every one of those seams is
 * only ever exercised here.
 */
test('clicking the pulsing dot opens the Changes panel and the file diff', async () => {
  const dot = page.locator(anyDot).first()
  await expect(dot).toBeVisible({ timeout: 30000 })
  await dot.click()

  await expect(page.locator('[data-testid="changes-panel"]')).toBeVisible({ timeout: 15000 })

  // git's own shorthand, not a prettified label of our own: "??" is what
  // `git status --porcelain` calls an untracked file, and inventing a friendlier word
  // would teach people a dialect that doesn't match the tool they already know.
  const row = page.locator('[data-testid="change-row-untracked.txt"]')
  await expect(row).toBeVisible({ timeout: 15000 })
  await expect(row).toContainText('??')

  await row.click()
  const modal = page.locator('[data-testid="file-diff-modal"]')
  await expect(modal).toBeVisible({ timeout: 15000 })
  // The right file, and its real contents — proof the modal reached git rather than
  // merely opening on an empty frame.
  await expect(modal).toHaveAttribute('aria-label', 'Diff for untracked.txt')
  await expect(modal).toContainText('work in progress', { timeout: 15000 })

  await page.keyboard.press('Escape')
})

/**
 * The user's own acceptance criterion, and the last thing the mark has to get right:
 * "once change are commited up and the working tree etc is clean ... then the git symbol
 * stop flashing/pulsating." A mark that pulses forever is noise people train themselves
 * to ignore, which is worse than no mark at all.
 *
 * Runs last on purpose — it commits the fixture repo, so every test above it would lose
 * the outstanding work they assert on.
 */
test('committing the work stops the pulse and reports a clean tree', async () => {
  // argv form for the same reason beforeAll uses it: the identity flags carry '@' and '='.
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repoDir, stdio: 'pipe' })
  git('add', '-A')
  git('-c', 'user.email=e2e@termpolis.test', '-c', 'user.name=e2e', 'commit', '-m', 'done')

  // The poll owns the clock: nothing in the app knows a commit happened until it next
  // asks git, so this waits on the state itself rather than on a fixed delay.
  const dot = page.locator(anyDot).first()
  await expect(dot).toHaveAttribute('data-dirty', 'false', { timeout: 60000 })
  // Still a repo and still marked — it just stops asking for attention.
  await expect(dot).toBeVisible()

  // And the panel agrees, rather than showing a stale list of work already committed.
  await dot.click()
  await expect(page.locator('[data-testid="changes-clean"]')).toBeVisible({ timeout: 30000 })
})

/**
 * The invariant the mark rests on: ANYTHING that makes the dot pulse has a row in the
 * panel. This is the case that broke it — a tree with nothing modified, one commit the
 * upstream has never seen. `isDirty` counts `ahead`, so the dot pulsed amber; the rail
 * listed only working-tree files, so it opened on "Nothing changed — the working tree is
 * clean." The mark said there was work and the panel called it a liar.
 *
 * Only an e2e can pin it. The unit suites hand each half its own fixture, so the two can
 * disagree about what "outstanding" means and both stay green — which is exactly what
 * they did. Here one real repo feeds both, through real git.
 *
 * Runs after the commit test because it needs the clean tree that test leaves behind.
 */
test('a clean tree with an unpushed commit pulses AND says what is unpushed', async () => {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repoDir, stdio: 'pipe' })

  // `git status` reports `ahead` only against a configured upstream, so the fixture needs
  // somewhere to have pushed. Bare, because it is only ever a push target.
  originDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-gitdot-origin-'))
  execFileSync('git', ['init', '--bare', originDir], { stdio: 'pipe' })
  git('remote', 'add', 'origin', originDir)
  // HEAD rather than a branch name: `git init` picks master or main depending on the
  // developer's git config, and this spec has no business caring which.
  git('push', '-u', 'origin', 'HEAD')

  // The tree ends clean — the edit goes straight into a commit. That is the whole point:
  // nothing here is a working-tree change, so nothing here would have shown in the rail.
  fs.writeFileSync(path.join(repoDir, 'committed.txt'), 'tracked\nand then some\n')
  git('add', '-A')
  git(
    '-c', 'user.email=e2e@termpolis.test', '-c', 'user.name=e2e',
    'commit', '-m', 'unpushed: the row this test exists for',
  )

  // The poll owns the clock here too.
  const dot = page.locator(anyDot).first()
  await expect(dot).toHaveAttribute('data-dirty', 'true', { timeout: 60000 })
  await expect(dot).toHaveAttribute('title', /1 to push/)

  await dot.click()
  const panel = page.locator('[data-testid="changes-panel"]')
  await expect(panel).toBeVisible({ timeout: 15000 })

  // The branch bar's chip — present in the JSX all along, and absent from the screenshot
  // that started this. If `ahead` never reaches the renderer, this is where it shows.
  await expect(panel).toContainText('↑1', { timeout: 30000 })

  // The rows, which is the half that did not exist at all.
  await expect(page.locator('[data-testid="changes-section-unpushed"]'))
    .toBeVisible({ timeout: 30000 })
  const row = page.locator('[data-testid^="commit-row-"]').first()
  await expect(row).toBeVisible()
  await expect(row).toContainText('unpushed: the row this test exists for')

  // And the panel stops denying there is anything to see.
  await expect(page.locator('[data-testid="changes-clean"]')).toHaveText(/1 commit to push/)

  // A row that leads nowhere is the bug one level up, so: the commit's own patch.
  await row.click()
  const modal = page.locator('[data-testid="file-diff-modal"]')
  await expect(modal).toBeVisible({ timeout: 15000 })
  await expect(modal).toContainText('and then some', { timeout: 15000 })
  await page.keyboard.press('Escape')
})

/**
 * The payload the `~` fix actually added, read back out of the live bridge.
 *
 * Every unit test in this repo stubs `window.termpolis`, so not one of them can prove the real
 * preload puts a home directory on that object at all — and that omission WAS the bug. The
 * renderer has no `process`, so with no homedir to expand against, `normalizeShellPath` left a
 * shell-reported `~/repos/x` verbatim, `git -C '~/repos/x'` could not chdir, and the mark read a
 * dirty repository as "not a repository". This asserts the real main -> preload -> renderer hop
 * carries it, and carries it absolute, which is the only form git can open.
 */
test('the live bridge hands the renderer an absolute home directory to expand `~` against', async () => {
  const fromApp = await page.evaluate(
    () =>
      (window as unknown as { termpolis?: { platformInfo?: { homedir?: string } } }).termpolis
        ?.platformInfo?.homedir,
  )
  expect(fromApp).toBe(os.homedir())
  expect(path.isAbsolute(String(fromApp))).toBe(true)
})

/**
 * The `~`-abbreviated case — the other half of what that homedir is FOR — lives in
 * git-dot-tilde.spec.ts rather than here. It has to run with shell integration switched off,
 * because integration reports an absolute path on every prompt and would hand the app a good
 * cwd whether or not the tilde was ever expanded; the `cd` test above asserts the opposite
 * arrangement on purpose, so the two cannot share this app instance.
 */
