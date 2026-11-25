// The launch intro's timeline: pure data, so the 4.0 s budget is provable in a unit test.
// All times are ms from the start of the overlay's own animation, the first frame it can paint.
// The spec fixes the 4.0 s maximum (David, 2026-11-21: one more second on each card than the first
// 2.0 s) and leaves the split open; this is the builder's split.

/** The spec's hard maximum, from the first visible frame to fully gone. */
export const INTRO_BUDGET_MS = 4000
/**
 * Where the timeline, and the removal, end: one 60 Hz frame inside the budget, so a removal that
 * lands a frame late still lands by 4000 ms.
 */
export const INTRO_TOTAL_MS = INTRO_BUDGET_MS - 16
/**
 * If the overlay's animation has not started this long after the page computed its first frame of the
 * overlay, the intro never appears. Counted from that frame, not mount: a launch that keeps the page
 * from rendering delays the intro and never eats into it.
 */
export const NOT_PAINTED_MS = 1000
/** Backstop, from the same first frame: the overlay is gone by now, whatever the animation or its timers did. */
export const INTRO_HARD_CAP_MS = NOT_PAINTED_MS + INTRO_TOTAL_MS

export const INTRO_TIMELINE = {
  fadeIn: [0, 150],
  termpolisHold: [150, 1800],
  crossfade: [1800, 2050],
  // Still one letter after another; the word is whole at 2050 + 8 * 30 + 260 = 2550.
  letters: { start: 2050, stagger: 30, each: 260 },
  rule: [2100, 2500],
  tag: [2250, 2550],
  // The full word, rule and tag hold 1184 ms before this 250 ms fade to the app.
  fadeOut: [3734, INTRO_TOTAL_MS],
} as const

export const INTRO_LETTER_COUNT = 9
/** The film's rule at its final width (stage px). */
export const INTRO_RULE_WIDTH = 900

export interface IntroStep {
  target: 'stage' | 'termpolis' | 'lumopolis' | 'letter' | 'rule' | 'tag'
  index?: number
  keyframes: Keyframe[]
  delay: number
  duration: number
}

// cubic-bezier(.45,0,.55,1) approximates the film's smoothstep x*x*(3-2*x).
const SMOOTH = 'cubic-bezier(.45,0,.55,1)'

function fade(from: number, to: number): Keyframe[] {
  return [{ opacity: from }, { opacity: to }]
}

export function introSteps(reduced: boolean): IntroStep[] {
  const T = INTRO_TIMELINE
  const [fadeInEnd, holdEnd] = [T.fadeIn[1], T.termpolisHold[1]]
  const [xStart, xEnd] = T.crossfade
  const [outStart, outEnd] = T.fadeOut
  // The stage is opaque from its first frame, so the starting app is never seen before the intro
  // (a stage fading up from 0 shows the app on its first frames). It only fades out, to the app.
  const stage: IntroStep = {
    target: 'stage',
    delay: 0,
    duration: outEnd,
    keyframes: [
      { opacity: 1, offset: 0 },
      { opacity: 1, offset: outStart / outEnd },
      { opacity: 0, offset: 1 },
    ],
  }
  // The Termpolis card fades in on the stage, holds, then leaves while the Lumopolis card arrives.
  const termpolis: IntroStep = {
    target: 'termpolis',
    delay: 0,
    duration: xEnd,
    keyframes: [
      { opacity: 0, offset: 0 },
      { opacity: 1, offset: fadeInEnd / xEnd },
      { opacity: 1, offset: holdEnd / xEnd },
      { opacity: 0, offset: 1 },
    ],
  }
  const lumopolis: IntroStep = { target: 'lumopolis', delay: xStart, duration: xEnd - xStart, keyframes: fade(0, 1) }
  const steps: IntroStep[] = [stage, termpolis, lumopolis]
  const { start, stagger, each } = T.letters
  for (let i = 0; i < INTRO_LETTER_COUNT; i++) {
    steps.push(reduced
      // No reveal: every letter, the rule and the tag take plain fades within the same 4 s.
      ? { target: 'letter', index: i, delay: start, duration: each - 50, keyframes: fade(0, 1) }
      : {
          target: 'letter',
          index: i,
          delay: start + stagger * i,
          duration: each,
          keyframes: [
            { opacity: 0, filter: 'blur(14px)', transform: 'translateY(18px)', easing: SMOOTH },
            { opacity: 1, filter: 'blur(0px)', transform: 'translateY(0px)' },
          ],
        })
  }
  const [ruleStart, ruleEnd] = T.rule
  const [tagStart, tagEnd] = T.tag
  steps.push(reduced
    ? { target: 'rule', delay: start, duration: each - 50, keyframes: fade(0, 1) }
    : {
        target: 'rule',
        delay: ruleStart,
        duration: ruleEnd - ruleStart,
        keyframes: [
          { opacity: 0, width: '0px', easing: SMOOTH },
          { opacity: 1, width: `${INTRO_RULE_WIDTH}px` },
        ],
      })
  steps.push(reduced
    ? { target: 'tag', delay: start, duration: each - 50, keyframes: fade(0, 1) }
    : {
        target: 'tag',
        delay: tagStart,
        duration: tagEnd - tagStart,
        keyframes: [
          { opacity: 0, transform: 'translateY(14px)', easing: SMOOTH },
          { opacity: 1, transform: 'translateY(0px)' },
        ],
      })
  return steps
}

/** The 1920x1080 stage shrinks to stay whole and inside 90% of the window; it never grows. */
export function introScale(viewport: { width: number; height: number }): number {
  return Math.min(1, (viewport.width * 0.9) / 1920, (viewport.height * 0.9) / 1080)
}

export const INTRO_SETTING_KEY = 'termpolis.launchIntro'

/** On unless the stored value is exactly '0'. Blocked storage or any other value reads as on. */
export function introEnabled(storage: Pick<Storage, 'getItem'> = localStorage): boolean {
  try {
    return storage.getItem(INTRO_SETTING_KEY) !== '0'
  } catch {
    return true
  }
}

export function setIntroEnabled(on: boolean, storage: Pick<Storage, 'setItem'> = localStorage): void {
  try {
    storage.setItem(INTRO_SETTING_KEY, on ? '1' : '0')
  } catch {
    // Blocked or full storage: the setting just does not stick.
  }
}
