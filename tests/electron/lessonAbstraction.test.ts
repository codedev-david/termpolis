import { describe, it, expect } from 'vitest'
import {
  abstractLesson,
  lessonTokens,
  lessonSimilarity,
  poolLessons,
  SAME_LESSON_THRESHOLD,
} from '../../src/main/mnemeSociety'

// Corroboration across agents only works if the same lesson, learned twice, LOOKS the same.
//
// A lesson written during real work carries the session it was learned in: a commit SHA, an
// absolute path with someone's username in it, a run id, a timestamp, a port. None of that is the
// lesson. All of it is distinct tokens, and every distinct token enlarges the union in the Jaccard
// denominator — so two agents who learned exactly the same thing on different machines score below
// the bar and are filed as two unrelated lessons.
//
// Volatile spans are DROPPED rather than replaced with a shared placeholder. Replacing them would
// make two unrelated lessons that both happen to mention a SHA agree a little, which is worse than
// the problem being fixed: it invents corroboration.

describe('abstractLesson — strip the session, keep the lesson', () => {
  it('drops a commit SHA', () => {
    expect(abstractLesson('reverted in 94d1668 after the gate went red')).not.toMatch(/94d1668/)
  })

  it('keeps a hex-looking WORD that is just a word', () => {
    // 'deadbeef' and 'facade' are hex. Dropping every hex-ish run would eat real content, so a
    // SHA has to contain a digit to count as one.
    expect(abstractLesson('the facade pattern hid the deadbeef case')).toContain('facade')
    expect(abstractLesson('the facade pattern hid the deadbeef case')).toContain('deadbeef')
  })

  it('reduces an absolute path to the file that matters', () => {
    const out = abstractLesson('fix lives in C:/Users/dave/repos/termpolis/src/main/swarmMemory.ts')
    expect(out).toContain('swarmMemory.ts')
    expect(out).not.toMatch(/dave/)
  })

  it('reduces a WINDOWS path too — the separator is not the lesson', () => {
    // A backslash lost in an earlier edit made this rule silently forward-slash-only, so a
    // real Windows path kept every directory as a token. Pinned so it cannot regress.
    const out = abstractLesson('fix lives in C:\\Users\\dave\\repos\\termpolis\\src\\main\\swarmMemory.ts')
    expect(out).toContain('swarmMemory.ts')
    expect(out).not.toMatch(/dave/)
  })

  it('drops a uuid', () => {
    expect(abstractLesson('task 4214c7d3-c8f4-46aa-a488-512a63334931 failed')).not.toMatch(/4214c7d3/)
  })

  it('drops a long digit run — a timestamp, a port, a byte count', () => {
    expect(abstractLesson('hung after 1758000000000 ms on port 54231')).not.toMatch(/1758000000000|54231/)
  })

  it('keeps a version, which is part of the lesson', () => {
    // "broke in v1.27" is content: the reader needs it. Only runs of four or more digits go.
    expect(abstractLesson('broke in v1.27.4 and was fixed in v1.28')).toContain('1.27.4')
  })

  it('keeps ordinary prose exactly as it is', () => {
    const plain = 'never whole-body JSON parse then stringify without a round-trip equality check'
    expect(abstractLesson(plain)).toBe(plain)
  })

  it('is total — no input makes it throw', () => {
    for (const bad of ['', '   ', '////', '0x', undefined as unknown as string]) {
      expect(() => abstractLesson(bad)).not.toThrow()
    }
  })
})

describe('the effect that matters: the same lesson, learned twice, now corroborates', () => {
  const a = 'the e2e teardown hangs on app.close() — see C:/Users/dave/repos/termpolis/e2e/spec.ts, run 1758000000000, fixed in 94d1668'
  const b = 'the e2e teardown hangs on app.close() — see /home/ci/work/termpolis/e2e/spec.ts, run 1799999999999, fixed in b7b283e'

  it('scored below the bar before abstraction and clears it after', () => {
    expect(lessonSimilarity(a, b)).toBeGreaterThanOrEqual(SAME_LESSON_THRESHOLD)
  })

  it('pools two agents onto one lesson, which is what corroboration counts', () => {
    const pooled = poolLessons([
      { source: 'claude', content: a },
      { source: 'codex', content: b },
    ])
    expect(pooled).toHaveLength(1)
    expect(pooled[0].corroboration).toBe(2)
  })

  it('still keeps genuinely different lessons apart', () => {
    const other = 'always pass --retry=1 to vitest because agentEventBus flakes under concurrency'
    expect(lessonSimilarity(a, other)).toBeLessThan(SAME_LESSON_THRESHOLD)
  })

  it('does not make two lessons agree just because both cite a SHA', () => {
    // The failure mode of replacing volatile spans with a shared placeholder instead of removing
    // them: invented agreement between lessons that have nothing to do with each other.
    const x = 'coverage gate tripped at 94d1668'
    const y = 'taskbar icon vanished at b7b283e'
    expect(lessonSimilarity(x, y)).toBeLessThan(SAME_LESSON_THRESHOLD)
  })

  it('leaves the stored text alone — abstraction is for comparison, not for display', () => {
    // A user reading their memories must see the SHA and the path. Only the comparator forgets.
    const pooled = poolLessons([{ source: 'claude', content: a }])
    expect(pooled[0].content).toBe(a)
  })

  it('no longer wastes token slots on the session', () => {
    expect([...lessonTokens(a)].some((t) => /^\d{4,}$/.test(t))).toBe(false)
  })
})
