// v1.54.5 (typing hotfix, lane C, package P6) — the memory host never falls back onto the MAIN thread
// above a store-size limit.
//
// WHY. memoryClient answered every way the memory host can fail (a spawn that throws, an init error,
// an exit before ready, the 120 s ready timeout, a crash loop) by loading the whole store inside the
// main process, and it never went back. That load is synchronous: 4.3 s on a 475 MB store,
// rebuildVectorIndex up to 18.8 s, on the thread that echoes every keystroke. On a CPU-starved
// machine a slow or failed host start is an ordinary event, so it turned straight into frozen typing.
//
// THE PROOF IS COUNTERS, not clocks: how many times the in-process store was initialised (must be
// ZERO above the limit), how many times the host was spawned and WHEN (virtual time), and what each
// refused call said. Every test that asserts the new behaviour is red on 942f2177. The "CONTROL"
// tests assert the old behaviour that must survive (below the limit, the kill switch, an unreadable
// size) and are green on both sides: they are what proves the assertions around them can tell the
// two apart.
//
// The fake host here is SCRIPTED, not the real dispatcher memoryHost.test.ts runs. That matters: the
// real dispatcher calls initSwarmMemory in this same process, which would make "the in-process init
// was never called" unmeasurable. Here the only caller of initSwarmMemory is the client's fallback.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// memoryClient statically imports `utilityProcess` (the real transport is ESM, no require()), so the
// mock must provide it. It is never CALLED here: every test injects its own transport.
vi.mock('electron', () => ({
  app: { getPath: () => '/fake' },
  utilityProcess: { fork: () => { throw new Error('utilityProcess.fork must not be called in unit tests') } },
}))

// Count every in-process store init. The wrapper runs the REAL initSwarmMemory, so a control that
// legitimately falls back still gets a working store; it only adds the counter.
const inproc = vi.hoisted(() => ({ inits: 0 }))
vi.mock('../../src/main/swarmMemory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/swarmMemory')>()
  return {
    ...actual,
    initSwarmMemory: (...args: Parameters<typeof actual.initSwarmMemory>) => {
      inproc.inits++
      return actual.initSwarmMemory(...args)
    },
  }
})

import { setSafeStorage, type SafeStorageLike } from '../../src/main/secureKeyStore'
import type { HostRequest, HostResponse } from '../../src/main/memoryHost'
import {
  startMemoryHost, stopMemoryHost, setMemoryHostSpawner, _resetMemoryClientForTests, memoryHostMode,
  setMemoryStoreSizeProbe, setMemoryRetryGovernor, retryMemoryHostNow,
  memoryCount, memoryList, memorySearch, memoryWrite, memoryStats, vectorRamStats, getSyncStatus,
  setSyncDir, enableLocalEncryption, startNewMemoryKey, consolidationSimOf, exportMemorySnapshot,
  type MemoryHostTransport, type MemoryHostSpawner,
} from '../../src/main/memoryClient'
import { memoryUnavailableInfo, RETRY_CAP_MS } from '../../src/main/memoryFallbackGuard'
import { _resetForTests, _setEmbeddingsAvailable } from '../../src/main/swarmMemory'

const MB = 1024 * 1024
const LIMIT = 256 * MB // the shipped default
const UNAVAILABLE = /^Memory is unavailable \(/

const fakeSafe: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from('SAFE:' + s, 'utf8'),
  decryptString: (b: Buffer) => b.toString('utf8').slice(5),
}

// ── The scripted host ────────────────────────────────────────────────────────────────────────────

type Step = 'ready' | 'exit' | 'silent' | 'init-error' | 'null' | 'throw'

interface Child {
  transport: MemoryHostTransport
  posted: HostRequest[]
  kills: () => number
  /** Fire the exit event, as many times as we like: utilityProcess is an EventEmitter. */
  exit: (code?: number) => void
  /** Deliver a 'ready' by hand (for a child scripted 'silent'). */
  ready: () => void
}

function makeChild(how: 'ready' | 'exit' | 'silent' | 'init-error', answers: Record<string, unknown> = {}): Child {
  const posted: HostRequest[] = []
  let msgCb: ((m: HostResponse) => void) | null = null
  let exitCb: ((code: number) => void) | null = null
  let kills = 0
  const transport: MemoryHostTransport = {
    postMessage: (msg) => {
      posted.push(msg)
      if (msg.kind === 'init') {
        if (how === 'ready') queueMicrotask(() => msgCb?.({ kind: 'ready', pid: 7777, entries: 0 }))
        else if (how === 'exit') queueMicrotask(() => exitCb?.(9))
        else if (how === 'init-error') {
          queueMicrotask(() => msgCb?.({ kind: 'init-error', error: { name: 'Error', message: 'fake init failure' } }))
        }
        return
      }
      if (msg.kind === 'call') queueMicrotask(() => msgCb?.({ kind: 'result', id: msg.id, ok: true, result: msg.fn in answers ? answers[msg.fn] : 5 }))
    },
    onMessage: (cb) => { msgCb = cb },
    onExit: (cb) => { exitCb = cb },
    kill: () => { kills++ },
    pid: 7777,
  }
  return {
    transport,
    posted,
    kills: () => kills,
    exit: (code = 1) => exitCb?.(code),
    ready: () => msgCb?.({ kind: 'ready', pid: 7777, entries: 0 }),
  }
}

/** A spawner whose n-th attempt does what steps[n] says (the last step repeats). It counts attempts
 *  and stamps each with the (possibly virtual) time, so a test can assert WHEN the client tried. */
function scripted(steps: Step[], answers: Record<string, unknown> = {}) {
  const children: Child[] = []
  const spawnAt: number[] = []
  const spawner: MemoryHostSpawner = () => {
    const step = steps[Math.min(spawnAt.length, steps.length - 1)]
    spawnAt.push(Date.now())
    if (step === 'null') return null
    if (step === 'throw') throw new Error('fork: ENOENT')
    const c = makeChild(step, answers)
    children.push(c)
    return c.transport
  }
  return {
    spawner,
    children,
    spawnAt,
    attempts: () => spawnAt.length,
    last: () => children[children.length - 1],
  }
}

/** logLoud() is silent under NODE_ENV=test, so its lines are invisible by default. */
function captureLoud(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  vi.stubEnv('NODE_ENV', 'production')
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(' '))
  })
  return { lines, restore: () => { spy.mockRestore(); vi.stubEnv('NODE_ENV', 'test') } }
}

/** Let queued work run: virtual time when the clock is faked, a real macrotask otherwise. */
const tick = async (ms = 0): Promise<void> => {
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(ms)
  else await new Promise<void>((r) => { setTimeout(r, ms) })
}

let tmp: string
const tmpDirs: string[] = []

/** A shard of `bytes` bytes (blank lines: valid for the real store if a control loads it). */
function writeStore(bytes: number): void {
  fs.writeFileSync(path.join(tmp, 'swarm-memory.jsonl'), '\n'.repeat(bytes))
}

type Probe = (userDataPath: string, syncDir: string | null) => Promise<number | null> | number | null

/** Make the store look `bytes` big to the client, with no disk involved (deterministic under fake
 *  time). The seam is new in 1.54.5; it is called through a guard ONLY so that this file also RUNS on
 *  the base commit, where what fails is the behaviour under test and not a TypeError. */
function probeReturns(probe: Probe): void {
  ;(setMemoryStoreSizeProbe as ((p: Probe | null) => void) | undefined)?.(probe)
}
const storeIs = (bytes: number | null): void => probeReturns(async () => bytes)

const FIRST_START_FAILURES: Array<{ name: string; step: Step; advance?: number }> = [
  { name: 'the spawner returns null', step: 'null' },
  { name: 'the spawner throws', step: 'throw' },
  { name: 'the child reports an init error', step: 'init-error' },
  { name: 'the child exits before it is ready', step: 'exit' },
  { name: 'the child never reports ready (the 120 s timeout)', step: 'silent', advance: 120_000 },
]

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memfallback-'))
  tmpDirs.push(tmp)
  inproc.inits = 0
  vi.stubEnv('TERMPOLIS_MEMORY_INPROC_GUARD', '')
  vi.stubEnv('TERMPOLIS_MEMORY_INPROC_MAX_MB', '')
  _resetForTests()
  _resetMemoryClientForTests()
  _setEmbeddingsAvailable(false) // keyword-only: no model, fast, deterministic
  setSafeStorage(null)
})

afterEach(() => {
  vi.useRealTimers()
  _resetMemoryClientForTests()
  _resetForTests()
  setSafeStorage(null)
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  for (const d of tmpDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

/** Start over with a fresh client: for tests that need two verdicts in one body. */
function freshClient(): void {
  _resetMemoryClientForTests()
  _resetForTests()
  _setEmbeddingsAvailable(false)
  inproc.inits = 0
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// 1. ABOVE THE LIMIT: a host that cannot serve never moves the store onto the main thread
// ═════════════════════════════════════════════════════════════════════════════════════════════════

describe('above the limit — a memory host that cannot serve never loads the store on the main thread', () => {
  it('crash 4x in 60 s: the mode is not in-process, the in-process init is never called, no 5th spawn', async () => {
    // REAL files and the REAL size probe: a ~4 KB shard against a ~1 KB limit (the limit is in MB and
    // may be fractional). This is the path the shipped app takes, with only the sizes shrunk.
    writeStore(4_000)
    vi.stubEnv('TERMPOLIS_MEMORY_INPROC_MAX_MB', '0.001')
    probeReturns(async () => 1)       // a seam answer first...
    setMemoryStoreSizeProbe(null)     // ...and back to the REAL probe, which is what this test is about
    const s = scripted(['ready'])
    setMemoryHostSpawner(s.spawner)
    expect(await startMemoryHost({ userDataPath: tmp })).toBe('host')

    for (let i = 0; i < 4; i++) { s.last().exit(1); await tick() }
    await vi.waitFor(() => expect(memoryHostMode()).toBe('unavailable'))

    expect(memoryHostMode()).not.toBe('inproc')
    expect(inproc.inits).toBe(0)       // the whole point: the main thread never loaded the store
    expect(s.attempts()).toBe(4)       // the first start + 3 immediate respawns; the 4th crash is not respawned at once
  })

  it.each(FIRST_START_FAILURES)('a failed first start ($name) is "unavailable", not in-process', async ({ step, advance }) => {
    vi.useFakeTimers()
    storeIs(400 * MB)
    const s = scripted([step])
    setMemoryHostSpawner(s.spawner)

    const started = startMemoryHost({ userDataPath: tmp })
    if (advance) await vi.advanceTimersByTimeAsync(advance)

    expect(await started).toBe('unavailable')
    expect(memoryHostMode()).not.toBe('inproc')
    expect(inproc.inits).toBe(0)
    expect(s.attempts()).toBe(1)
    if (step === 'silent') expect(s.last().kills()).toBe(1) // the hung child is not left running
  })

  it('every memory call is refused with the same honest, fixed text: never an empty answer, never the in-process store', async () => {
    storeIs(400 * MB)
    const s = scripted(['exit'])
    setMemoryHostSpawner(s.spawner)
    await startMemoryHost({ userDataPath: tmp })
    expect(memoryHostMode()).toBe('unavailable')
    setSafeStorage(fakeSafe) // so startNewMemoryKey reaches the host call instead of the no-keychain refusal

    const calls: Array<[string, () => Promise<unknown>]> = [
      ['memoryCount', () => memoryCount()],
      ['memoryList', () => memoryList()],
      ['memorySearch', () => memorySearch({ query: 'anything' })],
      ['memoryWrite', () => memoryWrite({ agentId: 'a', kind: 'fact', content: 'a note that must not be lost silently' })],
      ['memoryStats', () => memoryStats()],
      ['vectorRamStats', () => vectorRamStats()],
      ['getSyncStatus', () => getSyncStatus()],
      ['setSyncDir', () => setSyncDir(null)],
      ['enableLocalEncryption', () => enableLocalEncryption()],
      ['startNewMemoryKey', () => startNewMemoryKey()],
      ['consolidationSimOf', () => consolidationSimOf(10)],
      ['exportMemorySnapshot', () => exportMemorySnapshot()],
    ]
    const messages = new Set<string>()
    for (const [name, run] of calls) {
      const err = await run().then(() => null, (e: Error) => e)
      expect(err, `${name} must reject`).toBeInstanceOf(Error)
      expect(err?.message, name).toMatch(UNAVAILABLE)
      expect(err?.message, `${name}: fixed text, no path in it`).not.toContain(tmp)
      messages.add(err?.message ?? '')
    }
    expect(messages.size).toBe(1) // one fixed text, so an agent can recognise it and stop retrying
    expect(inproc.inits).toBe(0)
  })

  it('a call made while the size is still being read waits for the verdict; it is not answered from an empty in-process store', async () => {
    // The gap this guards: the child dies, the decision needs the size, the size is still on its way.
    // If mode were left at host/in-process-by-default during that wait, a call would reach a store
    // nobody initialised and answer "0 memories": the one lie this module exists to prevent.
    let release!: (n: number | null) => void
    probeReturns(() => new Promise<number | null>((r) => { release = r }))
    const s = scripted(['exit'])
    setMemoryHostSpawner(s.spawner)

    const started = startMemoryHost({ userDataPath: tmp })
    await tick()
    expect(memoryHostMode()).not.toBe('inproc')   // decided nothing yet

    let outcome: unknown = 'pending'
    const early = memoryCount().then((v) => { outcome = v }, (e) => { outcome = e })
    await tick()
    expect(outcome).toBe('pending')               // held for the verdict, not answered 0

    release(400 * MB)
    await started
    await early
    expect(outcome).toBeInstanceOf(Error)
    expect((outcome as Error).message).toMatch(UNAVAILABLE)
    expect(inproc.inits).toBe(0)
  })

  it('one byte over the limit is unavailable (the limit is "above", not "at")', async () => {
    storeIs(LIMIT + 1)
    setMemoryHostSpawner(scripted(['exit']).spawner)
    expect(await startMemoryHost({ userDataPath: tmp })).toBe('unavailable')
    expect(inproc.inits).toBe(0)
  })

  it('TERMPOLIS_MEMORY_INPROC_MAX_MB moves the limit: a 700 MB store is unavailable under a 600 MB limit', async () => {
    vi.stubEnv('TERMPOLIS_MEMORY_INPROC_MAX_MB', '600')
    storeIs(700 * MB)
    setMemoryHostSpawner(scripted(['exit']).spawner)
    expect(await startMemoryHost({ userDataPath: tmp })).toBe('unavailable')
    expect(inproc.inits).toBe(0)
  })

  it('a kill switch value that is not an "off" word leaves the guard ON', async () => {
    vi.stubEnv('TERMPOLIS_MEMORY_INPROC_GUARD', '1')
    storeIs(900 * MB)
    setMemoryHostSpawner(scripted(['exit']).spawner)
    expect(await startMemoryHost({ userDataPath: tmp })).toBe('unavailable')
    expect(inproc.inits).toBe(0)
  })

  it('a size that never comes back (a hung share) is given 3 s, then the decision fails open', async () => {
    vi.useFakeTimers()
    probeReturns(() => new Promise<number | null>(() => { /* never settles */ }))
    setMemoryHostSpawner(scripted(['exit']).spawner)
    const started = startMemoryHost({ userDataPath: tmp })
    await vi.advanceTimersByTimeAsync(2_999)
    expect(inproc.inits).toBe(0)                   // still waiting for the size
    await vi.advanceTimersByTimeAsync(1)
    expect(await started).toBe('inproc')           // could not tell: today's behaviour
    expect(inproc.inits).toBe(1)
  })
})

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// 2. RETRY WITH BACKOFF
// ═════════════════════════════════════════════════════════════════════════════════════════════════

describe('unavailable — the client retries in the background on a capped exponential schedule', () => {
  it('retries after 10 s, 20 s, 40 s, 80 s, 160 s, then every 300 s, each on time and exactly once', async () => {
    vi.useFakeTimers()
    storeIs(400 * MB)
    const s = scripted(['exit']) // every attempt dies during startup
    setMemoryHostSpawner(s.spawner)
    expect(await startMemoryHost({ userDataPath: tmp })).toBe('unavailable')
    expect(s.attempts()).toBe(1)

    const delays = [10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000]
    for (const d of delays) {
      const before = s.attempts()
      await vi.advanceTimersByTimeAsync(d - 1)
      expect(s.attempts(), `not ${d - 1} ms in`).toBe(before)     // never early
      await vi.advanceTimersByTimeAsync(1)
      expect(s.attempts(), `at ${d} ms`).toBe(before + 1)          // exactly one try, on time
      expect(memoryHostMode()).toBe('unavailable')
    }
    const gaps = s.spawnAt.slice(1).map((t, i) => t - s.spawnAt[i])
    expect(gaps).toEqual(delays)
    expect(inproc.inits).toBe(0)
  })

  it('a retry keeps the mode "unavailable" while it runs: calls fail fast, they do not queue behind it', async () => {
    vi.useFakeTimers()
    storeIs(400 * MB)
    const s = scripted(['exit', 'silent'])
    setMemoryHostSpawner(s.spawner)
    await startMemoryHost({ userDataPath: tmp })

    await vi.advanceTimersByTimeAsync(10_000)
    expect(s.attempts()).toBe(2)                 // the retry is in flight (its child is silent)
    expect(memoryHostMode()).toBe('unavailable')
    await expect(memoryCount()).rejects.toThrow(UNAVAILABLE) // does not wait for it
  })

  it('a ready timeout is retried too, and each retry is given longer to load than the last', async () => {
    vi.useFakeTimers()
    storeIs(400 * MB)
    const s = scripted(['silent']) // no child ever reports ready
    setMemoryHostSpawner(s.spawner)

    const started = startMemoryHost({ userDataPath: tmp })
    await vi.advanceTimersByTimeAsync(119_999)
    expect(memoryHostMode()).toBe('starting')      // the first start keeps its 120 s
    await vi.advanceTimersByTimeAsync(1)
    expect(await started).toBe('unavailable')
    expect(s.children[0].kills()).toBe(1)

    // Retry 1 starts 10 s later and is allowed 2 x 120 s: a store too big to load in 120 s on a
    // starved machine must be able to finish, or "unavailable" would never end.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(s.attempts()).toBe(2)
    await vi.advanceTimersByTimeAsync(239_999)
    expect(s.children[1].kills()).toBe(0)          // 120 s was NOT enough this time
    await vi.advanceTimersByTimeAsync(1)
    expect(s.children[1].kills()).toBe(1)          // timed out at 240 s, and killed

    // ...and the wait before retry 2 doubled (20 s), whose own allowance is 360 s.
    await vi.advanceTimersByTimeAsync(19_999)
    expect(s.attempts()).toBe(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(s.attempts()).toBe(3)
    await vi.advanceTimersByTimeAsync(359_999)
    expect(s.children[2].kills()).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(s.children[2].kills()).toBe(1)
    expect(inproc.inits).toBe(0)
  })

  it('a retry that comes up ends it: host mode, calls served by the child, no further spawn, nothing left to report', async () => {
    vi.useFakeTimers()
    storeIs(400 * MB)
    const s = scripted(['exit', 'exit', 'ready'])
    setMemoryHostSpawner(s.spawner)
    await startMemoryHost({ userDataPath: tmp })

    await vi.advanceTimersByTimeAsync(10_000)      // retry 1: dies
    await vi.advanceTimersByTimeAsync(20_000)      // retry 2: comes up
    expect(s.attempts()).toBe(3)
    expect(memoryHostMode()).toBe('host')
    expect(await memoryCount()).toBe(5)            // answered by the child
    expect(s.last().posted.some((m) => m.kind === 'call' && m.fn === 'memoryCount')).toBe(true)

    await vi.advanceTimersByTimeAsync(60 * 60_000) // an hour
    expect(s.attempts()).toBe(3)                   // the retry loop is over
    expect(memoryUnavailableInfo()).toEqual({})
    expect(inproc.inits).toBe(0)
  })

  it('publishes what the Settings panel shows: the attempt, the wait, the size, the limit and the cause', async () => {
    vi.useFakeTimers()
    storeIs(400 * MB)
    const s = scripted(['exit'])
    setMemoryHostSpawner(s.spawner)
    await startMemoryHost({ userDataPath: tmp })

    expect(memoryUnavailableInfo()).toMatchObject({ attempt: 1, retrying: false, retryInMs: 10_000, storeMB: 400, limitMB: 256 })
    expect(String(memoryUnavailableInfo().reason)).toContain('exited during startup')

    await vi.advanceTimersByTimeAsync(4_000)
    expect(memoryUnavailableInfo().retryInMs).toBe(6_000) // a countdown, not a constant

    await vi.advanceTimersByTimeAsync(6_000)               // retry 1 ran and failed
    expect(memoryUnavailableInfo()).toMatchObject({ attempt: 2, retrying: false, retryInMs: 20_000 })
  })
})

describe('the governor hook (P13 will decide WHEN to retry; until then the backoff alone does)', () => {
  it('a governor can defer a retry: it is asked when the timer fires, and nothing starts until it says go', async () => {
    vi.useFakeTimers()
    storeIs(400 * MB)
    const asked: number[] = []
    setMemoryRetryGovernor(({ attempt }) => { asked.push(attempt); return asked.length === 1 ? 7_000 : 0 })
    const s = scripted(['exit'])
    setMemoryHostSpawner(s.spawner)
    await startMemoryHost({ userDataPath: tmp })

    await vi.advanceTimersByTimeAsync(10_000)
    expect(asked).toEqual([1])                     // asked once, at the backoff time
    expect(s.attempts()).toBe(1)                   // told to wait: no spawn
    await vi.advanceTimersByTimeAsync(6_999)
    expect(s.attempts()).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(asked).toEqual([1, 1])                  // asked again after the deferral
    expect(s.attempts()).toBe(2)                   // and this time it said go
  })

  it('a governor that throws, or answers nonsense, cannot wedge memory: it fails open to the plain backoff', async () => {
    vi.useFakeTimers()
    storeIs(400 * MB)
    const answers: Array<() => number> = [() => { throw new Error('governor bug') }, () => Number.NaN, () => -5]
    let n = 0
    setMemoryRetryGovernor(() => answers[Math.min(n++, answers.length - 1)]())
    const s = scripted(['exit'])
    setMemoryHostSpawner(s.spawner)
    await startMemoryHost({ userDataPath: tmp })

    await vi.advanceTimersByTimeAsync(10_000)
    expect(s.attempts()).toBe(2)                   // threw: go
    await vi.advanceTimersByTimeAsync(20_000)
    expect(s.attempts()).toBe(3)                   // NaN: go
    await vi.advanceTimersByTimeAsync(40_000)
    expect(s.attempts()).toBe(4)                   // negative: go
  })

  it('a governor cannot defer without bound: one answer is clamped to the 5 minute cap', async () => {
    vi.useFakeTimers()
    storeIs(400 * MB)
    setMemoryRetryGovernor(() => 1e12)             // "a very long time"
    const s = scripted(['exit'])
    setMemoryHostSpawner(s.spawner)
    await startMemoryHost({ userDataPath: tmp })
    await vi.advanceTimersByTimeAsync(10_000)      // asked; told to wait forever
    expect(s.attempts()).toBe(1)

    let asks = 0
    setMemoryRetryGovernor(() => { asks++; return 0 })
    await vi.advanceTimersByTimeAsync(299_999)     // the clamp: asked again 300 s after the last ask
    expect(asks).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(asks).toBe(1)
    expect(s.attempts()).toBe(2)
  })

  it('retryMemoryHostNow() starts a retry at once, skips the wait, and cancels the pending timer', async () => {
    vi.useFakeTimers()
    storeIs(400 * MB)
    const s = scripted(['exit', 'ready'])
    setMemoryHostSpawner(s.spawner)
    await startMemoryHost({ userDataPath: tmp })
    expect(s.attempts()).toBe(1)

    expect(retryMemoryHostNow()).toBe(true)
    await tick()
    expect(s.attempts()).toBe(2)                   // no 10 s wait
    expect(memoryHostMode()).toBe('host')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(s.attempts()).toBe(2)                   // the pending timer is gone: no second try
  })

  it('retryMemoryHostNow() does nothing while one is already running, and nothing before a start or after the quit', async () => {
    vi.useFakeTimers()
    storeIs(400 * MB)
    expect(retryMemoryHostNow()).toBe(false)       // never started
    const s = scripted(['exit', 'silent'])
    setMemoryHostSpawner(s.spawner)
    await startMemoryHost({ userDataPath: tmp })

    expect(retryMemoryHostNow()).toBe(true)        // starts the (silent) retry
    await tick()
    expect(s.attempts()).toBe(2)
    expect(retryMemoryHostNow()).toBe(false)       // one is in flight: not a second child
    await tick()
    expect(s.attempts()).toBe(2)

    stopMemoryHost()
    expect(retryMemoryHostNow()).toBe(false)       // the app quit: nothing may start
  })

  it('retryMemoryHostNow() on a healthy host is a no-op', async () => {
    storeIs(400 * MB)
    const s = scripted(['ready'])
    setMemoryHostSpawner(s.spawner)
    expect(await startMemoryHost({ userDataPath: tmp })).toBe('host')
    expect(retryMemoryHostNow()).toBe(false)
    expect(s.attempts()).toBe(1)
  })
})

describe('an episode of failures: when the backoff starts over and when it keeps climbing', () => {
  async function crashLoopToUnavailable(s: ReturnType<typeof scripted>): Promise<void> {
    for (let i = 0; i < 4; i++) { s.last().exit(1); await vi.advanceTimersByTimeAsync(0) }
    expect(memoryHostMode()).toBe('unavailable')
  }

  it('a host that comes back and then crashes again within the minute keeps climbing: 20 s, not 10 s', async () => {
    vi.useFakeTimers()
    storeIs(400 * MB)
    const s = scripted(['ready'])
    setMemoryHostSpawner(s.spawner)
    await startMemoryHost({ userDataPath: tmp })
    await crashLoopToUnavailable(s)                // episode 1: attempt 1, retry in 10 s
    expect(s.attempts()).toBe(4)

    await vi.advanceTimersByTimeAsync(10_000)      // the retry comes up...
    expect(s.attempts()).toBe(5)
    expect(memoryHostMode()).toBe('host')
    await vi.advanceTimersByTimeAsync(5_000)
    s.last().exit(1)                               // ...and dies 5 s later, with the earlier crashes still in the window
    await vi.advanceTimersByTimeAsync(0)
    expect(memoryHostMode()).toBe('unavailable')

    await vi.advanceTimersByTimeAsync(19_999)
    expect(s.attempts()).toBe(5)                   // NOT retried after 10 s again
    await vi.advanceTimersByTimeAsync(1)
    expect(s.attempts()).toBe(6)
  })

  it('a host that ran for a full minute before crashing starts a fresh episode: back to 10 s', async () => {
    vi.useFakeTimers()
    storeIs(400 * MB)
    const s = scripted(['ready'])
    setMemoryHostSpawner(s.spawner)
    await startMemoryHost({ userDataPath: tmp })
    await crashLoopToUnavailable(s)
    await vi.advanceTimersByTimeAsync(10_000)      // retry comes up
    expect(memoryHostMode()).toBe('host')
    const before = s.attempts()

    await vi.advanceTimersByTimeAsync(61_000)      // stable for longer than the restart window
    s.last().exit(1)                               // a single crash: an ordinary immediate respawn
    await vi.advanceTimersByTimeAsync(0)
    expect(s.attempts()).toBe(before + 1)
    expect(memoryHostMode()).toBe('host')

    for (let i = 0; i < 3; i++) { s.last().exit(1); await vi.advanceTimersByTimeAsync(0) }
    expect(memoryHostMode()).toBe('unavailable')   // a crash loop again...
    const at = s.attempts()
    await vi.advanceTimersByTimeAsync(9_999)
    expect(s.attempts()).toBe(at)
    await vi.advanceTimersByTimeAsync(1)
    expect(s.attempts()).toBe(at + 1)              // ...but the backoff began again at 10 s
  })
})

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// 3. LIFECYCLE: quitting, stale exits
// ═════════════════════════════════════════════════════════════════════════════════════════════════

describe('unavailable — shutdown and stale children', () => {
  it('stopMemoryHost() cancels the pending retry: nothing is spawned after the app quit', async () => {
    vi.useFakeTimers()
    storeIs(400 * MB)
    const s = scripted(['exit'])
    setMemoryHostSpawner(s.spawner)
    await startMemoryHost({ userDataPath: tmp })
    expect(vi.getTimerCount()).toBeGreaterThan(0)  // a retry is pending

    stopMemoryHost()
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(s.attempts()).toBe(1)
    expect(memoryHostMode()).toBe('unstarted')
    expect(memoryUnavailableInfo()).toEqual({})
  })

  it('a retry in flight when the app quits neither revives host mode nor forks again', async () => {
    vi.useFakeTimers()
    storeIs(400 * MB)
    const s = scripted(['exit', 'silent'])
    setMemoryHostSpawner(s.spawner)
    await startMemoryHost({ userDataPath: tmp })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(s.attempts()).toBe(2)                   // retry 1 is loading

    stopMemoryHost()
    s.last().ready()                               // its ready was already on the way
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(memoryHostMode()).toBe('unstarted')
    expect(s.attempts()).toBe(2)
  })

  it('a late exit from an abandoned child cannot tear down the retry that replaced it', async () => {
    vi.useFakeTimers()
    storeIs(400 * MB)
    const s = scripted(['silent'])                 // child A hangs and is abandoned at 120 s
    setMemoryHostSpawner(s.spawner)
    const started = startMemoryHost({ userDataPath: tmp })
    await vi.advanceTimersByTimeAsync(120_000)
    await started
    await vi.advanceTimersByTimeAsync(10_000)      // child B (the retry) is now loading
    expect(s.attempts()).toBe(2)

    s.children[0].exit(0)                          // A's exit event finally lands, after B began
    await vi.advanceTimersByTimeAsync(0)
    s.children[1].ready()                          // B comes up
    await vi.advanceTimersByTimeAsync(0)

    expect(memoryHostMode()).toBe('host')          // not wrecked by A's stale exit
    expect(await memoryCount()).toBe(5)
    expect(s.children[1].posted.some((m) => m.kind === 'call' && m.fn === 'memoryCount')).toBe(true)
    expect(inproc.inits).toBe(0)
  })
})

describe('unavailable — the verdict window and the quit', () => {
  it('a duplicate exit event from the abandoned child, while the verdict is pending, cannot let a call reach an unloaded store', async () => {
    // The hole: the child died, the size is still being read, the exit event is delivered AGAIN
    // (utilityProcess is an EventEmitter). If that second delivery cleared the "wait for the verdict"
    // promise, a call arriving now would see a client that is neither started nor unavailable and be
    // answered by the in-process store, which nobody initialised: "0 memories".
    let release!: (n: number | null) => void
    probeReturns(() => new Promise<number | null>((r) => { release = r }))
    const s = scripted(['exit'])
    setMemoryHostSpawner(s.spawner)
    const started = startMemoryHost({ userDataPath: tmp })
    await tick()
    s.children[0].exit(9)                          // the same exit, delivered again, mid-verdict
    await tick()

    let outcome: unknown = 'pending'
    const early = memoryCount().then((v) => { outcome = v }, (e) => { outcome = e })
    await tick()
    expect(outcome).toBe('pending')                // still held for the verdict

    release(400 * MB)
    await started
    await early
    expect(outcome).toBeInstanceOf(Error)
    expect((outcome as Error).message).toMatch(UNAVAILABLE)
    expect(inproc.inits).toBe(0)
  })

  it('the app quitting while the size is still being read leaves the client stopped: no verdict is acted on', async () => {
    let release!: (n: number | null) => void
    probeReturns(() => new Promise<number | null>((r) => { release = r }))
    const s = scripted(['exit'])
    setMemoryHostSpawner(s.spawner)
    const started = startMemoryHost({ userDataPath: tmp })
    await tick()

    stopMemoryHost()
    release(400 * MB)
    expect(await started).toBe('unstarted')
    expect(memoryHostMode()).toBe('unstarted')
    expect(inproc.inits).toBe(0)
    expect(s.attempts()).toBe(1)
    expect(memoryUnavailableInfo()).toEqual({})
  })

  it('a retry that comes up in the same instant the app quits does not become a live host', async () => {
    vi.useFakeTimers()
    storeIs(400 * MB)
    const s = scripted(['exit', 'silent'])
    setMemoryHostSpawner(s.spawner)
    await startMemoryHost({ userDataPath: tmp })
    await vi.advanceTimersByTimeAsync(10_000)      // retry 1 is loading
    expect(s.attempts()).toBe(2)

    s.last().ready()                               // ready lands...
    stopMemoryHost()                               // ...and the quit follows in the same tick
    await vi.advanceTimersByTimeAsync(0)
    expect(memoryHostMode()).toBe('unstarted')
    expect(memoryUnavailableInfo()).toEqual({})
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(s.attempts()).toBe(2)
  })
})

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// 3b. THE SIZE IS KNOWN BEFORE A FAILURE NEEDS IT
// ═════════════════════════════════════════════════════════════════════════════════════════════════

describe('the size of the store is known before a failure needs it (a starved machine must not decide on a fresh read)', () => {
  it('a retry that fails again is judged from the size already known: no new read, and never released onto the main thread', async () => {
    vi.useFakeTimers()
    let reads = 0
    probeReturns(async () => { reads++; return 400 * MB })
    const s = scripted(['exit'])
    setMemoryHostSpawner(s.spawner)
    await startMemoryHost({ userDataPath: tmp })
    expect(reads).toBe(1)                          // once, at start, beside the first spawn

    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(RETRY_CAP_MS)
    expect(s.attempts()).toBeGreaterThanOrEqual(5) // it kept retrying...
    expect(reads).toBe(1)                          // ...and never asked the disk again
    expect(memoryHostMode()).toBe('unavailable')
    expect(inproc.inits).toBe(0)
  })

  it('a probe that stalls AFTER the first answer cannot turn a retry failure into a main-thread load', async () => {
    vi.useFakeTimers()
    let calls = 0
    // The first answer is fine; any later read would hang (a starved box, a share that went away).
    probeReturns(() => (++calls === 1 ? Promise.resolve(400 * MB) : new Promise<number | null>(() => { /* hangs */ })))
    const s = scripted(['exit'])
    setMemoryHostSpawner(s.spawner)
    await startMemoryHost({ userDataPath: tmp })
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(RETRY_CAP_MS)
    expect(memoryHostMode()).toBe('unavailable')   // on the old behaviour this is 'inproc' after the first failure
    expect(inproc.inits).toBe(0)
  })

  it('a size that could not be read at start is not remembered: a later crash loop asks again, and is judged on the real answer', async () => {
    vi.useFakeTimers()
    let calls = 0
    // The first read hangs (a starved box): after 3 s it counts as "could not tell". The second works.
    probeReturns(() => (++calls === 1 ? new Promise<number | null>(() => { /* hangs */ }) : Promise.resolve(400 * MB)))
    const s = scripted(['ready'])
    setMemoryHostSpawner(s.spawner)
    const started = startMemoryHost({ userDataPath: tmp })
    await vi.advanceTimersByTimeAsync(3_000)       // the first read gives up (it never blocks the host itself)
    expect(await started).toBe('host')
    expect(calls).toBe(1)

    for (let i = 0; i < 4; i++) { s.last().exit(1); await vi.advanceTimersByTimeAsync(0) }
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(2)                          // asked again at the failure
    expect(memoryHostMode()).toBe('unavailable')
    expect(inproc.inits).toBe(0)
  })

  it('setSyncDir keeps the size answer warm for the NEW location, so a later crash loop is judged without a fresh read', async () => {
    const seen: Array<string | null> = []
    probeReturns(async (_userData, syncDir) => { seen.push(syncDir); return 400 * MB })
    const share = path.join(tmp, 'shared-folder')
    const s = scripted(['ready'], { setSyncDir: { syncing: true, dir: share } })
    setMemoryHostSpawner(s.spawner)
    await startMemoryHost({ userDataPath: tmp })
    expect(seen).toEqual([null])                   // the local store, at start

    await setSyncDir(share)                        // the child confirms it is now syncing there
    await tick()
    expect(seen).toEqual([null, share])            // asked once for the new location, in the background

    for (let i = 0; i < 4; i++) { s.last().exit(1); await tick() }
    await vi.waitFor(() => expect(memoryHostMode()).toBe('unavailable'))
    expect(seen).toEqual([null, share])            // judged from the warm answer
    expect(inproc.inits).toBe(0)
  })
})

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// 4. THE TRANSITION IS LOGGED, WITH MAIN'S RSS BEFORE AND AFTER
// ═════════════════════════════════════════════════════════════════════════════════════════════════

describe('the transition is logged with the main process RSS before and after', () => {
  it('"unavailable" says the store was NOT loaded, and gives main\'s RSS around the transition', async () => {
    storeIs(400 * MB)
    setMemoryHostSpawner(scripted(['exit']).spawner)
    const loud = captureLoud()
    try {
      await startMemoryHost({ userDataPath: tmp })
      const line = loud.lines.find((l) => l.includes('UNAVAILABLE'))
      expect(line).toBeDefined()
      expect(line).toMatch(/main rss \d+ MB -> \d+ MB/)
      expect(line).toContain('NOT loaded')
      expect(line).toContain('memory host exited during startup (code 9)')
    } finally {
      loud.restore()
    }
  })

  it('the in-process fallback (below the limit) logs the same pair, around the load it just did', async () => {
    storeIs(1 * MB)
    setMemoryHostSpawner(scripted(['exit']).spawner)
    const loud = captureLoud()
    try {
      await startMemoryHost({ userDataPath: tmp })
      expect(loud.lines.some((l) => l.includes('FALLBACK') && l.includes('memory host exited during startup (code 9)'))).toBe(true)
      expect(loud.lines.some((l) => /in-process store loaded.*main rss \d+ MB -> \d+ MB/.test(l))).toBe(true)
    } finally {
      loud.restore()
    }
  })
})

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// 5. CONTROLS — the old behaviour that must survive. Green on 942f2177 AND after.
// ═════════════════════════════════════════════════════════════════════════════════════════════════

describe('CONTROL — below the limit, with the kill switch, or with no size at all, today\'s behaviour is untouched', () => {
  it('the same crash loop on a small store still falls back to in-process, once, and serves from there', async () => {
    storeIs(1 * MB)
    const s = scripted(['ready'])
    setMemoryHostSpawner(s.spawner)
    await startMemoryHost({ userDataPath: tmp })
    for (let i = 0; i < 4; i++) { s.last().exit(1); await tick() }
    await vi.waitFor(() => expect(memoryHostMode()).toBe('inproc'))

    expect(inproc.inits).toBe(1)
    await memoryWrite({ agentId: 'a', kind: 'fact', content: 'served on the main thread, as before' })
    expect((await memoryList()).map((e) => e.content)).toContain('served on the main thread, as before')
  })

  it.each(FIRST_START_FAILURES)('a failed first start ($name) on a small store still falls back to in-process', async ({ step, advance }) => {
    vi.useFakeTimers()
    storeIs(1 * MB)
    const s = scripted([step])
    setMemoryHostSpawner(s.spawner)
    const started = startMemoryHost({ userDataPath: tmp })
    if (advance) await vi.advanceTimersByTimeAsync(advance)
    expect(await started).toBe('inproc')
    expect(inproc.inits).toBe(1)
  })

  it('a store exactly AT the limit is still allowed in-process', async () => {
    storeIs(LIMIT)
    setMemoryHostSpawner(scripted(['exit']).spawner)
    expect(await startMemoryHost({ userDataPath: tmp })).toBe('inproc')
    expect(inproc.inits).toBe(1)
  })

  it.each(['0', 'off', 'false', 'no', 'OFF'])('the kill switch TERMPOLIS_MEMORY_INPROC_GUARD=%s restores today\'s behaviour on a huge store', async (value) => {
    vi.stubEnv('TERMPOLIS_MEMORY_INPROC_GUARD', value)
    let reads = 0
    probeReturns(async () => { reads++; return 900 * MB })
    setMemoryHostSpawner(scripted(['exit']).spawner)
    expect(await startMemoryHost({ userDataPath: tmp })).toBe('inproc')
    expect(inproc.inits).toBe(1)
    expect(reads).toBe(0) // off means off: not even the size is read
  })

  it('a size that cannot be read (null, or a throw) fails OPEN to today\'s behaviour', async () => {
    storeIs(null)
    setMemoryHostSpawner(scripted(['exit']).spawner)
    expect(await startMemoryHost({ userDataPath: tmp })).toBe('inproc')
    expect(inproc.inits).toBe(1)

    freshClient()
    probeReturns(async () => { throw new Error('EPERM: the folder is locked') })
    setMemoryHostSpawner(scripted(['exit']).spawner)
    expect(await startMemoryHost({ userDataPath: tmp })).toBe('inproc')
    expect(inproc.inits).toBe(1)
  })

  it('an explicit inProcess request, or no spawner wired at all, is honoured on any size', async () => {
    storeIs(900 * MB)
    expect(await startMemoryHost({ userDataPath: tmp, inProcess: true })).toBe('inproc')
    expect(inproc.inits).toBe(1)

    freshClient()
    storeIs(900 * MB)
    expect(await startMemoryHost({ userDataPath: tmp })).toBe('inproc') // no spawner: nothing could ever retry
    expect(inproc.inits).toBe(1)
  })

  it('a healthy start on a huge store is not changed: host mode, one spawn, no timer left behind', async () => {
    vi.useFakeTimers()
    storeIs(900 * MB)                              // huge, but the host starts fine
    const s = scripted(['ready'])
    setMemoryHostSpawner(s.spawner)
    expect(await startMemoryHost({ userDataPath: tmp })).toBe('host')
    expect(s.attempts()).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(s.attempts()).toBe(1)
    expect(inproc.inits).toBe(0)
  })
})
