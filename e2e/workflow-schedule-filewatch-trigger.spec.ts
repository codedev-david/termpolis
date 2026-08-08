/**
 * schedule (cron) + fileWatch triggers — end-to-end, against a real clock and a
 * real filesystem.
 *
 * `workflow-git-trigger.spec.ts` proves the git half of the supervisor against a
 * real repository. This is its sibling for the other two automatic triggers, and
 * it exists for the same reason: the unit suites drive `TriggerSupervisor` with
 * an injected clock, an injected `setTimer`, and an injected `watch`, so every
 * one of them would still pass if `fsWatch(dir, {recursive:true})` threw on this
 * platform or if the cron ticker were never started. Neither of those is a
 * hypothetical — recursive `fs.watch` is a Node ≥20.13 feature on Linux, and the
 * ticker lives in `app.whenReady()`, which no unit test executes.
 *
 * So this spec wires nothing up itself. It drops three workflows on disk, points
 * a saved session at the project so the BOOT FAN-OUT arms them, launches the real
 * app, and then just waits for the real ticker and the real watcher:
 *
 *   1. a `* * * * *` schedule fires on its own, with no user action at all;
 *   2. writing a file under a fileWatch workflow's `paths` prefix fires it;
 *   3. writing outside that prefix does NOT fire it, but DOES fire the
 *      whole-project fileWatch workflow — so the prefix filter is a filter and
 *      not an accident of ordering;
 *   4. writing inside `.termpolis` fires NOTHING, which is the ignore-list rule
 *      the whole feature depends on: run history lives in `.termpolis`, so a
 *      fileWatch workflow that saw its own history would retrigger forever.
 *
 * Ubuntu/macOS only in CI, matching workflow-git-trigger: headless Windows can't
 * drive the app reliably and the subject here is the supervisor, not the platform.
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import os from 'os'

let app: ElectronApplication | null = null
let page: Page | null = null
let isolatedUserData = ''
let project = ''

const SCHED_ID = 'e2esched'
const WATCH_ID = 'e2ewatch'
const WATCH_ALL_ID = 'e2ewatchall'

const runsFile = (id: string): string =>
  path.join(project, '.termpolis', 'workflows', 'runs', `${id}.jsonl`)

/** How many runs a workflow has recorded so far. Absent file = none yet. */
function runCount(id: string): number {
  const f = runsFile(id)
  if (!fs.existsSync(f)) return 0
  return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).length
}

function lastRun(id: string): Record<string, unknown> {
  const lines = fs.readFileSync(runsFile(id), 'utf8').trim().split('\n').filter(Boolean)
  return JSON.parse(lines[lines.length - 1])
}

/**
 * The version the RUNNING BUILD reports. `app.getVersion()` is Electron's own
 * version when Playwright launches `out/main/index.js` (there's no package.json
 * at that path), so this has to be asked of the app rather than read from disk,
 * keeping the seeded `session.json` a faithful fixture. The terminal it seeds is
 * never reopened — the supervisor only arms the project at its cwd.
 */
async function probeAppVersion(): Promise<string> {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-trigwf-probe-'))
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

/** A control-only workflow. Command and Agent steps drive a pty, and a headless
 *  runner's pty `onExit` is not dependable — the trigger is what's under test, so
 *  the body is deliberately the cheapest step that can succeed. */
function workflowYaml(id: string, name: string, trigger: string[]): string {
  return [
    `id: ${id}`,
    `name: ${name}`,
    'version: 1',
    'trigger:',
    ...trigger,
    'steps:',
    '  - id: note',
    '    type: control',
    '    name: Note',
    '    action: notify',
    '    config:',
    `      message: '${id} fired in \${project.name}'`,
    '',
  ].join('\n')
}

test.beforeAll(async () => {
  // A build plus two Electron launches does not fit the config's 120s hook budget
  // on a cold runner.
  test.setTimeout(300_000)
  const { execSync } = await import('child_process')
  execSync('npx electron-vite build', { cwd: path.resolve('.'), stdio: 'pipe' })

  const appVersion = await probeAppVersion()

  // ── a real project directory ──────────────────────────────────────────────
  // realpath because macOS hands out /var/... symlinks for tmpdir and the
  // supervisor keys projects by the path it was given.
  project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-trigwf-')))
  fs.mkdirSync(path.join(project, 'src'), { recursive: true })
  fs.mkdirSync(path.join(project, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(project, 'src', 'seed.ts'), 'export const seed = 1\n')
  fs.writeFileSync(path.join(project, 'docs', 'seed.md'), '# seed\n')

  // ── the workflows, written straight to disk ───────────────────────────────
  // Authoring through the UI is covered by workflow-orchestrator; the triggers
  // are the subject here, so the definitions are fixtures.
  const wfDir = path.join(project, '.termpolis', 'workflows')
  fs.mkdirSync(wfDir, { recursive: true })
  fs.writeFileSync(
    path.join(wfDir, `${SCHED_ID}.yml`),
    workflowYaml(SCHED_ID, 'E2E Every Minute', ['  type: schedule', '  config:', "    cron: '* * * * *'"]),
  )
  // `paths: src` — only changes under src/ count.
  fs.writeFileSync(
    path.join(wfDir, `${WATCH_ID}.yml`),
    workflowYaml(WATCH_ID, 'E2E Watch src', ['  type: fileWatch', '  config:', '    paths: src', "    debounceMs: '500'"]),
  )
  // No `paths` — the whole project, which is what makes the `.termpolis`
  // ignore-list assertion meaningful.
  fs.writeFileSync(
    path.join(wfDir, `${WATCH_ALL_ID}.yml`),
    workflowYaml(WATCH_ALL_ID, 'E2E Watch All', ['  type: fileWatch', '  config:', "    debounceMs: '500'"]),
  )

  // ── the app profile ───────────────────────────────────────────────────────
  isolatedUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-trigwf-ud-'))
  // A saved terminal in the project is the ONLY thing that arms it: nothing in
  // this spec ever opens the project in the UI. That boot fan-out is part of
  // what's under test.
  fs.writeFileSync(
    path.join(isolatedUserData, 'session.json'),
    JSON.stringify({
      appVersion,
      terminals: [{ id: 't1', title: 'project', cwd: project, shell: 'bash' }],
      workspaces: [],
      defaultShell: 'bash',
      viewMode: 'tabs',
    }),
  )
  // An untrusted workspace never auto-runs anything — that gate is unit-tested;
  // here it just needs to be satisfied so the runs can actually happen.
  fs.writeFileSync(path.join(isolatedUserData, 'trusted-workspaces.json'), JSON.stringify({ paths: [project] }))

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

  // The supervisor writes its state file the moment it arms a project. Nothing
  // downstream can pass before that, so wait for it once here rather than in
  // every test.
  await expect
    .poll(() => fs.existsSync(path.join(project, '.termpolis', 'workflows', '.triggers.json')), {
      timeout: 60_000,
      intervals: [500],
      message: 'the trigger supervisor never armed the project from the saved session',
    })
    .toBe(true)
})

test.afterAll(async () => {
  try { await app?.close() } catch { /* already gone */ }
  for (const d of [project, isolatedUserData]) {
    try { if (d) fs.rmSync(d, { recursive: true, force: true }) } catch { /* temp dir */ }
  }
})

test('a `* * * * *` schedule fires on the real ticker with no user action', async () => {
  // The supervisor seeds lastFiredAt when it arms, so the earliest possible fire
  // is the first tick after the next minute boundary: <=60s of clock plus one
  // 15s tick. Three minutes is slack for a loaded runner, not an expectation.
  test.setTimeout(240_000)

  await expect
    .poll(() => runCount(SCHED_ID), {
      timeout: 180_000,
      intervals: [1000],
      message: 'the cron schedule never fired — the ticker is not running in the real app',
    })
    .toBeGreaterThan(0)

  const run = lastRun(SCHED_ID)
  expect(run.workflowId).toBe(SCHED_ID)
  expect(fs.realpathSync(String(run.cwd))).toBe(project)
  expect(run.status).toBe('succeeded')
  expect(Array.isArray(run.steps) ? (run.steps as unknown[]).length : 0).toBeGreaterThanOrEqual(1)

  // And the fire was recorded, which is what stops it re-firing for the same
  // minute on the next tick.
  const state = JSON.parse(fs.readFileSync(path.join(project, '.termpolis', 'workflows', '.triggers.json'), 'utf8'))
  expect(typeof state[SCHED_ID]?.lastFiredAt).toBe('number')
  expect(state[SCHED_ID].lastFiredAt).toBeGreaterThan(0)
})

test('writing under the watched prefix fires the fileWatch workflow', async () => {
  test.setTimeout(120_000)

  const before = runCount(WATCH_ID)
  fs.writeFileSync(path.join(project, 'src', 'touched.ts'), `export const at = ${Date.now()}\n`)

  await expect
    .poll(() => runCount(WATCH_ID), {
      timeout: 60_000,
      intervals: [500],
      message: 'a write under src/ never reached the recursive watcher',
    })
    .toBeGreaterThan(before)

  const run = lastRun(WATCH_ID)
  expect(run.workflowId).toBe(WATCH_ID)
  expect(fs.realpathSync(String(run.cwd))).toBe(project)
  expect(run.status).toBe('succeeded')
})

test('a write outside the prefix is filtered out, but still reaches the whole-project watcher', async () => {
  test.setTimeout(120_000)

  // The previous test just fired the whole-project workflow, and the supervisor
  // throttles re-fires (MIN_REFIRE_MS). A fileWatch event is delivered once, on
  // a one-shot debounce timer — if the throttle swallows it there is no retry —
  // so wait the throttle out before writing, or this test is a coin flip.
  await page!.waitForTimeout(6_000)

  const watchBefore = runCount(WATCH_ID)
  const allBefore = runCount(WATCH_ALL_ID)

  fs.writeFileSync(path.join(project, 'docs', 'notes.md'), `changed ${Date.now()}\n`)

  // The unfiltered workflow proves the event was delivered at all — without it,
  // "src-only didn't fire" would be indistinguishable from "the watcher is dead".
  await expect
    .poll(() => runCount(WATCH_ALL_ID), {
      timeout: 60_000,
      intervals: [500],
      message: 'the whole-project fileWatch workflow never saw the docs/ write',
    })
    .toBeGreaterThan(allBefore)

  expect(runCount(WATCH_ID)).toBe(watchBefore)
})

test('churn inside .termpolis fires nothing — the rule that stops a watcher feeding itself', async () => {
  test.setTimeout(120_000)

  // Settle first: the previous test's event may still be inside the debounce
  // window, and a run that lands after the baseline is read would be misread as
  // this write's doing.
  await page!.waitForTimeout(5_000)
  const allBefore = runCount(WATCH_ALL_ID)
  const watchBefore = runCount(WATCH_ID)

  // A write to exactly the kind of file the app itself writes constantly.
  fs.writeFileSync(path.join(project, '.termpolis', 'workflows', 'runs', 'ignored-marker.txt'), `x ${Date.now()}\n`)

  // Well past the 500ms debounce and the 3s minimum-refire floor. If the ignore
  // list were broken this would already have fired several times over.
  await page!.waitForTimeout(15_000)

  expect(runCount(WATCH_ALL_ID)).toBe(allBefore)
  expect(runCount(WATCH_ID)).toBe(watchBefore)
})
