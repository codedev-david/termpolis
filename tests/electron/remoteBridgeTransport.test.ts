import { describe, it, expect, beforeEach, vi } from 'vitest'

/** One forked child, recorded rather than spawned. */
const forks: Array<{
  path: string
  args: string[]
  opts: { serviceName?: string; env?: Record<string, string | undefined> }
  listeners: Record<string, (arg: unknown) => void>
  posted: unknown[]
  killed: number
  killThrows: boolean
}> = []

vi.mock('electron', () => ({
  utilityProcess: {
    fork(path: string, args: string[], opts: Record<string, unknown>) {
      const child = {
        path,
        args,
        opts: opts as { serviceName?: string; env?: Record<string, string | undefined> },
        listeners: {} as Record<string, (arg: unknown) => void>,
        posted: [] as unknown[],
        killed: 0,
        killThrows: false,
        on(event: string, cb: (arg: unknown) => void) {
          child.listeners[event] = cb
        },
        postMessage(msg: unknown) {
          child.posted.push(msg)
        },
        kill() {
          child.killed++
          if (child.killThrows) throw new Error('already gone')
        },
      }
      forks.push(child)
      return child
    },
  },
}))

const { createRemoteBridgeTransport } = await import('../../src/main/remoteBridgeSupervisor')

beforeEach(() => {
  forks.length = 0
  delete process.env.TERMPOLIS_RELAY_URL
})

describe('createRemoteBridgeTransport', () => {
  it('hands the relay URL to the child through the environment', () => {
    // The child reads TERMPOLIS_RELAY_URL at bootstrap and has no other way to
    // learn where to dial. Without this the relay setting is inert: the user
    // changes it, the field saves, and every device keeps using the default.
    createRemoteBridgeTransport('/bridge.js', 'wss://relay.example/ws')
    expect(forks[0].opts.env?.TERMPOLIS_RELAY_URL).toBe('wss://relay.example/ws')
  })

  it('passes the rest of the parent environment through', () => {
    // The child is a Node process: PATH, TMPDIR and the Electron run-time vars
    // all matter to it. Replacing the environment rather than extending it is a
    // failure that shows up as a bridge that will not start, with no message.
    process.env.TERMPOLIS_TRANSPORT_PROBE = 'kept'
    createRemoteBridgeTransport('/bridge.js', 'wss://relay.example/ws')
    expect(forks[0].opts.env?.TERMPOLIS_TRANSPORT_PROBE).toBe('kept')
    delete process.env.TERMPOLIS_TRANSPORT_PROBE
  })

  it('leaves the variable unset when no relay URL is given', () => {
    // Unset and not empty-string: the child falls back to DEFAULT_RELAY_URL with
    // `?? `, which an empty string would pass straight through as a URL nothing
    // can dial.
    createRemoteBridgeTransport('/bridge.js')
    expect(forks[0].opts.env?.TERMPOLIS_RELAY_URL).toBeUndefined()
  })

  it('names the service so it is identifiable in a process list', () => {
    createRemoteBridgeTransport('/bridge.js')
    expect(forks[0].opts.serviceName).toBe('termpolis-remote-bridge')
  })

  it('forwards postMessage and both event kinds to the child', () => {
    // GOTCHA this wiring exists to get right: in the PARENT the payload arrives
    // directly, while in the CHILD it is `e.data`. Unwrapping on both sides makes
    // every message undefined -- which looks like a phone that paired and then
    // never responded.
    const handle = createRemoteBridgeTransport('/bridge.js')
    handle.postMessage({ kind: 'cancelPairing' })
    expect(forks[0].posted).toEqual([{ kind: 'cancelPairing' }])

    const messages: unknown[] = []
    const exits: unknown[] = []
    handle.on('message', (m) => messages.push(m))
    handle.on('exit', (c) => exits.push(c))
    forks[0].listeners.message({ kind: 'ready' })
    forks[0].listeners.exit(0)
    expect(messages).toEqual([{ kind: 'ready' }])
    expect(exits).toEqual([0])
  })

  it('swallows a kill on a child that is already gone', () => {
    // The supervisor kills on shutdown and on restart, and a child that crashed
    // a moment earlier throws. An unhandled throw there takes down app quit.
    const handle = createRemoteBridgeTransport('/bridge.js')
    forks[0].killThrows = true
    expect(() => handle.kill()).not.toThrow()
    expect(forks[0].killed).toBe(1)
  })
})
