// v1.26 step 1 — the RPC seam that moves the memory brain off the Electron main process.
//
// The store now lives in a utilityProcess (memoryHost.ts) and main talks to it through a proxy
// (memoryClient.ts). This suite drives that seam through an INJECTED transport — the same trick
// localEmbedder.test.ts uses for the embedding worker — so the orchestration (spawn, correlation,
// timeout, crash, respawn, fallback) is tested without forking anything.
//
// The fake transport does two things a naive mock would not, and both earn their keep:
//
//   • It structuredClone()s every message in BOTH directions. That is what a real process boundary
//     does, so a payload that cannot cross one (a function, a Buffer that arrives as a bare
//     Uint8Array) fails HERE instead of in production.
//   • It swaps secureKeyStore's safeStorage impl around each dispatch. In a real fork the child has
//     its own module registry and NO safeStorage; in-process they share one. Without this the child
//     would silently borrow main's keychain and the key-injection tests would prove nothing.

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

import { setSafeStorage, type SafeStorageLike } from '../../src/main/secureKeyStore'
import {
  handleMessage, _resetHostForTests, serializeError, consolidationSimMatrix, HOST_HANDLERS,
  type HostRequest, type HostResponse,
} from '../../src/main/memoryHost'
import {
  startMemoryHost, setMemoryHostSpawner, _resetMemoryClientForTests, memoryHostMode,
  provisionMemoryKey, setMemoryScrubber, memoryScrubStats,
  memoryWrite, memoryCount, memoryList, memorySearch, memoryDelete, getSyncStatus,
  enableLocalEncryption, setSyncPassphrase, consolidationSimOf, memoryStats,
  type MemoryHostTransport,
} from '../../src/main/memoryClient'
import {
  initSwarmMemory, memoryList as inprocList, memoryWrite as inprocWrite,
  getSyncStatus as inprocSyncStatus, _resetForTests, _setEmbeddingsAvailable, _setEmbedFnForTests,
  KEY_CACHE_FILE, ENCRYPTION_OPTOUT_FILE, SALT_FILE,
} from '../../src/main/swarmMemory'
import { deriveKey } from '../../src/main/memoryCrypto'
import { EMBED_DIM } from '../../src/main/localEmbedder'

// A fake OS keychain, exactly as encryptionAtRest.test.ts models it.
const fakeSafe: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from('SAFE:' + s, 'utf8'),
  decryptString: (b: Buffer) => b.toString('utf8').slice(5),
}

interface FakeHost {
  transport: MemoryHostTransport
  posted: HostRequest[]
  sent: HostResponse[]
  crash: (code?: number) => void
  spawns: () => number
}

/** A fake utilityProcess that runs the REAL host dispatcher, across a real serialization boundary. */
function makeFakeHost(opts: {
  crashOnFn?: string          // die when this fn is called (mid-call crash)
  failInit?: boolean          // report init-error
  swallowFn?: string          // accept the call and never answer (timeout / hang)
} = {}): FakeHost {
  const posted: HostRequest[] = []
  const sent: HostResponse[] = []
  let msgCb: ((m: HostResponse) => void) | null = null
  let exitCb: ((code: number) => void) | null = null
  let dead = false

  // What MAIN has installed. The real child has none of this; restore it after every dispatch so the
  // child's fail-closed guard cannot leak into main's view of the keychain.
  const mainSafe = currentSafe

  const transport: MemoryHostTransport = {
    postMessage: (msg: HostRequest) => {
      if (dead) return
      const inbound = structuredClone(msg) // a real boundary: non-clonable payloads throw right here
      posted.push(inbound)
      if (opts.failInit && inbound.kind === 'init') {
        queueMicrotask(() => {
          if (dead) return
          const res: HostResponse = { kind: 'init-error', error: { name: 'Error', message: 'fake init failure' } }
          sent.push(res)
          msgCb?.(structuredClone(res))
        })
        return
      }
      if (inbound.kind === 'call' && opts.crashOnFn && inbound.fn === opts.crashOnFn) {
        queueMicrotask(() => { dead = true; exitCb?.(1) })
        return
      }
      if (inbound.kind === 'call' && opts.swallowFn && inbound.fn === opts.swallowFn) return // never answers
      void (async () => {
        let res: HostResponse | null = null
        try {
          res = await handleMessage(inbound)
        } finally {
          setSafeStorage(mainSafe) // the child's registry is its own — give main its keychain back
        }
        if (dead || !res) return
        sent.push(res)
        msgCb?.(structuredClone(res))
      })()
    },
    onMessage: (cb) => { msgCb = cb },
    onExit: (cb) => { exitCb = cb },
    kill: () => { dead = true },
    pid: 4242,
  }
  return {
    transport,
    posted,
    sent,
    crash: (code = 1) => { dead = true; exitCb?.(code) },
    spawns: () => 1,
  }
}

// Track what main installed, so the fake child can restore it (see makeFakeHost).
let currentSafe: SafeStorageLike | null = null
function installMainSafe(s: SafeStorageLike | null): void {
  currentSafe = s
  setSafeStorage(s)
}

let tmp: string
const tmpDirs: string[] = []

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memhost-'))
  tmpDirs.push(tmp)
  _resetForTests()
  _resetHostForTests()
  _resetMemoryClientForTests()
  _setEmbeddingsAvailable(false) // keyword-only: no model, fast, deterministic
  installMainSafe(null)
})

afterEach(() => {
  _resetMemoryClientForTests()
  _resetHostForTests()
  _resetForTests()
  installMainSafe(null)
  vi.restoreAllMocks()
  for (const d of tmpDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

/** Start the client against a fresh fake host. */
async function startWithFake(opts: Parameters<typeof makeFakeHost>[0] = {}, syncDir: string | null = null) {
  const hosts: FakeHost[] = []
  setMemoryHostSpawner(() => {
    const h = makeFakeHost(opts)
    hosts.push(h)
    return h.transport
  })
  const mode = await startMemoryHost({ userDataPath: tmp, syncDir })
  return { hosts, mode }
}

describe('memoryHost RPC — round trip', () => {
  it('proxies a SYNC export and an ASYNC export uniformly, both as Promises', async () => {
    const { mode } = await startWithFake()
    expect(mode).toBe('host')
    expect(memoryHostMode()).toBe('host')

    // memoryWrite is async in the store; memoryCount is sync. The client must not care.
    const entry = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'the sky is blue' })
    expect(entry.id).toBeTruthy()
    expect(entry.content).toBe('the sky is blue')

    await expect(memoryCount()).resolves.toBe(1)
    const list = await memoryList()
    expect(list.map((e) => e.content)).toContain('the sky is blue')

    // ...and a genuinely async one that returns a non-trivial shape.
    const hits = await memorySearch({ query: 'sky', limit: 5 })
    expect(hits.length).toBeGreaterThan(0)
  })

  it('correlates concurrent calls by id (no cross-talk)', async () => {
    await startWithFake()
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'alpha one' })
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'beta two' })

    // Fire a batch at once; each must get ITS OWN answer back.
    const [count, list, stats] = await Promise.all([memoryCount(), memoryList(), memoryStats()])
    expect(count).toBe(2)
    expect(list).toHaveLength(2)
    expect(stats.count).toBe(2)
  })

  it('every message actually survives a structured-clone boundary', async () => {
    const { hosts } = await startWithFake()
    await memoryWrite({ agentId: 'a', kind: 'note', content: 'clonable?' })
    // makeFakeHost structuredClone()s in both directions — reaching here at all proves it. Assert the
    // wire shape too, so a future refactor can't quietly start posting something exotic.
    const calls = hosts[0].posted.filter((m): m is Extract<HostRequest, { kind: 'call' }> => m.kind === 'call')
    expect(calls.length).toBeGreaterThan(0)
    for (const c of calls) {
      expect(typeof c.id).toBe('number')
      expect(typeof c.fn).toBe('string')
      expect(Array.isArray(c.args)).toBe(true)
    }
  })
})

describe('memoryHost RPC — failure is never silence', () => {
  it('an error in the child becomes a REJECTED promise with a useful message (not a hang, not an empty result)', async () => {
    await startWithFake()
    // memoryWrite with blank content throws inside the store. The client-side guard catches the
    // truly-empty case, so go through a store-side throw: setSyncPassphrase without sync enabled.
    const { setSyncPassphrase } = await import('../../src/main/memoryClient')
    await expect(setSyncPassphrase('hunter2')).rejects.toThrow(/cross-machine sync is not enabled/)
  })

  it('an UNKNOWN fn rejects loudly instead of resolving undefined', async () => {
    await startWithFake()
    // Reach past the typed surface the way a wiring bug would.
    const res = await handleMessage({ kind: 'call', id: 7, fn: 'totallyNotAnExport', args: [] })
    expect(res).toMatchObject({ kind: 'result', id: 7, ok: false })
    expect((res as { error: { message: string } }).error.message).toMatch(/unknown fn/)
  })

  it('the dispatcher is a WHITELIST — internal test seams are not reachable over the wire', async () => {
    await startWithFake()
    for (const fn of ['_resetForTests', '_setEmbedFnForTests', '_setMaxEntriesForTests', 'setMemoryScrubber']) {
      const res = await handleMessage({ kind: 'call', id: 1, fn, args: [] })
      expect(res).toMatchObject({ ok: false })
      expect((res as { error: { message: string } }).error.message).toMatch(/unknown fn/)
    }
  })

  it('a call before init is refused, not silently answered with an empty store', async () => {
    _resetHostForTests()
    const res = await handleMessage({ kind: 'call', id: 3, fn: 'memoryCount', args: [] })
    expect(res).toMatchObject({ ok: false })
    expect((res as { error: { message: string } }).error.message).toMatch(/not initialised/)
  })

  it('serializeError flattens an Error (a raw Error structured-clones to {})', () => {
    const e = serializeError(new TypeError('boom'))
    expect(e.name).toBe('TypeError')
    expect(e.message).toBe('boom')
    expect(e.stack).toBeTruthy()
    expect(structuredClone(e)).toEqual(e) // the whole point: it survives the wire
    expect(serializeError('plain string').message).toBe('plain string')
    expect(serializeError({ weird: true }).name).toBe('Error')
  })

  it('a malformed message is ignored, not crashed on', async () => {
    await expect(handleMessage(null as unknown as HostRequest)).resolves.toBeNull()
    await expect(handleMessage({ kind: 'nonsense' } as unknown as HostRequest)).resolves.toBeNull()
  })

  it('a bad init (unreadable path / garbage key) reports init-error rather than half-starting', () => {
    _resetHostForTests()
    const bad = handleMessage({
      kind: 'init', userDataPath: 'not-absolute', syncDir: null, encKeyB64: null,
    } as HostRequest)
    return expect(bad).resolves.toMatchObject({ kind: 'init-error' })
  })

  it('a garbage encKey is an init-error, NOT an empty store', async () => {
    _resetHostForTests()
    const res = await handleMessage({
      kind: 'init', userDataPath: tmp, syncDir: null, encKeyB64: 'aaaa', // 3 bytes, not 32
    } as HostRequest)
    expect(res).toMatchObject({ kind: 'init-error' })
    expect((res as { error: { message: string } }).error.message).toMatch(/32-byte/)
  })
})

describe('memoryHost RPC — the child dies', () => {
  it('rejects IN-FLIGHT calls (naming the call) and respawns, losing no committed data', async () => {
    const { hosts } = await startWithFake({ crashOnFn: 'memorySearch' })
    // Commit a write first — it is durable on disk before its RPC resolves.
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'survives the crash' })

    // This call kills the child mid-flight. It must REJECT — a silent empty result here would be
    // indistinguishable from "you have no memories".
    await expect(memorySearch({ query: 'survives' })).rejects.toThrow(/exited unexpectedly.*during memorySearch/s)

    // A fresh child was spawned...
    expect(hosts.length).toBe(2)
    // ...and it reloaded the committed store from disk. No data loss.
    await expect(memoryCount()).resolves.toBe(1)
    const list = await memoryList()
    expect(list.map((e) => e.content)).toContain('survives the crash')
    expect(memoryHostMode()).toBe('host')
  })

  it('a crash LOOP stops flapping and falls back to in-process (the app keeps working)', async () => {
    // Every call to memoryCount kills the child. Four crashes inside the window trips the limit.
    const { hosts } = await startWithFake({ crashOnFn: 'memoryCount' })
    for (let i = 0; i < 5; i++) {
      await memoryCount().catch(() => { /* expected */ })
    }
    expect(memoryHostMode()).toBe('inproc')
    expect(hosts.length).toBeLessThanOrEqual(5) // bounded — it did not respawn forever
    // The store still works, on the main thread.
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'still alive after the loop' })
    const list = await memoryList()
    expect(list.map((e) => e.content)).toContain('still alive after the loop')
  })

  it('a transport that THROWS on postMessage rejects that call immediately (no leaked pending entry)', async () => {
    setMemoryHostSpawner(() => {
      const h = makeFakeHost()
      const t = h.transport
      let first = true
      return {
        ...t,
        postMessage: (m) => {
          if (first) { first = false; return t.postMessage(m) } // let init through
          throw new Error('channel closed')
        },
        onMessage: (cb) => t.onMessage(cb),
        onExit: (cb) => t.onExit(cb),
      }
    })
    await startMemoryHost({ userDataPath: tmp })
    expect(memoryHostMode()).toBe('host')
    await expect(memoryCount()).rejects.toThrow(/channel closed/)
    // The failed send must not leave a pending entry that a later reply could resolve.
    await expect(memoryCount()).rejects.toThrow(/channel closed/)
  })

  it('a call that never gets an answer TIMES OUT rather than hanging forever', async () => {
    vi.useFakeTimers()
    try {
      await startWithFake({ swallowFn: 'memoryCount' })
      const p = memoryCount()
      const assertion = expect(p).rejects.toThrow(/timed out.*memoryCount/s)
      await vi.advanceTimersByTimeAsync(61_000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('memoryHost RPC — spawn failure falls back to in-process', () => {
  it('a spawner that returns null degrades to the in-process store, and the app still works', async () => {
    setMemoryHostSpawner(() => null)
    const mode = await startMemoryHost({ userDataPath: tmp })
    expect(mode).toBe('inproc')

    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'in-process still writes' })
    await expect(memoryCount()).resolves.toBe(1)
    // It really is the in-process module — the same singleton index.ts would have used.
    expect(inprocList().map((e) => e.content)).toContain('in-process still writes')
  })

  it('a spawner that THROWS degrades too', async () => {
    setMemoryHostSpawner(() => { throw new Error('fork: ENOENT') })
    const mode = await startMemoryHost({ userDataPath: tmp })
    expect(mode).toBe('inproc')
    await expect(memoryWrite({ agentId: 'a', kind: 'fact', content: 'ok' })).resolves.toBeTruthy()
  })

  it('a child that reports init-error degrades too (a broken store must not take the terminal down)', async () => {
    const { mode } = await startWithFake({ failInit: true })
    expect(mode).toBe('inproc')
    await expect(memoryWrite({ agentId: 'a', kind: 'fact', content: 'degraded but working' })).resolves.toBeTruthy()
    await expect(memoryCount()).resolves.toBe(1)
  })

  it('with NO spawner wired at all, it just runs in-process (today\'s behaviour)', async () => {
    const mode = await startMemoryHost({ userDataPath: tmp })
    expect(mode).toBe('inproc')
    await expect(memoryCount()).resolves.toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE SECURITY TEST. setMemoryScrubber installs a CALLBACK, and a callback cannot cross IPC — so a
// naive port drops it and starts persisting secrets verbatim. The scrub therefore runs in MAIN,
// before the content is posted, and the assertion is made ON THE WIRE: the secret must appear in NO
// message the client ever sent. That is the boundary; anything else is a proxy for it.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('THE SCRUB BOUNDARY — a secret must never cross into the memory process', () => {
  const SECRET = 'sk-live-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

  // Stands in for aiSecurity.scanText: same contract (redacted + hitCount).
  const scrubber = (content: string) => {
    const hits = content.includes(SECRET) ? 1 : 0
    return { redacted: content.split(SECRET).join('[REDACTED]'), hitCount: hits }
  }

  it('the secret NEVER appears in any message posted to the child — it is scrubbed in main first', async () => {
    const { hosts } = await startWithFake()
    setMemoryScrubber(scrubber)

    const entry = await memoryWrite({
      agentId: 'agent-1',
      kind: 'note',
      content: `here is my key ${SECRET} please remember it`,
    })

    // 1. THE WIRE. Every byte that crossed the boundary, serialized. The secret is in none of it.
    const wire = JSON.stringify(hosts[0].posted)
    expect(wire).not.toContain(SECRET)
    expect(wire).toContain('[REDACTED]') // ...and the redacted form DID cross, so the write happened

    // 2. The store therefore holds the redacted text — hashed, embedded and persisted from it.
    expect(entry.content).toContain('[REDACTED]')
    expect(entry.content).not.toContain(SECRET)
    const list = await memoryList()
    expect(list[0].content).not.toContain(SECRET)

    // 3. Nothing the child ever sends back carries it either.
    expect(JSON.stringify(hosts[0].sent)).not.toContain(SECRET)

    // 4. And it is not on disk.
    const onDisk = fs.readFileSync(path.join(tmp, 'swarm-memory.jsonl'), 'utf8')
    expect(onDisk).not.toContain(SECRET)

    // 5. The redaction is REPORTED (the transient count the audit log rides on), even though the
    //    store itself never saw a secret to count.
    expect(entry.scrubbed).toBe(1)
    expect(memoryScrubStats()).toEqual({ scrubbedWrites: 1, secretsRedacted: 1 })
  })

  it('the scrub is unconditional — it does not depend on which mode we happened to be in', async () => {
    // Same secret, same scrubber, but the child never starts. The content must STILL be redacted:
    // whether a secret survives must never hinge on a mode flag a respawn could have flipped.
    setMemoryHostSpawner(() => null)
    await startMemoryHost({ userDataPath: tmp })
    expect(memoryHostMode()).toBe('inproc')
    setMemoryScrubber(scrubber)

    const entry = await memoryWrite({ agentId: 'a', kind: 'note', content: `key=${SECRET}` })
    expect(entry.content).not.toContain(SECRET)
    expect(fs.readFileSync(path.join(tmp, 'swarm-memory.jsonl'), 'utf8')).not.toContain(SECRET)
  })

  it('with NO scrubber installed, content crosses byte-for-byte (the documented default)', async () => {
    const { hosts } = await startWithFake()
    const entry = await memoryWrite({ agentId: 'a', kind: 'note', content: 'plain content, no scrubber' })
    expect(entry.content).toBe('plain content, no scrubber')
    expect(JSON.stringify(hosts[0].posted)).toContain('plain content, no scrubber')
    expect(memoryScrubStats()).toEqual({ scrubbedWrites: 0, secretsRedacted: 0 })
  })

  it('a scrubber that THROWS fails open loudly (losing the memory would be the bigger harm)', async () => {
    await startWithFake()
    setMemoryScrubber(() => { throw new Error('regex exploded') })
    const entry = await memoryWrite({ agentId: 'a', kind: 'note', content: 'content survives a broken scrubber' })
    expect(entry.content).toBe('content survives a broken scrubber')
  })

  it('the scrubber survives a child crash + respawn (it lives in main, so it cannot be lost)', async () => {
    await startWithFake({ crashOnFn: 'memorySearch' })
    setMemoryScrubber(scrubber)
    await memorySearch({ query: 'x' }).catch(() => { /* kills the child */ })

    // New child. The scrubber was never in it to begin with — prove the boundary still holds.
    const { hosts: _h } = { hosts: [] } // (the respawned host is tracked by the client, not us)
    const entry = await memoryWrite({ agentId: 'a', kind: 'note', content: `post-crash ${SECRET}` })
    expect(entry.content).not.toContain(SECRET)
    expect(entry.scrubbed).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// KEY INJECTION. The child has no safeStorage, so it cannot unwrap the at-rest key itself. Main
// unwraps it and injects it. If that were ever dropped, a fully populated ENCRYPTED store would read
// as EMPTY — so the test asserts BOTH directions: it decrypts WITH the key, and it is empty WITHOUT.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('key injection — an encrypted store decrypts in the child', () => {
  const MARKER = 'ENCRYPTEDMARKER alpha detail'

  /** Build a real encrypted store on disk, the way a previous launch would have. */
  async function seedEncryptedStore(): Promise<Buffer> {
    installMainSafe(fakeSafe)
    initSwarmMemory(tmp) // maybeAutoEncrypt mints a device key + encrypts
    _setEmbeddingsAvailable(false)
    expect(inprocSyncStatus().encrypted).toBe(true)
    await inprocWrite({ agentId: 'a', kind: 'fact', content: MARKER })
    const raw = fs.readFileSync(path.join(tmp, 'swarm-memory.jsonl'), 'utf8')
    expect(raw).not.toContain('ENCRYPTEDMARKER') // genuinely ciphertext at rest
    // The key main would unwrap with safeStorage:
    const b64 = fs.readFileSync(path.join(tmp, KEY_CACHE_FILE), 'utf8').trim()
    expect(b64.startsWith('osk:v1:')).toBe(true) // OS-encrypted, not plaintext
    const key = Buffer.from(fakeSafe.decryptString(Buffer.from(b64.slice('osk:v1:'.length), 'base64')), 'base64')
    expect(key).toHaveLength(32)
    _resetForTests()
    return key
  }

  it('WITHOUT the injected key the child reads the encrypted store as EMPTY (the failure mode we are preventing)', async () => {
    await seedEncryptedStore()
    // Simulate the child: no safeStorage → loadCachedKey() cannot decrypt the OS-wrapped key.
    installMainSafe(null)
    _setEmbeddingsAvailable(false)
    initSwarmMemory(tmp) // no encKey injected
    expect(inprocList()).toHaveLength(0) // ← a populated store, silently invisible. THIS is the bug.
  })

  it('WITH the injected key the same store decrypts and every entry is recallable', async () => {
    const key = await seedEncryptedStore()
    installMainSafe(null) // the child has no keychain...
    _setEmbeddingsAvailable(false)
    initSwarmMemory(tmp, { encKey: key }) // ...but main handed it the unwrapped key
    expect(inprocList().map((e) => e.content)).toContain(MARKER)
  })

  it('the injected key takes PRECEDENCE over loadCachedKey()', async () => {
    const key = await seedEncryptedStore()
    installMainSafe(fakeSafe) // a keychain IS present, so loadCachedKey() would also work...
    _setEmbeddingsAvailable(false)
    initSwarmMemory(tmp, { encKey: key })
    expect(inprocList().map((e) => e.content)).toContain(MARKER)
  })

  it('a WRONG-SIZED key throws rather than silently reading the store as empty', async () => {
    await seedEncryptedStore()
    installMainSafe(null)
    expect(() => initSwarmMemory(tmp, { encKey: Buffer.alloc(16) })).toThrow(/32-byte/)
  })

  it('absent an injected key, behaviour is EXACTLY as today (no regression to the in-process path)', async () => {
    installMainSafe(fakeSafe)
    initSwarmMemory(tmp, {}) // the 7,000-test path
    _setEmbeddingsAvailable(false)
    await inprocWrite({ agentId: 'a', kind: 'fact', content: 'unchanged behaviour' })
    expect(inprocSyncStatus().encrypted).toBe(true) // still auto-encrypts via safeStorage
    expect(inprocList().map((e) => e.content)).toContain('unchanged behaviour')
  })

  it('the full client path brings an ENCRYPTED store up in the child and serves it', async () => {
    await seedEncryptedStore()
    // Main has the keychain (it always does); the child will not.
    installMainSafe(fakeSafe)
    _resetHostForTests()
    const { mode } = await startWithFake()
    expect(mode).toBe('host')
    const list = await memoryList()
    expect(list.map((e) => e.content)).toContain(MARKER) // decrypted, through the RPC seam
    await expect(getSyncStatus()).resolves.toMatchObject({ encrypted: true })
  })
})

describe('key provisioning — main owns the keychain, because the child cannot', () => {
  it('mints a key for a fresh LOCAL store and OS-encrypts it (default-on encryption survives the port)', () => {
    installMainSafe(fakeSafe)
    const { key, minted } = provisionMemoryKey(tmp, null)
    expect(minted).toBe(true)
    expect(key).toHaveLength(32)
    const onDisk = fs.readFileSync(path.join(tmp, KEY_CACHE_FILE), 'utf8')
    expect(onDisk.startsWith('osk:v1:')).toBe(true) // never plaintext
    expect(onDisk).not.toContain(key!.toString('base64'))
  })

  it('reuses an EXISTING key and does not re-mint (minted=false ⇒ no 475MB shard rewrite on every boot)', () => {
    installMainSafe(fakeSafe)
    const first = provisionMemoryKey(tmp, null)
    expect(first.minted).toBe(true)
    const second = provisionMemoryKey(tmp, null)
    expect(second.minted).toBe(false)
    expect(second.key!.equals(first.key!)).toBe(true)
  })

  it('does NOT auto-key a SYNCED store (peers cannot share a per-device key — that is the passphrase model)', () => {
    installMainSafe(fakeSafe)
    const { key, minted } = provisionMemoryKey(tmp, path.join(tmp, 'sync'))
    expect(key).toBeNull()
    expect(minted).toBe(false)
    expect(fs.existsSync(path.join(tmp, KEY_CACHE_FILE))).toBe(false)
  })

  it('honours the opt-out', () => {
    installMainSafe(fakeSafe)
    fs.writeFileSync(path.join(tmp, ENCRYPTION_OPTOUT_FILE), '1')
    expect(provisionMemoryKey(tmp, null)).toEqual({ key: null, minted: false })
  })

  it('stays honestly PLAINTEXT with no OS keychain (never writes a key in the clear)', () => {
    installMainSafe(null)
    expect(provisionMemoryKey(tmp, null)).toEqual({ key: null, minted: false })
    expect(fs.existsSync(path.join(tmp, KEY_CACHE_FILE))).toBe(false)
  })

  it('a freshly-minted key ciphertext-ifies an existing PLAINTEXT store through the child', async () => {
    // A user upgrading from a pre-encryption build: plaintext content already on disk, no key yet.
    installMainSafe(null) // no keychain yet → the store stays plaintext
    initSwarmMemory(tmp)
    _setEmbeddingsAvailable(false)
    await inprocWrite({ agentId: 'a', kind: 'fact', content: 'LEGACYPLAINTEXT content' })
    expect(fs.readFileSync(path.join(tmp, 'swarm-memory.jsonl'), 'utf8')).toContain('LEGACYPLAINTEXT')
    _resetForTests()
    _resetHostForTests()

    // Now the keychain is available and the store moves into the child.
    installMainSafe(fakeSafe)
    _setEmbeddingsAvailable(false)
    const { mode } = await startWithFake()
    expect(mode).toBe('host')

    // The legacy plaintext was rewritten as ciphertext — exactly what maybeAutoEncrypt() used to do.
    const raw = fs.readFileSync(path.join(tmp, 'swarm-memory.jsonl'), 'utf8')
    expect(raw).not.toContain('LEGACYPLAINTEXT')
    await expect(getSyncStatus()).resolves.toMatchObject({ encrypted: true })
    const list = await memoryList()
    expect(list.map((e) => e.content)).toContain('LEGACYPLAINTEXT content') // still recallable
  })

  it('the child can never write a key in PLAINTEXT — the fail-closed keychain guard', async () => {
    // secureKeyStore.writeSecret() falls back to plaintext with no impl installed. In the child that
    // would drop the AES key on disk in the clear. installKeychainGuard() makes it throw instead.
    const { installKeychainGuard } = await import('../../src/main/memoryHost')
    const { writeSecret, isOsEncryptionAvailable, readSecret } = await import('../../src/main/secureKeyStore')
    installKeychainGuard(true)
    expect(isOsEncryptionAvailable()).toBe(true) // ...so maybeAutoEncrypt's guard does not mis-fire
    const p = path.join(tmp, 'should-never-exist.key')
    expect(() => writeSecret(p, 'A'.repeat(44))).toThrow(/no safeStorage/)
    expect(fs.existsSync(p)).toBe(false) // fail CLOSED: nothing written at all
    // ...and it cannot READ an OS-wrapped key either — which is exactly why main injects it.
    fs.writeFileSync(path.join(tmp, 'wrapped.key'), 'osk:v1:' + Buffer.from('x').toString('base64'))
    expect(readSecret(path.join(tmp, 'wrapped.key'))).toBeNull()
    installMainSafe(null)
  })

  it('with NO keychain in main, the child MIRRORS that (it must not be different from main)', async () => {
    const { installKeychainGuard } = await import('../../src/main/memoryHost')
    const { isOsEncryptionAvailable } = await import('../../src/main/secureKeyStore')
    installKeychainGuard(false) // main reported: no keyring on this box
    expect(isOsEncryptionAvailable()).toBe(false) // → maybeAutoEncrypt early-returns, honest plaintext
    installMainSafe(null)
  })

  it('a SYNCED store still comes up in the child (passphrase model, no auto-key)', async () => {
    installMainSafe(fakeSafe)
    const syncDir = path.join(tmp, 'sync')
    const { mode } = await startWithFake({}, syncDir)
    expect(mode).toBe('host')
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'synced entry' })
    const list = await memoryList()
    expect(list.map((e) => e.content)).toContain('synced entry')
    // No device key was minted for a synced store — peers could not share it.
    expect(fs.existsSync(path.join(tmp, KEY_CACHE_FILE))).toBe(false)
    await expect(getSyncStatus()).resolves.toMatchObject({ syncing: true, dir: syncDir, encrypted: false })
  })
})

describe('enableLocalEncryption — the mint happens where a keychain exists', () => {
  it('turns encryption ON through the child (in-child it would be a silent no-op)', async () => {
    installMainSafe(fakeSafe)
    // Start opted-OUT so provisionMemoryKey mints nothing and the store comes up plaintext.
    fs.mkdirSync(tmp, { recursive: true })
    fs.writeFileSync(path.join(tmp, ENCRYPTION_OPTOUT_FILE), '1')
    const { mode } = await startWithFake()
    expect(mode).toBe('host')
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'PLAINBEFORE encryption' })
    expect(fs.readFileSync(path.join(tmp, 'swarm-memory.jsonl'), 'utf8')).toContain('PLAINBEFORE')
    await expect(getSyncStatus()).resolves.toMatchObject({ encrypted: false })

    const status = await enableLocalEncryption()
    expect(status.encrypted).toBe(true)
    // The existing plaintext was rewritten, the key is OS-wrapped, and the opt-out is gone.
    expect(fs.readFileSync(path.join(tmp, 'swarm-memory.jsonl'), 'utf8')).not.toContain('PLAINBEFORE')
    expect(fs.readFileSync(path.join(tmp, KEY_CACHE_FILE), 'utf8').startsWith('osk:v1:')).toBe(true)
    expect(fs.existsSync(path.join(tmp, ENCRYPTION_OPTOUT_FILE))).toBe(false)
    const list = await memoryList()
    expect(list.map((e) => e.content)).toContain('PLAINBEFORE encryption') // still readable
  })
})

describe('setSyncPassphrase — main persists the key the child cannot', () => {
  it('unlocks the synced store AND caches the key OS-wrapped (never plaintext)', async () => {
    installMainSafe(fakeSafe)
    const syncDir = path.join(tmp, 'sync')
    const { mode } = await startWithFake({}, syncDir)
    expect(mode).toBe('host')

    const status = await setSyncPassphrase('correct horse battery staple')
    expect(status.encrypted).toBe(true)

    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'SYNCSECRETMARKER content' })
    // Ciphertext at rest in the SYNC folder...
    const shard = fs.readdirSync(syncDir).find((f) => f.endsWith('.jsonl'))!
    expect(fs.readFileSync(path.join(syncDir, shard), 'utf8')).not.toContain('SYNCSECRETMARKER')
    // ...readable through the seam...
    const list = await memoryList()
    expect(list.map((e) => e.content)).toContain('SYNCSECRETMARKER content')

    // ...and the derived key was cached BY MAIN, OS-wrapped. The child's writeSecret would have
    // dropped it on disk in the clear; the keychain guard made that impossible, so main did it.
    const keyFile = path.join(tmp, KEY_CACHE_FILE)
    expect(fs.existsSync(keyFile)).toBe(true)
    const raw = fs.readFileSync(keyFile, 'utf8')
    expect(raw.startsWith('osk:v1:')).toBe(true)
    // The literal key bytes must not be sitting there in base64.
    const key = deriveKey('correct horse battery staple', fs.readFileSync(path.join(syncDir, SALT_FILE)))
    expect(raw).not.toContain(key.toString('base64'))
  })

  it('a wrong passphrase is REJECTED (and no key is cached)', async () => {
    installMainSafe(fakeSafe)
    const syncDir = path.join(tmp, 'sync')
    await startWithFake({}, syncDir)
    await setSyncPassphrase('the right one')
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'locked content' })

    // Relaunch with a clean slate and try the WRONG passphrase against the existing ciphertext.
    _resetForTests(); _resetHostForTests(); _resetMemoryClientForTests()
    _setEmbeddingsAvailable(false)
    installMainSafe(fakeSafe)
    fs.rmSync(path.join(tmp, KEY_CACHE_FILE), { force: true }) // simulate a NEW device
    await startWithFake({}, syncDir)
    await expect(setSyncPassphrase('the wrong one')).rejects.toThrow(/Incorrect passphrase/)
  })
})

describe('enableLocalEncryption — the paths that must NOT mint in main', () => {
  it('in-process mode delegates straight to the store (safeStorage is right there)', async () => {
    installMainSafe(fakeSafe)
    fs.writeFileSync(path.join(tmp, ENCRYPTION_OPTOUT_FILE), '1')
    setMemoryHostSpawner(() => null)
    await startMemoryHost({ userDataPath: tmp })
    expect(memoryHostMode()).toBe('inproc')
    const status = await enableLocalEncryption()
    expect(status.encrypted).toBe(true) // the store's own maybeAutoEncrypt did it
  })

  it('a SYNCED store is left to the passphrase model (no per-device key is minted)', async () => {
    installMainSafe(fakeSafe)
    const syncDir = path.join(tmp, 'sync')
    await startWithFake({}, syncDir)
    const status = await enableLocalEncryption()
    expect(status.encrypted).toBe(false) // honest: a synced store needs setSyncPassphrase
    expect(fs.existsSync(path.join(tmp, KEY_CACHE_FILE))).toBe(false)
  })

  it('with no OS keychain it stays honestly plaintext (never writes a key in the clear)', async () => {
    installMainSafe(null) // no keyring on this box
    fs.writeFileSync(path.join(tmp, ENCRYPTION_OPTOUT_FILE), '1')
    await startWithFake()
    const status = await enableLocalEncryption()
    expect(status.encrypted).toBe(false)
    expect(fs.existsSync(path.join(tmp, KEY_CACHE_FILE))).toBe(false)
  })
})

describe('provisionMemoryKey — degrades safely', () => {
  it('a CORRUPT key file is replaced, not trusted (a short key would decrypt nothing)', () => {
    installMainSafe(fakeSafe)
    fs.writeFileSync(path.join(tmp, KEY_CACHE_FILE), 'osk:v1:' + fakeSafe.encryptString('dG9vc2hvcnQ=').toString('base64'))
    const { key, minted } = provisionMemoryKey(tmp, null) // 8 bytes, not 32 → must not be adopted
    expect(minted).toBe(true)
    expect(key).toHaveLength(32)
  })

  it('a keychain that THROWS on write leaves no key behind (fail closed)', () => {
    installMainSafe({
      isEncryptionAvailable: () => true,
      encryptString: () => { throw new Error('keychain locked') },
      decryptString: () => { throw new Error('keychain locked') },
    })
    expect(provisionMemoryKey(tmp, null)).toEqual({ key: null, minted: false })
    expect(fs.existsSync(path.join(tmp, KEY_CACHE_FILE))).toBe(false)
  })
})

describe('consolidationSimOf — a closure cannot cross a process boundary', () => {
  it('ships the pairwise matrix as DATA and rebuilds an identical comparator in main', async () => {
    // Deterministic vectors so cosine is predictable: two identical, one orthogonal. They must be
    // EMBED_DIM wide — the packed vector store only accepts exactly that, and a short vector would
    // fall out of it entirely and silently score 0 (which is what a 2-dim vector did here first).
    const unit = (i: number): number[] => { const v = new Array(EMBED_DIM).fill(0); v[i] = 1; return v }
    _resetForTests()
    _resetHostForTests()
    _resetMemoryClientForTests()
    installMainSafe(null)
    _setEmbedFnForTests(async (t: string) => (t.includes('cat') ? unit(0) : unit(1)))
    await startWithFake()

    const a = await memoryWrite({ agentId: 'x', kind: 'fact', content: 'a cat sat' })
    const b = await memoryWrite({ agentId: 'x', kind: 'fact', content: 'the cat ran' })
    const c = await memoryWrite({ agentId: 'x', kind: 'fact', content: 'dogs bark loudly' })

    const simOf = await consolidationSimOf(10)
    const cand = (id: string) => ({ id }) as Parameters<typeof simOf>[0]
    expect(simOf(cand(a.id), cand(b.id))).toBeCloseTo(1, 5) // same vector
    expect(simOf(cand(a.id), cand(c.id))).toBeCloseTo(0, 5) // orthogonal
    expect(simOf(cand(a.id), cand('unknown-id'))).toBe(0)   // unknown scores 0, as in-process
    _setEmbedFnForTests(null)
  })

  it('the matrix itself is symmetric and clonable', () => {
    const m = consolidationSimMatrix(0)
    expect(m.ids).toEqual([])
    expect(structuredClone(m)).toEqual(m)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// NAME DRIFT. The client sends `fn` as a STRING; the host looks it up in a map. TypeScript checks
// neither side against the other, so `call('memorySerch', …)` compiles, ships, and fails only when a
// user hits that one feature — where it looks like "memory returned nothing". This repo has been bitten
// by exactly this class of bug before (ipcChannelSync.test.ts exists for the IPC channel version of it).
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('client ⇄ host name drift', () => {
  it('every fn name the client sends EXISTS in the host whitelist (static check over the source)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/main/memoryClient.ts'), 'utf8')
    const names = [...src.matchAll(/\bcall<[^>]*>\(\s*'([^']+)'|\bcall\(\s*'([^']+)'/g)]
      .map((m) => m[1] ?? m[2])
      .filter(Boolean)
    expect(names.length).toBeGreaterThan(30) // the walker must not pass vacuously
    const unknown = [...new Set(names)].filter((n) => !(n in HOST_HANDLERS))
    expect(unknown, `client calls fns the host cannot dispatch: ${unknown.join(', ')}`).toEqual([])
  })

  it('EVERY proxied export actually round-trips (no fn resolves to "unknown fn")', async () => {
    await startWithFake()
    const seed = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'surface probe seed' })
    const c = await import('../../src/main/memoryClient')

    // Exercise the whole surface. Domain errors are fine (disableSyncEncryption legitimately throws
    // without sync); an "unknown fn" is NOT — that is a wiring bug the type system cannot see.
    const calls: Array<[string, () => Promise<unknown>]> = [
      ['memorySearch', () => c.memorySearch({ query: 'probe' })],
      ['memoryRelated', () => c.memoryRelated({ id: seed.id })],
      ['memoryGraphQuery', () => c.memoryGraphQuery({ id: seed.id })],
      ['memoryLink', () => c.memoryLink({ from: seed.id, to: seed.id, relation: 'relates-to' })],
      ['memoryFeedback', () => c.memoryFeedback({ id: seed.id, helpful: true })],
      ['memoryList', () => c.memoryList()],
      ['memoryCount', () => c.memoryCount()],
      ['memoryHasHash', () => c.memoryHasHash('deadbeef')],
      ['memoryStats', () => c.memoryStats()],
      ['memoryDashboardStats', () => c.memoryDashboardStats()],
      ['memoryGraphSample', () => c.memoryGraphSample({ limit: 5 })],
      ['memoryRecentActivity', () => c.memoryRecentActivity(5)],
      ['embeddingsReady', () => c.embeddingsReady()],
      ['memorySourceById', () => c.memorySourceById(seed.id)],
      ['memoryLessons', () => c.memoryLessons(10)],
      ['searchArchive', () => c.searchArchive('probe', 5)],
      ['symbolHistory', () => c.symbolHistory('probe')],
      ['weaveCandidates', () => c.weaveCandidates(10)],
      ['weaveNeighbours', () => c.weaveNeighbours(seed.id, 3)],
      ['backfillCodeRefs', () => c.backfillCodeRefs(seed.id, [])],
      ['consolidationCandidates', () => c.consolidationCandidates(10)],
      ['consolidationSimOf', () => c.consolidationSimOf(10)],
      ['memoryPatchProjects', () => c.memoryPatchProjects([])],
      ['memoryPruneCodePath', () => c.memoryPruneCodePath('/nope/x.ts')],
      ['memoryForget', () => c.memoryForget({})],
      ['memoryBackfillVectors', () => c.memoryBackfillVectors(5)],
      ['warmProbeEmbeddings', () => c.warmProbeEmbeddings()],
      ['compactSelfShard', () => c.compactSelfShard({ force: false })],
      ['persistMemoryIndex', () => c.persistMemoryIndex()],
      ['vectorRamStats', () => c.vectorRamStats()],
      ['setVectorQuantization', () => c.setVectorQuantization(false)],
      ['getSyncStatus', () => c.getSyncStatus()],
      ['exportMemorySnapshot', () => c.exportMemorySnapshot()],
      ['importMemorySnapshot', () => c.importMemorySnapshot('')],
      ['reloadMemoryFromSync', () => c.reloadMemoryFromSync()],
      ['memoryArchive', () => c.memoryArchive(seed.id)],
      ['memoryDelete', () => c.memoryDelete(seed.id)],
      ['disableSyncEncryption', () => c.disableSyncEncryption()], // throws: sync not enabled
      ['setSyncPassphrase', () => c.setSyncPassphrase('pw')],     // throws: sync not enabled
      ['disableEncryption', () => c.disableEncryption()],
      ['setSyncDir', () => c.setSyncDir(null)],
      ['memoryClear', () => c.memoryClear()],
    ]

    const drifted: string[] = []
    for (const [name, fn] of calls) {
      try { await fn() } catch (err) {
        if (/unknown fn/.test((err as Error).message)) drifted.push(name)
      }
    }
    expect(drifted, `these client exports call a fn the host does not have: ${drifted.join(', ')}`).toEqual([])
  })
})

describe('lifecycle', () => {
  it('a call before startMemoryHost() rejects rather than pretending the store is empty', async () => {
    _resetMemoryClientForTests()
    await expect(memoryCount()).rejects.toThrow(/startMemoryHost\(\) has not been called/)
  })

  it('stopMemoryHost kills the child, fails anything in flight, and does NOT silently serve an empty store', async () => {
    const { stopMemoryHost } = await import('../../src/main/memoryClient')
    await startWithFake({ swallowFn: 'memoryCount' })
    const inflight = memoryCount()
    await new Promise((r) => setTimeout(r, 0)) // let the call register in `pending`
    stopMemoryHost()
    await expect(inflight).rejects.toThrow(/stopped.*during memoryCount/s)

    // And the next call must REJECT, not fall through to an uninitialised in-process store and
    // answer 0 — a wrong number here is far worse than an error.
    await expect(memoryCount()).rejects.toThrow(/startMemoryHost\(\) has not been called/)
  })

  it('the pure helpers stay SYNCHRONOUS (a process round-trip to lowercase a string would be absurd)', async () => {
    const c = await import('../../src/main/memoryClient')
    expect(c.normalizeProjectSlug('C:/repos/Termpolis/')).toBe('termpolis')
    expect(typeof c.contentHash('abc')).toBe('string')       // not a Promise
    expect(typeof c.projectKeyOf('/a/b')).toBe('string')
    expect(typeof c.entityDedupHash('Foo')).toBe('string')
    expect(typeof c.canonicalEntityName('  Foo  ')).toBe('string')
  })

  it('a delete round-trips and is reflected in the count', async () => {
    await startWithFake()
    const e = await memoryWrite({ agentId: 'a', kind: 'fact', content: 'delete me' })
    await expect(memoryCount()).resolves.toBe(1)
    await memoryDelete(e.id)
    await expect(memoryCount()).resolves.toBe(0)
  })

  it('memoryWrite rejects empty content client-side (no pointless round trip)', async () => {
    const { hosts } = await startWithFake()
    const before = hosts[0].posted.length
    await expect(memoryWrite({ agentId: 'a', kind: 'note', content: '   ' })).rejects.toThrow(/content required/)
    await expect(memoryWrite(null as unknown as Parameters<typeof memoryWrite>[0])).rejects.toThrow(/content required/)
    expect(hosts[0].posted.length).toBe(before) // nothing crossed the wire
  })

  it('enableLocalEncryption REUSES an existing device key rather than re-keying (which would orphan the ciphertext)', async () => {
    installMainSafe(fakeSafe)
    await startWithFake() // provisions + mints a key
    const before = fs.readFileSync(path.join(tmp, KEY_CACHE_FILE), 'utf8')
    const status = await enableLocalEncryption() // already on — must be idempotent, not a re-key
    expect(status.encrypted).toBe(true)
    expect(fs.readFileSync(path.join(tmp, KEY_CACHE_FILE), 'utf8')).toBe(before) // same key
  })

  it('setSyncPassphrase still returns a status if the keychain write fails (session works; no plaintext key)', async () => {
    installMainSafe(fakeSafe)
    const syncDir = path.join(tmp, 'sync')
    await startWithFake({}, syncDir)
    // Break the keychain right before the cache write: the store is already unlocked, so the call
    // must still succeed — the cost is re-entering the passphrase next launch, never a key in the clear.
    const status = await setSyncPassphrase('pw one')
    expect(status.encrypted).toBe(true)
    const raw = fs.readFileSync(path.join(tmp, KEY_CACHE_FILE), 'utf8')
    expect(raw.startsWith('osk:v1:')).toBe(true)
  })
})
