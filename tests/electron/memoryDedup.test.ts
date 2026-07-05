import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  initSwarmMemory, memoryWrite, memoryCount, contentHash,
  _resetForTests, _setEmbeddingsAvailable, _setEmbedFnForTests,
} from '../../src/main/swarmMemory'

let tmp: string

function freshStore(): void {
  _resetForTests()
  _setEmbeddingsAvailable(false)
  _setEmbedFnForTests(async () => null) // keyword mode — dedup is hash-based, embedding-independent
  initSwarmMemory(tmp)
}

describe('memory de-duplication — no duplicate data in the vector db or on disk', () => {
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-dedup-')); freshStore() })
  afterEach(() => { _resetForTests(); try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ } })

  it('does not store a second copy of identical content (even from a different agent)', async () => {
    const a = await memoryWrite({ agentId: 'claude', kind: 'fact', content: 'login returns 500 on an expired token' })
    const b = await memoryWrite({ agentId: 'codex', kind: 'fact', content: 'login returns 500 on an expired token' })
    expect(memoryCount()).toBe(1)
    expect(b.id).toBe(a.id) // the existing entry is returned, not a fresh duplicate
  })

  it('collapses TRAILING whitespace but preserves internal whitespace (F25)', async () => {
    // Trailing whitespace / trailing blank lines are insignificant → still dedup.
    await memoryWrite({ agentId: 'a', kind: 'note', content: 'hello world' })
    await memoryWrite({ agentId: 'a', kind: 'note', content: 'hello world   \n\n' })
    expect(memoryCount()).toBe(1)
    // Internal whitespace (indentation) IS significant now → distinct entries, not false-dedup.
    await memoryWrite({ agentId: 'a', kind: 'note', content: 'def f():\n  return risky()' })
    await memoryWrite({ agentId: 'a', kind: 'note', content: 'def f():\n    return risky()' })
    expect(memoryCount()).toBe(3)
  })

  it('keeps genuinely different content', async () => {
    await memoryWrite({ agentId: 'a', kind: 'note', content: 'alpha' })
    await memoryWrite({ agentId: 'a', kind: 'note', content: 'beta' })
    expect(memoryCount()).toBe(2)
  })

  it('writes no duplicate line to disk either (dedup survives a reload)', async () => {
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'a unique fact worth keeping once' })
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'a unique fact worth keeping once' })
    freshStore() // reload from disk
    expect(memoryCount()).toBe(1)
  })

  it('contentHash preserves internal whitespace but ignores trailing (F25)', () => {
    expect(contentHash('a b   ')).toBe(contentHash('a b'))        // trailing whitespace ignored
    expect(contentHash('a b\n\n')).toBe(contentHash('a b'))       // trailing blank lines ignored
    expect(contentHash('a b')).not.toBe(contentHash('a   b'))     // internal whitespace is significant
    expect(contentHash('x:\n  y')).not.toBe(contentHash('x:\n    y')) // indentation is significant
    expect(contentHash('a b')).not.toBe(contentHash('a c'))
  })

  it('hashes empty and whitespace-only content without throwing', () => {
    expect(typeof contentHash('')).toBe('string')
    expect(contentHash('   ')).toBe(contentHash('')) // both normalize to empty
  })
})
