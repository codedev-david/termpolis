import { StrictMode } from 'react'
import { render, act, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LaunchIntro } from '../../../src/renderer/src/components/LaunchIntro/LaunchIntro'
import { INTRO_ART } from '../../../src/renderer/src/assets/intro/introManifest'
import { introSteps } from '../../../src/renderer/src/lib/launchIntro'

type Call = { el: Element; keyframes: Keyframe[]; options: KeyframeAnimationOptions; cancel: ReturnType<typeof vi.fn> }

let calls: Call[]
let frames: Map<number, FrameRequestCallback>
let nextFrame: number
let saved: { animate: unknown; raf: unknown; caf: unknown; matchMedia: unknown; termpolis: unknown; w: number; h: number }

const flushFrame = () => {
  const queued = [...frames.values()]
  frames.clear()
  act(() => { for (const cb of queued) cb(0) })
}

const setViewport = (width: number, height: number) => {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true })
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true, writable: true })
}

beforeEach(() => {
  calls = []
  frames = new Map()
  nextFrame = 1
  const w = window as unknown as Record<string, unknown>
  saved = {
    animate: Element.prototype.animate, raf: w.requestAnimationFrame, caf: w.cancelAnimationFrame,
    matchMedia: w.matchMedia, termpolis: w.termpolis, w: window.innerWidth, h: window.innerHeight,
  }
  vi.useFakeTimers()
  Element.prototype.animate = function (this: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
    const cancel = vi.fn()
    calls.push({ el: this, keyframes, options, cancel })
    return { cancel } as unknown as Animation
  } as typeof Element.prototype.animate
  w.requestAnimationFrame = (cb: FrameRequestCallback) => { frames.set(nextFrame, cb); return nextFrame++ }
  w.cancelAnimationFrame = (id: number) => { frames.delete(id) }
  w.matchMedia = undefined
  w.termpolis = undefined
})

afterEach(() => {
  vi.useRealTimers()
  const w = window as unknown as Record<string, unknown>
  Element.prototype.animate = saved.animate as typeof Element.prototype.animate
  w.requestAnimationFrame = saved.raf
  w.cancelAnimationFrame = saved.caf
  w.matchMedia = saved.matchMedia
  w.termpolis = saved.termpolis
  setViewport(saved.w, saved.h)
  vi.restoreAllMocks()
})

describe('LaunchIntro', () => {
  it('renders nothing when play is false', () => {
    render(<LaunchIntro play={false} />)
    flushFrame()
    expect(screen.queryByTestId('launch-intro')).toBeNull()
    expect(frames.size).toBe(0)
    expect(calls).toHaveLength(0)
  })

  it('follows the preload flag when play is not given', () => {
    const w = window as unknown as Record<string, unknown>
    w.termpolis = { launchIntro: false }
    const off = render(<LaunchIntro />)
    flushFrame()
    expect(screen.queryByTestId('launch-intro')).toBeNull()
    off.unmount()
    w.termpolis = {}
    render(<LaunchIntro />).unmount()
    expect(calls).toHaveLength(0)
    w.termpolis = { launchIntro: true }
    render(<LaunchIntro />)
    flushFrame()
    expect(screen.getByTestId('launch-intro')).toBeTruthy()
  })

  it('renders nothing where Element.animate is missing', () => {
    ;(Element.prototype as unknown as Record<string, unknown>).animate = undefined
    render(<LaunchIntro play />)
    expect(frames.size).toBe(0)
    expect(screen.queryByTestId('launch-intro')).toBeNull()
  })

  it('renders nothing before the first frame, then animates once per step', () => {
    render(<LaunchIntro play reducedMotion={false} />)
    expect(screen.queryByTestId('launch-intro')).toBeNull()
    expect(calls).toHaveLength(0)
    flushFrame()
    const root = screen.getByTestId('launch-intro')
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
      expect(calls[i].options).toMatchObject({ delay: s.delay, duration: s.duration, fill: 'both' })
    })
    expect(calls[0].el).toBe(root)
  })

  it('uses the reduced steps when motion is reduced, by prop or by the media query', () => {
    render(<LaunchIntro play reducedMotion />)
    flushFrame()
    expect(calls).toHaveLength(introSteps(true).length)
    expect(calls.every((c) => c.keyframes.every((k) => !('filter' in k) && !('transform' in k)))).toBe(true)
    calls.length = 0
    ;(window as unknown as Record<string, unknown>).matchMedia = vi.fn(() => ({ matches: true }))
    render(<LaunchIntro play />)
    flushFrame()
    expect(window.matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)')
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((c) => c.keyframes.every((k) => !('filter' in k)))).toBe(true)
  })

  it('plays the full reveal when matchMedia is missing', () => {
    render(<LaunchIntro play />)
    flushFrame()
    expect(calls.some((c) => c.keyframes.some((k) => 'filter' in k))).toBe(true)
  })

  it('removes itself 2000 ms after first paint and cancels its animations', () => {
    render(<LaunchIntro play />)
    flushFrame()
    act(() => { vi.advanceTimersByTime(1999) })
    expect(screen.queryByTestId('launch-intro')).not.toBeNull()
    act(() => { vi.advanceTimersByTime(1) })
    expect(screen.queryByTestId('launch-intro')).toBeNull()
    expect(calls.every((c) => c.cancel.mock.calls.length === 1)).toBe(true)
  })

  it('a key ends it at once and still reaches the focused textarea exactly once', () => {
    const area = document.createElement('textarea')
    document.body.appendChild(area)
    area.focus()
    const seen = vi.fn()
    area.addEventListener('keydown', seen)
    render(<LaunchIntro play />)
    flushFrame()
    const ev = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true })
    act(() => { area.dispatchEvent(ev) })
    expect(ev.defaultPrevented).toBe(false)
    expect(seen).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('launch-intro')).toBeNull()
    expect(document.activeElement).toBe(area)
    // After removal a key is a no-op.
    const later = new KeyboardEvent('keydown', { key: 'b', bubbles: true, cancelable: true })
    act(() => { area.dispatchEvent(later) })
    expect(later.defaultPrevented).toBe(false)
    expect(seen).toHaveBeenCalledTimes(2)
    expect(screen.queryByTestId('launch-intro')).toBeNull()
    act(() => { vi.advanceTimersByTime(3000) })
    expect(screen.queryByTestId('launch-intro')).toBeNull()
    area.remove()
  })

  it('a pointerdown ends it', () => {
    render(<LaunchIntro play />)
    flushFrame()
    act(() => { window.dispatchEvent(new Event('pointerdown', { bubbles: true })) })
    expect(screen.queryByTestId('launch-intro')).toBeNull()
  })

  it('never takes focus and has no tabIndex', () => {
    const focus = vi.spyOn(HTMLElement.prototype, 'focus')
    render(<LaunchIntro play />)
    flushFrame()
    const root = screen.getByTestId('launch-intro')
    expect(focus).not.toHaveBeenCalled()
    expect(root.hasAttribute('tabindex')).toBe(false)
    expect(root.querySelector('[tabindex]')).toBeNull()
  })

  it('never appears when the first frame does not come within 1000 ms', () => {
    render(<LaunchIntro play />)
    act(() => { vi.advanceTimersByTime(1000) })
    expect(screen.queryByTestId('launch-intro')).toBeNull()
    expect(frames.size).toBe(0)
    flushFrame()
    expect(screen.queryByTestId('launch-intro')).toBeNull()
    act(() => { vi.advanceTimersByTime(5000) })
    expect(calls).toHaveLength(0)
  })

  it('never appears when the first frame arrives late (a window restored later)', () => {
    let t = 0
    render(<LaunchIntro play now={() => t} />)
    t = 90_000
    flushFrame()
    expect(screen.queryByTestId('launch-intro')).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('plays when the first frame comes just inside the limit', () => {
    let t = 0
    render(<LaunchIntro play now={() => t} />)
    t = 1000
    flushFrame()
    expect(screen.queryByTestId('launch-intro')).not.toBeNull()
  })

  it('puts the 2x artwork in every srcSet and lays the letters out from their offsets', () => {
    render(<LaunchIntro play />)
    flushFrame()
    const imgs = [...screen.getByTestId('launch-intro').querySelectorAll('img')]
    const letters = [...screen.getByTestId('launch-intro-lumopolis').querySelectorAll('img')].slice(0, 9)
    expect(imgs).toHaveLength(1 + 2 + 9 + 1)
    const withSet = imgs.filter((i) => i.getAttribute('srcset'))
    expect(withSet).toHaveLength(12)
    for (const img of withSet) expect(img.getAttribute('srcset')).toMatch(/ 1x, .+ 2x$/)
    expect(letters[3].getAttribute('srcset')).toBe(`${INTRO_ART.letters[3].src1x} 1x, ${INTRO_ART.letters[3].src2x} 2x`)
    // Glyph spacing equals the film's span spacing, whatever the absolute origin.
    const left = (i: number) => parseFloat(letters[i].style.left)
    for (let i = 1; i < 9; i++) expect(left(i) - left(0)).toBeCloseTo(INTRO_ART.letterOffsets[i], 5)
    // The film's mark box (padding-left 34, then the nine spans) is centred on the 1920 stage.
    const last = INTRO_ART.letters[8]
    const markW = 34 + INTRO_ART.letterOffsets[8] + (last.width - 2 * INTRO_ART.pad)
    expect(left(0) + INTRO_ART.pad - 34).toBeCloseTo((1920 - markW) / 2, 5)
  })

  it('scales the stage to the window and follows a resize', () => {
    setViewport(800, 600)
    render(<LaunchIntro play />)
    flushFrame()
    const stage = () => screen.getByTestId('launch-intro').firstElementChild as HTMLElement
    expect(stage().style.transform).toBe(`scale(${(800 * 0.9) / 1920})`)
    setViewport(3840, 2160)
    act(() => { window.dispatchEvent(new Event('resize')) })
    expect(stage().style.transform).toBe('scale(1)')
  })

  it('cleans up on unmount: animations cancelled, listeners and timers gone', () => {
    const view = render(<LaunchIntro play />)
    flushFrame()
    view.unmount()
    expect(calls.every((c) => c.cancel.mock.calls.length === 1)).toBe(true)
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'x' }))
      vi.advanceTimersByTime(5000)
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels a pending frame on unmount', () => {
    const view = render(<LaunchIntro play />)
    expect(frames.size).toBe(1)
    view.unmount()
    expect(frames.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('is idempotent under StrictMode double effects', () => {
    render(<StrictMode><LaunchIntro play /></StrictMode>)
    flushFrame()
    expect(screen.queryByTestId('launch-intro')).not.toBeNull()
    const live = calls.filter((c) => c.cancel.mock.calls.length === 0)
    expect(live).toHaveLength(introSteps(false).length)
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' })) })
    expect(screen.queryByTestId('launch-intro')).toBeNull()
    expect(calls.every((c) => c.cancel.mock.calls.length === 1)).toBe(true)
    act(() => { vi.advanceTimersByTime(5000) })
    expect(vi.getTimerCount()).toBe(0)
  })
})
