/**
 * Shared Electron launch args for e2e specs.
 *
 * Why this exists: 34 of the 52 specs on disk had never been executed by CI, and when
 * the whole directory was finally run every single one of them died at
 * `electron.launch: Process failed to launch!` — not on a stale assertion, but because
 * they launched with `args: [path.resolve('out/main/index.js')]` and nothing else:
 *
 *   - Linux CI runners have no usable sandbox for Electron, so the process exits
 *     immediately without `--no-sandbox`. Every spec CI *did* run already passed it;
 *     the ones it didn't run never learned.
 *   - Without `--user-data-dir` a spec shares the single-instance lock with any other
 *     Termpolis on the box — a developer's running app, or the previous spec still
 *     shutting down — and the second instance quits on startup, which surfaces as the
 *     same opaque launch failure.
 *
 * Centralising it means a new spec inherits both fixes instead of rediscovering them.
 */
import { test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { spawnSync, type ChildProcess } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

/**
 * Args for `electron.launch()`: the built main entry, a private user-data dir, and
 * `--no-sandbox` on Linux. `label` only shapes the temp dir name so a failed run is
 * traceable to the spec that made it.
 */
/** One temp profile per label, so a relaunch inside the same spec keeps its state. */
const userDataDirs = new Map<string, string>()

/**
 * The isolated Electron `userData` directory for `label`, created on first use.
 *
 * Under `--user-data-dir=X`, `app.getPath('userData')` IS `X` — so anything the app writes
 * into its profile (`mcp-token`, `session.json`, the memory store) lands directly in here.
 * Specs that need to seed or read those files must call this instead of hand-building
 * `~/AppData/Roaming/termpolis/...`: that path is Windows-only, and now that every spec
 * runs against its own profile it is also simply the wrong directory — it points at the
 * developer's REAL Termpolis profile, which the whole-suite run would then clobber.
 */
export function e2eUserDataDir(label = 'e2e'): string {
  let dir = userDataDirs.get(label)
  if (!dir) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), `termpolis-${label}-`))
    userDataDirs.set(label, dir)
  }
  return dir
}

export function e2eLaunchArgs(label = 'e2e'): string[] {
  return [
    path.resolve('out/main/index.js'),
    `--user-data-dir=${e2eUserDataDir(label)}`,
    ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
  ]
}

/**
 * Make `e2e/test-shims/claude` look like an installed Claude Code to BOTH consumers.
 *
 * `TERMPOLIS_TEST_SHIM_DIR` alone is not enough: terminalManager.ts prepends it to the
 * PATH of spawned PTYs only, while the Start Swarm wizard gates on `agents:detect`, which
 * runs `which claude` in the MAIN process against `getExtendedPath()` — built from
 * `process.env.PATH`. So on a runner with no real binary the wizard rendered
 * "Claude Code Required" and every swarm spec sat waiting for a Describe step that was
 * never going to come. Prepending the shim dir to PATH satisfies the detector too.
 */
export function e2eShimEnv(label = 'e2e'): {
  TERMPOLIS_TEST_SHIM_DIR: string
  TERMPOLIS_TEST_USER_DATA_DIR: string
  PATH: string
} {
  const shimDir = path.resolve('e2e', 'test-shims')
  // The Unix shim loses its +x bit through some npm/git paths.
  try { fs.chmodSync(path.join(shimDir, 'claude'), 0o755) } catch { /* windows / already set */ }
  const sep = process.platform === 'win32' ? ';' : ':'
  return {
    TERMPOLIS_TEST_SHIM_DIR: shimDir,
    // The mocks talk to the app's MCP server, whose token the app writes into its
    // userData dir. That used to be the OS default path, so `mock-claude.cjs` hardcoded
    // it; now every spec runs under its own `--user-data-dir`, and the mock died with
    // ENOENT on `~/.config/termpolis/mcp-token`. `label` MUST match the one passed to
    // `e2eLaunchArgs`, or the mock reads a profile the app never wrote to.
    TERMPOLIS_TEST_USER_DATA_DIR: e2eUserDataDir(label),
    PATH: `${shimDir}${sep}${process.env.PATH ?? ''}`,
  }
}

/**
 * Clear any full-screen overlay a previous test left up.
 *
 * `test.describe.serial` specs share one window, so a modal that one test leaves open
 * becomes the NEXT test's `locator.click: Timeout 30000ms exceeded` — the click lands on
 * a `fixed inset-0` backdrop instead of the button underneath, and the error names the
 * innocent button rather than the modal. Escape alone is not enough: InstallHint and the
 * close-confirm have no key handler and only close via their own control or a backdrop
 * click, so try the explicit dismiss button first and fall back to Escape, then the
 * backdrop corner. `pointer-events-none` overlays are decorative and never intercept.
 */
export async function dismissOverlays(page: Page, attempts = 4): Promise<void> {
  const overlay = page.locator('div.fixed.inset-0:not(.pointer-events-none)').first()
  for (let i = 0; i < attempts; i++) {
    if (!(await overlay.isVisible({ timeout: 500 }).catch(() => false))) return
    // The agent review's "Not now" / "Disconnect" would decline the agents, so answer it
    // the way dismissOnboarding does rather than with the generic dismiss below.
    const keepAgents = page.locator('[data-testid="agent-review-connect"]')
    if (await keepAgents.isVisible({ timeout: 200 }).catch(() => false)) {
      await keepAgents.click({ timeout: 2000 }).catch(() => {})
      await page.waitForTimeout(300)
      continue
    }
    const dismiss = page
      .locator('div.fixed.inset-0 button')
      .filter({ hasText: /^(Cancel|Close|Dismiss|Not now|Skip tour)$/ })
      .first()
    if (await dismiss.isVisible({ timeout: 500 }).catch(() => false)) {
      await dismiss.click({ timeout: 2000 }).catch(() => {})
    } else {
      await page.keyboard.press('Escape')
      await page.waitForTimeout(200)
      if (await overlay.isVisible({ timeout: 500 }).catch(() => false)) {
        await overlay.click({ position: { x: 5, y: 5 }, timeout: 2000 }).catch(() => {})
      }
    }
    await page.waitForTimeout(300)
  }
}

/**
 * Clear the first-run onboarding tour before a spec touches the UI.
 *
 * `OnboardingModal` renders `fixed inset-0 z-[200] bg-black/80` whenever
 * `termpolis.onboarding.seen.v1` is absent from localStorage — a full-screen overlay that
 * swallows every pointer event underneath it. Each spec now launches with its own fresh
 * `--user-data-dir` (see above), so localStorage starts empty on EVERY run and the tour is
 * always up. That single overlay accounted for the large majority of the whole-suite
 * failures: ~108 `locator.click: Timeout 30000ms exceeded` plus the
 * `strict mode violation: 'Welcome to Termpolis' resolved to 2 elements` cases, where the
 * modal heading collided with the welcome screen's.
 *
 * Writing the flag stops it coming back after a reload; clicking "Skip tour" clears the
 * instance that is already mounted. Both are needed, and both are safe to run when the
 * tour never appeared.
 *
 * Skipping the tour answers its first step as shown, which CONNECTS the agents — config
 * writes that land in the global-setup scratch home, never the real one. A spec asserting
 * the state before anyone answers must not call this (see mcp-registration.spec.ts).
 */
export async function dismissOnboarding(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded').catch(() => {})
  await page.evaluate(() => {
    try {
      localStorage.setItem('termpolis.onboarding.seen.v1', '1')
      localStorage.setItem('termpolis.telemetry.optIn', '0')
    } catch { /* renderer not ready yet — the click path below still clears it */ }
  }).catch(() => {})

  const dialog = page.locator('[aria-labelledby="onboarding-title"]')
  if (await dialog.isVisible().catch(() => false)) {
    // One click closes it; the loop only guards against a tour that someday needs two.
    for (let i = 0; i < 3 && (await dialog.isVisible().catch(() => false)); i++) {
      await page.locator('button:has-text("Skip tour")').first().click({ force: true }).catch(() => {})
      await dialog.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {})
    }
    return
  }
  // No tour means this userData dir has launched before — the only case where the one-time
  // reviews can open (App.tsx decides at first render). Both wait on an IPC round trip.
  const agentReview = page.locator('[aria-labelledby="agent-review-title"]')
  if (await agentReview.waitFor({ state: 'visible', timeout: 1500 }).then(() => true, () => false)) {
    // Answer the way the tour's defaults do, so a spec sees the same agents either way.
    await page.locator('[data-testid="agent-review-connect"]').click({ force: true }).catch(() => {})
    await agentReview.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {})
  }
  const consentReview = page.locator('[data-testid="consent-review-modal"]')
  if (await consentReview.isVisible().catch(() => false)) {
    await consentReview.locator('button:has-text("Not now")').click({ force: true }).catch(() => {})
    await consentReview.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {})
  }
}

/** A healthy quit takes about a second, and the app's own shutdown watchdogs give up at 5. */
const QUIT_TIMEOUT_MS = 20_000

/**
 * End a spec's app: `app.close()`, but never for longer than QUIT_TIMEOUT_MS.
 *
 * Playwright's close() has main call app.quit() and then waits, with no limit, for the process's
 * `close` event. That needs more than the main process exiting: every process that inherited its
 * stdout and stderr has to let go of them too. About one e2e job in ten one of those two never
 * happened: every test in the spec had passed, and the shard still went red on "Worker teardown
 * timeout of 120000ms exceeded". A quit that overruns is written up in
 * test-results/teardown-hangs/ (the main process's last `[shutdown]` lines, whether it exited,
 * what still holds its output pipes, a native backtrace where gdb can attach) and then ended
 * outright, so the next one names where it stuck instead of failing a shard.
 */
export async function quitApp(app: ElectronApplication | null | undefined): Promise<void> {
  if (!app) return
  const proc = app.process()
  // The app's ends of the pipes Playwright gave it, read while it is surely still alive, so that
  // a hang report can say which processes still hold them. Five, not three: Playwright starts
  // Electron with fds 3 and 4 open as well, nothing in the app closes them, and every child that
  // main spawns (a PTY's shell, a git call) inherits them.
  const outputEnds = process.platform === 'linux' && proc.pid !== undefined
    ? [1, 2, 3, 4].map(fd => safeReadlink(`/proc/${proc.pid}/fd/${fd}`)).filter(link => link.startsWith('pipe:') || link.startsWith('socket:'))
    : []
  const output: string[] = []
  const keep = (chunk: Buffer | string): void => {
    for (const line of chunk.toString().split(/\r?\n/)) if (line.trim()) output.push(line)
    if (output.length > 400) output.splice(0, output.length - 400)
  }
  proc.stdout?.on('data', keep)
  proc.stderr?.on('data', keep)
  const closed = app.close().then(() => true, () => true)
  const inTime = await Promise.race([closed, sleep(QUIT_TIMEOUT_MS).then(() => false)])
  if (!inTime) {
    reportQuitHang(proc, output, outputEnds)
    killTree(proc)
    await Promise.race([new Promise(resolve => proc.once('exit', resolve)), sleep(5_000)])
    // Whatever survived the kill may still hold the pipes: a PTY's shell, in a session of its own
    // that the group kill doesn't reach, or a child of it. close() waits for every one of the
    // five, so closing our ends is what ends that wait.
    for (const stream of proc.stdio) (stream as { destroy?: () => void } | null)?.destroy?.()
    await Promise.race([closed, sleep(10_000)])
  }
  proc.stdout?.off('data', keep)
  proc.stderr?.off('data', keep)
}

/** The one failure probeAppVersion retries: the main process's context torn down mid-evaluate. */
const CONTEXT_DESTROYED = /Execution context was destroyed/
const PROBE_ATTEMPTS = 3

/**
 * The version the RUNNING BUILD reports, asked of a short throwaway launch, so a spec that seeds
 * `session.json` writes a faithful fixture rather than an invented one.
 *
 * `app.getVersion()` reads the package.json next to the app path. Launched unpackaged the way
 * Playwright does it, the app path is `out/main` — which has no package.json — so Electron falls
 * back to reporting its OWN version, NOT the one in the repo's package.json. Guessing from
 * package.json therefore writes a session the app throws away, and the spec fails for a reason
 * that has nothing to do with what it tests.
 *
 * Bounded every way it can hang or flake, because it runs in a beforeAll that takes the whole file
 * down with it:
 *  - it asks only once the first window is up. Asked straight after launch on a cold Windows
 *    runner, the main process's context was once destroyed mid-evaluate, and all four tests in
 *    workflow-schedule-filewatch-trigger were skipped;
 *  - that error, and only that one, gets up to PROBE_ATTEMPTS launches. Anything else is a real
 *    failure — a startup crash must still fail the spec — and is thrown at once;
 *  - every launch ends through quitApp, never an unbounded close().
 *
 * Its own user-data dir per launch, so the session it writes on quit can never touch a fixture.
 * `label` only shapes that temp dir's name.
 */
export async function probeAppVersion(label = 'probe'): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const ud = fs.mkdtempSync(path.join(os.tmpdir(), `termpolis-${label}-`))
    let probe: ElectronApplication | undefined
    try {
      probe = await electron.launch({
        args: [
          path.resolve('out/main/index.js'),
          `--user-data-dir=${ud}`,
          ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
        ],
        env: { ...process.env, NODE_ENV: 'test', TERMPOLIS_TEST_AGENTS: '1', TERMPOLIS_SMOKE_SKIP_PICKERS: '1' },
      })
      await probe.firstWindow()
      return await probe.evaluate(({ app }) => app.getVersion())
    } catch (e) {
      if (attempt >= PROBE_ATTEMPTS || !CONTEXT_DESTROYED.test((e as Error)?.message ?? '')) throw e
    } finally {
      await quitApp(probe)
      try { fs.rmSync(ud, { recursive: true, force: true }) } catch { /* temp dir */ }
    }
  }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** The app and every process under it. Off Windows, Playwright starts Electron as a process-group
 *  leader, so the group is the tree; on Windows the pid is cmd.exe, and only taskkill /T reaches
 *  the electron.exe beneath it. */
function killTree(proc: ChildProcess): void {
  if (proc.pid === undefined) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { timeout: 10_000 })
    return
  }
  try { process.kill(-proc.pid, 'SIGKILL') } catch { /* the group is gone; the leader may not be */ }
  try { proc.kill('SIGKILL') } catch { /* already gone */ }
}

function reportQuitHang(proc: ChildProcess, output: string[], outputEnds: string[]): void {
  let spec = 'unknown-spec'
  try { spec = path.basename(test.info().file, '.ts') } catch { /* not inside a test or hook */ }
  const pid = proc.pid ?? 0
  const exited = proc.exitCode !== null || proc.signalCode !== null
  const state = exited
    ? `main process ${pid} HAD exited (code ${proc.exitCode}, signal ${proc.signalCode}), but something still held the pipes Playwright gave it`
    : `main process ${pid} was still running`
  const lines = [
    `${spec}: app.close() had not returned after ${QUIT_TIMEOUT_MS / 1000}s; ${state}.`,
    '',
    '--- main process output since close() was called:',
    ...(output.length > 0 ? output.slice(-150) : ['(none)']),
    ...(process.platform === 'linux' ? linuxProcessState(proc, exited, outputEnds) : []),
  ]
  const file = path.resolve('test-results', 'teardown-hangs', `${spec}-${pid}.txt`)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${lines.join('\n')}\n`)
  } catch { /* the console copy below still has the gist */ }
  const steps = output.filter(line => line.includes('[shutdown]')).slice(-12)
  console.error([
    `::warning title=e2e quit hang::${spec}: app.close() overran ${QUIT_TIMEOUT_MS / 1000}s (${exited ? 'main had exited' : 'main still running'}); killed. Details: ${path.relative(process.cwd(), file)}`,
    ...(steps.length > 0 ? steps : ['(the main process printed no [shutdown] line while closing)']),
  ].join('\n'))
}

/**
 * What a stuck Linux main process is doing: its process group, every thread, and a backtrace.
 * Bounded to about a minute, so the wait, this and the kill stay inside the hook's 120s timeout.
 */
function linuxProcessState(proc: ChildProcess, exited: boolean, outputEnds: string[]): string[] {
  const pid = proc.pid ?? 0
  const read = (file: string): string => { try { return fs.readFileSync(file, 'utf8') } catch { return '' } }
  const run = (cmd: string, args: string[], timeout = 10_000): string => {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout })
    return r.error ? `(${cmd} failed: ${r.error.message})` : `${r.stdout ?? ''}${r.stderr ?? ''}`.trimEnd()
  }

  // ps -g means different things to different procps builds, so filter by pgid/ppid here.
  const rows = run('ps', ['-e', '-o', 'pid=,ppid=,pgid=,stat=,etime=,wchan:24=,args=']).split('\n')
  const group = rows.filter(row => {
    const [p, pp, pg] = row.trim().split(/\s+/).map(Number)
    return p === pid || pg === pid || pp === pid
  })

  const threads: string[] = []
  let tids: string[] = []
  try { tids = fs.readdirSync(`/proc/${pid}/task`) } catch { /* already gone */ }
  for (const tid of tids) {
    const base = `/proc/${pid}/task/${tid}`
    const stat = read(`${base}/stat`)
    const state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] || '?'
    const syscall = read(`${base}/syscall`).split(' ')[0] || '?'
    threads.push(`${tid.padStart(7)} ${state} wchan=${read(`${base}/wchan`).trim() || '-'} syscall=${syscall} ${read(`${base}/comm`).trim()}`)
  }

  // Who still holds the app's ends of its output pipes (socketpairs, under libuv: our ends have
  // other inodes). After the main process has gone, these are the whole story.
  const holders: string[] = []
  const inodes = outputEnds
  if (inodes.length > 0) {
    let pids: string[] = []
    try { pids = fs.readdirSync('/proc').filter(name => /^\d+$/.test(name)) } catch { /* no procfs */ }
    for (const other of pids) {
      if (Number(other) === process.pid) continue
      let fds: string[] = []
      try { fds = fs.readdirSync(`/proc/${other}/fd`) } catch { continue }
      if (!fds.some(fd => inodes.includes(safeReadlink(`/proc/${other}/fd/${fd}`)))) continue
      holders.push(`${other.padStart(7)} ${read(`/proc/${other}/cmdline`).split('\0').join(' ').trim().slice(0, 300)}`)
    }
  }

  const gdb = run('sh', ['-c', 'command -v gdb'])
  const backtrace = exited ? '(main had already exited)' : gdb.startsWith('/')
    ? run('sudo', ['-n', 'gdb', '-p', String(pid), '-batch', '-nx', '-ex', 'set pagination off',
      '-ex', 'info threads', '-ex', 'thread apply all bt 30'], 30_000)
    : '(gdb is not installed)'

  return [
    '',
    `--- processes still holding the app's fds 1-4 (${inodes.join(', ') || 'pipe inode unknown'}):`,
    ...(holders.length > 0 ? holders : ['(none)']),
    '',
    `--- /proc/${pid}/status:`,
    ...read(`/proc/${pid}/status`).split('\n').filter(l => /^(State|Threads|SigPnd|ShdPnd|SigBlk):/.test(l)),
    '',
    '--- its process group and children (pid ppid pgid stat elapsed wchan args):',
    ...(group.length > 0 ? group : ['(none)']),
    '',
    `--- its ${threads.length} threads (tid state wchan syscall name):`,
    ...threads,
    '',
    '--- kernel stack of the main thread:',
    run('sudo', ['-n', 'cat', `/proc/${pid}/stack`]),
    '',
    '--- gdb:',
    backtrace,
  ]
}

function safeReadlink(file: string): string {
  try { return fs.readlinkSync(file) } catch { return '' }
}
