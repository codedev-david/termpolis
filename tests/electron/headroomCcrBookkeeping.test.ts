import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * A stash is the promise behind a retrieve_full token that is already on the wire. The elision ledger is
 * bookkeeping about that promise. If the bookkeeping fails, the promise must still be kept, and a stash
 * that survives a restart must still be counted in its class when the model asks for it.
 */

const state = vi.hoisted(() => ({ throwOnRecord: false, throwOnSanitize: false, recorded: [] as string[] }))
vi.mock('../../src/main/headroom/elisionLedger', async () => {
  const real = await vi.importActual<typeof import('../../src/main/headroom/elisionLedger')>('../../src/main/headroom/elisionLedger')
  return {
    ...real,
    recordElision: (token: string, meta: Parameters<typeof real.recordElision>[1]): void => {
      if (state.throwOnRecord) throw new Error('ledger fault')
      state.recorded.push(token)
      real.recordElision(token, meta)
    },
  }
})

vi.mock('../../src/main/headroom/elisionMeta', async () => {
  const real = await vi.importActual<typeof import('../../src/main/headroom/elisionMeta')>('../../src/main/headroom/elisionMeta')
  return {
    ...real,
    sanitizeMeta: (raw: unknown): ReturnType<typeof real.sanitizeMeta> => {
      if (state.throwOnSanitize) throw new Error('reading the metadata blew up')
      return real.sanitizeMeta(raw)
    },
  }
})

const meta = { kind: 'compact' as const, tool: 'Read', chars: 6000, view: 1100, model: 'claude-x', policy: 'legacy' as const }
const TOKEN = 'hr_00000000000000a1'
let dir: string

beforeEach(() => {
  state.throwOnRecord = false
  state.throwOnSanitize = false
  state.recorded = []
  dir = mkdtempSync(join(tmpdir(), 'tp-ccr-book-'))
  vi.resetModules()
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('ccrPut keeps the promise when its bookkeeping fails', () => {
  it('stores the value and resolves the token when the elision ledger throws', async () => {
    const { ccrPut, ccrRetrieve, resetCcr, setCcrDir } = await import('../../src/main/headroom/ccrStore')
    resetCcr(); setCcrDir(dir)
    state.throwOnRecord = true
    expect(() => ccrPut(TOKEN, 'the original text', 'proxy', meta)).not.toThrow()
    expect(ccrRetrieve(TOKEN)).toBe('the original text')
  })

  it('stores the value and resolves the token when reading the metadata throws, for a new token and for a stored one', async () => {
    const { ccrPut, ccrRetrieve, resetCcr, setCcrDir } = await import('../../src/main/headroom/ccrStore')
    resetCcr(); setCcrDir(dir)
    state.throwOnSanitize = true
    expect(() => ccrPut(TOKEN, 'the original text', 'proxy', meta)).not.toThrow()
    expect(ccrRetrieve(TOKEN)).toBe('the original text')
    expect(() => ccrPut(TOKEN, 'the original text', 'proxy', meta)).not.toThrow() // and again, now already stored
    expect(ccrRetrieve(TOKEN)).toBe('the original text')
    expect(state.recorded).toEqual([]) // nothing was counted: the metadata could not be read
  })

  it('writes the file too, so the token survives a restart even though the count was lost', async () => {
    const a = await import('../../src/main/headroom/ccrStore')
    a.resetCcr(); a.setCcrDir(dir)
    state.throwOnRecord = true
    a.ccrPut(TOKEN, 'the original text', 'proxy', meta)
    vi.resetModules()
    state.throwOnRecord = false
    const b = await import('../../src/main/headroom/ccrStore')
    b.resetCcr(); b.setCcrDir(dir)
    expect(b.ccrRetrieve(TOKEN)).toBe('the original text')
  })

  it('records the elision once, after the value is stored, when nothing is wrong', async () => {
    const { ccrPut, resetCcr, setCcrDir, ccrRetrieve } = await import('../../src/main/headroom/ccrStore')
    resetCcr(); setCcrDir(dir)
    ccrPut(TOKEN, 'x', 'proxy', meta)
    ccrPut(TOKEN, 'x', 'proxy', meta)
    ccrPut(TOKEN, 'x', 'proxy', meta)
    expect(state.recorded).toEqual([TOKEN])
    expect(ccrRetrieve(TOKEN)).toBe('x')
  })

  it('a faulty ledger does not stop the next token from being counted once it recovers', async () => {
    const { ccrPut, resetCcr, setCcrDir } = await import('../../src/main/headroom/ccrStore')
    resetCcr(); setCcrDir(dir)
    state.throwOnRecord = true
    ccrPut(TOKEN, 'a', 'proxy', meta)
    state.throwOnRecord = false
    ccrPut('hr_00000000000000a2', 'b', 'proxy', meta)
    expect(state.recorded).toEqual(['hr_00000000000000a2'])
  })
})

describe('a stash that outlives a launch is still counted in its class when it is asked for', () => {
  it('carries the class forward when the proxy sends the same content again after a restart', async () => {
    // Launch 1: the token is elided and stored.
    const a = await import('../../src/main/headroom/ccrStore')
    a.resetCcr(); a.setCcrDir(dir)
    a.ccrPut(TOKEN, 'the original text', 'proxy', meta)
    expect(a.ccrRetrieveRecord(TOKEN)?.meta).toMatchObject({ kind: 'compact', tool: 'Read' })
    // Launch 2: nothing in memory, the file on disk. The proxy re-sends the identical body, and with it
    // the identical metadata, before the model asks.
    vi.resetModules()
    const b = await import('../../src/main/headroom/ccrStore')
    b.resetCcr(); b.setCcrDir(dir)
    state.recorded = []
    b.ccrPut(TOKEN, 'the original text', 'proxy', meta)
    // Not an elision now: it was stored by the earlier launch.
    expect(state.recorded).toEqual([])
    // But the record in memory knows its class, so a redemption lands in it and not in "legacy".
    expect(b.ccrRetrieveRecord(TOKEN)?.meta).toMatchObject({ kind: 'compact', tool: 'Read', chars: 6000, view: 1100 })
  })

  it('counts the redemption in the class, end to end through retrieveFull', async () => {
    const a = await import('../../src/main/headroom/ccrStore')
    a.resetCcr(); a.setCcrDir(dir)
    a.ccrPut(TOKEN, 'the original text '.repeat(200), 'proxy', meta)
    vi.resetModules()
    const store = await import('../../src/main/headroom/ccrStore')
    store.resetCcr(); store.setCcrDir(dir)
    const ledger = await import('../../src/main/headroom/elisionLedger')
    ledger.resetElisionLedger()
    store.ccrPut(TOKEN, 'the original text '.repeat(200), 'proxy', meta)
    const { retrieveFull } = await import('../../src/main/headroom/compressToolResult')
    const r = retrieveFull(TOKEN)
    expect(r).toBeDefined()
    const s = ledger.elisionState()
    expect(s.legacyRedeemed).toBe(0)
    expect(s.classes['compact|Read|4-10k']).toMatchObject({ redeemed: 1 })
  })

  it('does not invent a class for content the earlier launch stored with none', async () => {
    const a = await import('../../src/main/headroom/ccrStore')
    a.resetCcr(); a.setCcrDir(dir)
    a.ccrPut(TOKEN, 'old stash', 'proxy') // from before the ledger: no metadata
    vi.resetModules()
    const b = await import('../../src/main/headroom/ccrStore')
    b.resetCcr(); b.setCcrDir(dir)
    b.ccrPut(TOKEN, 'old stash', 'proxy')
    expect(b.ccrRetrieveRecord(TOKEN)?.meta).toBeUndefined()
  })

  it('keeps the class a resident token was first stored with, whatever a later put says', async () => {
    const { ccrPut, ccrRetrieveRecord, resetCcr, setCcrDir } = await import('../../src/main/headroom/ccrStore')
    resetCcr(); setCcrDir(dir)
    ccrPut(TOKEN, 'x', 'proxy', meta)
    ccrPut(TOKEN, 'x', 'proxy', { ...meta, tool: 'Bash', chars: 90_000 })
    expect(ccrRetrieveRecord(TOKEN)?.meta).toMatchObject({ tool: 'Read', chars: 6000 })
  })
})
