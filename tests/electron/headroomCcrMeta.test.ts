import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ccrPut, ccrStash, ccrRetrieveRecord, setCcrDir, resetCcr } from '../../src/main/headroom/ccrStore'
import { retrieveFull } from '../../src/main/headroom/compressToolResult'
import { elisionState, recentByClass, resetElisionLedger } from '../../src/main/headroom/elisionLedger'
import { resetProxyLedger, summarizeProxySavings } from '../../src/main/headroomProxy/proxyLedger'
import { resetLedger, summarizeSavings } from '../../src/main/headroom/savingsLedger'
import type { ElisionMeta } from '../../src/main/headroom/elisionMeta'

/**
 * R1 criterion 3: a stash carries what the proxy knew when it elided, the elision ledger counts
 * each token once when it is first stored and once when it is first redeemed, and an unknown token
 * or a stash written before any of this existed neither breaks nor distorts the count.
 */

const meta = (over: Partial<ElisionMeta> = {}): ElisionMeta => ({ kind: 'compact', tool: 'Read', chars: 5000, view: 1100, model: 'claude-x', ...over })
const tok = (n: number): string => 'hr_' + n.toString(16).padStart(16, '0')
const KEY = 'compact|Read|4-10k'

let dir: string
beforeEach(() => {
  resetCcr(); resetElisionLedger(); resetProxyLedger(); resetLedger()
  dir = mkdtempSync(join(tmpdir(), 'tp-r1-ccr-'))
})
afterEach(() => { resetCcr(); rmSync(dir, { recursive: true, force: true }) })

describe('stash metadata', () => {
  it('returns the meta it was stored with', () => {
    ccrPut(tok(1), 'the original', 'proxy', meta())
    expect(ccrRetrieveRecord(tok(1))).toEqual({ value: 'the original', origin: 'proxy', meta: meta() })
  })

  it('writes the meta into the stash file and reads it back after a restart', () => {
    setCcrDir(dir)
    ccrPut(tok(1), 'the original', 'proxy', meta())
    expect(JSON.parse(readFileSync(join(dir, `${tok(1)}.json`), 'utf8')).meta).toEqual(meta())
    resetCcr(); setCcrDir(dir) // a new process: nothing in memory, the directory is all there is
    expect(ccrRetrieveRecord(tok(1))?.meta).toEqual(meta())
  })

  it('keeps the meta of the elision that first stored a token when it is stored again', () => {
    ccrPut(tok(1), 'x', 'proxy', meta({ kind: 'compact' }))
    ccrPut(tok(1), 'x', 'proxy', meta({ kind: 'decay', view: 140 }))
    expect(ccrRetrieveRecord(tok(1))?.meta?.kind).toBe('compact')
  })

  it('replaces the value of a caller-supplied token that is not a content hash, keeping the first meta', () => {
    // headroomCcrDisk pins the value half of this: only a sha1 token proves what its file holds.
    setCcrDir(dir)
    ccrPut('hr_manual', { v: 1 }, 'proxy', meta())
    ccrPut('hr_manual', { v: 2 }, 'proxy', meta({ kind: 'decay' }))
    expect(ccrRetrieveRecord('hr_manual')).toEqual({ value: { v: 2 }, origin: 'proxy', meta: meta() })
    expect(elisionState().classes[KEY].elided).toBe(1)
  })

  it('counts nothing and records no meta for a non-hash token that is only on disk', () => {
    setCcrDir(dir)
    ccrPut('hr_manual', { v: 1 }, 'proxy', meta())
    resetCcr(); setCcrDir(dir) // a new process: on disk, not resident
    ccrPut('hr_manual', { v: 2 }, 'proxy', meta())
    expect(elisionState().classes[KEY].elided).toBe(1)
    expect('meta' in (ccrRetrieveRecord('hr_manual') as object)).toBe(false) // its first meta is on disk and unread
  })

  it('does not read or rewrite the file of a hash token that is already on disk', () => {
    setCcrDir(dir)
    ccrPut(tok(1), 'x', 'proxy', meta())
    const f = join(dir, `${tok(1)}.json`)
    resetCcr(); setCcrDir(dir)
    writeFileSync(f, JSON.stringify({ value: 'SENTINEL', origin: 'proxy', meta: meta() }), 'utf8')
    ccrPut(tok(1), 'x', 'proxy', meta({ kind: 'decay' }))
    expect(JSON.parse(readFileSync(f, 'utf8')).value).toBe('SENTINEL')
    expect(ccrRetrieveRecord(tok(1))?.meta?.kind).toBe('compact')
  })

  it('a record with no meta stays meta-less: the MCP layer and old callers never had one', () => {
    ccrPut(tok(1), 'x', 'proxy')
    const mcp = ccrStash({ big: 'y' })
    expect(ccrRetrieveRecord(tok(1))).toEqual({ value: 'x', origin: 'proxy' })
    expect('meta' in (ccrRetrieveRecord(mcp) as object)).toBe(false)
  })

  it('resolves a stash file written before metadata existed', () => {
    writeFileSync(join(dir, `${tok(7)}.json`), JSON.stringify({ value: 'old text', origin: 'proxy' }), 'utf8')
    setCcrDir(dir)
    const rec = ccrRetrieveRecord(tok(7))
    expect(rec?.value).toBe('old text')
    expect(rec?.origin).toBe('proxy')
    expect('meta' in (rec as object)).toBe(false)
  })

  it('reads a damaged meta in a stash file as no meta, and still returns the value', () => {
    for (const bad of [{ kind: 'bogus', chars: 1, view: 1 }, 'text', 5, null, [], { kind: 'compact' }]) {
      resetCcr()
      writeFileSync(join(dir, `${tok(8)}.json`), JSON.stringify({ value: 'kept', origin: 'proxy', meta: bad }), 'utf8')
      setCcrDir(dir)
      const rec = ccrRetrieveRecord(tok(8))
      expect(rec?.value).toBe('kept')
      expect('meta' in (rec as object)).toBe(false)
    }
  })
})

describe('elided counts once per token', () => {
  it('100 re-puts of one token count one elision, in memory', () => {
    for (let i = 0; i < 100; i++) ccrPut(tok(1), 'x', 'proxy', meta())
    expect(elisionState().classes[KEY].elided).toBe(1)
  })

  it('100 re-puts of one token count one elision, on disk', () => {
    setCcrDir(dir)
    for (let i = 0; i < 100; i++) ccrPut(tok(1), 'x', 'proxy', meta())
    expect(elisionState().classes[KEY].elided).toBe(1)
  })

  it('a token that comes back after a restart is not elided again: its stash is on disk already', () => {
    setCcrDir(dir)
    ccrPut(tok(1), 'x', 'proxy', meta())
    resetCcr(); setCcrDir(dir)
    ccrPut(tok(1), 'x', 'proxy', meta()) // a resumed session sends the same history again
    expect(elisionState().classes[KEY].elided).toBe(1)
    expect(ccrRetrieveRecord(tok(1))?.meta).toEqual(meta()) // and it is still classified
  })

  it('a token whose stash the disk cap aged out is a new elision when it comes back', () => {
    ccrPut(tok(1), 'x', 'proxy', meta())
    resetCcr() // gone from memory, never on disk
    ccrPut(tok(1), 'x', 'proxy', meta())
    expect(elisionState().classes[KEY].elided).toBe(2)
  })

  it('counts distinct tokens separately, each in its own class', () => {
    ccrPut(tok(1), 'a', 'proxy', meta())
    ccrPut(tok(2), 'b', 'proxy', meta({ tool: 'Bash', chars: 2000 }))
    ccrPut(tok(3), 'c', 'proxy', meta({ kind: 'decay', tool: 'Bash', chars: 700, view: 140 }))
    expect(Object.keys(elisionState().classes).sort()).toEqual(['compact|Bash|1.6-4k', KEY, 'decay|Bash|<1.6k'].sort())
  })

  it('counts nothing for a put with no meta or an MCP-layer stash', () => {
    ccrPut(tok(1), 'x', 'proxy')
    ccrStash({ big: 'y' })
    expect(elisionState().classes).toEqual({})
    expect(recentByClass().size).toBe(0)
  })
})

describe('redeemed counts once per token', () => {
  it('two retrieve_full calls for one token count one redemption', async () => {
    ccrPut(tok(1), 'the original', 'proxy', meta())
    expect(await retrieveFull(tok(1))).toBe('the original')
    expect(await retrieveFull(tok(1))).toBe('the original')
    expect(elisionState().classes[KEY].redeemed).toBe(1)
    expect(summarizeProxySavings().session.retrieves).toBe(1)
  })

  it('counts the redemption in the class the stash recorded, and in the recent window', async () => {
    ccrPut(tok(1), 'a', 'proxy', meta())
    ccrPut(tok(2), 'b', 'proxy', meta({ tool: 'Bash', chars: 2000 }))
    await retrieveFull(tok(1))
    expect(elisionState().classes[KEY]).toMatchObject({ elided: 1, redeemed: 1 })
    expect(elisionState().classes['compact|Bash|1.6-4k']).toMatchObject({ elided: 1, redeemed: 0 })
    expect(recentByClass().get(KEY)).toMatchObject({ elided: 1, redeemed: 1 })
  })

  it('counts nothing for a token it has no record of, or one that is not a token at all', async () => {
    expect(await retrieveFull('hr_0123456789abcdef')).toMatchObject({ error: 'expired' })
    expect(await retrieveFull('hr_madeUpByTheModel')).toMatchObject({ error: 'expired' })
    expect(elisionState()).toEqual({ classes: {}, legacyRedeemed: 0 })
    expect(summarizeProxySavings().session.retrieves).toBe(0)
  })

  it('counts a redemption of a stash written before metadata existed, apart from every class', async () => {
    writeFileSync(join(dir, `${tok(7)}.json`), JSON.stringify({ value: 'old text', origin: 'proxy' }), 'utf8')
    setCcrDir(dir)
    expect(await retrieveFull(tok(7))).toBe('old text')
    expect(elisionState()).toEqual({ classes: {}, legacyRedeemed: 1 })
    expect(summarizeProxySavings().session.retrieves).toBe(1)
  })

  it('leaves the elision ledger alone for an MCP-layer token, which is charged to the tool ledger', async () => {
    const t = ccrStash({ big: 'y'.repeat(1000) })
    await retrieveFull(t)
    expect(elisionState()).toEqual({ classes: {}, legacyRedeemed: 0 })
    expect(summarizeSavings().session.retrieves).toBe(1)
    expect(summarizeProxySavings().session.retrieves).toBe(0)
  })

})

describe('the two ledgers cannot drift', () => {
  it('every proxy redemption is one retrieve on the proxy ledger and one redemption on the elision ledger', async () => {
    // Three classified tokens, one stash from before metadata, one MCP token, each redeemed twice.
    ccrPut(tok(1), 'a'.repeat(100), 'proxy', meta())
    ccrPut(tok(2), 'b'.repeat(100), 'proxy', meta({ tool: 'Bash', chars: 2000 }))
    ccrPut(tok(3), 'c'.repeat(100), 'proxy', meta({ kind: 'decay', tool: 'Grep', chars: 700, view: 140 }))
    ccrPut(tok(4), 'd'.repeat(100), 'proxy') // no meta, as a stash from an older version reads
    const mcp = ccrStash({ e: 'e'.repeat(100) })
    for (const t of [tok(1), tok(2), tok(3), tok(4), mcp, tok(1), tok(2), tok(3), tok(4), mcp]) await retrieveFull(t)
    const s = elisionState()
    const classified = Object.values(s.classes).reduce((n, c) => n + c.redeemed, 0)
    expect(classified).toBe(3)
    expect(s.legacyRedeemed).toBe(1)
    expect(classified + s.legacyRedeemed).toBe(summarizeProxySavings().session.retrieves)
    expect(summarizeProxySavings().session.retrieves).toBe(4)
    expect(summarizeSavings().session.retrieves).toBe(1) // the MCP token, on its own ledger
  })
})
