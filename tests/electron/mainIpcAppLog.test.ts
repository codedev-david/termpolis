// IPC surface of the v1.39.1 "what is this app actually doing?" features in
// src/main/index.ts: the terminal:clear half of Clear Terminal, and the
// app-log:read / :clear / :path / :append channels behind the in-app log viewer.
//
// Same harness as mainIpcTerminal.test.ts / security.test.ts: `electron` is mocked, every
// ipcMain.handle callback is captured into a Map and every ipcMain.on callback into a list,
// and the assertions are on what the RENDERER can observe -- the envelope returned over IPC,
// or the state visible through a second channel. src/main/appLog is left REAL (only its fs
// seam is faked) because the coercion these handlers delegate -- normalizeLevel, String(),
// the read limit -- is the whole contract under test; mocking it away would assert nothing.
//
// The contracts pinned here:
//   * terminal:clear wipes the RETAINED window but not the stream position. Resetting the
//     position would make every absolute-offset poller (swarm bridge, MCP readers, the phone)
//     see the stream jump backwards and re-deliver output it had already consumed.
//   * ...and it writes NOTHING to the pty. Typing `clear` at a running agent is a message to
//     the agent, not a command to the terminal.
//   * A bad terminalId is an error result, not a silent no-op -- a "clear" that quietly did
//     nothing looks identical to one that worked, right up until the next remount replays
//     the transcript the user thought they had cleared.
//   * app-log:append is `on`, not `handle`, and nothing it is handed can throw: an unknown
//     level and a non-string message both coerce. A logger that can crash turns a cosmetic
//     bug into a dead main process.

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Harness — mirrors tests/electron/security.test.ts
// ---------------------------------------------------------------------------
const ipcHandlers = new Map<string, Function>()
const ipcOnHandlers = new Map<string, Function[]>()

const {
  mockExecSync, mockExecFileSync, mockExecFile,
  mockGetTerminalCwdAsync,
  mockShowOpenDialog, mockShowSaveDialog,
  mockClipboardWriteText, mockClipboardReadText, mockClipboardWrite,
  mockOpenExternal, mockOpenPath,
  mockCreateFromBuffer,
  mockSpawnTerminal, mockKillTerminal, mockWriteToTerminal, mockResizeTerminal,
  mockGetTerminalCwd, mockGetTerminalPid, mockComputeWindowsPty,
  mockDetectAvailableShells,
  mockLoadSession, mockLoadRestoreSession, mockSaveSession,
  mockAppendCommand, mockSearchHistory,
  mockReadConfigFile, mockWriteConfigFile,
  mockListPathEntries, mockListPathCommands, mockListEnvVars,
  mockAppendAudit,
  mockInitAutoUpdater,
  mockWriteFileSync,
} = vi.hoisted(() => ({
  mockExecSync: vi.fn(),
  mockExecFileSync: vi.fn(),
  // execFile (callback style) backs safeGitAsync, which terminal:status now uses so the git branch
  // read doesn't block the main thread. Default: no output, no error.
  mockExecFile: vi.fn((_bin: string, _args: string[], _opts: unknown, cb: (e: Error | null, out: string) => void) => cb(null, '')),
  // getTerminalCwdAsync — the async cwd probe (lsof on mac is slow; the poll must not block main).
  mockGetTerminalCwdAsync: vi.fn(async () => ''),
  mockShowOpenDialog: vi.fn(),
  mockShowSaveDialog: vi.fn(),
  mockClipboardWriteText: vi.fn(),
  mockClipboardReadText: vi.fn(() => ''),
  mockClipboardWrite: vi.fn(),
  mockOpenExternal: vi.fn(async () => undefined),
  mockOpenPath: vi.fn(async () => ''),
  mockCreateFromBuffer: vi.fn(() => ({ isEmpty: () => true })),
  mockSpawnTerminal: vi.fn(),
  mockKillTerminal: vi.fn(),
  mockWriteToTerminal: vi.fn(),
  mockResizeTerminal: vi.fn(),
  mockGetTerminalCwd: vi.fn(() => ''),
  mockGetTerminalPid: vi.fn(() => 0),
  mockComputeWindowsPty: vi.fn(() => ({ backend: 'conpty', buildNumber: 22631 })),
  mockDetectAvailableShells: vi.fn(async () => [] as Array<{ type: string; executable: string; name?: string }>),
  mockLoadSession: vi.fn(() => ({ terminals: [] })),
  mockLoadRestoreSession: vi.fn(() => ({ terminals: [] })),
  mockSaveSession: vi.fn(),
  mockAppendCommand: vi.fn(),
  mockSearchHistory: vi.fn(() => [] as unknown[]),
  mockReadConfigFile: vi.fn(() => ''),
  mockWriteConfigFile: vi.fn(),
  mockListPathEntries: vi.fn(() => [] as unknown[]),
  mockListPathCommands: vi.fn(() => [] as unknown[]),
  mockListEnvVars: vi.fn(() => [] as unknown[]),
  mockAppendAudit: vi.fn(async () => undefined),
  mockInitAutoUpdater: vi.fn(),
  mockWriteFileSync: vi.fn(),
}))

const mockWebContents = {
  send: vi.fn(),
  executeJavaScript: vi.fn(),
  session: {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
  },
}
// Listener registrations must survive vi.clearAllMocks() — createWindow runs once at
// startup, long before any beforeEach, so a mock.calls-based lookup would come up empty.
const winOnHandlers = new Map<string, Function[]>()
const mockMainWindow = {
  minimize: vi.fn(), maximize: vi.fn(), unmaximize: vi.fn(),
  isMaximized: vi.fn(() => false), isMinimized: vi.fn(() => false),
  restore: vi.fn(), focus: vi.fn(), close: vi.fn(),
  on: vi.fn((ev: string, h: Function) => {
    const list = winOnHandlers.get(ev) ?? []
    list.push(h)
    winOnHandlers.set(ev, list)
  }),
  setIcon: vi.fn(),
  loadURL: vi.fn(), loadFile: vi.fn(), webContents: mockWebContents,
}
// Captures the options object each BrowserWindow is constructed with, so the
// icon / titleBarStyle decisions inside createWindow are observable.
const browserWindowOpts: any[] = []
function MockBrowserWindow(opts: any) { browserWindowOpts.push(opts); return mockMainWindow }
MockBrowserWindow.prototype = {}

const appOnHandlers = new Map<string, Function>()

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => require('os').tmpdir()),
    getVersion: vi.fn(() => '9.9.9'),
    whenReady: () => Promise.resolve(),
    requestSingleInstanceLock: () => true,
    setName: vi.fn(),
    setAppUserModelId: vi.fn(),
    disableHardwareAcceleration: vi.fn(),
    on: vi.fn((ev: string, h: Function) => { appOnHandlers.set(ev, h) }),
    commandLine: { appendSwitch: vi.fn() },
    isPackaged: false,
    quit: vi.fn(),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: Function) => { ipcHandlers.set(channel, handler) }),
    // createWindow() re-registers app:force-close on every call, so keep every
    // registration — the tests below always drive the most recent one.
    on: vi.fn((channel: string, handler: Function) => {
      const list = ipcOnHandlers.get(channel) ?? []
      list.push(handler)
      ipcOnHandlers.set(channel, list)
    }),
  },
  BrowserWindow: MockBrowserWindow,
  clipboard: {
    writeText: mockClipboardWriteText,
    readText: mockClipboardReadText,
    write: mockClipboardWrite,
  },
  dialog: {
    showSaveDialog: mockShowSaveDialog,
    showOpenDialog: mockShowOpenDialog,
    showMessageBox: vi.fn(async () => ({ response: 0, checkboxChecked: false })),
  },
  Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn(() => ({})) },
  nativeImage: { createFromPath: vi.fn(() => ({})), createFromBuffer: mockCreateFromBuffer },
  globalShortcut: { register: vi.fn(), unregisterAll: vi.fn() },
  shell: { openExternal: mockOpenExternal, openPath: mockOpenPath },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8'),
  },
}))

vi.mock('../../src/main/sentry', () => ({ initMainSentry: vi.fn() }))
vi.mock('../../src/main/terminalManager', () => ({
  spawnTerminal: mockSpawnTerminal,
  killTerminal: mockKillTerminal,
  writeToTerminal: mockWriteToTerminal,
  resizeTerminal: mockResizeTerminal,
  killAll: vi.fn(),
  getTerminalCwd: mockGetTerminalCwd,
  getTerminalCwdAsync: mockGetTerminalCwdAsync,
  getTerminalPid: mockGetTerminalPid,
  computeWindowsPty: mockComputeWindowsPty,
}))
vi.mock('../../src/main/shellDetector', () => ({ detectAvailableShells: mockDetectAvailableShells }))
vi.mock('../../src/main/sessionStore', () => ({ loadSession: mockLoadSession, loadRestoreSession: mockLoadRestoreSession, saveSession: mockSaveSession }))
vi.mock('../../src/main/historyStore', () => ({ appendCommand: mockAppendCommand, searchHistory: mockSearchHistory }))
vi.mock('../../src/main/configFileManager', () => ({ readConfigFile: mockReadConfigFile, writeConfigFile: mockWriteConfigFile }))
vi.mock('../../src/main/completionService', () => ({
  listPathEntries: mockListPathEntries,
  listPathCommands: mockListPathCommands,
  listEnvVars: mockListEnvVars,
}))

// aiSecurity stays REAL — terminal:write's whole value is that it runs the genuine
// secret scanner / code-chunk / env-dump detectors. Only the audit sink is swapped for
// a spy, because "what did we write to the audit log" is precisely what we need to
// assert on (and precisely where a secret must never appear).
vi.mock('../../src/main/aiSecurity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/aiSecurity')>()
  return { ...actual, appendAudit: mockAppendAudit }
})

vi.mock('../../src/main/mcpServer', () => ({
  startMcpServer: vi.fn(), stopMcpServer: vi.fn(),
  getMcpAuthToken: vi.fn(() => 'fake-token'), getMcpPort: vi.fn(() => 9315),
  initAuditLog: vi.fn(),
  awaitMcpPortBound: vi.fn(() => Promise.resolve(9315)),
}))
vi.mock('../../src/main/swarmManager', () => ({
  sendMessage: vi.fn(), readMessages: vi.fn(() => []), getAllMessages: vi.fn(() => []),
  createTask: vi.fn(), listTasks: vi.fn(() => []), updateTask: vi.fn(), clearSwarm: vi.fn(),
}))
vi.mock('../../src/main/agentEventBus', () => ({
  initEventBus: vi.fn(), query: vi.fn(() => []), subscribe: vi.fn(), publish: vi.fn(),
  getRingSize: vi.fn(() => 0), getDroppedCount: vi.fn(() => 0), shutdownEventBus: vi.fn(),
}))
vi.mock('../../src/main/transcriptWatchers', () => ({
  attachWatcher: vi.fn(), detachWatchers: vi.fn(), detachAll: vi.fn(),
}))
vi.mock('../../src/main/contextPinStore', () => ({
  initContextPinStore: vi.fn(),
  listPins: vi.fn(() => []), addPin: vi.fn(), removePin: vi.fn(),
  updatePin: vi.fn(), clearPins: vi.fn(),
}))
vi.mock('../../src/main/swarmMemory', () => ({
  initSwarmMemory: vi.fn(),
  memoryWrite: vi.fn(), memorySearch: vi.fn(() => []),
  memoryList: vi.fn(() => []), memoryCount: vi.fn(() => 0), memoryClear: vi.fn(),
  normalizeProjectSlug: vi.fn((p: string) => (p || '').split(/[\\/]/).filter(Boolean).pop() || ''),
  setMemoryScrubber: vi.fn(),
}))

// v1.26 — index.ts reaches the store through memoryClient (the brain lives in a utilityProcess now).
// Every proxied call is a Promise there, so the mock is async too; the pure helpers stay sync.
// Vitest's factory mock THROWS on access to a name it does not define, so this must cover every
// export index.ts touches — including the lifecycle it calls in app.whenReady().
vi.mock('../../src/main/memoryClient', () => ({
  startMemoryHost: vi.fn(async () => 'host'),
  setMemoryHostSpawner: vi.fn(),
  createMemoryHostTransport: vi.fn(),
  stopMemoryHost: vi.fn(),
  memoryHostMode: vi.fn(() => 'host'),
  setMemoryScrubber: vi.fn(),
  memoryWrite: vi.fn(async () => ({ id: 'm1' })),
  memorySearch: vi.fn(async () => []),
  memoryRelated: vi.fn(async () => []),
  memoryLink: vi.fn(async () => ({ ok: true })),
  memoryGraphQuery: vi.fn(async () => []),
  memoryFeedback: vi.fn(async () => ({ ok: true })),
  memoryList: vi.fn(async () => []),
  memoryCount: vi.fn(async () => 0),
  memoryClear: vi.fn(async () => {}),
  memoryKnownHashes: vi.fn(async () => [] as string[]),
  memoryStats: vi.fn(async () => ({ count: 0 })),
  memoryDashboardStats: vi.fn(async () => ({ total: 0 })),
  memoryGraphSample: vi.fn(async () => ({ nodes: [], edges: [] })),
  memoryRecentActivity: vi.fn(async () => []),
  embeddingsReady: vi.fn(async () => false),
  memorySourceById: vi.fn(async () => undefined),
  memoryDelete: vi.fn(async () => {}),
  consolidationCandidates: vi.fn(async () => []),
  consolidationSimOf: vi.fn(async () => () => 0),
  memoryPatchProjects: vi.fn(async () => 0),
  memoryLessons: vi.fn(async () => []),
  memoryPruneCodePath: vi.fn(async () => 0),
  warmProbeEmbeddings: vi.fn(async () => true),
  compactSelfShard: vi.fn(async () => ({ compacted: false, before: 0, after: 0 })),
  weaveCandidates: vi.fn(async () => []),
  weaveNeighbours: vi.fn(async () => []),
  weaveNeighboursBatch: vi.fn(async () => ({})),
  backfillCodeRefs: vi.fn(async () => {}),
  symbolHistory: vi.fn(async () => []),
  memoryArchive: vi.fn(async () => {}),
  searchArchive: vi.fn(async () => []),
  getSyncStatus: vi.fn(async () => ({ syncing: false })),
  setSyncDir: vi.fn(async () => ({ syncing: false })),
  reloadMemoryFromSync: vi.fn(async () => {}),
  setSyncPassphrase: vi.fn(async () => ({ encrypted: true })),
  disableSyncEncryption: vi.fn(async () => ({ encrypted: false })),
  enableLocalEncryption: vi.fn(async () => ({ encrypted: true })),
  disableEncryption: vi.fn(async () => ({ encrypted: false })),
  persistMemoryIndex: vi.fn(async () => {}),
  vectorRamStats: vi.fn(async () => ({ vectors: 0, dim: 384, quantized: false, ramBytes: 0, ramBytesFloat: 0, ramBytesInt8: 0 })),
  setVectorQuantization: vi.fn(async () => ({ vectors: 0, dim: 384, quantized: false, ramBytes: 0, ramBytesFloat: 0, ramBytesInt8: 0 })),
  exportMemorySnapshot: vi.fn(async () => ''),
  importMemorySnapshot: vi.fn(async () => ({ imported: 0 })),
  // pure helpers — SYNC, exactly as memoryClient re-exports them from swarmMemory
  normalizeProjectSlug: vi.fn((p: string) => (p || '').split(/[\/]/).filter(Boolean).pop()?.toLowerCase() || ''),
  projectKeyOf: vi.fn((p: string) => `pk:${p}`),
  entityDedupHash: vi.fn((n: string, k?: string) => `edh:${n}:${k ?? ''}`),
  contentHash: vi.fn((c: string) => `h:${c}`),
  canonicalEntityName: vi.fn((n: string) => n.trim()),
}))
vi.mock('../../src/main/autoUpdater', () => ({ initAutoUpdater: mockInitAutoUpdater }))
vi.mock('../../src/main/agentCommandSanitizer', () => ({
  sanitizeAgentCommand: vi.fn((cmd: string) => cmd),
}))

vi.mock('child_process', () => ({
  default: { execSync: mockExecSync, execFileSync: mockExecFileSync, execFile: mockExecFile },
  execSync: mockExecSync,
  execFileSync: mockExecFileSync,
  execFile: mockExecFile,
}))

vi.mock('fs', () => {
  const impl = {
    writeFileSync: mockWriteFileSync, existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => '{}'), readdirSync: vi.fn(() => []),
    statSync: vi.fn(() => ({ isDirectory: () => false, mtimeMs: 0, size: 0 })),
    mkdirSync: vi.fn(), appendFileSync: vi.fn(),
    renameSync: vi.fn(), unlinkSync: vi.fn(), watch: vi.fn(),
  }
  return { ...impl, default: impl }
})

vi.mock('uuid', () => ({ v4: vi.fn(() => 'mock-uuid') }))
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function invoke(channel: string, args: any = {}): any {
  const handler = ipcHandlers.get(channel)
  if (!handler) throw new Error(`No handler for ${channel}`)
  return handler({}, args)
}
/** ipcMain.on handlers aren't in the handle Map -- take the most recent registration. */
function fire(channel: string, ...args: any[]): any {
  const list = ipcOnHandlers.get(channel)
  if (!list?.length) throw new Error(`No ipcMain.on handler for ${channel}`)
  return list[list.length - 1]({}, ...args)
}

// The real appLog module instance index.ts is bound to (same post-resetModules registry).
let appLog: typeof import('../../src/main/appLog')
/** Lines the log queued to disk. initAppLog's `fs` seam exists so the file half can be
 *  observed without a real write -- these tests would otherwise append to os.tmpdir(). */
let written: string[] = []
/** Only the lines that came from the renderer. index.ts mirrors its OWN console into the
 *  same log, so counting raw appends would make these assertions depend on whether some
 *  unrelated main-process code happened to print during the test. */
const rendererLines = (): string[] => written.filter((l) => l.includes('[renderer]'))
const fakeFs = {
  appendFile: async (_p: string, data: string) => { written.push(data) },
  rename: async () => undefined,
  stat: async () => ({ size: 0 }),
}
/** logToApp queues the file write on a promise chain; let it drain before asserting. */
const flushLog = (): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, 0))

let uid = 0
const newId = (p: string): string => `${p}-${++uid}`

/** Spawn a terminal and hand back the onData pump terminal:create wired to the pty. */
async function spawnWithPump(id: string): Promise<(data: string) => void> {
  mockDetectAvailableShells.mockResolvedValue([{ type: 'bash', executable: '/bin/bash' }])
  await invoke('terminal:create', { id, shellType: 'bash' })
  return mockSpawnTerminal.mock.calls.at(-1)![3] as (d: string) => void
}

const LOG_DIR = require('os').tmpdir()
const LOG_PATH = require('path').join(LOG_DIR, 'app.log')

beforeAll(async () => {
  vi.resetModules()
  await import('../../src/main/index')
  appLog = await import('../../src/main/appLog')
  await new Promise((resolve) => setTimeout(resolve, 50))
  // Re-point the log at the same directory whenReady chose, but through the fake fs, so the
  // file half is observable and these tests never actually write into the temp directory.
  appLog.initAppLog(LOG_DIR, { fs: fakeFs })
})

beforeEach(async () => {
  vi.clearAllMocks()
  mockExecFileSync.mockReturnValue(Buffer.from(''))
  mockCreateFromBuffer.mockReturnValue({ isEmpty: () => true })
  mockDetectAvailableShells.mockResolvedValue([])
  mockAppendAudit.mockImplementation(async () => undefined)
  written = []
  await invoke('app-log:clear')   // every ring assertion below counts from empty
})

// ===========================================================================
// terminal:clear -- the main-side half of Clear Terminal.
// ===========================================================================
describe('terminal:clear IPC', () => {
  it('drops the retained transcript so a remount cannot replay it', async () => {
    // The renderer clears xterm itself; this is the half that makes it STICK.
    // TerminalPane replays this window into a fresh xterm on every mount, so without the
    // main-side wipe a tab switch or a split re-layout resurrects everything the user just
    // cleared -- which is worse than not offering a clear at all.
    const id = newId('clear')
    const onData = await spawnWithPump(id)
    onData('hello world')
    expect((await invoke('terminal:read-buffer', { terminalId: id })).data.output).toBe('hello world')

    expect(await invoke('terminal:clear', { terminalId: id })).toEqual({ success: true, data: undefined })
    expect((await invoke('terminal:read-buffer', { terminalId: id })).data.output).toBe('')
  })

  it('keeps the ABSOLUTE stream position, reporting the wipe as missed output', async () => {
    // `total` deliberately survives the clear. Every consumer of this stream (the swarm
    // bridge, MCP read_output, the phone's output pump) holds an absolute offset, and
    // resetting it to 0 would make each of them see the stream jump BACKWARDS -- which
    // reads as a restarted terminal reusing an id and re-delivers consumed output. The
    // cleared bytes surface as `missed` instead, so a poller learns it lost them.
    const id = newId('clear')
    const onData = await spawnWithPump(id)
    onData('hello world')
    await invoke('terminal:clear', { terminalId: id })

    expect((await invoke('terminal:read-buffer', { terminalId: id })).data).toEqual({
      output: '', length: 0, nextOffset: 11, missed: 11,
    })
  })

  it('writes NOTHING to the pty -- a clear is a display action, not a command', async () => {
    // Sending a `clear` command would be a message to whatever is running rather than a
    // command to the terminal: at a Claude Code prompt it types the word into the agent.
    const id = newId('clear')
    const onData = await spawnWithPump(id)
    onData('output')
    mockWriteToTerminal.mockClear()

    await invoke('terminal:clear', { terminalId: id })
    expect(mockWriteToTerminal).not.toHaveBeenCalled()
  })

  it('rejects a missing terminalId and leaves every buffer intact', async () => {
    // A clear that silently did nothing is indistinguishable from one that worked -- until
    // the next remount replays the transcript. The renderer needs to be told.
    const id = newId('clear')
    const onData = await spawnWithPump(id)
    onData('still here')

    expect(await invoke('terminal:clear', {})).toEqual({ success: false, error: 'terminalId required' })
    expect((await invoke('terminal:read-buffer', { terminalId: id })).data.output).toBe('still here')
  })

  it('rejects a non-string terminalId and leaves every buffer intact', async () => {
    const id = newId('clear')
    const onData = await spawnWithPump(id)
    onData('still here')

    expect(await invoke('terminal:clear', { terminalId: 42 })).toEqual({
      success: false, error: 'terminalId required',
    })
    expect((await invoke('terminal:read-buffer', { terminalId: id })).data.output).toBe('still here')
  })

  it('rejects an EMPTY terminalId, which passes the typeof half of the guard', async () => {
    // '' is a string, so `typeof terminalId !== 'string'` waves it straight through; the
    // `!terminalId` half is the only thing that stops a default-initialised renderer state
    // from clearing nothing and being told it succeeded.
    const id = newId('clear')
    const onData = await spawnWithPump(id)
    onData('still here')

    expect(await invoke('terminal:clear', { terminalId: '' })).toEqual({
      success: false, error: 'terminalId required',
    })
    expect((await invoke('terminal:read-buffer', { terminalId: id })).data.output).toBe('still here')
  })

  it('answers ok for a terminal that never existed', async () => {
    // Clearing an unknown id is not an error: a pane can close between the keystroke and
    // the IPC arriving, and surfacing that race as a failure would be pure noise.
    expect(await invoke('terminal:clear', { terminalId: 'never-spawned' })).toEqual({
      success: true, data: undefined,
    })
  })
})

// ===========================================================================
// app-log:read / :clear / :path -- what the in-app log viewer reads.
// ===========================================================================
describe('app-log read/clear/path IPC', () => {
  /** Put `n` known lines in the ring through the same path the renderer uses. */
  function seed(n: number): void {
    for (let i = 1; i <= n; i++) fire('app-log:append', { level: 'info', message: `line-${i}` })
  }

  it('returns the ring oldest-first with the file path beside it', async () => {
    // The viewer needs both in one round trip: the entries to render, and the path for its
    // "the file is here" affordance -- the file is the half that survives a crash.
    seed(3)
    const { success, data } = await invoke('app-log:read', { limit: 500 })
    expect(success).toBe(true)
    expect(data.path).toBe(LOG_PATH)
    expect(data.entries.map((e: any) => e.msg)).toEqual(['line-1', 'line-2', 'line-3'])
    expect(data.entries.every((e: any) => e.source === 'renderer' && e.level === 'info')).toBe(true)
  })

  it('honours an explicit limit and keeps the NEWEST lines', async () => {
    // A truncating log viewer that kept the OLDEST lines would show the user startup noise
    // and hide the thing that just went wrong.
    seed(5)
    const { data } = await invoke('app-log:read', { limit: 2 })
    expect(data.entries.map((e: any) => e.msg)).toEqual(['line-4', 'line-5'])
  })

  it('defaults the limit when the payload omits it', async () => {
    seed(4)
    const { data } = await invoke('app-log:read', {})
    expect(data.entries).toHaveLength(4)
  })

  it('defaults the limit when there is no payload at all', async () => {
    // preload's readAppLog() takes an OPTIONAL limit, so `{ limit: undefined }` is a real
    // wire shape; `args?.limit` also has to survive a caller that sends nothing.
    seed(4)
    expect((await invoke('app-log:read', undefined)).data.entries).toHaveLength(4)
    expect((await invoke('app-log:read', null)).data.entries).toHaveLength(4)
  })

  it('defaults the limit when it arrives as a non-number', async () => {
    // A typeof check, not a truthiness check: the string '2' would otherwise reach
    // Math.floor and silently truncate the viewer to two lines.
    seed(4)
    const { data } = await invoke('app-log:read', { limit: '2' })
    expect(data.entries).toHaveLength(4)
  })

  it('app-log:clear empties the ring', async () => {
    seed(3)
    expect(await invoke('app-log:clear')).toEqual({ success: true, data: undefined })
    expect((await invoke('app-log:read', { limit: 500 })).data.entries).toEqual([])
  })

  it('app-log:clear does NOT touch the file -- the file is the crash evidence', async () => {
    // "Clear the view" must not destroy the only record of what happened before it.
    seed(1)
    await flushLog()
    const before = rendererLines().length
    expect(before).toBeGreaterThan(0)

    await invoke('app-log:clear')
    await flushLog()
    expect(rendererLines()).toHaveLength(before)
  })

  it('app-log:path answers the path directly, not wrapped in another object', async () => {
    // The renderer hands this straight to a "show in folder" action, so the envelope's
    // `data` has to BE the path.
    expect(await invoke('app-log:path')).toEqual({ success: true, data: LOG_PATH })
  })
})

// ===========================================================================
// app-log:append -- renderer console lines, fire-and-forget.
// ===========================================================================
describe('app-log:append IPC', () => {
  const lastEntry = async (): Promise<any> => {
    const { data } = await invoke('app-log:read', { limit: 500 })
    return data.entries.at(-1)
  }

  it('is registered with ipcMain.on, never ipcMain.handle', async () => {
    // Every console.* in the renderer funnels through this channel. As a `handle` it would
    // put an IPC round trip inside every log line in the app; nothing awaits a log line.
    expect(ipcOnHandlers.has('app-log:append')).toBe(true)
    expect(ipcHandlers.has('app-log:append')).toBe(false)
  })

  it('records the line at the level the renderer gave, tagged as renderer', async () => {
    // `source` is what lets the viewer tell "main decided something" from "the UI printed
    // something" -- the two failure stories read completely differently.
    fire('app-log:append', { level: 'error', message: 'boom' })
    expect(await lastEntry()).toMatchObject({ level: 'error', source: 'renderer', msg: 'boom' })
  })

  it('coerces an unknown level to log instead of trusting the renderer', async () => {
    // normalizeLevel is the trust boundary: the level arrives over IPC and then picks a
    // console method and a viewer colour, so an arbitrary string must reach neither.
    fire('app-log:append', { level: 'FATAL', message: 'odd level' })
    expect(await lastEntry()).toMatchObject({ level: 'log', msg: 'odd level' })
  })

  it('coerces a missing level to log', async () => {
    fire('app-log:append', { message: 'no level' })
    expect(await lastEntry()).toMatchObject({ level: 'log', msg: 'no level' })
  })

  it('coerces a non-string message with String() rather than dropping it', async () => {
    // A renderer that logs a number or an object still deserves a line. Dropping it would
    // make the viewer lie by omission at exactly the moment someone is reading it.
    fire('app-log:append', { level: 'warn', message: 42 })
    expect(await lastEntry()).toMatchObject({ level: 'warn', msg: '42' })

    fire('app-log:append', { level: 'warn', message: { code: 'EPERM' } })
    expect(await lastEntry()).toMatchObject({ msg: '[object Object]' })
  })

  it('turns a missing message into an empty line, not the word "undefined"', async () => {
    // String(undefined) is 'undefined' -- the `?? ''` is what keeps a malformed payload from
    // writing a line that reads like a real log message about nothing.
    fire('app-log:append', { level: 'info' })
    expect(await lastEntry()).toMatchObject({ level: 'info', msg: '' })
  })

  it('survives a payload that is entirely absent', async () => {
    // ipcRenderer.send with no second argument delivers undefined. The optional chaining is
    // the difference between an empty log line and a TypeError in the main process.
    expect(() => fire('app-log:append', undefined)).not.toThrow()
    expect(await lastEntry()).toMatchObject({ level: 'log', source: 'renderer', msg: '' })
  })

  it('mirrors the COERCED line to the log file, not the raw payload', async () => {
    // The ring is for the viewer; the file is what a user attaches to a bug report. Both
    // have to show the same coerced line, or the report contradicts what the user saw.
    fire('app-log:append', { level: 'BOGUS', message: 7 })
    await flushLog()
    const lines = rendererLines()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('[LOG]')
    expect(lines[0].trimEnd().endsWith('7')).toBe(true)
  })
})
