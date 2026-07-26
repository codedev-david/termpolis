// memoryClient — the defensive edges of the RPC proxy.
//
// memoryHost.test.ts drives the happy orchestration (spawn, correlate, crash, respawn, fall back)
// through a fake transport that runs the REAL host dispatcher. This file is its pathological twin:
// every test here feeds the client something a well-behaved child would never send — a failure with
// no error payload, a reply to a call that no longer exists, an exit event that arrives twice, a
// truncated similarity matrix, a half-written key cache — and asserts the client stays honest.
//
// The bar throughout is the one the module was written to: a memory store must never answer a
// question it cannot answer. Silence, `undefined`, and "you have no memories" are all the same lie.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// memoryClient statically imports `utilityProcess` (the real transport is ESM — no require()), so the
// mock must provide it. It is never CALLED here: every test injects a transport instead.
vi.mock('electron', () => ({
  app: { getPath: () => '/fake' },
  utilityProcess: { fork: () => { throw new Error('utilityProcess.fork must not be called in unit tests') } },
}))

import {
  setSafeStorage, readSecret, writeSecret, type SafeStorageLike,
} from '../../src/main/secureKeyStore'
import type { HostRequest, HostResponse } from '../../src/main/memoryHost'
import {
  startMemoryHost, setMemoryHostSpawner, _resetMemoryClientForTests, memoryHostMode, memoryHostPid,
  provisionMemoryKey, memoryWrite, memoryCount, memoryList, getSyncStatus, enableLocalEncryption,
  consolidationSimOf,
  type MemoryHostTransport,
} from '../../src/main/memoryClient'
import {
  initSwarmMemory, memoryWrite as inprocWrite, memoryList as inprocList,
  _resetForTests, _setEmbeddingsAvailable, KEY_CACHE_FILE,
} from '../../src/main/swarmMemory'

type HostCall = Extract<HostRequest, { kind: 'call' }>

// A fake OS keychain, exactly as encryptionAtRest.test.ts (and memoryHost.test.ts) model it.
const fakeSafe: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from('SAFE:' + s, 'utf8'),
  decryptString: (b: Buffer) => b.toString('utf8').slice(5),
}

interface ManualHost {
  transport: MemoryHostTransport
  posted: HostRequest[]
  /** Push ANY payload at main — including things a real child could never send. */
  push: (msg: unknown) => void
  /** Fire the exit callback, as many times as we like: utilityProcess is an EventEmitter. */
  exit: (code?: number) => void
}

/**
 * A transport whose every reply is scripted by the test.
 *
 * memoryHost.test.ts deliberately runs the real dispatcher behind its fake; that is the right tool
 * for "does the round trip work". It is the wrong tool here, because a correct host never produces
 * the messages these tests are about. This one answers only what it is told to.
 */
function makeManualHost(opts: {
  onInit?: 'ready' | 'exit' | 'silent'
  answer?: (call: HostCall) => HostResponse | null
} = {}): ManualHost {
  const posted: HostRequest[] = []
  let msgCb: ((m: HostResponse) => void) | null = null
  let exitCb: ((code: number) => void) | null = null

  const transport: MemoryHostTransport = {
    postMessage: (msg: HostRequest) => {
      posted.push(msg)
      if (msg.kind === 'init') {
        const how = opts.onInit ?? 'ready'
        if (how === 'ready') queueMicrotask(() => msgCb?.({ kind: 'ready', pid: 7777, entries: 0 }))
        else if (how === 'exit') queueMicrotask(() => exitCb?.(9))
        return
      }
      const res = opts.answer?.(msg)
      if (res) queueMicrotask(() => msgCb?.(res))
    },
    onMessage: (cb) => { msgCb = cb },
    onExit: (cb) => { exitCb = cb },
    kill: () => { /* nothing real to kill */ },
    pid: 7777,
  }

  return {
    transport,
    posted,
    push: (m: unknown) => msgCb?.(m as HostResponse),
    exit: (code = 1) => exitCb?.(code),
  }
}

/**
 * logLoud() is silent under NODE_ENV=test, so the operator-facing announcements — the only record of
 * WHY the store quietly moved back onto the main thread — are invisible to the suite by default.
 * Stubbing the env the way a packaged app runs is what makes them assertable.
 */
function captureLoud(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  vi.stubEnv('NODE_ENV', 'production')
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(' '))
  })
  return { lines, restore: () => { spy.mockRestore(); vi.unstubAllEnvs() } }
}

const flush = (): Promise<void> => new Promise((r) => { setTimeout(r, 0) })

let tmp: string
const tmpDirs: string[] = []

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memclient-'))
  tmpDirs.push(tmp)
  _resetForTests()
  _resetMemoryClientForTests()
  _setEmbeddingsAvailable(false) // keyword-only: no model, fast, deterministic
  setSafeStorage(null)
})

afterEach(() => {
  _resetMemoryClientForTests()
  _resetForTests()
  setSafeStorage(null)
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  for (const d of tmpDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

describe('memoryClient — a failure the child could not describe', () => {
  it('rejects with the CALL NAME when the child sends no error payload at all', async () => {
    // A child that dies mid-serialize (or an older host build) can post ok:false with nothing else.
    // Resolving undefined here would surface as an empty result — the one outcome this module exists
    // to prevent — so the fallback message has to carry the fn name on its own.
    const h = makeManualHost({
      answer: (c) => ({ kind: 'result', id: c.id, ok: false } as unknown as HostResponse),
    })
    setMemoryHostSpawner(() => h.transport)
    expect(await startMemoryHost({ userDataPath: tmp })).toBe('host')

    const err = await memoryCount().then(() => null, (e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err?.message).toBe('memory host: memoryCount failed')
    expect(err?.name).toBe('Error')
  })

  it('keeps a LOCAL stack when the child sent a message but no name or stack', async () => {
    const h = makeManualHost({
      answer: (c) => ({
        kind: 'result', id: c.id, ok: false,
        error: { message: 'store is locked' },
      } as unknown as HostResponse),
    })
    setMemoryHostSpawner(() => h.transport)
    await startMemoryHost({ userDataPath: tmp })

    const err = await memoryList().then(() => null, (e: Error) => e)
    expect(err?.message).toBe('store is locked')       // the child's message wins over the fallback
    expect(err?.name).toBe('Error')                    // ...but a missing name must not become undefined
    // With no stack from the child, the Error rehydrate() built in MAIN keeps its own — an error with
    // no stack at all is an anonymous message, and "which memory call blew up?" becomes a guess.
    expect(err?.stack?.startsWith('Error: store is locked')).toBe(true)
  })
})

describe('memoryClient — noise on the channel', () => {
  it('drops malformed, duplicate and orphaned messages without wedging the client', async () => {
    let answered = 0
    const h = makeManualHost({
      answer: (c) => { answered++; return { kind: 'result', id: c.id, ok: true, result: 41 + answered } },
    })
    setMemoryHostSpawner(() => h.transport)
    await startMemoryHost({ userDataPath: tmp })

    await expect(memoryCount()).resolves.toBe(42) // id 1, answered normally

    // Every push below is delivered SYNCHRONOUSLY, so a missing guard does not merely mis-handle the
    // message — it throws out of the message callback, which in production is the child's message
    // pump. The test failing on the throw is the point.
    h.push(null)                                            // no message at all
    h.push('memory host says hi')                           // a string: truthy, but not an object
    h.push({ kind: 'ready', pid: 1, entries: 9 })            // a second handshake, long after we settled
    h.push({ kind: 'result', id: 9999, ok: true, result: 'ghost' })  // a call we never made
    h.push({ kind: 'result', id: 1, ok: true, result: 'stale' })     // a late duplicate of an id we retired

    // Still correlating: the next call gets its OWN answer, not the ghost's and not the stale one.
    await expect(memoryCount()).resolves.toBe(43)
    expect(answered).toBe(2) // the noise never reached the host as a call
  })
})

describe('memoryClient — the child dies during the handshake', () => {
  it('falls back immediately instead of waiting out the ready timeout, and says why', async () => {
    // A child that exits before it reports ready (a bad native dep, an OOM at load) would otherwise
    // sit in the 120s ready timeout — two minutes of a memory store that looks like it is "starting".
    const loud = captureLoud()
    try {
      const h = makeManualHost({ onInit: 'exit' })
      setMemoryHostSpawner(() => h.transport)
      const mode = await startMemoryHost({ userDataPath: tmp })
      expect(mode).toBe('inproc')
      expect(memoryHostPid()).toBeUndefined()
      expect(loud.lines.some((l) => l.includes('memory host exited during startup (code 9)'))).toBe(true)
    } finally {
      loud.restore()
    }

    // ...and the store really is serving from the main thread.
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'served after a stillborn child' })
    expect(inprocList().map((e) => e.content)).toContain('served after a stillborn child')
  })
})

describe('memoryClient — exits that arrive after we have given up', () => {
  it('a respawn with no spawner left degrades, and the dead child cannot resurrect host mode', async () => {
    const spawned: ManualHost[] = []
    const wire = (): void => {
      setMemoryHostSpawner(() => { const h = makeManualHost(); spawned.push(h); return h.transport })
    }
    wire()
    expect(await startMemoryHost({ userDataPath: tmp })).toBe('host')
    const first = spawned[0]

    // Shutdown ordering: the spawner is torn down while the child is still alive. Its death now has
    // nothing to respawn with, and must degrade rather than throw out of the exit handler.
    const loud = captureLoud()
    try {
      setMemoryHostSpawner(null)
      first.exit(3)
      await flush()
      expect(memoryHostMode()).toBe('inproc')
      // Name the reason: "it ended up in-process" is also what a ready-timeout looks like.
      expect(loud.lines.some((l) => l.includes('respawn failed: memory client: no spawner set'))).toBe(true)
    } finally {
      loud.restore()
    }

    // utilityProcess is an EventEmitter, and a dead child can emit exit more than once. With a working
    // spawner wired again, a stale exit would spawn a fresh host and flip us back to 'host' — serving
    // from a child nobody asked for, after we already committed to the main thread.
    wire()
    first.exit(3)
    await flush()
    expect(spawned).toHaveLength(1)
    expect(memoryHostMode()).toBe('inproc')

    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'alive after the stale exit' })
    expect(inprocList().map((e) => e.content)).toContain('alive after the stale exit')
  })

  it('a respawn failure landing AFTER teardown does not re-init a store it has no params for', async () => {
    // The teardown-vs-in-flight-respawn race. _resetMemoryClientForTests() is the only seam that
    // clears initParams, and it models the shape of the race exactly: the crash schedules a respawn,
    // the client is torn down, and the respawn's failure handler runs against a client that no longer
    // knows where the store lives. Without the guard, `initParams.encKeyB64` throws a TypeError and
    // gets logged as an in-process init failure that never actually happened.
    const loud = captureLoud()
    try {
      const h = makeManualHost()
      setMemoryHostSpawner(() => h.transport)
      await startMemoryHost({ userDataPath: tmp })

      setMemoryHostSpawner(null)   // the respawn is doomed...
      h.exit(1)                    // ...and is scheduled synchronously, here
      _resetMemoryClientForTests() // ...but teardown wins the race to the microtask queue
      await flush()

      expect(loud.lines.some((l) => l.includes('respawn failed'))).toBe(true)          // the handler DID run
      expect(loud.lines.some((l) => l.includes('in-process memory init FAILED'))).toBe(false)
    } finally {
      loud.restore()
    }
  })
})

describe('memoryClient — falling back must not drop encryption', () => {
  it('adopts a key it MINTED, so the fallback ciphertext-ifies the plaintext store', async () => {
    // Seed a genuinely plaintext store first: no keychain yet, so nothing auto-encrypts it.
    initSwarmMemory(tmp, {})
    await inprocWrite({ agentId: 'a', kind: 'fact', content: 'PLAINBEFORE the fallback' })
    const jsonl = path.join(tmp, 'swarm-memory.jsonl')
    expect(fs.readFileSync(jsonl, 'utf8')).toContain('PLAINBEFORE')

    _resetForTests()
    _setEmbeddingsAvailable(false)
    setSafeStorage(fakeSafe) // now a keychain exists, so provisionMemoryKey will mint

    expect(await startMemoryHost({ userDataPath: tmp, inProcess: true })).toBe('inproc')

    // The minted key is what makes this the one-time rewrite: main provisions, and whichever side
    // ends up owning the store does the ciphertext pass. Skipping it on the fallback path would leave
    // default-on encryption silently off for exactly the users whose child failed to start.
    expect(fs.readFileSync(jsonl, 'utf8')).not.toContain('PLAINBEFORE')
    await expect(getSyncStatus()).resolves.toMatchObject({ encrypted: true })
    expect(await memoryList()).toEqual([expect.objectContaining({ content: 'PLAINBEFORE the fallback' })])
  })

  it('hands over an EXISTING key without re-adopting it (no shard rewrite on every boot)', async () => {
    setSafeStorage(fakeSafe)
    const { key, minted } = provisionMemoryKey(tmp, null)
    expect(minted).toBe(true)
    expect(key).toHaveLength(32)

    // A previous session's encrypted store.
    initSwarmMemory(tmp, { encKey: key })
    await inprocWrite({ agentId: 'a', kind: 'fact', content: 'CIPHERED ALPHA' })
    const jsonl = path.join(tmp, 'swarm-memory.jsonl')
    expect(fs.readFileSync(jsonl, 'utf8')).not.toContain('CIPHERED ALPHA')

    _resetForTests()
    _setEmbeddingsAvailable(false)

    // Relaunch into the fallback. The key is now EXISTING, not minted — the adopt (and its 475MB
    // shard rewrite) must be skipped, but the key itself still has to reach the store or the fallback
    // reads its own ciphertext as an empty store.
    expect(await startMemoryHost({ userDataPath: tmp, inProcess: true })).toBe('inproc')
    expect((await memoryList()).map((e) => e.content)).toContain('CIPHERED ALPHA')
    await expect(getSyncStatus()).resolves.toMatchObject({ encrypted: true })
  })
})

describe('enableLocalEncryption — a half-written key cache', () => {
  it('replaces a TRUNCATED cached key instead of handing the store a short one', async () => {
    setSafeStorage(fakeSafe)
    const posted: HostCall[] = []
    const h = makeManualHost({
      answer: (c) => { posted.push(c); return { kind: 'result', id: c.id, ok: true, result: { encrypted: true } } },
    })
    setMemoryHostSpawner(() => h.transport)
    expect(await startMemoryHost({ userDataPath: tmp })).toBe('host')

    // What a crash mid-write (or a truncating sync client) leaves behind: a readable blob that is not
    // a 32-byte AES key. Adopting it would either throw in the store or, worse, key the shard with
    // something nothing can reproduce.
    const keyPath = path.join(tmp, KEY_CACHE_FILE)
    writeSecret(keyPath, Buffer.from('too short').toString('base64'))

    const status = await enableLocalEncryption()
    expect(status.encrypted).toBe(true)

    const adopt = posted.find((m) => m.fn === 'adoptEncryptionKeyB64')
    expect(adopt).toBeDefined()
    expect(Buffer.from(adopt?.args[0] as string, 'base64')).toHaveLength(32)
    // The cache is repaired on disk too, so the next launch does not repeat this.
    expect(Buffer.from(readSecret(keyPath) ?? '', 'base64')).toHaveLength(32)
  })
})

describe('consolidationSimOf — a matrix that does not match its ids', () => {
  it('scores 0 for cells the host did not send, rather than leaking undefined into the comparator', async () => {
    // The matrix crosses the wire as a flat n*n array. A host that truncated it (or an id list that
    // outgrew it) would otherwise hand `undefined` to a sort comparator, and Array.prototype.sort
    // with an undefined comparison is not "wrong order" — it is unspecified order.
    const h = makeManualHost({
      answer: (c) => c.fn === 'consolidationSimMatrix'
        ? { kind: 'result', id: c.id, ok: true, result: { ids: ['a', 'b'], sim: [1] } } // 1 cell for a 2x2
        : { kind: 'result', id: c.id, ok: true, result: null },
    })
    setMemoryHostSpawner(() => h.transport)
    await startMemoryHost({ userDataPath: tmp })

    const simOf = await consolidationSimOf(10)
    const cand = (id: string): Parameters<typeof simOf>[0] => ({ id }) as Parameters<typeof simOf>[0]

    expect(simOf(cand('a'), cand('a'))).toBe(1) // the one cell that exists
    expect(simOf(cand('b'), cand('b'))).toBe(0) // off the end of the array
    expect(simOf(cand('b'), cand('a'))).toBe(0)
    expect(simOf(cand('a'), cand('unknown-id'))).toBe(0) // not in the id map at all
    expect(Number.isFinite(simOf(cand('b'), cand('b')))).toBe(true)
  })
})

// This one rebuilds the module graph, so it runs LAST: vi.resetModules() would otherwise hand the
// tests above a different singleton than the one their static imports hold.
describe('memoryClient — whitelist drift between client and host', () => {
  it('rejects loudly for an fn the host whitelist does not contain', async () => {
    // inprocCall dispatches through the SAME HOST_HANDLERS map the child does, precisely so the two
    // sides cannot drift. If one ever does, the missing entry must reject — resolving undefined would
    // reach the UI as "0 memories", which is indistinguishable from a wiped brain.
    vi.resetModules()
    vi.doMock('../../src/main/memoryHost', async () => {
      const actual = await vi.importActual<typeof import('../../src/main/memoryHost')>('../../src/main/memoryHost')
      const drifted: Record<string, unknown> = { ...actual.HOST_HANDLERS }
      delete drifted.memoryCount
      return { ...actual, HOST_HANDLERS: drifted }
    })
    try {
      const client = await import('../../src/main/memoryClient')
      const store = await import('../../src/main/swarmMemory')
      store._setEmbeddingsAvailable(false)
      try {
        expect(await client.startMemoryHost({ userDataPath: tmp, inProcess: true })).toBe('inproc')
        await expect(client.memoryCount()).rejects.toThrow(/unknown fn "memoryCount"/)
        // A name that DID survive still works — the client is not broken, one entry is missing.
        await expect(client.memoryList()).resolves.toEqual([])
      } finally {
        client._resetMemoryClientForTests()
        store._resetForTests()
      }
    } finally {
      vi.doUnmock('../../src/main/memoryHost')
      vi.resetModules()
    }
  })
})
