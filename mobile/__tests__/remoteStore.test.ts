import type { RelaySocketDeps, RelayState } from '../src/net/relaySocket'
import type { OutputChunk } from '../src/wire/protocol'
import type { PairedDesktop } from '../src/storage/identity'

/** What the desktop answers `getCapabilities` with in these tests. */
const GRANTS = { read: true, createTerminal: true, writeToTerminal: false, closeTerminal: false }

const PHONE_PK = '0faa684ed28867b97f4a6a2dee5df8ce974e76b7018e3f22a1c4cf2678570f20'
const DESKTOP_PK = '7b4e909bbe7ffe44c465a220037d608ee35897d31ef972f07f74892cb0f73f13'

const PAIRED: PairedDesktop = {
  desktopPublicKey: DESKTOP_PK,
  sessionRoomId: 'c9dc49b87f0dc983be61f034ceab7c52',
  relayUrl: 'wss://relay.test',
  deviceId: '12faa049f0ec7720',
  label: 'Termpolis desktop',
  pairedAt: 1_700_000_000_000,
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
  resolveNext: (value: unknown) => void
  output: ((chunks: OutputChunk[]) => void)[]
  status: ((u: unknown) => void)[]
  caps: ((c: unknown) => void)[]
  resets: string[]
  rejectNext: (err: unknown) => void
  frames: unknown[]
}[] = []
const mockAppState: { handlers: ((s: string) => void)[] } = { handlers: [] }
const mockStorage: { paired: PairedDesktop | null; cleared: number; saved: PairedDesktop[] } = {
  paired: null,
  cleared: 0,
  saved: [],
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

    request(req: unknown): Promise<unknown> {
      this.requests.push(req)
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

jest.mock('../src/storage/identity', () => ({
  // Inlined: a jest.mock factory may not reach out-of-scope constants.
  loadIdentity: async () => ({
    secretKey: '22'.repeat(32),
    publicKey: '0faa684ed28867b97f4a6a2dee5df8ce974e76b7018e3f22a1c4cf2678570f20',
  }),
  loadPaired: async () => mockStorage.paired,
  savePaired: async (d: PairedDesktop) => {
    mockStorage.saved.push(d)
    mockStorage.paired = d
  },
  clearPaired: async () => {
    mockStorage.cleared += 1
    mockStorage.paired = null
  },
  wipeIdentity: async () => undefined,
}))

import { AppState } from 'react-native'
import { NO_CAPABILITIES } from '../src/wire/protocol'
import { deriveVerificationPhrase } from '../src/wire/safetyNumber'
import { FOREGROUND_DEBOUNCE_MS, teardownRemote, useRemoteStore } from '../src/state/remoteStore'

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
  return { terminalId: 't1', chunk: 'hello', missed: 0, marker: null, ...over }
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
  mockStorage.paired = null
  mockStorage.cleared = 0
  mockStorage.saved.length = 0
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
    mockStorage.paired = PAIRED
    await useRemoteStore.getState().boot()
    expect(socket().deps.roomId).toBe(PAIRED.sessionRoomId)
    expect(socket().deps.url).toBe(PAIRED.relayUrl)
    expect(socket().connected).toBe(true)
  })

  it('shows the safety phrase for the stored pairing', async () => {
    mockStorage.paired = PAIRED
    await useRemoteStore.getState().boot()
    expect(useRemoteStore.getState().safetyPhrase).toBe(
      deriveVerificationPhrase(PHONE_PK, DESKTOP_PK),
    )
  })

  it('starts stale, because nothing on screen has been confirmed yet', async () => {
    mockStorage.paired = PAIRED
    await useRemoteStore.getState().boot()
    expect(useRemoteStore.getState().stale).toBe(true)
  })

  it('does not open a second socket when called twice', async () => {
    mockStorage.paired = PAIRED
    await useRemoteStore.getState().boot()
    await useRemoteStore.getState().boot()
    expect(mockSockets).toHaveLength(1)
  })
})

describe('pairing from a scanned code', () => {
  const RAW = JSON.stringify({
    v: 1,
    relayUrl: 'wss://relay.test',
    pairingId: '0123456789abcdef0123456789abcdef',
    desktopPublicKey: DESKTOP_PK,
    oneTimeSecret: 'aa'.repeat(32),
  })

  it('refuses a malformed payload without touching storage', async () => {
    await useRemoteStore.getState().pairFromQr('not a qr', 'phone')
    expect(useRemoteStore.getState().error).toMatch(/code/i)
    expect(useRemoteStore.getState().paired).toBeNull()
    expect(mockStorage.saved).toHaveLength(0)
    expect(mockPairing.calls).toHaveLength(0)
  })

  it('stores the pairing and shows its safety phrase', async () => {
    mockPairing.result = { desktop: PAIRED, safetyPhrase: 'hurdle desert ember kelp' }
    await useRemoteStore.getState().pairFromQr(RAW, "David's iPhone")
    expect(mockStorage.saved).toEqual([PAIRED])
    expect(useRemoteStore.getState().paired).toEqual(PAIRED)
    expect(useRemoteStore.getState().safetyPhrase).toBe('hurdle desert ember kelp')
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
    expect(mockStorage.saved).toHaveLength(0)
    expect(useRemoteStore.getState().paired).toBeNull()
  })
})

describe('stale means stale', () => {
  async function attached(): Promise<void> {
    mockStorage.paired = PAIRED
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
    mockStorage.paired = PAIRED
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

  it('keeps the last-known terminals while stale', async () => {
    // Showing nothing would read as "the desktop has no terminals", which is a
    // different and wrong statement.
    mockStorage.paired = PAIRED
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
    mockStorage.paired = PAIRED
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

describe('unpairing', () => {
  it('clears storage, closes the socket, and forgets what was on screen', async () => {
    mockStorage.paired = PAIRED
    await useRemoteStore.getState().boot()
    state('attached')
    await settle()
    session().resolveNext(GRANTS)
    session().resolveNext([{ id: 't1', name: 'Claude', shellType: 'pwsh', cwd: '/repo' }])
    await settle()
    session().output[0]?.([chunk()])
    expect(useRemoteStore.getState().terminals).toHaveLength(1)

    await useRemoteStore.getState().unpair()

    expect(mockStorage.cleared).toBe(1)
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
})

describe('what this phone may do', () => {
  async function attached(): Promise<void> {
    mockStorage.paired = PAIRED
    await useRemoteStore.getState().boot()
    state('attached')
    await settle()
  }

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
    mockStorage.paired = PAIRED
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
    mockStorage.paired = PAIRED
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
    mockStorage.paired = PAIRED
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
    mockStorage.paired = PAIRED
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
    mockStorage.paired = PAIRED
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
    mockStorage.paired = PAIRED
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
    mockStorage.paired = PAIRED
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
})
