/**
 * Resize-order E2E (1.54.5, plan packages P2 and P3) -- what only a real Electron window can prove.
 *
 * The unit and component suites prove the ordering with a real xterm, a real FitAddon and the real output
 * throttle, but under jsdom: there is no layout, no real ResizeObserver, no real window, and no pty. They
 * cannot prove that a real window resize reaches a real pty the right number of times, or that after a
 * resize under real output the grid xterm shows and the size the shell's own child sees are the SAME
 * (the two disagreeing is the persistent garble: nothing repaints it). This spec does, counter by counter:
 *
 *   1. A window resize reaches the pty for the visible terminal only: with 3 terminals mounted, the main
 *      process counts 1 (at most 2) `terminal:resize` messages, not one per mounted pane.
 *   2. A resize made WHILE a flood of output is arriving leaves xterm's grid equal to the size the shell's
 *      child reports for its pty, and the output itself arrived (nothing lost to a throw in the flush).
 *   3. A terminal that was hidden through the resize fits when it is shown: its grid becomes the
 *      container's, and its shell sees that size.
 *
 * The size of the shell's pty is read by the shell: `node -p "process.stdout.columns"` reports it on
 * bash and PowerShell alike (ConPTY included). The sentinels are built from two strings so the typed
 * command's own echo can never satisfy the wait.
 *
 * Isolated --user-data-dir so it owns its own single-instance lock (mirrors typing-trace.spec.ts).
 * NOT RUN where this was written (no Electron there): it is "unverified until CI runs it".
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { quitApp, ensureE2eBuild } from './helpers/launch'

interface Grid { cols: number; rows: number }

async function launch(): Promise<{ app: ElectronApplication; page: Page; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-resize-'))
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
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await page.waitForTimeout(1500)
}

/** The visible terminal's text, from xterm's own buffer through the renderer's read-only test hook.
 *  Newlines are removed: a line the width of the pane that wraps would otherwise split a marker in two. */
async function terminalText(page: Page): Promise<string> {
  const text = await page.evaluate(
    () => (window as unknown as { __termpolis_terminal_text?: (id?: string) => string }).__termpolis_terminal_text?.() ?? '',
  )
  return text.replace(/\r?\n/g, '')
}

/** The grid xterm has for the terminal on screen (the renderer's read-only test hook). */
async function gridSize(page: Page): Promise<Grid | null> {
  return page.evaluate(
    () => (window as unknown as { __termpolis_terminal_size?: (id?: string) => Grid | null }).__termpolis_terminal_size?.() ?? null,
  )
}

/** How many `terminal:resize` messages the main process has handled so far (the typing trace counts them). */
async function resizeMessages(page: Page): Promise<number> {
  const r = await page.evaluate(
    () => (window as unknown as { termpolis: { collectDiagnostics: () => Promise<{ success: boolean; data?: { typing?: { ipc?: Record<string, { count: number }> } } }> } }).termpolis.collectDiagnostics(),
  )
  expect(r.success).toBe(true)
  return r.data?.typing?.ipc?.['terminal:resize']?.count ?? 0
}

async function windowSize(app: ElectronApplication): Promise<{ w: number; h: number }> {
  return app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    const [w, h] = win ? win.getSize() : [0, 0]
    return { w, h }
  })
}

async function resizeWindow(app: ElectronApplication, w: number, h: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, size) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) win.setSize(size.w, size.h)
  }, { w, h })
}

/** Type a command and run it. */
async function run(page: Page, command: string): Promise<void> {
  await page.keyboard.type(command, { delay: 4 })
  await page.keyboard.press('Enter')
}

/** Ask the shell's child what size its pty is: the LAST `SIZE <cols>x<rows>` in the buffer. */
async function childSize(page: Page): Promise<Grid> {
  await run(page, `node -p "'SIZE '+process.stdout.columns+'x'+process.stdout.rows"`)
  let found: Grid | null = null
  await expect.poll(async () => {
    const all = [...(await terminalText(page)).matchAll(/SIZE (\d+)x(\d+)/g)]
    const last = all[all.length - 1]
    found = last ? { cols: Number(last[1]), rows: Number(last[2]) } : null
    return found !== null
  }, { timeout: 30_000 }).toBe(true)
  return found!
}

test.describe.serial('Resize order in the real app', () => {
  test.setTimeout(240_000)
  let app: ElectronApplication
  let page: Page
  let dir: string
  let original: { w: number; h: number }

  test.beforeAll(async () => {
    ensureE2eBuild()
    ;({ app, page, dir } = await launch())
    original = await windowSize(app)
  })

  test.afterAll(async () => {
    await quitApp(app)
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  test('1. a window resize reaches the pty once, for the visible terminal, not once per mounted pane', async () => {
    await createTerminal(page, 'ResizeA')
    await createTerminal(page, 'ResizeB')
    await createTerminal(page, 'ResizeC') // the last one created is the one on screen: A and B are mounted, hidden
    await page.waitForTimeout(1500)
    const gridBefore = await gridSize(page)
    expect(gridBefore).not.toBeNull()
    const before = await resizeMessages(page)

    await resizeWindow(app, original.w - 260, original.h - 140)
    await expect.poll(() => gridSize(page), { timeout: 20_000 }).not.toEqual(gridBefore) // the visible pane refitted
    await page.waitForTimeout(1500) // anything that follows has followed
    const delta = (await resizeMessages(page)) - before

    // 1.54.4 told the pty once per MOUNTED pane: 3 here. The visible one only: 1, or 2 if the layout
    // settled in two steps more than 100 ms apart. Never 3.
    expect(delta).toBeGreaterThanOrEqual(1)
    expect(delta).toBeLessThan(3)
  })

  test('2. a resize made while output is arriving leaves xterm and the shell at the same size, and loses no output', async () => {
    // 20,000 lines of about 105 characters: a couple of MB, far more than one 64 KB frame of the throttle.
    await run(page, `node -e "for(let i=0;i<20000;i++)console.log('F'+i+' '+'x'.repeat(100));console.log('FLOOD-'+'DONE')"`)
    await page.waitForTimeout(500)
    // narrow it, then widen it back, while the flood is still being parsed
    await resizeWindow(app, original.w - 420, original.h - 200)
    await page.waitForTimeout(500)
    await resizeWindow(app, original.w, original.h)

    await expect.poll(() => terminalText(page), { timeout: 120_000 }).toContain('FLOOD-DONE')
    // nothing was lost on the way: the last line of the flood arrived whole (its row can wrap, never be cut)
    expect(await terminalText(page)).toContain('F19999 ' + 'x'.repeat(100))

    // let the last refit land, then compare what xterm has with what the shell's child sees
    await page.waitForTimeout(2500)
    const xterm = await gridSize(page)
    const child = await childSize(page)
    expect(xterm).toEqual(child)
  })

  test('3. a terminal that was hidden through the resizes fits when it is shown', async () => {
    const shown = await gridSize(page) // terminal C, the one on screen, at the size the window has now
    expect(shown).not.toBeNull()
    await page.keyboard.press('Alt+1') // ResizeA: mounted and hidden through every resize above
    await expect.poll(() => gridSize(page), { timeout: 20_000 }).toEqual(shown) // fitted to the same container
    await page.waitForTimeout(1500)
    const child = await childSize(page) // and its pty was told
    expect(child).toEqual(shown)
  })
})
