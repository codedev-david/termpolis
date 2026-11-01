import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  setProxySpawner, startProxy, stopProxy, setProxyMode, setProxyThinkingCap, setProxyDecay,
  setProxyFirstSight, getProxyFirstSight, _resetProxyForTest, type ProxyTransport,
} from '../../src/main/headroomProxy/proxySupervisor'
import { armForBody } from '../../src/main/headroom/elisionPolicy'

/**
 * The first-sight policy rides the same channel as the tier and prefix decay: the main process
 * pushes it, the supervisor holds it and sends it on every init and config frame, and the proxy
 * child takes the first usable one and keeps it. The child serves every Claude session of an app
 * run, so the policy MUST NOT change while it runs: a change rewrites every cached prefix.
 */

interface FakeChild { posted: Array<Record<string, unknown>>; exit: () => void; failPost: boolean }
let children: FakeChild[] = []
let failFirstPost = false

function spawner(): ProxyTransport {
  let onMsg: (m: unknown) => void = () => {}
  let onExit: (c: number) => void = () => {}
  const child: FakeChild = { posted: [], exit: () => onExit(1), failPost: failFirstPost }
  failFirstPost = false
  children.push(child)
  return {
    postMessage: (m: unknown) => {
      if (child.failPost) throw new Error('post failed')
      child.posted.push(m as Record<string, unknown>)
      if ((m as { kind?: string })?.kind === 'init') onMsg({ kind: 'ready', port: (m as { port: number }).port })
    },
    onMessage: (cb) => { onMsg = cb },
    onExit: (cb) => { onExit = cb },
    kill: () => {},
    pid: 1,
  }
}
const initOf = (c: FakeChild): Record<string, unknown> | undefined => c.posted.find((m) => m.kind === 'init')
const configsOf = (c: FakeChild): Array<Record<string, unknown>> => c.posted.filter((m) => m.kind === 'config')

describe('the supervisor and the first-sight policy', () => {
  beforeEach(() => {
    _resetProxyForTest()
    setProxyThinkingCap(0)
    setProxyDecay(false)
    children = []
    failFirstPost = false
    setProxySpawner(spawner)
  })
  afterEach(() => { stopProxy(); _resetProxyForTest() })

  it('is legacy on the first init when nothing has set it: a failure to read settings never turns it on', () => {
    startProxy({ port: 7401 })
    expect(initOf(children[0])).toMatchObject({ kind: 'init', firstSight: 'legacy' })
    expect(getProxyFirstSight()).toBe('legacy')
  })

  it('carries a policy set before the child exists on its very first init', () => {
    setProxyFirstSight('late')
    expect(getProxyFirstSight()).toBe('late')
    startProxy({ port: 7402 })
    expect(initOf(children[0])).toMatchObject({ firstSight: 'late' })
  })

  it('keeps the first usable policy for the whole run: a later one, a Settings flip, changes nothing', () => {
    setProxyFirstSight('late')
    setProxyFirstSight('legacy')
    expect(getProxyFirstSight()).toBe('late')
    startProxy({ port: 7403 })
    setProxyFirstSight('legacy')
    expect(getProxyFirstSight()).toBe('late')
    expect(configsOf(children[0]).some((c) => c.firstSight === 'legacy')).toBe(false)
  })

  it('does not spend the one resolution on a value that is not a policy', () => {
    for (const bad of [undefined, null, '', 'Late', 'off', 0, 1, {}, [], true]) setProxyFirstSight(bad)
    expect(getProxyFirstSight()).toBe('legacy')
    setProxyFirstSight('late')
    expect(getProxyFirstSight()).toBe('late')
  })

  it('once a child has been handed the default, that is the policy for the run', () => {
    // The child freezes whatever its first init carries, so the supervisor must say the same thing
    // about what is in force, or Settings would report a policy nothing is running.
    startProxy({ port: 7404 })
    setProxyFirstSight('late')
    expect(getProxyFirstSight()).toBe('legacy')
  })

  it('re-carries the same policy on the init of every respawn', () => {
    setProxyFirstSight('late')
    startProxy({ port: 7405 })
    setProxyFirstSight('legacy') // the user flips the switch while it runs
    children[0].exit() // the child dies; the supervisor spawns another
    expect(children).toHaveLength(2)
    expect(initOf(children[1])).toMatchObject({ firstSight: 'late' })
  })

  it('puts the policy on every config frame, so no frame can carry a different one', () => {
    setProxyFirstSight('late')
    startProxy({ port: 7406 })
    setProxyMode('balanced')
    setProxyThinkingCap(4096)
    setProxyDecay(true)
    const configs = configsOf(children[0])
    expect(configs).toHaveLength(3)
    for (const c of configs) expect(c.firstSight).toBe('late')
  })

  it('a push that fails when the init is sent is not lost: it is sent again by the next frame', () => {
    failFirstPost = true
    startProxy({ port: 7407 }) // the init cannot be posted: the policy has not reached a child
    setProxyFirstSight('late') // so it is still the user's to choose
    expect(getProxyFirstSight()).toBe('late')
    expect(children[0].posted).toHaveLength(0)
  })

  it('posts the policy to a child that is already running only when it has not yet been given one', () => {
    failFirstPost = true
    startProxy({ port: 7408 })
    children[0].failPost = false // the channel recovers
    setProxyFirstSight('late')
    expect(configsOf(children[0])).toEqual([expect.objectContaining({ kind: 'config', firstSight: 'late' })])
  })

  it('survives a transport that throws when the policy is posted', () => {
    failFirstPost = true
    startProxy({ port: 7409 })
    expect(() => setProxyFirstSight('late')).not.toThrow()
  })

  it('forgets the run in the test reset, so one test cannot leak a policy into the next', () => {
    setProxyFirstSight('late')
    _resetProxyForTest()
    expect(getProxyFirstSight()).toBe('legacy')
    setProxyFirstSight('late')
    expect(getProxyFirstSight()).toBe('late')
  })
})

describe('the proxy child and the first-sight policy', () => {
  beforeEach(() => { vi.resetModules() })

  async function child(): Promise<{ applyProxyConfig: (m: unknown) => void; wire: { getFirstSightPolicy: () => string; rewriteMessagesBody: (raw: string) => { changed: boolean; stats: { arm: string } } } }> {
    const main = await import('../../src/main/headroomProxy/proxyMain')
    const wire = await import('../../src/main/headroomProxy/wireCompress')
    return { applyProxyConfig: main.applyProxyConfig, wire }
  }
  // A first message on the late arm: about one in ten would be held out and run the old behaviour.
  let first = 'show me the log'
  for (let i = 0; armForBody({ messages: [{ role: 'user', content: first }] }) !== 'late'; i++) first = `show me the log ${i}`
  const body = JSON.stringify({
    model: 'x',
    messages: [
      { role: 'user', content: first },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'cat log' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: Array.from({ length: 200 }, (_, i) => `row ${i} of the log with some padding in it`).join('\n') }] },
    ],
  })

  it('applies the policy a config frame carries, and the next frame cannot change it', async () => {
    const { applyProxyConfig, wire } = await child()
    expect(wire.getFirstSightPolicy()).toBe('legacy')
    applyProxyConfig({ mode: 'aggressive', thinkingCap: 0, decay: false, firstSight: 'late' })
    expect(wire.getFirstSightPolicy()).toBe('late')
    applyProxyConfig({ mode: 'aggressive', thinkingCap: 0, decay: false, firstSight: 'legacy' })
    expect(wire.getFirstSightPolicy()).toBe('late')
    expect(wire.rewriteMessagesBody(body).changed).toBe(false)
  })

  it('leaves the policy unresolved for a frame that carries none, so a later frame can set it', async () => {
    const { applyProxyConfig, wire } = await child()
    applyProxyConfig({ mode: 'aggressive' })
    applyProxyConfig({ mode: 'aggressive', firstSight: 'nonsense' })
    expect(wire.getFirstSightPolicy()).toBe('legacy')
    applyProxyConfig({ mode: 'aggressive', firstSight: 'late' })
    expect(wire.getFirstSightPolicy()).toBe('late')
  })

  it('still applies the tier, the cap and decay from the same frame, as it always did', async () => {
    const { applyProxyConfig, wire } = await child()
    applyProxyConfig({ mode: 'max', thinkingCap: 2048, decay: true, firstSight: 'late' })
    const w = await import('../../src/main/headroomProxy/wireCompress')
    expect(w.getThinkingCap()).toBe(2048)
    // Maximum would shorten a 600-character result; late keeps the larger floor.
    expect(wire.rewriteMessagesBody(body).changed).toBe(false)
  })

  it('does not throw on a frame that is not an object', async () => {
    const { applyProxyConfig } = await child()
    for (const bad of [null, undefined, 5, 'x', [], true]) expect(() => applyProxyConfig(bad)).not.toThrow()
  })
})
