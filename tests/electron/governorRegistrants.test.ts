/**
 * The background pollers that stand down while the event loop struggles (1.54.5 hotfix, lane G).
 *
 * Registered here (files no other lane edits, and each provably safe to pause):
 *   - learningSignals: the 15 s git HEAD poll over the open projects (several sync reads per project per tick).
 *     Nothing is lost by skipping a tick: the poll compares HEAD with the sha it remembered, so a commit made
 *     while shed is seen on the first tick after calm.
 *   - the Headroom proxy supervisor's 30 s cooldown restart (a fork on main). While shed it re-arms instead of
 *     forking; Claude launches go direct (safe) in the meantime, exactly as during the cooldown itself.
 * (The updater's checks are in governorUpdater.test.ts, which needs its own electron mock.)
 *
 * Proof style: counters (fs reads, openProjects calls, forks), with a "control" per behaviour showing that
 * the same code does the work when the loop is calm.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'path'
import { startLearningSignals, stopLearningSignals, type LearningSignalDeps } from '../../src/main/learningSignals'
import { shedRegistry } from '../../src/main/loopGovernor'
import {
  setProxySpawner, startProxy, stopProxy, _resetProxyForTest,
} from '../../src/main/headroomProxy/proxySupervisor'
import type { WorkEvent } from '../../src/main/outcomeSignals'

const ROOT = join('/repo')
const GITDIR = join(ROOT, '.git')
const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

afterEach(() => {
  shedRegistry.setShed(false)
  vi.useRealTimers()
})

// ── learningSignals ─────────────────────────────────────────────────

function repo(sha: string) {
  const files = new Map<string, string>([
    [join(GITDIR, 'HEAD'), 'ref: refs/heads/main\n'],
    [join(GITDIR, 'refs', 'heads', 'main'), `${sha}\n`],
  ])
  const dirs = new Set<string>([GITDIR])
  const reads = { exists: 0, read: 0 }
  return {
    files, reads,
    existsSync: (p: string) => { reads.exists++; return files.has(p) || dirs.has(p) },
    readFileSync: (p: string) => {
      reads.read++
      if (!files.has(p)) throw new Error(dirs.has(p) ? `EISDIR: ${p}` : `ENOENT: ${p}`)
      return files.get(p) as string
    },
  }
}

function learning() {
  const fs = repo(SHA_A)
  const emitted: WorkEvent[] = []
  let ticker: (() => void) | null = null
  const openProjects = vi.fn(() => [ROOT])
  const deps: LearningSignalDeps = {
    openProjects,
    cwdForTerminal: () => ROOT,
    normalizeProject: () => 'repo',
    emit: (e) => { emitted.push(e) },
    subscribe: () => () => {},
    fs,
    readBytes: () => new Uint8Array(),
    setInterval: (fn) => { ticker = fn; return 0 as unknown as ReturnType<typeof setInterval> },
    clearInterval: () => { ticker = null },
  }
  startLearningSignals(deps)
  return { fs, emitted, openProjects, tick: () => ticker?.() }
}

describe('learningSignals: the git HEAD poll stands down while shed', () => {
  beforeEach(() => stopLearningSignals())
  afterEach(() => stopLearningSignals())

  it('control: calm, a tick lists the open projects and reads the repo', () => {
    const h = learning()
    h.tick()
    expect(h.openProjects).toHaveBeenCalledTimes(1)
    expect(h.fs.reads.read).toBeGreaterThan(0)
  })

  it('shed: ticks do ZERO work (no project listing, no existsSync, no readFileSync)', () => {
    const h = learning()
    shedRegistry.setShed(true)
    const before = { ...h.fs.reads }
    for (let i = 0; i < 10; i++) h.tick()
    expect(h.openProjects).not.toHaveBeenCalled()
    expect(h.fs.reads).toEqual(before)
  })

  it('a commit made WHILE shed is not lost: the first calm tick sees it', () => {
    const h = learning()
    h.tick() // seeds silently at SHA_A
    shedRegistry.setShed(true)
    h.fs.files.set(join(GITDIR, 'refs', 'heads', 'main'), `${SHA_B}\n`) // the user commits
    h.tick(); h.tick()
    expect(h.emitted).toEqual([])
    shedRegistry.setShed(false)
    h.tick()
    expect(h.emitted).toHaveLength(1)
    expect(h.emitted[0]).toMatchObject({ kind: 'git-commit' })
  })

  it('registers one entry in the registry and removes it on stop (control: no leak across start/stop cycles)', () => {
    expect(shedRegistry.names().filter((n) => n.startsWith('learningSignals'))).toEqual([])
    learning()
    expect(shedRegistry.names().filter((n) => n.startsWith('learningSignals'))).toHaveLength(1)
    learning() // "starting again replaces the previous run"
    expect(shedRegistry.names().filter((n) => n.startsWith('learningSignals'))).toHaveLength(1)
    stopLearningSignals()
    expect(shedRegistry.names().filter((n) => n.startsWith('learningSignals'))).toEqual([])
  })
})

// ── the proxy supervisor's cooldown restart ───────────────────────────

interface FakeChild { fireExit: () => void }
let children: FakeChild[] = []

function spawner(): unknown {
  let msgCb: (m: unknown) => void = () => {}
  let exitCb: (c: number) => void = () => {}
  const child: FakeChild = { fireExit: () => exitCb(1) }
  children.push(child)
  return {
    postMessage: (m: { kind?: string; port?: number }) => { if (m?.kind === 'init') msgCb({ kind: 'ready', port: m.port }) },
    onMessage: (cb: (m: unknown) => void) => { msgCb = cb },
    onExit: (cb: (c: number) => void) => { exitCb = cb },
    kill: () => {},
    pid: 1,
  }
}

/** Start the proxy and kill it until the supervisor gives up (the 5th exit inside a minute), leaving the 30 s cooldown armed. */
function flapUntilCooldown(): void {
  startProxy({ port: 9999 })
  for (let i = 0; i < 5; i++) children[children.length - 1].fireExit()
}

describe('proxy supervisor: the cooldown restart (a fork on main) stands down while shed', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    children = []
    _resetProxyForTest()
    setProxySpawner(spawner)
  })
  afterEach(() => { stopProxy(); _resetProxyForTest() })

  it('control: calm, the cooldown ends after 30 s with exactly one new fork', () => {
    flapUntilCooldown()
    expect(children).toHaveLength(5) // the first child + 4 restarts, then it gave up
    vi.advanceTimersByTime(29_999)
    expect(children).toHaveLength(5)
    vi.advanceTimersByTime(1)
    expect(children).toHaveLength(6)
  })

  it('shed: no fork, however long the cooldown ends up lasting; the first calm cooldown after it forks once', () => {
    flapUntilCooldown()
    shedRegistry.setShed(true)
    vi.advanceTimersByTime(30_000 * 10)
    expect(children).toHaveLength(5)
    shedRegistry.setShed(false)
    vi.advanceTimersByTime(29_999)
    expect(children).toHaveLength(5)
    vi.advanceTimersByTime(1)
    expect(children).toHaveLength(6)
  })

  it('an ordinary crash restart is NOT delayed by SHED: a dead proxy would break every live Claude session pinned to its port', () => {
    startProxy({ port: 9999 })
    shedRegistry.setShed(true)
    children[0].fireExit()
    expect(children).toHaveLength(2)
  })

  it('stopProxy and the test reset leave nothing registered', () => {
    flapUntilCooldown()
    expect(shedRegistry.names().some((n) => n.startsWith('headroomProxy'))).toBe(true)
    stopProxy()
    _resetProxyForTest()
    expect(shedRegistry.names().some((n) => n.startsWith('headroomProxy'))).toBe(false)
  })
})
