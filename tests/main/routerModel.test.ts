import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// A deterministic stand-in for bge-small: a letter histogram.
function fakeVec(t: string): number[] {
  const v = new Array<number>(26).fill(0)
  for (const c of t.toLowerCase()) { const i = c.charCodeAt(0) - 97; if (i >= 0 && i < 26) v[i]++ }
  v[0] += 0.01
  return v
}
const emb = vi.hoisted(() => ({ down: false, batchCalls: 0 }))
vi.mock('../../src/main/localEmbedder', () => ({
  embedBatch: vi.fn(async (texts: string[]) => { emb.batchCalls++; return texts.map((t) => (emb.down ? null : fakeVec(t))) }),
  embedText: vi.fn(async (t: string) => (emb.down || !t.trim() ? null : fakeVec(t))),
}))

import {
  _resetRouterModelForTests, seedHash, unit, parseItems, loadSeeds, routerWarm, routerClassify, routerLearn,
  SEED_FILE, USER_FILE, MAX_USER_EXAMPLES,
} from '../../src/main/routerModel'
import { flatSeeds } from '../../src/shared/routerSeeds'

let dir: string
beforeEach(() => {
  _resetRouterModelForTests()
  emb.down = false; emb.batchCalls = 0
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-model-'))
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('routerModel helpers', () => {
  it('seedHash is stable and short', () => {
    expect(seedHash()).toMatch(/^[0-9a-f]{16}$/)
    expect(seedHash()).toBe(seedHash())
  })

  it('unit normalises and rejects empty or zero vectors', () => {
    expect(unit([3, 4])).toEqual([0.6, 0.8])
    expect(unit([])).toBeNull()
    expect(unit(null)).toBeNull()
    expect(unit(undefined)).toBeNull()
    expect(unit([0, 0])).toBeNull()
    expect(unit([Infinity, 1])).toBeNull()
  })

  it('parseItems keeps only well-formed items', () => {
    expect(parseItems(null)).toEqual([])
    expect(parseItems({})).toEqual([])
    expect(parseItems([
      { label: 'haiku', vec: [1, 0] },
      { label: 'nope', vec: [1] },
      { label: 'opus', vec: [] },
      { label: 'opus', vec: [1, 'x'] },
      { label: 'opus', vec: [NaN] },
      { label: 'sonnet' },
      null,
    ])).toEqual([{ label: 'haiku', vec: [1, 0] }])
  })
})

describe('routerModel seeds', () => {
  it('embeds once, caches to disk, and reads the cache on the next start', async () => {
    const s = await loadSeeds(dir)
    expect(s).toHaveLength(flatSeeds().length)
    expect(emb.batchCalls).toBe(1)
    expect(await loadSeeds(dir)).toBe(s) // memo
    const file = JSON.parse(fs.readFileSync(path.join(dir, SEED_FILE), 'utf8'))
    expect(file.hash).toBe(seedHash())
    _resetRouterModelForTests()
    expect(await routerWarm(dir)).toBe(true)
    expect(emb.batchCalls).toBe(1) // from the cache
  })

  it('re-embeds a stale or short cache', async () => {
    fs.writeFileSync(path.join(dir, SEED_FILE), JSON.stringify({ hash: 'old', items: [] }))
    await loadSeeds(dir)
    expect(emb.batchCalls).toBe(1)
    _resetRouterModelForTests()
    fs.writeFileSync(path.join(dir, SEED_FILE), JSON.stringify({ hash: seedHash(), items: [{ label: 'haiku', vec: [1] }] }))
    await loadSeeds(dir)
    expect(emb.batchCalls).toBe(2)
  })

  it('shares one load between concurrent callers', async () => {
    const [a, b] = await Promise.all([loadSeeds(dir), loadSeeds(dir)])
    expect(a).toBe(b)
    expect(emb.batchCalls).toBe(1)
  })

  it('returns null while the embedder is down, and tries again later', async () => {
    emb.down = true
    expect(await loadSeeds(dir)).toBeNull()
    expect(await routerWarm(dir)).toBe(false)
    expect(fs.existsSync(path.join(dir, SEED_FILE))).toBe(false)
    emb.down = false
    expect(await loadSeeds(dir)).not.toBeNull()
  })

  it('a cache it cannot write is not fatal', async () => {
    const missing = path.join(dir, 'no', 'such', 'dir')
    expect(await loadSeeds(missing)).toHaveLength(flatSeeds().length)
  })

  it('routerWarm tolerates a missing dir argument, and never writes a cache into the working folder', async () => {
    const cwd = process.cwd()
    process.chdir(dir)
    try {
      expect(await routerWarm(undefined as unknown as string)).toBe(true)
      _resetRouterModelForTests()
      expect(await loadSeeds('relative')).toHaveLength(flatSeeds().length)
      expect((await routerClassify('relative', flatSeeds()[0].text)).cls).not.toBeNull()
      expect(fs.readdirSync(dir)).toEqual([])
    } finally {
      process.chdir(cwd)
    }
  })
})

describe('routerClassify / routerLearn', () => {
  it('classifies a message by its nearest examples', async () => {
    const seed = flatSeeds()[0]
    const r = await routerClassify(dir, seed.text)
    expect(r.cls).not.toBeNull()
    expect(r.cls!.topSim).toBeCloseTo(1, 3)
    expect(r.ms).toBeGreaterThanOrEqual(0)
  })

  it('returns no vote for blank text, a down embedder, or bad args', async () => {
    expect((await routerClassify(dir, '   ')).cls).toBeNull()
    expect((await routerClassify(undefined as unknown as string, undefined as unknown as string)).cls).toBeNull()
    await loadSeeds(dir)
    emb.down = true
    expect((await routerClassify(dir, 'hello there')).cls).toBeNull()
    expect(await routerLearn(dir, 'hello there', 'haiku')).toBe(false)
  })

  it('learns a pick as a vector only, weighted double, and keeps the newest', async () => {
    const text = 'zzzz qqqq xxxx a private message'
    expect(await routerLearn(dir, text, 'nope')).toBe(false)
    expect(await routerLearn('', text, 'haiku')).toBe(false)
    expect(await routerLearn('relative', text, 'haiku')).toBe(false)
    expect(await routerLearn(dir, text, 'opus')).toBe(true)
    const raw = fs.readFileSync(path.join(dir, USER_FILE), 'utf8')
    expect(raw).not.toContain('private')
    expect(JSON.parse(raw).items).toEqual([{ label: 'opus', vec: unit(fakeVec(text)) }])
    const r = await routerClassify(dir, text)
    expect(r.cls!.label).toBe('opus')
    expect(r.cls!.topSim).toBeCloseTo(1, 3)
  })

  it('reads saved picks on a fresh start and caps them', async () => {
    const items = Array.from({ length: MAX_USER_EXAMPLES + 5 }, (_, i) => ({ label: 'haiku', vec: [1, i] }))
    fs.writeFileSync(path.join(dir, USER_FILE), JSON.stringify({ items }))
    expect(await routerLearn(dir, 'one more', 'sonnet')).toBe(true)
    const saved = JSON.parse(fs.readFileSync(path.join(dir, USER_FILE), 'utf8')).items
    expect(saved).toHaveLength(MAX_USER_EXAMPLES)
    expect(saved[saved.length - 1].label).toBe('sonnet')
  })
})
