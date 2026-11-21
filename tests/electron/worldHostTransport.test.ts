// The Lumopolis host transport: the one Electron-aware part of worldClient, against a stand-in utilityProcess.
import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

class FakeChild extends EventEmitter {
  pid: number | undefined = 4321
  postMessage = vi.fn()
  kill = vi.fn(() => true)
}

const { fork, killUtility, children } = vi.hoisted(() => ({ fork: vi.fn(), killUtility: vi.fn(), children: [] as unknown[] }))
vi.mock('electron', () => ({ app: { getPath: () => '/fake-userdata' }, utilityProcess: { fork } }))
vi.mock('../../src/main/utilityKill', () => ({ killUtility }))

import { createWorldHostTransport, resolveWorldHostPath } from '../../src/main/world/worldClient'

beforeEach(() => {
  fork.mockReset()
  killUtility.mockReset()
  children.length = 0
  fork.mockImplementation(() => {
    const c = new FakeChild()
    children.push(c)
    return c
  })
})

describe('createWorldHostTransport', () => {
  it('the host entry is worldHost.js next to the main bundle', () => {
    expect(resolveWorldHostPath()).toMatch(/[\\/]worldHost\.js$/)
  })

  it('forks the host as termpolis-lumopolis, at the bundled path unless given one', () => {
    createWorldHostTransport('/app/out/main/worldHost.js')
    expect(fork).toHaveBeenLastCalledWith('/app/out/main/worldHost.js', [], { serviceName: 'termpolis-lumopolis' })
    createWorldHostTransport()
    expect(fork).toHaveBeenLastCalledWith(resolveWorldHostPath(), [], { serviceName: 'termpolis-lumopolis' })
  })

  it('posts to the child, hands its messages and exit code over, reads its pid and stops it through killUtility', () => {
    const t = createWorldHostTransport('/h.js')
    const child = children[0] as FakeChild
    const msg = { id: 1, kind: 'get', root: '/r' } as unknown as Parameters<typeof t.postMessage>[0]
    t.postMessage(msg)
    expect(child.postMessage).toHaveBeenCalledWith(msg)
    const got: unknown[] = []
    const exits: number[] = []
    t.onMessage((m) => { got.push(m) })
    t.onExit((code) => { exits.push(code) })
    child.emit('message', { id: 1, ok: true })
    child.emit('exit', 3)
    expect(got).toEqual([{ id: 1, ok: true }])
    expect(exits).toEqual([3])
    expect(t.pid).toBe(4321)
    child.pid = undefined
    expect(t.pid).toBeUndefined()
    t.kill()
    expect(killUtility).toHaveBeenCalledWith(child)
  })

  it('a message the child cannot take fails with fixed text that never repeats the call arguments', () => {
    const t = createWorldHostTransport('/h.js')
    const child = children[0] as FakeChild
    const arg = { mode: 'token', value: 'neutral-value-4' }
    child.postMessage.mockImplementationOnce(() => {
      throw new Error(`could not clone ${JSON.stringify(arg)}`)
    })
    const msg = { kind: 'call', id: 1, fn: 'cloneSource', args: ['https://h/r.git', undefined, arg] } as unknown as Parameters<typeof t.postMessage>[0]
    let thrown: unknown
    try {
      t.postMessage(msg)
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(Error)
    const text = `${(thrown as Error).name} ${(thrown as Error).message} ${String((thrown as Error).stack)}`
    expect(text).not.toContain('neutral-value-4')
    expect(text).not.toContain('cloneSource')
    expect((thrown as Error).message).toBe('Lumopolis host could not take that request')
    expect((thrown as { cause?: unknown }).cause).toBeUndefined()
  })
})
