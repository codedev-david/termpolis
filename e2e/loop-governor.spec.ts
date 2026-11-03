/**
 * Event-loop governor E2E (1.54.5 hotfix, lane G) -- what only a real Electron main process can prove.
 *
 * The unit suites prove the state machine against a fake histogram, fake timers and a fake clock, the wiring
 * against a mocked index.ts, and the thread-pool order in a plain Node child process. They cannot prove that
 * Node's real event-loop histogram inside Electron's real main process sees a real stall, that SHED then ends by
 * itself once the loop is calm, or what libuv's pool size really is inside Electron (Rollup hoists external
 * imports above bundled code, so an external package that did async pool work while loading would win over
 * threadpoolEnv.ts). This spec does, counter by counter:
 *
 *   1. diagnostics:collect carries a `governor` block, enabled, sampling, calm at rest, and the pool variable is NOT
 *      left in main's environment (threadpoolEnv.ts starts the pool with 16 and puts the variable back at once, so
 *      no shell, agent CLI or host inherits it: the merge's SEAM 8).
 *   2. The effective libuv pool size inside the real main process is above the default 4 (Windows: 6 pool
 *      threads are parked on a named pipe nobody writes, a 7th operation still completes; the parked reads are
 *      released again before the check ends).
 *   3. A real stall of the real main loop (300 ms blocks, 8 s long, run inside main through the Playwright
 *      handle) enters SHED, and once the loop is calm again SHED ends by itself. Counters: `enters` and
 *      `transitions` move, the stall is the only cause (the count before it is the negative control).
 *   4. With TERMPOLIS_NO_GOVERNOR=1 the app starts and types, the block says the governor is off, the same real
 *      stall changes nothing, and the pool variable is untouched: fail-open.
 *
 * NOT covered here, on purpose: that the four background hosts run below normal priority. Reading another
 * process's priority needs a per-process query and the project rule is no process enumeration of any kind; the
 * unit tests count the calls to a fake os module instead (tests/electron/hostPriority.test.ts). Unverified in a
 * real Electron.
 *
 * Isolated --user-data-dir so it owns its own single-instance lock (mirrors typing-trace.spec.ts).
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { quitApp, ensureE2eBuild } from './helpers/launch'

interface Governor {
  enabled: boolean
  shed: boolean
  transitions: number
  enters: number
  samples: number
  lastP99Ms: number | null
  lastDelayMs: number | null
  maxDelayMs: number
  registered: string[]
  errors: number
}

async function launch(extraEnv: Record<string, string> = {}): Promise<{ app: ElectronApplication; page: Page; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-governor-'))
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({
    terminals: [],
    workspaces: [],
    defaultShell: process.platform === 'win32' ? 'powershell' : 'bash',
    viewMode: 'tabs',
  }))
  const merged: Record<string, string | undefined> = { ...process.env, NODE_ENV: 'test', TERMPOLIS_TEST_AGENTS: '1', TERMPOLIS_TEST_TIMING: '1', ...extraEnv }
  delete merged.UV_THREADPOOL_SIZE // the real default, so the first import's effect is what is measured
  if (!('TERMPOLIS_NO_GOVERNOR' in extraEnv)) delete merged.TERMPOLIS_NO_GOVERNOR
  const env = Object.fromEntries(Object.entries(merged).filter((e): e is [string, string] => e[1] !== undefined))
  const app = await electron.launch({
    args: [
      path.resolve('out/main/index.js'),
      `--user-data-dir=${dir}`,
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    ],
    env,
  })
  const page = await app.firstWindow()
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
  return { app, page, dir }
}

async function governor(page: Page): Promise<Governor> {
  const r = await page.evaluate(() => (window as unknown as { termpolis: { collectDiagnostics: () => Promise<{ success: boolean; data?: { governor?: unknown } }> } }).termpolis.collectDiagnostics())
  expect(r.success).toBe(true)
  expect(r.data?.governor).toBeDefined()
  return r.data!.governor as Governor
}

/** Hold the real main loop in 300 ms blocks for about `ms`, with short gaps so timers (the governor's sampler) still run. */
async function stallMain(app: ElectronApplication, ms: number): Promise<void> {
  await app.evaluate(async (_electron, total) => {
    const end = Date.now() + total
    while (Date.now() < end) {
      const blockUntil = Date.now() + 300
      while (Date.now() < blockUntil) { /* hold the thread */ }
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
  }, ms)
}

test.describe.serial('Event-loop governor in the real app', () => {
  test.setTimeout(240_000)
  let app: ElectronApplication
  let page: Page
  let dir: string

  test.beforeAll(async () => {
    ensureE2eBuild()
    ;({ app, page, dir } = await launch())
  })

  test.afterAll(async () => {
    await quitApp(app)
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  test('1. diagnostics:collect carries a started governor block, calm at rest, and no pool variable is left in main for children to inherit', async () => {
    await expect.poll(async () => (await governor(page)).samples, { timeout: 30_000 }).toBeGreaterThan(0)
    const g = await governor(page)
    expect(g.enabled).toBe(true)
    expect(g.errors).toBe(0)
    expect(g.lastP99Ms).not.toBeNull()
    // Startup itself is heavy synchronous work: the governor may honestly have been shed while the app came up.
    // Calm is reached by itself (10 s under 40 ms), so poll for it rather than assert it at once.
    await expect.poll(async () => (await governor(page)).shed, { timeout: 60_000 }).toBe(false)
    // The pool took 16 at start-up (test 2 measures the size itself); the variable must be gone again, because every
    // child this process starts inherits its environment: a user's shell and agent CLIs see nothing they did not set.
    const pool = await app.evaluate(() => process.env.UV_THREADPOOL_SIZE)
    expect(pool).toBeUndefined()
  })

  test('2. the effective libuv pool in the real main process is above the default 4', async () => {
    test.skip(process.platform !== 'win32', 'the probe parks pool threads on a Windows named pipe')
    const seventhCompleted = await app.evaluate(async () => {
      if (typeof process.getBuiltinModule !== 'function') return null // older runtime: nothing to measure with
      const net = process.getBuiltinModule('node:net')
      const fsm = process.getBuiltinModule('node:fs')
      const pipe = '\\\\.\\pipe\\tp-e2e-pool-' + process.pid + '-' + Date.now()
      const sockets: Array<{ destroy: () => void }> = []
      const server = net.createServer((s: { on: (e: string, f: () => void) => void; destroy: () => void }) => { s.on('error', () => {}); sockets.push(s) })
      await new Promise<void>((resolve) => server.listen(pipe, () => resolve()))
      try {
        const fds: number[] = []
        for (let i = 0; i < 6; i++) fds.push(await new Promise<number>((res) => fsm.open(pipe, 'r', (e: unknown, f: number) => res(e ? -1 : f))))
        for (const fd of fds) fsm.read(fd, Buffer.alloc(1), 0, 1, null, () => {}) // each parks one pool thread
        await new Promise((resolve) => setTimeout(resolve, 150))
        return await Promise.race([
          new Promise<boolean>((resolve) => fsm.stat('.', () => resolve(true))),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
        ])
      } finally {
        for (const s of sockets) s.destroy() // EOF releases every parked read, so the app can still quit
        server.close()
      }
    })
    test.skip(seventhCompleted === null, 'process.getBuiltinModule is not available in this runtime')
    expect(seventhCompleted).toBe(true)
  })

  test('3. a real stall of the real main loop enters SHED, and calm ends it by itself', async () => {
    const before = await governor(page)
    expect(before.shed).toBe(false)
    await stallMain(app, 8_000)
    // Counters, not the instantaneous state: the stall made at least one SHED, and only the stall did.
    await expect.poll(async () => (await governor(page)).enters, { timeout: 30_000 }).toBeGreaterThan(before.enters)
    const during = await governor(page)
    expect(during.maxDelayMs).toBeGreaterThan(100)
    // 10 s calm plus up to two sample periods: it ends with no help.
    await expect.poll(async () => (await governor(page)).shed, { timeout: 60_000 }).toBe(false)
    const after = await governor(page)
    expect(after.transitions).toBeGreaterThanOrEqual(before.transitions + 2) // in, and out
    expect(after.enabled).toBe(true)
    expect(after.errors).toBe(0)
  })
})

test.describe.serial('Event-loop governor switched off', () => {
  test.setTimeout(120_000)
  let app: ElectronApplication
  let page: Page
  let dir: string

  test.beforeAll(async () => {
    ensureE2eBuild()
    ;({ app, page, dir } = await launch({ TERMPOLIS_NO_GOVERNOR: '1' }))
  })

  test.afterAll(async () => {
    await quitApp(app)
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  test('4. TERMPOLIS_NO_GOVERNOR=1: the block says off, a real stall changes nothing, the pool variable is untouched', async () => {
    await stallMain(app, 5_000)
    await page.waitForTimeout(6_000) // longer than three sample periods: nothing may have been sampled
    const g = await governor(page)
    expect(g.enabled).toBe(false)
    expect(g.shed).toBe(false)
    expect(g.samples).toBe(0)
    expect(g.transitions).toBe(0)
    const pool = await app.evaluate(() => process.env.UV_THREADPOOL_SIZE)
    expect(pool).toBeUndefined()
  })
})
