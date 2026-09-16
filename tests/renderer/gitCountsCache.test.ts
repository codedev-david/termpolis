import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../src/renderer/src/lib/pollingService', () => ({
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
}))

import { subscribe, unsubscribe } from '../../src/renderer/src/lib/pollingService'
import {
  subscribeCounts,
  resetCountsRegistry,
  COUNTS_POLL_MS,
} from '../../src/renderer/src/lib/gitCountsCache'

const ok = (patch: Record<string, any> = {}) => ({
  success: true,
  data: { branch: 'main', ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, ...patch },
})

/** Run whatever pollingService was handed for `cwd`, as the 1s base tick would. */
const tickFor = (cwd: string) => {
  const call = (subscribe as any).mock.calls.filter((c: any[]) => c[0] === `git-counts-${cwd}`).pop()
  if (!call) throw new Error(`nothing subscribed for ${cwd}`)
  call[1]()
}

// A macrotask, not `await Promise.resolve()`: the fetch chain is several `.then` hops
// deep, so a microtask or two lands mid-chain and reads half-finished state.
const settle = () => new Promise(r => setTimeout(r, 0))

describe('shared per-repo git counts', () => {
  let bridge: ReturnType<typeof vi.fn>

  beforeEach(() => {
    // Reset BEFORE clearing: tearing down the previous test's pollers itself calls
    // unsubscribe, and those calls would otherwise be counted against this test.
    resetCountsRegistry()
    vi.clearAllMocks()
    bridge = vi.fn().mockResolvedValue(ok())
    ;(globalThis as any).window = { termpolis: { gitChangeCounts: bridge } }
  })

  afterEach(() => {
    delete (globalThis as any).window
  })

  // The bug this exists for. Every terminal carries a git dot, each dot polled on its
  // own subscription keyed by terminal id, so ten terminals open on one repo spawned
  // ten identical `git status` processes every five seconds — on Windows, ~100-300ms of
  // process-creation tax each. The repo does not have ten different answers.
  it('spawns one git per repo per tick no matter how many terminals watch it', async () => {
    subscribeCounts('/repo', vi.fn())
    subscribeCounts('/repo', vi.fn())
    subscribeCounts('/repo', vi.fn())
    await settle()

    // One immediate fetch at first subscribe — not one per subscriber.
    expect(bridge).toHaveBeenCalledTimes(1)

    tickFor('/repo')
    await settle()
    expect(bridge).toHaveBeenCalledTimes(2)
  })

  it('registers exactly one poller for a repo, at the dot cadence', () => {
    subscribeCounts('/repo', vi.fn())
    subscribeCounts('/repo', vi.fn())

    const mine = (subscribe as any).mock.calls.filter((c: any[]) => c[0] === 'git-counts-/repo')
    expect(mine).toHaveLength(1)
    expect(mine[0][2]).toBe(COUNTS_POLL_MS)
  })

  it('gives every watcher of a repo the same answer', async () => {
    const a = vi.fn()
    const b = vi.fn()
    subscribeCounts('/repo', a)
    subscribeCounts('/repo', b)
    tickFor('/repo')
    await settle()

    expect(a).toHaveBeenCalledWith(expect.objectContaining({ branch: 'main' }))
    expect(b).toHaveBeenCalledWith(expect.objectContaining({ branch: 'main' }))
  })

  // Sharing is per repo, not global — two projects must not read each other's status.
  it('keeps separate repos separate', async () => {
    subscribeCounts('/repo-a', vi.fn())
    subscribeCounts('/repo-b', vi.fn())
    await settle()

    expect(bridge).toHaveBeenCalledTimes(2)
    expect(bridge.mock.calls.map(c => c[0]).sort()).toEqual(['/repo-a', '/repo-b'])
  })

  // A terminal that joins an already-watched repo should not have to wait up to five
  // seconds staring at the inert glyph when the answer is already known.
  it('hands a late joiner the answer already on hand, without a new spawn', async () => {
    subscribeCounts('/repo', vi.fn())
    await settle()
    expect(bridge).toHaveBeenCalledTimes(1)

    const late = vi.fn()
    subscribeCounts('/repo', late)
    expect(late).toHaveBeenCalledWith(expect.objectContaining({ branch: 'main' }))
    expect(bridge).toHaveBeenCalledTimes(1)
  })

  it('stops polling a repo once its last watcher leaves', async () => {
    const offA = subscribeCounts('/repo', vi.fn())
    const offB = subscribeCounts('/repo', vi.fn())

    offA()
    expect(unsubscribe).not.toHaveBeenCalledWith('git-counts-/repo')

    offB()
    expect(unsubscribe).toHaveBeenCalledWith('git-counts-/repo')
  })

  it('never calls back a watcher that has already left', async () => {
    const gone = vi.fn()
    const off = subscribeCounts('/repo', gone)
    off()
    tickFor('/repo')
    await settle()
    expect(gone).not.toHaveBeenCalled()
  })

  it('reports null when git says this is not a repo', async () => {
    bridge.mockResolvedValue({ success: false })
    const cb = vi.fn()
    subscribeCounts('/not-a-repo', cb)
    await settle()
    expect(cb).toHaveBeenCalledWith(null)
  })

  it('reports null when the call rejects, and keeps polling afterwards', async () => {
    bridge.mockRejectedValueOnce(new Error('git exploded'))
    const cb = vi.fn()
    subscribeCounts('/repo', cb)
    await settle()
    expect(cb).toHaveBeenCalledWith(null)

    bridge.mockResolvedValue(ok({ staged: 2 }))
    tickFor('/repo')
    await settle()
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ staged: 2 }))
  })

  it('does nothing at all without a cwd or without a bridge', async () => {
    const cb = vi.fn()
    subscribeCounts('', cb)
    expect(subscribe).not.toHaveBeenCalledWith('git-counts-', expect.anything(), expect.anything())

    ;(globalThis as any).window = {}
    subscribeCounts('/repo', cb)
    await settle()
    expect(bridge).not.toHaveBeenCalled()
  })
})
