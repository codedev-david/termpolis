/**
 * The `processes:` IPC surface. The engine itself is tested in stuckProcesses.test.ts; this
 * file holds the boundary: malformed renderer input is refused before it reaches the engine,
 * errors come back as { success: false } instead of rejecting, and overlapping scans share
 * one PowerShell run.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { StuckScan, StuckKillResult } from '../../src/main/stuckProcesses'

const engine = vi.hoisted(() => ({
  scanStuckProcesses: vi.fn(),
  killStuckProcesses: vi.fn(),
}))
vi.mock('../../src/main/stuckProcesses', () => engine)

import { registerStuckProcessIpc, type StuckProcessIpcLike } from '../../src/main/stuckProcessIpc'

type Handler = (event: unknown, input?: unknown) => unknown

function fakeIpc(): { ipc: StuckProcessIpcLike; channels: () => string[]; call: (channel: string, input?: unknown) => any } {
  const handlers = new Map<string, Handler>()
  return {
    ipc: { handle: (channel, listener) => void handlers.set(channel, listener) },
    channels: () => [...handlers.keys()],
    call: (channel, input) => {
      const h = handlers.get(channel)
      if (!h) throw new Error(`no handler registered for ${channel}`)
      return h({}, input)
    },
  }
}

const SCAN: StuckScan = { processes: [], scannedAt: 1, platform: 'win32', totalProcesses: 3, warnings: [] }
const KILLED: StuckKillResult = { killed: [7], failed: [], skipped: [] }

describe('stuckProcessIpc', () => {
  beforeEach(() => {
    engine.scanStuckProcesses.mockReset()
    engine.killStuckProcesses.mockReset()
  })

  it('registers the scan and the kill channel', () => {
    const f = fakeIpc()
    registerStuckProcessIpc(f.ipc)
    expect(f.channels().sort()).toEqual(['processes:kill-stuck', 'processes:scan-stuck'])
  })

  it('scans with the real engine by default', async () => {
    engine.scanStuckProcesses.mockResolvedValue(SCAN)
    const f = fakeIpc()
    registerStuckProcessIpc(f.ipc)
    expect(await f.call('processes:scan-stuck')).toEqual({ success: true, data: SCAN })
    expect(engine.scanStuckProcesses).toHaveBeenCalledTimes(1)
  })

  it('kills with the real engine by default, passing the targets through untouched', async () => {
    engine.killStuckProcesses.mockResolvedValue(KILLED)
    const f = fakeIpc()
    registerStuckProcessIpc(f.ipc)
    const targets = [{ pid: 7, created: 100 }]
    expect(await f.call('processes:kill-stuck', { targets })).toEqual({ success: true, data: KILLED })
    // The engine validates the entries itself, against a fresh scan.
    expect(engine.killStuckProcesses).toHaveBeenCalledWith(targets, {}, { stuckOnly: false })
    await f.call('processes:kill-stuck', { targets, stuckOnly: true })
    expect(engine.killStuckProcesses).toHaveBeenLastCalledWith(targets, {}, { stuckOnly: true })
  })

  it('re-checks "still stuck" only when the renderer asks with a literal true', async () => {
    const kill = vi.fn().mockResolvedValue(KILLED)
    const f = fakeIpc()
    registerStuckProcessIpc(f.ipc, { kill })
    const targets = [{ pid: 7, created: 100 }]
    const cases: Array<[unknown, boolean]> = [
      [undefined, false],
      [false, false],
      [true, true],
      // Only a literal true narrows the kill. A malformed flag falls back to ending exactly the
      // targets the user picked, which are still re-checked for exit and pid reuse either way.
      ['true', false],
      [1, false],
      [{}, false],
    ]
    for (const [stuckOnly, expected] of cases) {
      expect(await f.call('processes:kill-stuck', { targets, stuckOnly })).toEqual({ success: true, data: KILLED })
      expect(kill).toHaveBeenLastCalledWith(targets, { stuckOnly: expected })
    }
    expect(kill).toHaveBeenCalledTimes(cases.length)
  })

  it('shares one scan between overlapping requests, then scans afresh', async () => {
    let release: (s: StuckScan) => void = () => {}
    const scan = vi.fn(() => new Promise<StuckScan>((resolve) => (release = resolve)))
    const f = fakeIpc()
    registerStuckProcessIpc(f.ipc, { scan })
    const a = f.call('processes:scan-stuck')
    const b = f.call('processes:scan-stuck')
    release(SCAN)
    expect(await a).toEqual({ success: true, data: SCAN })
    expect(await b).toEqual({ success: true, data: SCAN })
    expect(scan).toHaveBeenCalledTimes(1)

    const c = f.call('processes:scan-stuck')
    release({ ...SCAN, totalProcesses: 4 })
    expect(await c).toEqual({ success: true, data: { ...SCAN, totalProcesses: 4 } })
    expect(scan).toHaveBeenCalledTimes(2)
  })

  it('reports a failed scan as an error result, and does not cache the failure', async () => {
    const scan = vi.fn().mockRejectedValueOnce(new Error('Could not list processes: boom')).mockRejectedValueOnce('plain').mockResolvedValue(SCAN)
    const f = fakeIpc()
    registerStuckProcessIpc(f.ipc, { scan })
    expect(await f.call('processes:scan-stuck')).toEqual({ success: false, error: 'Could not list processes: boom' })
    expect(await f.call('processes:scan-stuck')).toEqual({ success: false, error: 'plain' })
    expect(await f.call('processes:scan-stuck')).toEqual({ success: true, data: SCAN })
  })

  it('reports a scan that throws synchronously as an error result', async () => {
    const f = fakeIpc()
    registerStuckProcessIpc(f.ipc, {
      scan: () => {
        throw new Error('sync')
      },
    })
    expect(await f.call('processes:scan-stuck')).toEqual({ success: false, error: 'sync' })
  })

  it('refuses a kill request that is not { targets: [...] } without calling the engine', async () => {
    const kill = vi.fn()
    const f = fakeIpc()
    registerStuckProcessIpc(f.ipc, { kill })
    for (const input of [undefined, null, [], [{ pid: 1, created: 1 }], 'targets', { targets: 'all' }, { targets: {} }]) {
      expect(await f.call('processes:kill-stuck', input)).toEqual({ success: false, error: 'A list of processes to end is required' })
    }
    expect(kill).not.toHaveBeenCalled()
  })

  it('reports a failed kill as an error result', async () => {
    const kill = vi.fn().mockRejectedValueOnce(new Error('Each process to end needs a pid and a start time')).mockRejectedValueOnce(42)
    const f = fakeIpc()
    registerStuckProcessIpc(f.ipc, { kill })
    expect(await f.call('processes:kill-stuck', { targets: [{}] })).toEqual({
      success: false,
      error: 'Each process to end needs a pid and a start time',
    })
    expect(await f.call('processes:kill-stuck', { targets: [] })).toEqual({ success: false, error: '42' })
  })
})
