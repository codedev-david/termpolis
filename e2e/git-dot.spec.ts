/**
 * Git dot E2E — proves the per-terminal git mark actually appears for a terminal the
 * user creates, in the repo they chose.
 *
 * This is the regression the unit suite structurally CANNOT catch: every TerminalGitDot
 * unit test hands the component a repo `cwd` prop directly, while the real bug was that
 * the creation path never gave it one — both "+ Add Terminal" handlers pinned every new
 * terminal to the home directory, where `git status` fails, so the dot rendered nothing
 * for the life of the terminal. On Windows there is no way to follow a later `cd`
 * (getTerminalCwdAsync returns null and the app has no shell integration), so the launch
 * directory is the only chance the dot ever gets.
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

const anyDot = '[data-testid^="git-dot-"]'

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
  for (const dir of [isolatedUserData, repoDir]) {
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
