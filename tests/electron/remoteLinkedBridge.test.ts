// Two bridge cores, joined through the in-memory relay, doing what two Termpolis
// desktops do when they link: one shows a code, the other enters it, both see
// the same safety words, and from then on each can ask the other things over
// one sealed session. Nothing is stubbed between the two cores but the network.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createBridgeCore, type BridgeCore } from '../../src/main/remoteBridge/entry'
import { generateIdentity } from '../../src/main/remoteBridge/sealedChannel'
import { deriveSessionRoomId } from '../../src/main/remoteBridge/sessionCrypto'
import { sealPairingHello } from '../../src/main/remoteBridge/pairing'
import { LINK_OFFER_TTL_MS, encodeLinkCode, parseLinkCode } from '../../src/main/remoteBridge/linkCode'
import {
  NO_CAPABILITIES,
  type BridgeLink,
  type BridgeToHost,
  type HostToBridge,
  type LinkTarget,
  type PairedDevice,
  type PeerHelloInfo,
  type PeerRequest,
} from '../../src/main/remoteBridge/protocol'
import { createMemoryRelay, relayOpener, type MemoryRelay } from './fixtures/memoryRelay'

const RELAY_URL = 'wss://relay.test'

type Msg<K extends BridgeToHost['kind']> = Extract<BridgeToHost, { kind: K }>

/** One Termpolis desktop: a real bridge core, and a stand-in for its main
 *  process that does what the linked-machines host in main will do -- answer
 *  `peerRequest`s, persist a joined link and hand it back with `setLinks`, and
 *  drop a link the other side said goodbye to. */
interface Machine {
  name: string
  identity: { secretKey: string; publicKey: string }
  core: BridgeCore
  sent: BridgeToHost[]
  links: BridgeLink[]
  /** Every `peerRequest` main was asked, in order. */
  asked: Array<{ from: LinkTarget; request: PeerRequest }>
  /** Per-link secrets minted for a join, by public key, until `linkJoined`
   *  names one -- main keeps the secret and the bridge never echoes it back. */
  pendingSecrets: Map<string, string>
  send(msg: HostToBridge): void
  all<K extends BridgeToHost['kind']>(kind: K): Array<Msg<K>>
  last<K extends BridgeToHost['kind']>(kind: K): Msg<K> | undefined
}

const machines: Machine[] = []
afterEach(() => {
  // Every relay client holds a keepalive interval and, after a drop, a redial
  // timer. A core left running outlives its test.
  for (const m of machines.splice(0)) m.send({ kind: 'shutdown' })
})

function helloFor(name: string): PeerHelloInfo {
  return {
    name,
    agents: { claude: true, codex: true, gemini: false },
    grants: { run: true, write: false },
    confirmed: true,
    version: '1.50.0',
  }
}

function machine(
  relay: MemoryRelay,
  name: string,
  init: { phones?: boolean; linked?: boolean; devices?: PairedDevice[] } = {},
): Machine {
  const identity = generateIdentity()
  const pendingSecrets = new Map<string, string>()
  const m: Machine = {
    name,
    identity,
    sent: [],
    links: [],
    asked: [],
    pendingSecrets,
    core: null as unknown as BridgeCore,
    send: (msg) => m.core.handleHostMessage(msg),
    all: <K extends BridgeToHost['kind']>(kind: K) =>
      m.sent.filter((x): x is Msg<K> => x.kind === kind),
    last: <K extends BridgeToHost['kind']>(kind: K) => m.all(kind).at(-1),
  }

  /** Main, reacting to the bridge. Asynchronous, as a message across the
   *  utilityProcess port is. */
  function main(msg: BridgeToHost): void {
    switch (msg.kind) {
      case 'peerRequest':
        m.asked.push({ from: msg.from, request: msg.request })
        if (msg.request.kind === 'peerHello') {
          m.send({ kind: 'peerReply', callId: msg.callId, ok: true, data: helloFor(name) })
        } else {
          m.send({ kind: 'peerReply', callId: msg.callId, ok: false, message: `${name} has no jobs` })
        }
        return
      case 'linkJoined': {
        const secretKey = pendingSecrets.get(msg.publicKey)
        if (!secretKey) return
        pendingSecrets.delete(msg.publicKey)
        m.links.push({
          id: msg.deviceId,
          hostPublicKey: msg.hostPublicKey,
          relayUrl: msg.relayUrl,
          sessionRoomId: msg.sessionRoomId,
          secretKey,
        })
        m.send({ kind: 'setLinks', links: m.links })
        return
      }
      case 'linkBye':
        if (msg.from.via === 'link') {
          m.links = m.links.filter((l) => l.id !== msg.from.id)
          m.send({ kind: 'setLinks', links: m.links })
        }
        return
      default:
        return
    }
  }

  m.core = createBridgeCore({
    send: (msg) => {
      m.sent.push(msg)
      queueMicrotask(() => main(msg))
    },
    mcp: { callTool: vi.fn().mockResolvedValue({ terminals: [] }) },
    relayUrl: RELAY_URL,
    desktopName: name,
    openRelay: relayOpener(relay),
  })
  m.send({
    kind: 'init',
    mcpPort: 1,
    mcpToken: 't',
    identitySecretKey: identity.secretKey,
    devices: init.devices ?? [],
    links: [],
    phones: init.phones ?? true,
    linked: init.linked ?? true,
  })
  machines.push(m)
  return m
}

/** Enter a code on `m`, with a keypair minted for this one link -- as main does. */
function join(m: Machine, code: string): { secretKey: string; publicKey: string } {
  const key = generateIdentity()
  m.pendingSecrets.set(key.publicKey, key.secretKey)
  m.send({ kind: 'joinLink', code, secretKey: key.secretKey, label: m.name })
  return key
}

/** Show a link code on `m` and hand back the code. */
function showCode(m: Machine): string {
  m.send({ kind: 'beginPairing', label: '', link: true })
  const code = m.last('pairingCode')?.linkCode
  if (!code) throw new Error('no link code was shown')
  return code
}

/** Whether a hosted computer's room is attached, as main was last told. */
function hostedAttached(m: Machine, deviceId: string): boolean {
  const last = m.sent
    .filter(
      (x): x is Msg<'deviceConnected'> | Msg<'deviceDisconnected'> =>
        (x.kind === 'deviceConnected' || x.kind === 'deviceDisconnected') && x.deviceId === deviceId,
    )
    .at(-1)
  return last?.kind === 'deviceConnected'
}

function joinedAttached(m: Machine, id: string): boolean {
  return m.all('linkStateChanged').filter((x) => x.id === id).at(-1)?.attached === true
}

/** Link `joiner` to `host` end to end and wait until both rooms are attached. */
async function link(relay: MemoryRelay, host: Machine, joiner: Machine) {
  const code = showCode(host)
  join(joiner, code)
  await vi.waitFor(() => expect(joiner.last('linkJoined')).toBeDefined())
  const joined = joiner.last('linkJoined')!
  await vi.waitFor(() => {
    expect(hostedAttached(host, joined.deviceId)).toBe(true)
    expect(joinedAttached(joiner, joined.deviceId)).toBe(true)
  })
  await relay.settle()
  return { code, joined, deviceId: joined.deviceId }
}

let callSeq = 0
/** Ask the other machine something through `m`'s bridge, as main's `linkCall` does. */
async function call(m: Machine, target: LinkTarget, request: PeerRequest, timeoutMs = 5_000) {
  const callId = `call-${++callSeq}`
  m.send({ kind: 'linkCall', callId, target, request, timeoutMs })
  let result: Msg<'linkCallResult'> | undefined
  await vi.waitFor(() => {
    result = m.all('linkCallResult').find((r) => r.callId === callId)
    expect(result).toBeDefined()
  })
  return result!
}

describe('linking two machines over the relay', () => {
  it('pairs with the same safety words on both screens', async () => {
    const relay = createMemoryRelay()
    const a = machine(relay, 'studio')
    const b = machine(relay, 'build-box')

    const before = Date.now()
    const code = showCode(a)
    const shown = a.last('pairingCode')!
    // Five minutes, not ninety seconds: this code has to be carried to another computer.
    expect(shown.expiresAt).toBeGreaterThanOrEqual(before + LINK_OFFER_TTL_MS)
    expect(parseLinkCode(code)).toEqual(JSON.parse(shown.qrPayload))

    const key = join(b, code)
    await vi.waitFor(() => expect(b.last('linkJoined')).toBeDefined())
    const joined = b.last('linkJoined')!
    const paired = a.last('paired')!.device

    // The host records a computer, not a phone, and grants it no phone powers.
    expect(paired.kind).toBe('desktop')
    expect(paired.capabilities).toEqual(NO_CAPABILITIES)
    expect(paired.label).toBe('build-box')
    expect(paired.publicKey).toBe(key.publicKey)

    // Both screens show the same eight words, derived from the same two keys.
    expect(joined.phrase).toBe(a.last('verificationPhrase')!.phrase)
    expect(joined.phrase.split(' ')).toHaveLength(8)
    expect(joined).toMatchObject({
      publicKey: key.publicKey,
      hostPublicKey: a.identity.publicKey,
      hostName: 'studio',
      deviceId: paired.id,
      sessionRoomId: paired.sessionRoomId,
      relayUrl: RELAY_URL,
    })

    // Both ends leave the pairing room: it was named on screen, and is used once.
    await relay.settle()
    const pairingId = JSON.parse(shown.qrPayload).pairingId as string
    expect(relay.seats(pairingId)).toEqual({ desktop: false, device: false })
    expect(b.all('joinFailed')).toEqual([])
  })

  it('carries requests both ways over the one session', async () => {
    const relay = createMemoryRelay()
    const a = machine(relay, 'studio')
    const b = machine(relay, 'build-box')
    const { deviceId } = await link(relay, a, b)

    // The host asks the machine that joined it...
    const there = await call(a, { via: 'device', id: deviceId }, { kind: 'peerHello' })
    expect(there).toEqual({ kind: 'linkCallResult', callId: there.callId, ok: true, data: helloFor('build-box') })
    expect(b.asked).toEqual([{ from: { via: 'link', id: deviceId }, request: { kind: 'peerHello' } }])

    // ...and the joiner asks the host, over the same room.
    const back = await call(b, { via: 'link', id: deviceId }, { kind: 'peerHello' })
    expect(back).toMatchObject({ ok: true, data: helloFor('studio') })
    expect(a.asked).toEqual([{ from: { via: 'device', id: deviceId }, request: { kind: 'peerHello' } }])

    // A refusal from the far main comes back as a refusal, message intact.
    const refused = await call(a, { via: 'device', id: deviceId }, { kind: 'peerResult', jobId: 'j1', waitMs: 0 })
    expect(refused).toMatchObject({ ok: false, message: 'build-box has no jobs' })
    expect(relay.refusals).toEqual([])
  })

  it('lets two machines each host a link to the other at the same time', async () => {
    // The reason a joiner uses a fresh keypair per link. The session room is a
    // DH over the two keys, which is symmetric -- so if each machine joined with
    // its IDENTITY, A-hosts-B and B-hosts-A would name the same room, and the
    // second desktop seat would be refused with a 409 forever.
    const relay = createMemoryRelay()
    const a = machine(relay, 'studio')
    const b = machine(relay, 'build-box')
    expect(deriveSessionRoomId(a.identity.secretKey, b.identity.publicKey)).toBe(
      deriveSessionRoomId(b.identity.secretKey, a.identity.publicKey),
    )

    const ab = await link(relay, a, b)
    const ba = await link(relay, b, a)
    expect(ab.joined.sessionRoomId).not.toBe(ba.joined.sessionRoomId)

    await expect(call(a, { via: 'device', id: ab.deviceId }, { kind: 'peerHello' })).resolves.toMatchObject({ ok: true })
    await expect(call(a, { via: 'link', id: ba.deviceId }, { kind: 'peerHello' })).resolves.toMatchObject({ ok: true })
    await expect(call(b, { via: 'device', id: ba.deviceId }, { kind: 'peerHello' })).resolves.toMatchObject({ ok: true })
    await expect(call(b, { via: 'link', id: ab.deviceId }, { kind: 'peerHello' })).resolves.toMatchObject({ ok: true })
    expect(relay.refusals).toEqual([])
  })

  it('refuses a phone on a link code, and keeps the code alive for the computer', async () => {
    const relay = createMemoryRelay()
    const a = machine(relay, 'studio')
    const b = machine(relay, 'build-box')
    const code = showCode(a)
    const offer = parseLinkCode(code)!

    // A phone -- or anything speaking the phone's hello -- in the link room.
    const phone = generateIdentity()
    const sock = relay.openSocket(`${RELAY_URL}/v1/pair/${offer.pairingId}?role=device`)
    sock.on('error', (() => {}) as never)
    sock.on('message', ((data: Buffer, isBinary: boolean) => {
      if (isBinary || JSON.parse(data.toString('utf8')).kind !== 'hello') return
      sock.send(
        sealPairingHello({
          deviceSecretKey: phone.secretKey,
          devicePublicKey: phone.publicKey,
          desktopPublicKey: offer.desktopPublicKey,
          pairingId: offer.pairingId,
          label: 'Pixel',
          oneTimeSecret: offer.oneTimeSecret,
        }),
      )
    }) as never)
    await vi.waitFor(() =>
      expect(a.last('error')?.message).toBe('That code is for linking another computer, not a phone.'),
    )
    expect(a.all('paired')).toEqual([])

    // The offer was not spent: the computer it was meant for still links.
    sock.close()
    await relay.settle()
    join(b, code)
    await vi.waitFor(() => expect(b.last('linkJoined')).toBeDefined())
    expect(a.last('paired')?.device.kind).toBe('desktop')
  })

  it('refuses a computer on a phone QR', async () => {
    const relay = createMemoryRelay()
    const a = machine(relay, 'studio')
    const b = machine(relay, 'build-box')
    a.send({ kind: 'beginPairing', label: 'Pixel' })
    const qr = a.last('pairingCode')!
    expect(qr.linkCode).toBeUndefined()

    // Wrapped by hand: the host never hands out a phone QR as a link code.
    join(b, encodeLinkCode(qr.qrPayload))
    await vi.waitFor(() =>
      expect(a.last('error')?.message).toBe(
        'That code is for a phone. Create a code under Settings ▸ Linked machines.',
      ),
    )
    expect(a.all('paired')).toEqual([])
    expect(b.all('linkJoined')).toEqual([])
    b.send({ kind: 'cancelJoin' })
  })

  it('takes the joiner off the host when it says goodbye, and closes both rooms', async () => {
    const relay = createMemoryRelay()
    const a = machine(relay, 'studio')
    const b = machine(relay, 'build-box')
    const { deviceId, joined } = await link(relay, a, b)

    const bye = await call(b, { via: 'link', id: deviceId }, { kind: 'peerBye' })
    expect(bye).toMatchObject({ ok: true, data: null })

    await vi.waitFor(() => expect(a.last('linkBye')).toEqual({ kind: 'linkBye', from: { via: 'device', id: deviceId } }))
    expect(a.last('devicesChanged')?.devices).toEqual([])
    // Only `peer*` kinds were ever served, and peerBye never reaches main.
    expect(a.asked).toEqual([])

    // The joiner's main drops the link once it hears the answer.
    b.links = []
    b.send({ kind: 'setLinks', links: [] })
    await relay.settle()
    expect(relay.seats(joined.sessionRoomId)).toEqual({ desktop: false, device: false })
  })

  it('drops the link on the joiner when the host says goodbye', async () => {
    const relay = createMemoryRelay()
    const a = machine(relay, 'studio')
    const b = machine(relay, 'build-box')
    const { deviceId, joined } = await link(relay, a, b)

    const bye = await call(a, { via: 'device', id: deviceId }, { kind: 'peerBye' })
    expect(bye).toMatchObject({ ok: true, data: null })
    await vi.waitFor(() => expect(b.last('linkBye')).toEqual({ kind: 'linkBye', from: { via: 'link', id: deviceId } }))
    expect(b.links).toEqual([])

    // The host's main then revokes its own record, which closes its room.
    a.send({ kind: 'revokeDevice', deviceId })
    await relay.settle()
    expect(relay.seats(joined.sessionRoomId)).toEqual({ desktop: false, device: false })
    expect(b.asked).toEqual([])
  })

  it('answers offline at once for a machine that is not there', async () => {
    const relay = createMemoryRelay()
    const a = machine(relay, 'studio')
    const b = machine(relay, 'build-box')
    const { deviceId } = await link(relay, a, b)

    // The host goes away. The joiner's room is still seated, alone.
    a.send({ kind: 'shutdown' })
    await vi.waitFor(() => expect(joinedAttached(b, deviceId)).toBe(false))
    const started = Date.now()
    await expect(call(b, { via: 'link', id: deviceId }, { kind: 'peerHello' }, 30_000)).resolves.toMatchObject({
      ok: false,
      message: 'offline',
    })
    // Not after a 30 s timeout -- at once.
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('comes back by itself after the relay drops the link', async () => {
    const relay = createMemoryRelay()
    const a = machine(relay, 'studio')
    const b = machine(relay, 'build-box')
    const { deviceId, joined } = await link(relay, a, b)

    relay.drop(joined.sessionRoomId, 'device')
    await vi.waitFor(() => expect(joinedAttached(b, deviceId)).toBe(false))
    // Redialled on the backoff, greeted again, attached again -- untouched by main.
    await vi.waitFor(() => expect(joinedAttached(b, deviceId)).toBe(true), { timeout: 5_000 })
    await vi.waitFor(() => expect(hostedAttached(a, deviceId)).toBe(true))
    await expect(call(b, { via: 'link', id: deviceId }, { kind: 'peerHello' })).resolves.toMatchObject({ ok: true })
  })

  it('survives a join cancelled while its socket is still connecting', async () => {
    // `ws` reports a close-while-connecting as `error` on the next tick. A socket
    // with no error listener throws it -- in the utilityProcess, a crash. The
    // in-memory relay throws exactly as an EventEmitter does, so this test fails
    // with an unhandled error if the listener is ever lost.
    const relay = createMemoryRelay()
    const a = machine(relay, 'studio')
    const b = machine(relay, 'build-box')
    const code = showCode(a)
    join(b, code)
    b.send({ kind: 'cancelJoin' })
    await relay.settle()
    expect(b.all('joinFailed')).toEqual([])
    expect(b.all('linkJoined')).toEqual([])

    // And the code is still good for a second try.
    join(b, code)
    await vi.waitFor(() => expect(b.last('linkJoined')).toBeDefined())
  })

  it('opens a hosted computer only when linked machines is on, and a phone only when Remote is', async () => {
    const relay = createMemoryRelay()
    const a = machine(relay, 'studio')
    const b = machine(relay, 'build-box')
    const { deviceId, joined } = await link(relay, a, b)
    const desk = a.last('paired')!.device

    // The same records, handed to a bridge with only phones on: the computer's
    // room stays shut, and the joiner's link sits alone.
    a.send({ kind: 'shutdown' })
    await relay.settle()
    const phonesOnly = machine(relay, 'studio-again', { phones: true, linked: false, devices: [desk] })
    await relay.settle()
    expect(relay.seats(joined.sessionRoomId)).toEqual({ desktop: false, device: true })
    expect(phonesOnly.all('deviceConnected')).toEqual([])
    expect(joinedAttached(b, deviceId)).toBe(false)
  })
})
