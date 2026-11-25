/**
 * The launch intro in the real app, on every platform.
 *
 * Main plays it only on the first start of a process, and not under NODE_ENV=test unless a test
 * sets TERMPOLIS_TEST_LAUNCH_INTRO=1. Every launch here has its own userData folder, so each one
 * is a first start. A relaunch with the SAME folder is the "setting off" case.
 *
 * The two reference frames in launch-intro.spec.ts-snapshots/ are shared by all platforms: the
 * artwork is pre-rendered, so one frame per card is right everywhere. They are a Linux CI runner's
 * frames (run 44871421371), cropped to the box the test takes. Against them the Linux and Windows
 * runners differ by 0 pixels, macOS by 1 and 16, and a GPU-rasterised laptop by 47 and 87: the
 * runners' own rendering is the reference, held to a tight budget in CI, and a developer machine
 * gets the slack its GPU raster needs (MAX_DIFF_PIXELS).
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { INTRO_BUDGET_MS, INTRO_HARD_CAP_MS, INTRO_TOTAL_MS, NOT_PAINTED_MS } from '../src/renderer/src/lib/launchIntro'
import { UPDATE_RESTART_FILE } from '../src/main/launchIntro'
import { dismissOnboarding, e2eLaunchArgs, e2eUserDataDir, ensureE2eBuild, quitApp } from './helpers/launch'

const INTRO = '[data-testid="launch-intro"]'
// The visible intro (its first frame on screen, to detach) is held to the spec's 4.0 s budget. Its
// first frame on screen is the stage animation's start: the stage's opacity runs on the compositor,
// so the animation starts in the frame that first draws the overlay. The page computes that frame's
// style earlier, while the window's first frame is still being drawn (85-130 ms on a warm Windows
// launch, 425 ms on a cold one), and nothing of the overlay is on screen in that time. The recordings
// agree: their first stage frame already shows the Termpolis card fading in.
// Upper slack for the wall-clock sanity checks: a loaded runner's late timer and React commit.
const UPPER_SLACK_MS = 250
// The strict ceiling: on the stage animation's clock (the clock the product's 4.0 s cap reads), the
// overlay is gone within the budget plus one frame. Measured (at the 2.0 s budget): 1984-1999 ms on
// every CI runner and 1984-1990 on Windows locally.
const REMOVAL_SLACK_MS = 50
// Lower slack: the timeline ends one 60 Hz frame inside the budget (INTRO_BUDGET_MS - INTRO_TOTAL_MS),
// the animation's start and the frame on screen can sit a frame or two apart, plus 30 ms.
const LOWER_SLACK_MS = INTRO_BUDGET_MS - INTRO_TOTAL_MS + 2 * 17 + 30
// The Termpolis card fades in from 0 on the stage: on the overlay's first frame it is a frame or two
// into its 150 ms at most.
const FIRST_OPACITY_MAX = 0.3
// The closing fade must be complete when the overlay goes: by the stage animation's own clock, the
// opacity its keyframes give at the moment of removal is at most this, a frame or two (25 ms) from the
// end of its 250 ms. Measured on the animation's clock, not on the last frame the page sampled: a
// starved runner samples a handful of frames in 2 s (11 on a macOS runner), so its last sample can sit
// 180 ms before the end of a fade that the compositor finished on time.
const FINAL_OPACITY_MAX = 0.1
// A sampled frame's stage opacity must be what the stage's keyframes give at that frame's time.
const SAMPLE_OPACITY_TOLERANCE = 0.02
// The controls' shifts of the removal timer. A cut of 200 ms removes the overlay 50 ms into its
// 250 ms fade (opacity 0.8, far above FINAL_OPACITY_MAX even with a starved runner's late timer); a
// delay of 400 ms holds it on screen well past the ceiling.
const CUT_FADE_MS = 200
const LATE_REMOVAL_MS = 400
// The reference frames compare only the card's artwork (a box around it), with an absolute pixel
// budget. Against the reference (termpolis / lumopolis), the real frames differ by 0 / 0 pixels on the
// Linux runner, 0 / 0 on the Windows runner, 1 / 16 on the macOS runner, and 47 / 87 on a
// GPU-rasterised Windows laptop; without the tag line by 1247 / 2167, without the card by 7194 / 8165
// (the laptop's frames). CI gets 40, a margin over the macOS runner's 16; a developer machine gets
// 130 for its GPU raster. Both are far under the smallest control.
const MAX_DIFF_PIXELS = process.env.CI ? 40 : 130
const VIEW_W = 1280
const VIEW_H = 720
// The stage's scale in that viewport (introScale): 0.9 * 720 / 1080.
const VIEW_STAGE_SCALE = 0.6
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
 * stage animation's start (the overlay's first frame on screen) once it has one, with the animation's
 * keyframes and end time; each sample also keeps the stage animation's own time. A MutationObserver
 * stamps the exact moment the overlay leaves the DOM (the overlay cancels its animations as it goes,
 * so everything about the stage animation is read while it runs).
 */
const TIMING_SCRIPT = `(() => {
  const m = window.__introTiming = { firstAt: null, firstFrameTime: null, firstStage: null, firstCard: null, lastStage: null, lastStageTime: null, frames: 0, startTime: null, stageEnd: null, stageDelay: null, stageEasing: null, stageKeyframes: null, detachedAt: null }
  let stageAnim = null
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
        // When the page computed that frame: now, as its callbacks run. Not the callback's argument,
        // the frame's begin time on the timeline, which a launch that holds the page before its first
        // frame leaves behind by as long as it held it (a Windows runner: 0.6 to 2 s). That begin time
        // is kept too: the stage animation's start is a frame time on the same timeline.
        m.firstAt = performance.now()
        m.firstFrameTime = at
        m.firstStage = stage
        m.firstCard = Number(getComputedStyle(root.querySelector('[data-testid="launch-intro-termpolis"]')).opacity)
      }
      if (m.startTime === null) {
        // The root's own animations: the stage's.
        const a = root.getAnimations().find((x) => typeof x.startTime === 'number')
        if (a) {
          stageAnim = a
          m.startTime = a.startTime
          const timing = a.effect.getComputedTiming()
          m.stageEnd = timing.endTime
          m.stageDelay = timing.delay
          m.stageEasing = timing.easing
          m.stageKeyframes = a.effect.getKeyframes().map((k) => ({ offset: k.computedOffset, opacity: Number(k.opacity), easing: k.easing }))
        }
      }
      if (m.firstAt !== null) {
        // The last frame inside the stage animation's active interval, with its time on that clock
        // (null before the animation has started). A frame at or past the end is not kept: its
        // opacity would be the fill's, not the keyframes'.
        if (!stageAnim || stageAnim.currentTime < m.stageEnd) {
          m.lastStage = stage
          m.lastStageTime = stageAnim ? stageAnim.currentTime : null
        }
        m.frames++
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

/**
 * The controls for the removal checks: a product whose removal timer is off by `shiftMs` (negative:
 * early, cutting the closing fade; positive: late). While the overlay is attached, the removal timer
 * (set when the stage animation is ready, to the rest of INTRO_TOTAL_MS) is shifted, and
 * `window.__introRemovalShifted` records that it was. The not-painted and hard-cap timers are untouched
 * (a late shift of 400 ms stays inside the hard cap: the cap counts 4984 ms from the overlay's first
 * frame, and the animation starts within NOT_PAINTED_MS of that frame, in practice 100-850 ms).
 */
function shiftRemovalScript(shiftMs: number): string {
  return `(() => {
  const realSetTimeout = window.setTimeout.bind(window)
  window.setTimeout = (cb, delay, ...args) => {
    const d = Number(delay)
    if (document.querySelector('${INTRO}') && d !== ${NOT_PAINTED_MS} && d > ${INTRO_TOTAL_MS - NOT_PAINTED_MS} && d <= ${INTRO_TOTAL_MS}) {
      window.__introRemovalShifted = true
      return realSetTimeout(cb, Math.max(0, d + ${shiftMs}), ...args)
    }
    return realSetTimeout(cb, delay, ...args)
  }
})()`
}

interface StageKeyframe { offset: number; opacity: number; easing: string }

interface Timing {
  firstAt: number | null
  firstFrameTime: number | null
  firstStage: number
  firstCard: number
  lastStage: number
  lastStageTime: number | null
  frames: number
  startTime: number | null
  stageEnd: number | null
  stageDelay: number | null
  stageEasing: string | null
  stageKeyframes: StageKeyframe[] | null
  detachedAt: number | null
}

/** The stage opacity the keyframes give at time `t` on the animation's clock (linear keyframes, no delay). */
function stageOpacityAt(keyframes: StageKeyframe[], end: number, t: number): number {
  const p = Math.min(1, Math.max(0, t / end))
  for (let i = 1; i < keyframes.length; i++) {
    const [a, b] = [keyframes[i - 1], keyframes[i]]
    if (p <= b.offset) return b.offset === a.offset ? b.opacity : a.opacity + ((b.opacity - a.opacity) * (p - a.offset)) / (b.offset - a.offset)
  }
  return keyframes[keyframes.length - 1].opacity
}

/** Waits for the overlay to leave, then returns the in-page timing record. */
async function introTiming(page: Page): Promise<Timing> {
  const read = (): Promise<Timing> => page.evaluate(() => (window as unknown as { __introTiming: Timing }).__introTiming)
  await expect.poll(async () => (await read()).detachedAt !== null, { timeout: 30_000 }).toBe(true)
  const m = await read()
  expect(m.firstAt, 'the intro left without its page ever computing a frame of it').not.toBeNull()
  expect(m.startTime, 'the intro left without ever reaching the screen').not.toBeNull()
  expect(m.stageKeyframes, 'the stage animation was never seen').not.toBeNull()
  // The interpolation below is linear: the stage's fade must be too, or the check must learn its easing.
  expect(m.stageEasing).toBe('linear')
  expect(m.stageDelay).toBe(0)
  expect((m.stageKeyframes as StageKeyframe[]).map((k) => k.easing)).toEqual((m.stageKeyframes as StageKeyframe[]).map(() => 'linear'))
  return m
}

/** When the overlay left, on the stage animation's clock: the time the product's 4.0 s cap measures. */
function removalOnClock(m: Timing): number {
  return (m.detachedAt as number) - (m.startTime as number)
}

/** Launches with a shifted removal timer, and returns the timing once the overlay has gone. */
async function shiftedRemoval(base: string, shiftMs: number): Promise<Timing> {
  const page = await launch(base, { init: [TIMING_SCRIPT, shiftRemovalScript(shiftMs)] })
  const m = await introTiming(page)
  expect(await page.evaluate(() => (window as unknown as { __introRemovalShifted?: boolean }).__introRemovalShifted), 'the control never shifted the removal timer').toBe(true)
  return m
}

/** The stage opacity its own keyframes give at the moment the overlay was removed. */
function opacityAtRemoval(m: Timing): number {
  return stageOpacityAt(m.stageKeyframes as StageKeyframe[], m.stageEnd as number, (m.detachedAt as number) - (m.startTime as number))
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
  // Device scale factor 1 whatever the display: on a machine whose window opens at another scale
  // (a laptop with mixed-scale monitors reported devicePixelRatio 0.99999998 and innerWidth 1281 for
  // a 1280 viewport), the stage lands a fraction of a pixel off, and every image of the artwork is
  // resampled at a different phase. The CI runners are already at 1.
  app = await electron.launch({ args: [...e2eLaunchArgs(labelFor(base)), '--force-device-scale-factor=1'], env })
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

/** A terminal's logical lines, trimmed: rows a long line wrapped onto (xterm's isWrapped) joined first. */
async function terminalLines(page: Page, id: string): Promise<string[]> {
  const lines = await page.evaluate(
    (tid) => (window as unknown as { __termpolis_terminal_lines?: (i?: string) => string[] }).__termpolis_terminal_lines?.(tid) ?? [],
    id,
  )
  return lines.map((l) => l.trim())
}

/**
 * Why a terminal's lines do not show `echo intro-ok` delivered exactly once, or null when they do.
 * The command's output appears once. The command line itself can show up twice for one delivery:
 * when the keys beat the shell's first prompt (seen on a Linux runner), the tty echoes the typed-ahead
 * line on its own, then the shell redraws it after its prompt. Doubled keys garble a line ('eecho',
 * 'echo intro-okecho intro-ok') and a repeated delivery runs the command twice. So every line with the
 * command is the command alone or a prompt followed by it, with the text once, and at most one of each.
 */
function typedOnceProblem(lines: string[]): string | null {
  const outputs = lines.filter((l) => l === 'intro-ok').length
  if (outputs !== 1) return `the output appears ${outputs} times`
  const commandLines = lines.filter((l) => l.includes('intro-ok') && l !== 'intro-ok')
  const bad = commandLines.find((l) => !/^(?:.*[$>#%] )?echo intro-ok$/.test(l) || l.split('intro-ok').length !== 2)
  if (bad !== undefined) return `a line carries the command doubled or garbled: ${bad}`
  const echoed = commandLines.filter((l) => l === 'echo intro-ok').length
  if (commandLines.length === 0 || echoed > 1 || commandLines.length - echoed > 1) return `the command line appears ${commandLines.length} times`
  return null
}

test.describe('launch intro', () => {
  test('is visible for at most 4.0 s, from its first frame on screen until it is gone, and never shows the app first', async () => {
    const page = await launch('intro-timing', { init: [WATCH_SCRIPT, TIMING_SCRIPT] })
    const m = await introTiming(page)
    const firstAt = m.firstAt as number
    const shownAt = m.startTime as number
    const detachedAt = m.detachedAt as number
    const visible = detachedAt - shownAt
    const keyframes = m.stageKeyframes as StageKeyframe[]
    const stageEnd = m.stageEnd as number
    const atRemoval = opacityAtRemoval(m)
    console.log(`intro timing: visible=${visible.toFixed(1)} ms (on screen to gone), first computed frame to gone=${(detachedAt - firstAt).toFixed(1)} ms, first computed frame to on screen=${(shownAt - firstAt).toFixed(1)} ms, frames=${m.frames}, first stage opacity=${m.firstStage.toFixed(3)}, first card opacity=${m.firstCard.toFixed(3)}, stage fade end=${stageEnd} ms, removal minus fade end=${(visible - stageEnd).toFixed(1)} ms, stage opacity at removal=${atRemoval.toFixed(3)}, last sample: stage opacity=${m.lastStage.toFixed(3)} at ${m.lastStageTime === null ? 'null' : m.lastStageTime.toFixed(1)} ms`)
    // The strict ceiling, on the stage animation's clock: gone within 4.0 s of its first frame on screen.
    expect(removalOnClock(m), "the overlay outlived the 4.0 s budget on the stage animation's clock").toBeLessThanOrEqual(INTRO_BUDGET_MS + REMOVAL_SLACK_MS)
    // Wall-clock sanity checks with a loaded runner's slack.
    expect(visible).toBeLessThanOrEqual(INTRO_BUDGET_MS + UPPER_SLACK_MS)
    expect(visible).toBeGreaterThanOrEqual(INTRO_BUDGET_MS - LOWER_SLACK_MS)
    // The overlay reaches the screen after the page first computes it (never before), and within
    // NOT_PAINTED_MS, or it would never have been shown; so it is in the page no longer than the hard cap.
    // (Never before: the start is a frame time, so it is held to that frame's own time.)
    expect(shownAt).toBeGreaterThanOrEqual(m.firstFrameTime as number)
    expect(shownAt - firstAt).toBeLessThan(NOT_PAINTED_MS)
    expect(detachedAt - firstAt).toBeLessThanOrEqual(INTRO_HARD_CAP_MS + UPPER_SLACK_MS)
    // Its first frame covers the app completely: the starting app is never seen before the intro.
    expect(m.firstStage).toBe(1)
    // And the Termpolis card fades in on it rather than appearing at full.
    expect(m.firstCard).toBeLessThan(FIRST_OPACITY_MAX)
    // The closing fade ends at nothing, inside the budget, and is (nearly) complete when the overlay
    // goes: on the stage animation's own clock, whatever the runner's frame rate.
    expect(stageOpacityAt(keyframes, stageEnd, stageEnd)).toBe(0)
    expect(stageEnd).toBeLessThanOrEqual(INTRO_BUDGET_MS)
    expect(atRemoval).toBeLessThanOrEqual(FINAL_OPACITY_MAX)
    // The measure catches a removal that the visible-time bounds alone let through: 60 ms early is
    // still inside the lower bound, and leaves the stage at a quarter of its opacity.
    expect(stageEnd - 60).toBeGreaterThanOrEqual(INTRO_BUDGET_MS - LOWER_SLACK_MS)
    expect(stageOpacityAt(keyframes, stageEnd, stageEnd - 60)).toBeGreaterThan(FINAL_OPACITY_MAX)
    // And the stage really shows that fade: the last frame the page sampled inside the animation's
    // active interval has the opacity the keyframes give at that frame's time (nothing else holds the
    // stage up). Frames at or past the end are never kept, so no fill behaviour is assumed.
    expect(m.lastStageTime, 'no frame was sampled inside the stage animation').not.toBeNull()
    expect(m.lastStageTime as number).toBeLessThan(stageEnd)
    expect(Math.abs(m.lastStage - stageOpacityAt(keyframes, stageEnd, m.lastStageTime as number))).toBeLessThanOrEqual(SAMPLE_OPACITY_TOLERANCE)
    // The watcher saw the overlay, so the "never shown" checks below can be trusted to see it too.
    expect(await page.evaluate(() => (window as unknown as { __introSeen?: boolean }).__introSeen)).toBe(true)
  })

  test('control: a closing fade cut short fails the fade check', async () => {
    const m = await shiftedRemoval('intro-cut-fade', -CUT_FADE_MS)
    const atRemoval = opacityAtRemoval(m)
    console.log(`cut fade: removal minus fade end=${(removalOnClock(m) - (m.stageEnd as number)).toFixed(1)} ms, stage opacity at removal=${atRemoval.toFixed(3)}`)
    expect(atRemoval).toBeGreaterThan(FINAL_OPACITY_MAX)
  })

  test('control: a late removal fails the 4.0 s ceiling', async () => {
    const m = await shiftedRemoval('intro-late-removal', LATE_REMOVAL_MS)
    console.log(`late removal: gone at ${removalOnClock(m).toFixed(1)} ms on the stage clock, ceiling ${INTRO_BUDGET_MS + REMOVAL_SLACK_MS} ms`)
    expect(removalOnClock(m)).toBeGreaterThan(INTRO_BUDGET_MS + REMOVAL_SLACK_MS)
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
      const lines = await terminalLines(page, id)
      return lines.filter((l) => l === 'intro-ok').length
    }, { timeout: 20_000 }).toBe(1)
    // And it stays one: not doubled by a late repeat.
    await page.waitForTimeout(1000)
    const lines = await terminalLines(page, id)
    expect(typedOnceProblem(lines), lines.join('\n')).toBeNull()
    // The check itself: the Linux runner's typed-ahead transcript and a PowerShell one pass, and every
    // shape of a doubled or repeated delivery fails.
    expect(typedOnceProblem(['echo intro-ok', 'runner@host:~$ echo intro-ok', 'intro-ok', 'runner@host:~$'])).toBeNull()
    expect(typedOnceProblem(['PS C:\\Users\\runner> echo intro-ok', 'intro-ok', 'PS C:\\Users\\runner>'])).toBeNull()
    // A long prompt plus the command wraps across rows. The rows are joined before this check, so a
    // single delivery reads as one prompted line however narrow the terminal.
    expect(typedOnceProblem(['echo intro-ok', 'runner@host:/home/runner/work/termpolis/termpolis/a/very/deep/working/directory$ echo intro-ok', 'intro-ok'])).toBeNull()
    for (const doubled of [
      ['runner@host:~$ echo intro-okecho intro-ok', 'intro-okecho intro-ok'],
      ['runner@host:~$ eecho intro-ok', 'eecho: command not found'],
      ['runner@host:~$ eecchhoo  iinnttrroo--ookk', 'eecchhoo: command not found'],
      ['runner@host:~$ echo intro-ok', 'intro-ok', 'runner@host:~$ echo intro-ok', 'intro-ok'],
      ['echo intro-ok', 'echo intro-ok', 'runner@host:~$ echo intro-ok', 'intro-ok'],
      ['echo intro-ok', 'runner@host:~$ echo intro-ok', 'runner@host:~$ echo intro-ok', 'intro-ok'],
      ['runner@host:/home/runner/work/termpolis/termpolis/a/very/deep/working/directory$ echo intro-okecho intro-ok', 'intro-okecho intro-ok'],
    ]) expect(typedOnceProblem(doubled), doubled.join(' / ')).not.toBeNull()
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

  for (const [card, t] of [['termpolis', 600], ['lumopolis', 2650]] as const) {
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
      // Compare the card's artwork only: a box around its pieces. A whole-viewport compare with a ratio
      // budget let a frame with the artwork missing pass.
      // The frame is taken at the geometry the reference was: scale 1, the fixed viewport, the stage at 0.6.
      const cardSel = `[data-testid="launch-intro-${card}"]`
      const geometry = await page.evaluate((s) => {
        const boxes = [...document.querySelectorAll(`${s} img, ${s} div`)].map((e) => e.getBoundingClientRect())
        const left = Math.min(...boxes.map((b) => b.left))
        const top = Math.min(...boxes.map((b) => b.top))
        return {
          dpr: window.devicePixelRatio, width: window.innerWidth, height: window.innerHeight,
          left, top,
          extentW: Math.max(...boxes.map((b) => b.right)) - left,
          extentH: Math.max(...boxes.map((b) => b.bottom)) - top,
        }
      }, cardSel)
      expect(geometry.dpr).toBe(1)
      expect([geometry.width, geometry.height]).toEqual([VIEW_W, VIEW_H])
      // The box's size is the artwork's extent: the pieces' sizes (the manifest's, at the stage's scale),
      // whatever fraction of a pixel the card starts at, rounded up once (a hair of slack absorbs
      // float noise). Its origin is the card's top-left rounded down once. So the box is the same size
      // on every machine, and the reference matches it exactly.
      const clip = {
        x: Math.floor(geometry.left),
        y: Math.floor(geometry.top),
        width: Math.ceil(geometry.extentW - 0.01),
        height: Math.ceil(geometry.extentH - 0.01),
      }
      const expectedSize = card === 'termpolis' ? [822, 391] : [828, 385]
      expect([clip.width, clip.height], `the ${card} artwork's extent at stage scale ${VIEW_STAGE_SCALE}`).toEqual(expectedSize)
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
