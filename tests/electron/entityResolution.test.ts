// Tier-2 — entity resolution beyond exact string identity. Entity nodes deduped on the raw name
// (case-sensitive, article- and extension-included), so "Parser" / "the parser" / "parser.ts"
// fragmented into separate nodes and the same real entity accreted no relationships. This adds a
// CONSERVATIVE canonicalization (case, leading article, code-file extension) that merges obvious
// aliases while deliberately NOT folding plurals or separators (which would over-merge distinct
// entities). Project scoping is preserved — aliases merge only within a repo.
import { describe, it, expect } from 'vitest'
import { entityDedupHash, canonicalEntityName } from '../../src/main/swarmMemory'

describe('entity resolution (Tier-2)', () => {
  it('canonicalizes case, leading articles, whitespace, and code file extensions', () => {
    expect(canonicalEntityName('Parser')).toBe('parser')
    expect(canonicalEntityName('The Parser')).toBe('parser')
    expect(canonicalEntityName('  the   Parser ')).toBe('parser')
    expect(canonicalEntityName('parser.ts')).toBe('parser')
    expect(canonicalEntityName('Scheduler.py')).toBe('scheduler')
    expect(canonicalEntityName('src/parser.ts')).toBe('src/parser') // path kept, extension stripped
    expect(canonicalEntityName('a Config')).toBe('config')
  })

  it('collapses aliases of the same entity to one dedup key', () => {
    const k = entityDedupHash('parser')
    for (const alias of ['Parser', 'the parser', 'The Parser', 'parser.ts', '  parser  ']) {
      expect(entityDedupHash(alias)).toBe(k)
    }
  })

  it('does NOT over-merge genuinely distinct entities', () => {
    expect(entityDedupHash('parser')).not.toBe(entityDedupHash('scheduler'))
    expect(entityDedupHash('parser')).not.toBe(entityDedupHash('parsers')) // plural is NOT folded
    expect(entityDedupHash('config')).not.toBe(entityDedupHash('configure'))
    // in a multi-word phrase, the extension is left intact (never strip an extension mid-phrase)
    // and only a LEADING article is removed (here the string starts with "edit", so nothing is)
    expect(canonicalEntityName('edit the parser.ts file')).toBe('edit the parser.ts file')
  })

  it('preserves project scoping — aliases merge only within a repo, never across repos', () => {
    expect(entityDedupHash('parser', 'repoAkey')).not.toBe(entityDedupHash('parser', 'repoBkey'))
    expect(entityDedupHash('Parser', 'repoAkey')).toBe(entityDedupHash('the parser', 'repoAkey'))
    // unscoped (global) aliasing still works and stays distinct from the scoped key
    expect(entityDedupHash('Parser')).toBe(entityDedupHash('parser.ts'))
    expect(entityDedupHash('parser')).not.toBe(entityDedupHash('parser', 'repoAkey'))
  })
})
