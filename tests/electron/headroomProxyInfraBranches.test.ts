import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/* The supervisor's pickFreePort() talks to a real OS socket, so the only way to exercise its
 * failure shapes (bind error, a non-TCP address) is to stand in for `net`. Nothing else in this
 * file's import graph touches `net`, so mocking it module-wide is safe. */
const netCtl = vi.hoisted(() => ({
  /** whatever srv.address() should answer with — TCP AddressInfo, a pipe string, or null */
  address: { address: '127.0.0.1', family: 'IPv4', port: 51515 } as unknown,
  failListen: false,
  closed: 0,
}))
vi.mock('net', () => ({
  createServer: () => {
    const handlers: Record<string, (() => void) | undefined> = {}
    return {
      on: (ev: string, cb: () => void) => { handlers[ev] = cb },
      listen: (_port: number, _host: string, cb: () => void) => {
        if (netCtl.failListen) { handlers.error?.(); return }
        cb()
      },
      address: () => netCtl.address,
      close: (cb: () => void) => { netCtl.closed += 1; cb() },
    }
  },
}))

const {
  setProxySpawner, onProxyResult, startProxy, stopProxy, isProxyHealthy, getProxyPort,
  getProxyEnv, setProxyMode, pickFreePort, _resetProxyForTest,
} = await import('../../src/main/headroomProxy/proxySupervisor')
type ProxyTransport = import('../../src/main/headroomProxy/proxySupervisor').ProxyTransport
type ProxyResultMsg = import('../../src/main/headroomProxy/proxySupervisor').ProxyResultMsg

const {
  recordProxyResult, summarizeProxySavings, currentProxyTotals, loadProxyBase, loadProxyBaseFromDisk,
  saveProxyTotalsToDisk, setProxyLedgerFlush, resetProxyLedger, resetProxyCounters,
} = await import('../../src/main/headroomProxy/proxyLedger')
const { ccrRetrieve, resetCcr } = await import('../../src/main/headroom/ccrStore')

/* ── supervisor ─────────────────────────────────────────────────────────────────────────────── */

interface FakeChild {
  posted: Array<Record<string, unknown>>
  killed: number
  /** child → parent IPC */
  send: (m: unknown) => void
  /** the child process died */
  exit: (code?: number) => void
  /** flip mid-test to simulate the IPC channel dying under a live child */
  postThrows: boolean
  killThrows: boolean
}

let children: FakeChild[] = []

/** Stand-in for the utilityProcess child. `autoReady` mirrors the real child, which answers
 *  `init` with `ready`; turn it off when a test needs to observe the pre-ready window. */
function makeSpawner(opts: { autoReady?: boolean; postThrows?: boolean; killThrows?: boolean } = {}) {
  return (): ProxyTransport => {
    let onMsg: (m: unknown) => void = () => {}
    let onExit: (c: number) => void = () => {}
    const child: FakeChild = {
      posted: [],
      killed: 0,
      send: (m) => onMsg(m),
      exit: (code = 1) => onExit(code),
      postThrows: !!opts.postThrows,
      killThrows: !!opts.killThrows,
    }
    children.push(child)
    return {
      postMessage: (m: unknown) => {
        if (child.postThrows) throw new Error('IPC channel closed')
        const msg = m as { kind?: string; port?: number }
        child.posted.push(msg as Record<string, unknown>)
        if (opts.autoReady !== false && msg?.kind === 'init') onMsg({ kind: 'ready', port: msg.port })
      },
      onMessage: (cb: (m: unknown) => void) => { onMsg = cb },
      onExit: (cb: (c: number) => void) => { onExit = cb },
      kill: () => { child.killed += 1; if (child.killThrows) throw new Error('ESRCH') },
      pid: 4242,
    }
  }
}

function initOf(child: FakeChild): Record<string, unknown> | undefined {
  return child.posted.find((m) => m.kind === 'init')
}

/** Drive the supervisor past MAX_RESTARTS so it parks on the 30s cooldown timer. */
function flapIntoCooldown(): void {
  for (let i = 0; i < 6; i++) children[children.length - 1].exit()
}

describe('proxy supervisor — degraded child + lifecycle edges', () => {
  beforeEach(() => {
    _resetProxyForTest()
    children = []
    setProxySpawner(makeSpawner())
  })
  afterEach(() => {
    _resetProxyForTest() // must run while fake timers are still installed so the cooldown is cleared
    vi.useRealTimers()
  })

  it('start with no spawner installed leaves the proxy unhealthy instead of throwing', () => {
    setProxySpawner(null) // headroom disabled / entry script missing → nothing to fork
    startProxy({ port: 7001 })
    expect(children).toHaveLength(0)
    expect(isProxyHealthy()).toBe(false)
    expect(getProxyEnv()).toBeNull() // Claude launches direct
  })

  it('a spawner that throws leaves the proxy unhealthy and stoppable', () => {
    setProxySpawner(() => { throw new Error('utilityProcess.fork failed') })
    startProxy({ port: 7002 })
    expect(isProxyHealthy()).toBe(false)
    expect(() => stopProxy()).not.toThrow() // transport is null — the optional kill must no-op
    expect(isProxyHealthy()).toBe(false)
  })

  it('an explicit upstream host is carried on init; a blank one falls back to the API default', () => {
    startProxy({ port: 7003, upstreamHost: 'proxy.internal.example' })
    expect(initOf(children[0])).toMatchObject({ upstreamHost: 'proxy.internal.example', port: 7003 })

    _resetProxyForTest(); children = []; setProxySpawner(makeSpawner())
    startProxy({ port: 7003, upstreamHost: '' })
    expect(initOf(children[0])).toMatchObject({ upstreamHost: 'api.anthropic.com' })
  })

  it('empty and unrecognised IPC frames are ignored without dropping health', () => {
    startProxy({ port: 7004 })
    expect(isProxyHealthy()).toBe(true)
    children[0].send(null)
    children[0].send(undefined)
    children[0].send({ kind: 'telemetry' }) // a kind this supervisor build does not handle
    expect(isProxyHealthy()).toBe(true)
    expect(getProxyPort()).toBe(7004)
  })

  it('a ready without a port keeps the requested port; a ready with one rebinds to it', () => {
    setProxySpawner(makeSpawner({ autoReady: false }))
    startProxy({ port: 7005 })
    expect(isProxyHealthy()).toBe(false) // not healthy until the child reports ready

    children[0].send({ kind: 'ready' })
    expect(isProxyHealthy()).toBe(true)
    expect(getProxyPort()).toBe(7005)

    // the child may have had to bind elsewhere (requested port taken) — that wins
    children[0].send({ kind: 'ready', port: 7105 })
    expect(getProxyPort()).toBe(7105)
    expect(getProxyEnv()).toEqual({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:7105',
      CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING: '1',
      ENABLE_TOOL_SEARCH: 'true',
    })
  })

  it('an error frame demotes to direct launches, and a later ready re-heals', () => {
    startProxy({ port: 7006 })
    children[0].send({ kind: 'error' })
    expect(isProxyHealthy()).toBe(false)
    expect(getProxyEnv()).toBeNull()

    children[0].send({ kind: 'ready', port: 7006 })
    expect(isProxyHealthy()).toBe(true)
    expect(getProxyEnv()).not.toBeNull()
  })

  it('results arriving with no consumer registered are dropped, not fatal', () => {
    onProxyResult(null) // nothing wired up yet (results can beat the main-process wiring)
    startProxy({ port: 7007 })
    expect(() => children[0].send({ kind: 'result', status: 200, stats: {}, usage: {}, stashes: [] })).not.toThrow()
    expect(isProxyHealthy()).toBe(true)
  })

  it('a throwing consumer does not poison the channel — later results still arrive', () => {
    const seen: number[] = []
    onProxyResult((r) => { seen.push(r.status); throw new Error('renderer window gone') })
    startProxy({ port: 7008 })
    children[0].send({ kind: 'result', status: 200, stats: {}, usage: {}, stashes: [] })
    children[0].send({ kind: 'result', status: 529, stats: {}, usage: {}, stashes: [] })
    expect(seen).toEqual([200, 529])
    expect(isProxyHealthy()).toBe(true) // one bad consumer must not take the proxy down
  })

  it('an init that cannot be delivered marks the proxy unhealthy rather than reporting a lie', () => {
    setProxySpawner(makeSpawner({ postThrows: true })) // child died between fork and init
    startProxy({ port: 7009 })
    expect(isProxyHealthy()).toBe(false)
    expect(getProxyEnv()).toBeNull()
  })

  it('a mode push that fails on a dying child is still carried on the next respawn', () => {
    startProxy({ port: 7010 })
    children[0].postThrows = true // channel collapsed but exit has not fired yet
    expect(() => setProxyMode('balanced')).not.toThrow()

    children[0].exit()
    expect(children).toHaveLength(2)
    expect(initOf(children[1])).toMatchObject({ mode: 'balanced' }) // mode survived the failed push
    expect(isProxyHealthy()).toBe(true)
  })

  it('a late exit from an already-stopped child does not resurrect the proxy', () => {
    startProxy({ port: 7011 })
    const first = children[0]
    stopProxy()
    first.exit() // the kill we just issued lands asynchronously
    expect(children).toHaveLength(1) // no respawn after an intentional shutdown
    expect(isProxyHealthy()).toBe(false)
  })

  it('after flapping it parks unhealthy, then self-heals when the cooldown elapses', () => {
    vi.useFakeTimers()
    startProxy({ port: 7012 })
    flapIntoCooldown()
    const spawnedWhileFlapping = children.length
    expect(isProxyHealthy()).toBe(false) // backed off — launches go direct meanwhile
    expect(getProxyEnv()).toBeNull()

    vi.advanceTimersByTime(29_000)
    expect(children).toHaveLength(spawnedWhileFlapping) // still cooling down

    vi.advanceTimersByTime(1_000)
    expect(children).toHaveLength(spawnedWhileFlapping + 1)
    expect(isProxyHealthy()).toBe(true) // recovered without a restart of the app
  })

  it('an explicit restart during the cooldown wins — the stale timer does not double-spawn', () => {
    vi.useFakeTimers()
    startProxy({ port: 7013 })
    flapIntoCooldown()

    startProxy({ port: 7113 }) // e.g. the user toggled Headroom off and back on
    expect(isProxyHealthy()).toBe(true)
    const afterManualRestart = children.length

    vi.advanceTimersByTime(60_000)
    expect(children).toHaveLength(afterManualRestart) // cooldown saw a healthy proxy and stood down
    expect(getProxyPort()).toBe(7113)
  })

  it('stopProxy cancels a pending cooldown so a stopped proxy never comes back', () => {
    vi.useFakeTimers()
    startProxy({ port: 7014 })
    flapIntoCooldown()
    stopProxy()
    const atStop = children.length

    vi.advanceTimersByTime(120_000)
    expect(children).toHaveLength(atStop)
    expect(isProxyHealthy()).toBe(false)
  })

  it('a kill that throws still leaves the supervisor cleanly stopped', () => {
    setProxySpawner(makeSpawner({ killThrows: true })) // child already reaped by the OS
    startProxy({ port: 7015 })
    expect(() => stopProxy()).not.toThrow()
    expect(children[0].killed).toBe(1)
    expect(isProxyHealthy()).toBe(false)
    expect(getProxyEnv()).toBeNull()
  })

  it('pickFreePort resolves the OS-assigned port and always closes the probe socket', async () => {
    netCtl.address = { address: '127.0.0.1', family: 'IPv4', port: 51515 }
    netCtl.failListen = false
    netCtl.closed = 0
    await expect(pickFreePort()).resolves.toBe(51515)
    expect(netCtl.closed).toBe(1) // probe socket released, or the proxy could never bind it
  })

  it('pickFreePort resolves 0 when the probe socket cannot bind', async () => {
    netCtl.failListen = true
    await expect(pickFreePort()).resolves.toBe(0)
    netCtl.failListen = false
  })

  it('pickFreePort resolves 0 when the address is not a TCP AddressInfo', async () => {
    netCtl.address = '\\\\.\\pipe\\something' // a pipe address has no numeric port
    await expect(pickFreePort()).resolves.toBe(0)

    netCtl.address = null // socket closed out from under us before we read the address
    await expect(pickFreePort()).resolves.toBe(0)
  })
})

/* ── ledger ─────────────────────────────────────────────────────────────────────────────────── */

function result(over: Record<string, unknown> = {}): ProxyResultMsg {
  return {
    kind: 'result',
    changed: true,
    stats: { trBlocks: 1, trOrigChars: 8000, trCompChars: 2000, images: 1, imgOrigBytes: 4000, imgCompBytes: 1000 },
    usage: { input_tokens: 8, cache_read_input_tokens: 78_824, cache_creation_input_tokens: 500, output_tokens: 100 },
    stashes: [{ token: 'hr_seed', original: 'seed original' }],
    status: 200,
    ...over,
  } as unknown as ProxyResultMsg
}

describe('proxy ledger — malformed results, flush wiring and on-disk baseline', () => {
  let dir = ''

  beforeEach(() => {
    resetProxyLedger()
    resetCcr()
    dir = mkdtempSync(join(tmpdir(), 'tp-proxy-ledger-'))
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('accumulates text and image savings across requests', () => {
    recordProxyResult(result())
    recordProxyResult(result())
    const s = summarizeProxySavings().session
    expect(s.requests).toBe(2)
    expect(s.textOrigTokens).toBe(4000) // 2 x ceil(8000/4)
    expect(s.textSavedTokens).toBe(3000) // 2 x ceil((8000-2000)/4)
    expect(s.savedPct).toBe(75)
    expect(s.images).toBe(2)
    expect(s.imageOrigBytes).toBe(8000)
    expect(s.imageSavedBytes).toBe(6000)
    expect(s.cacheReadTokens).toBe(157_648)
    expect(s.outputTokens).toBe(200)
  })

  it('never reports negative image savings when a re-encode grew the image', () => {
    recordProxyResult(result({ stats: { trOrigChars: 0, trCompChars: 0, images: 1, imgOrigBytes: 100, imgCompBytes: 900 } }))
    const s = summarizeProxySavings().session
    expect(s.imageOrigBytes).toBe(100)
    expect(s.imageSavedBytes).toBe(0)
  })

  it('a result with no stats or usage counts as a request and adds nothing', () => {
    // the proxy still reports results it could not parse a body for (streaming abort, non-JSON error)
    recordProxyResult({ kind: 'result', changed: false, status: 500, stashes: [] } as unknown as ProxyResultMsg)
    const s = summarizeProxySavings().session
    expect(s.requests).toBe(1)
    expect(s.textOrigTokens).toBe(0)
    expect(s.textSavedTokens).toBe(0)
    expect(s.images).toBe(0)
    expect(s.imageOrigBytes).toBe(0)
    expect(s.imageSavedBytes).toBe(0)
    expect(s.inputTokens).toBe(0)
    expect(s.outputTokens).toBe(0)
    expect(s.cacheReadTokens).toBe(0)
    expect(s.cacheCreationTokens).toBe(0)
    expect(s.savedPct).toBe(0) // no divide-by-zero on an empty denominator
  })

  it('a result whose stashes are missing is still recorded', () => {
    recordProxyResult(result({ stashes: undefined }))
    expect(summarizeProxySavings().session.requests).toBe(1)
  })

  it('one malformed stash does not abort the rest of the batch', () => {
    recordProxyResult(result({ stashes: [null, { token: 'hr_good', original: 'kept anyway' }] }))
    expect(ccrRetrieve('hr_good')).toBe('kept anyway') // retrieve_full still works for the good one
    expect(summarizeProxySavings().session.requests).toBe(1)
  })

  it('flushes once per recorded result', () => {
    const flush = vi.fn()
    setProxyLedgerFlush(flush)
    recordProxyResult(result())
    recordProxyResult(result())
    expect(flush).toHaveBeenCalledTimes(2)
    setProxyLedgerFlush(null)
  })

  it('a flush that throws never loses the in-memory accounting', () => {
    setProxyLedgerFlush(() => { throw new Error('ENOSPC') })
    expect(() => recordProxyResult(result())).not.toThrow()
    expect(summarizeProxySavings().session.requests).toBe(1)
    expect(summarizeProxySavings().session.textSavedTokens).toBe(1500)
    setProxyLedgerFlush(null)
  })

  it('resetProxyCounters keeps the flush wiring; resetProxyLedger drops it', () => {
    const flush = vi.fn()
    setProxyLedgerFlush(flush)

    resetProxyCounters() // live "reset lifetime savings" — must keep persisting afterwards
    recordProxyResult(result())
    expect(flush).toHaveBeenCalledTimes(1)

    resetProxyLedger() // test-only teardown — unwires the flush
    recordProxyResult(result())
    expect(flush).toHaveBeenCalledTimes(1)
  })

  it('round-trips the cumulative total through disk, leaving the new session at zero', () => {
    recordProxyResult(result())
    saveProxyTotalsToDisk(dir)
    const onDisk = JSON.parse(readFileSync(join(dir, 'proxy-totals.json'), 'utf8')) as Record<string, number>
    expect(onDisk.requests).toBe(1)
    expect(onDisk.textSavedTokens).toBe(1500)

    resetProxyLedger() // next app launch
    loadProxyBaseFromDisk(dir)
    const r = summarizeProxySavings()
    expect(r.session.requests).toBe(0) // this session has done nothing yet
    expect(r.cumulative.requests).toBe(1) // but lifetime savings survived the restart
    expect(r.cumulative.textSavedTokens).toBe(1500)
    expect(r.cumulative.savedPct).toBe(75)
    expect(currentProxyTotals().textOrigTokens).toBe(2000)
  })

  it('a missing ledger file leaves the in-memory baseline untouched', () => {
    loadProxyBase({ requests: 3 })
    loadProxyBaseFromDisk(join(dir, 'never-written')) // first ever launch
    expect(currentProxyTotals().requests).toBe(3)
  })

  it('a corrupt ledger file is ignored rather than crashing the launch', () => {
    writeFileSync(join(dir, 'proxy-totals.json'), '{"requests": 4, tru', 'utf8') // truncated by a hard kill
    loadProxyBase({ requests: 7 })
    expect(() => loadProxyBaseFromDisk(dir)).not.toThrow()
    expect(currentProxyTotals().requests).toBe(7)
  })

  it('a ledger file from an older schema fills the missing counters with zero', () => {
    writeFileSync(join(dir, 'proxy-totals.json'), JSON.stringify({ requests: 4, textSavedTokens: 100 }), 'utf8')
    loadProxyBaseFromDisk(dir)
    const t = currentProxyTotals()
    expect(t.requests).toBe(4)
    expect(t.textSavedTokens).toBe(100)
    expect(t.outputTokens).toBe(0) // absent in the old file → 0, not undefined/NaN
    expect(summarizeProxySavings().cumulative.savedPct).toBe(0) // no orig tokens recorded back then
  })

  it('a save onto a path occupied by a file is swallowed and does not clobber it', () => {
    const notADir = join(dir, 'occupied')
    writeFileSync(notADir, 'someone else owns this', 'utf8')
    recordProxyResult(result())
    expect(() => saveProxyTotalsToDisk(notADir)).not.toThrow()
    expect(readFileSync(notADir, 'utf8')).toBe('someone else owns this')
  })

  it('a save into a not-yet-created nested directory creates it', () => {
    const nested = join(dir, 'a', 'b', 'headroom') // userData/headroom on a fresh install
    mkdirSync(join(dir, 'a'), { recursive: true })
    recordProxyResult(result())
    saveProxyTotalsToDisk(nested)
    expect(JSON.parse(readFileSync(join(nested, 'proxy-totals.json'), 'utf8')).requests).toBe(1)
  })
})
