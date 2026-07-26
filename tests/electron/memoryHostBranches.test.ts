// memoryHost — the guards that only fire on a HOSTILE wire.
//
// Everything this file receives crossed a process boundary, so "the caller would never send that"
// is not a guarantee here: a half-migrated client posts a message without `args`, a batch arrives
// as a bare string instead of a list, an upstream `Promise.reject()` hands the catch `undefined`.
// The happy paths are covered by memoryHost.test.ts and memoryPlannerProxy.test.ts — this suite
// drives the defensive edges those two never reach, and asserts the OBSERVABLE consequence of each
// guard (what the client gets back / how many ANN queries actually ran), not merely that it ran.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { WeaveNeighbour } from '../../src/main/mnemeWeave'

// weaveNeighboursBatch's dedupe guard is observable ONLY as a call count: a Record cannot hold the
// same key twice, so the returned object is identical whether or not the second ANN query ran. Mock
// exactly that one export — `importOriginal` hands back the LIVE swarmMemory instance, so every
// other function (and all of its module state) is still the real thing this test also drives.
const { weaveNeighboursSpy } = vi.hoisted(() => ({
  weaveNeighboursSpy: vi.fn((_id: string, _k: number): WeaveNeighbour[] => []),
}))
vi.mock('../../src/main/swarmMemory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/swarmMemory')>()
  return { ...actual, weaveNeighbours: weaveNeighboursSpy }
})

import {
  handleMessage, handleCall, _resetHostForTests, serializeError,
  weaveNeighboursBatch, adoptEncryptionKeyB64,
  type HostCallMsg, type HostOkMsg, type HostErrMsg,
} from '../../src/main/memoryHost'
import { _resetForTests, _setEmbeddingsAvailable, getSyncStatus } from '../../src/main/swarmMemory'
import { setSafeStorage } from '../../src/main/secureKeyStore'

let tmp: string
const tmpDirs: string[] = []

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memhost-branch-'))
  tmpDirs.push(tmp)
  _resetForTests()
  _resetHostForTests()
  _setEmbeddingsAvailable(false) // keyword-only: no model, fast, deterministic
  setSafeStorage(null)
  // mockReset() leaves the mock returning undefined, which would make `out[id]` falsy and hide the
  // dedupe guard entirely — every test that needs it installs its own implementation.
  weaveNeighboursSpy.mockReset()
})

afterEach(() => {
  _resetHostForTests()
  _resetForTests()
  setSafeStorage(null) // handleInit installs a fail-closed keychain guard; give the registry back
  vi.restoreAllMocks()
  for (const d of tmpDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

describe('serializeError — an RPC failure must never arrive as a blank', () => {
  it('an Error with an empty message falls back to String(err), not to ""', () => {
    // `throw new RangeError()` is ordinary (index/length guards throw bare ones). The client renders
    // `error.message` verbatim, so an empty string there reads as "the call failed, no reason given"
    // — which is exactly the mystery this whole serialization exists to prevent.
    const e = serializeError(new RangeError(''))
    expect(e.message).toBe('RangeError')
    expect(e.name).toBe('RangeError')
  })

  it('an Error whose name was blanked still names itself "Error"', () => {
    // Libraries do reassign `.name`; a blanked one would render as an unlabelled failure in the
    // client's error surface. `message` must be untouched by that fallback.
    const e = new Error('boom')
    e.name = ''
    const s = serializeError(e)
    expect(s.name).toBe('Error')
    expect(s.message).toBe('boom')
  })

  it('a thrown value JSON.stringify cannot represent becomes "unknown error"', () => {
    // `await Promise.reject()` rejects with undefined, and JSON.stringify(undefined) is undefined —
    // not a string. Without the ?? the SerializedError would carry `message: undefined`, which is
    // not a valid message and would surface as "undefined" in the UI.
    expect(serializeError(undefined)).toEqual({ message: 'unknown error', name: 'Error' })
    expect(serializeError(() => 'nope')).toEqual({ message: 'unknown error', name: 'Error' })
    // and it still survives the boundary it exists for
    expect(structuredClone(serializeError(undefined))).toEqual({ message: 'unknown error', name: 'Error' })
  })
})

describe('weaveNeighboursBatch — the batch is only as trustworthy as the id list', () => {
  it('a non-list ids payload answers {} without firing a single ANN query', () => {
    weaveNeighboursSpy.mockImplementation(() => [{ id: 'n1', score: 1 }])

    expect(weaveNeighboursBatch(null as unknown as string[], 6)).toEqual({})
    expect(weaveNeighboursBatch(undefined as unknown as string[], 6)).toEqual({})
    // The string is the dangerous one: it has .slice() AND is iterable, so without the Array.isArray
    // gate a client that posted ONE id instead of a list would run an ANN query per CHARACTER and
    // answer with a map keyed by letters.
    expect(weaveNeighboursBatch('m-42' as unknown as string[], 6)).toEqual({})

    expect(weaveNeighboursSpy).not.toHaveBeenCalled()
  })

  it('ids that are not non-empty strings are skipped, never keyed into the result', () => {
    weaveNeighboursSpy.mockImplementation((id) => [{ id: `${id}-n`, score: 0.5 }])

    // Left unguarded, `out[null]` coins the literal key "null" and `out[{…}]` coins
    // "[object Object]". The caller turns this Record into a SYNC `(id) => map[id]` lookup for
    // runWeave, so a bogus key is not merely untidy — it is a neighbourhood nobody can ever read.
    const out = weaveNeighboursBatch(
      ['m-1', '', 42, null, undefined, { id: 'm-2' }] as unknown as string[],
      3,
    )

    expect(Object.keys(out)).toEqual(['m-1'])
    expect(weaveNeighboursSpy.mock.calls).toEqual([['m-1', 3]])
  })

  it('a repeated id is answered once — including when the first answer was an empty list', () => {
    // The empty-list case is the subtle half: a vector-less memory legitimately weaves to [], and []
    // is truthy, so the guard still holds. If it were written `if (out[id]?.length)` a cold id would
    // be re-queried on every repeat — the exact per-candidate round trip the batch exists to remove.
    const answers = new Map<string, WeaveNeighbour[]>([
      ['warm', [{ id: 'w2', score: 0.9 }]],
      ['cold', []],
    ])
    weaveNeighboursSpy.mockImplementation((id) => answers.get(id) ?? [])

    const out = weaveNeighboursBatch(['warm', 'cold', 'warm', 'cold', 'warm'], 4)

    expect(out).toEqual({ warm: [{ id: 'w2', score: 0.9 }], cold: [] })
    expect(weaveNeighboursSpy.mock.calls).toEqual([['warm', 4], ['cold', 4]])
  })
})

describe('adoptEncryptionKeyB64 — a missing key is a refusal, not a crash', () => {
  it('null/undefined base64 reaches the store as an EMPTY key and is rejected on its merits', async () => {
    const ready = await handleMessage({ kind: 'init', userDataPath: tmp, syncDir: null, encKeyB64: null })
    expect(ready).toMatchObject({ kind: 'ready' })

    for (const missing of [undefined, null]) {
      let caught: unknown
      try { adoptEncryptionKeyB64(missing as unknown as string) } catch (e) { caught = e }
      // Buffer.from(undefined, 'base64') is a hard TypeError (ERR_INVALID_ARG_TYPE). The `?? ''`
      // turns a key-less message into an empty key so the store's own 32-byte validation answers
      // instead — the client can distinguish "no key was sent" from "the child is broken".
      expect(caught).toBeInstanceOf(Error)
      expect((caught as Error).name).toBe('Error')
      expect((caught as Error).message).toMatch(/32-byte/)
    }
    // And nothing was half-applied: the store is still writing plaintext at rest.
    expect(getSyncStatus().encrypted).toBe(false)
  })
})

describe('handleCall — a message that lost its args', () => {
  it('dispatches with zero args rather than spreading a non-array', async () => {
    const ready = await handleMessage({ kind: 'init', userDataPath: tmp, syncDir: null, encKeyB64: null })
    expect(ready).toMatchObject({ kind: 'ready' })

    // `args` absent entirely — an older or half-migrated client. `...undefined` is a TypeError, so
    // without the Array.isArray fallback every such call would come back as a mystery failure that
    // the client reads as "the memory store is empty" — the failure mode this design exists to stop.
    const listed = await handleCall({ kind: 'call', id: 7, fn: 'memoryList' } as unknown as HostCallMsg)
    expect(listed).toMatchObject({ kind: 'result', id: 7, ok: true })
    expect((listed as HostOkMsg).result).toEqual([]) // memoryList()'s own `opts = {}` default applied

    // args: null — same fallback, and now the HANDLER gets to reject it on its own terms instead of
    // the dispatcher blowing up first with "null is not iterable".
    const written = await handleCall({ kind: 'call', id: 8, fn: 'memoryWrite', args: null } as unknown as HostCallMsg)
    expect(written).toMatchObject({ kind: 'result', id: 8, ok: false })
    expect((written as HostErrMsg).error.message).toMatch(/content required/)
  })
})
