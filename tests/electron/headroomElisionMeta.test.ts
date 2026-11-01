import { describe, it, expect } from 'vitest'
import {
  ELISION_KINDS, SIZE_BANDS, TOOL_CLASSES, sizeBand, toolClass, classKey, parseClassKey, makeMeta, sanitizeMeta, stampModel, stampPolicy,
  type StashEntry,
} from '../../src/main/headroom/elisionMeta'

/**
 * The vocabulary the elision ledger counts in. A class is (kind, tool, size band): the same cut the
 * research used to show that a 1.6k-char Bash result and a 40k-char Read are different bets.
 */

describe('sizeBand', () => {
  it('cuts at the research table: 1.6k, 4k, 10k, 40k', () => {
    const cases: Array<[number, string]> = [
      [0, '<1.6k'], [1599, '<1.6k'], [1600, '1.6-4k'], [3999, '1.6-4k'], [4000, '4-10k'],
      [9999, '4-10k'], [10_000, '10-40k'], [39_999, '10-40k'], [40_000, '40k+'], [2_000_000, '40k+'],
    ]
    for (const [chars, band] of cases) expect(sizeBand(chars)).toBe(band)
  })

  it('puts garbage in the smallest band instead of throwing', () => {
    for (const bad of [-1, Number.NaN, Number.NEGATIVE_INFINITY, undefined as unknown as number]) expect(sizeBand(bad)).toBe('<1.6k')
    expect(sizeBand(Number.POSITIVE_INFINITY)).toBe('40k+')
  })

  it('lists the bands smallest first', () => {
    expect([...SIZE_BANDS]).toEqual(['<1.6k', '1.6-4k', '4-10k', '10-40k', '40k+'])
  })
})

describe('toolClass', () => {
  it('names the tools the research measured and folds the rest', () => {
    for (const t of ['Read', 'Bash', 'Grep', 'Glob', 'PowerShell', 'WebFetch', 'WebSearch']) expect(toolClass(t)).toBe(t)
    expect(toolClass('mcp__termpolis__code_search')).toBe('mcp')
    expect(toolClass('mcp__claude_ai_Gmail__get_message')).toBe('mcp')
    expect(toolClass('Task')).toBe('other')
    expect(toolClass('read')).toBe('other') // case matters: Claude Code's names are exact
  })

  it('treats a missing or non-string name as other', () => {
    for (const bad of [undefined, null, 7, {}, '']) expect(toolClass(bad)).toBe('other')
  })

  it('keeps the class list bounded', () => {
    expect(TOOL_CLASSES.length).toBe(9)
  })
})

describe('class keys', () => {
  it('builds kind|tool|band from a meta', () => {
    expect(classKey({ kind: 'compact', tool: 'Bash', chars: 5000, view: 1100 })).toBe('compact|Bash|4-10k')
    expect(classKey({ kind: 'decay', chars: 700, view: 140 })).toBe('decay|other|<1.6k')
  })

  it('parses a key back, and refuses anything it did not build', () => {
    expect(parseClassKey('compact|Read|40k+')).toEqual({ kind: 'compact', tool: 'Read', band: '40k+', policy: 'legacy' })
    for (const bad of ['', 'compact|Read', 'compact|Read|40k+|x', 'nope|Read|40k+', 'compact|Nope|40k+', 'compact|Read|9k']) {
      expect(parseClassKey(bad)).toBeNull()
    }
  })

  it('round-trips every kind, tool class and band', () => {
    for (const kind of ELISION_KINDS) for (const tool of TOOL_CLASSES) for (const band of SIZE_BANDS) {
      expect(parseClassKey(`${kind}|${tool}|${band}`)).toEqual({ kind, tool, band, policy: 'legacy' })
    }
  })
})

describe('makeMeta', () => {
  it('records what was replaced and by what', () => {
    expect(makeMeta('compact', 'Read', 8000, 1200)).toEqual({ kind: 'compact', tool: 'Read', chars: 8000, view: 1200 })
  })

  it('omits the tool when the body did not say, and bounds a pathological name', () => {
    expect('tool' in makeMeta('dedup', undefined, 100, 10)).toBe(false)
    expect('tool' in makeMeta('dedup', '', 100, 10)).toBe(false)
    expect(makeMeta('diff', 'x'.repeat(500), 100, 10).tool).toHaveLength(80)
  })
})

describe('sanitizeMeta', () => {
  it('accepts a well-formed meta and copies it', () => {
    const raw = { kind: 'decay', tool: 'Bash', chars: 900, view: 140, model: 'claude-opus-5-5' }
    const m = sanitizeMeta(raw)
    expect(m).toEqual(raw)
    expect(m).not.toBe(raw)
  })

  it('drops fields it does not know and bounds the strings', () => {
    const m = sanitizeMeta({ kind: 'compact', chars: 10, view: 5, tool: 't'.repeat(200), model: 'm'.repeat(200), extra: 'x' })
    expect(m).toEqual({ kind: 'compact', chars: 10, view: 5, tool: 't'.repeat(80), model: 'm'.repeat(80) })
  })

  it('ignores a tool or model that is not a string', () => {
    expect(sanitizeMeta({ kind: 'compact', chars: 10, view: 5, tool: 7, model: {} })).toEqual({ kind: 'compact', chars: 10, view: 5 })
  })

  it('returns undefined for anything that is not a usable meta', () => {
    const bad: unknown[] = [
      undefined, null, 5, 'compact', [], {}, { kind: 'compact' }, { kind: 'bogus', chars: 1, view: 1 },
      { kind: 'compact', chars: -1, view: 1 }, { kind: 'compact', chars: 1, view: -1 },
      { kind: 'compact', chars: Number.NaN, view: 1 }, { kind: 'compact', chars: 1, view: Number.POSITIVE_INFINITY },
      { kind: 'compact', chars: '1', view: 1 },
    ]
    for (const b of bad) expect(sanitizeMeta(b)).toBeUndefined()
  })
})

describe('stampModel', () => {
  const entries = (): StashEntry[] => [
    { token: 'hr_a', original: 'a', meta: { kind: 'compact', chars: 1, view: 1 } },
    { token: 'hr_b', original: 'b' },
  ]

  it('puts the request model on every meta and leaves a meta-less entry alone', () => {
    const e = entries()
    stampModel(e, 'claude-opus-5-5')
    expect(e[0].meta?.model).toBe('claude-opus-5-5')
    expect(e[1].meta).toBeUndefined()
  })

  it('does nothing without a usable model', () => {
    for (const bad of [undefined, null, 5, '', {}]) {
      const e = entries()
      stampModel(e, bad)
      expect(e[0].meta?.model).toBeUndefined()
    }
  })

  it('bounds a long model name', () => {
    const e = entries()
    stampModel(e, 'm'.repeat(300))
    expect(e[0].meta?.model).toHaveLength(80)
  })
})

/**
 * Which first-sight policy produced an elision is part of what the ledger counts, because the question
 * the Elision health card answers is "is the policy in force paying", and the conversations held out on
 * the old behaviour elide a different set of results. Only a compaction under `late` is named: a key
 * with no policy on it is the old behaviour, which is what every key written before the policy existed
 * was and what the holdout and the Legacy setting run. A repeat, a patch and an aged-out result are
 * collapsed the same way under both, so their keys do not split.
 */
describe('class keys name the policy of a Late compaction', () => {
  it('adds |late to a compaction made under late, and nothing to any other', () => {
    expect(classKey({ kind: 'compact', tool: 'Read', chars: 50_000, view: 1100, policy: 'late' })).toBe('compact|Read|40k+|late')
    expect(classKey({ kind: 'compact', tool: 'Read', chars: 5_000, view: 1100, policy: 'legacy' })).toBe('compact|Read|4-10k')
    expect(classKey({ kind: 'compact', tool: 'Read', chars: 5_000, view: 1100 })).toBe('compact|Read|4-10k')
    for (const kind of ['dedup', 'diff', 'decay'] as const) {
      expect(classKey({ kind, tool: 'Bash', chars: 5_000, view: 100, policy: 'late' })).toBe(`${kind}|Bash|4-10k`)
    }
  })

  it('parses both forms, naming the policy, and refuses a fourth part it did not build', () => {
    expect(parseClassKey('compact|Read|40k+|late')).toEqual({ kind: 'compact', tool: 'Read', band: '40k+', policy: 'late' })
    expect(parseClassKey('compact|Read|4-10k')).toEqual({ kind: 'compact', tool: 'Read', band: '4-10k', policy: 'legacy' })
    expect(parseClassKey('dedup|Bash|4-10k')).toEqual({ kind: 'dedup', tool: 'Bash', band: '4-10k', policy: 'legacy' })
    for (const bad of ['compact|Read|40k+|legacy', 'compact|Read|40k+|Late', 'compact|Read|40k+|', 'dedup|Read|4-10k|late', 'compact|Read|40k+|late|x', 'compact|Read']) {
      expect(parseClassKey(bad), bad).toBeNull()
    }
  })

  it('round-trips through classKey for every kind, tool class, band and policy', () => {
    for (const kind of ELISION_KINDS) for (const tool of TOOL_CLASSES) for (const chars of [100, 2_000, 5_000, 20_000, 50_000]) for (const policy of ['late', 'legacy', undefined] as const) {
      const key = classKey({ kind, tool: tool === 'mcp' ? 'mcp__x__y' : tool === 'other' ? 'Zed' : tool, chars, view: 10, policy })
      const parsed = parseClassKey(key)
      expect(parsed, key).not.toBeNull()
      expect(parsed?.kind).toBe(kind)
      expect(parsed?.policy).toBe(kind === 'compact' && policy === 'late' ? 'late' : 'legacy')
    }
  })
})

describe('the policy a stash was made under', () => {
  it('is kept by sanitizeMeta when it is one of the two, and dropped when it is anything else', () => {
    expect(sanitizeMeta({ kind: 'compact', chars: 100, view: 10, policy: 'late' })?.policy).toBe('late')
    expect(sanitizeMeta({ kind: 'compact', chars: 100, view: 10, policy: 'legacy' })?.policy).toBe('legacy')
    for (const bad of ['LATE', 'holdout', 5, null, {}, ['late']]) {
      const m = sanitizeMeta({ kind: 'compact', chars: 100, view: 10, policy: bad })
      expect(m).toBeDefined()
      expect('policy' in (m as object)).toBe(false)
    }
    expect('policy' in (sanitizeMeta({ kind: 'compact', chars: 100, view: 10 }) as object)).toBe(false)
  })

  it('stampPolicy puts the policy on every meta of a request, skips an entry with no meta, and ignores a name it does not know', () => {
    const entries = [
      { token: 'hr_a', original: 'x', meta: makeMeta('compact', 'Read', 50_000, 1_000) },
      { token: 'hr_b', original: 'y' },
      { token: 'hr_c', original: 'z', meta: makeMeta('decay', 'Bash', 3_000, 100) },
    ]
    stampPolicy(entries, 'late')
    expect(entries[0].meta?.policy).toBe('late')
    expect(entries[1]).toEqual({ token: 'hr_b', original: 'y' })
    expect(entries[2].meta?.policy).toBe('late')
    stampPolicy(entries, 'legacy')
    expect(entries[0].meta?.policy).toBe('legacy')
    stampPolicy(entries, 'holdout' as never)
    stampPolicy(entries, undefined as never)
    expect(entries[0].meta?.policy).toBe('legacy')
  })
})
