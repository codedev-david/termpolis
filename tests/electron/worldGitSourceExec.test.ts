import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

// A child that never closes after it is killed (a grandchild keeps its stderr open): the wrapper must
// still resolve once the grace period passes.
class FakeChild extends EventEmitter {
  stderr = new EventEmitter()
  kill = vi.fn()
}
let child: FakeChild

vi.mock('node:child_process', () => ({ spawn: () => child }))

afterEach(() => {
  vi.resetModules()
})

describe('nodeExecFile when the child does not close after a kill', () => {
  it('gives up after the grace period with what stderr said; a timeout then an abort kills once', async () => {
    child = new FakeChild()
    const { nodeExecFile } = await import('../../src/main/world/gitSource')
    const ctl = new AbortController()
    const p = nodeExecFile('git', [], { env: {}, timeout: 10, signal: ctl.signal, killGraceMs: 60 })
    child.stderr.emit('data', Buffer.from('fatal: partial'))
    await new Promise((r) => setTimeout(r, 30))
    ctl.abort()
    expect(await p).toEqual({ code: 1, stderr: 'fatal: partial' })
    expect(child.kill).toHaveBeenCalledTimes(1)
  })

  it('without any stderr the message says it was stopped; the default grace is used when none is given', async () => {
    child = new FakeChild()
    vi.useFakeTimers()
    try {
      const { nodeExecFile, KILL_GRACE_MS } = await import('../../src/main/world/gitSource')
      const ctl = new AbortController()
      const p = nodeExecFile('git', [], { env: {}, timeout: 60_000, signal: ctl.signal })
      ctl.abort()
      await vi.advanceTimersByTimeAsync(KILL_GRACE_MS)
      expect(await p).toEqual({ code: 1, stderr: 'it was stopped' })
    } finally {
      vi.useRealTimers()
    }
  })
})
