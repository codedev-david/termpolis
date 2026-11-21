import { describe, expect, it } from 'vitest'
import {
  ASK_INDEX_VERSION, BGE_QUERY_PREFIX, FUSE, TEST_RANK_FACTOR, askEntries, bm25Scores, buildBm25, cosineScores, nameFit, packInt8, rankAsk, rrf, tokenize, WHOLE_NAME,
  type AskEntry, type AskKind
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

  it('throws on a ragged row', () => {
    expect(() => packInt8([[1, 0], [1]])).toThrow(/ragged/i)
    expect(() => packInt8([[1, 0], [1, 0, 0]])).toThrow(/ragged/i)
  })

  it('scores all zeros when the query is not the packed width', () => {
    const p = packInt8([[1, 0, 0], [0, 1, 0]])
    expect(cosineScores(p, Float32Array.from([1, 0]))).toEqual([0, 0])
    expect(cosineScores(p, Float32Array.from([1, 0, 0, 0]))).toEqual([0, 0])
  })

  it('maps NaN and infinite components to 0 and keeps every value within 127', () => {
    const p = packInt8([[Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1, -1]])
    expect(p.scales[0]).toBeCloseTo(1 / 127, 10)
    expect(Array.from(p.data)).toEqual([0, 0, 0, 127, -127])
    expect(cosineScores(p, Float32Array.from([0, 0, 0, 1, 0])).every((x) => Number.isFinite(x))).toBe(true)
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

describe('nameFit', () => {
  const named = (id: string, kind: AskKind, name: string): AskEntry => ({ id, kind, name, first: '', text: name, test: false })
  const entries = [
    named('b-mem', 'building', 'Memory host'),
    named('e-mem', 'line', 'Memory host → Embedder'),
    named('b-emb', 'building', 'Embedder'),
    named('x-relay', 'external', 'Pairing relay'),
    named('t', 'tour', '→')
  ]

  it('is 1 plus the share of a name the question says, when every word of the question is in that name, and WHOLE_NAME for the whole name', () => {
    expect(WHOLE_NAME).toBe(2)
    expect(nameFit(entries, 'memory')).toEqual([1 + 1 / 2, 1 + 1 / 3, 0, 0, 0])
    expect(nameFit(entries, 'Memory hosts')).toEqual([WHOLE_NAME, 1 + 2 / 3, 0, 0, 0])
    expect(nameFit(entries, 'the memory host')).toEqual([WHOLE_NAME, 1 + 2 / 3, 0, 0, 0])
    expect(nameFit(entries, 'EMBEDDER')).toEqual([0, 1 + 1 / 3, WHOLE_NAME, 0, 0])
  })

  it('is the share of the question a whole name fills, below 1, when the question says the name among other words', () => {
    expect(nameFit(entries, 'how does the memory host work')).toEqual([2 / 3, 0, 0, 0, 0])
    expect(nameFit(entries, 'what does the memory host send to the embedder')).toEqual([2 / 4, 3 / 4, 1 / 4, 0, 0])
    expect(nameFit(entries, 'what does the pairing relay do')).toEqual([0, 0, 0, WHOLE_NAME, 0])
    expect(nameFit(entries, 'is the pairing relay safe')).toEqual([0, 0, 0, 2 / 3, 0])
  })

  it('is 0 for a name the question says only part of, beside other words', () => {
    expect(nameFit(entries, 'where is each memory kept')).toEqual([0, 0, 0, 0, 0])
    expect(nameFit(entries, 'relay memory')).toEqual([0, 0, 0, 0, 0])
  })

  it('counts a repeated word once, and is 0 everywhere for a question with no words', () => {
    expect(nameFit(entries, 'relay relay relay')).toEqual([0, 0, 0, 1 + 1 / 2, 0])
    for (const q of ['', '?!', 'the of and']) expect(nameFit(entries, q)).toEqual([0, 0, 0, 0, 0])
    expect(nameFit([], 'memory')).toEqual([])
  })

  it('never fits a name with no words of its own: a stopword, one letter or punctuation is in every question', () => {
    const empty = ['A', 'The', 'C', 'C++', 'App', '→', 'R & D'].map((n, i) => named(`n${i}`, 'term', n))
    for (const q of ['how does the app use a C library', 'R and D', 'a', 'the', 'what does it do']) {
      expect(nameFit(empty, q)).toEqual(empty.map(() => 0))
    }
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

  it('lowers a test part even when its score is negative', () => {
    const e = [entry('t', true), entry('real')]
    expect(rankAsk(e, { smart: [-0.5, -0.5], keyword: [1, 1] }).map((h) => h.id)).toEqual(['real', 't'])
    expect(rankAsk(e, { smart: [-0.3, -0.3], keyword: [0, 0] }).map((h) => h.id)).toEqual(['real', 't'])
  })

  it('falls back to keywords when the meaning scores are not one per entry', () => {
    const e = [entry('a'), entry('b'), entry('c')]
    const keyword = [1, 3, 2]
    const expected = ['b', 'c', 'a']
    expect(rankAsk(e, { smart: [9, 9, 9, 9], keyword }).map((h) => h.id)).toEqual(expected)
    expect(rankAsk(e, { smart: [9, 9], keyword }).map((h) => h.id)).toEqual(expected)
    expect(rankAsk(e, { smart: [], keyword }).map((h) => h.id)).toEqual(expected)
  })

  it('throws when the keyword scores are not one per entry', () => {
    const e = [entry('a'), entry('b')]
    expect(() => rankAsk(e, { keyword: [1, 2, 3] })).toThrow(/keyword/)
    expect(() => rankAsk(e, { keyword: [1] })).toThrow(/keyword/)
  })

  it('demotes a test part in the meaning ranking too', () => {
    const e = [entry('t', true), entry('real')]
    expect(rankAsk(e, { smart: [0.5, 0.5], keyword: [1, 1] }).map((h) => h.id)).toEqual(['real', 't'])
  })

  it('puts the parts whose name the question fills most first, in ranking order, and leaves the rest in place', () => {
    const e = [entry('a'), entry('b'), entry('c'), entry('d')]
    const keyword = [4, 3, 2, 1]
    expect(rankAsk(e, { keyword, named: [0, 0, 1 / 2, 0] }).map((h) => h.id)).toEqual(['c', 'a', 'b', 'd'])
    expect(rankAsk(e, { keyword, named: [0, 1 / 3, 1 / 2, 1 / 2] }).map((h) => h.id)).toEqual(['c', 'd', 'a', 'b'])
    expect(rankAsk(e, { keyword, named: [0, 0, 0, 0] }).map((h) => h.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('puts the named part first over a fused ranking too', () => {
    const e = [entry('line'), entry('part'), entry('other')]
    const scores = { smart: [0.9, 0.1, 0.7], keyword: [3, 1, 2] }
    expect(rankAsk(e, scores).map((h) => h.id)).toEqual(['line', 'other', 'part'])
    expect(rankAsk(e, { ...scores, named: [1 / 3, 1 / 2, 0] }).map((h) => h.id)).toEqual(['part', 'line', 'other'])
  })

  it('never adds a named part the keyword ranking left out, and keeps the limit', () => {
    const e = [entry('a'), entry('b'), entry('c')]
    expect(rankAsk(e, { keyword: [2, 1, 0], named: [0, 0, 1] }).map((h) => h.id)).toEqual(['a', 'b'])
    expect(rankAsk(e, { keyword: [3, 2, 1], named: [0, 1, 1] }, 1).map((h) => h.id)).toEqual(['b'])
  })

  it('breaks a tie in the lead by kind: a building or outside part, then a line, a term, a tour', () => {
    const k = (id: string, kind: AskKind): AskEntry => ({ id, kind, name: id, first: '', text: id, test: false })
    const e = [k('tour', 'tour'), k('term', 'term'), k('line', 'line'), k('ext', 'external'), k('bld', 'building'), k('rest', 'building')]
    const keyword = [6, 5, 4, 3, 2, 1]
    expect(rankAsk(e, { keyword, named: [1.5, 1.5, 1.5, 1.5, 1.5, 0] }).map((h) => h.id)).toEqual(['ext', 'bld', 'line', 'term', 'tour'])
    // A better fit still wins over kind: the whole name of a term beats half the name of a building.
    expect(rankAsk(e, { keyword, named: [0, WHOLE_NAME, 0, 0, 1.5, 0] }).map((h) => h.id)).toEqual(['term', 'tour', 'line', 'ext', 'bld'])
  })

  it('lets a test part lead only when the question is its whole name', () => {
    const e = [entry('t', true), entry('real'), entry('other')]
    // The whole name of a test part leads, even over a better-ranked part with half its name said.
    expect(rankAsk(e, { keyword: [1, 3, 2], named: [WHOLE_NAME, 1.5, 0] }).map((h) => h.id)).toEqual(['t', 'real', 'other'])
    // Part of a test part's name: a non-test part with any lead goes first, and the test part keeps its ranked place.
    expect(rankAsk(e, { keyword: [3, 1, 2], named: [1.5, 1.2, 0] }).map((h) => h.id)).toEqual(['real', 't', 'other'])
    expect(rankAsk(e, { keyword: [3, 1, 2], named: [1.5, 0.5, 0] }).map((h) => h.id)).toEqual(['real', 't', 'other'])
    // With no non-test lead, the test part keeps the usual demotion: below an equal part.
    expect(rankAsk(e, { keyword: [1, 1, 0], named: [1.5, 0, 0] }).map((h) => h.id)).toEqual(['real', 't'])
    expect(rankAsk(e, { keyword: [1, 1, 0], named: [0.5, 0, 0] }).map((h) => h.id)).toEqual(['real', 't'])
  })

  it('keeps the test rule end to end: a test part that fits a one-word question better stays below the real part', () => {
    const part = (id: string, name: string, test: boolean): AskEntry => ({ id, kind: 'building', name, first: '', text: `${name} keeps notes`, test })
    const e = [part('b-mem-tests', 'Memory tests', true), part('b-mem', 'Memory host process', false)]
    const ix = buildBm25(e.map((x) => x.text))
    const ask = (q: string): string[] => rankAsk(e, { keyword: bm25Scores(ix, q), named: nameFit(e, q) }).map((h) => h.id)
    expect(nameFit(e, 'memory')).toEqual([1 + 1 / 2, 1 + 1 / 3])
    expect(ask('memory')).toEqual(['b-mem', 'b-mem-tests'])
    expect(ask('memory tests')).toEqual(['b-mem-tests', 'b-mem'])
  })

  it('puts a question wholly inside one name above a name said among other words', () => {
    const e = [entry('a'), entry('b'), entry('c')]
    expect(rankAsk(e, { keyword: [3, 2, 1], named: [0.75, 1.5, 0] }).map((h) => h.id)).toEqual(['b', 'a', 'c'])
    expect(rankAsk(e, { keyword: [3, 2, 1], named: [0, 0.5, 0] }).map((h) => h.id)).toEqual(['b', 'a', 'c'])
  })

  it('throws when the name fits are not one per entry', () => {
    const e = [entry('a'), entry('b')]
    expect(() => rankAsk(e, { keyword: [1, 2], named: [1] })).toThrow(/name/)
    expect(() => rankAsk(e, { keyword: [1, 2], named: [1, 0, 0] })).toThrow(/name/)
  })
})
