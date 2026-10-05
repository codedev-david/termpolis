import { describe, it, expect, vi, afterEach } from 'vitest'
import { createMemoryRelay, relayOpener, type MemorySocket } from './fixtures/memoryRelay'
import { generateIdentity } from '../../src/main/remoteBridge/sealedChannel'
import { Handshake } from '../../src/main/remoteBridge/sessionCrypto'
import { RelayClient } from '../../src/main/remoteBridge/relayClient'
import type { RemoteEnvelope } from '../../src/main/remoteBridge/protocol'

const ROOM = 'c'.repeat(32)
const url = (role: string, room = ROOM): string => `wss://relay.test/v1/pair/${room}?role=${role}`

/** What a socket has been told, as the test sees it. */
function listen(sock: MemorySocket) {
  const events: Array<{ event: string; text?: unknown; bytes?: number[] }> = []
  sock.on('open', (() => events.push({ event: 'open' })) as never)
  sock.on('close', (() => events.push({ event: 'close' })) as never)
  sock.on('error', (() => events.push({ event: 'error' })) as never)
  sock.on('message', ((data: Buffer, isBinary: boolean) =>
    events.push(
      isBinary
        ? { event: 'binary', bytes: [...data] }
        : { event: 'text', text: JSON.parse(data.toString('utf8')) },
    )) as never)
  return events
}

const clients: RelayClient[] = []
afterEach(() => {
  for (const c of clients.splice(0)) c.stop()
})

describe('the in-memory relay', () => {
  it('seats the first socket alone, then tells both ends when a second arrives', async () => {
    const relay = createMemoryRelay()
    const desk = relay.openSocket(url('desktop'))
    const deskEvents = listen(desk)
    await relay.settle(1)
    expect(deskEvents).toEqual([
      { event: 'open' },
      { event: 'text', text: { kind: 'hello', role: 'desktop', peer: false } },
    ])

    const phone = relay.openSocket(url('device'))
    const phoneEvents = listen(phone)
    await relay.settle(1)
    expect(phoneEvents).toEqual([
      { event: 'open' },
      { event: 'text', text: { kind: 'hello', role: 'device', peer: true } },
    ])
    expect(deskEvents.at(-1)).toEqual({ event: 'text', text: { kind: 'peer-joined', role: 'device' } })
    expect(relay.seats(ROOM)).toEqual({ desktop: true, device: true })
  })

  it('forwards binary to the other seat byte for byte, and drops it into an empty room', async () => {
    const relay = createMemoryRelay()
    const desk = relay.openSocket(url('desktop'))
    const deskEvents = listen(desk)
    await relay.settle(1)
    desk.send(new Uint8Array([1, 2, 3])) // nobody there: dropped, not queued

    const phone = relay.openSocket(url('device'))
    const phoneEvents = listen(phone)
    await relay.settle(1)
    desk.send(new Uint8Array([4, 5]))
    ;(phone as unknown as { send(d: unknown): void }).send('peer text is never forwarded')
    await relay.settle(1)

    expect(phoneEvents.filter((e) => e.event === 'binary')).toEqual([{ event: 'binary', bytes: [4, 5] }])
    expect(deskEvents.filter((e) => e.event === 'binary')).toEqual([])
    expect(desk.written.map((b) => [...b])).toEqual([[1, 2, 3], [4, 5]])
  })

  it('answers a second dial for a held seat with a 409', async () => {
    const relay = createMemoryRelay()
    relay.openSocket(url('desktop'))
    const second = relay.openSocket(url('desktop'))
    const events = listen(second)
    await relay.settle(1)
    expect(events).toEqual([{ event: 'error' }, { event: 'close' }])
    expect(relay.refusals).toEqual([{ roomId: ROOM, role: 'desktop', status: 409 }])
  })

  it.each([
    ['a room id of the wrong shape', url('desktop', 'not-a-room')],
    ['a role it does not know', url('admin')],
    ['a path that is not a room', 'wss://relay.test/elsewhere'],
  ])('refuses %s with a 400', async (_label, address) => {
    const relay = createMemoryRelay()
    const events = listen(relay.openSocket(address))
    await relay.settle(1)
    expect(events).toEqual([{ event: 'error' }, { event: 'close' }])
    expect(relay.refusals[0].status).toBe(400)
  })

  it('tells the one left behind, and frees the seat for whoever comes next', async () => {
    const relay = createMemoryRelay()
    const desk = relay.openSocket(url('desktop'))
    const deskEvents = listen(desk)
    const phone = relay.openSocket(url('device'))
    const phoneEvents = listen(phone)
    await relay.settle(1)

    phone.close()
    await relay.settle(1)
    expect(phoneEvents.at(-1)).toEqual({ event: 'close' })
    expect(deskEvents.at(-1)).toEqual({ event: 'text', text: { kind: 'peer-gone', role: 'device' } })
    expect(relay.seats(ROOM)).toEqual({ desktop: true, device: false })

    relay.drop(ROOM, 'desktop')
    relay.drop(ROOM, 'desktop') // nobody there any more: a no-op
    await relay.settle(1)
    expect(deskEvents.at(-1)).toEqual({ event: 'close' })
    expect(relay.seats(ROOM)).toEqual({ desktop: false, device: false })
    phone.close() // already closed: a no-op
    expect(() => desk.send(new Uint8Array([1]))).not.toThrow()
  })

  it('still delivers what was already in flight to a client that hung up, as ws does', async () => {
    // The seat is freed at once, but a frame already on its way arrives before
    // the client's own `close` event. A client that acts on it after stopping
    // has a bug; this relay makes sure the bug can show.
    const relay = createMemoryRelay()
    const desk = relay.openSocket(url('desktop'))
    const deskEvents = listen(desk)
    const phone = relay.openSocket(url('device'))
    listen(phone)
    await relay.settle(1)

    phone.send(new Uint8Array([7]))
    desk.close()
    desk.close() // a second hang-up changes nothing
    expect(desk.state).toBe('closing')
    expect(relay.seats(ROOM).desktop).toBe(false)
    expect(() => desk.send(new Uint8Array([8]))).not.toThrow() // dropped, as ws drops it
    await relay.settle(1)

    expect(deskEvents.slice(-2)).toEqual([{ event: 'binary', bytes: [7] }, { event: 'close' }])
    expect(desk.state).toBe('closed')
    expect(desk.written).toEqual([])
  })

  it('reports a socket closed while connecting the way ws does: error, then close', async () => {
    const relay = createMemoryRelay()
    const sock = relay.openSocket(url('desktop'))
    const events = listen(sock)
    sock.close()
    await relay.settle(1)
    expect(events).toEqual([{ event: 'error' }, { event: 'close' }])
    // Never seated, so nothing else in the room heard about it.
    expect(relay.seats(ROOM)).toEqual({ desktop: false, device: false })
  })

  it('throws an error nobody listens for, as an EventEmitter does', () => {
    const relay = createMemoryRelay()
    const sock = relay.openSocket(url('desktop'))
    expect(() => sock.emit('error', new Error('boom'))).toThrow('boom')
  })

  it('refuses a write before the upgrade has finished, as ws does', () => {
    const relay = createMemoryRelay()
    const sock = relay.openSocket(url('desktop'))
    expect(() => sock.send(new Uint8Array([1]))).toThrow(/CONNECTING/)
  })

  it('cuts a frame over the cap for frame-size, telling the sender first', async () => {
    const relay = createMemoryRelay()
    const desk = relay.openSocket(url('desktop'))
    const events = listen(desk)
    await relay.settle(1)
    desk.send(new Uint8Array(1024 * 1024 + 1))
    await relay.settle(1)
    expect(events.slice(-2)).toEqual([
      { event: 'text', text: { kind: 'quota-exceeded', limit: 'frame-size' } },
      { event: 'close' },
    ])
    expect(relay.seats(ROOM).desktop).toBe(false)
  })

  it('carries a real session between a desktop seat and a device seat, both ways', async () => {
    // The whole transport a link rides on: two RelayClients, one in each seat,
    // greeting on presence, attaching, and each asking the other something over
    // the same sealed session.
    const relay = createMemoryRelay()
    const host = generateIdentity()
    const joiner = generateIdentity()
    const open = relayOpener(relay)
    const answer = (who: string) => async (env: RemoteEnvelope) => ({
      kind: 'ok' as const,
      id: env.id,
      data: `${who} heard ${env.request.kind}`,
    })

    const desk = open({
      url: 'wss://relay.test',
      roomId: ROOM,
      handshake: () => new Handshake({ ownSecretKey: host.secretKey, peerPublicKey: joiner.publicKey, role: 'desktop' }),
      onRequest: answer('host'),
      onStateChange: () => {},
    }) as RelayClient
    const dev = open({
      url: 'wss://relay.test',
      roomId: ROOM,
      role: 'device',
      handshake: () => new Handshake({ ownSecretKey: joiner.secretKey, peerPublicKey: host.publicKey, role: 'device' }),
      onRequest: answer('joiner'),
      onStateChange: () => {},
    }) as RelayClient
    clients.push(desk, dev)
    desk.start()
    dev.start()
    await vi.waitFor(() => expect([desk.state, dev.state]).toEqual(['attached', 'attached']))

    await expect(desk.request({ kind: 'peerHello' }, 5_000)).resolves.toBe('joiner heard peerHello')
    await expect(dev.request({ kind: 'peerHello' }, 5_000)).resolves.toBe('host heard peerHello')
    expect(relay.refusals).toEqual([])
  })
})
