/**
 * Resizing a terminal while it prints (1.54.5, plan P11), in the real app.
 *
 * The unit and sweep tests (tests/electron/terminalManagerResizeFlush.test.ts, remoteResizeFlush.test.ts)
 * prove the ORDER with the real modules and a virtual clock: when a pane's size changes, main hands on
 * what the 8 ms coalescer and the remote pump hold, at the size they were drawn for, and only then
 * records the new size and resizes the pty. What only a real run can show is that this survives the
 * real thing: the renderer's fit() -> `terminal:resize` IPC -> `resizeTerminal` -> a real node-pty
 * (ConPTY on Windows) while a real child prints faster than the coalescer's window.
 *
 * So: a node child prints 2,000 numbered lines in bursts, the window is resized six times while it
 * does, and the numbered lines must arrive. On Linux and macOS a pty never redraws on a resize, so the
 * lines in main's output buffer (what the coalescer emitted, which is what the phone and a pane that
 * remounts replay) must be exactly 1..2000, once each and in order: the flush neither drops, repeats
 * nor reorders a byte. On Windows ConPTY repaints the viewport on a resize (that is the residual the
 * plan states), so there the spec asserts only that the stream finishes and the terminal still answers.
 *
 * Needs real Electron and a real pty, so it cannot run in the unit suite: it is the named CI check for
 * "the flush before a resize works in the app", and until CI runs it, that is not verified.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { quitApp, ensureE2eBuild } from './helpers/launch'

let app: ElectronApplication
let page: Page
let isolatedUserData: string

const LINES = 2000
/** Each numbered line is 10 characters ("RF-00001" and CRLF). Main keeps the last 32,768 characters of a
 *  terminal's output (MAX_TERMINAL_BUFFER_CHARS), and the strict check below reads all of the stream back
 *  out of that window, so LINES * 10 plus the echoed command and the prompt must stay well under it. */
const BUFFER_CAP = 32_768

/** Prints LINES numbered lines, four per 10 ms tick, then RF-DONE. The marker is built from two
 *  literals so that the echo of this very command (which the terminal shows) does not contain it. The
 *  quoting is the subset that means the same thing to PowerShell and to bash. */
const STREAM =
  `node -e "let i=0;const t=setInterval(()=>{let s='';for(let k=0;k<4;k++)s+='RF-'+String(++i).padStart(5,'0')+'\\r\\n';` +
  `process.stdout.write(s);if(i>=${LINES}){clearInterval(t);console.log('RF-'+'DONE')}},10)"`

/** Answers with a number nothing typed spells out, so it proves the terminal still takes input. */
const ASK = `node -e "console.log('RF-'+(6*7))"`

async function resizeWindow(width: number, height: number): Promise<void> {
  await app.evaluate(async ({ BrowserWindow }, size) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) win.setSize(size.w, size.h)
  }, { w: width, h: height })
  // The renderer debounces its ResizeObserver by 100 ms; leave room for the fit and the IPC.
  await page.waitForTimeout(250)
}

function paneWidth(): Promise<number> {
  return page.evaluate(() => {
    const screen = document.querySelector('.xterm .xterm-screen') as HTMLElement | null
    return screen ? Math.round(screen.getBoundingClientRect().width) : 0
  })
}

/** What main has buffered for the terminal: the bytes the coalescer emitted, in order. */
function mainBuffer(id: string): Promise<string> {
  return page.evaluate(async (terminalId) => {
    const res = await (window as unknown as {
      termpolis: { readTerminalBuffer: (id: string) => Promise<{ success: boolean; data?: { output: string } }> }
    }).termpolis.readTerminalBuffer(terminalId)
    return res?.success && res.data ? res.data.output : ''
  }, id)
}

/** What the pane itself shows, out of xterm's buffer (identical under the DOM and WebGL renderers). */
function paneText(id: string): Promise<string> {
  return page.evaluate(
    (terminalId) =>
      (window as unknown as { __termpolis_terminal_text?: (id?: string) => string }).__termpolis_terminal_text?.(
        terminalId,
      ) ?? '',
    id,
  )
}

function write(id: string, data: string): Promise<void> {
  return page.evaluate(
    ({ terminalId, text }) =>
      (window as unknown as { termpolis: { writeToTerminal: (id: string, d: string) => void } }).termpolis.writeToTerminal(
        terminalId,
        text,
      ),
    { terminalId: id, text: data },
  )
}

/** Type a command and press Enter as a separate write, the way the app submits to anything that reads
 *  a fused text-plus-CR as a paste. */
async function run(id: string, command: string): Promise<void> {
  await write(id, command)
  await page.waitForTimeout(200)
  await write(id, '\r')
}

async function createTerminal(name: string): Promise<void> {
  await page.locator('button:has-text("+ Add Terminal")').first().click()
  await page.waitForTimeout(400)
  const nameInput = page.locator('h2:has-text("New Terminal")').locator('..').locator('input').first()
  await nameInput.fill(name)
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await page.waitForTimeout(1500)
}

async function terminalIdNamed(name: string): Promise<string> {
  const id = await page.evaluate((wanted) => {
    const state = (window as unknown as {
      __termpolis_test_state?: () => { terminals: Array<{ id: string; name?: string }> }
    }).__termpolis_test_state?.()
    const all = state?.terminals ?? []
    return (all.find((t) => t.name === wanted) ?? all[all.length - 1])?.id ?? ''
  }, name)
  expect(id, 'the terminal that was just created is in the store').not.toBe('')
  return id
}

test.beforeAll(async () => {
  ensureE2eBuild()

  isolatedUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'termpolis-resizeflush-'))
  fs.writeFileSync(
    path.join(isolatedUserData, 'session.json'),
    JSON.stringify({
      terminals: [],
      workspaces: [],
      defaultShell: process.platform === 'win32' ? 'powershell' : 'bash',
      viewMode: 'tabs',
    }),
  )

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

  await page.evaluate(() => {
    try {
      localStorage.setItem('termpolis.onboarding.seen.v1', '1')
      localStorage.setItem('termpolis.telemetry.optIn', '0')
    } catch {
      /* ignore */
    }
  })
  const onboardDialog = page.locator('[aria-labelledby="onboarding-title"]')
  if (await onboardDialog.isVisible({ timeout: 5000 }).catch(() => false)) {
    await page.locator('button:has-text("Skip tour")').first().click({ force: true }).catch(() => {})
    await onboardDialog.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {})
  }
})

test.afterAll(async () => {
  await quitApp(app)
  if (isolatedUserData) {
    try {
      fs.rmSync(isolatedUserData, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

test.describe.serial('Resizing a terminal while it prints', () => {
  test.setTimeout(240_000)
  let id = ''

  test('1. six window resizes during a 2,000-line stream: the stream finishes, and where the pty does not redraw it arrives whole', async () => {
    await createTerminal('ResizeFlush')
    id = await terminalIdNamed('ResizeFlush')

    // The shell is ready once it has printed anything (a banner, a prompt).
    await expect.poll(async () => (await mainBuffer(id)).length, { timeout: 60_000 }).toBeGreaterThan(0)
    await page.waitForTimeout(800)

    await run(id, STREAM)
    // The stream is flowing before the first resize, so every resize below lands in the middle of it.
    await expect
      .poll(async () => (await mainBuffer(id)).includes('RF-00001'), { timeout: 60_000 })
      .toBe(true)

    const widths = new Set<number>([await paneWidth()])
    for (const [w, h] of [
      [1100, 800],
      [900, 700],
      [1250, 820],
      [800, 650],
      [1000, 760],
      [1200, 800],
    ]) {
      await resizeWindow(w, h)
      widths.add(await paneWidth())
    }
    // The panes really changed size: these were resizes, not no-ops.
    expect(widths.size, `pane widths seen: ${[...widths].join(', ')}`).toBeGreaterThanOrEqual(4)

    // It finishes: nothing the flush does can wedge the stream.
    await expect
      .poll(async () => (await mainBuffer(id)).includes('RF-DONE'), { timeout: 120_000 })
      .toBe(true)
    // And what main emitted reached the pane.
    await expect.poll(() => paneText(id), { timeout: 60_000 }).toContain('RF-DONE')

    if (process.platform !== 'win32') {
      const out = await mainBuffer(id)
      expect(out.length, 'the stream must fit in main\'s output window, or its first lines are evicted').toBeLessThan(
        BUFFER_CAP - 2000,
      )
      const seen = [...out.matchAll(/RF-(\d{5})/g)].map((m) => Number(m[1]))
      const firstBad = seen.findIndex((n, i) => n !== i + 1)
      expect(
        { count: seen.length, firstBadIndex: firstBad, around: firstBad < 0 ? [] : seen.slice(Math.max(0, firstBad - 2), firstBad + 3) },
        'every numbered line exactly once, in order',
      ).toEqual({ count: LINES, firstBadIndex: -1, around: [] })
    }
  })

  test('2. after the resizes the terminal still takes input and answers', async () => {
    await run(id, ASK)
    await expect.poll(async () => (await mainBuffer(id)).includes('RF-42'), { timeout: 60_000 }).toBe(true)
    await expect.poll(() => paneText(id), { timeout: 60_000 }).toContain('RF-42')
  })

  test('3. a resize to the size the pane already has is harmless, and the terminal keeps working', async () => {
    // The renderer fits on every layout change and often lands on the size it already had: that must
    // flush nothing and still resize the pty.
    const before = await paneWidth()
    await resizeWindow(1200, 800)
    await resizeWindow(1200, 800)
    expect(await paneWidth()).toBe(before)
    await run(id, ASK)
    await expect
      .poll(async () => ((await mainBuffer(id)).match(/RF-42/g) ?? []).length, { timeout: 60_000 })
      .toBeGreaterThanOrEqual(2)
  })
})
