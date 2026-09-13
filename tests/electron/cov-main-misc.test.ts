// memoryHost — memoryKnownHashes (the batched dedup probe) and the clamping on consolidationSimMatrix.
//
// memoryKnownHashes is the one composite handler with CORRECTNESS, not merely latency, riding on it:
// hasHash is consumed as a SYNC predicate inside conversationIngest/codeIngest (`if (deps.hasHash(h))`)
// and a Promise is always truthy — so a per-chunk async proxy would report every chunk as
// already-stored and ingestion would silently write NOTHING, forever. The batch is what lets the
// client keep that predicate synchronous, and every case below is about the batch answering exactly
// the stored subset and nothing else.
//
// A separate file rather than an append: memoryHost.test.ts drives memoryClient end-to-end as well,
// so it is shared ground.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('electron', () => ({
  app: { getPath: () => '/fake' },
  utilityProcess: { fork: () => { throw new Error('utilityProcess.fork must not be called in unit tests') } },
}))

import {
  handleMessage, handleCall, _resetHostForTests,
  memoryKnownHashes, consolidationSimMatrix, HOST_HANDLERS,
  type HostOkMsg,
} from '../../src/main/memoryHost'
import {
  _resetForTests, _setEmbeddingsAvailable,
  contentHash, memoryWrite, memoryDelete, memoryHasHash,
} from '../../src/main/swarmMemory'
import { setSafeStorage } from '../../src/main/secureKeyStore'

let tmp: string
const tmpDirs: string[] = []

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memhost-hashes-'))
  tmpDirs.push(tmp)
  _resetForTests()
  _resetHostForTests()
  _setEmbeddingsAvailable(false) // keyword-only: no model to load, fast and deterministic
  setSafeStorage(null)
})

afterEach(() => {
  _resetHostForTests()
  _resetForTests()
  setSafeStorage(null) // handleInit installs a fail-closed keychain guard; hand the registry back
  for (const d of tmpDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

async function bringUpHost(): Promise<void> {
  const ready = await handleMessage({ kind: 'init', userDataPath: tmp, syncDir: null, encKeyB64: null })
  expect(ready).toMatchObject({ kind: 'ready' })
}

/** Write a chunk and return the hash the store filed it under. memoryWrite uses
 *  `input.hash || contentHash(scrubbed)`, and with no scrubber installed the scrub is a
 *  byte-for-byte no-op — so contentHash(content) is exactly the stored key. */
async function store(content: string): Promise<string> {
  await memoryWrite({ agentId: 'a', kind: 'fact', content })
  return contentHash(content)
}

describe('memoryKnownHashes — the batched dedup probe', () => {
  it('answers exactly the stored subset, in the order the caller asked', async () => {
    await bringUpHost()
    const a = await store('chunk A — the parser rewrite')
    const b = await store('chunk B — the deploy pipeline')
    const c = await store('chunk C — telemetry opt-in')
    const missing = contentHash('chunk D — never written')

    // The caller rebuilds a Set from this and answers hasHash() synchronously, so the answer has to
    // be the subset and nothing more: an extra id would make ingestion skip a chunk it never stored.
    expect(memoryKnownHashes([a, missing, b, c])).toEqual([a, b, c])
    expect(memoryKnownHashes([missing])).toEqual([])
    expect(memoryKnownHashes([])).toEqual([])
    expect(Array.isArray(memoryKnownHashes([a]))).toBe(true) // a thenable here is the silent-no-write bug
  })

  it('a non-list payload answers [] instead of probing every CHARACTER of a string', async () => {
    await bringUpHost()
    const a = await store('chunk A — the parser rewrite')

    // The bare string is the dangerous shape: it has .slice() AND is iterable, so without the
    // Array.isArray gate a client that posted ONE hash instead of a list would run a lookup per
    // character and answer with a list of letters.
    expect(memoryKnownHashes(a as unknown as string[])).toEqual([])
    expect(memoryKnownHashes(null as unknown as string[])).toEqual([])
    expect(memoryKnownHashes(undefined as unknown as string[])).toEqual([])
    // An array-LIKE is not an array: it has .length and indices but no .slice, so it would throw.
    expect(memoryKnownHashes({ 0: a, length: 1 } as unknown as string[])).toEqual([])
  })

  it('skips entries that are not non-empty strings rather than reporting them as stored', async () => {
    await bringUpHost()
    const a = await store('chunk A — the parser rewrite')

    const out = memoryKnownHashes([a, '', 0, null, undefined, {}, [], true] as unknown as string[])
    expect(out).toEqual([a])
  })

  it('a DELETED chunk stays known — a tombstoned hash must not be re-ingested', async () => {
    await bringUpHost()
    const content = 'chunk that is about to be deleted'
    const entry = await memoryWrite({ agentId: 'a', kind: 'fact', content })
    const h = contentHash(content)
    expect(memoryKnownHashes([h])).toEqual([h])

    memoryDelete(entry.id)

    // The batch inherits memoryHasHash's anti-thrash contract: a content-hash tombstone still counts
    // as "already accounted for", so the auto-indexer does not resurrect what was just deleted —
    // which would flap the shard forever, one re-ingest and one re-delete per pass.
    expect(memoryKnownHashes([h])).toEqual([h])
  })

  it('caps the batch at 5,000 hashes so a runaway list cannot be probed without bound', async () => {
    await bringUpHost()
    const first = await store('the first chunk')
    const beyondTheCap = await store('the chunk sitting past the cap')

    const padding = Array.from({ length: 4_999 }, (_, i) => `not-a-stored-hash-${i}`)
    const out = memoryKnownHashes([first, ...padding, beyondTheCap]) // 5,001 entries

    expect(out).toEqual([first]) // index 5,000 was never looked at
    // ...and it really is stored — the CAP dropped it, not the store. Without that distinction this
    // assertion would pass for the wrong reason.
    expect(memoryHasHash(beyondTheCap)).toBe(true)
  })

  it('is reachable over the wire through the explicit whitelist, not a dynamic lookup', async () => {
    await bringUpHost()
    const a = await store('chunk A — the parser rewrite')

    const res = await handleCall({ kind: 'call', id: 11, fn: 'memoryKnownHashes', args: [[a, 'nope']] })
    expect(res).toMatchObject({ kind: 'result', id: 11, ok: true })
    expect((res as HostOkMsg).result).toEqual([a])

    // The map is the contract: reached via `swarmMemory[msg.fn]` this name would not resolve at all,
    // because memoryKnownHashes is a composite that exists only in the host.
    expect(HOST_HANDLERS.memoryKnownHashes).toBe(memoryKnownHashes)
  })
})

describe('consolidationSimMatrix — the limit arrives over the wire, so it is clamped', () => {
  async function seed(): Promise<void> {
    await bringUpHost()
    for (const c of ['alpha note about caching', 'bravo note about parsing', 'charlie note about deploys']) {
      await memoryWrite({ agentId: 'a', kind: 'fact', content: c })
    }
  }

  it('a NaN / negative / non-numeric limit behaves exactly like 0, never like "everything"', async () => {
    await seed()
    const zero = consolidationSimMatrix(0)

    // `Math.max(0, Math.min(Math.floor(limit) || 0, MAX_SIM_CANDIDATES))`. The `|| 0` is what stops a
    // malformed message's NaN from reaching `new Array(n * n)` — where NaN would allocate 0 rows and
    // the loops would silently compute nothing while still claiming a matrix.
    for (const bad of [NaN, -5, -1e9, undefined, null, 'twenty', {}]) {
      expect(consolidationSimMatrix(bad as unknown as number)).toEqual(zero)
    }
  })

  it('an absurd limit is clamped to the payload bound rather than shipping n² floats', async () => {
    await seed()
    // The payload is n² floats, so an unclamped limit is a memory bomb on the IPC channel, not just
    // a slow call. Anything at or above the bound must answer identically.
    expect(consolidationSimMatrix(1e9)).toEqual(consolidationSimMatrix(1000))
  })

  it('a fractional limit floors, and the matrix stays square and symmetric', async () => {
    await seed()
    const m = consolidationSimMatrix(2.9)
    expect(m.ids.length).toBeLessThanOrEqual(2)
    expect(m.sim.length).toBe(m.ids.length * m.ids.length)
    for (let i = 0; i < m.ids.length; i++) {
      for (let j = 0; j < m.ids.length; j++) {
        expect(m.sim[i * m.ids.length + j]).toBe(m.sim[j * m.ids.length + i]) // cosine is symmetric
      }
    }
    expect(structuredClone(m)).toEqual(m) // it has to survive the boundary it exists to cross
  })
})
