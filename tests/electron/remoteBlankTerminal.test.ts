// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { setSafeStorage } from '../../src/main/secureKeyStore'
import { createBridgeCore, type BridgeCore, type RelayLike } from '../../src/main/remoteBridge/entry'
import { generateIdentity } from '../../src/main/remoteBridge/sealedChannel'
import { deriveSessionRoomId } from '../../src/main/remoteBridge/sessionCrypto'
import { MAX_PAYLOAD_BYTES } from '../../src/main/remoteBridge/outputChunker'
import {
  NO_CAPABILITIES,
  type BridgeToHost,
  type HostToBridge,
  type PairedDevice,
  type RemoteEnvelope,
  type RemoteRequest,
} from '../../src/main/remoteBridge/protocol'
import type { RelayState, SessionRelayDeps } from '../../src/main/remoteBridge/relayClient'
import { saveRemoteDevices } from '../../src/main/remoteDeviceStore'
import { getOrCreateRemoteIdentity } from '../../src/main/remoteIdentityStore'
import { saveRemoteSettings } from '../../src/main/remoteSettings'
import { createRemoteHost, type RemoteHost } from '../../src/main/remoteBridgeHost'
import {
  appendOutput,
  readOutput,
  readOutputFrom,
  type OutputBuffers,
} from '../../src/main/terminalOutputBuffer'
import { RemoteSession, type StatusUpdate } from '../../mobile/src/net/remoteSession'
import { utf8Decode, utf8Encode } from '../../mobile/src/wire/bytes'
import type { OutputChunk } from '../../mobile/src/wire/protocol'

// "When I click into a terminal it does not show the output or what the agent
// is working on until I type any kind of message."
//
// Every layer between the pty and the phone's screen, real, with only the
// process boundary and the network faked: main's rolling buffer and the host
// with both of its pumps, the bridge core with its emulator and fan-out, and
// the phone's own session and parser out of mobile/src. Each layer had a unit
// test that passed while the whole was blank -- the gap was in the seams, so
// the seams are what this drives.

const XOR = 0x5a
function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from([...Buffer.from(s, 'utf8')].map((b) => b ^ XOR)),
    decryptString: (b: Buffer) => Buffer.from([...b].map((x) => x ^ XOR)).toString('utf8'),
  }
}

/** A TUI agent sitting at its prompt: it drew this once and is waiting. */
const AGENT_SCREEN = 'Claude Code\r\n\r\n> waiting for input'

/** What the phone shows, minus colour. */
function plain(text: string | undefined): string {
  return (text ?? '').replace(/\x1b\[[0-9;]*m/g, '')
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

/** The phone's store applying output: mobile/src/state/remoteStore.ts,
 *  `live.onOutput`, line for line. Copied because that module imports
 *  react-native. It is the rule the 1.1.0 phone in people's hands runs, and
 *  the first test below reads the store's source so this copy cannot drift
 *  from it in silence. */
const MAX_OUTPUT_CHARS = 200_000
function applyOutput(phone: Phone, chunks: OutputChunk[]): void {
  const { output, outputEnd } = phone
  for (const c of chunks) {
    const held = output[c.terminalId] ?? ''
    const heldEnd = outputEnd[c.terminalId] ?? 0
    const gap = c.missed > 0 && c.marker !== null ? c.marker : ''
    const keep =
      c.replaceFrom === null
        ? held.length
        : Math.min(held.length, Math.max(0, held.length - (heldEnd - c.replaceFrom)))
    const joined = held.slice(0, keep) + gap + c.chunk
    output[c.terminalId] =
      joined.length > MAX_OUTPUT_CHARS ? joined.slice(joined.length - MAX_OUTPUT_CHARS) : joined
    outputEnd[c.terminalId] =
      c.replaceFrom === null
        ? heldEnd + c.missed + c.chunk.length
        : c.replaceFrom + c.chunk.length
  }
}

/** A relay room as the bridge sees it, wired straight to the phone in it. */
interface Room extends RelayLike {
  deps: SessionRelayDeps
  state: RelayState
  phone: Phone | null
  /** Every payload put on the wire, to hold against the relay's frame cap. */
  sent: unknown[]
}

interface Phone {
  device: PairedDevice
  session: RemoteSession
  room: Room | null
  output: Record<string, string>
  outputEnd: Record<string, number>
  statuses: StatusUpdate[]
}

type InitParams = Omit<Extract<HostToBridge, { kind: 'init' }>, 'kind'>

let dir: string
let desk: ReturnType<typeof desktop>

/** Main, the bridge child it supervises, and the relay between them and the
 *  phones. Messages cross the process boundary through queues that `settle`
 *  drains, because the real boundary is asynchronous -- delivering them inline
 *  would run orders the app can never produce. */
function desktop(devices: PairedDevice[]) {
  saveRemoteSettings(dir, { enabled: true })
  saveRemoteDevices(dir, devices)

  const buffers: OutputBuffers = new Map()
  const timers: Array<() => void> = []
  const toBridge: HostToBridge[] = []
  const toHost: BridgeToHost[] = []
  const rooms: Room[] = []
  const cores: BridgeCore[] = []
  let bridge: BridgeCore | null = null
  let launched: { init: InitParams; relayUrl: string } | null = null
  let fromBridge: (m: BridgeToHost) => void = () => {}
  let inflight = 0

  /** What the relay client does with a payload, minus the sealing: serialise it
   *  and hand it to whoever is in the room. */
  function deliver(room: Room, payload: unknown): void {
    if (room.state !== 'attached' || room.phone === null) return
    room.sent.push(payload)
    room.phone.session.handleFrame(utf8Encode(JSON.stringify(payload)))
  }

  /** Start a bridge child the way the supervisor does: a new process, handed the
   *  init captured at launch. A respawn after a crash goes through here too,
   *  and main's host is never told one happened. */
  function spawn(): void {
    const core: BridgeCore = createBridgeCore({
      // A dead child says nothing more.
      send: (m) => {
        if (bridge === core) toHost.push(m)
      },
      mcp: { callTool: async () => ({ terminals: [] }) },
      relayUrl: launched!.relayUrl,
      desktopName: 'Bench desktop',
      openRelay: (deps) => {
        const room: Room = {
          deps: deps as SessionRelayDeps,
          state: 'connecting',
          phone: null,
          sent: [],
          start() {},
          send: (payload) => deliver(room, payload),
          sendFrame() {},
          stop() {
            room.state = 'offline'
            if (room.phone) room.phone.room = null
            room.phone = null
          },
        }
        rooms.push(room)
        return room
      },
    })
    cores.push(core)
    bridge = core
    toBridge.push({ kind: 'init', ...launched!.init })
  }

  const host: RemoteHost = createRemoteHost({
    userDataDir: dir,
    mcpPort: 3369,
    mcpToken: 'mcp-token',
    sendStatus: () => undefined,
    sendEvent: () => undefined,
    readOutput: (id, from) => readOutputFrom(buffers, id, from),
    readRecent: (id) => (buffers.has(id) ? { output: readOutput(buffers, id), name: id } : null),
    terminalSize: (id) => (buffers.has(id) ? { cols: 80, rows: 24 } : null),
    startBridge: (init, relayUrl) => {
      launched = { init, relayUrl }
      spawn()
    },
    stopBridge: () => {
      bridge = null
    },
    // The supervisor drops a message when no child is running.
    sendToBridge: (msg) => {
      if (bridge) toBridge.push(msg)
    },
    onBridgeMessage: (cb) => {
      fromBridge = cb
    },
    isBridgeRunning: () => bridge !== null,
    isDisabled: () => false,
    clearDisabled: () => undefined,
    setTimer: (fn) => {
      timers.push(fn)
      return timers.length
    },
    clearTimer: () => undefined,
  })

  /** Run every message, request and emulator write to completion. */
  async function settle(): Promise<void> {
    for (let round = 0; round < 200; round += 1) {
      const moved = toBridge.length + toHost.length + inflight > 0
      while (toBridge.length + toHost.length > 0) {
        const down = toBridge.shift()
        if (down) bridge?.handleHostMessage(down)
        const up = toHost.shift()
        if (up) fromBridge(up)
      }
      await bridge?.settled()
      await new Promise((resolve) => setImmediate(resolve))
      if (!moved && toBridge.length + toHost.length + inflight === 0) return
    }
    throw new Error('the desktop never went quiet')
  }

  function request(phone: Phone, plaintext: Uint8Array): void {
    const room = phone.room
    if (room === null || room.state !== 'attached') return
    const env = JSON.parse(utf8Decode(plaintext)) as RemoteEnvelope
    inflight += 1
    void room.deps
      .onRequest(env)
      .then(
        (response) => deliver(room, response),
        () => undefined,
      )
      .finally(() => {
        inflight -= 1
      })
  }

  /** A request from the phone, answered. */
  async function ask(phone: Phone, req: RemoteRequest): Promise<unknown> {
    if (phone.room === null) throw new Error('the phone is not attached')
    const answer = phone.session.request(req)
    // Awaited below; never left unhandled in between.
    answer.catch(() => undefined)
    await settle()
    return answer
  }

  return {
    host,
    /** A phone app with an empty store, as it is after a cold start. */
    phone(device: PairedDevice): Phone {
      const phone: Phone = {
        device,
        room: null,
        output: {},
        outputEnd: {},
        statuses: [],
        session: new RemoteSession({
          send: (plaintext) => request(phone, plaintext),
          // Inert: every request is answered inside `settle`, long before any
          // real timeout could fire.
          setTimer: () => 0,
          clearTimer: () => undefined,
        }),
      }
      phone.session.onOutput((chunks) => applyOutput(phone, chunks))
      phone.session.onStatus((update) => phone.statuses.push(update))
      return phone
    },
    /** The pty wrote: main buffers it and tells the host, as index.ts does. */
    print(terminalId: string, data: string): void {
      appendOutput(buffers, terminalId, data)
      host.noteTerminalOutput(terminalId)
    },
    /** Fire every timer the pumps have scheduled. */
    tick(): void {
      const due = timers.splice(0, timers.length)
      for (const fn of due) fn()
    },
    settle,
    /** The phone's socket meets the desktop's in the room the CURRENT bridge
     *  opened for it. */
    async attach(phone: Phone): Promise<void> {
      const room = [...rooms]
        .reverse()
        .find((r) => r.deps.roomId === phone.device.sessionRoomId && r.state !== 'offline')
      if (!room) throw new Error(`no open room for ${phone.device.id}`)
      room.phone = phone
      phone.room = room
      room.state = 'attached'
      room.deps.onStateChange('attached')
      await settle()
    },
    /** The phone's link goes -- a tunnel, a lock screen, a killed app. The
     *  desktop keeps its seat in the room and waits. */
    async drop(phone: Phone): Promise<void> {
      const room = phone.room!
      room.phone = null
      phone.room = null
      room.state = 'online'
      room.deps.onStateChange('online')
      await settle()
    },
    /** TerminalScreen mounting. */
    open: (phone: Phone, terminalId: string) => ask(phone, { kind: 'subscribe', terminalId }),
    /** TerminalScreen unmounting. */
    leave: (phone: Phone, terminalId: string) => ask(phone, { kind: 'unsubscribe', terminalId }),
    /** The bridge child dies. Nothing reports it to main, and whatever was in
     *  either pipe dies with it. Shut down only to stop its timers and rooms --
     *  it is already muted, so main hears none of that either. */
    crash(): void {
      const dead = bridge!
      bridge = null
      toBridge.length = 0
      toHost.length = 0
      dead.handleHostMessage({ kind: 'shutdown' })
    },
    /** The supervisor's restart: the same init, and no `launch()` in main. */
    async respawn(): Promise<void> {
      spawn()
      await settle()
    },
    rooms,
    /** Muted first, so tearing the cores down cannot reach a host that is gone. */
    teardown(): void {
      bridge = null
      for (const core of cores) core.handleHostMessage({ kind: 'shutdown' })
    },
  }
}

let devices: Record<string, PairedDevice>

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-blank-'))
  setSafeStorage(fakeSafeStorage())
  const identity = getOrCreateRemoteIdentity(dir)
  devices = {}
  for (const id of ['dev1', 'dev2', 'dev3']) {
    const keys = generateIdentity()
    devices[id] = {
      id,
      label: id,
      publicKey: keys.publicKey,
      sessionRoomId: deriveSessionRoomId(identity.secretKey, keys.publicKey),
      capabilities: { ...NO_CAPABILITIES, read: true },
      pairedAt: Date.now(),
      lastSeenAt: Date.now(),
    }
  }
})

afterEach(() => {
  desk?.teardown()
  setSafeStorage(null)
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

/** A desktop running remote, with one terminal that drew its screen before any
 *  phone was looking and has printed nothing since. */
async function idleAgent(ids: string[] = ['dev1']): Promise<void> {
  desk = desktop(ids.map((id) => devices[id]))
  desk.host.start()
  await desk.settle()
  desk.print('t1', AGENT_SCREEN)
  desk.tick()
  await desk.settle()
}

describe('a phone opening a terminal that is not printing', () => {
  it('models the phone that ships, not a copy that has drifted from it', () => {
    const store = fs
      .readFileSync(path.join(__dirname, '../../mobile/src/state/remoteStore.ts'), 'utf8')
      .replace(/\s+/g, ' ')
    expect(store).toContain('export const MAX_OUTPUT_CHARS = 200_000')
    expect(store).toContain("const gap = c.missed > 0 && c.marker !== null ? c.marker : ''")
    expect(store).toContain(
      'const keep = c.replaceFrom === null ? held.length : Math.min(held.length, Math.max(0, held.length - (heldEnd - c.replaceFrom)))',
    )
    expect(store).toContain('const joined = held.slice(0, keep) + gap + c.chunk')
    expect(store).toContain(
      'outputEnd[c.terminalId] = c.replaceFrom === null ? heldEnd + c.missed + c.chunk.length : c.replaceFrom + c.chunk.length',
    )
  })

  it('shows the screen the moment the phone opens it, before anything prints', async () => {
    // The report itself. No print and no tick after the open: either one is
    // the keystroke that used to make the screen appear, and would hide the bug.
    await idleAgent()
    const phone = desk.phone(devices.dev1)
    await desk.attach(phone)
    await desk.open(phone, 't1')
    expect(plain(phone.output.t1)).toContain('waiting for input')

    // Typing then adds to that screen rather than being what reveals it.
    desk.print('t1', 'h')
    desk.tick()
    await desk.settle()
    const shown = plain(phone.output.t1)
    expect(shown).toContain('> waiting for inputh')
    expect(count(shown, 'Claude Code')).toBe(1)
  })

  it('gives a second phone the screen of a terminal the first is already watching', async () => {
    // Nothing joins main's watched set when the second phone subscribes, so
    // main has nothing to read; the bridge has to hand over the screen it holds.
    await idleAgent(['dev1', 'dev2'])
    const first = desk.phone(devices.dev1)
    const second = desk.phone(devices.dev2)
    await desk.attach(first)
    await desk.open(first, 't1')
    await desk.attach(second)
    await desk.open(second, 't1')
    expect(plain(second.output.t1)).toContain('waiting for input')
    expect(plain(second.output.t1)).toBe(plain(first.output.t1))
  })

  it('shows what a terminal printed while the phone was looking at another one', async () => {
    await idleAgent()
    desk.print('t2', 'PS C:\\repo> ')
    desk.tick()
    const phone = desk.phone(devices.dev1)
    await desk.attach(phone)
    await desk.open(phone, 't1')
    await desk.leave(phone, 't1')
    await desk.open(phone, 't2')
    desk.print('t1', '\r\nbuild finished in 3s')
    desk.tick()
    await desk.settle()
    await desk.leave(phone, 't2')
    await desk.open(phone, 't1')
    const shown = plain(phone.output.t1)
    expect(shown).toContain('build finished in 3s')
    expect(count(shown, 'Claude Code')).toBe(1)
    expect(shown).not.toContain('PS C:')
  })

  it('gives a phone that left without unsubscribing the screen when it comes back', async () => {
    // An app killed in the background, or switched to its other desktop: the
    // subscription is still on this bridge, so the open changes nothing it
    // announces -- and the new store has nothing to draw an increment onto.
    await idleAgent()
    const before = desk.phone(devices.dev1)
    await desk.attach(before)
    await desk.open(before, 't1')
    await desk.drop(before)
    const after = desk.phone(devices.dev1)
    await desk.attach(after)
    await desk.open(after, 't1')
    expect(plain(after.output.t1)).toContain('waiting for input')
  })

  it('serves the screen again after the bridge crashed and restarted under the phone', async () => {
    // The supervisor restarts the child without telling the host, so main's
    // pumps still believe the dead bridge's subscriptions. Without `ready`
    // clearing them, the phone opening the terminal again joins nothing:
    // no read, no status, and a stale or blank screen until the next print.
    await idleAgent()
    const phone = desk.phone(devices.dev1)
    await desk.attach(phone)
    await desk.open(phone, 't1')
    const heard = phone.statuses.length
    desk.crash()
    desk.print('t1', '\r\nprinted while the bridge was down')
    desk.tick()
    await desk.settle()
    await desk.respawn()
    await desk.attach(phone)
    // The phone does not re-subscribe on attach; the user backs out and opens
    // the terminal again.
    await desk.leave(phone, 't1')
    await desk.open(phone, 't1')
    const shown = plain(phone.output.t1)
    expect(shown).toContain('printed while the bridge was down')
    expect(count(shown, 'Claude Code')).toBe(1)
    expect(phone.statuses.length).toBeGreaterThan(heard)
  })
})

describe('the neighbours of that fix', () => {
  it('catches a phone up on what printed while its link was down', async () => {
    await idleAgent()
    const phone = desk.phone(devices.dev1)
    await desk.attach(phone)
    await desk.open(phone, 't1')
    await desk.drop(phone)
    desk.print('t1', '\r\nRunning the tests')
    desk.tick()
    await desk.settle()
    await desk.attach(phone)
    const shown = plain(phone.output.t1)
    expect(shown).toContain('Running the tests')
    expect(count(shown, 'Claude Code')).toBe(1)
  })

  it('opens a terminal with more history than any window holds, without a false gap', async () => {
    desk = desktop([devices.dev1])
    desk.host.start()
    await desk.settle()
    let history = ''
    for (let i = 0; i < 4000; i += 1) history += `line ${i} ${'x'.repeat(50)}\r\n`
    desk.print('t1', `${history}> ready`)
    desk.tick()
    await desk.settle()
    const phone = desk.phone(devices.dev1)
    await desk.attach(phone)
    await desk.open(phone, 't1')
    const shown = plain(phone.output.t1)
    expect(shown).toContain('line 3999')
    expect(shown).toContain('> ready')
    // Main's window lost most of this long before anyone watched. That is
    // history, not output this phone missed, and a marker would say otherwise.
    expect(shown).not.toContain('skipped')
  })

  it('keeps the newest output when a phone falls further behind than its queue holds', async () => {
    await idleAgent()
    const phone = desk.phone(devices.dev1)
    await desk.attach(phone)
    await desk.open(phone, 't1')
    await desk.drop(phone)
    // Escape-dense and well past the per-device queue, in pieces main's window
    // can hold, so the only loss is the queue's own.
    for (let burst = 0; burst < 12; burst += 1) {
      let lines = ''
      for (let i = 0; i < 400; i += 1) lines += `\x1b[3${i % 8}mburst ${burst} line ${i}\x1b[0m ${'y'.repeat(40)}\r\n`
      desk.print('t1', lines)
      desk.tick()
      await desk.settle()
    }
    await desk.attach(phone)
    const shown = plain(phone.output.t1)
    expect(shown).toContain('burst 11 line 399')
    expect(count(shown, 'burst 11 line 399')).toBe(1)
    const sent = desk.rooms.flatMap((r) => r.sent)
    // The loss is reported on the wire, whatever the phone then keeps of it...
    expect(
      sent.some(
        (p) =>
          (p as { kind?: string }).kind === 'output' &&
          (p as { chunks: Array<{ missed: number }> }).chunks.some((c) => c.missed > 0),
      ),
    ).toBe(true)
    // ...and nothing went out in a frame the relay would cut the connection over.
    for (const payload of sent) {
      expect(utf8Encode(JSON.stringify(payload)).length).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES)
    }
  })
})

// The phone draws a gap notice into its copy but leaves it out of the end mark
// it counts every anchor back from, so after a notice its copy runs a notice
// longer than the end mark says. A screen anchored at 0 then kept that many
// chars of the OLD copy's head above itself -- for good, because every later
// anchor counts back from the end the same way, and one more notice's worth
// with every gap.
describe('a phone opening a terminal again after it was shown a gap', () => {
  /** More than main's whole window, printed between two reads of the pump: the
   *  terminal outran it, so the slice it reads reports `missed` and every phone
   *  watching is sent a gap notice. */
  async function outrun(burst: number): Promise<void> {
    let lines = ''
    for (let i = 0; i < 700; i += 1) lines += `burst ${burst} line ${i} ${'z'.repeat(48)}\r\n`
    desk.print('t1', lines)
    desk.tick()
    await desk.settle()
  }

  /** What a phone holding nothing is given for t1 right now: the copy any phone
   *  opening it has to end up with, whatever it held before. Read from a device
   *  that watches t1 neither before nor after, so asking changes nothing about
   *  who is watching. */
  async function fresh(): Promise<string> {
    const phone = desk.phone(devices.dev3)
    await desk.attach(phone)
    await desk.open(phone, 't1')
    const shown = plain(phone.output.t1)
    await desk.leave(phone, 't1')
    return shown
  }

  it('keeps nothing of its old copy when it was the only phone watching', async () => {
    // The last watcher leaving lets the grid go, so opening it again is main's
    // opening read: the whole window, anchored at 0. Twice, because the leftover
    // used to grow by a notice with every gap.
    await idleAgent(['dev1', 'dev3'])
    const phone = desk.phone(devices.dev1)
    await desk.attach(phone)
    await desk.open(phone, 't1')
    for (let burst = 0; burst < 2; burst += 1) {
      await outrun(burst)
      expect(plain(phone.output.t1)).toContain('output skipped')
      await desk.leave(phone, 't1')
      await desk.open(phone, 't1')
      const shown = plain(phone.output.t1)
      expect(shown).toContain(`burst ${burst} line 699`)
      expect(shown).not.toContain('skipped')
      expect(shown).toBe(await fresh())
      // Back in step: nothing held that the end mark does not count.
      expect(phone.output.t1.length).toBe(phone.outputEnd.t1)
    }
  }, 60_000)

  it('keeps nothing of its old copy when another phone is still watching', async () => {
    // The grid stays for the other phone, so this one is seeded from it. Short
    // enough that the screen starts at 0.
    await idleAgent(['dev1', 'dev2', 'dev3'])
    const first = desk.phone(devices.dev1)
    const second = desk.phone(devices.dev2)
    await desk.attach(first)
    await desk.open(first, 't1')
    await desk.attach(second)
    await desk.open(second, 't1')
    await outrun(0)
    expect(plain(second.output.t1)).toContain('output skipped')
    await desk.leave(second, 't1')
    await desk.open(second, 't1')
    const shown = plain(second.output.t1)
    expect(count(shown, 'Claude Code')).toBe(1)
    expect(shown).not.toContain('skipped')
    expect(shown).toBe(await fresh())
    expect(second.output.t1.length).toBe(second.outputEnd.t1)
  }, 60_000)

  it('keeps nothing of its old copy however many gaps it was shown', async () => {
    // Long enough that the screen it is seeded with starts past 0 -- the case
    // that emptied the copy with a separate chunk anchored at 0 first, which
    // kept a notice's worth of it per gap all the same.
    await idleAgent(['dev1', 'dev2', 'dev3'])
    const first = desk.phone(devices.dev1)
    const second = desk.phone(devices.dev2)
    await desk.attach(first)
    await desk.open(first, 't1')
    await desk.attach(second)
    await desk.open(second, 't1')
    for (let burst = 0; burst < 3; burst += 1) await outrun(burst)
    expect(count(plain(second.output.t1), 'output skipped')).toBe(3)
    await desk.leave(second, 't1')
    await desk.open(second, 't1')
    // Anchored past 0: the copy ends further into the stream than it is long.
    expect(second.outputEnd.t1).toBeGreaterThan(second.output.t1.length)
    const shown = plain(second.output.t1)
    expect(shown).toContain('burst 2 line 699')
    expect(shown).not.toContain('skipped')
    expect(shown).toBe(await fresh())
  }, 60_000)

  it('keeps nothing of its old copy when its unsubscribe never arrived', async () => {
    // Left while the link was down, so the bridge still counts it as watching
    // and draws the screen over its copy rather than clearing it -- from 0,
    // which reaches the copy's head all the same.
    await idleAgent(['dev1', 'dev3'])
    const phone = desk.phone(devices.dev1)
    await desk.attach(phone)
    await desk.open(phone, 't1')
    await outrun(0)
    expect(plain(phone.output.t1)).toContain('output skipped')
    await desk.open(phone, 't1')
    const shown = plain(phone.output.t1)
    expect(count(shown, 'Claude Code')).toBe(1)
    expect(shown).not.toContain('skipped')
    expect(shown).toBe(await fresh())
    expect(phone.output.t1.length).toBe(phone.outputEnd.t1)
  }, 60_000)
})
