import { describe, it, expect } from 'vitest'
import { LexicalIndex, tokenizeLexical } from '../../src/main/lexicalIndex'

describe('tokenizeLexical', () => {
  it('NFC-normalizes, lowercases, splits on non-word runs, drops tokens <= 2 chars', () => {
    // `_` is a word char, so snake_case identifiers stay whole (a feature for code tokens).
    expect(tokenizeLexical('Hello, World! foo_bar baz')).toEqual(['hello', 'world', 'foo_bar', 'baz'])
    expect(tokenizeLexical('a an the it is')).toEqual(['the']) // a/an/it/is are <=2 chars
    expect(tokenizeLexical('')).toEqual([])
  })
  it('does NOT stem/suffix-strip — identifiers stay distinct', () => {
    expect(tokenizeLexical('paths path useState')).toEqual(['paths', 'path', 'usestate'])
  })
})

describe('LexicalIndex (BM25)', () => {
  it('ranks docs containing the query terms and omits non-matching docs', () => {
    const idx = new LexicalIndex()
    idx.add('d1', 'the quick brown fox')
    idx.add('d2', 'lazy dog sleeps')
    const r = idx.search('quick fox', 10)
    expect(r.map(x => x.id)).toEqual(['d1'])
    expect(r[0].score).toBeGreaterThan(0)
  })

  it('weights a rare term higher than a common one (idf)', () => {
    const idx = new LexicalIndex()
    idx.add('d1', 'common alpha beta')
    idx.add('d2', 'common gamma delta')
    idx.add('d3', 'common rareword epsilon') // only d3 has the rare term
    const r = idx.search('common rareword', 10)
    expect(r[0].id).toBe('d3') // the rare term lifts d3 above the common-only docs
  })

  it('favors shorter documents for the same term frequency (length normalization)', () => {
    const idx = new LexicalIndex()
    idx.add('short', 'needle')
    idx.add('long', 'needle ' + 'filler '.repeat(20))
    expect(idx.search('needle', 10)[0].id).toBe('short')
  })

  it('rewards higher term frequency', () => {
    const idx = new LexicalIndex()
    idx.add('once', 'term other words here padding extra')
    idx.add('thrice', 'term term term other words here')
    expect(idx.search('term', 10)[0].id).toBe('thrice')
  })

  it('honors the allow() filter', () => {
    const idx = new LexicalIndex()
    idx.add('a', 'match here')
    idx.add('b', 'match there')
    expect(idx.search('match', 10, (id) => id !== 'a').map(x => x.id)).toEqual(['b'])
  })

  it('is idempotent on re-add — old content is replaced', () => {
    const idx = new LexicalIndex()
    idx.add('d', 'original alpha')
    idx.add('d', 'updated betaword')
    expect(idx.size).toBe(1)
    expect(idx.search('alpha', 10)).toEqual([])
    expect(idx.search('betaword', 10).map(x => x.id)).toEqual(['d'])
  })

  it('remove drops the doc and cleans its postings; remove of an unknown id is a no-op', () => {
    const idx = new LexicalIndex()
    idx.add('d', 'gone soon')
    idx.remove('d')
    expect(idx.size).toBe(0)
    expect(idx.search('gone', 10)).toEqual([])
    expect(() => idx.remove('nonexistent')).not.toThrow()
  })

  it('clear empties the index', () => {
    const idx = new LexicalIndex()
    idx.add('d', 'some content here')
    idx.clear()
    expect(idx.size).toBe(0)
    expect(idx.search('content', 10)).toEqual([])
  })

  it('returns [] for an empty corpus, empty/too-short query, or k <= 0', () => {
    const idx = new LexicalIndex()
    expect(idx.search('anything', 10)).toEqual([]) // empty corpus
    idx.add('d', 'some content')
    expect(idx.search('', 10)).toEqual([])
    expect(idx.search('xy', 10)).toEqual([]) // all query tokens <= 2 chars
    expect(idx.search('content', 0)).toEqual([]) // k <= 0
  })
})
