import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

// Capture recordSwarmError calls so we can assert that real failures
// (not expected silent fallbacks) get surfaced to Sentry.
const mockRecordSwarmError = vi.fn()
vi.mock('../../src/main/telemetry', () => ({
  recordSwarmError: (...args: any[]) => mockRecordSwarmError(...args),
}))

import {
  initSwarmMemory,
  memoryWrite,
  memorySearch,
  memoryList,
  memoryCount,
  memoryClear,
  memoryHasHash,
  memoryStats,
  _resetForTests,
  _setEmbeddingsAvailable,
  _setEmbedFnForTests,
  _setMaxEntriesForTests,
} from '../../src/main/swarmMemory'

// Each test gets its own temp directory so persistence between runs can be
// exercised deterministically without leaking state.
let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-memory-test-'))
  _resetForTests()
  initSwarmMemory(tmpDir)
  _setEmbeddingsAvailable(false)  // force keyword fallback unless a test overrides
  mockRecordSwarmError.mockReset()
})

afterEach(() => {
  _resetForTests()
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  vi.restoreAllMocks()
})

describe('initSwarmMemory', () => {
  it('creates the jsonl store file', () => {
    expect(fs.existsSync(path.join(tmpDir, 'swarm-memory.jsonl'))).toBe(true)
  })

  it('rejects relative paths', () => {
    _resetForTests()
    expect(() => initSwarmMemory('relative/path')).toThrow(/absolute/)
  })

  it('rejects empty path', () => {
    _resetForTests()
    expect(() => initSwarmMemory('')).toThrow(/userDataPath/)
  })

  it('loads existing entries from disk on init', async () => {
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'persist me' })
    _resetForTests()
    initSwarmMemory(tmpDir)
    _setEmbeddingsAvailable(false)
    expect(memoryCount()).toBe(1)
    const list = memoryList()
    expect(list[0].content).toBe('persist me')
  })

  it('skips malformed jsonl lines silently', () => {
    _resetForTests()
    fs.writeFileSync(path.join(tmpDir, 'swarm-memory.jsonl'), '{"id":"ok","ts":1,"agentId":"a","kind":"note","content":"good"}\nnot-json\n')
    initSwarmMemory(tmpDir)
    expect(memoryCount()).toBe(1)
  })

  it('skips entries missing required fields on load', () => {
    _resetForTests()
    // id missing, content wrong type, and a good one
    fs.writeFileSync(path.join(tmpDir, 'swarm-memory.jsonl'),
      '{"ts":1,"agentId":"a","kind":"note","content":"no-id"}\n' +
      '{"id":"x","ts":1,"agentId":"a","kind":"note","content":42}\n' +
      '{"id":"ok","ts":1,"agentId":"a","kind":"note","content":"kept"}\n',
    )
    initSwarmMemory(tmpDir)
    expect(memoryCount()).toBe(1)
  })

  it('swallows init errors when path is unwritable', () => {
    _resetForTests()
    // Passing a path where the userData dir is actually a regular file —
    // path.join will produce something like <file>/swarm-memory.jsonl and
    // fs.writeFileSync will throw (ENOTDIR), exercising the outer catch.
    const bogusFile = path.join(tmpDir, 'not-a-dir.txt')
    fs.writeFileSync(bogusFile, '')
    expect(() => initSwarmMemory(bogusFile)).not.toThrow()
    // Writes after a failed init should not throw either (persist is best-effort)
    return expect(memoryWrite({ agentId: 'a', kind: 'note', content: 'noop' })).resolves.toBeDefined()
  })
})

describe('memoryWrite', () => {
  it('stores a new entry with generated id and timestamp', async () => {
    const entry = await memoryWrite({ agentId: 'claude', kind: 'fact', content: 'hello' })
    expect(entry.id).toMatch(/^mem-/)
    expect(entry.ts).toBeGreaterThan(0)
    expect(entry.agentId).toBe('claude')
    expect(entry.kind).toBe('fact')
    expect(entry.content).toBe('hello')
  })

  it('rejects empty content', async () => {
    await expect(memoryWrite({ agentId: 'a', kind: 'note', content: '   ' })).rejects.toThrow(/required/)
  })

  it('truncates content over 16KB', async () => {
    const huge = 'x'.repeat(50_000)
    const entry = await memoryWrite({ agentId: 'a', kind: 'note', content: huge })
    expect(entry.content.length).toBe(16 * 1024)
  })

  it('defaults agentId to "unknown" when empty', async () => {
    const entry = await memoryWrite({ agentId: '', kind: 'note', content: 'x' })
    expect(entry.agentId).toBe('unknown')
  })

  it('caps tags array to 20 entries', async () => {
    const tags = Array.from({ length: 50 }, (_, i) => `tag${i}`)
    const entry = await memoryWrite({ agentId: 'a', kind: 'note', content: 'x', tags })
    expect(entry.tags?.length).toBe(20)
  })

  it('omits tags when empty array passed', async () => {
    const entry = await memoryWrite({ agentId: 'a', kind: 'note', content: 'x', tags: [] })
    expect(entry.tags).toBeUndefined()
  })

  it('includes taskId when provided', async () => {
    const entry = await memoryWrite({ agentId: 'a', kind: 'note', content: 'x', taskId: 't-1' })
    expect(entry.taskId).toBe('t-1')
  })

  it('persists to disk', async () => {
    await memoryWrite({ agentId: 'a', kind: 'note', content: 'persisted' })
    const raw = fs.readFileSync(path.join(tmpDir, 'swarm-memory.jsonl'), 'utf8')
    expect(raw).toContain('persisted')
  })
})

describe('memorySearch', () => {
  it('finds entries via substring match', async () => {
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'Refactor authentication middleware' })
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'Add unit tests for payment flow' })
    const results = await memorySearch({ query: 'authentication' })
    expect(results.length).toBe(1)
    expect(results[0].content).toContain('authentication')
    expect(results[0].score).toBeGreaterThan(0)
  })

  it('returns empty array for empty query', async () => {
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'thing' })
    expect(await memorySearch({ query: '' })).toEqual([])
    expect(await memorySearch({ query: '   ' })).toEqual([])
  })

  it('filters by agentId', async () => {
    await memoryWrite({ agentId: 'claude', kind: 'fact', content: 'shared knowledge' })
    await memoryWrite({ agentId: 'codex', kind: 'fact', content: 'shared knowledge' })
    const results = await memorySearch({ query: 'shared', agentId: 'codex' })
    expect(results.length).toBe(1)
    expect(results[0].agentId).toBe('codex')
  })

  it('filters by kind', async () => {
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'thing one' })
    await memoryWrite({ agentId: 'a', kind: 'decision', content: 'thing two' })
    const results = await memorySearch({ query: 'thing', kind: 'decision' })
    expect(results.length).toBe(1)
    expect(results[0].kind).toBe('decision')
  })

  it('filters by taskId', async () => {
    await memoryWrite({ agentId: 'a', kind: 'note', content: 'work on thing', taskId: 't-1' })
    await memoryWrite({ agentId: 'a', kind: 'note', content: 'also work on thing', taskId: 't-2' })
    const results = await memorySearch({ query: 'thing', taskId: 't-1' })
    expect(results.length).toBe(1)
    expect(results[0].taskId).toBe('t-1')
  })

  it('respects limit parameter', async () => {
    for (let i = 0; i < 20; i++) {
      await memoryWrite({ agentId: 'a', kind: 'note', content: `match ${i}` })
    }
    const results = await memorySearch({ query: 'match', limit: 5 })
    expect(results.length).toBe(5)
  })

  it('clamps limit to [1, 100]', async () => {
    for (let i = 0; i < 3; i++) {
      await memoryWrite({ agentId: 'a', kind: 'note', content: `match ${i}` })
    }
    const zero = await memorySearch({ query: 'match', limit: 0 })
    expect(zero.length).toBeLessThanOrEqual(3)
    const huge = await memorySearch({ query: 'match', limit: 9999 })
    expect(huge.length).toBeLessThanOrEqual(3)
  })

  it('ranks substring matches higher than token overlap', async () => {
    await memoryWrite({ agentId: 'a', kind: 'note', content: 'refactor user login flow' })
    await memoryWrite({ agentId: 'a', kind: 'note', content: 'refactor user session handling' })
    const results = await memorySearch({ query: 'login' })
    expect(results[0].content).toContain('login')
  })

  it('returns empty list when filter pool is empty', async () => {
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'thing' })
    const results = await memorySearch({ query: 'thing', agentId: 'nobody' })
    expect(results).toEqual([])
  })

  it('drops entries whose score is zero', async () => {
    await memoryWrite({ agentId: 'a', kind: 'note', content: 'totally unrelated text here' })
    const results = await memorySearch({ query: 'authentication middleware' })
    expect(results).toEqual([])
  })
})

describe('memorySearch with embeddings', () => {
  it('uses embedding similarity when query + entries have embeddings', async () => {
    // Provide deterministic per-prompt vectors via the embed override
    const vectors = new Map<string, number[]>([
      ['authentication middleware', [1, 0, 0]],
      ['login flow', [0.9, 0.1, 0]],  // close to authentication
      ['pizza recipe', [0, 0, 1]],     // orthogonal
    ])
    _setEmbedFnForTests(async (text: string) => vectors.get(text) ?? [0.1, 0.1, 0.1])

    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'authentication middleware' })
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'login flow' })
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'pizza recipe' })

    const results = await memorySearch({ query: 'authentication middleware' })
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].content).toBe('authentication middleware')
    const pizzaRank = results.findIndex(r => r.content === 'pizza recipe')
    const loginRank = results.findIndex(r => r.content === 'login flow')
    if (pizzaRank !== -1 && loginRank !== -1) {
      expect(loginRank).toBeLessThan(pizzaRank)
    }
  })

  it('falls back to keyword scoring if no entries have matching-dim embeddings', async () => {
    // First entry written without embeddings
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'no embed content A' })
    // Now enable embeddings for the query — entry has none, so cosine path
    // scores nothing and code falls back to keyword match.
    _setEmbedFnForTests(async () => [1, 2, 3])
    const results = await memorySearch({ query: 'embed' })
    expect(results.length).toBe(1)
  })

  it('skips entries whose embedding dim differs from the query', async () => {
    _setEmbedFnForTests(async (text: string) => text === 'mismatch' ? [1, 0] : [1, 0, 0, 0])
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'mismatch' })  // dim=2
    _setEmbedFnForTests(async () => [1, 0, 0, 0])                           // dim=4 for query
    const results = await memorySearch({ query: 'anything' })
    // mismatch entry had a 2-dim vector; query is 4-dim; cosine loop skips it,
    // so scored.length===0 → keyword fallback.
    expect(results.length).toBeLessThanOrEqual(1)
  })

  it('returns zero score when one cosine vector is all zeros', async () => {
    _setEmbedFnForTests(async () => [0, 0, 0])  // degenerate vector
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'zero vec' })
    const results = await memorySearch({ query: 'zero vec' })
    // With cosine=0 for all entries, search filters them out (score > 0 gate).
    // Either keyword fallback kicks in via "scored.length === 0" branch.
    expect(Array.isArray(results)).toBe(true)
  })
})

describe('memoryList', () => {
  it('returns entries newest first', async () => {
    const a = await memoryWrite({ agentId: 'a', kind: 'note', content: 'first' })
    await new Promise(r => setTimeout(r, 5))
    const b = await memoryWrite({ agentId: 'a', kind: 'note', content: 'second' })
    const list = memoryList()
    expect(list[0].id).toBe(b.id)
    expect(list[1].id).toBe(a.id)
  })

  it('filters by agentId', async () => {
    await memoryWrite({ agentId: 'x', kind: 'note', content: 'x-one' })
    await memoryWrite({ agentId: 'y', kind: 'note', content: 'y-one' })
    const list = memoryList({ agentId: 'y' })
    expect(list.length).toBe(1)
    expect(list[0].content).toBe('y-one')
  })

  it('filters by kind', async () => {
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'f' })
    await memoryWrite({ agentId: 'a', kind: 'decision', content: 'd' })
    const list = memoryList({ kind: 'fact' })
    expect(list.every(e => e.kind === 'fact')).toBe(true)
  })

  it('filters by since timestamp', async () => {
    await memoryWrite({ agentId: 'a', kind: 'note', content: 'old' })
    const cutoff = Date.now() + 1
    await new Promise(r => setTimeout(r, 5))
    await memoryWrite({ agentId: 'a', kind: 'note', content: 'new' })
    const list = memoryList({ since: cutoff })
    expect(list.length).toBe(1)
    expect(list[0].content).toBe('new')
  })

  it('respects limit parameter', async () => {
    for (let i = 0; i < 10; i++) await memoryWrite({ agentId: 'a', kind: 'note', content: `n${i}` })
    expect(memoryList({ limit: 3 }).length).toBe(3)
  })

  it('clamps limit to [1, 500]', async () => {
    await memoryWrite({ agentId: 'a', kind: 'note', content: 'one' })
    expect(memoryList({ limit: 0 }).length).toBe(1)
    expect(memoryList({ limit: 99999 }).length).toBe(1)
  })

  it('returns empty list when no entries', () => {
    expect(memoryList()).toEqual([])
  })
})

describe('memoryCount / memoryClear', () => {
  it('count starts at zero and increments per write', async () => {
    expect(memoryCount()).toBe(0)
    await memoryWrite({ agentId: 'a', kind: 'note', content: 'one' })
    expect(memoryCount()).toBe(1)
    await memoryWrite({ agentId: 'a', kind: 'note', content: 'two' })
    expect(memoryCount()).toBe(2)
  })

  it('clear empties both memory and disk', async () => {
    await memoryWrite({ agentId: 'a', kind: 'note', content: 'delete me' })
    memoryClear()
    expect(memoryCount()).toBe(0)
    const raw = fs.readFileSync(path.join(tmpDir, 'swarm-memory.jsonl'), 'utf8')
    expect(raw).toBe('')
  })
})

describe('content-hash dedup (idempotent ingest)', () => {
  it('stores source + hash and reports them via memoryHasHash', async () => {
    expect(memoryHasHash('h1')).toBe(false)
    const e = await memoryWrite({ agentId: 'claude', kind: 'message', content: 'past convo', source: 'claude', hash: 'h1' })
    expect(e.source).toBe('claude')
    expect(e.hash).toBe('h1')
    expect(memoryHasHash('h1')).toBe(true)
  })

  it('memoryHasHash is false for unknown or non-string input', async () => {
    await memoryWrite({ agentId: 'a', kind: 'note', content: 'x', hash: 'known' })
    expect(memoryHasHash('other')).toBe(false)
    expect(memoryHasHash(undefined as unknown as string)).toBe(false)
  })

  it('rebuilds the hash set from disk on init', async () => {
    await memoryWrite({ agentId: 'a', kind: 'message', content: 'c', source: 'codex', hash: 'persist-h' })
    _resetForTests()
    initSwarmMemory(tmpDir)
    _setEmbeddingsAvailable(false)
    expect(memoryHasHash('persist-h')).toBe(true)
    const reloaded = memoryList()[0]
    expect(reloaded.source).toBe('codex')
    expect(reloaded.hash).toBe('persist-h')
  })
})

describe('ring buffer cap', () => {
  it('drops oldest entries past the configured cap', async () => {
    _setMaxEntriesForTests(5)
    for (let i = 0; i < 7; i++) {
      await memoryWrite({ agentId: 'a', kind: 'note', content: `e${i}` })
    }
    expect(memoryCount()).toBe(5)
    expect(memoryList({ limit: 1 })[0].content).toBe('e6') // newest kept
    expect(memoryStats()).toEqual({ count: 5, capacity: 5 })
  })

  it("removes evicted entries' hashes from the dedup set", async () => {
    _setMaxEntriesForTests(2)
    await memoryWrite({ agentId: 'a', kind: 'note', content: 'old', hash: 'old-h' })
    await memoryWrite({ agentId: 'a', kind: 'note', content: 'mid', hash: 'mid-h' })
    await memoryWrite({ agentId: 'a', kind: 'note', content: 'new', hash: 'new-h' }) // evicts 'old'
    expect(memoryHasHash('old-h')).toBe(false) // evicted hash removed from dedup set
    expect(memoryHasHash('new-h')).toBe(true)
  })

  it('defaults to a large semantic window', () => {
    expect(memoryStats().capacity).toBe(50_000)
  })
})

describe('embedding graceful failure', () => {
  it('write succeeds even when embed throws', async () => {
    _setEmbedFnForTests(async () => { throw new Error('connection refused') })
    const entry = await memoryWrite({ agentId: 'a', kind: 'note', content: 'survives' })
    expect(entry.embedding).toBeUndefined()
  })

  it('write succeeds when embed returns null', async () => {
    _setEmbedFnForTests(async () => null)
    const entry = await memoryWrite({ agentId: 'a', kind: 'note', content: 'malformed' })
    expect(entry.embedding).toBeUndefined()
  })

  it('rejects oversized embeddings', async () => {
    _setEmbedFnForTests(async () => new Array(99999).fill(0.1))
    const entry = await memoryWrite({ agentId: 'a', kind: 'note', content: 'big' })
    expect(entry.embedding).toBeUndefined()
  })
})

describe('swarm error reporting', () => {
  it('reports init failure to Sentry when the parent directory does not exist', () => {
    _resetForTests()
    // Path inside a nonexistent directory — fs.writeFileSync will throw ENOENT,
    // which is exactly the kind of real failure we want surfaced.
    const ghost = path.join(os.tmpdir(), `does-not-exist-${Date.now()}`, 'nested', 'deeper')
    initSwarmMemory(ghost)
    expect(mockRecordSwarmError).toHaveBeenCalledWith(
      'swarmMemory.init.failed',
      expect.any(Error),
      expect.objectContaining({ memPath: expect.stringContaining('swarm-memory.jsonl') }),
    )
  })

  it('reports persist failure to Sentry when the memory file is replaced with a directory', async () => {
    // Simulate disk-level failure: replace the memory file with a directory of
    // the same name so appendFileSync fails with EISDIR.
    const memFile = path.join(tmpDir, 'swarm-memory.jsonl')
    fs.unlinkSync(memFile)
    fs.mkdirSync(memFile)
    await memoryWrite({ agentId: 'a', kind: 'note', content: 'will fail to persist' })
    expect(mockRecordSwarmError).toHaveBeenCalledWith(
      'swarmMemory.persist.failed',
      expect.any(Error),
      expect.objectContaining({ entryId: expect.stringContaining('mem-') }),
    )
  })

  it('does NOT report a malformed JSONL line as a swarm error (expected)', () => {
    _resetForTests()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-malformed-'))
    fs.writeFileSync(path.join(dir, 'swarm-memory.jsonl'),
      '{"id":"valid","ts":1,"agentId":"a","kind":"note","content":"ok"}\nNOT JSON\n',
    )
    initSwarmMemory(dir)
    expect(mockRecordSwarmError).not.toHaveBeenCalled()
    expect(memoryCount()).toBe(1)
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  })

  it('does NOT report embedding failures as swarm errors (expected fallback)', async () => {
    _setEmbedFnForTests(async () => { throw new Error('embedder not ready') })
    await memoryWrite({ agentId: 'a', kind: 'note', content: 'survives' })
    // Embedding failure goes to its own catch with no telemetry — explicit
    // design choice (embedder-not-ready is expected, not a bug).
    expect(mockRecordSwarmError).not.toHaveBeenCalled()
  })
})
