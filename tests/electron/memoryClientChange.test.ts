// WPA fix round 1: memoryClient's change boundary (I3), a late reply after a timeout (I4), the coded timeout (I2), and the
// router riding the interactive lane (I4).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('electron', () => ({
  app: { getPath: () => '/fake' },
  utilityProcess: { fork: () => { throw new Error('utilityProcess.fork must not be called in unit tests') } },
}))

import { HOST_HANDLERS, type HostRequest, type HostResponse } from '../../src/main/memoryHost'
import * as client from '../../src/main/memoryClient'
import {
  startMemoryHost, setMemoryHostSpawner, _resetMemoryClientForTests, onMemoryChanged, MEMORY_CHANGING_CALLS,
  memoryCount, memoryWrite, memoryDelete, routerClassify, type MemoryHostTransport,
} from '../../src/main/memoryClient'
import { _resetForTests, _setEmbeddingsAvailable } from '../../src/main/swarmMemory'
import { isMemoryTimeout } from '../../src/main/hostLane'
import { setSafeStorage } from '../../src/main/secureKeyStore'

type HostCall = Extract<HostRequest, { kind: 'call' }>

function manualHost(answer: (c: HostCall) => HostResponse | null = () => null): {
  transport: MemoryHostTransport; posted: HostRequest[]; push: (m: HostResponse) => void; exit: (code?: number) => void
} {
  const posted: HostRequest[] = []
  let cb: ((m: HostResponse) => void) | null = null
  let exitCb: ((code: number) => void) | null = null
  const transport: MemoryHostTransport = {
    postMessage: (msg: HostRequest) => {
      posted.push(msg)
      if (msg.kind === 'init') { queueMicrotask(() => cb?.({ kind: 'ready', pid: 1, entries: 0 })); return }
      if (msg.kind !== 'call') return
      const res = answer(msg)
      if (res) queueMicrotask(() => cb?.(res))
    },
    onMessage: (c) => { cb = c },
    onExit: (c) => { exitCb = c },
    kill: () => {},
    pid: 1,
  }
  return { transport, posted, push: (m) => cb?.(m), exit: (code = 1) => exitCb?.(code) }
}

function captureLoud(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  vi.stubEnv('NODE_ENV', 'production')
  const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')) })
  return { lines, restore: () => { spy.mockRestore(); vi.unstubAllEnvs() } }
}

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memchange-'))
  _resetForTests()
  _resetMemoryClientForTests()
  _setEmbeddingsAvailable(false)
  setSafeStorage(null)
})
afterEach(() => {
  _resetMemoryClientForTests()
  _resetForTests()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
})

/** What each changing call is answered with so that it DID change something, and the arguments it is sent with. */
const CHANGED_ANSWER: Record<string, { args: unknown[]; result: unknown }> = {
  memoryForget: { args: [{}], result: 2 },
  memoryPruneCodePath: { args: ['src/a.ts'], result: 1 },
  memoryPatchProjects: { args: [[]], result: 3 },
  memoryReleaseSupersedes: { args: ['m1'], result: 1 },
  memorySupersedePass: { args: [{}], result: { considered: 4, minted: 1 } },
  compactSelfShard: { args: [{}], result: { compacted: true, before: 9, after: 3 } },
  memoryLink: { args: [{ from: 'a', to: 'b', relation: 'supersedes' }], result: null },
  memoryFeedback: { args: [{ id: 'a', helpful: false }], result: { id: 'a', used: 0 } },
}
/** The same calls answered so that nothing changed. */
const UNCHANGED_ANSWER: Record<string, { args: unknown[]; result: unknown }> = {
  memoryForget: { args: [{}], result: 0 },
  memoryPruneCodePath: { args: ['src/a.ts'], result: 0 },
  memoryPatchProjects: { args: [[]], result: 0 },
  memoryReleaseSupersedes: { args: ['m1'], result: 0 },
  memorySupersedePass: { args: [{}], result: { considered: 4, minted: 0 } },
  compactSelfShard: { args: [{}], result: { compacted: false, before: 9, after: 9 } },
  memoryLink: { args: [{ from: 'a', to: 'b', relation: 'causes' }], result: null },
  memoryFeedback: { args: [{ id: 'a', helpful: true }], result: { id: 'a', used: 1 } },
}

/** Send `fn` through the client's own call path (the boundary is inside it), answered with `result`. */
async function through(fn: string, args: unknown[], result: unknown, ok = true): Promise<string[]> {
  _resetMemoryClientForTests()
  const h = manualHost((c) => (ok
    ? { kind: 'result', id: c.id, ok: true, result }
    : { kind: 'result', id: c.id, ok: false, error: { name: 'Error', message: 'store refused' } }))
  setMemoryHostSpawner(() => h.transport)
  await startMemoryHost({ userDataPath: tmp })
  const seen: string[] = []
  onMemoryChanged((why) => seen.push(why))
  // Every changing call has a proxy that hands its arguments straight to call(); those with extra main-side steps are sent
  // the host fn they end in (adoptEncryptionKeyB64, startNewMemoryKeyB64) through a raw call below.
  const raw = (client as unknown as { _callForTests: (fn: string, args: unknown[]) => Promise<unknown> })._callForTests
  try { await raw(fn, args) } catch { /* a refusal is reported too */ }
  return seen
}

describe('memoryClient change boundary (WPA fix I3)', () => {
  it('every host call that can take a note out of a read, hide one, or change whether the store opens is on the boundary', () => {
    // A new delete path added to the host whitelist fails here until it is either on the boundary or listed below with why not.
    const looksChanging = /delete|archive|clear|forget|prune|supersed|import|reload|encrypt|key|passphrase|syncdir|patchproject|compact|link|feedback/i
    const notChanging: Record<string, string> = {
      memoryKnownHashes: 'a read: which hashes are stored',
      edgeKeysIncident: 'a read: the edge keys around some ids',
      exportGraphEdges: 'a read',
      exportMemorySnapshot: 'a read',
      searchArchive: 'a read of the archive',
      backfillCodeRefs: 'adds code references to a note; hides nothing',
      memoryHasHash: 'a read',
      consolidationCandidates: 'a read',
      persistMemoryIndex: 'writes the vector index to disk; what reads return is unchanged',
    }
    const missing = Object.keys(HOST_HANDLERS)
      .filter((fn) => looksChanging.test(fn) && !(fn in notChanging) && !MEMORY_CHANGING_CALLS.has(fn))
    expect(missing).toEqual([])
    for (const fn of MEMORY_CHANGING_CALLS) expect(typeof HOST_HANDLERS[fn], fn).toBe('function')
    // The four removal paths the review named are all on it.
    for (const fn of ['memoryDelete', 'memoryArchive', 'memorySupersedePass', 'memoryReleaseSupersedes']) expect(MEMORY_CHANGING_CALLS.has(fn)).toBe(true)
  })

  it('each changing call tells the listener when it changed something, and every one tells it when it fails', async () => {
    for (const fn of MEMORY_CHANGING_CALLS) {
      const a = CHANGED_ANSWER[fn] ?? { args: [], result: { ok: true } }
      expect(await through(fn, a.args, a.result), `${fn} changed`).toEqual([fn])
      expect(await through(fn, a.args, null, false), `${fn} failed`).toEqual([fn])
    }
  })

  it('a count of 0, a pass that minted nothing, a link that is not a supersession or helpful feedback changes nothing', async () => {
    for (const [fn, a] of Object.entries(UNCHANGED_ANSWER)) expect(await through(fn, a.args, a.result), fn).toEqual([])
  })

  it('a malformed answer to a counting call is reported (it may have changed something)', async () => {
    expect(await through('memoryForget', [{}], undefined)).toEqual(['memoryForget'])
    expect(await through('memorySupersedePass', [{}], null)).toEqual(['memorySupersedePass'])
    expect(await through('compactSelfShard', [{}], 'x')).toEqual(['compactSelfShard'])
    expect(await through('memoryLink', [], null)).toEqual([])
    expect(await through('memoryFeedback', [], null)).toEqual([])
  })

  it('a read or a write is not on the boundary: nothing is told', async () => {
    expect(await through('memoryList', [{}], [])).toEqual([])
    expect(await through('memoryWrite', [{ agentId: 'a', kind: 'fact', content: 'x' }], { id: 'n' })).toEqual([])
  })

  it('the exported proxies go through it: memoryDelete tells the listener', async () => {
    const h = manualHost((c) => ({ kind: 'result', id: c.id, ok: true, result: undefined }))
    setMemoryHostSpawner(() => h.transport)
    await startMemoryHost({ userDataPath: tmp })
    const seen: string[] = []
    const off = onMemoryChanged((why) => seen.push(why))
    await memoryDelete('m1')
    expect(seen).toEqual(['memoryDelete'])
    off()
    await memoryDelete('m2')
    expect(seen).toEqual(['memoryDelete']) // unsubscribed
  })

  it('a listener that throws does not stop the others or the call', async () => {
    const h = manualHost((c) => ({ kind: 'result', id: c.id, ok: true, result: undefined }))
    setMemoryHostSpawner(() => h.transport)
    await startMemoryHost({ userDataPath: tmp })
    const seen: string[] = []
    onMemoryChanged(() => { throw new Error('bad listener') })
    onMemoryChanged((why) => seen.push(why))
    await expect(memoryDelete('m1')).resolves.toBeUndefined()
    expect(seen).toEqual(['memoryDelete'])
  })

  it('the store starting, respawning or moving in-process tells the listener (it may come back locked)', async () => {
    const seen: string[] = []
    onMemoryChanged((why) => seen.push(why))
    let h = manualHost()
    setMemoryHostSpawner(() => h.transport)
    await startMemoryHost({ userDataPath: tmp })
    expect(seen).toEqual(['store restarted'])
    const first = h
    h = manualHost()
    first.exit(1) // a crash: the client respawns
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
    expect(seen).toEqual(['store restarted', 'store restarted'])
    _resetMemoryClientForTests()
    const again: string[] = []
    onMemoryChanged((why) => again.push(why))
    await startMemoryHost({ userDataPath: tmp, inProcess: true })
    expect(again).toEqual(['store restarted'])
  })
})

describe('memoryClient timeouts (WPA fix I2 and I4)', () => {
  it('a timeout rejects with the coded error, the message unchanged', async () => {
    const h = manualHost()
    setMemoryHostSpawner(() => h.transport)
    await startMemoryHost({ userDataPath: tmp })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const p = memoryCount().catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(60_000)
    const e = await p as Error
    expect(e.message).toBe('memory host timed out after 60000ms (fn "memoryCount")')
    expect(isMemoryTimeout(e)).toBe(true)
  })

  it('a write whose caller timed out still lands, and its late outcome is logged by name, never its content', async () => {
    const h = manualHost()
    setMemoryHostSpawner(() => h.transport)
    await startMemoryHost({ userDataPath: tmp })
    const loud = captureLoud()
    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const w = memoryWrite({ agentId: 'a', kind: 'fact', content: 'the secret plan for the walrus' }).catch((e: unknown) => e)
      const l = memoryCount().catch((e: unknown) => e)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(isMemoryTimeout(await w)).toBe(true)
      expect(isMemoryTimeout(await l)).toBe(true)
      const calls = h.posted.filter((m): m is HostCall => m.kind === 'call')
      h.push({ kind: 'result', id: calls[0].id, ok: true, result: { id: 'n1' } })
      h.push({ kind: 'result', id: calls[1].id, ok: false, error: { name: 'Error', message: 'x' } })
      h.push({ kind: 'result', id: calls[0].id, ok: true, result: { id: 'n1' } }) // a second late reply: said once only
      h.push({ kind: 'result', id: 9_999, ok: true, result: null }) // never asked: dropped silently
      const late = loud.lines.filter((x) => x.includes('late reply'))
      expect(late).toEqual([
        '[termpolis][memory] late reply: memoryWrite finished ok after its caller timed out',
        '[termpolis][memory] late reply: memoryCount finished with an error after its caller timed out',
      ])
      expect(loud.lines.join('\n')).not.toContain('walrus')
    } finally { loud.restore() }
  })

  it('a changing call that timed out fires the change boundary again when it really completes; a read that lands late does not (WPA fix round 2, R-M1)', async () => {
    const h = manualHost()
    setMemoryHostSpawner(() => h.transport)
    await startMemoryHost({ userDataPath: tmp })
    const seen: string[] = []
    onMemoryChanged((why) => seen.push(why))
    const loud = captureLoud()
    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const pass = client.memorySupersedePass({ max: 50 }).catch((e: unknown) => e)
      const count = memoryCount().catch((e: unknown) => e)
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(isMemoryTimeout(await pass)).toBe(true)
      expect(isMemoryTimeout(await count)).toBe(true)
      expect(seen).toEqual(['memorySupersedePass']) // the timeout itself fires once: the pass may already have changed something
      const calls = h.posted.filter((m): m is HostCall => m.kind === 'call')
      const passCall = calls.find((c) => c.fn === 'memorySupersedePass') as HostCall
      const countCall = calls.find((c) => c.fn === 'memoryCount') as HostCall
      h.push({ kind: 'result', id: countCall.id, ok: true, result: 3 })
      expect(seen).toEqual(['memorySupersedePass'])
      // The async pass kept minting after its caller gave up: a digest built in between is stale, so the late reply clears again.
      h.push({ kind: 'result', id: passCall.id, ok: true, result: { considered: 9, minted: 2 } })
      expect(seen).toEqual(['memorySupersedePass', 'memorySupersedePass'])
      h.push({ kind: 'result', id: passCall.id, ok: true, result: { considered: 9, minted: 2 } }) // a repeat: dropped
      expect(seen).toHaveLength(2)
    } finally { loud.restore() }
  })

  it('remembers at most 256 timed-out calls (the oldest forgotten first)', async () => {
    const h = manualHost()
    setMemoryHostSpawner(() => h.transport)
    await startMemoryHost({ userDataPath: tmp })
    const loud = captureLoud()
    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const all = Array.from({ length: 257 }, () => memoryCount().catch(() => null))
      await vi.advanceTimersByTimeAsync(60_000)
      await Promise.all(all)
      const calls = h.posted.filter((m): m is HostCall => m.kind === 'call')
      h.push({ kind: 'result', id: calls[0].id, ok: true, result: 1 }) // forgotten
      h.push({ kind: 'result', id: calls[256].id, ok: true, result: 1 }) // kept
      expect(loud.lines.filter((x) => x.includes('late reply'))).toHaveLength(1)
    } finally { loud.restore() }
  })
})

describe('the router rides the interactive lane (WPA fix I4)', () => {
  it('routerClassify is sent with lane interactive, its own two arguments unchanged', async () => {
    const h = manualHost((c) => ({ kind: 'result', id: c.id, ok: true, result: { cls: null, ms: 1 } }))
    setMemoryHostSpawner(() => h.transport)
    await startMemoryHost({ userDataPath: tmp })
    await routerClassify('/u', 'what branch am I on')
    const sent = h.posted.find((m): m is HostCall => m.kind === 'call' && m.fn === 'routerClassify') as HostCall
    expect(sent.lane).toBe('interactive')
    expect(sent.args).toEqual(['/u', 'what branch am I on'])
  })
  it('memoryWrite and memoryDelete take a route: the bulk callers send lane background, their arguments unchanged; with none, no lane (WPA fix round 3, R2-M1)', async () => {
    const h = manualHost((c) => ({ kind: 'result', id: c.id, ok: true, result: c.fn === 'memoryWrite' ? { id: 'n1' } : undefined }))
    setMemoryHostSpawner(() => h.transport)
    await startMemoryHost({ userDataPath: tmp })
    const input = { agentId: 'ingest', kind: 'note', content: 'a chunk' }
    await client.memoryWrite(input, { lane: 'background' })
    await client.memoryDelete('n1', undefined, { lane: 'background' })
    await client.memoryDelete('n2', { keepContentHash: true }, { lane: 'background' })
    await client.memoryWrite(input)
    await client.memoryDelete('n3')
    const sent = h.posted.filter((m): m is HostCall => m.kind === 'call' && (m.fn === 'memoryWrite' || m.fn === 'memoryDelete'))
    expect(sent.map((m) => [m.fn, m.args, m.lane])).toEqual([
      ['memoryWrite', [input], 'background'],
      ['memoryDelete', ['n1'], 'background'],
      ['memoryDelete', ['n2', { keepContentHash: true }], 'background'],
      ['memoryWrite', [input], undefined],
      ['memoryDelete', ['n3'], undefined],
    ])
  })
})

describe('the thin proxies hand their name and arguments to the host (backfill)', () => {
  it('each sends one call with its own fn and arguments, and hands back the answer', async () => {
    const h = manualHost((c) => ({ kind: 'result', id: c.id, ok: true, result: `r:${c.fn}` }))
    setMemoryHostSpawner(() => h.transport)
    await startMemoryHost({ userDataPath: tmp })
    const cases: Array<[string, () => Promise<unknown>, unknown[]]> = [
      ['graphStats', () => client.graphStats(), []],
      ['graphRelationStats', () => client.graphRelationStats(), []],
      ['graphCreatorStats', () => client.graphCreatorStats(), []],
      ['edgeKeysIncident', () => client.edgeKeysIncident(['a']), [['a']]],
      ['importGraphEdges', () => client.importGraphEdges('{}'), ['{}']],
      ['routerLearn', () => client.routerLearn('/u', 'hi', 'chat'), ['/u', 'hi', 'chat']],
      ['memoryReleaseSupersedes', () => client.memoryReleaseSupersedes('m1'), ['m1']],
      ['memoryKnownHashes', () => client.memoryKnownHashes(['h']), [['h']]],
      ['entrySimMatrix', () => client.entrySimMatrix(['x', 'y']), [['x', 'y']]],
      ['memoryDelete', () => client.memoryDelete('m9', { keepContentHash: true }), ['m9', { keepContentHash: true }]],
    ]
    for (const [fn, run, args] of cases) {
      expect(await run()).toBe(`r:${fn}`)
      const sent = h.posted.filter((m): m is HostCall => m.kind === 'call' && m.fn === fn)
      expect(sent).toHaveLength(1)
      expect(sent[0].args).toEqual(args)
    }
  })
})
