import { describe, it, expect } from 'vitest'
import {
  normalizeTurns,
  assembleEpisode,
  isReflectable,
  boundaryFromTaskStatus,
  outcomeFromTaskStatus,
  type RawTurn,
} from '../../src/main/mnemeEpisode'
import type { Episode } from '../../src/main/mnemeReflect'

// Build a minimal Episode literal for the pure gate helpers.
function epOf(turns: Episode['turns']): Episode {
  return { id: 'ep-1', turns }
}

describe('mnemeEpisode — normalizeTurns', () => {
  it('keeps role assistant and collapses every other role to user', () => {
    const out = normalizeTurns([
      { role: 'assistant', text: 'a reply' },
      { role: 'user', text: 'a question' },
      { role: 'system', text: 'a system prompt' },
      { role: 'tool', text: 'tool output' },
      { role: 'Assistant', text: 'wrong case → user' }, // exact match only
    ])
    expect(out.map((t) => t.role)).toEqual(['assistant', 'user', 'user', 'user', 'user'])
  })

  it('takes text when present, falls back to content, then to empty', () => {
    const out = normalizeTurns([
      { role: 'user', text: 'from text', content: 'ignored' }, // text wins
      { role: 'user', content: 'from content' }, // text absent → content
      { role: 'user' }, // neither → '' → dropped below
    ] as RawTurn[])
    expect(out.map((t) => t.text)).toEqual(['from text', 'from content'])
  })

  it('trims whitespace and drops turns that are empty after trimming', () => {
    const out = normalizeTurns([
      { role: 'assistant', text: '   spaced out   ' },
      { role: 'user', text: '    ' }, // whitespace only → dropped
      { role: 'user', text: '\n\t' }, // whitespace only → dropped
      { role: 'user', content: '' }, // empty content → dropped
      { role: 'user' }, // neither field → dropped
    ])
    expect(out).toEqual([{ role: 'assistant', text: 'spaced out' }])
  })

  it('returns an empty array for no input', () => {
    expect(normalizeTurns([])).toEqual([])
  })
})

describe('mnemeEpisode — assembleEpisode', () => {
  it('normalizes turns and attaches id, project, source, and outcome', () => {
    const ep = assembleEpisode({
      id: 'task-42',
      project: 'termpolis',
      source: 'claude',
      turns: [
        { role: 'user', text: '  hi  ' },
        { role: 'assistant', content: 'hello there' }, // content fallback
        { role: 'system', text: '   ' }, // dropped
      ],
      outcome: { kind: 'manual', success: true, detail: 'done' },
    })
    expect(ep).toEqual({
      id: 'task-42',
      project: 'termpolis',
      source: 'claude',
      turns: [
        { role: 'user', text: 'hi' },
        { role: 'assistant', text: 'hello there' },
      ],
      outcome: { kind: 'manual', success: true, detail: 'done' },
    })
  })

  it('omits project, source, and outcome when they are not supplied', () => {
    const ep = assembleEpisode({ id: 'bare', turns: [{ role: 'assistant', text: 'ok' }] })
    expect(ep).toEqual({ id: 'bare', turns: [{ role: 'assistant', text: 'ok' }] })
    expect('project' in ep).toBe(false)
    expect('source' in ep).toBe(false)
    expect('outcome' in ep).toBe(false)
  })

  it('caps at the most-recent MAX turns when fed more than the limit', () => {
    // 250 non-empty turns → normalize keeps all 250 → cap keeps the last 200.
    const turns: RawTurn[] = Array.from({ length: 250 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      text: `turn-${i}`,
    }))
    const ep = assembleEpisode({ id: 'big', turns })
    expect(ep.turns).toHaveLength(200)
    expect(ep.turns[0].text).toBe('turn-50') // most-recent 200 → drops turn-0..49
    expect(ep.turns[199].text).toBe('turn-249')
  })

  it('does not pad or cap when under the limit', () => {
    const turns: RawTurn[] = Array.from({ length: 3 }, (_, i) => ({ role: 'user', text: `t${i}` }))
    expect(assembleEpisode({ id: 's', turns }).turns).toHaveLength(3)
  })
})

describe('mnemeEpisode — isReflectable', () => {
  it('is true with an assistant turn and enough combined text', () => {
    const ep = epOf([
      { role: 'user', text: 'why is the build failing on windows only?' },
      { role: 'assistant', text: 'because the path separator differs.' },
    ])
    expect(isReflectable(ep)).toBe(true)
  })

  it('is false when there is no assistant turn (even with plenty of text)', () => {
    const ep = epOf([{ role: 'user', text: 'x'.repeat(80) }])
    expect(isReflectable(ep)).toBe(false)
  })

  it('is false when the combined text is too short (< 40 chars)', () => {
    const ep = epOf([{ role: 'assistant', text: 'fixed it' }]) // 8 chars
    expect(isReflectable(ep)).toBe(false)
  })

  it('is false for an empty episode', () => {
    expect(isReflectable(epOf([]))).toBe(false)
  })

  it('sums text across turns to clear the threshold', () => {
    // Neither turn alone is 40 chars, but combined they are (and one is assistant).
    const ep = epOf([
      { role: 'user', text: 'twenty-two chars here.' }, // 22
      { role: 'assistant', text: 'plus twenty-two more!!' }, // 22 → 44 total
    ])
    expect(isReflectable(ep)).toBe(true)
  })
})

describe('mnemeEpisode — boundaryFromTaskStatus', () => {
  it('is true for completed', () => {
    expect(boundaryFromTaskStatus('completed')).toBe(true)
  })

  it('is true for failed', () => {
    expect(boundaryFromTaskStatus('failed')).toBe(true)
  })

  it('is false for any in-flight or unknown status', () => {
    for (const s of ['running', 'queued', 'cancelled', 'in_progress', '']) {
      expect(boundaryFromTaskStatus(s)).toBe(false)
    }
  })
})

describe('mnemeEpisode — outcomeFromTaskStatus', () => {
  it('maps completed → a successful manual outcome, carrying the result detail', () => {
    expect(outcomeFromTaskStatus('completed', 'all tests green')).toEqual({
      kind: 'manual',
      success: true,
      detail: 'all tests green',
    })
  })

  it('maps failed → a failed error outcome, carrying the result detail', () => {
    expect(outcomeFromTaskStatus('failed', '2 tests failing')).toEqual({
      kind: 'error',
      success: false,
      detail: '2 tests failing',
    })
  })

  it('leaves detail undefined when no result is supplied', () => {
    expect(outcomeFromTaskStatus('completed')).toEqual({ kind: 'manual', success: true, detail: undefined })
    expect(outcomeFromTaskStatus('failed')).toEqual({ kind: 'error', success: false, detail: undefined })
  })

  it('returns undefined for any non-terminal status', () => {
    expect(outcomeFromTaskStatus('running', 'ignored')).toBeUndefined()
    expect(outcomeFromTaskStatus('cancelled')).toBeUndefined()
    expect(outcomeFromTaskStatus('')).toBeUndefined()
  })
})
