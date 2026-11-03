// @vitest-environment node
//
// Flush before a pty resize (1.54.5, plan P11): the phone reads every byte at the size it was drawn for.
//
// The measurement behind it is the E1 sweep of the diagnosis harness (perf155/harness-phone/run.mjs): an
// Ink-style TUI repaints its live region every 50-100 ms while the desktop pane goes from 120 to 80
// columns, and the resize lands at ten different phases against the 50 ms pump tick. Main records the new
// size at once (`resizeTerminal`) and the phone pump reads the size when a slice is SENT, so a repaint
// that was still waiting in the 8 ms coalescer or in the pump was emulated at the NEW width: the live
// region (the bottom quarter) came out garbled on the phone, 5 phases in 10 for a 100 ms TUI and every
// phase for a 50 ms one. With the flush before the resize it is 0 in 10 for both.
//
// Everything between the pty and the phone's rows is the shipped code, with only the process boundary and
// the network faked and the clock virtual: terminalManager (the real spawnTerminal / resizeTerminal and
// the real 8 ms coalescer), remoteHost's start (which installs the hook), the host and its pump, the
// bridge core with its emulator and fan-out, and the phone's own session, parser and ANSI renderer out of
// mobile/src. Nothing waits in real time; only counters are asserted.
//
// The same sweep runs with the kill switch on as the NEGATIVE CONTROL: that is today's behaviour, and it
// must keep failing the way the diagnosis said it does, or the sweep measures nothing.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Terminal } from '@xterm/headless'
import { Unicode11Addon } from '@xterm/addon-unicode11'

const hoisted = vi.hoisted(() => {
  const base = process.env.RUNNER_TEMP || process.env.TEMP || process.env.TMPDIR || '/tmp'
  const feeds: Array<(data: string) => void> = []
  const resizes: Array<{ cols: number; rows: number }> = []
  const pty = {
    onData: (cb: (data: string) => void) => {
      feeds.push(cb)
    },
    onExit: () => undefined,
    write: () => undefined,
    resize: (cols: number, rows: number) => {
      resizes.push({ cols, rows })
    },
    kill: () => undefined,
    pid: 4242,
  }
  return {
    feeds,
    resizes,
    pty,
    // A real folder: spawnTerminal's helper files are really written (and removed again in afterAll).
    USER_DATA: `${base}${base.includes('\\') ? '\\' : '/'}termpolis-test-resizeflush-${process.pid}`,
  }
})

vi.mock('node-pty', () => ({ spawn: vi.fn(() => hoisted.pty) }))
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: (name: string) => (name === 'userData' ? hoisted.USER_DATA : '') },
  utilityProcess: {},
}))
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return { ...actual, execSync: vi.fn() }
})
// What the OS says runs in a terminal is shellAlone.test.ts's; nothing here asks it.
vi.mock('../../src/main/shellAlone', () => ({ shellAlone: vi.fn(async () => true) }))

import { setSafeStorage } from '../../src/main/secureKeyStore'
import { _resetSupervisorForTests, type BridgeHandle } from '../../src/main/remoteBridgeSupervisor'
import { createBridgeCore, type BridgeCore, type RelayLike } from '../../src/main/remoteBridge/entry'
import { generateIdentity } from '../../src/main/remoteBridge/sealedChannel'
import { deriveSessionRoomId } from '../../src/main/remoteBridge/sessionCrypto'
import {
  NO_CAPABILITIES,
  type BridgeToHost,
  type HostToBridge,
  type PairedDevice,
  type RemoteEnvelope,
} from '../../src/main/remoteBridge/protocol'
import type { RelayState, SessionRelayDeps } from '../../src/main/remoteBridge/relayClient'
import { saveRemoteDevices } from '../../src/main/remoteDeviceStore'
import { saveRemoteSettings } from '../../src/main/remoteSettings'
import { identityOf } from './fixtures/remoteIdentity'
import {
  _resetRemoteHostForTests,
  noteTerminalOutput,
  startRemoteBridgeHost,
  stopRemoteBridgeHost,
} from '../../src/main/remoteHost'
import {
  appendOutput,
  readOutput,
  readOutputFrom,
  type OutputBuffers,
} from '../../src/main/terminalOutputBuffer'
import { getTerminalSize, killAll, resizeTerminal, spawnTerminal } from '../../src/main/terminalManager'
import { RemoteSession } from '../../mobile/src/net/remoteSession'
import { utf8Decode, utf8Encode } from '../../mobile/src/wire/bytes'
import type { OutputChunk } from '../../mobile/src/wire/protocol'

const KILL_SWITCH = 'TERMPOLIS_DISABLE_RESIZE_FLUSH'

afterAll(() => {
  fs.rmSync(hoisted.USER_DATA, { recursive: true, force: true })
})

// xterm's async write queue runs on setTimeout, which the virtual clock owns here: a write would wait for
// a tick that only this test can give it, and a sweep of eighty simulations would crawl. Parsing is
// unchanged; only WHEN the parser runs is. write() becomes synchronous and still reports completion on a
// microtask, which is all the bridge's emulator and this test wait for. The ORDER of bytes is untouched.
Terminal.prototype.write = function (this: unknown, data: string | Uint8Array, callback?: () => void): void {
  const warn = console.warn
  console.warn = () => undefined
  try {
    ;(this as { _core: { writeSync(d: string | Uint8Array): void } })._core.writeSync(data)
  } finally {
    console.warn = warn
  }
  if (callback) queueMicrotask(callback)
}

const XOR = 0x5a
function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from([...Buffer.from(s, 'utf8')].map((b) => b ^ XOR)),
    decryptString: (b: Buffer) => Buffer.from([...b].map((x) => x ^ XOR)).toString('utf8'),
  }
}

// ---------------------------------------------------------------------------------------------
// The phone's store applying output: mobile/src/state/remoteStore.ts, `live.onOutput`, line for line.
// Copied because that module imports react-native; the guard test at the bottom reads the store's
// source, so this copy cannot drift from it in silence.
// ---------------------------------------------------------------------------------------------
const MAX_OUTPUT_CHARS = 200_000
interface Phone {
  device: PairedDevice
  session: RemoteSession
  room: Room | null
  output: Record<string, string>
  outputEnd: Record<string, number>
}
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
    output[c.terminalId] = joined.length > MAX_OUTPUT_CHARS ? joined.slice(joined.length - MAX_OUTPUT_CHARS) : joined
    outputEnd[c.terminalId] =
      c.replaceFrom === null ? heldEnd + c.missed + c.chunk.length : c.replaceFrom + c.chunk.length
  }
}

/** A relay room as the bridge sees it, wired straight to the phone in it. */
interface Room extends RelayLike {
  deps: SessionRelayDeps
  state: RelayState
  phone: Phone | null
}

// ---------------------------------------------------------------------------------------------
// Rows, as the harness measured them. `bad` aligns the desktop's rows with the phone's last rows from the
// bottom (one inserted row shifts every row above it); `bottomQuarterBad` is the same count over the last
// quarter of the screen, where a TUI keeps its live region.
// ---------------------------------------------------------------------------------------------
function phoneRows(text: string): string[] {
  // The phone's text, minus colour. (The phone's own renderer, mobile/src/ansi/render.ts, turns this same
  // text into styled segments. It has no tsconfig of its own for vite to transform it with, and the size
  // the emulator read the bytes at reaches it only through this text.)
  const plain = text.replace(/\x1b\[[0-9;]*m/g, '').replace(/\r/g, '')
  const rows = plain.split('\n').map((r) => r.replace(/\s+$/, ''))
  while (rows.length && rows[rows.length - 1] === '') rows.pop()
  return rows
}
function viewportRows(term: Terminal): string[] {
  const buf = term.buffer.active
  const rows: string[] = []
  for (let y = buf.baseY; y < buf.length; y += 1) {
    rows.push((buf.getLine(y)?.translateToString(true) ?? '').replace(/\s+$/, ''))
  }
  while (rows.length && rows[rows.length - 1] === '') rows.pop()
  return rows
}
function mirrorError(truth: string[], phone: string[]): { rows: number; bad: number; bottomQuarterBad: number } {
  const k = truth.length
  const tail = phone.slice(-k)
  const aligned = [...Array<string>(Math.max(0, k - tail.length)).fill(''), ...tail]
  let bad = 0
  for (let i = 0; i < k; i += 1) if (aligned[i] !== truth[i]) bad += 1
  const q = Math.ceil(k / 4)
  let bottomQuarterBad = 0
  for (let i = k - q; i < k; i += 1) if (aligned[i] !== truth[i]) bottomQuarterBad += 1
  return { rows: k, bad, bottomQuarterBad }
}

// ---------------------------------------------------------------------------------------------
// Synthetic Ink / log-update TUI (the harness's): erase what it BELIEVES it drew (lines + 1), then draw
// again. Frames use CRLF the way ConPTY emits them.
// ---------------------------------------------------------------------------------------------
const ESC = '\x1b'
const eraseLines = (n: number): string => {
  let s = ''
  for (let i = 0; i < n; i += 1) s += `${ESC}[2K${i < n - 1 ? `${ESC}[1A` : ''}`
  return n > 0 ? `${s}${ESC}[G` : s
}
const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
const histLine = (i: number): string => `h${String(i).padStart(3, '0')} ${'x'.repeat(50 + ((i * 7) % 60))}`
const history = (n: number): string => Array.from({ length: n }, (_, i) => histLine(i)).join('\r\n') + '\r\n'
function liveLines(cols: number, tick: number): string[] {
  const bar = '─'.repeat(cols)
  return [
    `${SPIN[tick % 10]} Thinking… (${tick}s · esc to interrupt)`,
    bar,
    '> draft message',
    bar,
    `  ? for shortcuts${' '.repeat(Math.max(1, cols - 25))}ctx ${String(tick % 100).padStart(2, '0')}%`,
  ]
}
function makeInk(): (cols: number, tick: number) => string {
  let prev = 0
  return (cols, tick) => {
    const lines = liveLines(cols, tick)
    const out = eraseLines(prev) + lines.join('\r\n') + '\r\n'
    prev = lines.length + 1
    return out
  }
}

type Ev =
  | { t: number; kind: 'data'; bytes: string }
  | { t: number; kind: 'ptyResize'; cols: number; rows: number }
  | { t: number; kind: 'xtermResize'; cols: number; rows: number }
  | { t: number; kind: 'subscribe' }

/** The harness's inlineResizeScenario. The renderer's pane resizes at `resizeAt` (xterm's fit() runs
 *  BEFORE the IPC), main hears of it 2 ms later, and the TUI repaints for the new size once it has
 *  processed the resize `lat` ms after that. Until then it keeps drawing at the old width. */
function scenario(o: {
  w1: number
  w2: number
  rows: number
  resizeAt: number | null
  lat: number
  endAt: number
  tickMs: number
}): Ev[] {
  const ink = makeInk()
  const ev: Ev[] = [
    // The pane's first fit: the terminal starts at the spawn size, the renderer then sizes it.
    { t: 0, kind: 'ptyResize', cols: o.w1, rows: o.rows },
    { t: 0, kind: 'data', bytes: history(40) },
    { t: 1, kind: 'subscribe' },
  ]
  let tick = 0
  for (let t = o.tickMs; t <= o.endAt; t += o.tickMs) {
    const cols = o.resizeAt === null || t < o.resizeAt + 2 + o.lat ? o.w1 : o.w2
    ev.push({ t, kind: 'data', bytes: ink(cols, tick++) })
  }
  if (o.resizeAt !== null) {
    ev.push({ t: o.resizeAt, kind: 'xtermResize', cols: o.w2, rows: o.rows })
    ev.push({ t: o.resizeAt + 2, kind: 'ptyResize', cols: o.w2, rows: o.rows })
    // the TUI repaints for the new size once it has processed the resize
    ev.push({ t: o.resizeAt + 2 + o.lat, kind: 'data', bytes: ink(o.w2, tick++) })
  }
  return ev
}

// ---------------------------------------------------------------------------------------------
// The desktop: main, the bridge child it supervises, and the phone behind the relay.
// ---------------------------------------------------------------------------------------------
const T = 't1'
let dir: string
let device: PairedDevice

interface Outcome {
  rows: number
  bad: number
  bottomQuarterBad: number
  /** Slices main posted to the bridge for bytes that were all drawn BEFORE the resize, but read at a size
   *  other than the one the terminal had when they were drawn. */
  staleSizeSlices: number
  /** Slices posted at all, and the sizes the pump read for them, for the sanity checks. */
  slices: number
  /** How many times the real pty was resized. */
  ptyResizes: number
}

async function simulate(events: Ev[], opts: { w1: number; rows: number }): Promise<Outcome> {
  hoisted.feeds.length = 0
  hoisted.resizes.length = 0
  saveRemoteSettings(dir, { enabled: true })
  saveRemoteDevices(dir, [device])

  const buffers: OutputBuffers = new Map()
  const toBridge: HostToBridge[] = []
  const toHost: BridgeToHost[] = []
  const rooms: Room[] = []
  const cores: BridgeCore[] = []
  const posted: Array<Extract<HostToBridge, { kind: 'terminalOutput' }>> = []
  let bridge: BridgeCore | null = null
  let fromBridge: (m: BridgeToHost) => void = () => undefined
  let inflight = 0

  function deliver(room: Room, payload: unknown): void {
    if (room.state !== 'attached' || room.phone === null) return
    room.phone.session.handleFrame(utf8Encode(JSON.stringify(payload)))
  }

  startRemoteBridgeHost({
    userDataDir: dir,
    mcpPort: 3369,
    mcpToken: 'mcp-token',
    sendStatus: () => undefined,
    sendEvent: () => undefined,
    // The bindings index.ts hands the host: the rolling buffer and the terminal manager's own size.
    readOutput: (id, from) => readOutputFrom(buffers, id, from),
    readRecent: (id) => (buffers.has(id) ? { output: readOutput(buffers, id), name: id } : null),
    terminalSize: getTerminalSize,
    createTransport: () => {
      const core: BridgeCore = createBridgeCore({
        send: (m) => {
          if (bridge === core) toHost.push(m)
        },
        mcp: { callTool: async () => ({ terminals: [] }) },
        relayUrl: 'wss://relay.invalid',
        desktopName: 'Bench desktop',
        openRelay: (deps) => {
          const room: Room = {
            deps: deps as SessionRelayDeps,
            state: 'connecting',
            phone: null,
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
      return {
        postMessage: (m: HostToBridge) => {
          if (m.kind === 'terminalOutput') posted.push(m)
          if (bridge === core) toBridge.push(m)
        },
        on: (event: string, cb: (arg: never) => void) => {
          if (event === 'message') fromBridge = cb as unknown as (m: BridgeToHost) => void
        },
        kill: () => {
          bridge = null
        },
      } as unknown as BridgeHandle
    },
  })

  /** Run every message, request and emulator write to completion: the real boundary is asynchronous, so
   *  messages cross through queues this drains, never inline. */
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

  const phone: Phone = {
    device,
    room: null,
    output: {},
    outputEnd: {},
    session: new RemoteSession({
      send: (plaintext) => {
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
      },
      setTimer: () => 0,
      clearTimer: () => undefined,
    }),
  }
  phone.session.onOutput((chunks) => applyOutput(phone, chunks))

  await settle()
  const room = rooms.find((r) => r.deps.roomId === device.sessionRoomId && r.state !== 'offline')
  if (!room) throw new Error('the bridge opened no room for the phone')
  room.phone = phone
  phone.room = room
  room.state = 'attached'
  room.deps.onStateChange('attached')
  await settle()

  // The desktop's xterm, configured like the renderer's (ConPTY + Unicode 11), fed each chunk the instant
  // the pty produced it and resized the instant the pane was: the screen the phone should be a copy of.
  const truth = new Terminal({
    cols: opts.w1,
    rows: opts.rows,
    scrollback: 10_000,
    allowProposedApi: true,
    windowsPty: { backend: 'conpty', buildNumber: 26200 },
  })
  truth.loadAddon(new Unicode11Addon())
  truth.unicode.activeVersion = '11'

  // What index.ts's emitter does with the coalescer's output: buffer it, mark the terminal for the host.
  spawnTerminal(T, '/bin/bash', '/tmp', (data) => {
    appendOutput(buffers, T, data)
    noteTerminalOutput(T)
  })
  const feed = hoisted.feeds[hoisted.feeds.length - 1]

  const sorted = events.map((e, i) => ({ e, i })).sort((a, b) => a.e.t - b.e.t || a.i - b.i)
  let now = 0
  /** Chars the pty has produced so far: the stream offset the bytes drawn so far end at, whether or not
   *  the coalescer has handed them to the buffer yet. */
  let produced = 0
  let oldSize: { cols: number; rows: number } | null = null
  let lastResize: { at: number; offset: number } | null = null

  async function advanceTo(t: number): Promise<void> {
    if (t > now) {
      await vi.advanceTimersByTimeAsync(t - now)
      now = t
    }
    await settle()
  }

  try {
    for (const { e } of sorted) {
      await advanceTo(e.t)
      if (e.kind === 'data') {
        produced += e.bytes.length
        feed(e.bytes)
        await new Promise<void>((resolve) => truth.write(e.bytes, resolve))
      } else if (e.kind === 'xtermResize') {
        truth.resize(e.cols, e.rows)
      } else if (e.kind === 'ptyResize') {
        oldSize = getTerminalSize(T)
        lastResize = { at: e.t, offset: produced }
        resizeTerminal(T, e.cols, e.rows)
      } else {
        // The phone opens the terminal (TerminalScreen mounting).
        const answer = phone.session.request({ kind: 'subscribe', terminalId: T })
        answer.catch(() => undefined)
        await settle()
        await answer
      }
      await settle()
    }
    // Let the last pump tick, the coalescer window and the bridge's emulator run out.
    await advanceTo(now + 500)
    await advanceTo(now + 500)

    // Every slice that CONTAINS a byte drawn before the last resize must have been read at the size the
    // terminal had then. (The pane's first fit is a resize too, but nothing had been drawn before it, and
    // the baseline has no other.)
    let staleSizeSlices = 0
    if (lastResize !== null && oldSize !== null && lastResize.at > 0) {
      for (const m of posted) {
        const start = m.slice.nextOffset - m.slice.output.length
        if (m.slice.output === '' || start >= lastResize.offset) continue
        if (m.size === undefined || m.size.cols !== oldSize.cols || m.size.rows !== oldSize.rows) staleSizeSlices += 1
      }
    }

    const err = mirrorError(viewportRows(truth), phoneRows(phone.output[T] ?? ''))
    return {
      rows: err.rows,
      bad: err.bad,
      bottomQuarterBad: err.bottomQuarterBad,
      staleSizeSlices,
      slices: posted.length,
      ptyResizes: hoisted.resizes.length,
    }
  } finally {
    truth.dispose()
    // Muted first, so tearing the cores down cannot reach a host that is gone.
    bridge = null
    stopRemoteBridgeHost()
    _resetSupervisorForTests()
    _resetRemoteHostForTests()
    killAll()
    for (const core of cores) core.handleHostMessage({ kind: 'shutdown' })
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-resize-flush-'))
  setSafeStorage(fakeSafeStorage())
  _resetSupervisorForTests()
  _resetRemoteHostForTests()
  const identity = identityOf(dir)
  const keys = generateIdentity()
  device = {
    id: 'dev1',
    label: 'dev1',
    publicKey: keys.publicKey,
    sessionRoomId: deriveSessionRoomId(identity.secretKey, keys.publicKey),
    capabilities: { ...NO_CAPABILITIES, read: true },
    pairedAt: Date.now(),
    lastSeenAt: Date.now(),
  }
})

afterEach(() => {
  stopRemoteBridgeHost()
  _resetSupervisorForTests()
  _resetRemoteHostForTests()
  killAll()
  setSafeStorage(null)
  vi.useRealTimers()
  delete process.env[KILL_SWITCH]
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

interface Sweep {
  /** Resize phases whose final phone screen differs from the desktop's. */
  rowPhases: number
  /** Resize phases in which some slice of pre-resize bytes was read at the wrong size. */
  sizePhases: number
  worstBad: number
  worstBottomQuarterBad: number
  phases: number
  ptyResizes: number
  /** Slices main posted to the bridge, over the whole sweep. */
  slices: number
}

/** The harness's phase sweep: the resize lands at ten offsets, 10 ms apart, against the TUI's repaint tick
 *  and the pump's 50 ms tick. (The harness ran the resize at 3 s; the offsets modulo both ticks, which is
 *  all that matters, are the same from 500 ms, and the sweep is six times shorter.) */
async function sweep(c: { w1: number; w2: number; lat: number; tickMs: number }): Promise<Sweep> {
  const rows = 30
  const out: Sweep = {
    rowPhases: 0,
    sizePhases: 0,
    worstBad: 0,
    worstBottomQuarterBad: 0,
    phases: 0,
    ptyResizes: 0,
    slices: 0,
  }
  for (let phase = 0; phase < 100; phase += 10) {
    const r = await simulate(scenario({ ...c, rows, resizeAt: 500 + phase, endAt: 1500 }), { w1: c.w1, rows })
    out.phases += 1
    if (r.bad > 0) out.rowPhases += 1
    if (r.staleSizeSlices > 0) out.sizePhases += 1
    out.worstBad = Math.max(out.worstBad, r.bad)
    out.worstBottomQuarterBad = Math.max(out.worstBottomQuarterBad, r.bottomQuarterBad)
    out.ptyResizes += r.ptyResizes
    out.slices += r.slices
  }
  return out
}

const CASES = [
  { name: 'a TUI that repaints every 100 ms and reacts to the resize in 15 ms', w1: 120, w2: 80, lat: 15, tickMs: 100, controlPhases: 5 },
  { name: 'a TUI that repaints every 50 ms and reacts to the resize in 15 ms', w1: 120, w2: 80, lat: 15, tickMs: 50, controlPhases: 10 },
  { name: 'a TUI that repaints every 100 ms and reacts to the resize in 300 ms', w1: 120, w2: 80, lat: 300, tickMs: 100, controlPhases: 5 },
  { name: 'a TUI that repaints every 50 ms and reacts to the resize in 300 ms', w1: 120, w2: 80, lat: 300, tickMs: 50, controlPhases: 10 },
]

describe('the measuring instrument', () => {
  it('mirrors a terminal that is never resized row for row', async () => {
    const r = await simulate(scenario({ w1: 120, w2: 80, rows: 30, resizeAt: null, lat: 15, endAt: 1500, tickMs: 50 }), {
      w1: 120,
      rows: 30,
    })
    expect(r.rows).toBeGreaterThan(20)
    expect(r.bad).toBe(0)
    expect(r.bottomQuarterBad).toBe(0)
    expect(r.slices).toBeGreaterThan(5)
  })

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
})

describe('a pane resized 120 -> 80 columns under a live TUI, ten phases against the pump tick', () => {
  for (const c of CASES) {
    it(`${c.name}: 0 of 10 phases read bytes at the wrong size or leave the phone's rows wrong`, async () => {
      const s = await sweep(c)
      expect(s.phases).toBe(10)
      expect(s.ptyResizes).toBe(20) // the first fit and the resize, in each of the ten phases
      expect(s.sizePhases).toBe(0)
      expect(s.rowPhases).toBe(0)
      expect(s.worstBad).toBe(0)
      expect(s.worstBottomQuarterBad).toBe(0)
    })

    it(`${c.name}: NEGATIVE CONTROL with the flush switched off, ${c.controlPhases} of 10 phases are wrong`, async () => {
      process.env[KILL_SWITCH] = '1'
      const s = await sweep(c)
      expect(s.phases).toBe(10)
      expect(s.ptyResizes).toBe(20) // the switch changes the order, not whether the pty is resized
      // The property: pre-resize bytes read at the post-resize size.
      expect(s.sizePhases).toBe(c.controlPhases)
      // And what it does to the phone: 5 of 10 or worse.
      expect(s.rowPhases).toBeGreaterThanOrEqual(5)
      expect(s.worstBad).toBeGreaterThan(0)
    })
  }

  it('costs the main thread at most one more slice per resize: it moves a read earlier, it does not add reads', async () => {
    // The counter that answers "what does it cost": slices posted across the process boundary over the
    // same ten resizes, with the flush and without it. The flush sends what the next tick would have
    // sent, so where that tick would have carried the old bytes AND the TUI's reply to the resize in
    // one slice, the stream is split in two at the resize: never fewer slices, at most one more per
    // resize. (Where the tick falls before the reply anyway, the flush only makes the same read earlier
    // and adds none, which is why the exact difference is not pinned: it follows the tick phase.)
    const c = CASES[0]
    const withFlush = await sweep(c)
    process.env[KILL_SWITCH] = '1'
    const without = await sweep(c)
    expect(without.slices).toBeGreaterThan(0)
    expect(withFlush.slices).toBeGreaterThanOrEqual(without.slices)
    expect(withFlush.slices - without.slices).toBeLessThanOrEqual(withFlush.phases)
    // And it is not nothing: where bytes were waiting at the resize, the stream really is split, so
    // this counter would read 0 if the flush did nothing.
    expect(withFlush.slices - without.slices).toBeGreaterThan(0)
  })

  it('a widening resize (120 -> 150) is clean with and without the flush, and the flush does not disturb it', async () => {
    const c = { w1: 120, w2: 150, lat: 15, tickMs: 100 }
    const fixed = await sweep(c)
    expect(fixed.sizePhases).toBe(0)
    expect(fixed.rowPhases).toBe(0)
    process.env[KILL_SWITCH] = '1'
    const control = await sweep(c)
    expect(control.rowPhases).toBe(0)
    expect(control.worstBad).toBe(0)
  })
})
