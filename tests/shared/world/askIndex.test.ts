import { describe, expect, it } from 'vitest'
import {
  ASK_INDEX_VERSION, BGE_QUERY_PREFIX, FUSE, TEST_RANK_FACTOR, askEntries, bm25Scores, buildBm25, cosineScores, packInt8, rankAsk, rrf, tokenize,
  type AskEntry
} from '../../../src/shared/world/askIndex'
import { building, claim, edge, rich } from '../../renderer/world/helpers'

describe('constants', () => {
  it('keeps the spec values', () => {
    expect(BGE_QUERY_PREFIX).toBe('Represent this sentence for searching relevant passages: ')
    expect(ASK_INDEX_VERSION).toBe(1)
    expect(TEST_RANK_FACTOR).toBeGreaterThan(0)
    expect(TEST_RANK_FACTOR).toBeLessThan(1)
    expect(FUSE).toBe(true)
  })
})

describe('askEntries', () => {
  it('writes the entry of each of the five kinds', () => {
    const doc = rich()
    doc.buildings[0].members = ['src/main/aaa.ts', 'src/main/bbb.tsx']
    doc.buildings[0].techLabel = 'Node'
    doc.buildings[0].stack = ['ipc']
    doc.glossary = { React: 'The library that builds the screens.' }
    doc.tours = [{ id: 't1', title: 'Big picture', steps: [{ ids: ['b1'], caption: 'First stop.' }, { ids: ['b2'], caption: 'Second stop.' }] }]
    const entries = askEntries(doc)
    const by = (id: string): AskEntry => entries.find((e) => e.id === id) as AskEntry

    const b = by(doc.buildings[0].id)
    expect(b.kind).toBe('building')
    expect(b.name).toBe(doc.buildings[0].name)
    expect(b.first).toBe(doc.buildings[0].how[0].text)
    expect(b.text.startsWith(doc.buildings[0].name)).toBe(true)
    expect(b.text).toContain(doc.buildings[0].how[0].text)
    expect(b.text).toContain(doc.buildings[0].why[0].text)
    expect(b.text).toContain('Node ipc')
    expect(b.text).toContain(doc.districts[0].name)
    expect(b.text.endsWith('aaa bbb')).toBe(true)
    expect(b.test).toBe(false)

    const x = by(doc.externals[0].id)
    expect(x).toEqual({ id: doc.externals[0].id, kind: 'external', name: doc.externals[0].name, first: doc.externals[0].kind, test: false, text: `${doc.externals[0].name} ${doc.externals[0].kind}` })

    const e = by(doc.edges[0].id)
    expect(e.kind).toBe('line')
    expect(e.name).toContain(' → ')
    expect(e.first.length).toBeGreaterThan(0)
    expect(e.text.startsWith(e.name)).toBe(true)
    expect(e.text).toContain(e.first)

    expect(by('tech:React')).toEqual({ id: 'tech:React', kind: 'term', name: 'React', first: 'The library that builds the screens.', test: false, text: 'React The library that builds the screens.' })
    expect(by('t1')).toEqual({ id: 't1', kind: 'tour', name: 'Big picture', first: 'First stop.', test: false, text: 'Big picture First stop. Second stop.' })
  })

  it('uses the cargo label, else the cargo id, and the line tech', () => {
    const doc = rich()
    doc.edges = [edge('l1', 'b1', 'b2', { cargo: 'memory', tech: ['ipc', 'ws'] }), edge('l2', 'b1', 'b2', { cargo: 'nope' })]
    const entries = askEntries(doc)
    expect(entries.find((e) => e.id === 'l1')?.text).toContain(`${doc.cargo.memory.label} ipc ws`)
    expect(entries.find((e) => e.id === 'l2')?.text).toContain('nope')
  })

  it('falls back for a building with no claims, no district and no members, and a tour with no steps', () => {
    const doc = rich()
    doc.buildings = [building('only', { how: [], why: [], districtId: 'gone', techLabel: '', stack: [], members: [] })]
    doc.edges = []
    doc.externals = []
    doc.glossary = {}
    doc.tours = [{ id: 'empty', title: 'Nothing', steps: [] }]
    const [b, ...rest] = askEntries(doc)
    expect(b.first).toBe('Not described yet.')
    expect(b.text).toBe('only')
    expect(b.test).toBe(false)
    expect(rest).toHaveLength(1)
    const t = rest[0]
    expect(t.first).toBe('')
    expect(t.text).toBe('Nothing')
  })

  it('lists at most 20 member basenames', () => {
    const doc = rich()
    doc.buildings = [building('many', { members: Array.from({ length: 25 }, (_, i) => `src/dir/file${String(i).padStart(2, '0')}.ts`) })]
    doc.edges = []
    const text = askEntries(doc)[0].text
    expect(text).toContain('file19')
    expect(text).not.toContain('file20')
  })

  it('marks a building made only of test files, and a line between two of them, as test', () => {
    const doc = rich()
    doc.buildings = [
      building('t1', { members: ['src/a.test.ts', 'tests/b.spec.tsx'] }),
      building('t2', { members: ['tests/c.test.ts'] }),
      building('real', { members: ['src/a.test.ts', 'src/real.ts'] })
    ]
    doc.edges = [edge('tt', 't1', 't2'), edge('tr', 't1', 'real'), edge('rt', 'real', 't2'), edge('xx', 't1', 'missing')]
    const by = (id: string): boolean => (askEntries(doc).find((e) => e.id === id) as AskEntry).test
    expect(by('t1')).toBe(true)
    expect(by('t2')).toBe(true)
    expect(by('real')).toBe(false)
    expect(by('tt')).toBe(true)
    expect(by('tr')).toBe(false)
    expect(by('rt')).toBe(false)
    expect(by('xx')).toBe(false)
  })
})

describe('tokenize', () => {
  it('splits camelCase and punctuation, lower-cases, stems and drops stopwords', () => {
    expect(tokenize('The remoteBridge handles Queries, and MORE!')).toEqual(['remote', 'bridge', 'handl', 'query', 'more'])
    expect(tokenize('a I to of')).toEqual([])
    expect(tokenize('?!')).toEqual([])
  })

  it('keeps a word whose stem would be empty', () => {
    expect(tokenize('ed')).toEqual(['ed'])
  })
})

describe('bm25', () => {
  it('ranks the doc with the rarer matching term first', () => {
    const ix = buildBm25(['alpha common words', 'beta common words', 'gamma common words', 'delta common rare'])
    expect(ix.docs).toBe(4)
    expect(ix.len).toEqual([3, 3, 3, 3])
    expect(ix.avgLen).toBe(3)
    expect(ix.df.common).toBe(4)
    expect(ix.tf[3].rare).toBe(1)
    const s = bm25Scores(ix, 'common rare')
    expect(s[3]).toBeGreaterThan(s[0])
    expect(s[0]).toBe(s[1])
    expect(s).toHaveLength(4)
  })

  it('scores a word that is an object property name as an ordinary word', () => {
    const ix = buildBm25(['constructor prototype', 'other'])
    expect(bm25Scores(ix, 'toString')).toEqual([0, 0])
    expect(bm25Scores(ix, 'constructor')[0]).toBeGreaterThan(0)
  })

  it('scores nothing for an empty index, an empty query or stopwords', () => {
    expect(buildBm25([])).toEqual({ docs: 0, avgLen: 0, df: {}, tf: [], len: [] })
    expect(bm25Scores(buildBm25([]), 'anything')).toEqual([])
    const ix = buildBm25(['alpha beta', ''])
    expect(bm25Scores(ix, '')).toEqual([0, 0])
    expect(bm25Scores(ix, 'the of and')).toEqual([0, 0])
    expect(bm25Scores(ix, 'alpha')[1]).toBe(0)
  })
})

describe('int8 vectors', () => {
  const unit = (v: number[]): number[] => { const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)); return v.map((x) => x / n) }
  const vec = (seed: number): number[] => unit(Array.from({ length: 384 }, (_, i) => Math.sin(seed * 31 + i * 0.37) + Math.cos(i * seed)))

  it('round-trips a vector with a cosine of at least 0.995', () => {
    const rows = [vec(1), vec(2), vec(3)]
    const p = packInt8(rows)
    expect(p.dim).toBe(384)
    expect(p.scales).toHaveLength(3)
    expect(p.data).toBeInstanceOf(Int8Array)
    expect(p.data).toHaveLength(3 * 384)
    rows.forEach((r, i) => {
      const s = cosineScores(p, Float32Array.from(r))
      expect(s[i]).toBeGreaterThanOrEqual(0.995)
      expect(s[(i + 1) % 3]).toBeLessThan(0.99)
    })
  })

  it('packs the zero vector with scale 0 and scores it 0', () => {
    const p = packInt8([new Array(8).fill(0), [1, 0, 0, 0, 0, 0, 0, 0]])
    expect(p.scales[0]).toBe(0)
    expect(Array.from(p.data.slice(0, 8))).toEqual(new Array(8).fill(0))
    const q = Float32Array.from([1, 0, 0, 0, 0, 0, 0, 0])
    expect(cosineScores(p, q)[0]).toBe(0)
    expect(cosineScores(p, q)[1]).toBeCloseTo(1, 6)
    expect(cosineScores(p, new Float32Array(8))).toEqual([0, 0])
  })

  it('packs no vectors', () => {
    const p = packInt8([])
    expect(p).toEqual({ dim: 0, scales: [], data: new Int8Array(0) })
    expect(cosineScores(p, new Float32Array(0))).toEqual([])
  })
})

describe('rrf', () => {
  it('puts the id both rankings like best first', () => {
    expect(rrf([[0, 1, 2], [2, 0, 1]])[0]).toBe(0)
    expect(rrf([[0, 1, 2], [2, 0, 1]])).toEqual([0, 2, 1])
  })

  it('takes k, lists ids seen in one ranking only, and breaks ties by id', () => {
    expect(rrf([[3], [1]])).toEqual([1, 3])
    expect(rrf([[5, 4]], 1)).toEqual([5, 4])
    expect(rrf([])).toEqual([])
  })
})

describe('rankAsk', () => {
  const entry = (id: string, test = false): AskEntry => ({ id, kind: 'building', name: `N${id}`, first: `F${id}`, text: id, test })
  const entries = [entry('a'), entry('b'), entry('c', true), entry('d'), entry('e'), entry('f'), entry('g')]

  it('returns at most 5 hits by default, and the limit when given', () => {
    const keyword = [7, 6, 5, 4, 3, 2, 1]
    const hits = rankAsk(entries, { keyword })
    expect(hits).toHaveLength(5)
    expect(hits[0]).toEqual({ id: 'a', kind: 'building', name: 'Na', first: 'Fa' })
    expect(rankAsk(entries, { keyword }, 2)).toHaveLength(2)
  })

  it('drops a test part below an equal non-test part', () => {
    const e = [entry('t', true), entry('real')]
    expect(rankAsk(e, { keyword: [1, 1] }).map((h) => h.id)).toEqual(['real', 't'])
    expect(rankAsk(e, { keyword: [1.1, 1] }).map((h) => h.id)).toEqual(['real', 't'])
  })

  it('answers nothing for an empty, punctuation or stopword-only question', () => {
    const ix = buildBm25(entries.map((e) => e.text))
    for (const q of ['', '?!', 'the of and']) expect(rankAsk(entries, { keyword: bm25Scores(ix, q) })).toEqual([])
  })

  it('does not throw on a 5,000-character question', () => {
    const ix = buildBm25(entries.map((e) => e.text))
    expect(() => rankAsk(entries, { keyword: bm25Scores(ix, 'word '.repeat(1000)) })).not.toThrow()
    expect(() => rankAsk(entries, { keyword: bm25Scores(ix, 'a'.repeat(5000)) })).not.toThrow()
  })

  it('fuses meaning with keywords when meaning scores are given', () => {
    const e = [entry('a'), entry('b'), entry('c')]
    const hits = rankAsk(e, { smart: [0.1, 0.9, 0.5], keyword: [0, 3, 2] })
    expect(hits.map((h) => h.id)).toEqual(['b', 'c', 'a'])
    expect(rankAsk(e, { smart: [0.9, 0.1, 0.5], keyword: [0, 0, 2] }).map((h) => h.id)).toEqual(['c', 'a', 'b'])
  })

  it('demotes a test part in the meaning ranking too', () => {
    const e = [entry('t', true), entry('real')]
    expect(rankAsk(e, { smart: [0.5, 0.5], keyword: [1, 1] }).map((h) => h.id)).toEqual(['real', 't'])
  })
})
