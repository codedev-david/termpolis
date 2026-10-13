// killUtility: a utilityProcess with no pid yet ignores kill(), so a stop that lands while it is
// starting has to wait for 'spawn' or the child is left running with nobody to stop it.
import { describe, it, expect, vi } from 'vitest'
import { killUtility, type KillableUtility } from '../../src/main/utilityKill'

function child(pid: number | undefined) {
  const spawnListeners: Array<() => void> = []
  const c = {
    pid,
    kill: vi.fn(() => c.pid !== undefined),
    once: vi.fn((_event: 'spawn', cb: () => void) => { spawnListeners.push(cb) }),
    spawn(newPid: number) { c.pid = newPid; for (const cb of spawnListeners.splice(0)) cb() },
  }
  return c
}

describe('killUtility', () => {
  it('kills a running child straight away', () => {
    const c = child(42)
    killUtility(c)
    expect(c.kill).toHaveBeenCalledTimes(1)
    expect(c.once).not.toHaveBeenCalled()
  })

  it('holds the kill for a child that has no pid yet, and sends it once the child spawns', () => {
    const c = child(undefined)
    killUtility(c)
    expect(c.kill).not.toHaveBeenCalled()
    c.spawn(7)
    expect(c.kill).toHaveBeenCalledTimes(1)
  })

  it('never throws, whether the kill fails now or after the spawn', () => {
    const now: KillableUtility = { pid: 1, kill: () => { throw new Error('gone') }, once: () => undefined }
    expect(() => killUtility(now)).not.toThrow()
    const later = child(undefined)
    later.kill.mockImplementation(() => { throw new Error('gone') })
    killUtility(later)
    expect(() => later.spawn(3)).not.toThrow()
    const noOnce: KillableUtility = { pid: undefined, kill: () => false, once: () => { throw new Error('closed') } }
    expect(() => killUtility(noOnce)).not.toThrow()
  })
})
