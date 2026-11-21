import { StrictMode } from 'react'
import { render, act, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LaunchIntro } from '../../../src/renderer/src/components/LaunchIntro/LaunchIntro'
import { INTRO_ART } from '../../../src/renderer/src/assets/intro/introManifest'
import { INTRO_HARD_CAP_MS, INTRO_TOTAL_MS, NOT_PAINTED_MS, introSteps } from '../../../src/renderer/src/lib/launchIntro'

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

  it('ends at the hard cap from mount even when the clock runs backwards', async () => {
    clock = 5000
    render(<LaunchIntro play now={now} />)
    // Started 900 ms after mount by the timeline, but read on a clock that went back to 0: the
    // computed removal would land long past the budget. The cap from mount holds.
    clock = 0
    await startAll(5900)
    advance(INTRO_HARD_CAP_MS - 1)
    expect(intro()).not.toBeNull()
    advance(1)
    expect(intro()).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('never shows when the animation has not started within NOT_PAINTED_MS', async () => {
    render(<LaunchIntro play now={now} />)
    advance(NOT_PAINTED_MS - 1)
    // An animation that never started never had a frame: the overlay was never painted.
    expect(intro()).not.toBeNull()
    expect(calls.every((c) => c.anim.startTime === null)).toBe(true)
    advance(1)
    expect(intro()).toBeNull()
    expect(calls.every((c) => c.anim.cancel.mock.calls.length === 1)).toBe(true)
    // A start that comes after giving up changes nothing.
    clock = 1500
    await startAll(1500)
    advance(5000)
    expect(intro()).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('never shows when the start is reported past the limit, before its timer has run', async () => {
    render(<LaunchIntro play now={now} />)
    clock = 90_000
    await startAll(NOT_PAINTED_MS + 1)
    expect(intro()).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('plays when the animation starts just inside the limit', async () => {
    render(<LaunchIntro play now={now} />)
    clock = NOT_PAINTED_MS
    await startAll(NOT_PAINTED_MS)
    advance(NOT_PAINTED_MS)
    expect(intro()).not.toBeNull()
    advance(INTRO_TOTAL_MS - NOT_PAINTED_MS)
    expect(intro()).toBeNull()
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
