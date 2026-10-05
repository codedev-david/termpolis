// The bridge's linked-machine routing, one rule at a time, against stub relay
// rooms. The two-core suite (remoteLinkedBridge) proves the pieces fit over a
// relay; this one pins each refusal, timeout and edge on its own, where a
// failure points at exactly one line.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createHash } from 'crypto'
import { x25519 } from '@noble/curves/ed25519.js'
import {
  createBridgeCore,
  JOIN_TIMEOUT_MS,
  MAX_LINK_CALL_TIMEOUT_MS,
  MAX_PEER_WAIT_MS,
  PEER_CALL_TIMEOUT_MS,
  PEER_RESULT_GRACE_MS,
  type RelayLike,
} from '../../src/main/remoteBridge/entry'
import {
  deriveVerificationPhrase,
  fromHex,
  generateIdentity,
  toHex,
} from '../../src/main/remoteBridge/sealedChannel'
import { Handshake, deriveSessionRoomId } from '../../src/main/remoteBridge/sessionCrypto'
import {
  createPairingOffer,
  openPairingHello,
  sealPairingAck,
  sealPairingHello,
} from '../../src/main/remoteBridge/pairing'
import { LINK_OFFER_TTL_MS, encodeLinkCode, parseLinkCode } from '../../src/main/remoteBridge/linkCode'
import {
  MAX_LINKED_MACHINES,
  NO_CAPABILITIES,
  type BridgeLink,
  type BridgeToHost,
  type HostToBridge,
  type PairedDevice,
  type RelayControlFrame,
  type RemoteEnvelope,
} from '../../src/main/remoteBridge/protocol'
import type {
  PairingRelayDeps,
  RelayClientDeps,
  RelayState,
  SessionRelayDeps,
} from '../../src/main/remoteBridge/relayClient'

afterEach(() => {
  vi.useRealTimers()
})

/** This machine. */
const HOST = generateIdentity()
const UNRECOGNISED = 'remote device sent an unrecognised request kind'

const publicKeyOf = (secretKey: string): string => toHex(x25519.getPublicKey(fromHex(secretKey)))
const deviceIdOf = (publicKey: string): string =>
  createHash('sha256').update(publicKey).digest('hex').slice(0, 16)

/** A relay room that records instead of dialling. `request` is answered by
 *  `answer`, which a test replaces; a room built `requestless` has none at all,
 *  like every room that predates linked machines. */
interface StubRoom extends RelayLike {
  deps: RelayClientDeps
  state: RelayState
  started: boolean
  stopped: boolean
  frames: Uint8Array[]
  asked: Array<{ request: unknown; timeoutMs: number }>
  answer(request: unknown): Promise<unknown>
}

function stubRoom(deps: RelayClientDeps, requestless: boolean): StubRoom {
  const room: StubRoom = {
    deps,
    state: 'offline',
    started: false,
    stopped: false,
    frames: [],
    asked: [],
    answer: async () => null,
    start() {
      room.started = true
    },
    send() {},
    sendFrame(frame) {
      room.frames.push(frame)
    },
    stop() {
      room.stopped = true
      // As the real client does: stopping a room that was up reports it down.
      if (room.state !== 'offline') {
        room.state = 'offline'
        room.deps.onStateChange('offline')
      }
    },
  }
  if (!requestless) {
    room.request = (request, timeoutMs) => {
      room.asked.push({ request, timeoutMs })
      return room.answer(request)
    }
  }
  return room
}

function attach(room: StubRoom): void {
  room.state = 'attached'
  room.deps.onStateChange('attached')
}

type InitMsg = Extract<HostToBridge, { kind: 'init' }>
type Msg<K extends BridgeToHost['kind']> = Extract<BridgeToHost, { kind: K }>

function core(
  init: Partial<Omit<InitMsg, 'kind'>> = {},
  opts: { requestless?: boolean; relayUrl?: string } = {},
) {
  const sent: BridgeToHost[] = []
  const rooms: StubRoom[] = []
  const callTool = vi.fn().mockResolvedValue({ terminals: [] })
  const c = createBridgeCore({
    send: (m) => sent.push(m),
    mcp: { callTool },
    relayUrl: opts.relayUrl ?? 'wss://relay.test',
    desktopName: 'Bench desktop',
    openRelay: (d) => {
      const room = stubRoom(d, opts.requestless === true)
      rooms.push(room)
      return room
    },
  })
  c.handleHostMessage({
    kind: 'init',
    mcpPort: 1,
    mcpToken: 't',
    identitySecretKey: HOST.secretKey,
    devices: [],
    linked: true,
    ...init,
  })
  const all = <K extends BridgeToHost['kind']>(kind: K): Array<Msg<K>> =>
    sent.filter((m): m is Msg<K> => m.kind === kind)
  const last = <K extends BridgeToHost['kind']>(kind: K): Msg<K> | undefined => all(kind).at(-1)
  const roomFor = (roomId: string): StubRoom | undefined =>
    rooms.filter((r) => r.deps.roomId === roomId).at(-1)
  /** Answer the latest `peerRequest` the way main would. */
  const reply = (data: unknown): void => {
    const asked = last('peerRequest')!
    c.handleHostMessage({ kind: 'peerReply', callId: asked.callId, ok: true, data })
  }
  return { c, sent, rooms, callTool, all, last, roomFor, reply }
}

/** A computer that entered a code this machine showed. */
function hostedComputer(): PairedDevice {
  const key = generateIdentity()
  return {
    id: deviceIdOf(key.publicKey),
    label: 'build-box',
    publicKey: key.publicKey,
    sessionRoomId: deriveSessionRoomId(HOST.secretKey, key.publicKey),
    capabilities: { ...NO_CAPABILITIES },
    pairedAt: 1,
    lastSeenAt: Date.now(),
    kind: 'desktop',
  }
}

function phone(): PairedDevice {
  const key = generateIdentity()
  return {
    id: deviceIdOf(key.publicKey),
    label: 'Pixel',
    publicKey: key.publicKey,
    sessionRoomId: deriveSessionRoomId(HOST.secretKey, key.publicKey),
    capabilities: { read: true, createTerminal: true, writeToTerminal: true, closeTerminal: true },
    pairedAt: 1,
    lastSeenAt: Date.now(),
  }
}

/** A link this machine joined, with the per-link key main minted for it, and
 *  -- for the test only -- the host's secret, so a test can play the host. */
function joinedLink(relayUrl = 'wss://relay.test'): { link: BridgeLink; hostSecretKey: string } {
  const host = generateIdentity()
  const mine = generateIdentity()
  return {
    link: {
      id: deviceIdOf(mine.publicKey),
      hostPublicKey: host.publicKey,
      relayUrl,
      sessionRoomId: deriveSessionRoomId(mine.secretKey, host.publicKey),
      secretKey: mine.secretKey,
    },
    hostSecretKey: host.secretKey,
  }
}

const env = (id: number, request: unknown): RemoteEnvelope => ({ id, request }) as RemoteEnvelope

describe('which rooms a bridge opens', () => {
  it('opens phones and nothing linked for an init written before linked machines', () => {
    const desk = hostedComputer()
    const pho = phone()
    const { link } = joinedLink()
    const { roomFor, rooms } = core({ devices: [desk, pho], links: [link], linked: undefined })
    expect(roomFor(pho.sessionRoomId)?.started).toBe(true)
    expect(roomFor(desk.sessionRoomId)).toBeUndefined()
    expect(roomFor(link.sessionRoomId)).toBeUndefined()
    expect(rooms).toHaveLength(1)
  })

  it('opens computers and links but no phones when only linked machines is on', () => {
    const desk = hostedComputer()
    const pho = phone()
    const { link } = joinedLink()
    const { roomFor } = core({ devices: [desk, pho], links: [link], phones: false, linked: true })
    expect(roomFor(pho.sessionRoomId)).toBeUndefined()
    expect(roomFor(desk.sessionRoomId)?.started).toBe(true)
    expect(roomFor(link.sessionRoomId)?.started).toBe(true)
  })

  it('dials a joined link from the device seat, with its own key, at its own relay', () => {
    const { link, hostSecretKey } = joinedLink('wss://other-relay.test')
    const { roomFor } = core({ links: [link] })
    const deps = roomFor(link.sessionRoomId)!.deps as SessionRelayDeps
    expect(deps.role).toBe('device')
    expect(deps.url).toBe('wss://other-relay.test')

    // The greeting is one only the host -- holding the other half of THIS
    // link's keys -- can accept, and it accepts it as a device's.
    const realHost = new Handshake({
      ownSecretKey: hostSecretKey,
      peerPublicKey: publicKeyOf(link.secretKey),
      role: 'desktop',
    })
    expect(() => realHost.accept(deps.handshake().greeting)).not.toThrow()
    const stranger = new Handshake({
      ownSecretKey: hostSecretKey,
      peerPublicKey: HOST.publicKey,
      role: 'desktop',
    })
    expect(() => stranger.accept(deps.handshake().greeting)).toThrow()
  })

  it('skips a link record it cannot safely dial, and says so', () => {
    const good = joinedLink().link
    const { rooms, last } = core({ links: [{ ...joinedLink().link, secretKey: 'not hex' }, good] })
    expect(rooms.map((r) => r.deps.roomId)).toEqual([good.sessionRoomId])
    expect(last('error')?.message).toBe('a linked machine record is malformed and was skipped')
  })

  it('reports a relay cut on a link room to main', () => {
    const { link } = joinedLink()
    const { roomFor, last } = core({ links: [link] })
    roomFor(link.sessionRoomId)!.deps.onQuota?.('frame-rate')
    expect(last('error')?.message).toBe('relay closed a linked machine connection: frame-rate')
  })
})

describe('setLinks', () => {
  it('closes what was removed, opens what was added, and leaves the rest alone', () => {
    const [a, b, c] = [joinedLink().link, joinedLink().link, joinedLink().link]
    const ctx = core({ links: [a, b] })
    const roomA = ctx.roomFor(a.sessionRoomId)!
    const roomB = ctx.roomFor(b.sessionRoomId)!

    ctx.c.handleHostMessage({ kind: 'setLinks', links: [b, c] })
    expect(roomA.stopped).toBe(true)
    // Not torn down and redialled: a live session with nothing wrong with it.
    expect(roomB.stopped).toBe(false)
    expect(ctx.roomFor(b.sessionRoomId)).toBe(roomB)
    expect(ctx.roomFor(c.sessionRoomId)?.started).toBe(true)
    expect(ctx.rooms).toHaveLength(3)
  })

  it('reopens a link whose record changed under the same id', () => {
    const { link } = joinedLink()
    const ctx = core({ links: [link] })
    const first = ctx.roomFor(link.sessionRoomId)!
    ctx.c.handleHostMessage({ kind: 'setLinks', links: [{ ...link, relayUrl: 'wss://moved.test' }] })
    expect(first.stopped).toBe(true)
    expect(ctx.rooms.at(-1)!.deps.url).toBe('wss://moved.test')
  })

  it('opens nothing while linked machines is off', () => {
    const ctx = core({ linked: false })
    ctx.c.handleHostMessage({ kind: 'setLinks', links: [joinedLink().link] })
    expect(ctx.rooms).toEqual([])
  })

  it('tells main when a link becomes reachable and when it stops, and only then', () => {
    const { link } = joinedLink()
    const ctx = core({ links: [link] })
    const room = ctx.roomFor(link.sessionRoomId)!
    room.deps.onStateChange('online') // seated alone: not reachable, nothing to say
    attach(room)
    attach(room) // no change, no second message
    room.state = 'online'
    room.deps.onStateChange('online')
    expect(ctx.all('linkStateChanged')).toEqual([
      { kind: 'linkStateChanged', id: link.id, attached: true },
      { kind: 'linkStateChanged', id: link.id, attached: false },
    ])
  })

  it('reports a removed link as down on its way out, and nothing from it after', () => {
    const { link } = joinedLink()
    const ctx = core({ links: [link] })
    const room = ctx.roomFor(link.sessionRoomId)!
    attach(room)
    ctx.c.handleHostMessage({ kind: 'setLinks', links: [] })
    expect(ctx.last('linkStateChanged')).toEqual({ kind: 'linkStateChanged', id: link.id, attached: false })

    const before = ctx.sent.length
    room.deps.onStateChange('attached')
    expect(ctx.sent).toHaveLength(before)
  })
})

describe('requests from a computer this machine hosts', () => {
  it('forwards a peer request to main and answers with what main says', async () => {
    const desk = hostedComputer()
    const ctx = core({ devices: [desk] })
    const answer = ctx.c.handleRemoteRequest(desk.id, env(4, { kind: 'peerHello' }))
    expect(ctx.last('peerRequest')).toMatchObject({
      from: { via: 'device', id: desk.id },
      request: { kind: 'peerHello' },
    })
    ctx.reply({ name: 'Bench desktop' })
    await expect(answer).resolves.toEqual({ kind: 'ok', id: 4, data: { name: 'Bench desktop' } })
  })

  it('answers with main\'s refusal, word for word', async () => {
    const desk = hostedComputer()
    const ctx = core({ devices: [desk] })
    const answer = ctx.c.handleRemoteRequest(desk.id, env(5, { kind: 'peerRun', agent: 'codex', prompt: 'x' }))
    const { callId } = ctx.last('peerRequest')!
    ctx.c.handleHostMessage({ kind: 'peerReply', callId, ok: false, message: 'write is not granted' })
    await expect(answer).resolves.toEqual({ kind: 'error', id: 5, message: 'write is not granted' })
  })

  it('gives up on main after its timeout, and a late reply settles nothing', async () => {
    vi.useFakeTimers()
    const desk = hostedComputer()
    const ctx = core({ devices: [desk] })
    const answer = ctx.c.handleRemoteRequest(desk.id, env(6, { kind: 'peerHello' }))
    await vi.advanceTimersByTimeAsync(PEER_CALL_TIMEOUT_MS)
    await expect(answer).resolves.toEqual({ kind: 'error', id: 6, message: 'timed out' })
    expect(() => ctx.reply('late')).not.toThrow()
  })

  it.each([
    ['a wait within the cap', 2_000, 2_000],
    ['a wait past the cap', 600_000, MAX_PEER_WAIT_MS],
    ['a negative wait', -5, 0],
    ['a wait that is not a number', 'soon', 0],
    ['no wait at all', undefined, 0],
  ])('holds a result poll open for %s, plus grace', async (_label, waitMs, held) => {
    vi.useFakeTimers()
    const desk = hostedComputer()
    const ctx = core({ devices: [desk] })
    let settled = false
    const answer = ctx.c
      .handleRemoteRequest(desk.id, env(7, { kind: 'peerResult', jobId: 'j1', waitMs }))
      .finally(() => (settled = true))
    await vi.advanceTimersByTimeAsync(held + PEER_RESULT_GRACE_MS - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(answer).resolves.toMatchObject({ kind: 'error', message: 'timed out' })
  })

  it.each([
    ['listTerminals', { kind: 'listTerminals' }],
    ['getCapabilities', { kind: 'getCapabilities' }],
    ['unpair', { kind: 'unpair' }],
    ['writeToTerminal', { kind: 'writeToTerminal', terminalId: 't1', text: 'rm -rf ~' }],
    ['a kind nobody knows', { kind: 'peerSomethingNew' }],
  ])('refuses %s from a computer: it is served peer requests and nothing else', async (_label, request) => {
    const desk = { ...hostedComputer(), capabilities: { read: true, createTerminal: true, writeToTerminal: true, closeTerminal: true } }
    const ctx = core({ devices: [desk] })
    await expect(ctx.c.handleRemoteRequest(desk.id, env(8, request))).resolves.toEqual({
      kind: 'error',
      id: 8,
      message: UNRECOGNISED,
    })
    // Not even a grant set on it by mistake gets it to a terminal, or to main.
    expect(ctx.callTool).not.toHaveBeenCalled()
    expect(ctx.all('peerRequest')).toEqual([])
    expect(ctx.all('devicesChanged')).toEqual([])
  })

  it('refuses peer requests from a phone, and main never hears of them', async () => {
    const pho = phone()
    const ctx = core({ devices: [pho] })
    for (const kind of ['peerHello', 'peerRun', 'peerResult', 'peerCancel', 'peerBye']) {
      await expect(ctx.c.handleRemoteRequest(pho.id, env(9, { kind }))).resolves.toEqual({
        kind: 'error',
        id: 9,
        message: UNRECOGNISED,
      })
    }
    expect(ctx.all('peerRequest')).toEqual([])
    expect(ctx.all('linkBye')).toEqual([])
    expect(ctx.callTool).not.toHaveBeenCalled()
  })

  it('takes a computer that says goodbye off this machine, and closes its room after answering', async () => {
    vi.useFakeTimers()
    const desk = hostedComputer()
    const other = hostedComputer()
    const ctx = core({ devices: [desk, other] })
    const room = ctx.roomFor(desk.sessionRoomId)!

    await expect(ctx.c.handleRemoteRequest(desk.id, env(10, { kind: 'peerBye' }))).resolves.toEqual({
      kind: 'ok',
      id: 10,
      data: null,
    })
    expect(ctx.last('devicesChanged')?.devices.map((d) => d.id)).toEqual([other.id])
    // The answer has to leave by this room, so it is still open here...
    expect(room.stopped).toBe(false)
    expect(ctx.all('linkBye')).toEqual([])
    await vi.advanceTimersByTimeAsync(0)
    // ...and closed once it has.
    expect(room.stopped).toBe(true)
    expect(ctx.last('linkBye')).toEqual({ kind: 'linkBye', from: { via: 'device', id: desk.id } })
    expect(ctx.all('peerRequest')).toEqual([])
    expect(ctx.roomFor(other.sessionRoomId)!.stopped).toBe(false)
    await expect(ctx.c.handleRemoteRequest(desk.id, env(11, { kind: 'peerHello' }))).resolves.toMatchObject({
      message: 'unknown or revoked device',
    })
  })

  it('ignores a reply to a request main was never asked', () => {
    const ctx = core()
    expect(() =>
      ctx.c.handleHostMessage({ kind: 'peerReply', callId: 'peer-999', ok: true, data: 1 }),
    ).not.toThrow()
  })

  it('answers everything still waiting on main when it shuts down', async () => {
    const desk = hostedComputer()
    const ctx = core({ devices: [desk] })
    const answer = ctx.c.handleRemoteRequest(desk.id, env(12, { kind: 'peerHello' }))
    ctx.c.handleHostMessage({ kind: 'shutdown' })
    await expect(answer).resolves.toEqual({ kind: 'error', id: 12, message: 'bridge shutting down' })
  })
})

describe('requests from a computer whose link this machine joined', () => {
  function linked() {
    const { link } = joinedLink()
    const ctx = core({ links: [link] })
    const room = ctx.roomFor(link.sessionRoomId)!
    const ask = (id: number, request: unknown) =>
      (room.deps as SessionRelayDeps).onRequest(env(id, request))
    return { ...ctx, link, room, ask }
  }

  it('forwards a peer request to main, naming the link it came over', async () => {
    const { ask, last, reply, link } = linked()
    const answer = ask(1, { kind: 'peerHello' })
    expect(last('peerRequest')).toMatchObject({ from: { via: 'link', id: link.id }, request: { kind: 'peerHello' } })
    reply('hi')
    await expect(answer).resolves.toEqual({ kind: 'ok', id: 1, data: 'hi' })
  })

  it('refuses anything that is not a peer request', async () => {
    const { ask, all } = linked()
    await expect(ask(2, { kind: 'listTerminals' })).resolves.toEqual({ kind: 'error', id: 2, message: UNRECOGNISED })
    expect(all('peerRequest')).toEqual([])
  })

  it('refuses a request still arriving on a link that has been removed', async () => {
    const { c, ask, all } = linked()
    c.handleHostMessage({ kind: 'setLinks', links: [] })
    await expect(ask(3, { kind: 'peerHello' })).resolves.toEqual({
      kind: 'error',
      id: 3,
      message: 'unknown or removed link',
    })
    expect(all('peerRequest')).toEqual([])
  })

  it('answers a goodbye, then closes the link and tells main', async () => {
    vi.useFakeTimers()
    const { ask, room, last, all, link } = linked()
    await expect(ask(4, { kind: 'peerBye' })).resolves.toEqual({ kind: 'ok', id: 4, data: null })
    expect(room.stopped).toBe(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(room.stopped).toBe(true)
    expect(last('linkBye')).toEqual({ kind: 'linkBye', from: { via: 'link', id: link.id } })
    expect(all('peerRequest')).toEqual([])
  })

  it('still tells main about a goodbye whose link main removed first', async () => {
    vi.useFakeTimers()
    const { c, ask, all, link } = linked()
    await ask(5, { kind: 'peerBye' })
    c.handleHostMessage({ kind: 'setLinks', links: [] })
    await vi.advanceTimersByTimeAsync(0)
    expect(all('linkBye')).toEqual([{ kind: 'linkBye', from: { via: 'link', id: link.id } }])
  })
})

describe('linkCall', () => {
  /** A machine holding one hosted computer and one joined link, both attached. */
  function both(opts: { requestless?: boolean } = {}) {
    const desk = hostedComputer()
    const pho = phone()
    const { link } = joinedLink()
    const ctx = core({ devices: [desk, pho], links: [link] }, opts)
    const deskRoom = ctx.roomFor(desk.sessionRoomId)!
    const linkRoom = ctx.roomFor(link.sessionRoomId)!
    attach(deskRoom)
    attach(linkRoom)
    attach(ctx.roomFor(pho.sessionRoomId)!)
    const call = async (msg: Omit<Extract<HostToBridge, { kind: 'linkCall' }>, 'kind' | 'callId'>) => {
      const callId = `c${ctx.sent.length}`
      ctx.c.handleHostMessage({ kind: 'linkCall', callId, ...msg })
      let result: Msg<'linkCallResult'> | undefined
      await vi.waitFor(() => {
        result = ctx.all('linkCallResult').find((r) => r.callId === callId)
        expect(result).toBeDefined()
      })
      return result!
    }
    return { ...ctx, desk, pho, link, deskRoom, linkRoom, call }
  }

  it('asks a hosted computer through its room, and a joined link through its own', async () => {
    const ctx = both()
    ctx.deskRoom.answer = async () => 'from the computer'
    ctx.linkRoom.answer = async () => 'from the link'

    await expect(
      ctx.call({ target: { via: 'device', id: ctx.desk.id }, request: { kind: 'peerHello' }, timeoutMs: 8_000 }),
    ).resolves.toMatchObject({ ok: true, data: 'from the computer' })
    await expect(
      ctx.call({ target: { via: 'link', id: ctx.link.id }, request: { kind: 'peerHello' }, timeoutMs: 8_000 }),
    ).resolves.toMatchObject({ ok: true, data: 'from the link' })
    expect(ctx.deskRoom.asked).toEqual([{ request: { kind: 'peerHello' }, timeoutMs: 8_000 }])
    expect(ctx.linkRoom.asked).toEqual([{ request: { kind: 'peerHello' }, timeoutMs: 8_000 }])
  })

  it('answers with the refusal when the other machine refuses', async () => {
    const ctx = both()
    ctx.linkRoom.answer = async () => {
      throw new Error('busy: 2 jobs already running for this machine')
    }
    await expect(
      ctx.call({ target: { via: 'link', id: ctx.link.id }, request: { kind: 'peerRun' } as never, timeoutMs: 1 }),
    ).resolves.toMatchObject({ ok: false, message: 'busy: 2 jobs already running for this machine' })
  })

  it.each([
    ['a link that is not attached', (ctx: ReturnType<typeof both>) => {
      ctx.linkRoom.state = 'online'
      return { via: 'link' as const, id: ctx.link.id }
    }],
    ['a link it does not have', () => ({ via: 'link' as const, id: 'f'.repeat(16) })],
    ['a computer it does not host', () => ({ via: 'device' as const, id: 'f'.repeat(16) })],
    // A phone is never sent a peer request, whatever main asks for.
    ['a phone', (ctx: ReturnType<typeof both>) => ({ via: 'device' as const, id: ctx.pho.id })],
    ['a target of a kind it does not know', () => ({ via: 'carrier-pigeon', id: 'x' }) as never],
    ['no target at all', () => null as never],
  ])('answers offline at once for %s', async (_label, target) => {
    const ctx = both()
    await expect(
      ctx.call({ target: target(ctx), request: { kind: 'peerHello' }, timeoutMs: 60_000 }),
    ).resolves.toMatchObject({ ok: false, message: 'offline' })
    expect(ctx.deskRoom.asked).toEqual([])
    expect(ctx.linkRoom.asked).toEqual([])
  })

  it('answers offline for a room that cannot ask anything', async () => {
    const ctx = both({ requestless: true })
    await expect(
      ctx.call({ target: { via: 'link', id: ctx.link.id }, request: { kind: 'peerHello' }, timeoutMs: 1_000 }),
    ).resolves.toMatchObject({ ok: false, message: 'offline' })
  })

  it.each([
    ['a phone request', { kind: 'listTerminals' }],
    ['no request', null],
    ['a request with no kind', {}],
  ])('refuses to send %s to another machine', async (_label, request) => {
    const ctx = both()
    await expect(
      ctx.call({ target: { via: 'link', id: ctx.link.id }, request: request as never, timeoutMs: 1_000 }),
    ).resolves.toMatchObject({ ok: false, message: 'not a linked-machine request' })
    expect(ctx.linkRoom.asked).toEqual([])
  })

  it.each([
    ['a sane timeout', 12_345, 12_345],
    ['no timeout', undefined, PEER_CALL_TIMEOUT_MS],
    ['a timeout that is not a number', Number.NaN, PEER_CALL_TIMEOUT_MS],
    ['a timeout of zero', 0, PEER_CALL_TIMEOUT_MS],
    ['a timeout past the ceiling', 10 * 60 * 60_000, MAX_LINK_CALL_TIMEOUT_MS],
  ])('waits %s as main asked, within bounds', async (_label, timeoutMs, expected) => {
    const ctx = both()
    await ctx.call({ target: { via: 'link', id: ctx.link.id }, request: { kind: 'peerHello' }, timeoutMs: timeoutMs as number })
    expect(ctx.linkRoom.asked[0].timeoutMs).toBe(expected)
  })
})

describe('renameDevice', () => {
  it('renames, cleans the name, and tells main', () => {
    const desk = hostedComputer()
    const ctx = core({ devices: [desk] })
    ctx.c.handleHostMessage({ kind: 'renameDevice', deviceId: desk.id, label: '  linux\u001b[2J box  ' })
    expect(ctx.last('devicesChanged')?.devices[0].label).toBe('linux[2J box')
  })

  it('keeps the old name when the new one cleans to nothing', () => {
    const desk = hostedComputer()
    const ctx = core({ devices: [desk] })
    ctx.c.handleHostMessage({ kind: 'renameDevice', deviceId: desk.id, label: '\u0000\u0007 ' })
    expect(ctx.all('devicesChanged')).toEqual([])
  })

  it('says nothing about a device it does not have', () => {
    const ctx = core()
    ctx.c.handleHostMessage({ kind: 'renameDevice', deviceId: 'ghost', label: 'x' })
    expect(ctx.all('devicesChanged')).toEqual([])
  })
})

describe('showing a link code', () => {
  /** What a computer joining this code sends, sealed with a key of its own. */
  function computerHello(ctx: ReturnType<typeof core>, label = 'build-box', peer: 'desktop' | undefined = 'desktop') {
    const offer = parseLinkCode(ctx.last('pairingCode')!.linkCode ?? encodeLinkCode(ctx.last('pairingCode')!.qrPayload))!
    const key = generateIdentity()
    return sealPairingHello({
      deviceSecretKey: key.secretKey,
      devicePublicKey: key.publicKey,
      desktopPublicKey: offer.desktopPublicKey,
      pairingId: offer.pairingId,
      label,
      oneTimeSecret: offer.oneTimeSecret,
      peer,
    })
  }
  const feed = (ctx: ReturnType<typeof core>, frame: Uint8Array): void =>
    (ctx.rooms.at(-1)!.deps as PairingRelayDeps).onFrame(frame)

  it('lives five minutes and carries the code beside the QR payload', () => {
    vi.useFakeTimers({ now: 1_000_000 })
    const ctx = core()
    ctx.c.handleHostMessage({ kind: 'beginPairing', label: '', link: true })
    const shown = ctx.last('pairingCode')!
    expect(shown.expiresAt).toBe(1_000_000 + LINK_OFFER_TTL_MS)
    expect(parseLinkCode(shown.linkCode!)).toEqual(JSON.parse(shown.qrPayload))
    // The room stays for the whole five minutes, then goes.
    const room = ctx.rooms.at(-1)!
    vi.advanceTimersByTime(LINK_OFFER_TTL_MS - 1)
    expect(room.stopped).toBe(false)
    vi.advanceTimersByTime(1)
    expect(room.stopped).toBe(true)
  })

  it('shows a phone no link code', () => {
    const ctx = core()
    ctx.c.handleHostMessage({ kind: 'beginPairing', label: '' })
    expect('linkCode' in ctx.last('pairingCode')!).toBe(false)
  })

  it.each([
    ['a link code while linked machines is off', { linked: false }, true, 'Linked machines is off. Switch it on under Settings ▸ Linked machines first.'],
    ['a phone QR while phones are off', { phones: false }, false, 'Phone pairing is off. Switch on "Allow phones to connect" first.'],
  ])('refuses %s', (_label, init, link, message) => {
    const ctx = core(init)
    ctx.c.handleHostMessage({ kind: 'beginPairing', label: '', link })
    expect(ctx.last('error')?.message).toBe(message)
    expect(ctx.all('pairingCode')).toEqual([])
    expect(ctx.rooms).toEqual([])
  })

  it('will not hand out a code over a relay the other computer would refuse', () => {
    // Remote accepts a plain ws:// relay anywhere; a joiner accepts one only on
    // loopback. A code minted over a LAN ws:// relay would be refused on the
    // other machine as "not a link code" -- say the real reason here instead.
    const ctx = core({}, { relayUrl: 'ws://192.168.1.20:8787' })
    ctx.c.handleHostMessage({ kind: 'beginPairing', label: '', link: true })
    expect(ctx.last('error')?.message).toMatch(/needs an encrypted relay/)
    expect(ctx.all('pairingCode')).toEqual([])
    expect(ctx.rooms).toEqual([])

    // A phone QR over the same relay is still Remote's business, as before.
    ctx.c.handleHostMessage({ kind: 'beginPairing', label: '' })
    expect(ctx.all('pairingCode')).toHaveLength(1)
  })

  it('refuses a seventeenth machine, counting hosted and joined together', () => {
    const devices = Array.from({ length: 10 }, hostedComputer)
    const links = Array.from({ length: MAX_LINKED_MACHINES - 10 }, () => joinedLink().link)
    const ctx = core({ devices: [...devices, phone()], links })
    ctx.c.handleHostMessage({ kind: 'beginPairing', label: '', link: true })
    expect(ctx.last('error')?.message).toBe(
      `This computer already has ${MAX_LINKED_MACHINES} linked machines. Unlink one before linking another.`,
    )
    expect(ctx.all('pairingCode')).toEqual([])
  })

  it('refuses the hello when the cap filled up while the code was on screen', () => {
    const ctx = core()
    ctx.c.handleHostMessage({ kind: 'beginPairing', label: '', link: true })
    const pairingRoom = ctx.rooms.at(-1)!
    const hello = computerHello(ctx)
    ctx.c.handleHostMessage({
      kind: 'setLinks',
      links: Array.from({ length: MAX_LINKED_MACHINES }, () => joinedLink().link),
    })
    ;(pairingRoom.deps as PairingRelayDeps).onFrame(hello)
    expect(ctx.last('error')?.message).toMatch(/already has 16 linked machines/)
    expect(ctx.all('paired')).toEqual([])
    // Not spent: refused before the secret was checked.
    expect(pairingRoom.stopped).toBe(false)
  })

  it('grants a computer no phone capability, whatever the offer carried', () => {
    const ctx = core()
    ctx.c.handleHostMessage({
      kind: 'beginPairing',
      label: '',
      link: true,
      capabilities: { read: true, createTerminal: true, writeToTerminal: true, closeTerminal: true },
    })
    feed(ctx, computerHello(ctx))
    expect(ctx.last('paired')?.device).toMatchObject({ kind: 'desktop', capabilities: NO_CAPABILITIES })
  })

  it('names a computer that sends no usable name', () => {
    const ctx = core()
    ctx.c.handleHostMessage({ kind: 'beginPairing', label: '', link: true })
    feed(ctx, computerHello(ctx, '\u0000'))
    expect(ctx.last('paired')?.device.label).toBe('Linked computer')
  })

  it('makes a computer of a link offer even when pairing is driven directly', () => {
    // `acceptPairing` is also called by the CLI client, with no hello at all.
    const ctx = core()
    ctx.c.handleHostMessage({ kind: 'beginPairing', label: 'cli', link: true })
    const offer = parseLinkCode(ctx.last('pairingCode')!.linkCode!)!
    const key = generateIdentity()
    const { device } = ctx.c.acceptPairing({
      oneTimeSecret: offer.oneTimeSecret,
      devicePublicKey: key.publicKey,
      label: 'cli',
      capabilities: { read: true, createTerminal: true, writeToTerminal: true, closeTerminal: true },
    })
    expect(device).toMatchObject({ kind: 'desktop', capabilities: NO_CAPABILITIES })
  })

  it('goes back to pairing phones on the next phone offer', () => {
    const ctx = core()
    ctx.c.handleHostMessage({ kind: 'beginPairing', label: '', link: true })
    ctx.c.handleHostMessage({ kind: 'beginPairing', label: 'Pixel' })
    feed(ctx, computerHello(ctx))
    expect(ctx.last('error')?.message).toBe(
      'That code is for a phone. Create a code under Settings ▸ Linked machines.',
    )
    feed(ctx, computerHello(ctx, 'Pixel', undefined))
    expect(ctx.last('paired')?.device.kind).toBeUndefined()
  })
})

describe('joining a link', () => {
  /** A host showing a link code, played by the test: its identity and offer. */
  function host(relayUrl = 'wss://relay.test') {
    const id = generateIdentity()
    const offer = createPairingOffer({ relayUrl, desktopPublicKey: id.publicKey, ttlMs: LINK_OFFER_TTL_MS })
    return { id, offer, code: encodeLinkCode(offer.qrPayload) }
  }

  function joining(h = host(), init: Partial<Omit<InitMsg, 'kind'>> = {}) {
    const ctx = core(init)
    const key = generateIdentity()
    ctx.c.handleHostMessage({ kind: 'joinLink', code: h.code, secretKey: key.secretKey, label: '  Studio\u0007  ' })
    const room = ctx.rooms.at(-1)
    const control = (frame: RelayControlFrame): void => (room!.deps as PairingRelayDeps).onControl?.(frame)
    const frame = (bytes: Uint8Array): void => (room!.deps as PairingRelayDeps).onFrame(bytes)
    const ack = (deviceId = deviceIdOf(key.publicKey), name = 'studio-host') =>
      sealPairingAck({
        desktopSecretKey: h.id.secretKey,
        devicePublicKey: key.publicKey,
        pairingId: h.offer.pairingId,
        deviceId,
        name,
      })
    return { ...ctx, h, key, room, control, frame, ack }
  }

  it('waits in the device seat of the code\'s room, on the code\'s relay', () => {
    const { room, h } = joining(host('wss://their-relay.test'))
    const deps = room!.deps as PairingRelayDeps
    expect(deps).toMatchObject({ mode: 'pairing', role: 'device', roomId: h.offer.pairingId, url: 'wss://their-relay.test' })
    expect(room!.started).toBe(true)
  })

  it('speaks once, only when the host is there, as a computer, with a clean name', () => {
    const { room, control, h, key } = joining()
    control({ kind: 'hello', role: 'device', peer: false })
    expect(room!.frames).toEqual([])
    control({ kind: 'peer-joined', role: 'desktop' })
    control({ kind: 'peer-joined', role: 'desktop' })
    control({ kind: 'hello', role: 'device', peer: true })
    expect(room!.frames).toHaveLength(1)
    expect(
      openPairingHello({ desktopSecretKey: h.id.secretKey, pairingId: h.offer.pairingId, frame: room!.frames[0] }),
    ).toEqual({ devicePublicKey: key.publicKey, label: 'Studio', oneTimeSecret: h.offer.oneTimeSecret, peer: 'desktop' })
  })

  it('finishes on the host\'s ack with everything main needs, and leaves the room', () => {
    vi.useFakeTimers()
    const { control, frame, ack, room, last, all, key, h } = joining()
    control({ kind: 'hello', role: 'device', peer: true })
    frame(new Uint8Array([2, 9, 9, 9])) // a stray: ignored
    frame(ack())
    expect(last('linkJoined')).toEqual({
      kind: 'linkJoined',
      publicKey: key.publicKey,
      hostPublicKey: h.id.publicKey,
      hostName: 'studio-host',
      deviceId: deviceIdOf(key.publicKey),
      sessionRoomId: deriveSessionRoomId(key.secretKey, h.id.publicKey),
      relayUrl: 'wss://relay.test',
      phrase: deriveVerificationPhrase(key.publicKey, h.id.publicKey),
    })
    expect(room!.stopped).toBe(true)
    // The give-up timer went with it.
    vi.advanceTimersByTime(JOIN_TIMEOUT_MS)
    expect(all('joinFailed')).toEqual([])
  })

  it('refuses an authentic ack made out for a different key', () => {
    const { frame, ack, last, room } = joining()
    frame(ack('0'.repeat(16)))
    expect(last('joinFailed')?.message).toMatch(/different key/)
    expect(room!.stopped).toBe(true)
  })

  it.each([
    [{ kind: 'peer-gone', role: 'desktop' } as const, 'The other computer stopped showing that code.'],
    [{ kind: 'quota-exceeded', limit: 'frame-rate' } as const, 'The relay refused the connection (frame-rate).'],
  ])('gives up when the relay says %j', (frame, message) => {
    const { control, last, room } = joining()
    control(frame)
    expect(last('joinFailed')?.message).toBe(message)
    expect(room!.stopped).toBe(true)
  })

  it('gives up after a minute of silence', () => {
    vi.useFakeTimers()
    const { last, room } = joining()
    vi.advanceTimersByTime(JOIN_TIMEOUT_MS - 1)
    expect(last('joinFailed')).toBeUndefined()
    vi.advanceTimersByTime(1)
    expect(last('joinFailed')?.message).toMatch(/^No answer\./)
    expect(room!.stopped).toBe(true)
  })

  it('cancels quietly, and nothing the old room still delivers counts', () => {
    vi.useFakeTimers()
    const { c, control, frame, ack, room, sent } = joining()
    c.handleHostMessage({ kind: 'cancelJoin' })
    expect(room!.stopped).toBe(true)
    const before = sent.length
    control({ kind: 'peer-joined', role: 'desktop' })
    control({ kind: 'peer-gone', role: 'desktop' })
    frame(ack())
    vi.advanceTimersByTime(JOIN_TIMEOUT_MS)
    expect(sent).toHaveLength(before)
    expect(room!.frames).toEqual([])
    c.handleHostMessage({ kind: 'cancelJoin' }) // nothing to cancel: a no-op
  })

  it('lets a second code replace the first', () => {
    const first = joining()
    const second = host()
    const key = generateIdentity()
    first.c.handleHostMessage({ kind: 'joinLink', code: second.code, secretKey: key.secretKey, label: 'x' })
    expect(first.room!.stopped).toBe(true)
    first.frame(first.ack())
    expect(first.all('linkJoined')).toEqual([])
    expect(first.rooms.at(-1)!.deps.roomId).toBe(second.offer.pairingId)
  })

  it('ends a join in progress when the bridge shuts down', () => {
    const { c, room } = joining()
    c.handleHostMessage({ kind: 'shutdown' })
    expect(room!.stopped).toBe(true)
  })

  it.each([
    ['linked machines is off', { linked: false }, (h: ReturnType<typeof host>) => h.code, 'a'.repeat(64), /Linked machines is off/],
    ['the text is not a code', {}, () => 'hello there', 'a'.repeat(64), /not a link code/],
    ['it is a phone QR, not a link code', {}, (h: ReturnType<typeof host>) => h.offer.qrPayload, 'a'.repeat(64), /not a link code/],
    ['the key main sent is not a key', {}, (h: ReturnType<typeof host>) => h.code, 'A'.repeat(64), /could not make a key/],
    ['the key main sent is not even text', {}, (h: ReturnType<typeof host>) => h.code, 42, /could not make a key/],
  ])('refuses at once when %s', (_label, init, code, secretKey, message) => {
    const ctx = core(init)
    ctx.c.handleHostMessage({ kind: 'joinLink', code: code(host()), secretKey: secretKey as string, label: 'x' })
    expect(ctx.last('joinFailed')?.message).toMatch(message)
    expect(ctx.rooms).toEqual([])
  })

  it('refuses the code this very machine is showing', () => {
    const ctx = core()
    ctx.c.handleHostMessage({ kind: 'beginPairing', label: '', link: true })
    const code = ctx.last('pairingCode')!.linkCode!
    const rooms = ctx.rooms.length
    ctx.c.handleHostMessage({ kind: 'joinLink', code, secretKey: generateIdentity().secretKey, label: 'x' })
    expect(ctx.last('joinFailed')?.message).toBe('That code was made on this computer. Enter it on the other one.')
    expect(ctx.rooms).toHaveLength(rooms)
  })

  it('refuses a seventeenth link', () => {
    const ctx = core({ links: Array.from({ length: MAX_LINKED_MACHINES }, () => joinedLink().link) })
    ctx.c.handleHostMessage({ kind: 'joinLink', code: host().code, secretKey: 'a'.repeat(64), label: 'x' })
    expect(ctx.last('joinFailed')?.message).toMatch(/already has 16 linked machines/)
  })
})

describe('linked rooms through the real relay client', () => {
  // Production passes no `openRelay`. Stubbing it everywhere would leave the
  // one factory a user actually reaches unexercised.
  function realCore(init: Partial<Omit<InitMsg, 'kind'>> = {}) {
    const sent: BridgeToHost[] = []
    const c = createBridgeCore({
      send: (m) => sent.push(m),
      mcp: { callTool: vi.fn() },
      relayUrl: 'ws://127.0.0.1:1',
      desktopName: 'Bench desktop',
    })
    c.handleHostMessage({
      kind: 'init',
      mcpPort: 1,
      mcpToken: 't',
      identitySecretKey: HOST.secretKey,
      devices: [],
      linked: true,
      ...init,
    })
    return { c, sent }
  }

  it('dials a joined link, and lets it go on shutdown', async () => {
    // Port 1 refuses at once: what matters is that the default factory builds,
    // dials, and survives the refusal.
    const { c } = realCore({ links: [joinedLink('ws://127.0.0.1:1').link] })
    await new Promise((r) => setTimeout(r, 50))
    expect(() => c.handleHostMessage({ kind: 'shutdown' })).not.toThrow()
  })

  it('survives a join cancelled before its socket has connected', async () => {
    // The `ws` close-while-connecting trap: `error` arrives on the next tick,
    // and without a listener it is an uncaught exception that ends the bridge.
    const { c, sent } = realCore()
    const h = createPairingOffer({ relayUrl: 'ws://127.0.0.1:1', desktopPublicKey: generateIdentity().publicKey })
    c.handleHostMessage({
      kind: 'joinLink',
      code: encodeLinkCode(h.qrPayload),
      secretKey: generateIdentity().secretKey,
      label: 'x',
    })
    c.handleHostMessage({ kind: 'cancelJoin' })
    await new Promise((r) => setTimeout(r, 50))
    expect(sent.filter((m) => m.kind === 'joinFailed')).toEqual([])
    c.handleHostMessage({ kind: 'shutdown' })
  })
})

describe('which errors are Linked machines\' to show', () => {
  // The bridge's errors name no owner, and main used to route them by the offer
  // alone -- so a relay cut on a link room, which has nothing to do with any
  // offer, reached the PHONE pane's error banner. `scope: 'link'` says whose an
  // error is wherever the bridge knows; an error about a phone stays unmarked,
  // exactly the message it was before linked machines existed.
  const scopes = (ctx: ReturnType<typeof core>): Array<string | undefined> =>
    ctx.all('error').map((e) => e.scope)

  /** A computer's hello that opens -- right pairing id and key -- carrying the
   *  wrong one-time secret, so the pairing itself is refused. */
  function badSecretHello(ctx: ReturnType<typeof core>, peer: 'desktop' | undefined): Uint8Array {
    const shown = ctx.last('pairingCode')!
    const offer = parseLinkCode(shown.linkCode ?? encodeLinkCode(shown.qrPayload))!
    const key = generateIdentity()
    return sealPairingHello({
      deviceSecretKey: key.secretKey,
      devicePublicKey: key.publicKey,
      desktopPublicKey: offer.desktopPublicKey,
      pairingId: offer.pairingId,
      label: 'x',
      oneTimeSecret: generateIdentity().secretKey,
      peer,
    })
  }
  const feed = (ctx: ReturnType<typeof core>, frame: Uint8Array): void =>
    (ctx.rooms.at(-1)!.deps as PairingRelayDeps).onFrame(frame)

  it('marks a relay cut on a joined link room, and a link record it skipped', () => {
    const good = joinedLink().link
    const ctx = core({ links: [{ ...joinedLink().link, secretKey: 'not hex' }, good] })
    ctx.roomFor(good.sessionRoomId)!.deps.onQuota?.('frame-rate')
    expect(ctx.all('error')).toEqual([
      { kind: 'error', message: 'a linked machine record is malformed and was skipped', scope: 'link' },
      { kind: 'error', message: 'relay closed a linked machine connection: frame-rate', scope: 'link' },
    ])
  })

  it("marks a relay cut on a hosted computer's room, and leaves a phone's unmarked", () => {
    const desk = hostedComputer()
    const pho = phone()
    const ctx = core({ devices: [desk, pho], phones: true, linked: true })
    ctx.roomFor(desk.sessionRoomId)!.deps.onQuota?.('frame-size')
    ctx.roomFor(pho.sessionRoomId)!.deps.onQuota?.('frame-rate')
    expect(ctx.all('error')).toEqual([
      { kind: 'error', message: 'relay closed the build-box connection: frame-size', scope: 'link' },
      { kind: 'error', message: 'relay closed the Pixel connection: frame-rate' },
    ])
  })

  it("marks a relay cut on a link code's room, and leaves a phone QR's unmarked", () => {
    const ctx = core()
    ctx.c.handleHostMessage({ kind: 'beginPairing', label: '', link: true })
    ctx.rooms.at(-1)!.deps.onQuota?.('idle')
    ctx.c.handleHostMessage({ kind: 'beginPairing', label: 'Pixel' })
    ctx.rooms.at(-1)!.deps.onQuota?.('idle')
    expect(ctx.all('error')).toEqual([
      { kind: 'error', message: 'relay closed the pairing connection: idle', scope: 'link' },
      { kind: 'error', message: 'relay closed the pairing connection: idle' },
    ])
  })

  it('marks every refusal of a link code, and none of a phone QR', () => {
    expect(scopes(withRefusal({ linked: false }, true))).toEqual(['link'])
    expect(scopes(withRefusal({ phones: false }, false))).toEqual([undefined])
    const crowded = core({ links: Array.from({ length: MAX_LINKED_MACHINES }, () => joinedLink().link) })
    crowded.c.handleHostMessage({ kind: 'beginPairing', label: '', link: true })
    expect(scopes(crowded)).toEqual(['link'])
    const plain = core({}, { relayUrl: 'ws://192.168.1.20:8787' })
    plain.c.handleHostMessage({ kind: 'beginPairing', label: '', link: true })
    expect(scopes(plain)).toEqual(['link'])

    function withRefusal(init: Partial<Omit<InitMsg, 'kind'>>, link: boolean): ReturnType<typeof core> {
      const ctx = core(init)
      ctx.c.handleHostMessage({ kind: 'beginPairing', label: '', link })
      return ctx
    }
  })

  it("marks a link code's refusals of a hello; a phone QR refusing a computer stays the phone pane's", () => {
    const ctx = core()
    ctx.c.handleHostMessage({ kind: 'beginPairing', label: '', link: true })
    // Held now: the link rooms opened below come after it in `rooms`.
    const pairingRoom = ctx.rooms.at(-1)!.deps as PairingRelayDeps
    pairingRoom.onFrame(badSecretHello(ctx, undefined))
    pairingRoom.onFrame(badSecretHello(ctx, 'desktop'))
    ctx.c.handleHostMessage({ kind: 'setLinks', links: Array.from({ length: MAX_LINKED_MACHINES }, () => joinedLink().link) })
    pairingRoom.onFrame(badSecretHello(ctx, 'desktop'))
    expect(ctx.all('error').map((e) => [e.message.split(':')[0], e.scope])).toEqual([
      ['That code is for linking another computer, not a phone.', 'link'],
      ['pairing failed', 'link'],
      [`This computer already has ${MAX_LINKED_MACHINES} linked machines. Unlink one before linking another.`, 'link'],
    ])

    const phoneOffer = core()
    phoneOffer.c.handleHostMessage({ kind: 'beginPairing', label: 'Pixel' })
    feed(phoneOffer, badSecretHello(phoneOffer, 'desktop'))
    feed(phoneOffer, badSecretHello(phoneOffer, undefined))
    expect(phoneOffer.all('error').map((e) => [e.message.split(':')[0], e.scope])).toEqual([
      ['That code is for a phone. Create a code under Settings ▸ Linked machines.', undefined],
      ['pairing failed', undefined],
    ])
  })
})
