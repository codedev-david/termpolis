import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  setProxySpawner, startProxy, stopProxy, isProxyHealthy, getProxyPort, _resetProxyForTest, type ProxyTransport,
} from '../../src/main/headroomProxy/proxySupervisor'

/**
 * A child that has been replaced is not the child that serves. Its last words, a late "ready" or a
 * late error, describe nothing that is live, and must neither mark the new child healthy nor take its
 * health away: health is the current child's.
 */

interface Fake { send: (m: Record<string, unknown>) => void; exit: () => void }
let fakes: Fake[] = []

function spawner(): ProxyTransport {
  let onMsg: (m: unknown) => void = () => {}
  let onExit: (c: number) => void = () => {}
  const fake: Fake = { send: (m) => onMsg(m), exit: () => onExit(1) }
  fakes.push(fake)
  return {
    postMessage: (m: unknown) => { if ((m as { kind?: string })?.kind === 'init') onMsg({ kind: 'ready', port: (m as { port: number }).port }) },
    onMessage: (cb) => { onMsg = cb },
    onExit: (cb) => { onExit = cb },
    kill: () => {},
    pid: 1,
  }
}

describe('the supervisor and a replaced child', () => {
  beforeEach(() => { _resetProxyForTest(); fakes = []; setProxySpawner(spawner) })
  afterEach(() => { stopProxy(); _resetProxyForTest() })

  it('does not take the new child’s health away on the old one’s late error', () => {
    startProxy({ port: 7501 })
    fakes[0].exit() // the first child dies; a second is brought up and is healthy
    expect(fakes).toHaveLength(2)
    expect(isProxyHealthy()).toBe(true)
    fakes[0].send({ kind: 'error', message: 'late words of a child that is gone' })
    expect(isProxyHealthy()).toBe(true)
  })

  it('does not mark the proxy healthy on the old child’s late ready, nor move the port', () => {
    startProxy({ port: 7502 })
    fakes[0].exit()
    // The second child has failed since coming up.
    fakes[1].send({ kind: 'error', message: 'listen failed' })
    expect(isProxyHealthy()).toBe(false)
    fakes[0].send({ kind: 'ready', port: 9999 })
    expect(isProxyHealthy()).toBe(false)
    expect(getProxyPort()).toBe(7502)
  })

  it('does take the current child’s own error and ready, as before', () => {
    startProxy({ port: 7503 })
    expect(isProxyHealthy()).toBe(true)
    fakes[0].send({ kind: 'error', message: 'broke' })
    expect(isProxyHealthy()).toBe(false)
    fakes[0].send({ kind: 'ready', port: 7503 })
    expect(isProxyHealthy()).toBe(true)
  })

  it('ignores a message that is not an object, from either child', () => {
    startProxy({ port: 7504 })
    for (const junk of [null, undefined, 5, 'x']) expect(() => fakes[0].send(junk as never)).not.toThrow()
    expect(isProxyHealthy()).toBe(true)
  })
})
