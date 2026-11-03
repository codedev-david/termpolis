/**
 * Hidden-pane E2E (1.54.5, plan package P9) -- what only a real Electron window can prove.
 *
 * The unit and component suites prove the routing, the per-pass side effects and the style of an inactive pane against a
 * real xterm parser, the real preload router and jsdom. They cannot prove what Chromium does with that style, or that the
 * context bridge carries the routed callbacks. This spec does, with real ptys, a real renderer thread and counters:
 *
 *   1. Routing: every mounted terminal shares ONE ipcRenderer listener (window.termpolis.terminalDataStats: numbers and
 *      one boolean), and nothing listens to "all terminals" while no launch is waiting for a shell.
 *   2. A pane hidden the way the app hides it gets no row paints while its terminal prints (a MutationObserver on the
 *      DOM renderer's .xterm-rows counts them: many while the same pane was in front, 0 hidden), and the screen is right
 *      when it is shown again: the rows the user sees are the buffer's rows, with the end of the flood in them.
 *      Hidden terminals are still parsed: the buffer holds ALL of the flood, in order. (A GPU renderer has no rows in the
 *      DOM: the spec then skips, see the guards in tests 2 and 3.)
 *   3. Negative control, the kill switch: with localStorage 'termpolis.hiddenPanes' = '0' a pane opened afterwards keeps
 *      painting while hidden, which is the 1.54.4 behaviour and what the style change removes.
 *   4. The side effects of the output (window, diff, prompt, agent detection ...) run once per pass: at most 4 a second for
 *      the pane in front, however many chunks arrive (window.__termpolis_pane_effects: numbers only).
 *
 * The existing terminal-layout.spec.ts and terminal-focus.spec.ts guard the other half of the risk: a hidden pane keeps
 * its box (no resize churn) and the caret still lands in a pane the moment it is shown.
 *
 * The floods are TIME-based and RATE-LIMITED (200 lines every 50 ms for a few seconds, then a sentinel with the line count), so
 * the terminal is still printing when it is hidden however fast the pty is, and the renderer is handed megabytes, not hundreds
 * of them; the sentinel is built from two strings, so the typed command's own echo can never satisfy a wait. Isolated --user-data-dir so it owns its own single-instance lock (mirrors
 * write-scheduler.spec.ts). NOT RUN where this was written (no Electron there): it is "unverified until CI runs it".
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { quitApp, ensureE2eBuild } from './helpers/launch'

interface RouterStats { shared: boolean; ids: number; panes: number; all: number; delivered: number; dropped: number }
interface EffectsStats { messages: number; passes: number; failures: number; pendingChars: number; pendingMessages: number; droppedChars: number }

async function launch(): Promise<{ app: ElectronApplication; page: Page; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-hidden-'))
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
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1200)
}

/** The text of the terminal on screen, or of the one with this id, from xterm's own buffer through the renderer's read-only test hook. */
async function terminalText(page: Page, id?: string): Promise<string> {
  const text = await page.evaluate(
    (tid) => (window as unknown as { __termpolis_terminal_text?: (id?: string) => string }).__termpolis_terminal_text?.(tid) ?? '',
    id,
  )
  return text.replace(/\r?\n/g, '')
}

async function routerStats(page: Page): Promise<RouterStats | null> {
  return page.evaluate(() => (window as unknown as { termpolis: { terminalDataStats?: () => RouterStats } }).termpolis.terminalDataStats?.() ?? null)
}

async function effects(page: Page): Promise<Record<string, EffectsStats>> {
  return page.evaluate(() => (window as unknown as { __termpolis_pane_effects?: () => Record<string, EffectsStats> }).__termpolis_pane_effects?.() ?? {})
}

/** Type a command and run it. */
async function run(page: Page, command: string): Promise<void> {
  await page.keyboard.type(command, { delay: 4 })
  await page.keyboard.press('Enter')
}

/**
 * Print numbered lines for `ms` milliseconds, 200 every 50 ms (about 4,000 a second, 430 KB/s: the same on a fast pty and a slow
 * one, so the terminal is still printing when the spec hides it, and the renderer is not handed hundreds of MB), then a sentinel
 * (two strings, so the echo cannot match) that carries the line count.
 */
const flood = (tag: string, ms: number): string =>
  `node -e "const e=Date.now()+${ms};let i=0;const t=setInterval(()=>{for(let k=0;k<200;k++){console.log('${tag}'+i+' '+'x'.repeat(100));i++}if(Date.now()>=e){clearInterval(t);console.log('${tag}-'+'DONE'+i)}},50)"`

/** Count the mutations of every pane's DOM-renderer rows, by pane order (panes are mounted in creation order). Returns how many panes. */
async function observeRows(page: Page): Promise<number> {
  return page.evaluate(() => {
    const w = window as unknown as { __rowMutations?: number[]; __rowObservers?: MutationObserver[] }
    w.__rowObservers?.forEach((o) => o.disconnect())
    const rows = Array.from(document.querySelectorAll('.xterm-rows'))
    w.__rowMutations = rows.map(() => 0)
    w.__rowObservers = rows.map((el, i) => {
      const o = new MutationObserver((records) => { w.__rowMutations![i] += records.length })
      o.observe(el, { subtree: true, childList: true, characterData: true, attributes: true })
      return o
    })
    return rows.length
  })
}

async function rowMutations(page: Page): Promise<number[]> {
  return page.evaluate(() => [...((window as unknown as { __rowMutations?: number[] }).__rowMutations ?? [])])
}

/** The rows of pane `index` as the DOM renderer drew them, trailing blanks trimmed. */
async function drawnRows(page: Page, index: number): Promise<string[]> {
  return page.evaluate(
    (i) => Array.from(document.querySelectorAll('.xterm-rows')[i]?.children ?? []).map((d) => (d.textContent ?? '').replace(/\s+$/g, '')),
    index,
  )
}

test.describe.serial('Hidden panes in the real app', () => {
  test.setTimeout(300_000)
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

  test('1. every mounted terminal shares ONE listener, and nothing listens to all terminals', async () => {
    await createTerminal(page, 'HideA')
    await createTerminal(page, 'HideB')
    await createTerminal(page, 'HideC') // the last one created is the one in front
    await page.waitForTimeout(1500)
    const stats = await routerStats(page)
    expect(stats).not.toBeNull()
    expect(stats!.shared).toBe(true)
    expect(stats!.ids).toBe(3)
    expect(stats!.panes).toBe(3)
    expect(stats!.all).toBe(0)
    // Output reached the panes through it (each shell printed its prompt). `dropped` is not asserted: before the first
    // announcement main sends everything, so a first chunk may beat its pane's mount (it is in the replay).
    expect(stats!.delivered).toBeGreaterThan(0)
  })

  test('2. a pane hidden the way the app hides it gets no row paints while it prints, and it is right when shown', async () => {
    // C is in front. Print in it first, so the observer is proven against a pane that IS painting.
    const panes = await observeRows(page)
    test.skip(panes !== 3, 'a GPU renderer draws no rows into the DOM: nothing to count here (the unit and harness numbers stand)')
    await run(page, flood('V', 1500))
    await expect.poll(() => terminalText(page), { timeout: 60_000 }).toMatch(/V-DONE\d+/)
    const visibleMutations = (await rowMutations(page))[2]
    expect(visibleMutations, 'the observer must see the pane that IS painting, or "0 while hidden" proves nothing').toBeGreaterThan(0)

    // Now print in C for several seconds and bring A to the front while it prints: C is hidden for nearly all of it.
    await run(page, flood('H', 5000))
    await page.waitForTimeout(600)
    await page.keyboard.press('Alt+1')
    await page.waitForTimeout(500)
    await observeRows(page) // count from here: C is hidden and still printing
    const ids = Object.keys(await effects(page)) // panes in creation order
    expect(ids).toHaveLength(3)
    const hiddenId = ids[2]
    await expect.poll(() => terminalText(page, hiddenId), { timeout: 120_000 }).toMatch(/H-DONE\d+/)

    // Hidden terminals are still parsed: the buffer holds the flood, complete and in order (the scrollback keeps the last 10,000 rows).
    const text = await terminalText(page, hiddenId)
    const count = Number(/H-DONE(\d+)/.exec(text)![1])
    const numbers = Array.from(text.matchAll(/H(\d+) x{100}/g), (m) => Number(m[1]))
    expect(count).toBeGreaterThan(100)
    // The scrollback keeps the last 10,000 ROWS, and a 106-character line may wrap into two on a narrow pane: so the number
    // that survives is not asserted exactly, only that a long run of them did, with no gap and no repeat, ending at the last.
    expect(numbers.length).toBeGreaterThan(2000)
    for (let i = 1; i < numbers.length; i++) expect(numbers[i]).toBe(numbers[i - 1] + 1) // no gap, no repeat
    expect(numbers[numbers.length - 1]).toBe(count - 1)

    // The pane in the background painted nothing while all that went in.
    expect((await rowMutations(page))[2]).toBe(0)

    // Shown again: the rows on screen are the buffer's own last rows, with the end of the flood in them.
    await page.keyboard.press('Alt+3')
    await expect.poll(async () => (await drawnRows(page, 2)).join('\n'), { timeout: 15_000 }).toContain('H-DONE')
    const drawn = (await drawnRows(page, 2)).filter((r) => /\S/.test(r))
    const shown = await terminalText(page) // the pane in front is C again
    expect(shown).toContain(drawn.join(''))
  })

  test('3. NEGATIVE CONTROL: with the kill switch a pane opened afterwards keeps painting while hidden (the 1.54.4 behaviour)', async () => {
    await page.evaluate(() => localStorage.setItem('termpolis.hiddenPanes', '0'))
    await createTerminal(page, 'HideOffA')
    await createTerminal(page, 'HideOffB') // in front
    await run(page, flood('K', 5000))
    await page.waitForTimeout(600)
    await page.keyboard.press('Alt+4') // HideOffA: HideOffB is hidden while it prints
    await page.waitForTimeout(500)
    const panes = await observeRows(page)
    test.skip(panes !== 5, 'a GPU renderer draws no rows into the DOM')
    const ids = Object.keys(await effects(page))
    const offBId = ids[ids.length - 1]
    await expect.poll(() => terminalText(page, offBId), { timeout: 120_000 }).toMatch(/K-DONE\d+/)
    const mutations = await rowMutations(page)
    expect(mutations[panes - 1]).toBeGreaterThan(0) // painted while hidden: what content-visibility removes
    await page.evaluate(() => localStorage.removeItem('termpolis.hiddenPanes'))
  })

  test('4. side effects: at most 4 passes a second for the pane in front, however many chunks arrive', async () => {
    await createTerminal(page, 'HideFx')
    const ids = Object.keys(await effects(page))
    const frontId = ids[ids.length - 1]
    const start = (await effects(page))[frontId]
    const t0 = Date.now()
    await run(page, flood('F', 3000))
    await expect.poll(() => terminalText(page), { timeout: 120_000 }).toMatch(/F-DONE\d+/)
    const seconds = (Date.now() - t0) / 1000
    const end = (await effects(page))[frontId]
    const passes = end.passes - start.passes
    const messages = end.messages - start.messages
    expect(messages).toBeGreaterThan(passes) // chunks were batched
    expect(passes).toBeLessThanOrEqual(Math.ceil(4 * seconds) + 2)
    expect(end.failures).toBe(0)
  })
})
