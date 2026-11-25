import { StrictMode } from 'react'
import { render, act, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LaunchIntro } from '../../../src/renderer/src/components/LaunchIntro/LaunchIntro'
import { INTRO_ART } from '../../../src/renderer/src/assets/intro/introManifest'
import { INTRO_HARD_CAP_MS, INTRO_TOTAL_MS, NOT_DRAWING_RECHECK_MS, NOT_PAINTED_MS, NO_FRAME_LIMIT_MS, ON_TIME_SLACK_MS, introSteps } from '../../../src/renderer/src/lib/launchIntro'

// A stand-in for a Web Animation: play-pending (startTime null) until the test starts it, the way a
// real one waits for the next frame the browser commits.
interface FakeAnimation {
  cancel: ReturnType<typeof vi.fn>
  startTime: number | null
  ready: Promise<FakeAnimation>
}
interface Call {
  el: Element
  keyframes: Keyframe[]
  options: KeyframeAnimationOptions
  anim: FakeAnimation
  start: (t: number | null) => void
}

let calls: Call[]
let saved: { animate: unknown; decode: unknown; matchMedia: unknown; termpolis: unknown; w: number; h: number }
let clock: number
const now = (): number => clock

const setViewport = (width: number, height: number): void => {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true })
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true, writable: true })
}

/** Starts every animation made so far at `startTime`, all on one frame, as the browser does. */
async function startAll(startTime: number | null): Promise<void> {
  await act(async () => {
    for (const c of calls) c.start(startTime)
    await Promise.resolve()
  })
}

// Frames the test runs by hand: once held, a requestAnimationFrame callback runs only on frame().
let frameQueue: FrameRequestCallback[] = []
let releaseFrames: (() => void) | null = null
function holdFrames(): void {
  const w = window as unknown as Record<string, unknown>
  const real = { raf: w.requestAnimationFrame, caf: w.cancelAnimationFrame }
  frameQueue = []
  w.requestAnimationFrame = (cb: FrameRequestCallback): number => frameQueue.push(cb)
  w.cancelAnimationFrame = (id: number): void => { frameQueue[id - 1] = () => {} }
  releaseFrames = () => { w.requestAnimationFrame = real.raf; w.cancelAnimationFrame = real.caf }
}
/** Runs the next frame: every callback asked for so far, at the test clock's time. */
function frame(): void {
  const due = frameQueue.slice()
  frameQueue = frameQueue.map(() => () => {})
  act(() => { for (const cb of due) cb(clock) })
}

const intro = (): HTMLElement | null => screen.queryByTestId('launch-intro')
const advance = (ms: number): void => act(() => { vi.advanceTimersByTime(ms) })
const imgProto = HTMLImageElement.prototype as unknown as Record<string, unknown>

beforeEach(() => {
  calls = []
  clock = 0
  const w = window as unknown as Record<string, unknown>
  saved = {
    animate: Element.prototype.animate, decode: imgProto.decode,
    matchMedia: w.matchMedia, termpolis: w.termpolis, w: window.innerWidth, h: window.innerHeight,
  }
  vi.useFakeTimers()
  Element.prototype.animate = function (this: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
    let resolve!: (a: FakeAnimation) => void
    let reject!: (e: unknown) => void
    const anim: FakeAnimation = {
      cancel: vi.fn(),
      startTime: null,
      ready: new Promise<FakeAnimation>((res, rej) => { resolve = res; reject = rej }),
    }
    // A real cancel rejects a pending ready with an AbortError, and marks that promise handled.
    anim.ready.catch(() => {})
    anim.cancel.mockImplementation(() => reject(new DOMException('cancelled', 'AbortError')))
    calls.push({ el: this, keyframes, options, anim, start: (t) => { anim.startTime = t; resolve(anim) } })
    return anim as unknown as Animation
  } as typeof Element.prototype.animate
  w.matchMedia = undefined
  w.termpolis = undefined
})

afterEach(() => {
  releaseFrames?.()
  releaseFrames = null
  vi.useRealTimers()
  const w = window as unknown as Record<string, unknown>
  Element.prototype.animate = saved.animate as typeof Element.prototype.animate
  imgProto.decode = saved.decode
  w.matchMedia = saved.matchMedia
  w.termpolis = saved.termpolis
  setViewport(saved.w, saved.h)
  vi.restoreAllMocks()
})

describe('LaunchIntro', () => {
  it('renders nothing, and animates nothing, when play is false', () => {
    render(<LaunchIntro play={false} />)
    expect(intro()).toBeNull()
    expect(calls).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('follows the preload flag when play is not given', () => {
    const w = window as unknown as Record<string, unknown>
    w.termpolis = { launchIntro: false }
    render(<LaunchIntro />).unmount()
    w.termpolis = {}
    render(<LaunchIntro />).unmount()
    expect(calls).toHaveLength(0)
    w.termpolis = { launchIntro: true }
    render(<LaunchIntro />)
    expect(intro()).not.toBeNull()
  })

  it("renders nothing when the user's setting is off, and plays when it is on", () => {
    const w = window as unknown as Record<string, unknown>
    w.termpolis = { launchIntro: true }
    localStorage.setItem('termpolis.launchIntro', '0')
    render(<LaunchIntro />).unmount()
    expect(calls).toHaveLength(0)
    localStorage.removeItem('termpolis.launchIntro')
    render(<LaunchIntro />)
    expect(intro()).not.toBeNull()
  })

  it('renders nothing where Element.animate is missing', () => {
    ;(Element.prototype as unknown as Record<string, unknown>).animate = undefined
    render(<LaunchIntro play />)
    expect(intro()).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('is in the page from mount, an opaque stage with its cards transparent, and every animation made before the first paint', () => {
    render(<LaunchIntro play reducedMotion={false} now={now} />)
    // No frame has run: the layout effect already made the overlay's animations.
    const root = screen.getByTestId('launch-intro')
    // The stage is opaque from its first frame, so the app under it never shows first; the cards are not.
    expect(root.style.opacity).toBe('')
    expect(screen.getByTestId('launch-intro-termpolis').style.opacity).toBe('0')
    expect(screen.getByTestId('launch-intro-lumopolis').style.opacity).toBe('0')
    expect(root.getAttribute('aria-hidden')).toBe('true')
    expect(root.style.pointerEvents).toBe('none')
    expect(root.style.position).toBe('fixed')
    expect(root.style.zIndex).toBe('9999')
    expect(root.style.background).toContain('rgb(3, 5, 11)')
    expect(screen.getByTestId('launch-intro-termpolis')).toBeTruthy()
    expect(screen.getByTestId('launch-intro-lumopolis')).toBeTruthy()
    const steps = introSteps(false)
    expect(calls).toHaveLength(steps.length)
    steps.forEach((s, i) => {
      expect(calls[i].keyframes).toEqual(s.keyframes)
      expect(calls[i].options).toEqual({ delay: s.delay, duration: s.duration, fill: 'both' })
      // Nothing backdates an animation: each starts on the frame the browser gives it.
      expect(calls[i].anim.startTime).toBeNull()
    })
    expect(calls[0].el).toBe(root)
  })

  it('uses the reduced steps when motion is reduced, by prop or by the media query', () => {
    render(<LaunchIntro play reducedMotion />).unmount()
    expect(calls).toHaveLength(introSteps(true).length)
    expect(calls.every((c) => c.keyframes.every((k) => !('filter' in k) && !('transform' in k) && !('width' in k)))).toBe(true)
    calls.length = 0
    ;(window as unknown as Record<string, unknown>).matchMedia = vi.fn(() => ({ matches: true }))
    render(<LaunchIntro play />)
    expect(window.matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)')
    expect(calls).toHaveLength(introSteps(true).length)
    expect(calls.every((c) => c.keyframes.every((k) => !('filter' in k)))).toBe(true)
  })

  it('plays the full reveal when matchMedia is missing', () => {
    render(<LaunchIntro play />)
    expect(calls.some((c) => c.keyframes.some((k) => 'filter' in k))).toBe(true)
  })

  it('removes itself INTRO_TOTAL_MS after the animation starts, and cancels its animations', async () => {
    render(<LaunchIntro play now={now} />)
    await startAll(0)
    advance(INTRO_TOTAL_MS - 1)
    expect(intro()).not.toBeNull()
    expect(calls.every((c) => c.anim.cancel.mock.calls.length === 0)).toBe(true)
    advance(1)
    expect(intro()).toBeNull()
    expect(calls.every((c) => c.anim.cancel.mock.calls.length === 1)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("runs the clock from the stage animation's real start, not from mount", async () => {
    render(<LaunchIntro play now={now} />)
    // The browser takes 300 ms to commit the first frame: none of that counts.
    advance(300)
    expect(intro()).not.toBeNull()
    // The animation started at 290 on the timeline; its ready callback runs at 300.
    clock = 300
    await startAll(290)
    advance(INTRO_TOTAL_MS - 10 - 1)
    expect(intro()).not.toBeNull()
    advance(1)
    expect(intro()).toBeNull()
  })

  it('takes the start as now when the animation reports no start time', async () => {
    render(<LaunchIntro play now={now} />)
    clock = 50
    await startAll(null)
    advance(INTRO_TOTAL_MS - 1)
    expect(intro()).not.toBeNull()
    advance(1)
    expect(intro()).toBeNull()
  })

  it('removes at once when the start was already a whole timeline ago', async () => {
    render(<LaunchIntro play now={now} />)
    clock = 900 + INTRO_TOTAL_MS
    await startAll(900)
    advance(0)
    expect(intro()).toBeNull()
  })

  it('ends at the hard cap from its first frame even when the clock runs backwards', async () => {
    holdFrames()
    clock = 5000
    render(<LaunchIntro play now={now} />)
    frame()
    // Started 900 ms after its first frame by the timeline, but read on a clock that went back to 0:
    // the computed removal would land long past the budget. The cap from the first frame holds.
    clock = 0
    await startAll(5900)
    advance(INTRO_HARD_CAP_MS - 1)
    expect(intro()).not.toBeNull()
    advance(1)
    expect(intro()).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('never shows in a window that draws no frame NOT_PAINTED_MS after mount, so a window restored later shows no stale intro', async () => {
    holdFrames()
    render(<LaunchIntro play now={now} />)
    // Minimised or covered before its first frame: the page's timers run (no background throttling)
    // but no frame comes. The guard fires on time with no frame, checks once more NOT_DRAWING_RECHECK_MS
    // later (on time again, still no frame), so the window is not drawing.
    clock = NOT_PAINTED_MS
    advance(NOT_PAINTED_MS)
    expect(intro()).not.toBeNull()
    clock = NOT_PAINTED_MS + NOT_DRAWING_RECHECK_MS - 1
    advance(NOT_DRAWING_RECHECK_MS - 1)
    expect(intro()).not.toBeNull()
    clock = NOT_PAINTED_MS + NOT_DRAWING_RECHECK_MS
    advance(1)
    expect(intro()).toBeNull()
    expect(calls.every((c) => c.anim.cancel.mock.calls.length === 1)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    // Restored an hour later: its first frame, and a start, change nothing.
    clock = 3_600_000
    frame()
    await startAll(3_600_000)
    advance(10_000)
    expect(intro()).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a busy thread that runs the guard late keeps waiting for the first frame, and plays the whole intro from it', async () => {
    holdFrames()
    render(<LaunchIntro play now={now} />)
    // The launch holds the main thread: the guard runs 2.5 s after mount, so its lateness says the page
    // was busy, not that the window is not drawing. It waits again, and runs late again.
    clock = 2500
    advance(NOT_PAINTED_MS)
    expect(intro()).not.toBeNull()
    clock = 5000
    advance(NOT_PAINTED_MS)
    expect(intro()).not.toBeNull()
    frame()
    clock = 5100
    await startAll(5100)
    advance(INTRO_TOTAL_MS - 1)
    expect(intro()).not.toBeNull()
    advance(1)
    expect(intro()).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a guard that ran late once still ends the intro when it next runs on time with no frame', () => {
    holdFrames()
    render(<LaunchIntro play now={now} />)
    clock = 1600
    advance(NOT_PAINTED_MS)
    expect(intro()).not.toBeNull()
    clock = 1600 + NOT_PAINTED_MS + ON_TIME_SLACK_MS - 1
    advance(NOT_PAINTED_MS)
    expect(intro()).not.toBeNull()
    clock += NOT_DRAWING_RECHECK_MS + ON_TIME_SLACK_MS - 1
    advance(NOT_DRAWING_RECHECK_MS)
    expect(intro()).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('counts a guard that runs ON_TIME_SLACK_MS late as late', () => {
    holdFrames()
    render(<LaunchIntro play now={now} />)
    clock = NOT_PAINTED_MS + ON_TIME_SLACK_MS
    advance(NOT_PAINTED_MS)
    expect(intro()).not.toBeNull()
    // The guard, armed again, and the no-frame limit from mount.
    expect(vi.getTimerCount()).toBe(2)
  })

  it('keeps the intro when the first frame comes just after an on-time guard, inside the recheck', async () => {
    holdFrames()
    render(<LaunchIntro play now={now} />)
    // Startup work holds the thread until just before the guard is due; the guard runs on time with
    // no frame, and the first frame comes 11 ms later, as a drawing compositor's next vsync does.
    clock = NOT_PAINTED_MS
    advance(NOT_PAINTED_MS)
    expect(intro()).not.toBeNull()
    clock = NOT_PAINTED_MS + 11
    advance(11)
    frame()
    await startAll(NOT_PAINTED_MS + 11)
    advance(NOT_DRAWING_RECHECK_MS)
    expect(intro()).not.toBeNull()
    advance(INTRO_TOTAL_MS - NOT_DRAWING_RECHECK_MS - 1)
    expect(intro()).not.toBeNull()
    advance(1)
    expect(intro()).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a recheck that runs late means a busy thread: the guard waits again', () => {
    holdFrames()
    render(<LaunchIntro play now={now} />)
    clock = NOT_PAINTED_MS
    advance(NOT_PAINTED_MS)
    clock = NOT_PAINTED_MS + NOT_DRAWING_RECHECK_MS + ON_TIME_SLACK_MS
    advance(NOT_DRAWING_RECHECK_MS)
    expect(intro()).not.toBeNull()
    // Waiting again from that late recheck: on time, then on time once more, with no frame, ends it.
    const at = clock
    clock = at + NOT_PAINTED_MS
    advance(NOT_PAINTED_MS)
    expect(intro()).not.toBeNull()
    clock = at + NOT_PAINTED_MS + NOT_DRAWING_RECHECK_MS
    advance(NOT_DRAWING_RECHECK_MS)
    expect(intro()).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ends at NO_FRAME_LIMIT_MS from mount when no frame has come, however late every guard runs', () => {
    holdFrames()
    render(<LaunchIntro play now={now} />)
    // Timers coalesced on a hidden app: every guard runs late, so it never decides; the limit does.
    for (let t = NOT_PAINTED_MS; t <= NO_FRAME_LIMIT_MS; t += NOT_PAINTED_MS) {
      clock += 2 * NOT_PAINTED_MS
      advance(NOT_PAINTED_MS - 1)
      expect(intro()).not.toBeNull()
      advance(1)
    }
    expect(intro()).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('never ends at NO_FRAME_LIMIT_MS an intro whose first frame came before it', async () => {
    holdFrames()
    render(<LaunchIntro play now={now} />)
    // A long busy launch: the guard always runs late, the first frame comes at 9.5 s, and the intro
    // plays its whole timeline past the 10 s limit.
    for (let t = NOT_PAINTED_MS; t < 9 * NOT_PAINTED_MS + 1; t += NOT_PAINTED_MS) {
      clock += 2 * NOT_PAINTED_MS
      advance(NOT_PAINTED_MS)
    }
    advance(NO_FRAME_LIMIT_MS - 500 - 9 * NOT_PAINTED_MS)
    expect(intro()).not.toBeNull()
    frame()
    await startAll(clock)
    advance(INTRO_TOTAL_MS - 1)
    expect(intro()).not.toBeNull()
    advance(1)
    expect(intro()).toBeNull()
  })

  it('renders nothing, and animates nothing, in a page that is hidden at mount', () => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    try {
      render(<LaunchIntro play now={now} />)
      expect(intro()).toBeNull()
      expect(calls).toHaveLength(0)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      delete (document as unknown as Record<string, unknown>).visibilityState
    }
    expect(document.visibilityState).not.toBe('hidden')
  })

  it('arms the hard cap from a start reported before any frame, and counts it from that start', async () => {
    holdFrames()
    render(<LaunchIntro play now={now} />)
    // The start is on screen, then the window is covered before the frame's own callback: no frame
    // ever runs. The clock reads 0 while the timeline says 5000, so the removal timer lands at 8984;
    // the cap, counted from the start, still ends it at INTRO_HARD_CAP_MS.
    await startAll(5000)
    advance(INTRO_HARD_CAP_MS - 1)
    expect(intro()).not.toBeNull()
    advance(1)
    expect(intro()).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('counts the hard cap from the start when the page learns of it late', async () => {
    holdFrames()
    render(<LaunchIntro play now={now} />)
    // Started at 900, learned of at 1700 on a busy page: the cap is armed for what is left of it from
    // that start, so it lands at 900 + INTRO_HARD_CAP_MS, not 1700 + INTRO_HARD_CAP_MS.
    clock = 1700
    advance(800)
    const arm = vi.spyOn(globalThis, 'setTimeout')
    await startAll(900)
    const delays = arm.mock.calls.map((c) => c[1])
    expect(delays).toContain(INTRO_HARD_CAP_MS - 800)
    expect(delays).not.toContain(INTRO_HARD_CAP_MS)
    advance(INTRO_TOTAL_MS - 800 - 1)
    expect(intro()).not.toBeNull()
    advance(1)
    expect(intro()).toBeNull()
  })

  it('a busy launch that holds the first frame back past NOT_PAINTED_MS still plays the whole intro, from its start', async () => {
    holdFrames()
    render(<LaunchIntro play now={now} />)
    // The app's own startup holds the main thread for 1.4 s after mount: the first frame, and the
    // overlay's first frame on screen, come after it.
    clock = 1400
    advance(1400)
    expect(intro()).not.toBeNull()
    frame()
    clock = 1600
    await startAll(1500)
    advance(INTRO_TOTAL_MS - 100 - 1)
    expect(intro()).not.toBeNull()
    advance(1)
    expect(intro()).toBeNull()
  })

  it('plays when its first frame reaches the screen NOT_PAINTED_MS after the page computed it, however long after mount', async () => {
    holdFrames()
    render(<LaunchIntro play now={now} />)
    clock = 300
    advance(300)
    frame()
    clock = 300 + NOT_PAINTED_MS
    await startAll(300 + NOT_PAINTED_MS)
    advance(INTRO_TOTAL_MS - 1)
    expect(intro()).not.toBeNull()
    advance(1)
    expect(intro()).toBeNull()
  })

  it('never shows when its first frame has not reached the screen NOT_PAINTED_MS after the page computed it', async () => {
    holdFrames()
    render(<LaunchIntro play now={now} />)
    frame()
    advance(NOT_PAINTED_MS - 1)
    expect(intro()).not.toBeNull()
    // The limit passes; the overlay waits one more frame, the first that can learn of a start the
    // compositor has already made, and none was made.
    advance(1)
    expect(intro()).not.toBeNull()
    expect(calls.every((c) => c.anim.startTime === null)).toBe(true)
    frame()
    expect(intro()).toBeNull()
    expect(calls.every((c) => c.anim.cancel.mock.calls.length === 1)).toBe(true)
    // A start that comes after giving up changes nothing.
    clock = 1500
    await startAll(1500)
    advance(5000)
    expect(intro()).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps an intro whose start the compositor made in time but the page learns of late', async () => {
    holdFrames()
    render(<LaunchIntro play now={now} />)
    frame()
    // A busy main thread runs the limit's timer late, after the compositor started the animation at
    // 900 but before the page's ready callback has run.
    clock = 1100
    advance(NOT_PAINTED_MS)
    for (const c of calls) c.anim.startTime = 900
    frame()
    expect(intro()).not.toBeNull()
    await startAll(900)
    advance(INTRO_TOTAL_MS - 200 - 1)
    expect(intro()).not.toBeNull()
    advance(1)
    expect(intro()).toBeNull()
  })

  it('never shows when the start is reported past the limit from its first frame, before any timer has run', async () => {
    holdFrames()
    render(<LaunchIntro play now={now} />)
    frame()
    clock = 90_000
    await startAll(NOT_PAINTED_MS + 1)
    expect(intro()).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("counts on performance.now() when given no clock, and is gone by the hard cap from its first frame", () => {
    holdFrames()
    const read = vi.spyOn(performance, 'now')
    render(<LaunchIntro play />)
    frame()
    expect(read).toHaveBeenCalled()
    advance(INTRO_HARD_CAP_MS - 1)
    expect(intro()).not.toBeNull()
    advance(1)
    expect(intro()).toBeNull()
  })

  it('takes a start reported before its first frame callback as that first frame', async () => {
    holdFrames()
    render(<LaunchIntro play now={now} />)
    // Ready can resolve ahead of the frame's own callbacks: the start is on screen, so the page
    // computed that frame no later.
    clock = 5000
    await startAll(5000)
    clock = 5016
    frame()
    advance(INTRO_TOTAL_MS - 1)
    expect(intro()).not.toBeNull()
    advance(1)
    expect(intro()).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('asks the browser to decode the artwork at mount, without waiting for it', async () => {
    const decode = vi.fn(() => Promise.reject(new Error('EncodingError')))
    imgProto.decode = decode
    render(<LaunchIntro play now={now} />)
    expect(decode).toHaveBeenCalledTimes(1 + 2 + 9 + 1)
    // A failed decode is no error, and nothing waits on it.
    await startAll(0)
    advance(INTRO_TOTAL_MS)
    expect(intro()).toBeNull()
  })

  it('a key ends it at once, from mount, and still reaches the focused textarea exactly once', () => {
    const area = document.createElement('textarea')
    document.body.appendChild(area)
    area.focus()
    const seen = vi.fn()
    area.addEventListener('keydown', seen)
    render(<LaunchIntro play />)
    const ev = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true })
    act(() => { area.dispatchEvent(ev) })
    expect(ev.defaultPrevented).toBe(false)
    expect(seen).toHaveBeenCalledTimes(1)
    expect(intro()).toBeNull()
    expect(document.activeElement).toBe(area)
    const later = new KeyboardEvent('keydown', { key: 'b', bubbles: true, cancelable: true })
    act(() => { area.dispatchEvent(later) })
    expect(later.defaultPrevented).toBe(false)
    expect(seen).toHaveBeenCalledTimes(2)
    advance(5000)
    expect(intro()).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
    area.remove()
  })

  it('a pointerdown ends it, and passes on untouched', async () => {
    render(<LaunchIntro play now={now} />)
    await startAll(0)
    const ev = new Event('pointerdown', { bubbles: true, cancelable: true })
    act(() => { window.dispatchEvent(ev) })
    expect(ev.defaultPrevented).toBe(false)
    expect(intro()).toBeNull()
  })

  it('ends once when two inputs land in the same task', () => {
    render(<LaunchIntro play />)
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
      window.dispatchEvent(new Event('pointerdown'))
    })
    expect(intro()).toBeNull()
    expect(calls.every((c) => c.anim.cancel.mock.calls.length === 1)).toBe(true)
  })

  it('never takes focus and has no tabIndex', () => {
    const focus = vi.spyOn(HTMLElement.prototype, 'focus')
    render(<LaunchIntro play />)
    const root = screen.getByTestId('launch-intro')
    expect(focus).not.toHaveBeenCalled()
    expect(root.hasAttribute('tabindex')).toBe(false)
    expect(root.querySelector('[tabindex]')).toBeNull()
  })

  it('puts the 2x artwork in every srcSet and lays the letters out from their offsets', () => {
    render(<LaunchIntro play />)
    const imgs = [...screen.getByTestId('launch-intro').querySelectorAll('img')]
    const letters = [...screen.getByTestId('launch-intro-lumopolis').querySelectorAll('img')].slice(0, 9)
    expect(imgs).toHaveLength(1 + 2 + 9 + 1)
    const withSet = imgs.filter((i) => i.getAttribute('srcset'))
    expect(withSet).toHaveLength(12)
    for (const img of withSet) expect(img.getAttribute('srcset')).toMatch(/ 1x, .+ 2x$/)
    expect(letters[3].getAttribute('srcset')).toBe(`${INTRO_ART.letters[3].src1x} 1x, ${INTRO_ART.letters[3].src2x} 2x`)
    // Glyph spacing equals the film's span spacing, whatever the absolute origin.
    const left = (i: number): number => parseFloat(letters[i].style.left)
    for (let i = 1; i < 9; i++) expect(left(i) - left(0)).toBeCloseTo(INTRO_ART.letterOffsets[i], 5)
    // The film's mark box (padding-left 34, then the nine spans) is centred on the 1920 stage.
    const last = INTRO_ART.letters[8]
    const markW = 34 + INTRO_ART.letterOffsets[8] + (last.width - 2 * INTRO_ART.pad)
    expect(left(0) + INTRO_ART.pad - 34).toBeCloseTo((1920 - markW) / 2, 5)
  })

  it('scales the stage to the window and follows a resize from mount, before the animation starts', () => {
    setViewport(800, 600)
    render(<LaunchIntro play />)
    const stage = (): HTMLElement => screen.getByTestId('launch-intro').firstElementChild as HTMLElement
    expect(stage().style.transform).toBe(`scale(${(800 * 0.9) / 1920})`)
    setViewport(3840, 2160)
    act(() => { window.dispatchEvent(new Event('resize')) })
    expect(stage().style.transform).toBe('scale(1)')
  })

  it('cleans up on unmount: animations cancelled, listeners and timers gone, a late start ignored', async () => {
    const view = render(<LaunchIntro play now={now} />)
    view.unmount()
    expect(calls.every((c) => c.anim.cancel.mock.calls.length === 1)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'x' })) })
    await startAll(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores a start that lands as it unmounts', async () => {
    const view = render(<LaunchIntro play now={now} />)
    // The ready callback is queued, then the overlay unmounts before it runs.
    act(() => {
      for (const c of calls) c.start(0)
      view.unmount()
    })
    await act(async () => { await Promise.resolve() })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cleans up after a start too', async () => {
    const view = render(<LaunchIntro play now={now} />)
    await startAll(0)
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('is idempotent under StrictMode double effects', async () => {
    render(<StrictMode><LaunchIntro play now={now} /></StrictMode>)
    expect(intro()).not.toBeNull()
    const live = calls.filter((c) => c.anim.cancel.mock.calls.length === 0)
    expect(live).toHaveLength(introSteps(false).length)
    await startAll(0)
    advance(INTRO_TOTAL_MS)
    expect(intro()).toBeNull()
    expect(calls.every((c) => c.anim.cancel.mock.calls.length === 1)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
})
