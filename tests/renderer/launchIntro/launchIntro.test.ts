import { describe, it, expect } from 'vitest'
import { INTRO_TIMELINE, INTRO_TOTAL_MS, NOT_PAINTED_MS, introScale, introSteps } from '../../../src/renderer/src/lib/launchIntro'

describe('introSteps', () => {
  it('pins the timeline the spec leaves to the builder', () => {
    expect(INTRO_TOTAL_MS).toBe(2000)
    expect(NOT_PAINTED_MS).toBe(1000)
    expect(INTRO_TIMELINE.letters.start + 8 * INTRO_TIMELINE.letters.stagger + INTRO_TIMELINE.letters.each).toBe(1670)
  })

  it.each([false, true])('every step ends by 2000 ms (reduced=%s)', (reduced) => {
    const steps = introSteps(reduced)
    expect(steps.length).toBeGreaterThan(9)
    expect(Math.max(...steps.map((s) => s.delay + s.duration))).toBeLessThanOrEqual(INTRO_TOTAL_MS)
    for (const s of steps) expect(s.delay).toBeGreaterThanOrEqual(0)
  })

  it('reduced motion has no filter or transform keyframes, and no rule growth', () => {
    for (const s of introSteps(true)) {
      for (const k of s.keyframes) {
        expect(k).not.toHaveProperty('filter')
        expect(k).not.toHaveProperty('transform')
        expect(k).not.toHaveProperty('width')
      }
    }
  })

  it("the letters reveal in order with the film's blur and rise", () => {
    const letters = introSteps(false).filter((s) => s.target === 'letter')
    expect(letters).toHaveLength(9)
    letters.forEach((s, i) => {
      expect(s.index).toBe(i)
      expect(s.delay).toBe(1050 + 40 * i)
      expect(s.duration).toBe(300)
      expect(s.keyframes[0]).toMatchObject({ opacity: 0, filter: 'blur(14px)', transform: 'translateY(18px)' })
      expect(s.keyframes[1]).toMatchObject({ opacity: 1, filter: 'blur(0px)', transform: 'translateY(0px)' })
    })
  })

  it('the rule grows, the tag lifts, and the card steps are opacity only', () => {
    const steps = introSteps(false)
    const rule = steps.find((s) => s.target === 'rule')!
    expect(rule.keyframes[0]).toMatchObject({ width: '0px' })
    expect(rule.keyframes[1]).toMatchObject({ width: '900px' })
    expect(steps.find((s) => s.target === 'tag')!.keyframes[0]).toMatchObject({ transform: 'translateY(14px)' })
    for (const t of ['stage', 'termpolis', 'lumopolis'] as const) {
      for (const k of steps.find((s) => s.target === t)!.keyframes) {
        expect(Object.keys(k).every((p) => p === 'opacity' || p === 'offset')).toBe(true)
      }
    }
  })

  it('reduced motion fades the same targets', () => {
    const targets = (r: boolean) => introSteps(r).map((s) => s.target)
    expect(targets(true)).toEqual(targets(false))
  })
})

describe('introScale', () => {
  it.each([
    [800, 600],
    [3440, 1440],
    [900, 1600],
    [1920, 1080],
    [5120, 2880],
  ])('keeps the artwork whole and inside 90 percent at %ix%i', (width, height) => {
    const s = introScale({ width, height })
    expect(s).toBeLessThanOrEqual(1)
    expect(s).toBeGreaterThan(0)
    expect(1920 * s).toBeLessThanOrEqual(0.9 * width + 1e-9)
    expect(1080 * s).toBeLessThanOrEqual(0.9 * height + 1e-9)
  })
})
