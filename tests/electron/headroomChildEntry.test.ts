import { describe, it, expect, vi, afterEach } from 'vitest'

/**
 * The proxy child's message handler is the one link in the first-sight chain that no other test
 * can reach: it sits inside the utilityProcess entry that proxyMain.ts excludes from coverage,
 * because the real entry only runs in a forked process. Everything either side of it is held (the
 * supervisor posts the policy on init and on every config frame, applyProxyConfig applies it), but
 * if the handler stopped passing a frame to applyProxyConfig the child would stay on the legacy
 * policy for the whole run, silently: no error anywhere, v1.54's behaviour, and a Settings pane
 * saying Late. So the entry is run here against a stand-in for the parent port, the way the fork
 * runs it, and what it does to the compressor is read back.
 */

// The server the entry starts, kept so each test can close it.
const servers = vi.hoisted(() => [] as Array<{ close: (cb?: () => void) => void }>)
vi.mock('http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('http')>()
  const createServer = (...args: Parameters<typeof actual.createServer>): ReturnType<typeof actual.createServer> => {
    const s = actual.createServer(...args)
    servers.push(s)
    return s
  }
  return { ...actual, default: { ...actual, createServer }, createServer }
})

type Frame = { data: unknown }
interface FakePort {
  handlers: Array<(e: Frame) => void>
  posted: Array<Record<string, unknown>>
  on(ev: string, cb: (e: Frame) => void): void
  postMessage(m: unknown): void
  send(data: unknown): void
}
function makePort(): FakePort {
  const port: FakePort = {
    handlers: [],
    posted: [],
    on(ev, cb) { if (ev === 'message') port.handlers.push(cb) },
    postMessage(m) { port.posted.push(m as Record<string, unknown>) },
    send(data) { for (const h of port.handlers) h({ data }) },
  }
  return port
}

const processHandlers = (): { exception: Function[]; rejection: Function[] } => ({
  exception: process.listeners('uncaughtException'),
  rejection: process.listeners('unhandledRejection'),
})

// What this worker had registered before any child ran, so only the children's handlers are removed.
const baseline = processHandlers()

/** A fresh child: new module registry, the port in place, the entry run by importing proxyMain. */
async function launchChild(): Promise<{ port: FakePort; wire: typeof import('../../src/main/headroomProxy/wireCompress') }> {
  vi.resetModules()
  const port = makePort()
  ;(process as unknown as { parentPort?: unknown }).parentPort = port
  await import('../../src/main/headroomProxy/proxyMain')
  const wire = await import('../../src/main/headroomProxy/wireCompress')
  return { port, wire }
}

afterEach(async () => {
  delete (process as unknown as { parentPort?: unknown }).parentPort
  // The entry keeps the child alive on an uncaught error; those handlers are the child's, not this worker's.
  for (const h of process.listeners('uncaughtException')) if (!baseline.exception.includes(h)) process.off('uncaughtException', h as never)
  for (const h of process.listeners('unhandledRejection')) if (!baseline.rejection.includes(h)) process.off('unhandledRejection', h as never)
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => { try { s.close(() => resolve()) } catch { resolve() } })))
})

const ready = (port: FakePort): boolean => port.posted.some((m) => m.kind === 'ready')

describe('the proxy child entry and the first-sight policy', () => {
  it('is legacy until a frame says otherwise: a child nothing has configured is v1.54', async () => {
    const { wire } = await launchChild()
    expect(wire.getFirstSightPolicy()).toBe('legacy')
  })

  it('takes the policy its init frame carries, starts serving, and ignores every later frame', async () => {
    const { port, wire } = await launchChild()
    port.send({ kind: 'init', port: 0, upstreamHost: 'upstream.invalid', mode: 'aggressive', thinkingCap: 0, decay: false, firstSight: 'late' })
    expect(wire.getFirstSightPolicy()).toBe('late')
    await vi.waitFor(() => expect(ready(port)).toBe(true), { timeout: 5_000 })

    // The supervisor puts the policy it froze on every frame; a Settings flip never reaches this far,
    // and a frame that did carry another one could not change the run.
    port.send({ kind: 'config', mode: 'aggressive', thinkingCap: 0, decay: false, firstSight: 'legacy' })
    expect(wire.getFirstSightPolicy()).toBe('late')
  })

  it('takes a legacy init the same way, and a later late frame does not turn it on', async () => {
    const { port, wire } = await launchChild()
    port.send({ kind: 'init', port: 0, upstreamHost: 'upstream.invalid', mode: 'aggressive', thinkingCap: 0, decay: false, firstSight: 'legacy' })
    expect(wire.getFirstSightPolicy()).toBe('legacy')
    port.send({ kind: 'config', mode: 'aggressive', thinkingCap: 0, decay: false, firstSight: 'late' })
    // The frame came after the one resolution the run gets, so it is not applied: this is legacy
    // that was chosen, not legacy that was never set.
    expect(wire.getFirstSightPolicy()).toBe('legacy')
    await vi.waitFor(() => expect(ready(port)).toBe(true), { timeout: 5_000 })
  })

  it('takes the policy from a config frame that arrives before the init, when it is the first to carry one', async () => {
    const { port, wire } = await launchChild()
    port.send({ kind: 'config', mode: 'aggressive', thinkingCap: 0, decay: false, firstSight: 'late' })
    expect(wire.getFirstSightPolicy()).toBe('late')
    expect(ready(port)).toBe(false) // a config frame starts no server
  })

  it('a child respawned by the supervisor is configured again from its init, as a new process', async () => {
    const first = await launchChild()
    first.port.send({ kind: 'init', port: 0, upstreamHost: 'upstream.invalid', mode: 'aggressive', thinkingCap: 0, decay: false, firstSight: 'late' })
    expect(first.wire.getFirstSightPolicy()).toBe('late')
    await vi.waitFor(() => expect(ready(first.port)).toBe(true), { timeout: 5_000 })

    const second = await launchChild()
    expect(second.wire.getFirstSightPolicy()).toBe('legacy') // a new process starts unconfigured
    second.port.send({ kind: 'init', port: 0, upstreamHost: 'upstream.invalid', mode: 'aggressive', thinkingCap: 0, decay: false, firstSight: 'late' })
    expect(second.wire.getFirstSightPolicy()).toBe('late')
    await vi.waitFor(() => expect(ready(second.port)).toBe(true), { timeout: 5_000 })
  })

  it('does not take a second init for a server it already runs', async () => {
    const { port, wire } = await launchChild()
    port.send({ kind: 'init', port: 0, upstreamHost: 'upstream.invalid', mode: 'aggressive', thinkingCap: 0, decay: false, firstSight: 'late' })
    await vi.waitFor(() => expect(ready(port)).toBe(true), { timeout: 5_000 })
    expect(servers.length).toBe(1)
    port.send({ kind: 'init', port: 0, upstreamHost: 'upstream.invalid', mode: 'aggressive', thinkingCap: 0, decay: false, firstSight: 'legacy' })
    expect(wire.getFirstSightPolicy()).toBe('late')
    // A server is created in the handler itself, so a second one would already be here.
    expect(servers.length).toBe(1)
  })

  it('does not throw on a frame with no data, or one that is not an object', async () => {
    const { port, wire } = await launchChild()
    expect(() => { for (const h of port.handlers) { h(undefined as never); h({ data: null }); h({ data: 'x' }); h({ data: { kind: 'other' } }) } }).not.toThrow()
    expect(wire.getFirstSightPolicy()).toBe('legacy')
  })
})
