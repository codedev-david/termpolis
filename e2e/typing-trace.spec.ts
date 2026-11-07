/**
 * Typing-trace E2E (1.54.5, plan package P0) -- what only a real Electron main thread can prove.
 *
 * The unit suites prove the counters against a fake loop and the wiring against a mocked index.ts.
 * They cannot prove that Node's real event-loop histogram sees a real stall of the real main thread,
 * that a key stamped by the real renderer reaches the real main handler and is timed, that the stamped
 * key (every 10th printable one) still reaches the shell intact, or that switching the trace off in the
 * real app leaves typing exactly as it was. This spec does, counter by counter, on a real terminal:
 *
 *   1. diagnostics:collect carries the `typing` block, started, with a loop-delay window and memory.
 *   2. A typed line arrives intact (including its 10th, 20th and 30th keys, the stamped ones), the main
 *      handler counted every write, 1 printable key in 10 produced a T1, and the shell's echo produced
 *      a T2.
 *   3. A real 1.5 s block of the main thread (run inside main through the Playwright handle) shows up as
 *      a window whose max loop delay crosses one second, and only then (the count before it is the
 *      negative control).
 *   4. With TERMPOLIS_TYPING_TRACE=0 the app starts, types and answers diagnostics, and reports the
 *      trace as off: fail-open.
 *
 * Isolated --user-data-dir so it owns its own single-instance lock (mirrors terminal-focus.spec.ts).
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { quitApp, ensureE2eBuild } from './helpers/launch'

interface Typing {
  enabled: boolean
  started: boolean
  uptimeMs: number
  loopDelay: { last: { count: number; max: number } | null; minute: { windows: number; max: number; over250: number; over1000: number } | null }
  elu: number | null
  t1: { n: number; max: number }
  t2: { n: number; max: number }
  ipc: Record<string, { count: number; msSum: number; msMax: number }>
  memory: { freeMB: number; rssMB: number; heapUsedMB: number } | null
}

async function launch(extraEnv: Record<string, string> = {}): Promise<{ app: ElectronApplication; page: Page; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-typing-'))
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({
    terminals: [],
    workspaces: [],
    defaultShell: process.platform === 'win32' ? 'powershell' : 'bash',
    viewMode: 'tabs',
  }))
  const app = await electron.launch({
    args: [
      path.resolve('out/main/index.js'),
      `--user-data-dir=${dir}`,
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    ],
    env: { ...process.env, NODE_ENV: 'test', TERMPOLIS_TEST_AGENTS: '1', TERMPOLIS_TEST_TIMING: '1', ...extraEnv },
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

async function createTerminal(page: Page, name: string): Promise<void> {
  await page.locator('button:has-text("+ Add Terminal")').first().click()
  await page.waitForTimeout(400)
  const nameInput = page.locator('h2:has-text("New Terminal")').locator('..').locator('input').first()
  await nameInput.fill(name)
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await page.waitForTimeout(1500)
}

/** The visible terminal's text, from xterm's own buffer through the renderer's read-only test hook.
 *  Newlines are removed: a prompt long enough to wrap the typed line would otherwise split the marker
 *  across two buffer lines, and a split marker is not a lost key. */
async function terminalText(page: Page): Promise<string> {
  const text = await page.evaluate(
    () => (window as unknown as { __termpolis_terminal_text?: (id?: string) => string }).__termpolis_terminal_text?.() ?? '',
  )
  return text.replace(/\r?\n/g, '')
}

async function typing(page: Page): Promise<Typing> {
  const r = await page.evaluate(() => (window as unknown as { termpolis: { collectDiagnostics: () => Promise<{ success: boolean; data?: { typing?: unknown } }> } }).termpolis.collectDiagnostics())
  expect(r.success).toBe(true)
  expect(r.data?.typing).toBeDefined()
  return r.data!.typing as Typing
}

test.describe.serial('Typing trace in the real app', () => {
  test.setTimeout(180_000)
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

  test('1. diagnostics:collect carries a started typing block with a loop-delay window and memory', async () => {
    // One 5 s window and one 10 s memory sample have to pass before both are there.
    await expect.poll(async () => (await typing(page)).memory !== null, { timeout: 30_000 }).toBe(true)
    const t = await typing(page)
    expect(t.enabled).toBe(true)
    expect(t.started).toBe(true)
    expect(t.loopDelay.last).not.toBeNull()
    expect(t.loopDelay.last!.count).toBeGreaterThan(0)
    expect(t.memory!.rssMB).toBeGreaterThan(50) // an Electron main process is well past 50 MB
    expect(t.elu === null || (t.elu >= 0 && t.elu <= 1)).toBe(true)
    // 1.54.5 merge, seam 3: the memory passes' counters and the brain's host mode ride in the same record (numbers only).
    const extra = (t as unknown as { extra?: { passes?: { v?: number }; memoryHost?: { mode?: number; hosted?: boolean; onMain?: boolean } } }).extra
    expect(extra?.passes?.v).toBe(1)
    expect(typeof extra?.memoryHost?.mode).toBe('number')
    expect(typeof extra?.memoryHost?.onMain).toBe('boolean')
  })

  test('2. a typed line arrives intact, stamped keys are timed (1 in 10), and the echo is timed', async () => {
    await createTerminal(page, 'TraceA')
    const before = await typing(page)
    const marker = 'TRACE-' + 'x'.repeat(30) // 36 printable characters after "echo ": the 10th, 20th, 30th... are stamped
    await page.keyboard.type('echo ' + marker, { delay: 25 })
    await page.keyboard.press('Enter')
    // Nothing was lost on the way to the shell, the stamped keys included.
    await expect.poll(() => terminalText(page), { timeout: 20_000 }).toContain(marker)

    const after = await typing(page)
    const writes = after.ipc['terminal:write'].count - (before.ipc['terminal:write']?.count ?? 0)
    expect(writes).toBeGreaterThanOrEqual(41) // one write per key: 41 printable keys and the Enter
    const t1 = after.t1.n - before.t1.n
    expect(t1).toBeGreaterThanOrEqual(3) // 1 printable key in 10 carries a stamp: 41 keys, so 4
    expect(t1).toBeLessThanOrEqual(Math.ceil(writes / 10) + 1) // and not every key (the negative control)
    expect(after.t1.max).toBeLessThan(5_000) // a stamp is a few ms old, not a minute
    expect(after.t2.n).toBeGreaterThan(before.t2.n) // the shell echoed a stamped key
  })

  test('3. a real 1.5 s block of the main thread crosses one second in the next loop-delay window', async () => {
    const before = await typing(page)
    const over1000Before = before.loopDelay.minute?.over1000 ?? 0
    // Playwright's app.evaluate runs in the MAIN process: this holds its event loop for 1.5 s.
    // On Linux CI Playwright can lose its main-process context as the stall ends ("Execution context
    // was destroyed"): the block has run by then, and the poll below is what checks it was seen.
    await app.evaluate(() => { const end = Date.now() + 1500; while (Date.now() < end) { /* hold the thread */ } })
      .catch((e: Error) => { if (!/Execution context was destroyed/.test(e.message)) throw e })
    // The window the stall landed in closes on the next 5 s tick; poll rather than sleep.
    await expect.poll(async () => (await typing(page)).loopDelay.minute?.over1000 ?? 0, { timeout: 20_000 }).toBeGreaterThan(over1000Before)
    const after = await typing(page)
    expect(after.loopDelay.minute!.max).toBeGreaterThanOrEqual(1_000)
  })
})

test.describe.serial('Typing trace switched off', () => {
  test.setTimeout(120_000)
  let app: ElectronApplication
  let page: Page
  let dir: string

  test.beforeAll(async () => {
    ensureE2eBuild()
    ;({ app, page, dir } = await launch({ TERMPOLIS_TYPING_TRACE: '0' }))
  })

  test.afterAll(async () => {
    await quitApp(app)
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  test('4. TERMPOLIS_TYPING_TRACE=0: the app types as before and the block says the trace is off', async () => {
    await createTerminal(page, 'TraceOff')
    const marker = 'OFF-' + 'y'.repeat(30)
    await page.keyboard.type('echo ' + marker, { delay: 25 })
    await page.keyboard.press('Enter')
    await expect.poll(() => terminalText(page), { timeout: 20_000 }).toContain(marker)
    await page.waitForTimeout(6_000) // longer than a window: nothing may have been sampled
    const t = await typing(page)
    expect(t.enabled).toBe(false)
    expect(t.started).toBe(false)
    expect(t.loopDelay.last).toBeNull()
    expect(t.memory).toBeNull()
    expect(t.t1.n).toBe(0)
    expect(Object.keys(t.ipc)).toEqual([])
  })
})
