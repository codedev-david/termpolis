/**
 * gitCommit trigger — end-to-end proof against a REAL git repository.
 *
 * Everything the unit suites prove about triggers, they prove against a fake
 * filesystem: a `.git/HEAD` we wrote ourselves and a sha we changed by hand.
 * That leaves the one thing that actually matters unproven — that a real
 * `git commit`, in a real repo, made by a real user, reaches the engine.
 *
 * So this spec does the whole thing for real:
 *   1. `git init` a throwaway repo in the OS temp dir and make a first commit.
 *   2. Drop a gitCommit-triggered workflow in that repo's `.termpolis/workflows`.
 *   3. Point the app's saved session at the repo, so the BOOT FAN-OUT is what
 *      arms it (nobody clicks into the project during this test).
 *   4. Launch the app, then `git commit` again from outside it entirely.
 *   5. Assert a run lands in the repo's run history JSONL.
 *
 * The workflow is Control-only on purpose: on a headless runner a conpty/PTY
 * Command step's `onExit` never fires, so a command step here would hang for
 * reasons that have nothing to do with triggers.
 *
 * Ubuntu-only in CI. Windows headless can't drive this reliably (see above) and
 * the point of the spec is the git plumbing, not the platform.
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { execFileSync } from 'child_process'

let app: ElectronApplication | null = null
let page: Page | null = null
let isolatedUserData = ''
let repo = ''

const WF_ID = 'e2egitcommit'
const RUNS_FILE = () => path.join(repo, '.termpolis', 'workflows', 'runs', `${WF_ID}.jsonl`)

/** git, in the throwaway repo, with an identity so `commit` never prompts. */
function git(...args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Termpolis E2E',
      GIT_AUTHOR_EMAIL: 'e2e@termpolis.test',
      GIT_COMMITTER_NAME: 'Termpolis E2E',
      GIT_COMMITTER_EMAIL: 'e2e@termpolis.test',
      GIT_CONFIG_GLOBAL: path.join(repo, '.gitconfig-none'),
      GIT_CONFIG_SYSTEM: path.join(repo, '.gitconfig-none'),
    },
  }).toString()
}

/**
 * The version `loadSession()` compares against, asked of the app itself.
 *
 * `app.getVersion()` reads the package.json next to the app path. Launched
 * unpackaged the way Playwright does it, the app path is `out/main` — which has
 * no package.json — so Electron falls back to reporting its OWN version
 * (30.5.1), NOT the one in the repo's package.json. Guessing the version from
 * package.json therefore writes a session the app throws away, and the spec
 * fails for a reason that has nothing to do with triggers.
 *
 * So: a short throwaway launch that just asks. Its own user-data dir, so the
 * session it writes on quit can never touch the fixture.
 */
async function probeAppVersion(): Promise<string> {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-gitwf-probe-'))
  const probe = await electron.launch({
    args: [
      path.resolve('out/main/index.js'),
      `--user-data-dir=${ud}`,
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    ],
    env: { ...process.env, NODE_ENV: 'test', TERMPOLIS_TEST_AGENTS: '1', TERMPOLIS_SMOKE_SKIP_PICKERS: '1' },
  })
  try {
    return await probe.evaluate(({ app: a }) => a.getVersion())
  } finally {
    try { await probe.close() } catch { /* already gone */ }
    try { fs.rmSync(ud, { recursive: true, force: true }) } catch { /* temp dir */ }
  }
}

test.beforeAll(async () => {
  // A build plus two Electron launches does not fit the config's 120s hook budget
  // on a cold runner.
  test.setTimeout(300_000)
  const { execSync } = await import('child_process')
  execSync('npx electron-vite build', { cwd: path.resolve('.'), stdio: 'pipe' })

  const appVersion = await probeAppVersion()

  // ── a real repository ─────────────────────────────────────────────────────
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-gitwf-')))
  git('init', '-q')
  fs.writeFileSync(path.join(repo, 'README.md'), '# e2e\n')
  git('add', '.')
  git('commit', '-qm', 'first')

  // ── the workflow, written straight to disk ────────────────────────────────
  // Authoring it through the UI is already covered by workflow-orchestrator;
  // what is under test here is the trigger, so the definition is a fixture.
  const wfDir = path.join(repo, '.termpolis', 'workflows')
  fs.mkdirSync(wfDir, { recursive: true })
  fs.writeFileSync(
    path.join(wfDir, `${WF_ID}.yml`),
    [
      `id: ${WF_ID}`,
      'name: E2E Git Commit',
      'version: 1',
      'trigger:',
      '  type: gitCommit',
      'steps:',
      '  - id: note',
      '    type: control',
      '    name: Note',
      '    action: notify',
      '    config:',
      "      message: 'commit observed in ${project.name}'",
      '',
    ].join('\n'),
  )

  // ── the app profile ───────────────────────────────────────────────────────
  isolatedUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-gitwf-ud-'))
  // A saved terminal in the repo is the ONLY thing that arms it: nothing in this
  // test ever opens the project in the UI. This is the boot fan-out under test.
  // `appVersion` MUST match what the running build reports — loadSession drops
  // every restored terminal when the version differs (an upgrade's shells no
  // longer exist), and a dropped terminal here would silently arm nothing.
  fs.writeFileSync(
    path.join(isolatedUserData, 'session.json'),
    JSON.stringify({
      appVersion,
      terminals: [{ id: 't1', title: 'repo', cwd: repo, shell: 'bash' }],
      workspaces: [],
      defaultShell: 'bash',
      viewMode: 'tabs',
    }),
  )
  // An untrusted workspace never auto-runs anything — that gate is unit-tested;
  // here we need it satisfied so the run can actually happen.
  fs.writeFileSync(path.join(isolatedUserData, 'trusted-workspaces.json'), JSON.stringify({ paths: [repo] }))

  app = await electron.launch({
    args: [
      path.resolve('out/main/index.js'),
      `--user-data-dir=${isolatedUserData}`,
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    ],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      TERMPOLIS_TEST_AGENTS: '1',
      TERMPOLIS_SMOKE_SKIP_PICKERS: '1',
    },
  })
  app.process().stderr?.on('data', (d: Buffer) => console.log('[app stderr] ' + d.toString().trimEnd()))
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const onboardDialog = page.locator('[aria-labelledby="onboarding-title"]')
  if (await onboardDialog.isVisible({ timeout: 5000 }).catch(() => false)) {
    await page.locator('button:has-text("Skip tour")').first().click({ force: true }).catch(() => {})
    await onboardDialog.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {})
  }
})

test.afterAll(async () => {
  try { await app?.close() } catch { /* already gone */ }
  for (const d of [repo, isolatedUserData]) {
    try { if (d) fs.rmSync(d, { recursive: true, force: true }) } catch { /* temp dir */ }
  }
})

test('a real git commit fires the workflow and the run lands in history', async () => {
  test.setTimeout(180_000)

  // The supervisor seeds the current sha when it arms, so it only ever fires on
  // a transition it observed. Give the boot arm time to land before committing.
  await expect
    .poll(() => fs.existsSync(path.join(repo, '.termpolis', 'workflows', '.triggers.json')), {
      timeout: 60_000,
      intervals: [500],
      message: 'the trigger supervisor never armed the repo from the saved session',
    })
    .toBe(true)

  expect(fs.existsSync(RUNS_FILE())).toBe(false)

  // A real commit, made entirely outside the app.
  fs.writeFileSync(path.join(repo, 'CHANGED.md'), 'second\n')
  git('add', '.')
  git('commit', '-qm', 'second')
  const sha = git('rev-parse', 'HEAD').trim()

  // The supervisor polls on a 15s ticker, so allow several passes.
  await expect
    .poll(() => (fs.existsSync(RUNS_FILE()) ? fs.readFileSync(RUNS_FILE(), 'utf8').trim() : ''), {
      timeout: 120_000,
      intervals: [1000],
      message: 'no run was recorded after a real commit',
    })
    .not.toBe('')

  const lines = fs.readFileSync(RUNS_FILE(), 'utf8').trim().split('\n').filter(Boolean)
  expect(lines.length).toBeGreaterThanOrEqual(1)
  const run = JSON.parse(lines[0])

  // It ran the right workflow, in the right directory, and it succeeded.
  expect(run.workflowId).toBe(WF_ID)
  expect(fs.realpathSync(run.cwd)).toBe(repo)
  expect(run.status).toBe('succeeded')
  expect(Array.isArray(run.steps) ? run.steps.length : 0).toBeGreaterThanOrEqual(1)

  // And the supervisor recorded the sha it fired on, so it won't fire again for
  // the same commit on the next tick.
  const state = JSON.parse(fs.readFileSync(path.join(repo, '.termpolis', 'workflows', '.triggers.json'), 'utf8'))
  expect(JSON.stringify(state)).toContain(sha)
})
