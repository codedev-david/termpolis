/**
 * The launch intro in the real app, on every platform.
 *
 * Main plays it only on the first start of a process, and not under NODE_ENV=test unless a test
 * sets TERMPOLIS_TEST_LAUNCH_INTRO=1. Every launch here has its own userData folder, so each one
 * is a first start. A relaunch with the SAME folder is the "setting off" case.
 *
 * The two reference frames in launch-intro.spec.ts-snapshots/ are shared by all platforms: the
 * artwork is pre-rendered, so one frame per card is right everywhere.
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { INTRO_BUDGET_MS, INTRO_HARD_CAP_MS, INTRO_TOTAL_MS, NOT_PAINTED_MS } from '../src/renderer/src/lib/launchIntro'
import { UPDATE_RESTART_FILE } from '../src/main/launchIntro'
import { dismissOnboarding, e2eLaunchArgs, e2eUserDataDir, ensureE2eBuild, quitApp } from './helpers/launch'

const INTRO = '[data-testid="launch-intro"]'
// The visible intro (its first frame on screen, to detach) is held to the spec's 2.0 s budget. Its
// first frame on screen is the stage animation's start: the stage's opacity runs on the compositor,
// so the animation starts in the frame that first draws the overlay. The page computes that frame's
// style earlier, while the window's first frame is still being drawn (85-130 ms on a warm Windows
// launch, 425 ms on a cold one), and nothing of the overlay is on screen in that time. The recordings
// agree: their first stage frame already shows the Termpolis card fading in.
// Upper slack: a loaded runner's late timer and React commit. Measured on Windows: see the timing
// test's log line and the fix report.
const UPPER_SLACK_MS = 250
// Lower slack: the timeline ends one 60 Hz frame inside the budget (INTRO_BUDGET_MS - INTRO_TOTAL_MS),
// the animation's start and the frame on screen can sit a frame or two apart, plus 30 ms.
const LOWER_SLACK_MS = INTRO_BUDGET_MS - INTRO_TOTAL_MS + 2 * 17 + 30
// The Termpolis card fades in from 0 on the stage: on the overlay's first frame it is a frame or two
// into its 150 ms at most.
const FIRST_OPACITY_MAX = 0.3
// The closing fade must be complete when the overlay goes: the last frame we see is at most a frame
// or two from the end of its 250 ms.
const FINAL_OPACITY_MAX = 0.1
// The reference frames compare only the card's artwork (its bounding box), with an absolute pixel
// budget. Set from Windows evidence (3 runs per card, budget 0): the real frames differ from the
// reference by 0 pixels; without the tag line by 1379 (termpolis) and 2097 (lumopolis); without the
// card by 7426 and 9631. The budget is under a tenth of the smallest of those, so every control below
// fails by a wide margin, and leaves room for another platform's image resampling.
const MAX_DIFF_PIXELS = 130
const VIEW_W = 1280
const VIEW_H = 720
const SHELL = process.platform === 'win32' ? 'powershell' : 'bash'

let app: ElectronApplication | null = null

test.beforeAll(() => {
  ensureE2eBuild()
})

test.afterEach(async () => {
  await quitApp(app)
  app = null
})

/** Records, in the page, whether the overlay was EVER attached: catches a flash a poll would miss. */
const WATCH_SCRIPT = `(() => {
  window.__introSeen = false
  new MutationObserver(() => {
    if (document.querySelector('${INTRO}')) window.__introSeen = true
  }).observe(document, { childList: true, subtree: true })
})()`

/**
 * Times the intro from the document's first frame, so its opening frames are never missed (a loop the
 * test starts after launch begins late, after the overlay is already up). Every frame while the overlay
 * is attached it reads the computed opacity of the stage and of the Termpolis card, and takes the
 * stage animation's start (the overlay's first frame on screen) once it has one; a MutationObserver
 * stamps the exact moment the overlay leaves the DOM.
 */
const TIMING_SCRIPT = `(() => {
  const m = window.__introTiming = { firstAt: null, firstStage: null, firstCard: null, lastStage: null, frames: 0, startTime: null, detachedAt: null }
  let attached = false
  new MutationObserver(() => {
    const on = !!document.querySelector('${INTRO}')
    if (attached && !on && m.detachedAt === null) m.detachedAt = performance.now()
    attached = attached || on
  }).observe(document, { childList: true, subtree: true })
  const tick = (at) => {
    const root = document.querySelector('${INTRO}')
    if (root) {
      const stage = Number(getComputedStyle(root).opacity)
      if (m.firstAt === null && stage > 0) {
        m.firstAt = at
        m.firstStage = stage
        m.firstCard = Number(getComputedStyle(root.querySelector('[data-testid="launch-intro-termpolis"]')).opacity)
      }
      if (m.firstAt !== null) { m.lastStage = stage; m.frames++ }
      if (m.startTime === null) {
        // The root's own animations: the stage's.
        const a = root.getAnimations().find((x) => typeof x.startTime === 'number')
        if (a) m.startTime = a.startTime
      }
    }
    if (m.detachedAt === null) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
})()`

/**
 * Holds the intro at film time \`t\`, from the moment it mounts. The overlay removes itself on its
 * own timers (never started by NOT_PAINTED_MS, the removal at start + INTRO_TOTAL_MS, the hard cap),
 * and pausing animations does not stop them, so a slow runner could lose the overlay before the
 * screenshot. While the overlay is attached, a timer with one of those delays never fires; every
 * other timer is untouched. Each frame pins every animation at \`t\`.
 * Only the frame tests install it; the timing test runs the real, unfrozen removal.
 */
function freezeScript(t: number): string {
  return `(() => {
  const realSetTimeout = window.setTimeout.bind(window)
  const introTimer = (delay) => delay === ${NOT_PAINTED_MS} || delay === ${INTRO_HARD_CAP_MS}
    || (delay >= ${INTRO_TOTAL_MS - NOT_PAINTED_MS} && delay <= ${INTRO_TOTAL_MS})
  window.setTimeout = (cb, delay, ...args) => {
    if (document.querySelector('${INTRO}') && introTimer(Number(delay))) {
      window.__introTimersHeld = (window.__introTimersHeld || 0) + 1
      return realSetTimeout(() => {}, delay)
    }
    return realSetTimeout(cb, delay, ...args)
  }
  const tick = () => {
    if (document.querySelector('${INTRO}')) {
      const animations = document.getAnimations()
      if (animations.length > 0) {
        animations.forEach((a) => { a.pause(); a.currentTime = ${t} })
        window.__introFrozen = true
      }
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
})()`
}

interface LaunchOptions {
  introSwitch?: boolean
  init?: string[]
}

/** One userData folder per label, and per retry: a retried test must not inherit what the failed attempt stored. */
const labelFor = (base: string): string => `${base}-${test.info().retry}`

async function launch(base: string, { introSwitch = true, init = [] }: LaunchOptions = {}): Promise<Page> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), NODE_ENV: 'test', TERMPOLIS_TEST_AGENTS: '1' }
  if (introSwitch) env.TERMPOLIS_TEST_LAUNCH_INTRO = '1'
  else delete env.TERMPOLIS_TEST_LAUNCH_INTRO
  app = await electron.launch({ args: e2eLaunchArgs(labelFor(base)), env })
  // Before the window exists (it opens a few seconds after the process starts), so the scripts
  // are in the document from its first byte.
  for (const content of init) await app.context().addInitScript({ content })
  const page = await app.firstWindow()
  // A fixed 1280x720 viewport at scale 1, so the overlay and its screenshots are the same everywhere
  // (a real window's content size drifts with the OS's display scaling).
  await page.setViewportSize({ width: VIEW_W, height: VIEW_H })
  await page.waitForLoadState('domcontentloaded')
  return page
}

async function relaunch(base: string, options?: LaunchOptions): Promise<Page> {
  await quitApp(app)
  app = null
  return launch(base, options)
}

/**
 * The intro never appears. Waits for a positive signal first (the app shell is up), then for longer
 * than the whole intro could last, then reads the in-page record of whether the overlay was ever attached.
 */
async function expectNeverShown(page: Page): Promise<void> {
  await expect(page.locator('button[title="Settings"]')).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(INTRO_HARD_CAP_MS + UPPER_SLACK_MS)
  expect(await page.evaluate(() => (window as unknown as { __introSeen?: boolean }).__introSeen)).toBe(false)
}

async function terminalText(page: Page, id: string): Promise<string> {
  return page.evaluate(
    (tid) => (window as unknown as { __termpolis_terminal_text?: (i?: string) => string }).__termpolis_terminal_text?.(tid) ?? '',
    id,
  )
}

test.describe('launch intro', () => {
  test('is visible for at most 2.0 s, from its first frame on screen until it is gone, and never shows the app first', async () => {
    const page = await launch('intro-timing', { init: [WATCH_SCRIPT, TIMING_SCRIPT] })
    interface Timing { firstAt: number | null; firstStage: number; firstCard: number; lastStage: number; frames: number; startTime: number | null; detachedAt: number | null }
    const read = (): Promise<Timing> => page.evaluate(() => (window as unknown as { __introTiming: Timing }).__introTiming)
    await expect.poll(async () => (await read()).detachedAt !== null, { timeout: 30_000 }).toBe(true)
    const m = await read()
    expect(m.firstAt, 'the intro left without its page ever computing a frame of it').not.toBeNull()
    expect(m.startTime, 'the intro left without ever reaching the screen').not.toBeNull()
    const firstAt = m.firstAt as number
    const shownAt = m.startTime as number
    const detachedAt = m.detachedAt as number
    const visible = detachedAt - shownAt
    console.log(`intro timing: visible=${visible.toFixed(1)} ms (on screen to gone), first computed frame to gone=${(detachedAt - firstAt).toFixed(1)} ms, first computed frame to on screen=${(shownAt - firstAt).toFixed(1)} ms, frames=${m.frames}, first stage opacity=${m.firstStage.toFixed(3)}, first card opacity=${m.firstCard.toFixed(3)}, last stage opacity=${m.lastStage.toFixed(3)}`)
    expect(visible).toBeLessThanOrEqual(INTRO_BUDGET_MS + UPPER_SLACK_MS)
    expect(visible).toBeGreaterThanOrEqual(INTRO_BUDGET_MS - LOWER_SLACK_MS)
    // The overlay reaches the screen after the page first computes it (never before), and within
    // NOT_PAINTED_MS, or it would never have been shown; so it is in the page no longer than the hard cap.
    expect(shownAt).toBeGreaterThanOrEqual(firstAt)
    expect(shownAt - firstAt).toBeLessThan(NOT_PAINTED_MS)
    expect(detachedAt - firstAt).toBeLessThanOrEqual(INTRO_HARD_CAP_MS + UPPER_SLACK_MS)
    // Its first frame covers the app completely: the starting app is never seen before the intro.
    expect(m.firstStage).toBe(1)
    // And the Termpolis card fades in on it rather than appearing at full.
    expect(m.firstCard).toBeLessThan(FIRST_OPACITY_MAX)
    expect(m.lastStage).toBeLessThanOrEqual(FINAL_OPACITY_MAX)
    // The watcher saw the overlay, so the "never shown" checks below can be trusted to see it too.
    expect(await page.evaluate(() => (window as unknown as { __introSeen?: boolean }).__introSeen)).toBe(true)
  })

  test('typing during the intro lands in the terminal once', async () => {
    const page = await launch('intro-typing')
    await expect(page.locator(INTRO)).toBeAttached({ timeout: 15_000 })
    // A terminal has to exist while the intro is up, and clicking the UI would end it. So open the
    // shell the way the app's own remote-open path does: the PTY through the real IPC, then the
    // event that puts it in the sidebar as an ordinary terminal.
    const id = `intro-e2e-${Date.now()}`
    await page.evaluate(async ({ tid, shell, cwd }) => {
      const api = (window as unknown as { termpolis: { createTerminal: (...a: unknown[]) => Promise<{ success: boolean }> } }).termpolis
      const res = await api.createTerminal(tid, shell, cwd)
      if (!res.success) throw new Error('could not create the terminal')
    }, { tid: id, shell: SHELL, cwd: os.homedir() })
    await app!.evaluate(({ BrowserWindow }, data) => {
      BrowserWindow.getAllWindows()[0].webContents.send('mcp:terminal-created', data)
    }, { id, name: 'intro-typing', shell: SHELL, cwd: os.homedir(), remote: true })
    const textarea = page.locator('.xterm-helper-textarea').first()
    await textarea.waitFor({ state: 'attached', timeout: 10_000 })
    // Focus by script: neither a key nor a click, so the intro keeps playing.
    await textarea.focus()
    expect(await page.locator(INTRO).count(), 'the intro must still be up when the typing starts').toBe(1)
    await page.keyboard.type('echo intro-ok')
    await page.keyboard.press('Enter')
    // Focus never moved to the overlay.
    expect(await page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea'))).toBe(true)
    await expect.poll(async () => {
      const lines = (await terminalText(page, id)).split(/\r?\n/).map((l) => l.trim())
      return lines.filter((l) => l === 'intro-ok').length
    }, { timeout: 20_000 }).toBe(1)
    // And it stays one: not doubled by a late repeat.
    await page.waitForTimeout(1000)
    const lines = (await terminalText(page, id)).split(/\r?\n/).map((l) => l.trim())
    expect(lines.filter((l) => l === 'intro-ok')).toHaveLength(1)
    expect(lines.filter((l) => l.endsWith('echo intro-ok'))).toHaveLength(1)
    await expect(page.locator(INTRO)).toHaveCount(0)
  })

  test('a reload does not play it again', async () => {
    const page = await launch('intro-reload', { init: [WATCH_SCRIPT] })
    await expect(page.locator(INTRO)).toBeVisible({ timeout: 15_000 })
    await expect(page.locator(INTRO)).toHaveCount(0, { timeout: INTRO_HARD_CAP_MS + 3000 })
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    // The watcher restarts with the new document, so this reads the reloaded page only.
    await expectNeverShown(page)
  })

  test('does not show when the setting is off', async () => {
    const label = 'intro-off'
    const page = await launch(label)
    await expect(page.locator(INTRO)).toBeVisible({ timeout: 15_000 })
    await expect(page.locator(INTRO)).toHaveCount(0, { timeout: INTRO_HARD_CAP_MS + 3000 })
    await dismissOnboarding(page)
    await page.locator('button[title="Settings"]').click()
    await page.getByRole('button', { name: 'General', exact: true }).click()
    const box = page.getByTestId('settings-launch-intro')
    await expect(box).toBeChecked()
    await box.uncheck()
    await expect(box).not.toBeChecked()
    expect(await page.evaluate(() => localStorage.getItem('termpolis.launchIntro'))).toBe('0')
    // Same userData: the stored setting is what keeps it away.
    const again = await relaunch(label, { init: [WATCH_SCRIPT] })
    await expectNeverShown(again)
  })

  test('does not show in e2e without the test switch', async () => {
    const page = await launch('intro-no-switch', { introSwitch: false, init: [WATCH_SCRIPT] })
    await expectNeverShown(page)
  })

  test('does not show on the restart an update asked for, and consumes the marker', async () => {
    // What the updater writes before it quits to install: the time, in the app's own userData.
    const marker = path.join(e2eUserDataDir(labelFor('intro-update-restart')), UPDATE_RESTART_FILE)
    fs.writeFileSync(marker, String(Date.now()))
    const page = await launch('intro-update-restart', { init: [WATCH_SCRIPT] })
    await expectNeverShown(page)
    // One-shot: deleted, so the next start the user makes plays it.
    await expect.poll(() => fs.existsSync(marker), { timeout: 10_000 }).toBe(false)
  })

  for (const [card, t] of [['termpolis', 600], ['lumopolis', 1650]] as const) {
    test(`the ${card} card matches the reference frame`, async () => {
      test.info().snapshotSuffix = ''
      // Held at the card's time from the moment the overlay mounts (see freezeScript), so nothing
      // here races the overlay's own removal, however slow the runner is.
      const page = await launch(`intro-shot-${card}`, { init: [freezeScript(t)] })
      await page.waitForFunction(() => (window as unknown as { __introFrozen?: boolean }).__introFrozen === true, undefined, { timeout: 30_000 })
      // Loud check that the hook really held the overlay's timers: past the hard cap the overlay must
      // still be attached. If the product's timers change and the hook misses them, this fails here.
      await page.waitForTimeout(INTRO_HARD_CAP_MS + UPPER_SLACK_MS)
      await expect(page.locator(INTRO)).toHaveCount(1)
      // Compare the card's artwork only: the union of its pieces' boxes, rounded out to whole pixels.
      // A whole-viewport compare with a ratio budget let a frame with the artwork missing pass.
      const cardSel = `[data-testid="launch-intro-${card}"]`
      const clip = await page.evaluate((s) => {
        const boxes = [...document.querySelectorAll(`${s} img, ${s} div`)].map((e) => e.getBoundingClientRect())
        const x = Math.floor(Math.min(...boxes.map((b) => b.left)))
        const y = Math.floor(Math.min(...boxes.map((b) => b.top)))
        return {
          x, y,
          width: Math.ceil(Math.max(...boxes.map((b) => b.right))) - x,
          height: Math.ceil(Math.max(...boxes.map((b) => b.bottom))) - y,
        }
      }, cardSel)
      expect(clip.width).toBeGreaterThan(200)
      expect(clip.height).toBeGreaterThan(100)
      const name = `launch-intro-${card}.png`
      const options = { maxDiffPixels: MAX_DIFF_PIXELS }
      const shoot = (): Promise<Buffer> => page.screenshot({ clip, scale: 'css', animations: 'allow' })
      expect(await shoot()).toMatchSnapshot(name, options)
      // Controls, with the same options: the budget must catch a missing tag line, and a missing card.
      await page.evaluate((s) => { (document.querySelector(`${s} img:last-of-type`) as HTMLElement).style.visibility = 'hidden' }, cardSel)
      expect(await shoot(), 'a frame without the tag line must not match').not.toMatchSnapshot(name, options)
      await page.evaluate((s) => { (document.querySelector(s) as HTMLElement).style.visibility = 'hidden' }, cardSel)
      expect(await shoot(), 'a frame without the card must not match').not.toMatchSnapshot(name, options)
    })
  }
})
