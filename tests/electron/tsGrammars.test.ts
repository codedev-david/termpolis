import { describe, it, expect } from 'vitest'
import { loadGrammar, grammarAvailable, newParser, _resetGrammarCacheForTests } from '../../src/main/tsGrammars'

describe('tsGrammars — WASM grammar loader', () => {
  it('grammarAvailable reflects the on-disk grammars', () => {
    expect(grammarAvailable('typescript')).toBe(true)
    expect(grammarAvailable('python')).toBe(true)
    expect(grammarAvailable('nonexistent-lang')).toBe(false)
  })

  it('loads a known grammar and returns null for an unknown one', async () => {
    expect(await loadGrammar('typescript')).toBeTruthy()
    expect(await loadGrammar('nonexistent-lang')).toBeNull()
  })

  it('caches a loaded grammar (same instance) and reloads after a reset', async () => {
    const a = await loadGrammar('python')
    const b = await loadGrammar('python')
    expect(a).toBe(b) // cached
    _resetGrammarCacheForTests()
    expect(await loadGrammar('python')).toBeTruthy() // reloads
    expect(await loadGrammar('nonexistent-lang')).toBeNull() // negative cache path
  })

  it('newParser returns a usable parser instance', () => {
    const p = newParser()
    expect(typeof p.parse).toBe('function')
  })
})
