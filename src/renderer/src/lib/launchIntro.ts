// The launch intro's timeline: pure data, so the 2.0 s budget is provable in a unit test.
// All times are ms from first paint. The spec fixes the 2.0 s maximum and leaves the split open;
// this is the builder's split.

export const INTRO_TOTAL_MS = 2000
/** If the first frame has not painted this long after mount, the intro never appears. */
export const NOT_PAINTED_MS = 1000

export const INTRO_TIMELINE = {
  fadeIn: [0, 150],
  termpolisHold: [150, 800],
  crossfade: [800, 1050],
  letters: { start: 1050, stagger: 40, each: 300 },
  rule: [1100, 1500],
  tag: [1300, 1600],
  fadeOut: [1700, 2000],
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
  // One animation for the whole overlay: in, hold, out.
  const stage: IntroStep = {
    target: 'stage',
    delay: 0,
    duration: outEnd,
    keyframes: [
      { opacity: 0, offset: 0 },
      { opacity: 1, offset: fadeInEnd / outEnd },
      { opacity: 1, offset: outStart / outEnd },
      { opacity: 0, offset: 1 },
    ],
  }
  // The Termpolis card holds, then leaves while the Lumopolis card arrives.
  const termpolis: IntroStep = {
    target: 'termpolis',
    delay: 0,
    duration: xEnd,
    keyframes: [
      { opacity: 1, offset: 0 },
      { opacity: 1, offset: holdEnd / xEnd },
      { opacity: 0, offset: 1 },
    ],
  }
  const lumopolis: IntroStep = { target: 'lumopolis', delay: xStart, duration: xEnd - xStart, keyframes: fade(0, 1) }
  const steps: IntroStep[] = [stage, termpolis, lumopolis]
  const { start, stagger, each } = T.letters
  for (let i = 0; i < INTRO_LETTER_COUNT; i++) {
    steps.push(reduced
      // No reveal: every letter, the rule and the tag take plain fades within the same 2 s.
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
