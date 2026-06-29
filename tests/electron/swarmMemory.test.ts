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
  memoryDelete,
  memoryHasHash,
  memoryStats,
  memoryPatchProjects,
  normalizeProjectSlug,
  _resetForTests,
  persistMemoryIndex,
  _setEmbeddingsAvailable,
  _setEmbedFnForTests,
  _setMaxEntriesForTests,
  _setHnswThresholdForTests,
  _setHnswYieldMsForTests,
  _whenHnswSettledForTests,
  _isHnswReadyForTests,
} from '../../src/main/swarmMemory'
import { HnswIndex } from '../../src/main/hnswIndex'

// Opt-in gate for the wall-clock event-loop responsiveness test. It measures real
// timing while a large graph builds, so its duration swings ~7x between a fast dev
// box (~4s) and a loaded CI runner (>30s) — too variable to gate CI on. Run it on
// demand: RUN_TIMING_TESTS=1 npx vitest run tests/electron/swarmMemory.test.ts
const RUN_TIMING_TESTS = process.env.RUN_TIMING_TESTS === '1'

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
    // Distinct content per agent — identical text would de-duplicate into one entry.
    await memoryWrite({ agentId: 'claude', kind: 'fact', content: 'shared knowledge from claude' })
    await memoryWrite({ agentId: 'codex', kind: 'fact', content: 'shared knowledge from codex' })
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

describe('rank fusion (QW1: recency + per-kind importance)', () => {
  it('ranks an OLDER decision above a NEWER message at equal keyword relevance (kind prior beats the recency tie-break)', async () => {
    // Both contents contain the full query as a substring → identical relevance (1.0).
    // The decision is written FIRST (older). Under the OLD pure-recency tie-break the
    // newer message would win; under QW1 the decision's kind prior (1.15) lifts it first.
    await memoryWrite({ agentId: 'a', kind: 'decision', content: 'alpha topic chosen approach' })
    await new Promise(r => setTimeout(r, 5))
    await memoryWrite({ agentId: 'a', kind: 'message', content: 'alpha topic casual remark' })
    const results = await memorySearch({ query: 'alpha topic' })
    expect(results.map(r => r.kind)).toEqual(['decision', 'message'])
  })

  it('still orders primarily by relevance — a far more relevant message beats a weak decision', async () => {
    await memoryWrite({ agentId: 'a', kind: 'decision', content: 'mentions widget once' })
    await memoryWrite({ agentId: 'a', kind: 'message', content: 'widget widget widget exact widget match' })
    // Direct substring match (score 1.0) on the message must still outrank a weak
    // token-overlap decision — the 1.15 kind prior only breaks near-ties, never overrides.
    const results = await memorySearch({ query: 'widget widget widget exact widget match' })
    expect(results[0].kind).toBe('message')
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
    expect(memoryStats().capacity).toBe(500_000)
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

// Inject a deterministic EMBED_DIM (384) unit vector so entries take the packed
// fast path without needing the real model. cos(vec(a), vec(b)) = 1 if a===b else 0.
const vec384 = (seed: number): number[] => {
  const v = new Array(384).fill(0)
  v[((seed % 384) + 384) % 384] = 1
  return v
}

// Deterministic DISTINCT dense unit vectors — representative of real embeddings
// (unlike one-hot vec384, which collides after 384 and makes a degenerate all-ties
// graph). Used where the HNSW build needs to be realistic, e.g. the responsiveness test.
const denseVec384 = (seed: number): number[] => {
  let s = (seed * 2654435761 + 1) >>> 0
  const v = new Array(384)
  let norm = 0
  for (let d = 0; d < 384; d++) {
    s = (s ^ (s << 13)) >>> 0; s = (s ^ (s >>> 17)) >>> 0; s = (s ^ (s << 5)) >>> 0
    const x = (s / 4294967296) * 2 - 1
    v[d] = x; norm += x * x
  }
  norm = Math.sqrt(norm) || 1
  for (let d = 0; d < 384; d++) v[d] /= norm
  return v
}

describe('packed vector index (memory-win integration)', () => {
  it('packs EMBED_DIM embeddings into the store, frees the number[] on stored entries, still searchable', async () => {
    _setEmbedFnForTests(async () => vec384(0))
    const written = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'packed me' })
    expect(written.embedding).toBeTruthy()              // returned entry keeps it (write contract)
    expect(written.embedding!.length).toBe(384)
    expect(memoryList()[0].embedding).toBeUndefined()   // …but the stored hot-window entry dropped it
    const hits = await memorySearch({ query: 'anything' })
    expect(hits.some((h) => h.content === 'packed me')).toBe(true)
  })

  it('ranks the nearest packed vector first', async () => {
    _setEmbedFnForTests(async (t) => (t.includes('auth') ? vec384(1) : vec384(2)))
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'about auth tokens' })
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'about pizza' })
    _setEmbedFnForTests(async () => vec384(1)) // query aligned with the 'auth' vector
    const hits = await memorySearch({ query: 'q', limit: 2 })
    expect(hits[0].content).toBe('about auth tokens')
  })

  it('applies agent/kind filters on the packed fast path', async () => {
    _setEmbedFnForTests(async () => vec384(3))
    await memoryWrite({ agentId: 'alice', kind: 'fact', content: 'alice fact' })
    await memoryWrite({ agentId: 'bob', kind: 'fact', content: 'bob fact' })
    _setEmbedFnForTests(async () => vec384(3))
    const hits = await memorySearch({ query: 'q', agentId: 'bob' })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.every((h) => h.agentId === 'bob')).toBe(true)
  })

  it('reconstructs packed vectors on reload so nothing is lost', async () => {
    _setEmbedFnForTests(async () => vec384(5))
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'survive reload' })
    _resetForTests()
    _setEmbedFnForTests(async () => vec384(5))
    initSwarmMemory(tmpDir) // re-reads JSONL (kept the embedding) → re-packs
    const hits = await memorySearch({ query: 'q' })
    expect(hits.some((h) => h.content === 'survive reload')).toBe(true)
  })

  it('drops a packed entry from search after delete', async () => {
    _setEmbedFnForTests(async () => vec384(7))
    const w = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'delete this packed' })
    memoryDelete(w.id)
    _setEmbedFnForTests(async () => vec384(7))
    const hits = await memorySearch({ query: 'q' })
    expect(hits.some((h) => h.content === 'delete this packed')).toBe(false)
  })

  it('leaves non-EMBED_DIM (small) vectors on the legacy per-object path', async () => {
    _setEmbedFnForTests(async () => [1, 0, 0]) // 3-dim, not EMBED_DIM
    const w = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'small vec' })
    expect(w.embedding).toEqual([1, 0, 0])
    expect(memoryList()[0].embedding).toEqual([1, 0, 0]) // not packed → stays on the entry
  })
})

describe('HNSW acceleration (large-store path)', () => {
  it('builds the HNSW graph above the threshold and returns correct results', async () => {
    _setHnswThresholdForTests(4) // build the graph after just a few vectors
    let i = 0
    _setEmbedFnForTests(async (t) => (t.includes('target') ? vec384(1) : vec384(50 + i++)))
    for (let n = 0; n < 8; n++) await memoryWrite({ agentId: 'a', kind: 'fact', content: `noise ${n}` })
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'the target fact' })
    _setEmbedFnForTests(async () => vec384(1)) // exact match with the target
    const hits = await memorySearch({ query: 'q', limit: 3 })
    expect(hits.some((h) => h.content === 'the target fact')).toBe(true)
  })

  it('excludes a deleted entry from HNSW search via the allow filter', async () => {
    _setHnswThresholdForTests(3)
    let i = 0
    _setEmbedFnForTests(async () => vec384(20 + i++))
    for (let n = 0; n < 5; n++) await memoryWrite({ agentId: 'a', kind: 'fact', content: `v${n}` })
    const doomed = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'doomed' }) // vec384(25)
    memoryDelete(doomed.id)
    _setEmbedFnForTests(async () => vec384(25)) // query for the now-deleted vector
    const hits = await memorySearch({ query: 'q', limit: 5 })
    expect(hits.some((h) => h.content === 'doomed')).toBe(false)
  })

  it('stays on exact brute-force below the threshold (no graph built)', async () => {
    _setHnswThresholdForTests(1_000_000) // effectively never build
    _setEmbedFnForTests(async (t) => (t.includes('match') ? vec384(2) : vec384(99)))
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'a match here' })
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'unrelated' })
    _setEmbedFnForTests(async () => vec384(2))
    const hits = await memorySearch({ query: 'q', limit: 1 })
    expect(hits[0].content).toBe('a match here')
  })

  it('builds in the BACKGROUND without blocking the search, then persists', async () => {
    _setHnswThresholdForTests(4)
    _setHnswYieldMsForTests(0) // yield every insert → force the async background build
    const graphPath = path.join(tmpDir, 'memory-hnsw.json')
    let i = 0
    _setEmbedFnForTests(async (t) => (t.includes('target') ? vec384(1) : vec384(50 + i++)))
    for (let n = 0; n < 8; n++) await memoryWrite({ agentId: 'a', kind: 'fact', content: `noise ${n}` })
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'the target fact' })
    _setEmbedFnForTests(async () => vec384(1)) // exact match with the target

    // The triggering search returns correct results immediately via the exact
    // brute-force fallback. With yield=0 the build suspends after its first insert
    // (a macrotask), but this search resolves on the microtask queue first — so the
    // graph provably isn't ready yet, proving the search did NOT block on it.
    const during = await memorySearch({ query: 'q', limit: 3 })
    expect(_isHnswReadyForTests()).toBe(false)
    expect(during.some((h) => h.content === 'the target fact')).toBe(true)

    // The graph finishes in the background and is persisted; later searches use it.
    await _whenHnswSettledForTests()
    expect(_isHnswReadyForTests()).toBe(true)
    expect(fs.existsSync(graphPath)).toBe(true)
    const after = await memorySearch({ query: 'q', limit: 3 })
    expect(after.some((h) => h.content === 'the target fact')).toBe(true)
  })

  it.skipIf(!RUN_TIMING_TESTS)('keeps the event loop responsive during a background build (no UI starvation)', async () => {
    _setHnswThresholdForTests(4)
    let i = 0
    _setEmbedFnForTests(async () => denseVec384(i++))
    for (let n = 0; n < 1500; n++) await memoryWrite({ agentId: 'a', kind: 'fact', content: `e${n}` })
    _setEmbedFnForTests(async () => denseVec384(999999))

    // Sample event-loop lag (how late a 10 ms timer actually fires) while the graph
    // builds in the background. Frame-budget yielding keeps every gap small; the OLD
    // blocking build would stall the loop for the whole build. In the app the build
    // runs in the main process, so a responsive loop here == IPC (terminal I/O,
    // panels) stays responsive == the user doesn't see a freeze.
    const lags: number[] = []
    let last = Date.now()
    const timer = setInterval(() => { const t = Date.now(); lags.push(t - last - 10); last = t }, 10)
    await memorySearch({ query: 'q' }) // returns fast (non-blocking) but kicks the build
    await _whenHnswSettledForTests() // now wait out the background build, timer still ticking
    clearInterval(timer)

    expect(_isHnswReadyForTests()).toBe(true) // it really built in the background
    expect(lags.length).toBeGreaterThan(5)    // the loop kept ticking throughout the build
    const maxLag = Math.max(...lags)
    console.log(`[event-loop responsiveness] samples=${lags.length} maxLag=${maxLag}ms`)
    expect(maxLag).toBeLessThan(400)          // generous tripwire; real value ~20ms, starvation would be >>1s
  }, 30000)
})

describe('HNSW persistence', () => {
  async function fillStore(n: number, start = 0): Promise<void> {
    let i = start
    _setEmbedFnForTests(async () => vec384(i++))
    for (let k = 0; k < n; k++) await memoryWrite({ agentId: 'a', kind: 'fact', content: `e${start + k}` })
  }
  const graphFile = () => path.join(tmpDir, 'memory-hnsw.json')

  it('saves the graph to disk after building it', async () => {
    _setHnswThresholdForTests(4)
    await fillStore(8)
    _setEmbedFnForTests(async () => vec384(0))
    await memorySearch({ query: 'q' }) // build + save
    await _whenHnswSettledForTests() // build is backgrounded — wait for it
    expect(fs.existsSync(graphFile())).toBe(true)
  })

  it('loads the persisted graph on reload (skips rebuild) when unchanged', async () => {
    _setHnswThresholdForTests(4)
    await fillStore(8)
    _setEmbedFnForTests(async () => vec384(0))
    await memorySearch({ query: 'q' }) // build + save with fingerprint A
    await _whenHnswSettledForTests()
    _resetForTests(); _setHnswThresholdForTests(4); _setEmbedFnForTests(async () => vec384(0))
    initSwarmMemory(tmpDir) // same disk → fingerprint matches
    const spy = vi.spyOn(HnswIndex, 'fromJSON')
    await memorySearch({ query: 'q' })
    expect(spy).toHaveBeenCalled() // loaded from disk, not rebuilt
    spy.mockRestore()
  })

  it('ignores the persisted graph and rebuilds when the store changed', async () => {
    _setHnswThresholdForTests(4)
    await fillStore(8)
    _setEmbedFnForTests(async () => vec384(0))
    await memorySearch({ query: 'q' }) // save fingerprint A
    await _whenHnswSettledForTests()
    await fillStore(1, 100) // a new entry → disk content changes
    _resetForTests(); _setHnswThresholdForTests(4); _setEmbedFnForTests(async () => vec384(0))
    initSwarmMemory(tmpDir)
    const spy = vi.spyOn(HnswIndex, 'fromJSON')
    await memorySearch({ query: 'q' })
    expect(spy).not.toHaveBeenCalled() // fingerprint mismatch → rebuild
    spy.mockRestore()
  })

  it('ignores a corrupt persisted graph and rebuilds without throwing', async () => {
    _setHnswThresholdForTests(4)
    await fillStore(8)
    fs.writeFileSync(graphFile(), 'not json{{{')
    _setEmbedFnForTests(async () => vec384(0))
    const hits = await memorySearch({ query: 'q', limit: 1 })
    expect(Array.isArray(hits)).toBe(true)
  })

  it('persistMemoryIndex re-saves the built graph; memoryClear removes the file', async () => {
    _setHnswThresholdForTests(4)
    await fillStore(8)
    _setEmbedFnForTests(async () => vec384(0))
    await memorySearch({ query: 'q' })
    await _whenHnswSettledForTests()
    fs.rmSync(graphFile(), { force: true })
    persistMemoryIndex() // graph is fresh → re-saves
    expect(fs.existsSync(graphFile())).toBe(true)
    memoryClear()
    expect(fs.existsSync(graphFile())).toBe(false)
  })
})

describe('project metadata (current-directory recall)', () => {
  it('memoryWrite normalizes a cwd/path into a project slug', async () => {
    await memoryWrite({ agentId: 'a', kind: 'note', content: 'alpha note', project: 'C:\\Users\\Dev\\repos\\Termpolis\\' })
    const [hit] = await memorySearch({ query: 'alpha', limit: 5 })
    expect(hit.project).toBe('termpolis')
  })

  it('memorySearch({ project }) filters to that project, accepting a path or slug', async () => {
    await memoryWrite({ agentId: 'a', kind: 'note', content: 'alpha in termpolis', project: '/repos/termpolis' })
    await memoryWrite({ agentId: 'a', kind: 'note', content: 'alpha in other', project: '/repos/other' })
    const hits = await memorySearch({ query: 'alpha', project: 'C:/repos/Termpolis' })
    expect(hits).toHaveLength(1)
    expect(hits[0].content).toContain('termpolis')
  })

  it('normalizeProjectSlug handles windows/posix paths, bare names, and junk', () => {
    expect(normalizeProjectSlug('C:\\repos\\MyApp\\')).toBe('myapp')
    expect(normalizeProjectSlug('/home/dev/My-App')).toBe('my-app')
    expect(normalizeProjectSlug('Termpolis')).toBe('termpolis')
    expect(normalizeProjectSlug('')).toBe('')
    expect(normalizeProjectSlug('  /  ')).toBe('')
  })

  it('memoryPatchProjects backfills hash-matched entries without overwriting existing tags', async () => {
    await memoryWrite({ agentId: 'a', kind: 'message', content: 'old conversation chunk', hash: 'h-old' })
    await memoryWrite({ agentId: 'a', kind: 'message', content: 'tagged already', hash: 'h-tagged', project: '/repos/keepme' })
    const n = memoryPatchProjects([
      { hash: 'h-old', project: 'C:\\repos\\Termpolis' },
      { hash: 'h-tagged', project: '/repos/clobber' },
      { hash: 'h-missing', project: '/repos/x' },
    ])
    expect(n).toBe(1)
    expect(await memorySearch({ query: 'conversation', project: 'termpolis' })).toHaveLength(1)
    expect(await memorySearch({ query: 'tagged', project: 'keepme' })).toHaveLength(1)
    expect(await memorySearch({ query: 'tagged', project: 'clobber' })).toHaveLength(0)
  })
})
