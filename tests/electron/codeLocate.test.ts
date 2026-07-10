import { describe, it, expect, vi } from 'vitest'
import { codeLocate, type LocateDeps, type LocatorMemory, type LocatorSymbol } from '../../src/main/codeLocate'
import { proactiveSignals, hasErrorSignal } from '../../src/main/mnemeRetrieval'

const NOW = 1_000_000_000_000

function deps(over: Partial<LocateDeps> = {}): LocateDeps {
  return {
    signals: (t) => proactiveSignals(t),
    resolve: () => ({ symbols: [], files: [] }),
    history: () => [],
    impact: () => 0,
    now: NOW,
    ...over,
  }
}

const sym = (name: string, file: string, id = `${file}#${name}@1`): LocatorSymbol => ({ id, name, file })
const mem = (id: string, over: Partial<LocatorMemory> = {}): LocatorMemory => ({ id, importance: 0.8, ts: NOW, ...over })

describe('codeLocate — issue -> location predictor (C5)', () => {
  it('ranks the file+symbol of a known error first, with the causal lesson as "why"', () => {
    const d = deps({
      resolve: (tok) => (tok === 'reflowForMessage' ? { symbols: [sym('reflowForMessage', 'src/exportTerminal.ts')], files: [] } : { symbols: [], files: [] }),
      history: (q) => (q === 'reflowForMessage' ? [mem('lesson-1', { content: 'Problem: hard returns → Fix: reflow' })] : []),
      impact: () => 3,
    })
    const sites = codeLocate('the `reflowForMessage` output has hard returns', d)
    expect(sites[0].file).toBe('src/exportTerminal.ts')
    expect(sites[0].symbol).toBe('reflowForMessage')
    expect(sites[0].why.map((w) => w.id)).toContain('lesson-1')
  })

  it('ranks a site with more/stronger supporting lessons and higher blast radius above a bare hit', () => {
    const d = deps({
      resolve: (tok) => {
        if (tok === 'hot') return { symbols: [sym('hot', 'a.ts')], files: [] }
        if (tok === 'cold') return { symbols: [sym('cold', 'b.ts')], files: [] }
        return { symbols: [], files: [] }
      },
      history: (q) => (q === 'hot' ? [mem('m1', { importance: 0.9 }), mem('m2', { importance: 0.9, useCount: 5 })] : []),
      impact: (n) => (n === 'hot' ? 10 : 0),
    })
    const sites = codeLocate('compare `hot` and `cold`', d)
    expect(sites.map((s) => s.symbol)).toEqual(['hot', 'cold']) // hot (lessons + impact) ranks first
    expect(sites[0].score).toBeGreaterThan(sites[1].score)
  })

  it('keeps an exact-symbol hit even with no lessons, but DROPS a file hit with no lessons', () => {
    const d = deps({
      resolve: (tok) => {
        if (tok === 'knownSym') return { symbols: [sym('knownSym', 'k.ts')], files: [] }
        if (tok === 'orphan.ts') return { symbols: [], files: ['src/orphan.ts'] }
        return { symbols: [], files: [] }
      },
      history: () => [], // nothing anchored anywhere
    })
    const sites = codeLocate('look at `knownSym` and orphan.ts', d)
    expect(sites.map((s) => s.symbol)).toEqual(['knownSym']) // symbol kept (strong token)
    expect(sites.some((s) => s.file === 'src/orphan.ts')).toBe(false) // file with no why → dropped
  })

  it('locates a FILE (no symbol) when it has supporting lessons', () => {
    const d = deps({
      resolve: (t) => (t === 'config.ts' ? { symbols: [], files: ['src/config.ts'] } : { symbols: [], files: [] }),
      history: (q) => (q === 'config.ts' ? [mem('cfg', { useCount: 3, importance: 0.7 })] : []),
    })
    const sites = codeLocate('the config.ts settings are stale', d)
    expect(sites).toHaveLength(1)
    expect(sites[0].file).toBe('src/config.ts')
    expect(sites[0].symbol).toBeUndefined()
    expect(sites[0].why.map((w) => w.id)).toContain('cfg')
  })

  it('returns [] for an issue with no signals, and caps at the limit', () => {
    expect(codeLocate('', deps())).toEqual([])
    const many: LocatorSymbol[] = Array.from({ length: 20 }, (_, i) => sym(`s${i}`, `f${i}.ts`))
    const d = deps({ resolve: () => ({ symbols: many, files: [] }), history: () => [mem('m')] })
    expect(codeLocate('`bigtoken`', d, { limit: 5 })).toHaveLength(5)
  })

  it('is resilient — throwing resolve / history / impact never breaks it', () => {
    const d = deps({
      resolve: () => { throw new Error('graph down') },
      history: () => { throw new Error('mem down') },
      impact: () => { throw new Error('impact down') },
    })
    expect(() => codeLocate('`x` failed with ENOENT', d)).not.toThrow()
    expect(codeLocate('`x` failed with ENOENT', d)).toEqual([])
  })

  it('tolerates a resolver returning null / undefined shapes', () => {
    const d = deps({ resolve: () => null as unknown as { symbols: LocatorSymbol[]; files: string[] } })
    expect(codeLocate('inspect the `weird` token here', d)).toEqual([])
    const d2 = deps({ resolve: () => ({ symbols: undefined as unknown as LocatorSymbol[], files: undefined as unknown as string[] }) })
    expect(codeLocate('inspect the `weird` token here', d2)).toEqual([])
  })

  it('keeps a symbol hit when per-symbol history/impact throw (best-effort inner catches)', () => {
    const d = deps({
      resolve: (t) => (t === 'sym' ? { symbols: [sym('sym', 's.ts')], files: [] } : { symbols: [], files: [] }),
      history: () => { throw new Error('mem down') }, // inner throw, not the whole pass
      impact: () => { throw new Error('impact down') },
    })
    const sites = codeLocate('look at the `sym` symbol please', d)
    expect(sites).toHaveLength(1)
    expect(sites[0].symbol).toBe('sym') // strong-token hit survives the inner failures
  })

  it('handles history returning undefined and lessons missing ts/importance (sort branches)', () => {
    const d = deps({
      resolve: (t) => (t === 'zeta' ? { symbols: [sym('zeta', 'z.ts')], files: [] } : { symbols: [], files: [] }),
      history: () => [{ id: 'no-meta' }, { id: 'has-ts', ts: NOW }] as LocatorMemory[], // one bare, one dated
      impact: () => 0,
    })
    const sites = codeLocate('inspect the `zeta` symbol', d)
    expect(sites[0].why.map((w) => w.id)).toEqual(['has-ts', 'no-meta']) // dated first
  })

  it('returns [] when signals() itself throws', () => {
    const d = deps({ signals: () => { throw new Error('signal down') } })
    expect(codeLocate('anything', d)).toEqual([])
  })
})

describe('proactive trigger (C5)', () => {
  it('hasErrorSignal fires on error classes and phrases, not on normal output', () => {
    expect(hasErrorSignal('Uncaught TypeError: x is not a function')).toBe(true)
    expect(hasErrorSignal('Error: cannot find module "foo"')).toBe(true)
    expect(hasErrorSignal('build succeeded, all tests pass')).toBe(false)
    expect(hasErrorSignal('hi')).toBe(false) // too short
  })

  it('is stateless across repeated calls (global regex lastIndex reset)', () => {
    const line = 'ReferenceError: boom'
    expect(hasErrorSignal(line)).toBe(true)
    expect(hasErrorSignal(line)).toBe(true) // would flip false if lastIndex leaked
  })
})
