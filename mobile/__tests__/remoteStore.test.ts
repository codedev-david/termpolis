import type { RelaySocketDeps, RelayState } from '../src/net/relaySocket'
import type { OutputChunk } from '../src/wire/protocol'
import type { PairedDesktop, StoredPairing } from '../src/storage/identity'

/** What the desktop answers `getCapabilities` with in these tests. */
const GRANTS = { read: true, createTerminal: true, writeToTerminal: false, closeTerminal: false }

/** One private key per desktop, and the public half the real curve maths
 *  derives from each. Fixed rather than random, because the safety phrase these
 *  tests assert has to be a phrase that can be written down -- and because a key
 *  handed to the wrong desktop is exactly the mistake that phrase catches. */
const PHONE_SK = '22'.repeat(32)
const PHONE_SK_B = '33'.repeat(32)
const PHONE_SK_C = '44'.repeat(32)
const PHONE_PK = publicKeyFor(PHONE_SK)
const PHONE_PK_B = publicKeyFor(PHONE_SK_B)

const DESKTOP_PK = '7b4e909bbe7ffe44c465a220037d608ee35897d31ef972f07f74892cb0f73f13'
const DESKTOP_PK_B = 'b1'.repeat(32)
const DESKTOP_PK_C = 'c2'.repeat(32)

const PAIRED: PairedDesktop = {
  desktopPublicKey: DESKTOP_PK,
  sessionRoomId: 'c9dc49b87f0dc983be61f034ceab7c52',
  relayUrl: 'wss://relay.test',
  deviceId: '12faa049f0ec7720',
  label: 'Termpolis desktop',
  pairedAt: 1_700_000_000_000,
}
const PAIRED_B: PairedDesktop = {
  desktopPublicKey: DESKTOP_PK_B,
  sessionRoomId: 'a1'.repeat(16),
  relayUrl: 'wss://relay-b.test',
  deviceId: 'b0'.repeat(8),
  label: 'Workshop Linux box',
  pairedAt: 1_700_000_100_000,
}
const PAIRED_C: PairedDesktop = {
  desktopPublicKey: DESKTOP_PK_C,
  sessionRoomId: 'a2'.repeat(16),
  relayUrl: 'wss://relay-c.test',
  deviceId: 'c0'.repeat(8),
  label: 'Basement server',
  pairedAt: 1_700_000_200_000,
}

/** The same desktops as the keystore holds them: with the key that is this
 *  phone's authority over that ONE machine. */
const STORED: StoredPairing = { ...PAIRED, secretKey: PHONE_SK }
const STORED_B: StoredPairing = { ...PAIRED_B, secretKey: PHONE_SK_B }
const STORED_C: StoredPairing = { ...PAIRED_C, secretKey: PHONE_SK_C }

/** A scanned code offering to pair with one particular desktop. */
function rawFor(desktopPublicKey: string): string {
  return JSON.stringify({
    v: 1,
    relayUrl: 'wss://relay.test',
    pairingId: '0123456789abcdef0123456789abcdef',
    desktopPublicKey,
    oneTimeSecret: 'aa'.repeat(32),
  })
}

/** Enough desktops to reach the ceiling, none of them one the fixtures name. */
function manyDesktops(n: number): StoredPairing[] {
  return Array.from({ length: n }, (_, i) => ({
    ...STORED,
    desktopPublicKey: i.toString(16).padStart(2, '0').repeat(32),
    label: `Desktop ${i}`,
  }))
}

/** Every fake the store is built on, reachable from the tests. */
const mockSockets: {
  deps: RelaySocketDeps
  connected: boolean
  closed: boolean
  sent: unknown[]
}[] = []
const mockSessions: {
  deps: unknown
  requests: unknown[]
  timeouts: (number | undefined)[]
  resolveNext: (value: unknown) => void
  output: ((chunks: OutputChunk[]) => void)[]
  status: ((u: unknown) => void)[]
  caps: ((c: unknown) => void)[]
  resets: string[]
  rejectNext: (err: unknown) => void
  frames: unknown[]
}[] = []
const mockAppState: { handlers: ((s: string) => void)[] } = { handlers: [] }
const mockStorage: {
  /** The keystore: one record per desktop, key and all. */
  book: StoredPairing[]
  active: string | null
  /** Every call that reached storage, in order. Which desktop a call landed on
   *  is most of what these tests are about -- and so is which calls did NOT
   *  happen: rewriting key material to remember a tap would be a great deal of
   *  keychain churn for a UI detail. */
  writes: string[]
  loads: number
  wipes: number
  /** Secret keys `newIdentity` hands out, in order, taken from the front. Fixed
   *  rather than random so a test can say which key a pairing ended up holding
   *  and check the safety phrase against it. */
  secrets: string[]
  minted: string[]
} = {
  book: [],
  active: null,
  writes: [],
  loads: 0,
  wipes: 0,
  secrets: [],
  minted: [],
}
const mockPairing: { result: unknown; error: Error | null; calls: unknown[] } = {
  result: null,
  error: null,
  calls: [],
}

jest.mock('../src/net/relaySocket', () => ({
  RelaySocket: class {
    // No imported type annotations anywhere in a jest.mock factory: babel's
    // hoist check reads them as out-of-scope variable access and refuses.
    deps: unknown
    connected = false
    closed = false
    sent: unknown[] = []
    constructor(deps: unknown) {
      this.deps = deps
      mockSockets.push(this as never)
    }
    connect(): void {
      this.connected = true
    }
    send(plaintext: unknown): void {
      // The store never seals -- RemoteSession owns what goes out -- but WHICH
      // socket a session writes to is the store's wiring, so it is recorded.
      this.sent.push(plaintext)
    }
    close(): void {
      this.closed = true
    }
  },
}))

jest.mock('../src/net/remoteSession', () => ({
  DEFAULT_TIMEOUT_MS: 20_000,
  RemoteSession: class {
    deps: unknown
    requests: unknown[] = []
    timeouts: (number | undefined)[] = []
    output: ((chunks: unknown) => void)[] = []
    status: ((u: unknown) => void)[] = []
    caps: ((c: unknown) => void)[] = []
    resets: string[] = []
    frames: unknown[] = []
    private pending: { resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = []

    constructor(deps: unknown) {
      this.deps = deps
      mockSessions.push(this as never)
    }

    request(req: unknown, timeoutMs?: number): Promise<unknown> {
      this.requests.push(req)
      // Recorded beside `requests` rather than folded into it, so the many
      // tests that assert an exact request list keep reading as a list of
      // requests. Only the unpair goodbye passes one -- and that it passes a
      // SHORT one is the whole reason the request does not hang the button.
      this.timeouts.push(timeoutMs)
      return new Promise((resolve, reject) => this.pending.push({ resolve, reject }))
    }

    resolveNext(value: unknown): void {
      this.pending.shift()?.resolve(value)
    }

    rejectNext(err: unknown): void {
      this.pending.shift()?.reject(err)
    }

    onOutput(cb: (chunks: unknown) => void): () => void {
      this.output.push(cb)
      return () => undefined
    }

    onStatus(cb: (u: unknown) => void): () => void {
      this.status.push(cb)
      return () => undefined
    }

    onCapabilities(cb: (c: unknown) => void): () => void {
      this.caps.push(cb)
      return () => undefined
    }

    handleFrame(plaintext: unknown): void {
      // Driven through onOutput/onStatus in most tests; recorded so the socket's
      // onFrame wiring can be checked for itself.
      this.frames.push(plaintext)
    }

    reset(reason: string): void {
      this.resets.push(reason)
    }
  },
}))

jest.mock('../src/net/pairingClient', () => ({
  DEFAULT_DESKTOP_LABEL: 'Termpolis desktop',
  pairWithDesktop: (opts: unknown) => {
    mockPairing.calls.push(opts)
    return mockPairing.error ? Promise.reject(mockPairing.error) : Promise.resolve(mockPairing.result)
  },
}))

jest.mock('../src/storage/identity', () => {
  // The REAL curve maths. A mocked `publicKeyOf` would make the safety phrase
  // whatever this file wanted it to be, and the phrase is the one thing on
  // screen the user is asked to compare by eye: it has to come from the key that
  // was actually stored for that desktop.
  const { publicKeyFor: derive } = jest.requireActual('../src/wire/sessionCrypto') as {
    publicKeyFor: (secretKey: string) => string
  }
  // Inlined: a jest.mock factory may not reach out-of-scope constants, and no
  // annotation inside one may name an imported type -- babel's hoist check reads
  // that as out-of-scope variable access and refuses. Hence the record shape
  // written out longhand below. `identity.test.ts` holds the real ceiling.
  const CEILING = 16

  return {
    MAX_PAIRINGS: CEILING,

    newIdentity: () => {
      const secretKey = mockStorage.secrets.shift() ?? '99'.repeat(32)
      mockStorage.minted.push(secretKey)
      return { secretKey, publicKey: derive(secretKey) }
    },

    publicPairing: (p: {
      desktopPublicKey: string
      sessionRoomId: string
      relayUrl: string
      deviceId: string
      label: string
      pairedAt: number
    }) => ({
      desktopPublicKey: p.desktopPublicKey,
      sessionRoomId: p.sessionRoomId,
      relayUrl: p.relayUrl,
      deviceId: p.deviceId,
      label: p.label,
      pairedAt: p.pairedAt,
    }),

    publicKeyOf: (p: { secretKey: string }) => derive(p.secretKey),

    loadBook: async () => {
      mockStorage.loads += 1
      const pairings = mockStorage.book.map((r) => ({ ...r }))
      // Mirrors the real `pickActive`, so the store is never handed a book that
      // names a desktop the book did not also return -- a state storage cannot
      // produce, and therefore not one worth writing a code path for.
      const named = pairings.some((r) => r.desktopPublicKey === mockStorage.active)
      return {
        pairings,
        active: named ? mockStorage.active : (pairings[0]?.desktopPublicKey ?? null),
      }
    },

    addPairing: async (p: {
      desktopPublicKey: string
      sessionRoomId: string
      relayUrl: string
      deviceId: string
      label: string
      pairedAt: number
      secretKey: string
    }) => {
      mockStorage.writes.push(`add ${p.desktopPublicKey}`)
      const at = mockStorage.book.findIndex((r) => r.desktopPublicKey === p.desktopPublicKey)
      if (at === -1) mockStorage.book.push({ ...p })
      else mockStorage.book[at] = { ...p }
      mockStorage.active = p.desktopPublicKey
    },

    writePairing: async (p: {
      desktopPublicKey: string
      sessionRoomId: string
      relayUrl: string
      deviceId: string
      label: string
      pairedAt: number
      secretKey: string
    }) => {
      mockStorage.writes.push(`write ${p.desktopPublicKey}`)
      const at = mockStorage.book.findIndex((r) => r.desktopPublicKey === p.desktopPublicKey)
      if (at !== -1) mockStorage.book[at] = { ...p }
    },

    removePairing: async (desktopPublicKey: string, nextActive: string | null) => {
      mockStorage.writes.push(`remove ${desktopPublicKey} -> ${nextActive ?? 'null'}`)
      mockStorage.book = mockStorage.book.filter((r) => r.desktopPublicKey !== desktopPublicKey)
      mockStorage.active = nextActive
    },

    setActivePairing: async (desktopPublicKey: string | null) => {
      mockStorage.writes.push(`active ${desktopPublicKey ?? 'null'}`)
      mockStorage.active = desktopPublicKey
    },

    wipeEverything: async () => {
      mockStorage.writes.push('wipe')
      mockStorage.wipes += 1
      mockStorage.book = []
      mockStorage.active = null
    },
  }
})

import { AppState } from 'react-native'
import { NO_CAPABILITIES } from '../src/wire/protocol'
import { deriveVerificationPhrase } from '../src/wire/safetyNumber'
import { publicKeyFor } from '../src/wire/sessionCrypto'
import { pairingStamp } from '../src/state/pairingStamp'
import {
  FOREGROUND_DEBOUNCE_MS,
  GOODBYE_TIMEOUT_MS,
  MAX_OUTPUT_CHARS,
  forgetEverything,
  teardownRemote,
  useRemoteStore,
} from '../src/state/remoteStore'

/** Seed the keystore. The first desktop is the one that was on screen last,
 *  unless `activeKey` names another. */
function seed(pairings: StoredPairing[], activeKey?: string): void {
  mockStorage.book = pairings.map((p) => ({ ...p }))
  mockStorage.active = activeKey ?? pairings[0]?.desktopPublicKey ?? null
}

function socket(): (typeof mockSockets)[number] {
  return mockSockets[mockSockets.length - 1] as (typeof mockSockets)[number]
}

function session(): (typeof mockSessions)[number] {
  return mockSessions[mockSessions.length - 1] as (typeof mockSessions)[number]
}

/** Drive the relay socket's state the way RelaySocket would. */
function state(next: RelayState): void {
  socket().deps.onState(next)
}

function chunk(over: Partial<OutputChunk> = {}): OutputChunk {
  return { terminalId: 't1', chunk: 'hello', missed: 0, marker: null, replaceFrom: null, ...over }
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  jest.useFakeTimers()
  // The real AppState rather than a mocked react-native: mocking the whole
  // module strands jest-expo's own setup, which calls Platform.select.
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((
    _event: string,
    handler: (s: string) => void,
  ) => {
    mockAppState.handlers.push(handler)
    return { remove: () => undefined }
  }) as never)
  mockSockets.length = 0
  mockSessions.length = 0
  mockAppState.handlers.length = 0
  mockStorage.book = []
  mockStorage.active = null
  mockStorage.writes.length = 0
  mockStorage.loads = 0
  mockStorage.wipes = 0
  mockStorage.secrets.length = 0
  mockStorage.minted.length = 0
  mockPairing.result = null
  mockPairing.error = null
  mockPairing.calls.length = 0
  teardownRemote()
})

afterEach(() => {
  jest.restoreAllMocks()
  jest.useRealTimers()
})

describe('boot', () => {
  it('lands on the pair screen when nothing is paired, opening no socket', async () => {
    await useRemoteStore.getState().boot()
    expect(useRemoteStore.getState().paired).toBeNull()
    expect(mockSockets).toHaveLength(0)
  })

  it('connects to the STORED session room, not one it recomputes', async () => {
    // The stored room is the one the desktop is sitting in. Recomputing it here
    // would look right until an identity change made the two disagree silently.
    seed([STORED])
    await useRemoteStore.getState().boot()
    expect(socket().deps.roomId).toBe(PAIRED.sessionRoomId)
    expect(socket().deps.url).toBe(PAIRED.relayUrl)
    expect(socket().connected).toBe(true)
  })

  it('shows the safety phrase for the stored pairing', async () => {
    seed([STORED])
    await useRemoteStore.getState().boot()
    expect(useRemoteStore.getState().safetyPhrase).toBe(
      deriveVerificationPhrase(PHONE_PK, DESKTOP_PK),
    )
  })

  it('starts stale, because nothing on screen has been confirmed yet', async () => {
    seed([STORED])
    await useRemoteStore.getState().boot()
    expect(useRemoteStore.getState().stale).toBe(true)
  })

  it('does not open a second socket when called twice', async () => {
    seed([STORED])
    await useRemoteStore.getState().boot()
    await useRemoteStore.getState().boot()
    expect(mockSockets).toHaveLength(1)
  })

  it('shows every paired desktop, with no private key among them', async () => {
    seed([STORED, STORED_B])
    await useRemoteStore.getState().boot()
    expect(useRemoteStore.getState().pairings).toEqual([PAIRED, PAIRED_B])
    // The redaction, checked rather than assumed: a screen that could read a
    // secret key off the store is one JSON.stringify away from putting this
    // phone's authority over a desktop into a log.
    for (const p of useRemoteStore.getState().pairings) {
      expect(p).not.toHaveProperty('secretKey')
    }
  })

  it('comes back to the desktop that was on screen last, not the first paired', async () => {
    seed([STORED, STORED_B], DESKTOP_PK_B)
    await useRemoteStore.getState().boot()
    expect(useRemoteStore.getState().paired).toEqual(PAIRED_B)
    expect(socket().deps.roomId).toBe(PAIRED_B.sessionRoomId)
  })

  it('dials the desktop on screen and no other', async () => {
    // One connection at a time. Several would keep several radios awake for
    // frames nobody is looking at, and the reconnect and foreground logic is
    // written per socket.
    seed([STORED, STORED_B, STORED_C])
    await useRemoteStore.getState().boot()
    expect(mockSockets).toHaveLength(1)
  })
})

describe('pairing from a scanned code', () => {
  const RAW = rawFor(DESKTOP_PK)

  it('refuses a malformed payload without touching storage', async () => {
    await useRemoteStore.getState().pairFromQr('not a qr', 'phone')
    expect(useRemoteStore.getState().error).toMatch(/code/i)
    expect(useRemoteStore.getState().paired).toBeNull()
    expect(mockStorage.writes).toHaveLength(0)
    expect(mockPairing.calls).toHaveLength(0)
  })

  it('stores the pairing, key and all, and shows the phrase for the key it stored', async () => {
    mockStorage.secrets = [PHONE_SK]
    mockPairing.result = { desktop: PAIRED, safetyPhrase: 'not this one' }
    await useRemoteStore.getState().pairFromQr(RAW, "David's iPhone")
    expect(mockStorage.writes).toEqual([`add ${DESKTOP_PK}`])
    expect(mockStorage.book).toEqual([{ ...PAIRED, secretKey: PHONE_SK }])
    expect(useRemoteStore.getState().paired).toEqual(PAIRED)
    // Derived from the key that was actually stored, not taken from the pairing
    // client's word for it. Those two agreeing is the whole point of showing a
    // phrase: it is a statement about the key this phone will greet with.
    expect(useRemoteStore.getState().safetyPhrase).toBe(
      deriveVerificationPhrase(PHONE_PK, DESKTOP_PK),
    )
  })

  it('passes the label the user typed to the desktop', async () => {
    mockPairing.result = { desktop: PAIRED, safetyPhrase: 'x' }
    await useRemoteStore.getState().pairFromQr(RAW, "David's iPhone")
    expect((mockPairing.calls[0] as { label: string }).label).toBe("David's iPhone")
  })

  it('connects once pairing succeeds', async () => {
    mockPairing.result = { desktop: PAIRED, safetyPhrase: 'x' }
    await useRemoteStore.getState().pairFromQr(RAW, 'phone')
    expect(socket().deps.roomId).toBe(PAIRED.sessionRoomId)
  })

  it('reports a failed pairing and stores nothing', async () => {
    mockPairing.error = new Error('Pairing timed out.')
    await useRemoteStore.getState().pairFromQr(RAW, 'phone')
    expect(useRemoteStore.getState().error).toMatch(/timed out/i)
    // An abandoned pairing leaves nothing in the keystore -- not even the key it
    // minted to try with.
    expect(mockStorage.writes).toHaveLength(0)
    expect(useRemoteStore.getState().paired).toBeNull()
  })

  it('keeps the desktops already paired and puts the new one on screen', async () => {
    seed([STORED])
    await useRemoteStore.getState().boot()
    mockStorage.secrets = [PHONE_SK_B]
    mockPairing.result = { desktop: PAIRED_B, safetyPhrase: 'x' }
    await useRemoteStore.getState().pairFromQr(rawFor(DESKTOP_PK_B), 'phone')
    expect(useRemoteStore.getState().pairings).toEqual([PAIRED, PAIRED_B])
    expect(useRemoteStore.getState().paired).toEqual(PAIRED_B)
  })

  it('mints a key per desktop, so no two are handed the same one', async () => {
    // Two desktops holding the same public key can compare notes and know they
    // are talking to one handset -- and since a device id is a hash of that key,
    // this phone would be the same row on both.
    mockStorage.secrets = [PHONE_SK, PHONE_SK_B]
    mockPairing.result = { desktop: PAIRED, safetyPhrase: 'x' }
    await useRemoteStore.getState().pairFromQr(RAW, 'phone')
    mockPairing.result = { desktop: PAIRED_B, safetyPhrase: 'x' }
    await useRemoteStore.getState().pairFromQr(rawFor(DESKTOP_PK_B), 'phone')
    expect(mockStorage.minted).toEqual([PHONE_SK, PHONE_SK_B])
    expect(new Set(mockStorage.book.map((r) => r.secretKey)).size).toBe(2)
  })

  it('closes the desktop it was showing and clears what belonged to it', async () => {
    seed([STORED])
    await useRemoteStore.getState().boot()
    state('attached')
    await settle()
    session().resolveNext(GRANTS)
    session().resolveNext([{ id: 't1', name: 'Claude', shellType: 'pwsh', cwd: '/repo' }])
    await settle()
    const first = socket()

    mockStorage.secrets = [PHONE_SK_B]
    mockPairing.result = { desktop: PAIRED_B, safetyPhrase: 'x' }
    await useRemoteStore.getState().pairFromQr(rawFor(DESKTOP_PK_B), 'phone')

    expect(first.closed).toBe(true)
    expect(socket().deps.roomId).toBe(PAIRED_B.sessionRoomId)
    // Terminals and grants are statements about a particular machine. Carried
    // across, a grant would enable a control the new desktop has not allowed.
    expect(useRemoteStore.getState().terminals).toEqual([])
    expect(useRemoteStore.getState().capabilities).toEqual(NO_CAPABILITIES)
  })

  it('numbers a second desktop that reports the same name', async () => {
    // Two machines calling themselves the same thing is ordinary -- a laptop and
    // its VM, two fresh Ubuntu installs -- and two identical rows is a switcher
    // that cannot be used. Numbered rather than refused, because the user can
    // rename either one afterwards.
    mockStorage.secrets = [PHONE_SK, PHONE_SK_B, PHONE_SK_C]
    mockPairing.result = { desktop: PAIRED, safetyPhrase: 'x' }
    await useRemoteStore.getState().pairFromQr(RAW, 'phone')
    mockPairing.result = { desktop: { ...PAIRED_B, label: PAIRED.label }, safetyPhrase: 'x' }
    await useRemoteStore.getState().pairFromQr(rawFor(DESKTOP_PK_B), 'phone')
    mockPairing.result = { desktop: { ...PAIRED_C, label: PAIRED.label }, safetyPhrase: 'x' }
    await useRemoteStore.getState().pairFromQr(rawFor(DESKTOP_PK_C), 'phone')
    expect(useRemoteStore.getState().pairings.map((d) => d.label)).toEqual([
      PAIRED.label,
      `${PAIRED.label} (2)`,
      `${PAIRED.label} (3)`,
    ])
  })

  it('does not number a desktop that is simply being paired again', async () => {
    // The collision check skips the row being written, so re-pairing a known
    // desktop keeps its name instead of drifting to "(2)" every time.
    mockStorage.secrets = [PHONE_SK, PHONE_SK_C]
    mockPairing.result = { desktop: PAIRED, safetyPhrase: 'x' }
    await useRemoteStore.getState().pairFromQr(RAW, 'phone')
    await useRemoteStore.getState().pairFromQr(RAW, 'phone')
    expect(useRemoteStore.getState().pairings.map((d) => d.label)).toEqual([PAIRED.label])
  })

  it('refuses a new desktop at the ceiling without spending the code', async () => {
    // Checked before dialling. A phone at the ceiling that dialled anyway would
    // burn the desktop's single-use code to find out, and the user would have to
    // walk back to the machine for a fresh one.
    seed(manyDesktops(16))
    await useRemoteStore.getState().boot()
    await useRemoteStore.getState().pairFromQr(RAW, 'phone')
    expect(useRemoteStore.getState().error).toMatch(/16 desktops already/)
    expect(mockPairing.calls).toHaveLength(0)
    expect(useRemoteStore.getState().pairings).toHaveLength(16)
  })

  it('still re-pairs a desktop it already knows when the list is full', async () => {
    seed([...manyDesktops(15), STORED])
    await useRemoteStore.getState().boot()
    mockStorage.secrets = [PHONE_SK_C]
    mockPairing.result = { desktop: PAIRED, safetyPhrase: 'x' }
    await useRemoteStore.getState().pairFromQr(RAW, 'phone')
    expect(mockPairing.calls).toHaveLength(1)
    expect(useRemoteStore.getState().pairings).toHaveLength(16)
    // Replaced in place, so the switcher does not reorder under the user's
    // finger while they are looking at it.
    expect(useRemoteStore.getState().pairings[15]?.desktopPublicKey).toBe(DESKTOP_PK)
    expect(mockStorage.book[15]?.secretKey).toBe(PHONE_SK_C)
  })
})

describe('switching between desktops', () => {
  async function two(): Promise<void> {
    seed([STORED, STORED_B])
    await useRemoteStore.getState().boot()
  }

  it('puts the other desktop on screen and dials its room', async () => {
    await two()
    expect(useRemoteStore.getState().paired).toEqual(PAIRED)
    await useRemoteStore.getState().selectDesktop(DESKTOP_PK_B)
    expect(useRemoteStore.getState().paired).toEqual(PAIRED_B)
    expect(socket().deps.roomId).toBe(PAIRED_B.sessionRoomId)
    expect(socket().deps.url).toBe(PAIRED_B.relayUrl)
  })

  it('holds one radio awake, not two', async () => {
    await two()
    const first = socket()
    await useRemoteStore.getState().selectDesktop(DESKTOP_PK_B)
    expect(first.closed).toBe(true)
    expect(mockSockets).toHaveLength(2)
  })

  it('remembers the choice, and rewrites nothing else to do it', async () => {
    await two()
    await useRemoteStore.getState().selectDesktop(DESKTOP_PK_B)
    // The index only. Rewriting a desktop's key material to remember a tap
    // would be a great deal of keychain churn for a UI detail.
    expect(mockStorage.writes).toEqual([`active ${DESKTOP_PK_B}`])
    expect(mockStorage.active).toBe(DESKTOP_PK_B)
  })

  it('shows the safety phrase of the desktop it moved to', async () => {
    // Derived from the key stored for THAT desktop. A store that handed the
    // socket the wrong pairing's key would show the wrong words here -- which is
    // the one place in the app that mistake is visible to a user.
    await two()
    expect(useRemoteStore.getState().safetyPhrase).toBe(
      deriveVerificationPhrase(PHONE_PK, DESKTOP_PK),
    )
    await useRemoteStore.getState().selectDesktop(DESKTOP_PK_B)
    expect(useRemoteStore.getState().safetyPhrase).toBe(
      deriveVerificationPhrase(PHONE_PK_B, DESKTOP_PK_B),
    )
  })

  it('leaves nothing of the desktop it left on screen', async () => {
    await two()
    state('attached')
    await settle()
    session().resolveNext(GRANTS)
    session().resolveNext([{ id: 't1', name: 'Claude', shellType: 'pwsh', cwd: '/repo' }])
    await settle()
    session().output[0]?.([chunk()])
    session().status[0]?.({ terminalId: 't1', state: 'working', detail: null, at: 1 })
    expect(useRemoteStore.getState().terminals).toHaveLength(1)

    await useRemoteStore.getState().selectDesktop(DESKTOP_PK_B)

    const s = useRemoteStore.getState()
    // Somebody else's terminals under this desktop's name would be a bad enough
    // bug on its own; a grant carried across would enable a control the desktop
    // now on screen has not allowed.
    expect(s.terminals).toEqual([])
    expect(s.output).toEqual({})
    expect(s.outputEnd).toEqual({})
    expect(s.agentStatus).toEqual({})
    expect(s.capabilities).toEqual(NO_CAPABILITIES)
  })

  it('ignores a tap on the desktop already showing', async () => {
    await two()
    await useRemoteStore.getState().selectDesktop(DESKTOP_PK)
    expect(mockSockets).toHaveLength(1)
    expect(mockStorage.writes).toEqual([])
  })

  it('ignores a tap on a row whose pairing has already gone', async () => {
    // A stale row can be tapped once after the pairing behind it is removed, and
    // throwing inside a list that has already moved on helps nobody.
    await two()
    await expect(
      useRemoteStore.getState().selectDesktop('ff'.repeat(32)),
    ).resolves.toBeUndefined()
    expect(mockSockets).toHaveLength(1)
  })
})

describe('renaming a desktop', () => {
  async function two(): Promise<void> {
    seed([STORED, STORED_B])
    await useRemoteStore.getState().boot()
  }

  it('writes the new name and shows it', async () => {
    await two()
    await useRemoteStore.getState().renameDesktop(DESKTOP_PK_B, 'Basement server')
    expect(mockStorage.writes).toEqual([`write ${DESKTOP_PK_B}`])
    expect(mockStorage.book[1]?.label).toBe('Basement server')
    expect(useRemoteStore.getState().pairings[1]?.label).toBe('Basement server')
  })

  it('renames the desktop on screen without disturbing the connection', async () => {
    // The name is this phone's note to itself. The desktop is not told, and the
    // socket has no reason to notice.
    await two()
    await useRemoteStore.getState().renameDesktop(DESKTOP_PK, 'Work laptop')
    expect(useRemoteStore.getState().paired?.label).toBe('Work laptop')
    expect(mockSockets).toHaveLength(1)
    expect(socket().closed).toBe(false)
  })

  it('cleans what the user typed, exactly as an announced name is cleaned', async () => {
    await two()
    await useRemoteStore
      .getState()
      .renameDesktop(DESKTOP_PK, `  Work${String.fromCharCode(7)} laptop  `)
    expect(useRemoteStore.getState().paired?.label).toBe('Work laptop')
  })

  it('ignores a name that is nothing but spaces, rather than blanking the row', async () => {
    await two()
    await useRemoteStore.getState().renameDesktop(DESKTOP_PK, '   ')
    expect(useRemoteStore.getState().paired?.label).toBe(PAIRED.label)
    expect(mockStorage.writes).toEqual([])
  })

  it('ignores a rename of a desktop that is no longer there', async () => {
    await two()
    await expect(
      useRemoteStore.getState().renameDesktop('ff'.repeat(32), 'Ghost'),
    ).resolves.toBeUndefined()
    expect(mockStorage.writes).toEqual([])
  })

  it('numbers a rename that collides with another desktop', async () => {
    await two()
    await useRemoteStore.getState().renameDesktop(DESKTOP_PK_B, PAIRED.label)
    expect(useRemoteStore.getState().pairings[1]?.label).toBe(`${PAIRED.label} (2)`)
  })

  it('lets a desktop keep the name it already has', async () => {
    // The collision check skips the row being renamed, so re-typing the same
    // name is not a collision with itself.
    await two()
    await useRemoteStore.getState().renameDesktop(DESKTOP_PK, PAIRED.label)
    expect(useRemoteStore.getState().paired?.label).toBe(PAIRED.label)
  })
})

describe('forgetting one desktop', () => {
  async function three(): Promise<void> {
    seed([STORED, STORED_B, STORED_C])
    await useRemoteStore.getState().boot()
  }

  it('erases that desktop and its key, and no other', async () => {
    await three()
    await useRemoteStore.getState().forgetDesktop(DESKTOP_PK_B)
    expect(mockStorage.writes).toEqual([`remove ${DESKTOP_PK_B} -> ${DESKTOP_PK}`])
    expect(mockStorage.book.map((r) => r.desktopPublicKey)).toEqual([DESKTOP_PK, DESKTOP_PK_C])
    expect(useRemoteStore.getState().pairings).toEqual([PAIRED, PAIRED_C])
  })

  it('leaves the connection alone when it was not the desktop on screen', async () => {
    await three()
    await useRemoteStore.getState().forgetDesktop(DESKTOP_PK_B)
    expect(mockSockets).toHaveLength(1)
    expect(socket().closed).toBe(false)
    expect(useRemoteStore.getState().paired).toEqual(PAIRED)
  })

  it('moves to another paired desktop rather than to the pair screen', async () => {
    // The user removed ONE desktop. A phone that falls back to the pairing
    // screen while two others are still paired has lost them as far as the user
    // can tell.
    await three()
    await useRemoteStore.getState().forgetDesktop(DESKTOP_PK)
    expect(useRemoteStore.getState().paired).toEqual(PAIRED_B)
    expect(mockSockets).toHaveLength(2)
    expect(socket().deps.roomId).toBe(PAIRED_B.sessionRoomId)
    expect(mockStorage.writes).toEqual([`remove ${DESKTOP_PK} -> ${DESKTOP_PK_B}`])
  })

  it('lands on the pair screen when the last desktop goes', async () => {
    seed([STORED])
    await useRemoteStore.getState().boot()
    await useRemoteStore.getState().forgetDesktop(DESKTOP_PK)
    expect(mockStorage.writes).toEqual([`remove ${DESKTOP_PK} -> null`])
    const s = useRemoteStore.getState()
    expect(s.paired).toBeNull()
    expect(s.pairings).toEqual([])
    expect(s.safetyPhrase).toBeNull()
    expect(mockSockets).toHaveLength(1)
    expect(socket().closed).toBe(true)
  })

  it('is harmless when the row has already gone', async () => {
    // Two taps on Remove race, and the second must not throw inside a screen
    // that has already redrawn without the row.
    await three()
    await useRemoteStore.getState().forgetDesktop(DESKTOP_PK_B)
    await expect(
      useRemoteStore.getState().forgetDesktop(DESKTOP_PK_B),
    ).resolves.toBeUndefined()
    expect(mockStorage.writes).toHaveLength(1)
  })
})

describe('the goodbye a phone says on its way out', () => {
  // Since v1.40 the phone mints a fresh keypair per desktop, which is what stops
  // two desktops correlating one handset. The cost is that unpairing destroys
  // this phone's only way of ever being that device again -- so a desktop that
  // is not told is left holding a row it can never reach and the user can only
  // remove by hand, guessing which of several look-alike entries is the dead
  // one. Saying so is the fix; everything below is about it staying a courtesy
  // rather than becoming a precondition for unpairing.

  /** Paired, connected, and attached, so there is a live desktop to tell. */
  async function attached(): Promise<void> {
    seed([STORED, STORED_B])
    await useRemoteStore.getState().boot()
    state('attached')
    await settle()
    session().resolveNext(GRANTS)
    session().resolveNext([])
    await settle()
  }

  it('tells the desktop on screen, and does not wait 20 seconds to hear back', async () => {
    await attached()
    const leaving = session()
    await useRemoteStore.getState().forgetDesktop(DESKTOP_PK)
    expect(leaving.requests).toEqual([
      { kind: 'getCapabilities' },
      { kind: 'listTerminals' },
      { kind: 'unpair' },
    ])
    // The two attach requests take the default; only the goodbye asks for a
    // short one. Nothing on the phone waits for the answer, so this bounds the
    // pending entry rather than a button -- but a goodbye left outstanding for
    // the full timeout is a slot held open for a desktop whose key this phone
    // has already erased.
    expect(leaving.timeouts).toEqual([undefined, undefined, GOODBYE_TIMEOUT_MS])
  })

  it('is on the wire before the socket that carries it is closed', async () => {
    // The ordering is the whole reason the goodbye can be fired and forgotten.
    // `forgetDesktop` closes this socket on the line after it asks, so if the
    // request were merely SCHEDULED rather than written, the send would land on
    // a socket that had already gone.
    await attached()
    const leaving = session()
    const closing = socket()
    await useRemoteStore.getState().forgetDesktop(DESKTOP_PK)
    expect(leaving.requests).toContainEqual({ kind: 'unpair' })
    expect(closing.closed).toBe(true)
  })

  it('forgets the desktop anyway when the goodbye is never answered', async () => {
    // Unpairing is a local act. A desktop that is switched off, on another
    // network, or running a build that has never heard of this request must not
    // be able to keep a phone paired to it.
    await attached()
    const leaving = session()
    await useRemoteStore.getState().forgetDesktop(DESKTOP_PK)
    leaving.rejectNext(new Error('timed out'))
    await settle()
    expect(useRemoteStore.getState().pairings).toEqual([PAIRED_B])
    expect(mockStorage.book.map((r) => r.desktopPublicKey)).toEqual([DESKTOP_PK_B])
    // And says nothing about it. "The desktop is offline" is a true sentence and
    // the wrong thing to put in front of someone who just asked to forget it --
    // the row is gone from this phone either way, which is what they asked for.
    expect(useRemoteStore.getState().error).toBeNull()
  })

  it('says nothing to a desktop that is not the one on screen', async () => {
    // The others have no open session, and dialling one purely to say goodbye
    // would mean connecting to a machine the user has already decided to
    // forget. Those leave a row behind, and that is the accepted cost.
    await attached()
    const leaving = session()
    await useRemoteStore.getState().forgetDesktop(DESKTOP_PK_B)
    expect(leaving.requests).not.toContainEqual({ kind: 'unpair' })
  })

  it('says nothing while the desktop is unreachable', async () => {
    // Booted but never attached: the session object exists, the desktop is not
    // on the other end of it. A frame written here reaches a relay room with
    // nobody in it.
    seed([STORED, STORED_B])
    await useRemoteStore.getState().boot()
    expect(useRemoteStore.getState().stale).toBe(true)
    await useRemoteStore.getState().forgetDesktop(DESKTOP_PK)
    expect(session().requests).not.toContainEqual({ kind: 'unpair' })
  })

  it('says nothing when the app is in the background and the socket is gone', async () => {
    // Backgrounding drops the socket AND the session while the pairing stays
    // active, so this is the one case where there is no session to ask at all.
    // Unpairing from the Settings screen the user left open still has to work.
    await attached()
    const leaving = session()
    mockAppState.handlers[0]?.('background')
    await useRemoteStore.getState().forgetDesktop(DESKTOP_PK)
    expect(leaving.requests).not.toContainEqual({ kind: 'unpair' })
    expect(useRemoteStore.getState().pairings).toEqual([PAIRED_B])
  })
})

describe('stale means stale', () => {
  async function attached(): Promise<void> {
    seed([STORED])
    await useRemoteStore.getState().boot()
    state('attached')
    await settle()
    // Two requests go out on attach, capabilities first. `resolveNext` answers
    // them in the order they were made.
    session().resolveNext(GRANTS)
    session().resolveNext([])
    await settle()
  }

  it('clears stale and asks what it may do, then for the terminal list', async () => {
    await attached()
    expect(useRemoteStore.getState().stale).toBe(false)
    expect(session().requests).toEqual([{ kind: 'getCapabilities' }, { kind: 'listTerminals' }])
  })

  it('keeps the list once it arrives', async () => {
    seed([STORED])
    await useRemoteStore.getState().boot()
    state('attached')
    await settle()
    session().resolveNext(GRANTS)
    session().resolveNext([{ id: 't1', name: 'Claude', shellType: 'pwsh', cwd: '/repo' }])
    await settle()
    expect(useRemoteStore.getState().terminals).toEqual([
      { id: 't1', name: 'Claude', shellType: 'pwsh', cwd: '/repo' },
    ])
  })

  it('goes stale the moment the socket leaves attached', async () => {
    await attached()
    state('offline')
    expect(useRemoteStore.getState().stale).toBe(true)
    expect(useRemoteStore.getState().status).toBe('offline')
  })

  it('clears the error banner when the desktop comes back', async () => {
    // The message describes a connection that no longer exists. Left up, a phone
    // fresh out of a tunnel shows a live terminal list underneath "The desktop is
    // offline" -- and nothing else in the store ever clears it.
    await attached()
    const failed = useRemoteStore.getState().refreshTerminals()
    session().rejectNext(new Error('the desktop refused'))
    await expect(failed).rejects.toThrow('the desktop refused')
    expect(useRemoteStore.getState().error).toBe('the desktop refused')

    state('offline')
    state('attached')
    expect(useRemoteStore.getState().error).toBeNull()
  })

  it('keeps the banner while the desktop is still away', async () => {
    // Only ATTACH clears it. A drop straight into `connecting` is not news that
    // the problem is over, and blanking the banner there would hide the reason
    // the user's last action failed.
    await attached()
    const failed = useRemoteStore.getState().refreshTerminals()
    session().rejectNext(new Error('the desktop refused'))
    await expect(failed).rejects.toThrow()

    state('connecting')
    expect(useRemoteStore.getState().error).toBe('the desktop refused')
  })

  it('keeps the last-known terminals while stale', async () => {
    // Showing nothing would read as "the desktop has no terminals", which is a
    // different and wrong statement.
    seed([STORED])
    await useRemoteStore.getState().boot()
    state('attached')
    await settle()
    session().resolveNext(GRANTS)
    session().resolveNext([{ id: 't1', name: 'Claude', shellType: 'pwsh', cwd: '/repo' }])
    await settle()
    state('offline')
    expect(useRemoteStore.getState().terminals).toHaveLength(1)
  })

  const writes: [string, () => Promise<unknown>][] = [
    ['refreshTerminals', () => useRemoteStore.getState().refreshTerminals()],
    ['refreshCapabilities', () => useRemoteStore.getState().refreshCapabilities()],
    ['subscribe', () => useRemoteStore.getState().subscribe('t1')],
    ['unsubscribe', () => useRemoteStore.getState().unsubscribe('t1')],
    ['send', () => useRemoteStore.getState().send('t1', 'ls')],
    ['runCommand', () => useRemoteStore.getState().runCommand('t1', 'ls')],
    ['createTerminal', () => useRemoteStore.getState().createTerminal('New')],
    ['closeTerminal', () => useRemoteStore.getState().closeTerminal('t1')],
  ]

  it.each(writes)('%s refuses while stale and queues nothing', async (_name, run) => {
    // Work must not silently execute later. A queued runCommand that fires on
    // reconnect is arbitrary shell execution the user has stopped expecting.
    await attached()
    const before = session().requests.length
    state('offline')
    await expect(run()).rejects.toThrow(/offline|not connected/i)
    expect(session().requests).toHaveLength(before)
  })

  it.each(writes)('%s refuses before anything is paired', async (_name, run) => {
    await useRemoteStore.getState().boot()
    await expect(run()).rejects.toThrow()
    expect(mockSessions).toHaveLength(0)
  })

  it.each(writes)('%s says on screen why it refused while stale', async (_name, run) => {
    // Every screen swallows the rejection and reads the banner instead, so a
    // refusal that only threw was a button that did nothing at all: no output, no
    // error, nothing to tell the user their desktop had gone.
    await attached()
    state('offline')
    await expect(run()).rejects.toThrow()
    expect(useRemoteStore.getState().error).toBe(
      'The desktop is offline. Reconnect before sending anything.',
    )
  })

  it.each(writes)('%s says on screen why it refused when unpaired', async (_name, run) => {
    await useRemoteStore.getState().boot()
    await expect(run()).rejects.toThrow()
    expect(useRemoteStore.getState().error).toBe('This phone is not paired with a desktop yet.')
  })

  it('sends again once the connection is back', async () => {
    await attached()
    state('offline')
    state('attached')
    await settle()
    // Not awaited: the fake session leaves every request pending, and what is
    // being asserted is that the request went out at all.
    void useRemoteStore.getState().runCommand('t1', 'ls').catch(() => undefined)
    expect(session().requests).toContainEqual({
      kind: 'runCommand', terminalId: 't1', command: 'ls',
    })
  })
})

describe('output', () => {
  async function attached(): Promise<void> {
    seed([STORED])
    await useRemoteStore.getState().boot()
    state('attached')
    await settle()
    session().resolveNext(GRANTS)
    session().resolveNext([])
    await settle()
  }

  it('appends to the terminal the chunk names', async () => {
    await attached()
    session().output[0]?.([chunk({ chunk: 'one ' }), chunk({ terminalId: 't2', chunk: 'two' })])
    session().output[0]?.([chunk({ chunk: 'more' })])
    expect(useRemoteStore.getState().output.t1).toBe('one more')
    expect(useRemoteStore.getState().output.t2).toBe('two')
  })

  it('renders the gap notice once when output was missed', async () => {
    await attached()
    session().output[0]?.([
      chunk({ chunk: 'after', missed: 4096, marker: '\n[4096 chars skipped]\n' }),
    ])
    expect(useRemoteStore.getState().output.t1).toBe('\n[4096 chars skipped]\nafter')
    expect(useRemoteStore.getState().output.t1?.match(/skipped/g)).toHaveLength(1)
  })

  it('does not invent a notice for a chunk that missed nothing', async () => {
    await attached()
    session().output[0]?.([chunk({ chunk: 'clean', marker: '[should not appear]' })])
    expect(useRemoteStore.getState().output.t1).toBe('clean')
  })

  it('keeps a bounded scrollback', async () => {
    // A phone cannot hold a day of agent output, and the view only ever shows
    // the tail. Trimming the head is what keeps a long session from an OOM.
    await attached()
    session().output[0]?.([chunk({ chunk: 'x'.repeat(300_000) })])
    const buffered = useRemoteStore.getState().output.t1 as string
    expect(buffered.length).toBeLessThanOrEqual(200_000)
    expect(buffered.endsWith('x')).toBe(true)
  })

  it('records agent status per terminal', async () => {
    await attached()
    session().status[0]?.({ terminalId: 't1', status: 'thinking', summary: 'reading files' })
    expect(useRemoteStore.getState().agentStatus.t1).toEqual({
      terminalId: 't1', status: 'thinking', summary: 'reading files',
    })
  })
})

/** The desktop's screen flattener re-sends the live region of the screen whenever
 *  it changes, and says which offset that region starts at. Ignoring the offset is
 *  what made a redrawn status line arrive as one appended line per animation
 *  frame -- the agent's verb repeating down the phone's screen.
 *
 *  `outputEnd` translates between the two copies. It anchors the END of what this
 *  phone holds, in the desktop's own offsets, because the phone's copy is not the
 *  desktop's stream: the head is trimmed at MAX_OUTPUT_CHARS and gap notices are
 *  spliced in. An anchor at the start would need re-basing on every trim. */
describe('an edit that replaces what the phone already showed', () => {
  async function attached(): Promise<void> {
    seed([STORED])
    await useRemoteStore.getState().boot()
    state('attached')
    await settle()
    session().resolveNext(GRANTS)
    session().resolveNext([])
    await settle()
  }

  const view = (): string => useRemoteStore.getState().output.t1 as string

  function feed(...over: Partial<OutputChunk>[]): void {
    session().output[0]?.(over.map((o) => chunk(o)))
  }

  it('collapses a redrawn status line to the frame that is current', async () => {
    await attached()
    feed({ chunk: 'line 1 thinking (1s)', replaceFrom: 0 })
    feed({ chunk: 'thinking (2s)', replaceFrom: 7 })
    feed({ chunk: 'thinking (3s)', replaceFrom: 7 })
    expect(view()).toBe('line 1 thinking (3s)')
    expect(view().match(/thinking/g)).toHaveLength(1)
  })

  it('leaves an ordinary append alone', async () => {
    await attached()
    feed({ chunk: 'one ' }, { chunk: 'two' })
    feed({ chunk: ' three' })
    expect(view()).toBe('one two three')
  })

  it('still lands the edit after the head of the scrollback was trimmed away', async () => {
    // The anchor is on the END of the phone's copy, so trimming the head does not
    // have to touch it. A missed re-base here would truncate live output.
    await attached()
    feed({ chunk: 'x'.repeat(250_000) })
    feed({ chunk: 'tail', replaceFrom: 250_000 - 4 })
    expect(view()).toHaveLength(MAX_OUTPUT_CHARS)
    expect(view().endsWith('xtail')).toBe(true)
  })

  it('replaces the whole buffer when the edit reaches back past everything it holds', async () => {
    // Every char this phone still has sits inside the replaced range, so keeping
    // any of it would duplicate text the desktop has just re-sent.
    await attached()
    feed({ chunk: 'a'.repeat(100) })
    feed({ chunk: 'fresh', replaceFrom: 0 })
    expect(view()).toBe('fresh')
  })

  it('degrades to an append when the offset runs past the end of its copy', async () => {
    // What a phone that subscribed mid-session sees: the desktop counts from the
    // start of the terminal, this copy starts wherever the phone joined. A
    // duplicated frame beats truncating output that is still on screen.
    await attached()
    feed({ chunk: 'joined late' })
    feed({ chunk: ' more', replaceFrom: 9_000 })
    expect(view()).toBe('joined late more')
  })

  it('re-anchors on the offset it was given, so the next edit lands correctly', async () => {
    // The anchor is set absolutely from a numeric offset rather than advanced by
    // the chunk length. That is what stops a single mis-anchored append from
    // putting every later edit permanently out of step.
    await attached()
    feed({ chunk: 'joined late' })
    feed({ chunk: ' more', replaceFrom: 9_000 })
    feed({ chunk: 'X', replaceFrom: 9_004 })
    expect(view()).toBe('joined late morX')
  })

  it('splices the gap notice between what it keeps and the replacement', async () => {
    await attached()
    feed({ chunk: 'held' })
    feed({ chunk: 'new', missed: 12, marker: '[gap]', replaceFrom: 2 })
    expect(view()).toBe('he[gap]new')
  })

  it('anchors each terminal on its own offsets', async () => {
    await attached()
    feed({ chunk: 'aaaa' }, { terminalId: 't2', chunk: 'bbbbbbbb' })
    feed({ chunk: 'A', replaceFrom: 3 }, { terminalId: 't2', chunk: 'B', replaceFrom: 3 })
    expect(view()).toBe('aaaA')
    expect(useRemoteStore.getState().output.t2).toBe('bbbB')
  })

  it('forgets the anchor along with the buffer when a terminal closes', async () => {
    // A reused terminal id must not be measured against the offsets of the
    // terminal that had it before.
    await attached()
    feed({ chunk: 'x'.repeat(500) })
    const done = useRemoteStore.getState().closeTerminal('t1')
    session().resolveNext({ ok: true })
    await done
    feed({ chunk: 'reopened', replaceFrom: 480 })
    expect(view()).toBe('reopened')
  })
})

describe('unpairing', () => {
  it('clears storage, closes the socket, and forgets what was on screen', async () => {
    seed([STORED])
    await useRemoteStore.getState().boot()
    state('attached')
    await settle()
    session().resolveNext(GRANTS)
    session().resolveNext([{ id: 't1', name: 'Claude', shellType: 'pwsh', cwd: '/repo' }])
    await settle()
    session().output[0]?.([chunk()])
    expect(useRemoteStore.getState().terminals).toHaveLength(1)

    await useRemoteStore.getState().unpair()

    expect(mockStorage.writes).toEqual([`remove ${DESKTOP_PK} -> null`])
    expect(mockStorage.book).toEqual([])
    expect(socket().closed).toBe(true)
    const s = useRemoteStore.getState()
    expect(s.paired).toBeNull()
    expect(s.terminals).toEqual([])
    expect(s.output).toEqual({})
    expect(s.safetyPhrase).toBeNull()
    // A phone that is no longer paired may do nothing, and must say so.
    expect(s.capabilities).toEqual(NO_CAPABILITIES)
  })

  it('is harmless on a phone that never paired', async () => {
    await expect(useRemoteStore.getState().unpair()).resolves.toBeUndefined()
  })

  it('drops the cached private key as well as the stored one', async () => {
    // The keystore is not the only copy: the vault is a module-level cache that
    // outlives the store, so an unpair that erased only the keychain would go on
    // greeting that desktop under the key the user just revoked for the rest of
    // the process -- the promise true of the disk and false of the running app.
    seed([STORED])
    await useRemoteStore.getState().boot()
    await settle()
    expect(mockStorage.loads).toBe(1)

    await useRemoteStore.getState().unpair()
    // Gone from the cache too, so tapping the row it came from does nothing at
    // all rather than dialling with a revoked key.
    await useRemoteStore.getState().selectDesktop(DESKTOP_PK)
    expect(mockSockets).toHaveLength(1)

    await useRemoteStore.getState().boot()
    expect(mockStorage.loads).toBe(2)
    expect(useRemoteStore.getState().pairings).toEqual([])
  })

  it('unpairs the desktop on screen only, leaving the others paired', async () => {
    // What Settings promises in so many words: this phone forgets its key for
    // that desktop, and any others stay paired.
    seed([STORED, STORED_B])
    await useRemoteStore.getState().boot()
    await useRemoteStore.getState().unpair()
    expect(mockStorage.writes).toEqual([`remove ${DESKTOP_PK} -> ${DESKTOP_PK_B}`])
    expect(useRemoteStore.getState().pairings).toEqual([PAIRED_B])
    expect(useRemoteStore.getState().paired).toEqual(PAIRED_B)
  })
})

describe('the stamp that says a pairing just happened', () => {
  it('is zero when nothing is paired', () => {
    expect(pairingStamp([])).toBe(0)
  })

  it('is the newest pairing, wherever it sits in the list', () => {
    // The list is in the order the desktops were paired and a re-pair keeps its
    // old position, so the newest stamp can be anywhere in it.
    expect(pairingStamp([{ ...PAIRED, pairedAt: 5 }, { ...PAIRED_B, pairedAt: 3 }])).toBe(5)
    expect(pairingStamp([{ ...PAIRED, pairedAt: 3 }, { ...PAIRED_B, pairedAt: 5 }])).toBe(5)
  })

  it('moves when a desktop already in the list is paired again', async () => {
    // A count would not, and that is the whole reason this exists: a re-pair
    // mints a fresh key and therefore fresh safety words, which have to be
    // compared like any other. Verification skipped because the name was already
    // on the list is verification not done.
    seed([STORED])
    await useRemoteStore.getState().boot()
    const before = pairingStamp(useRemoteStore.getState().pairings)

    mockStorage.secrets = [PHONE_SK_C]
    mockPairing.result = {
      desktop: { ...PAIRED, pairedAt: PAIRED.pairedAt + 60_000 },
      safetyPhrase: 'x',
    }
    await useRemoteStore.getState().pairFromQr(rawFor(DESKTOP_PK), 'phone')

    expect(useRemoteStore.getState().pairings).toHaveLength(1)
    expect(pairingStamp(useRemoteStore.getState().pairings)).toBeGreaterThan(before)
  })
})

describe('what this phone may do', () => {
  async function attached(): Promise<void> {
    seed([STORED])
    await useRemoteStore.getState().boot()
    state('attached')
    await settle()
  }

  // Pins the reported bug: the desktop refuses `listTerminals` without `read`,
  // so a phone that attached before the grant holds an empty list AND the
  // refusal that produced it. The push used to set the flag and stop there,
  // leaving both on screen -- "I gave it read capability but it says there are
  // not any terminals even though we are in one".
  it('re-lists the terminals when read is granted after attaching', async () => {
    await attached()
    session().resolveNext(NO_CAPABILITIES)
    session().rejectNext(new Error('remote device lacks the "read" capability'))
    await settle()
    expect(useRemoteStore.getState().terminals).toEqual([])
    expect(useRemoteStore.getState().error).toContain('read')

    const before = session().requests.length
    for (const cb of session().caps) cb(GRANTS)
    await settle()

    // The grant alone is not the fix. The refetch it triggers is.
    expect(session().requests.slice(before)).toContainEqual({ kind: 'listTerminals' })
    session().resolveNext([{ id: 't1', name: 'Claude', shellType: 'pwsh', cwd: '/repo' }])
    await settle()
    expect(useRemoteStore.getState().terminals).toHaveLength(1)
    // The stale refusal must go with it, or the list arrives under a banner
    // still saying the device is not allowed to have it.
    expect(useRemoteStore.getState().error).toBeNull()
  })

  it('leaves the retry failure on screen when the re-list fails too', async () => {
    // The refetch is fire-and-forget, so its rejection has nowhere to go and an
    // unhandled one crashes the app. `ask` has already written the real reason
    // to the banner by the time the catch runs -- swallowing it there is what
    // lets the user see that reason instead of a stale capability message.
    await attached()
    session().resolveNext(NO_CAPABILITIES)
    session().rejectNext(new Error('remote device lacks the "read" capability'))
    await settle()

    for (const cb of session().caps) cb(GRANTS)
    await settle()
    session().rejectNext(new Error('The desktop is busy.'))
    await settle()

    expect(useRemoteStore.getState().terminals).toEqual([])
    expect(useRemoteStore.getState().error).toBe('The desktop is busy.')
  })

  it('starts out allowed nothing, because it has not asked yet', () => {
    expect(useRemoteStore.getState().capabilities).toEqual(NO_CAPABILITIES)
  })

  it('asks on attach and holds the answer', async () => {
    await attached()
    expect(session().requests).toContainEqual({ kind: 'getCapabilities' })
    session().resolveNext(GRANTS)
    await settle()
    expect(useRemoteStore.getState().capabilities).toEqual(GRANTS)
  })

  it('asks before it asks for anything else -- the list is drawn from the grants', async () => {
    await attached()
    expect(session().requests[0]).toEqual({ kind: 'getCapabilities' })
  })

  it('fails closed when the desktop answers with junk', async () => {
    await attached()
    session().resolveNext('nope')
    await settle()
    expect(useRemoteStore.getState().capabilities).toEqual(NO_CAPABILITIES)
  })

  it('fails closed per flag, so a half-answer grants only what it names', async () => {
    await attached()
    session().resolveNext({ read: true, createTerminal: 'yes' })
    await settle()
    expect(useRemoteStore.getState().capabilities).toEqual({
      read: true,
      // 'yes' is not `true`. Anything short of the literal is not a grant.
      createTerminal: false,
      writeToTerminal: false,
      closeTerminal: false,
    })
  })

  it('takes the desktop word for it when Settings changes mid-session', async () => {
    await attached()
    session().resolveNext(GRANTS)
    await settle()
    session().caps[0]?.({ ...NO_CAPABILITIES, read: true })
    expect(useRemoteStore.getState().capabilities).toEqual({
      read: true,
      createTerminal: false,
      writeToTerminal: false,
      closeTerminal: false,
    })
  })

  it('does not throw when the desktop never answers', async () => {
    await attached()
    await expect(
      Promise.race([useRemoteStore.getState().refreshCapabilities(), settle()]),
    ).resolves.toBeUndefined()
  })
})

describe('following the app in and out of the foreground', () => {
  async function booted(): Promise<void> {
    seed([STORED])
    await useRemoteStore.getState().boot()
  }

  it('drops the socket when the app goes to the background', async () => {
    // A socket held in the background is a radio kept awake for frames nobody is
    // looking at, and the relay's idle timer cuts it anyway.
    await booted()
    mockAppState.handlers[0]?.('background')
    expect(socket().closed).toBe(true)
    expect(useRemoteStore.getState().stale).toBe(true)
  })

  it('holds the socket through the iOS task-switcher peek', async () => {
    // iOS fires 'inactive' for a notification-shade pull. Treating that as a
    // background is a reconnect every time the user glances at a notification.
    await booted()
    mockAppState.handlers[0]?.('inactive')
    expect(socket().closed).toBe(false)
  })

  it('reconnects on the way back, once', async () => {
    // Android fires 'change' more eagerly than iOS -- a task-switcher swipe can
    // produce several in a row, and each one dialing is a reconnect storm.
    await booted()
    mockAppState.handlers[0]?.('background')
    mockAppState.handlers[0]?.('active')
    jest.advanceTimersByTime(50)
    mockAppState.handlers[0]?.('active')
    jest.advanceTimersByTime(FOREGROUND_DEBOUNCE_MS)
    await settle()
    expect(mockSockets).toHaveLength(2)
  })

  it('does not reconnect while the app is still coming forward', async () => {
    await booted()
    mockAppState.handlers[0]?.('background')
    mockAppState.handlers[0]?.('active')
    jest.advanceTimersByTime(FOREGROUND_DEBOUNCE_MS - 1)
    await settle()
    expect(mockSockets).toHaveLength(1)
  })

  it('does not reconnect a phone that has been unpaired', async () => {
    await booted()
    await useRemoteStore.getState().unpair()
    mockAppState.handlers[0]?.('active')
    jest.advanceTimersByTime(FOREGROUND_DEBOUNCE_MS)
    await settle()
    expect(mockSockets).toHaveLength(1)
  })

  it('does not stack a second socket when it is already connected', async () => {
    await booted()
    mockAppState.handlers[0]?.('active')
    jest.advanceTimersByTime(FOREGROUND_DEBOUNCE_MS)
    await settle()
    expect(mockSockets).toHaveLength(1)
  })

  it('listens exactly once however often boot is called', async () => {
    await booted()
    await useRemoteStore.getState().boot()
    expect(mockAppState.handlers).toHaveLength(1)
  })
})

describe('a request the desktop refuses', () => {
  async function attached(): Promise<void> {
    seed([STORED])
    await useRemoteStore.getState().boot()
    state('attached')
    await settle()
    session().resolveNext(GRANTS)
    session().resolveNext([])
    await settle()
  }

  it('shows why, and still rejects the caller', async () => {
    await attached()
    // Both halves matter. Swallowing the rejection would leave a screen showing
    // a spinner for work that has already failed; not recording the message
    // would leave the user with a failure and no reason for it.
    const pending = useRemoteStore.getState().runCommand('t1', 'ls')
    session().rejectNext(new Error('No terminal t1 on this desktop.'))
    await expect(pending).rejects.toThrow(/No terminal t1/)
    expect(useRemoteStore.getState().error).toBe('No terminal t1 on this desktop.')
  })

  it('reports a rejection that is not an Error at all', async () => {
    await attached()
    // The session is fed by the network. A frame that rejects with a bare string
    // must not turn into "undefined" on screen.
    const pending = useRemoteStore.getState().subscribe('t1')
    session().rejectNext('link went down')
    await expect(pending).rejects.toBe('link went down')
    expect(useRemoteStore.getState().error).toBe('link went down')
  })
})

describe('the wiring the store hands to the socket and the session', () => {
  async function booted(): Promise<void> {
    seed([STORED])
    await useRemoteStore.getState().boot()
  }

  function sessionDeps(): {
    send: (plaintext: unknown) => void
    setTimer: (fn: () => void, ms: number) => unknown
    clearTimer: (timer: unknown) => void
  } {
    return session().deps as never
  }

  it('writes a session frame to the socket that session belongs to', async () => {
    await booted()
    sessionDeps().send(new Uint8Array([1, 2, 3]))
    expect(socket().sent).toEqual([new Uint8Array([1, 2, 3])])
  })

  it('drops a session frame written after the socket is gone', async () => {
    await booted()
    const deps = sessionDeps()
    // The session outlives the socket by a moment on every backgrounding. A
    // write in that gap must be a no-op, not a throw inside the retransmit path.
    mockAppState.handlers[0]?.('background')
    expect(() => deps.send(new Uint8Array([9]))).not.toThrow()
  })

  it('gives the session real timers', async () => {
    await booted()
    const deps = sessionDeps()
    const fired: string[] = []
    const kept = deps.setTimer(() => fired.push('kept'), 10)
    const cancelled = deps.setTimer(() => fired.push('cancelled'), 10)
    deps.clearTimer(cancelled)
    jest.advanceTimersByTime(20)
    expect(fired).toEqual(['kept'])
    expect(kept).toBeDefined()
  })

  it('opens the URL the socket asks for', async () => {
    await booted()
    const opened: string[] = []
    const globals = globalThis as { WebSocket?: unknown }
    const real = globals.WebSocket
    globals.WebSocket = class {
      constructor(url: string) {
        opened.push(url)
      }
    }
    try {
      socket().deps.open('wss://relay.test/v1/pair/abc')
    } finally {
      globals.WebSocket = real
    }
    expect(opened).toEqual(['wss://relay.test/v1/pair/abc'])
  })

  it('builds a fresh handshake for every attachment', async () => {
    await booted()
    const first = socket().deps.handshake()
    const second = socket().deps.handshake()
    // One ephemeral key per attachment is what makes a recorded session
    // unreadable after the fact -- a handshake reused across reconnects would
    // hand a recorder the whole history for one compromise.
    expect(first.ownPublicKey).toMatch(/^[0-9a-f]{64}$/)
    expect(first).not.toBe(second)
  })

  it('hands an arriving frame to the session, and ignores relay control frames', async () => {
    await booted()
    socket().deps.onFrame(new Uint8Array([7, 7]))
    expect(session().frames).toEqual([new Uint8Array([7, 7])])
    // The relay's own frames are not part of the sealed conversation, so the
    // store has nothing to do with them.
    expect(socket().deps.onControl({ kind: 'peer-joined', role: 'desktop' })).toBeUndefined()
  })

  it('gives the socket a clock and real timers', async () => {
    await booted()
    const before = Date.now()
    expect(socket().deps.now()).toBeGreaterThanOrEqual(before)

    const fired: string[] = []
    const kept = socket().deps.setTimer(() => fired.push('kept'), 10)
    const cancelled = socket().deps.setTimer(() => fired.push('cancelled'), 10)
    socket().deps.clearTimer(cancelled)
    jest.advanceTimersByTime(20)
    expect(fired).toEqual(['kept'])
    expect(kept).toBeDefined()
  })
})

describe('creating and closing terminals', () => {
  const T1 = { id: 't1', name: 'Claude', shellType: 'pwsh', cwd: '/repo' }
  const T2 = { id: 't2', name: 'Codex', shellType: 'pwsh', cwd: '/repo' }

  async function attachedWith(terminals: unknown[]): Promise<void> {
    seed([STORED])
    await useRemoteStore.getState().boot()
    state('attached')
    await settle()
    session().resolveNext(GRANTS)
    session().resolveNext(terminals)
    await settle()
  }

  it('re-reads the list after creating a terminal, so the new one appears', async () => {
    await attachedWith([])
    const done = useRemoteStore.getState().createTerminal('New', '/repo/api')
    session().resolveNext({ terminalId: 't9' })
    await settle()
    session().resolveNext([{ id: 't9', name: 'New', shellType: 'pwsh', cwd: '/repo/api' }])
    await done
    // Without the re-read the phone would report success and show a list that
    // does not contain the terminal it just made.
    expect(useRemoteStore.getState().terminals).toEqual([
      { id: 't9', name: 'New', shellType: 'pwsh', cwd: '/repo/api' },
    ])
    expect(session().requests).toContainEqual({
      kind: 'createTerminal',
      name: 'New',
      cwd: '/repo/api',
    })
  })

  it('omits cwd entirely when none was given, rather than sending undefined', async () => {
    await attachedWith([])
    const done = useRemoteStore.getState().createTerminal('New')
    session().resolveNext({ terminalId: 't9' })
    await settle()
    session().resolveNext([])
    await done
    expect(session().requests).toContainEqual({ kind: 'createTerminal', name: 'New' })
  })

  it('drops a closed terminal and its scrollback without waiting to be told again', async () => {
    await attachedWith([T1, T2])
    session().output[0]?.([chunk({ terminalId: 't1' }), chunk({ terminalId: 't2' })])

    const done = useRemoteStore.getState().closeTerminal('t1')
    session().resolveNext({ ok: true })
    await done

    expect(useRemoteStore.getState().terminals).toEqual([T2])
    // The buffer belongs to a terminal that no longer exists. Keeping it would
    // eventually show a reused id somebody else's output.
    expect(useRemoteStore.getState().output).toEqual({ t2: 'hello' })
  })
})

describe('a reconnect the user changed their mind about', () => {
  it('cancels the pending dial when the app goes straight back to the background', async () => {
    seed([STORED])
    await useRemoteStore.getState().boot()
    mockAppState.handlers[0]?.('background')
    mockAppState.handlers[0]?.('active')
    // Inside the debounce window. Leaving the timer armed would dial a socket
    // for an app that is no longer on screen -- and then hold it there.
    mockAppState.handlers[0]?.('background')
    jest.advanceTimersByTime(FOREGROUND_DEBOUNCE_MS * 4)
    await settle()
    expect(mockSockets).toHaveLength(1)
  })
})

describe('the wiring the store hands to the pairing client', () => {
  const RAW = JSON.stringify({
    v: 1,
    relayUrl: 'wss://relay.test',
    pairingId: '0123456789abcdef0123456789abcdef',
    desktopPublicKey: DESKTOP_PK,
    oneTimeSecret: 'aa'.repeat(32),
  })

  function pairingDeps(): {
    open: (url: string) => unknown
    now: () => number
    setTimer: (fn: () => void, ms: number) => unknown
    clearTimer: (timer: unknown) => void
  } {
    return (mockPairing.calls[0] as { deps: never }).deps
  }

  it('gives the pairing client a socket opener, a clock and real timers', async () => {
    mockPairing.result = { desktop: PAIRED, safetyPhrase: 'x' }
    await useRemoteStore.getState().pairFromQr(RAW, 'phone')

    const opened: string[] = []
    const globals = globalThis as { WebSocket?: unknown }
    const real = globals.WebSocket
    globals.WebSocket = class {
      constructor(url: string) {
        opened.push(url)
      }
    }
    try {
      pairingDeps().open('wss://relay.test/v1/pair/0123456789abcdef0123456789abcdef')
    } finally {
      globals.WebSocket = real
    }
    expect(opened).toEqual(['wss://relay.test/v1/pair/0123456789abcdef0123456789abcdef'])

    // Pairing offers expire, so the clock and the timers are not decoration --
    // they are how the client gives up instead of waiting on a dead offer.
    expect(pairingDeps().now()).toBeGreaterThan(0)
    const fired: string[] = []
    pairingDeps().setTimer(() => fired.push('kept'), 10)
    const cancelled = pairingDeps().setTimer(() => fired.push('cancelled'), 10)
    pairingDeps().clearTimer(cancelled)
    jest.advanceTimersByTime(20)
    expect(fired).toEqual(['kept'])
  })

  it('says something useful when pairing fails with something that is not an Error', async () => {
    // The pairing client talks to the network and to a QR code the user pointed
    // a camera at. A rejection that is not an Error must not surface as
    // "undefined" on the one screen a new user sees first.
    mockPairing.error = 'socket died' as unknown as Error
    await useRemoteStore.getState().pairFromQr(RAW, 'phone')
    expect(useRemoteStore.getState().error).toBe('Pairing failed.')
    expect(useRemoteStore.getState().paired).toBeNull()
  })
})

describe('an attach where the desktop answers with a refusal', () => {
  it('swallows both re-asks rather than raising an unhandled rejection', async () => {
    seed([STORED])
    await useRemoteStore.getState().boot()
    state('attached')
    await settle()

    // Attaching fires two requests nobody is awaiting -- the capability re-ask
    // and the terminal list. A rejection from either has no caller to reach, so
    // if it were not swallowed here it would surface as an unhandled rejection
    // that crashes the app on a desktop that merely said no.
    session().rejectNext(new Error('The desktop is busy.'))
    session().rejectNext(new Error('The desktop is still busy.'))
    await settle()

    expect(useRemoteStore.getState().error).toMatch(/busy/)
    expect(useRemoteStore.getState().capabilities).toEqual(NO_CAPABILITIES)
    expect(useRemoteStore.getState().terminals).toEqual([])
  })
})

describe('tearing the whole module down', () => {
  it('forgets the grants along with everything else', async () => {
    seed([STORED])
    await useRemoteStore.getState().boot()
    state('attached')
    await settle()
    session().resolveNext(GRANTS)
    session().resolveNext([])
    await settle()
    expect(useRemoteStore.getState().capabilities.read).toBe(true)

    teardownRemote()

    // A grant is a statement about one desktop. Surviving a teardown, it would
    // become a statement about the next one -- and the screens draw their
    // buttons from exactly this.
    expect(useRemoteStore.getState().capabilities).toEqual(NO_CAPABILITIES)
    expect(useRemoteStore.getState().paired).toBeNull()
    expect(useRemoteStore.getState().terminals).toEqual([])
  })

  it('forgets every desktop and erases every key', async () => {
    // Not reachable from any screen -- Settings unpairs one at a time -- but
    // PRIVACY.md promises that deleting the app destroys the key material, and a
    // test proving it needs something to call.
    seed([STORED, STORED_B])
    await useRemoteStore.getState().boot()

    await forgetEverything()

    expect(mockStorage.wipes).toBe(1)
    expect(mockStorage.book).toEqual([])
    expect(socket().closed).toBe(true)
    const s = useRemoteStore.getState()
    expect(s.pairings).toEqual([])
    expect(s.paired).toBeNull()
    expect(s.safetyPhrase).toBeNull()
  })
})
