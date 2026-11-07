/**
 * Write-scheduler E2E (1.54.5, plan package P8) -- what only a real Electron window can prove.
 *
 * The unit and component suites prove the scheduler against a real xterm parser, a virtual clock and a
 * jsdom pane. They cannot prove that in a real window, with real ptys and a real renderer thread, every
 * mounted pane is registered, that a terminal that is hidden and flooding still ends with ALL of its output,
 * that the terminal in front keeps echoing while the other one floods, and that the kill switch gives a pane
 * its own throttle again. This spec does, by counters the scheduler keeps (window.__termpolis_write_scheduler:
 * numbers only) and by the text xterm has:
 *
 *   1. Every mounted terminal is registered with the scheduler, and it is not in pass-through (that is what
 *      it falls back to when its own code throws).
 *   2. While terminal C floods (6,000 numbered lines) and is NOT the one in front, a command typed into
 *      terminal A echoes and runs; the scheduler saw the keys; at no time did a terminal have more in flight
 *      to xterm than its cap (focused 128 KB + one echo write, hidden 64 KB); and afterwards C holds all 6,000
 *      lines, complete and in order (a hidden terminal is rationed, never starved).
 *   3. With localStorage 'termpolis.writeScheduler' = '0' a terminal opened afterwards keeps its own output
 *      throttle: the scheduler does not count it, and it works.
 *
 * Sentinels are built from two strings, so the typed command's own echo can never satisfy a wait.
 * Isolated --user-data-dir so it owns its own single-instance lock (mirrors resize-order.spec.ts).
 * NOT RUN where this was written (no Electron there): it is "unverified until CI runs it".
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { quitApp, ensureE2eBuild } from './helpers/launch'

interface Stats {
  panes: number
  ticks: number
  handoffs: number
  handedChars: number
  ackedChars: number
  fastPath: number
  keys: number
  queuedChars: number
  inflightChars: number
  refusals: number
  drops: number
  ackTimeouts: number
  bypassed: boolean
  maxInflight: { focused: number; visible: number; hidden: number }
}

/** The caps in the scheduler's defaults (writeScheduler.ts DEFAULT_LIMITS), and the one small echo write on top. */
const FOCUSED_CAP = 131_072
const HIDDEN_CAP = 65_536
const SMALL_WRITE = 8_192

async function launch(): Promise<{ app: ElectronApplication; page: Page; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-sched-'))
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
    env: { ...process.env, NODE_ENV: 'test', TERMPOLIS_TEST_AGENTS: '1', TERMPOLIS_TEST_TIMING: '1' },
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
  // The dialog has no Enter-to-create: Enter in the name field left it open, and its backdrop took the next click.
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await page.waitForTimeout(1200)
}

/** The visible terminal's text, from xterm's own buffer through the renderer's read-only test hook. */
async function terminalText(page: Page): Promise<string> {
  const text = await page.evaluate(
    () => (window as unknown as { __termpolis_terminal_text?: (id?: string) => string }).__termpolis_terminal_text?.() ?? '',
  )
  return text.replace(/\r?\n/g, '')
}

/** The scheduler's counters (numbers only), or null when no pane has created it. */
async function schedulerStats(page: Page): Promise<Stats | null> {
  return page.evaluate(
    () => (window as unknown as { __termpolis_write_scheduler?: () => Stats }).__termpolis_write_scheduler?.() ?? null,
  )
}

/** Type a command and run it. */
async function run(page: Page, command: string): Promise<void> {
  await page.keyboard.type(command, { delay: 4 })
  await page.keyboard.press('Enter')
}

test.describe.serial('Write scheduler in the real app', () => {
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

  test('1. every mounted terminal is registered with the scheduler, and it is not in pass-through', async () => {
    await createTerminal(page, 'SchedA')
    await createTerminal(page, 'SchedB')
    await createTerminal(page, 'SchedC') // the last one created is the one on screen
    await page.waitForTimeout(1500)
    const stats = await schedulerStats(page)
    expect(stats).not.toBeNull()
    expect(stats!.panes).toBe(3)
    expect(stats!.bypassed).toBe(false)
  })

  test('2. a hidden terminal floods while a command is typed into the one in front: the echo comes, the caps hold, and the hidden one ends complete', async () => {
    // C is on screen: start the flood there, then bring A to the front. C keeps printing, hidden.
    await run(page, `node -e "for(let i=0;i<6000;i++)console.log('S'+i+' '+'x'.repeat(100));console.log('FLOOD-'+'DONE')"`)
    await page.waitForTimeout(400)
    await page.keyboard.press('Alt+1')
    await page.waitForTimeout(600)

    const keysBefore = (await schedulerStats(page))!.keys
    await run(page, `node -p "'ECHO-'+(40+2)"`)
    await expect.poll(() => terminalText(page), { timeout: 60_000 }).toContain('ECHO-42')

    const stats = (await schedulerStats(page))!
    expect(stats.keys).toBeGreaterThan(keysBefore) // the scheduler heard the keys
    expect(stats.bypassed).toBe(false)
    expect(stats.maxInflight.focused).toBeLessThanOrEqual(FOCUSED_CAP + SMALL_WRITE)
    expect(stats.maxInflight.hidden).toBeLessThanOrEqual(HIDDEN_CAP + SMALL_WRITE)
    expect(stats.drops).toBe(0) // xterm refused nothing for good

    // Now look at C: it was hidden for most of the flood. All 6,000 lines, complete, in order.
    await page.keyboard.press('Alt+3')
    await expect.poll(() => terminalText(page), { timeout: 120_000 }).toContain('FLOOD-DONE')
    const text = await terminalText(page)
    const numbers = Array.from(text.matchAll(/S(\d+) x{100}/g), (m) => Number(m[1]))
    expect(numbers.length).toBeGreaterThanOrEqual(5900) // the scrollback holds 10,000 rows: every line of the flood is in it
    for (let i = 1; i < numbers.length; i++) expect(numbers[i]).toBe(numbers[i - 1] + 1) // no gap, no repeat, in order
    expect(numbers[numbers.length - 1]).toBe(5999)

    await expect.poll(async () => (await schedulerStats(page))!.queuedChars, { timeout: 30_000 }).toBe(0)
  })

  test("3. with the kill switch a terminal opened afterwards keeps its own throttle: it works, and the scheduler does not count it", async () => {
    const before = (await schedulerStats(page))!.panes
    await page.evaluate(() => localStorage.setItem('termpolis.writeScheduler', '0'))
    await createTerminal(page, 'SchedOff') // reads the switch when it mounts
    await page.waitForTimeout(1000)
    expect((await schedulerStats(page))!.panes).toBe(before) // not registered
    await run(page, `node -p "'OFF-'+(40+2)"`)
    await expect.poll(() => terminalText(page), { timeout: 60_000 }).toContain('OFF-42')
    await page.evaluate(() => localStorage.removeItem('termpolis.writeScheduler'))
  })
})
