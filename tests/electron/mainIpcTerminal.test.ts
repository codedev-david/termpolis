// IPC surface of the Electron main entry: TERMINAL, CLIPBOARD, SHELL, SESSION,
// CONFIG, HISTORY, COMPLETION, FS, DIALOG — plus the window lifecycle that owns them.
//
// src/main/index.ts registers ~100 ipcMain callbacks and almost nothing invokes them,
// so the error paths, the `?? fallback` arms and the guard clauses inside them have
// never run. This suite drives them directly through the same mocked-`electron`
// harness security.test.ts uses (every ipcMain.handle is captured into a Map;
// ipcMain.on handlers are pulled off the mock), and asserts on what the caller can
// actually observe: the value returned to the renderer, the args a mocked dependency
// was called with, the event pushed down `webContents.send`, or a state transition
// visible through a second channel.
//
// The load-bearing contracts pinned here:
//   * terminal:write ALWAYS forwards the user's bytes verbatim (v1.25 dropped outbound
//     redaction because it ate keystrokes) — watching must never withhold.
//   * ...except strict-mode Gemini, which is the ONE interception, and it must happen
//     BEFORE the bytes reach the PTY.
//   * When a secret IS observed, neither the audit log nor the renderer event may carry
//     the secret's VALUE — only the rule id / label / variable name. `hit.sample` spans
//     the whole `DB_PASSWORD=hunter2` assignment, so shipping it would leak the
//     credential into a devtools console and every future component that renders a hit.
//   * The agents-running close guard must not cancel an update restart.

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'

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
/** ipcMain.on handlers aren't in the handle Map — take the most recent registration. */
function fire(channel: string, ...args: any[]): any {
  const list = ipcOnHandlers.get(channel)
  if (!list?.length) throw new Error(`No ipcMain.on handler for ${channel}`)
  return list[list.length - 1]({}, ...args)
}
/** The listeners createWindow attaches to the BrowserWindow instance (most recent wins). */
function windowListener(event: string): Function {
  const list = winOnHandlers.get(event)
  if (!list?.length) throw new Error(`No window listener for ${event}`)
  return list[list.length - 1]
}
/** Re-run createWindow via the `activate` lifecycle hook (fires only when mainWindow is null). */
function recreateWindow(): void {
  windowListener('closed')()                    // mainWindow = null
  appOnHandlers.get('activate')!()              // if (!mainWindow) createWindow()
}
const auditEvents = (): any[] => mockAppendAudit.mock.calls.map((c: any[]) => c[0])
const sentEvents = (channel: string): any[] =>
  mockWebContents.send.mock.calls.filter((c: any[]) => c[0] === channel).map((c: any[]) => c[1])

// The real aiSecurity module instance that index.ts is bound to (resolved from the
// same post-resetModules registry, so settings mutations are actually shared).
let aiSec: typeof import('../../src/main/aiSecurity')
// initAutoUpdater is called ONCE at whenReady — captured here because vi.clearAllMocks()
// in beforeEach would otherwise erase the only record of its callbacks.
let updaterOpts: { onBeforeQuitAndInstall: () => void }

let uid = 0
const newId = (p: string) => `${p}-${++uid}`
/** Flag a terminal as an AI session (what gates the outbound watcher) and clear the audit spy. */
function asAiTerminal(id: string): void {
  fire('terminal:write', { id, data: 'claude\r' })
  mockAppendAudit.mockClear()
  mockWriteToTerminal.mockClear()
  mockWebContents.send.mockClear()
}

// Repeated characters keep these below entropy heuristics (so GitHub push protection
// doesn't reject this file) while still matching the rule regexes.
const AWS_KEY = 'AKIA' + 'A'.repeat(16)          // rule aws_access_key — has NO nameGroup
const NAMED_SECRET = 'DB_PASSWORD=' + 'a'.repeat(12) // rule env_secret — nameGroup 1 => "DB_PASSWORD"
const SECRET_VALUE = 'a'.repeat(12)

beforeAll(async () => {
  vi.resetModules()
  await import('../../src/main/index')
  aiSec = await import('../../src/main/aiSecurity')
  await new Promise((resolve) => setTimeout(resolve, 50))
  updaterOpts = mockInitAutoUpdater.mock.calls[0][1] as typeof updaterOpts
})

beforeEach(() => {
  vi.clearAllMocks()   // clears call history only — implementations are restored explicitly
  mockExecFileSync.mockReturnValue(Buffer.from(''))
  mockCreateFromBuffer.mockReturnValue({ isEmpty: () => true })
  mockOpenPath.mockResolvedValue('')
  mockClipboardReadText.mockReturnValue('')
  mockDetectAvailableShells.mockResolvedValue([])
  mockAppendAudit.mockImplementation(async () => undefined)
})

// ===========================================================================
// CLIPBOARD — main-process clipboard (the renderer's navigator.clipboard is
// focus-gated and silently no-ops from a context menu).
// ===========================================================================
describe('clipboard IPC', () => {
  it('clipboard:write-text writes the supplied string', async () => {
    const r = await invoke('clipboard:write-text', { text: 'hello world' })
    expect(r).toEqual({ success: true, data: undefined })
    expect(mockClipboardWriteText).toHaveBeenCalledWith('hello world')
  })

  it('clipboard:write-text coerces a non-string to empty rather than crashing the clipboard', async () => {
    // clipboard.writeText(undefined) throws in real Electron — the typeof guard is what
    // keeps a malformed renderer payload from taking down the main process.
    await invoke('clipboard:write-text', {})
    await invoke('clipboard:write-text', { text: 42 as unknown as string })
    expect(mockClipboardWriteText).toHaveBeenNthCalledWith(1, '')
    expect(mockClipboardWriteText).toHaveBeenNthCalledWith(2, '')
  })

  it('clipboard:read-text returns whatever the OS clipboard holds', async () => {
    mockClipboardReadText.mockReturnValue('pasted text')
    expect(await invoke('clipboard:read-text')).toEqual({ success: true, data: 'pasted text' })
  })

  it('clipboard:write-rich writes both flavours (Copy for Teams pastes as a normal message)', async () => {
    const r = await invoke('clipboard:write-rich', { text: 'plain', html: '<p>rich</p>' })
    expect(r.success).toBe(true)
    expect(mockClipboardWrite).toHaveBeenCalledWith({ text: 'plain', html: '<p>rich</p>' })
  })

  it('clipboard:write-rich defaults each missing flavour to empty string', async () => {
    await invoke('clipboard:write-rich', {})
    expect(mockClipboardWrite).toHaveBeenCalledWith({ text: '', html: '' })
  })
})

// ===========================================================================
// terminal:create
// ===========================================================================
describe('terminal:create', () => {
  const SHELLS = [
    { type: 'bash', executable: '/bin/bash' },
    { type: 'pwsh', executable: 'pwsh.exe' },
  ]

  it('spawns the requested shell type', async () => {
    mockDetectAvailableShells.mockResolvedValue(SHELLS)
    const r = await invoke('terminal:create', { id: 't-create-1', shellType: 'pwsh', cwd: '/work' })
    expect(r).toEqual({ success: true, data: undefined })
    const [id, exe, cwd] = mockSpawnTerminal.mock.calls[0]
    expect(id).toBe('t-create-1')
    expect(exe).toBe('pwsh.exe')
    expect(cwd).toBe('/work')
  })

  it('falls back to the first available shell when the requested type is unknown', async () => {
    mockDetectAvailableShells.mockResolvedValue(SHELLS)
    const r = await invoke('terminal:create', { id: 't-create-2', shellType: 'fish', cwd: '/w' })
    expect(r.success).toBe(true)
    expect(mockSpawnTerminal.mock.calls[0][1]).toBe('/bin/bash')
  })

  it('rejects when the machine has no usable shell, without spawning anything', async () => {
    mockDetectAvailableShells.mockResolvedValue([])
    const r = await invoke('terminal:create', { id: 't-create-3', shellType: 'bash' })
    expect(r).toEqual({ success: false, error: 'No shell available' })
    expect(mockSpawnTerminal).not.toHaveBeenCalled()
  })

  it('appends renderer-supplied extraPaths after the auto-discovered agent paths', async () => {
    mockDetectAvailableShells.mockResolvedValue(SHELLS)
    await invoke('terminal:create', { id: 't-create-4', shellType: 'bash', cwd: '/w', extraPaths: ['/opt/custom/bin'] })
    const extraPaths = mockSpawnTerminal.mock.calls[0][4] as string[]
    expect(extraPaths).toContain('/opt/custom/bin')
    // caller-supplied entries come last so they can't shadow the agent binaries we found
    expect(extraPaths[extraPaths.length - 1]).toBe('/opt/custom/bin')
  })

  it('surfaces a spawn failure to the renderer as {success:false,error}', async () => {
    mockDetectAvailableShells.mockResolvedValue(SHELLS)
    mockSpawnTerminal.mockImplementationOnce(() => { throw new Error('ENOENT: node-pty missing') })
    const r = await invoke('terminal:create', { id: 't-create-5', shellType: 'bash' })
    expect(r).toEqual({ success: false, error: 'ENOENT: node-pty missing' })
  })

  it('falls back to a generic message when the thrown value carries no .message', async () => {
    mockDetectAvailableShells.mockResolvedValue(SHELLS)
    mockSpawnTerminal.mockImplementationOnce(() => { throw { code: 'EPERM' } })
    const r = await invoke('terminal:create', { id: 't-create-6', shellType: 'bash' })
    expect(r).toEqual({ success: false, error: 'Failed to create terminal' })
  })
})

// ===========================================================================
// The PTY data pump: terminal:create's onData -> renderer + the MCP read buffer.
// ===========================================================================
describe('terminal output buffering (terminal:create onData -> terminal:read-buffer)', () => {
  async function spawnWithPump(id: string): Promise<(data: string) => void> {
    mockDetectAvailableShells.mockResolvedValue([{ type: 'bash', executable: '/bin/bash' }])
    await invoke('terminal:create', { id, shellType: 'bash' })
    return mockSpawnTerminal.mock.calls.at(-1)![3] as (d: string) => void
  }

  it('forwards each chunk to the renderer and accumulates it for MCP read_output', async () => {
    const id = 'buf-1'
    const onData = await spawnWithPump(id)
    onData('hello ')
    onData('world')

    expect(mockWebContents.send).toHaveBeenCalledWith('terminal:data', id, 'hello ')
    expect(mockWebContents.send).toHaveBeenCalledWith('terminal:data', id, 'world')
    expect(await invoke('terminal:read-buffer', { terminalId: id })).toEqual({
      success: true,
      data: { output: 'hello world', length: 11 },
    })
  })

  it('reads from an offset so a poller only gets what is new', async () => {
    const id = 'buf-2'
    const onData = await spawnWithPump(id)
    onData('abcdef')
    expect(await invoke('terminal:read-buffer', { terminalId: id, fromOffset: 3 })).toEqual({
      success: true, data: { output: 'def', length: 3 },
    })
  })

  it('caps the buffer at 32 KB, keeping the TAIL (a long build must not evict the error at the end)', async () => {
    const id = 'buf-3'
    const onData = await spawnWithPump(id)
    onData('x'.repeat(32768))
    onData('TAIL-MARKER')
    const { data } = await invoke('terminal:read-buffer', { terminalId: id })
    expect(data.length).toBe(32768)
    expect(data.output.endsWith('TAIL-MARKER')).toBe(true)
    expect(data.output.startsWith('x')).toBe(true)
  })

  it('returns an empty buffer for a terminal that never existed', async () => {
    expect(await invoke('terminal:read-buffer', { terminalId: 'never-spawned' })).toEqual({
      success: true, data: { output: '', length: 0 },
    })
  })
})

// ===========================================================================
// terminal:kill
// ===========================================================================
describe('terminal:kill', () => {
  it('kills the pty, drops its output buffer and detaches its transcript watcher', async () => {
    mockDetectAvailableShells.mockResolvedValue([{ type: 'bash', executable: '/bin/bash' }])
    await invoke('terminal:create', { id: 'kill-1', shellType: 'bash' })
    const onData = mockSpawnTerminal.mock.calls.at(-1)![3] as (d: string) => void
    onData('leftover output')
    expect((await invoke('terminal:read-buffer', { terminalId: 'kill-1' })).data.output).toBe('leftover output')

    const r = await invoke('terminal:kill', { id: 'kill-1' })
    expect(r).toEqual({ success: true, data: undefined })
    expect(mockKillTerminal).toHaveBeenCalledWith('kill-1')
    // The buffer is gone — a recycled id must not inherit the dead terminal's output.
    expect((await invoke('terminal:read-buffer', { terminalId: 'kill-1' })).data.output).toBe('')
  })

  it('audits terminal_close only for a terminal that was audited as an AI session', async () => {
    const plain = newId('kill-plain')
    fire('terminal:write', { id: plain, data: 'ls -la\r' })
    mockAppendAudit.mockClear()
    await invoke('terminal:kill', { id: plain })
    expect(auditEvents().some((e) => e.event === 'terminal_close')).toBe(false)

    const agent = newId('kill-agent')
    fire('terminal:write', { id: agent, data: 'claude\r' })  // logs terminal_open
    mockAppendAudit.mockClear()
    await invoke('terminal:kill', { id: agent })
    expect(auditEvents()).toContainEqual(
      expect.objectContaining({ event: 'terminal_close', terminalId: agent }),
    )
  })

  it('is idempotent — a second kill of the same id no longer re-audits the close', async () => {
    const id = newId('kill-twice')
    fire('terminal:write', { id, data: 'claude\r' })
    await invoke('terminal:kill', { id })
    mockAppendAudit.mockClear()
    await invoke('terminal:kill', { id })
    expect(auditEvents().some((e) => e.event === 'terminal_close')).toBe(false)
  })

  it('surfaces a kill failure as {success:false,error}', async () => {
    mockKillTerminal.mockImplementationOnce(() => { throw new Error('pty already exited') })
    expect(await invoke('terminal:kill', { id: 'kill-boom' })).toEqual({
      success: false, error: 'pty already exited',
    })
  })
})

// ===========================================================================
// terminal:write — the outbound watcher.
// ===========================================================================
describe('terminal:write — always forwards, never withholds', () => {
  it('passes a plain shell command straight through with no audit and no renderer event', () => {
    const id = newId('w-plain')
    fire('terminal:write', { id, data: 'npm test\r' })
    expect(mockWriteToTerminal).toHaveBeenCalledWith(id, 'npm test\r')
    expect(auditEvents()).toEqual([])
    expect(mockWebContents.send.mock.calls.filter((c: any[]) => c[0].startsWith('terminal:secret'))).toEqual([])
  })

  it('audits terminal_open when the user launches an agent, naming the agent', () => {
    const id = newId('w-launch')
    fire('terminal:write', { id, data: 'claude\r' })
    expect(auditEvents()).toContainEqual(expect.objectContaining({
      agent: 'claude', event: 'terminal_open', terminalId: id,
    }))
    expect(mockWriteToTerminal).toHaveBeenCalledWith(id, 'claude\r')
  })

  it.each(['codex', 'gemini'])('recognises `%s` as an agent launch too', (agent) => {
    const id = newId(`w-${agent}`)
    fire('terminal:write', { id, data: `${agent} --help\r` })
    expect(auditEvents()).toContainEqual(expect.objectContaining({ agent, event: 'terminal_open' }))
  })

  it('throttles the launch audit — relaunching within 5s does not double-log', () => {
    const id = newId('w-throttle')
    fire('terminal:write', { id, data: 'claude\r' })
    expect(auditEvents().filter((e) => e.event === 'terminal_open')).toHaveLength(1)
    mockAppendAudit.mockClear()
    fire('terminal:write', { id, data: 'claude --resume\r' })
    expect(auditEvents().filter((e) => e.event === 'terminal_open')).toHaveLength(0)
  })

  it('ignores an empty write instead of scanning it', () => {
    const id = newId('w-empty')
    fire('terminal:write', { id, data: '' })
    expect(mockWriteToTerminal).toHaveBeenCalledWith(id, '')
    expect(auditEvents()).toEqual([])
  })
})

describe('terminal:write — a secret in the prompt is RECORDED, never redacted or blocked', () => {
  it('forwards the bytes verbatim and tells the renderer WHAT leaked', () => {
    const id = newId('w-secret')
    asAiTerminal(id)

    const prompt = `why is ${AWS_KEY} rejected\r`
    fire('terminal:write', { id, data: prompt })

    // v1.25 contract: redaction is gone. The bytes reach the PTY unmodified.
    expect(mockWriteToTerminal).toHaveBeenCalledWith(id, prompt)

    const [evt] = sentEvents('terminal:secret-observed')
    expect(evt.id).toBe(id)
    expect(evt.hits.map((h: any) => h.rule)).toContain('aws_access_key')
    expect(evt.hits[0].label).toBe('AWS Access Key ID')
  })

  it('NEVER puts the secret value (or hit.sample, which contains it) on the renderer IPC', () => {
    const id = newId('w-nosample')
    asAiTerminal(id)
    fire('terminal:write', { id, data: `deploy with ${NAMED_SECRET}\r` })

    const [evt] = sentEvents('terminal:secret-observed')
    const payload = JSON.stringify(evt)
    // `sample` is `DB_P…aa` for the named rules — the tail comes out of the credential itself.
    expect(evt.hits.every((h: any) => !('sample' in h))).toBe(true)
    expect(payload).not.toContain(SECRET_VALUE)
    // …but it is still actionable: the renderer is told the variable to rotate.
    expect(evt.hits.map((h: any) => h.name)).toContain('DB_PASSWORD')
  })

  it('NEVER puts the secret value in the audit log either — only rule ids and variable names', () => {
    const id = newId('w-audit')
    asAiTerminal(id)
    const prompt = `${AWS_KEY} and ${NAMED_SECRET}\r`
    fire('terminal:write', { id, data: prompt })

    const entry = auditEvents().find((e) => e.event === 'prompt_secret_sent')
    expect(entry).toBeDefined()
    expect(entry.terminalId).toBe(id)
    expect(entry.byteCount).toBe(prompt.length)
    expect(entry.hitCount).toBeGreaterThanOrEqual(2)
    // Named rule => "DB_PASSWORD (env_secret)"; unnamed rule => bare rule id.
    expect(entry.notes).toContain('DB_PASSWORD (env_secret)')
    expect(entry.notes).toContain('aws_access_key')
    expect(JSON.stringify(entry)).not.toContain(SECRET_VALUE)
    expect(JSON.stringify(entry)).not.toContain(AWS_KEY)
  })

  it('attributes the leak to the agent when the launch and the secret land in one chunk', () => {
    const id = newId('w-attr')
    fire('terminal:write', { id, data: `claude "check ${AWS_KEY}"\r` })
    const entry = auditEvents().find((e) => e.event === 'prompt_secret_sent')
    expect(entry.agent).toBe('claude')
    expect(sentEvents('terminal:secret-observed')[0].agent).toBe('claude')
  })

  it('falls back to agent "unknown" for a later prompt that does not name the agent', () => {
    const id = newId('w-attr2')
    asAiTerminal(id)
    fire('terminal:write', { id, data: `rotate ${AWS_KEY} please\r` })
    const entry = auditEvents().find((e) => e.event === 'prompt_secret_sent')
    expect(entry.agent).toBe('unknown')
    expect(sentEvents('terminal:secret-observed')[0].agent).toBeNull()
  })

  it('does not scan a NON-agent terminal — the watcher is scoped to where the leak risk is', () => {
    const id = newId('w-noai')
    fire('terminal:write', { id, data: `echo ${AWS_KEY}\r` })  // never typed `claude`
    expect(mockWriteToTerminal).toHaveBeenCalledWith(id, `echo ${AWS_KEY}\r`)
    expect(sentEvents('terminal:secret-observed')).toEqual([])
    expect(auditEvents().some((e) => e.event === 'prompt_secret_sent')).toBe(false)
  })

  it('does not fire mid-keystroke — only on submit (Enter) or a paste-sized chunk', () => {
    const id = newId('w-typing')
    asAiTerminal(id)
    for (const ch of AWS_KEY) fire('terminal:write', { id, data: ch })
    expect(sentEvents('terminal:secret-observed')).toEqual([])  // still typing

    fire('terminal:write', { id, data: '\r' })                  // submitted
    expect(sentEvents('terminal:secret-observed')).toHaveLength(1)
  })
})

describe('terminal:write — code-chunk and env-dump prompts get their OWN events', () => {
  // Deliberately distinct from a secret: pasting a big file is not a leak, and conflating
  // the two would inflate the secrets-sent count with things that are not secrets at all.
  const CODE = 'import { compute } from "./m"\n' +
    Array.from({ length: 45 }, (_, i) => `  const value${i} = compute(a, b); // padding padding padding`).join('\n') +
    '\nexport function run() { return value0 }\n'

  const ENV_DUMP = ['FOO_ONE=aaaaaaaa', 'FOO_TWO=bbbbbbbb', 'FOO_THREE=cccccccc',
    'FOO_FOUR=dddddddd', 'FOO_FIVE=eeeeeeee', 'FOO_SIX=ffffffff'].join('\n') + '\r'

  it('flags a pasted code chunk as code_chunk_sent, not as a secret', () => {
    expect(CODE.length).toBeGreaterThan(2048)
    const id = newId('w-code')
    asAiTerminal(id)
    fire('terminal:write', { id, data: CODE })

    expect(mockWriteToTerminal).toHaveBeenCalledWith(id, CODE)   // still forwarded verbatim
    const [evt] = sentEvents('terminal:code-chunk-detected')
    expect(evt.id).toBe(id)
    expect(evt.byteSize).toBe(Buffer.byteLength(CODE, 'utf8'))
    expect(evt.signals.length).toBeGreaterThanOrEqual(2)

    const entry = auditEvents().find((e) => e.event === 'code_chunk_sent')
    expect(entry.notes).toMatch(/^code-chunk:/)
    expect(entry.byteCount).toBe(evt.byteSize)
    expect(auditEvents().some((e) => e.event === 'prompt_secret_sent')).toBe(false)
  })

  it('flags a pasted .env as env_dump_sent, naming the variables but never their values', () => {
    const id = newId('w-env')
    asAiTerminal(id)
    fire('terminal:write', { id, data: ENV_DUMP })

    const [evt] = sentEvents('terminal:env-dump-detected')
    expect(evt.varCount).toBe(6)
    expect(evt.variableNames).toEqual(['FOO_ONE', 'FOO_TWO', 'FOO_THREE', 'FOO_FOUR', 'FOO_FIVE', 'FOO_SIX'])

    const entry = auditEvents().find((e) => e.event === 'env_dump_sent')
    expect(entry.notes).toBe('env-dump:6:FOO_ONE,FOO_TWO,FOO_THREE,FOO_FOUR,FOO_FIVE')
    expect(entry.notes).not.toContain('aaaaaaaa')  // names, never values
  })

  it('leaves a short prose prompt alone', () => {
    const id = newId('w-prose')
    asAiTerminal(id)
    fire('terminal:write', { id, data: 'explain this stack trace\r' })
    expect(sentEvents('terminal:code-chunk-detected')).toEqual([])
    expect(sentEvents('terminal:env-dump-detected')).toEqual([])
    expect(auditEvents()).toEqual([])
  })
})

describe('terminal:write — strict-mode Gemini is the ONE interception', () => {
  const SAFE_KEYS = ['GEMINI_API_KEY', 'GOOGLE_GENAI_USE_GCA', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT']
  let saved: Record<string, string | undefined>

  beforeEach(() => {
    saved = Object.fromEntries(SAFE_KEYS.map((k) => [k, process.env[k]]))
    for (const k of SAFE_KEYS) delete process.env[k]
  })
  afterEach(() => {
    aiSec.setStrictGeminiPaidOnly(false)
    for (const k of SAFE_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('BLOCKS the launch before the bytes reach the PTY when the account is free-tier', () => {
    aiSec.setStrictGeminiPaidOnly(true)
    const id = newId('w-strict')
    fire('terminal:write', { id, data: 'gemini\r' })

    // The whole point: the unsafe `gemini` token is never forwarded.
    expect(mockWriteToTerminal).not.toHaveBeenCalledWith(id, 'gemini\r')
    // Ctrl+C first, so the shell drops back to a clean prompt.
    expect(mockWriteToTerminal).toHaveBeenNthCalledWith(1, id, '\u0003')

    // FIXED in v1.25.6 -- the banner now goes STRAIGHT TO THE RENDERER, not through the shell.
    // It used to be wrapped in `printf '<banner>'` and written to the PTY as a typed command, which
    // only renders on a shell that HAS printf. On Windows (cmd.exe / PowerShell -- the default, and
    // Termpolis's primary platform) the user got `'printf' is not recognized` INSTEAD of the
    // explanation, at the exact moment they most needed to know why the launch was refused. The
    // BLOCK always worked; the MESSAGE was what failed.
    const dataEvents = mockWebContents.send.mock.calls.filter((c: any[]) => c[0] === 'terminal:data')
    const banner = dataEvents.map((c: any[]) => c[2] as string).find((t) => typeof t === 'string' && t.includes('BLOCKED'))
    expect(banner).toBeDefined()
    expect(banner).toContain('Strict Mode')
    expect(dataEvents.some((c: any[]) => c[1] === id)).toBe(true)

    // …and NOTHING shell-shaped is typed into the PTY. `printf` must never appear again: on the
    // primary platform it turns an explanation into an error message.
    for (const call of mockWriteToTerminal.mock.calls) {
      expect(String(call[1])).not.toContain('printf')
    }

    expect(auditEvents()).toContainEqual(expect.objectContaining({
      agent: 'gemini',
      event: 'terminal_open',
      notes: expect.stringContaining('BLOCKED: strict-mode'),
    }))
  })

  it('allows the launch when the account IS paid (GOOGLE_GENAI_USE_GCA)', () => {
    aiSec.setStrictGeminiPaidOnly(true)
    process.env.GOOGLE_GENAI_USE_GCA = 'true'
    const id = newId('w-strict-ok')
    fire('terminal:write', { id, data: 'gemini\r' })

    expect(mockWriteToTerminal).toHaveBeenCalledWith(id, 'gemini\r')
    expect(mockWriteToTerminal).not.toHaveBeenCalledWith(id, '\u0003')
  })

  it('does not intercept when strict mode is OFF, even on a free-tier account', () => {
    aiSec.setStrictGeminiPaidOnly(false)
    const id = newId('w-strict-off')
    fire('terminal:write', { id, data: 'gemini\r' })
    expect(mockWriteToTerminal).toHaveBeenCalledWith(id, 'gemini\r')
  })

  it('does not intercept an unrelated command that merely mentions gemini', () => {
    aiSec.setStrictGeminiPaidOnly(true)
    const id = newId('w-strict-mention')
    fire('terminal:write', { id, data: 'echo install gemini later\r' })
    expect(mockWriteToTerminal).toHaveBeenCalledWith(id, 'echo install gemini later\r')
    expect(mockWriteToTerminal).not.toHaveBeenCalledWith(id, '\u0003')
  })
})

// ===========================================================================
// The audit sink is BEST-EFFORT. Every aiSecurityAppend() on the terminal path is
// fire-and-forget with a `.catch(() => {})`, and that is deliberate: a full disk or a
// locked audit file must never swallow a keystroke, block a paste, or wedge a kill.
// If any of these catches were dropped, the rejected promise would surface as an
// unhandled rejection in main — so these tests are what keep the terminal typeable
// when logging breaks.
// ===========================================================================
describe('terminal path survives an audit-log failure', () => {
  const AUDIT_DOWN = new Error('EACCES: audit log is read-only')

  it('still forwards an agent launch when the terminal_open audit cannot be written', () => {
    mockAppendAudit.mockRejectedValue(AUDIT_DOWN)
    const id = newId('af-launch')
    expect(() => fire('terminal:write', { id, data: 'claude\r' })).not.toThrow()
    expect(mockWriteToTerminal).toHaveBeenCalledWith(id, 'claude\r')
  })

  it('still forwards the prompt AND still warns the renderer when the secret audit fails', () => {
    const id = newId('af-secret')
    asAiTerminal(id)
    mockAppendAudit.mockRejectedValue(AUDIT_DOWN)

    const prompt = `check ${AWS_KEY}\r`
    expect(() => fire('terminal:write', { id, data: prompt })).not.toThrow()
    expect(mockWriteToTerminal).toHaveBeenCalledWith(id, prompt)
    // The banner is the user's only signal once the log is gone — it must still fire.
    expect(sentEvents('terminal:secret-observed')).toHaveLength(1)
  })

  it('still forwards a pasted code chunk when its audit fails', () => {
    const id = newId('af-code')
    asAiTerminal(id)
    mockAppendAudit.mockRejectedValue(AUDIT_DOWN)

    const code = 'import x from "y"\n' +
      Array.from({ length: 45 }, (_, i) => `  const v${i} = compute(a, b); // padding padding padding`).join('\n')
    expect(() => fire('terminal:write', { id, data: code })).not.toThrow()
    expect(mockWriteToTerminal).toHaveBeenCalledWith(id, code)
    expect(sentEvents('terminal:code-chunk-detected')).toHaveLength(1)
  })

  it('still forwards a pasted .env when its audit fails', () => {
    const id = newId('af-env')
    asAiTerminal(id)
    mockAppendAudit.mockRejectedValue(AUDIT_DOWN)

    const env = ['AAA_ONE=11111111', 'BBB_TWO=22222222', 'CCC_THREE=33333333',
      'DDD_FOUR=44444444', 'EEE_FIVE=55555555'].join('\n') + '\r'
    expect(() => fire('terminal:write', { id, data: env })).not.toThrow()
    expect(mockWriteToTerminal).toHaveBeenCalledWith(id, env)
    expect(sentEvents('terminal:env-dump-detected')).toHaveLength(1)
  })

  it('still BLOCKS strict-mode gemini when the block cannot be audited — enforcement outranks logging', () => {
    const saved = process.env.GOOGLE_GENAI_USE_GCA
    delete process.env.GOOGLE_GENAI_USE_GCA
    aiSec.setStrictGeminiPaidOnly(true)
    mockAppendAudit.mockRejectedValue(AUDIT_DOWN)
    try {
      const id = newId('af-strict')
      expect(() => fire('terminal:write', { id, data: 'gemini\r' })).not.toThrow()
      expect(mockWriteToTerminal).not.toHaveBeenCalledWith(id, 'gemini\r')
      expect(mockWriteToTerminal).toHaveBeenNthCalledWith(1, id, '\u0003')
    } finally {
      aiSec.setStrictGeminiPaidOnly(false)
      if (saved === undefined) delete process.env.GOOGLE_GENAI_USE_GCA
      else process.env.GOOGLE_GENAI_USE_GCA = saved
    }
  })

  it('still kills the terminal when the terminal_close audit fails', async () => {
    const id = newId('af-kill')
    fire('terminal:write', { id, data: 'claude\r' })
    mockAppendAudit.mockRejectedValue(AUDIT_DOWN)

    expect(await invoke('terminal:kill', { id })).toEqual({ success: true, data: undefined })
    expect(mockKillTerminal).toHaveBeenCalledWith(id)
  })
})

// ===========================================================================
// terminal:resize / terminal:status
// ===========================================================================
describe('terminal:resize + terminal:status', () => {
  it('terminal:resize forwards the new geometry to the pty', () => {
    fire('terminal:resize', { id: 'r-1', cols: 120, rows: 40 })
    expect(mockResizeTerminal).toHaveBeenCalledWith('r-1', 120, 40)
  })

  // terminal:status is polled every 5 s per terminal; both the cwd probe (lsof on mac) and the git
  // branch read are ASYNC now so the poll never blocks the PTY-pumping main thread. These drive the
  // async seams: getTerminalCwdAsync and execFile (via safeGitAsync).
  const gitBranchAsync = (out: string | Error) =>
    mockExecFile.mockImplementation((_b: string, _a: string[], _o: unknown, cb: (e: Error | null, s: string) => void) =>
      out instanceof Error ? cb(out, '') : cb(null, out))

  it('terminal:status prefers the pty\'s LIVE cwd over the renderer\'s stale one', async () => {
    mockGetTerminalCwdAsync.mockResolvedValue('/live/cwd')
    gitBranchAsync('feature/x\n')
    expect(await invoke('terminal:status', { terminalId: 's-1', fallbackCwd: '/stale' })).toEqual({
      success: true, data: { cwd: '/live/cwd', gitBranch: 'feature/x' },
    })
  })

  it('terminal:status falls back to the supplied cwd when the pty cannot report one', async () => {
    mockGetTerminalCwdAsync.mockResolvedValue('')
    gitBranchAsync('main\n')
    const r = await invoke('terminal:status', { terminalId: 's-2', fallbackCwd: '/fallback' })
    expect(r.data.cwd).toBe('/fallback')
  })

  it('terminal:status still returns the cwd when the folder is not a git repo', async () => {
    mockGetTerminalCwdAsync.mockResolvedValue('/no-git')
    gitBranchAsync(new Error('not a git repository'))
    expect(await invoke('terminal:status', { terminalId: 's-3' })).toEqual({
      success: true, data: { cwd: '/no-git', gitBranch: '' },
    })
  })

  it('terminal:status reports the failure when the pty lookup itself throws', async () => {
    mockGetTerminalCwdAsync.mockRejectedValueOnce(new Error('pty registry corrupt'))
    expect(await invoke('terminal:status', { terminalId: 's-4' })).toEqual({
      success: false, error: 'pty registry corrupt',
    })
  })

  it('terminal:status never blocks the main thread — no sync git spawn', async () => {
    mockGetTerminalCwdAsync.mockResolvedValue('/repo')
    gitBranchAsync('main\n')
    mockExecFileSync.mockClear()
    await invoke('terminal:status', { terminalId: 's-5' })
    // The git branch read must go through the async execFile, never the blocking execFileSync.
    expect(mockExecFile).toHaveBeenCalled()
    expect(mockExecFileSync).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// terminal:export
// ===========================================================================
describe('terminal:export', () => {
  it('writes the transcript to the chosen path', async () => {
    mockShowSaveDialog.mockResolvedValue({ canceled: false, filePath: '/out/session.txt' })
    const r = await invoke('terminal:export', { content: 'scrollback', defaultFilename: 'session.txt' })
    expect(r).toEqual({ success: true, data: { filePath: '/out/session.txt' } })
    expect(mockWriteFileSync).toHaveBeenCalledWith('/out/session.txt', 'scrollback', 'utf-8')
  })

  it('writes nothing when the user cancels the save dialog', async () => {
    mockShowSaveDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    expect(await invoke('terminal:export', { content: 'x' })).toEqual({ success: true, data: undefined })
    expect(mockWriteFileSync).not.toHaveBeenCalled()
  })

  it('writes nothing when the dialog returns without a path', async () => {
    mockShowSaveDialog.mockResolvedValue({ canceled: false, filePath: undefined })
    expect(await invoke('terminal:export', { content: 'x' })).toEqual({ success: true, data: undefined })
    expect(mockWriteFileSync).not.toHaveBeenCalled()
  })

  it('reports a disk failure instead of silently losing the export', async () => {
    mockShowSaveDialog.mockResolvedValue({ canceled: false, filePath: '/ro/session.txt' })
    mockWriteFileSync.mockImplementationOnce(() => { throw new Error('EACCES: read-only file system') })
    expect(await invoke('terminal:export', { content: 'x' })).toEqual({
      success: false, error: 'EACCES: read-only file system',
    })
  })
})

// ===========================================================================
// SHELL
// ===========================================================================
describe('shell IPC', () => {
  it('shell:available returns the detected shells', async () => {
    mockDetectAvailableShells.mockResolvedValue([{ type: 'bash', executable: '/bin/bash' }])
    expect(await invoke('shell:available')).toEqual({
      success: true, data: [{ type: 'bash', executable: '/bin/bash' }],
    })
  })

  it('shell:available reports a detection failure', async () => {
    mockDetectAvailableShells.mockRejectedValueOnce(new Error('registry unreadable'))
    expect(await invoke('shell:available')).toEqual({ success: false, error: 'registry unreadable' })
  })

  it('shell:open-path opens the folder', async () => {
    mockOpenPath.mockResolvedValue('')
    expect(await invoke('shell:open-path', { path: '/some/dir' })).toEqual({ success: true, data: undefined })
    expect(mockOpenPath).toHaveBeenCalledWith('/some/dir')
  })

  it('shell:open-path surfaces the OS refusal — openPath reports failure by RETURNING a message, not throwing', async () => {
    mockOpenPath.mockResolvedValue('Cannot find the specified path')
    expect(await invoke('shell:open-path', { path: '/gone' })).toEqual({
      success: false, error: 'Cannot find the specified path',
    })
  })

  it('shell:open-path reports a thrown failure too', async () => {
    mockOpenPath.mockRejectedValueOnce(new Error('shell unavailable'))
    expect(await invoke('shell:open-path', { path: '/x' })).toEqual({ success: false, error: 'shell unavailable' })
  })

  it.each([
    ['file:///etc/passwd', 'disallowed protocol: file:'],
    ['javascript:alert(1)', 'disallowed protocol: javascript:'],
  ])('shell:open-external refuses %s — this surface must never launch a local handler', async (url, expected) => {
    expect(await invoke('shell:open-external', { url })).toEqual({ success: false, error: expected })
    expect(mockOpenExternal).not.toHaveBeenCalled()
  })

  it('shell:open-external rejects a non-string and a malformed url', async () => {
    expect(await invoke('shell:open-external', { url: 42 })).toEqual({ success: false, error: 'url must be a string' })
    expect(await invoke('shell:open-external', { url: 'not a url' })).toEqual({ success: false, error: 'invalid url' })
    expect(mockOpenExternal).not.toHaveBeenCalled()
  })

  it('shell:open-external opens an https url', async () => {
    expect(await invoke('shell:open-external', { url: 'https://termpolis.com/docs' })).toEqual({
      success: true, data: undefined,
    })
    expect(mockOpenExternal).toHaveBeenCalledWith('https://termpolis.com/docs')
  })
})

// ===========================================================================
// SESSION / CONFIG / HISTORY / COMPLETION / FS
// ===========================================================================
describe('session IPC', () => {
  it('session:load returns the RESTORE session, not the raw stored one', async () => {
    // The boot restore reads loadRestoreSession — the variant that drops loose
    // terminals — while loadSession keeps reporting what the file holds.
    mockLoadRestoreSession.mockReturnValue({ terminals: [], viewMode: 'tabs' } as any)
    expect(await invoke('session:load')).toEqual({ success: true, data: { terminals: [], viewMode: 'tabs' } })
    expect(mockLoadSession).not.toHaveBeenCalled()
  })

  it('session:load reports a corrupt store rather than crashing the window', async () => {
    mockLoadRestoreSession.mockImplementationOnce(() => { throw new Error('Unexpected token in JSON') })
    expect(await invoke('session:load')).toEqual({ success: false, error: 'Unexpected token in JSON' })
  })

  it('session:save persists the payload', () => {
    const data = { terminals: [{ id: 'z' }] }
    fire('session:save', data)
    expect(mockSaveSession).toHaveBeenCalledWith(data)
  })

  it('session:save swallows a write failure — an autosave must never take down the app', () => {
    mockSaveSession.mockImplementationOnce(() => { throw new Error('ENOSPC') })
    expect(() => fire('session:save', { terminals: [] })).not.toThrow()
  })
})

describe('config IPC', () => {
  it('config:read returns the file contents', async () => {
    mockReadConfigFile.mockReturnValue('export PS1="$ "')
    expect(await invoke('config:read', { filePath: '~/.bashrc' })).toEqual({
      success: true, data: 'export PS1="$ "',
    })
    expect(mockReadConfigFile).toHaveBeenCalledWith('~/.bashrc')
  })

  it('config:read reports a missing file', async () => {
    mockReadConfigFile.mockImplementationOnce(() => { throw new Error('ENOENT: no such file') })
    expect(await invoke('config:read', { filePath: '/nope' })).toEqual({
      success: false, error: 'ENOENT: no such file',
    })
  })

  it('config:write persists the edited content', async () => {
    expect(await invoke('config:write', { filePath: '~/.zshrc', content: 'alias ll="ls -la"' })).toEqual({
      success: true, data: undefined,
    })
    expect(mockWriteConfigFile).toHaveBeenCalledWith('~/.zshrc', 'alias ll="ls -la"')
  })

  it('config:write reports a permission failure', async () => {
    mockWriteConfigFile.mockImplementationOnce(() => { throw new Error('EACCES') })
    expect(await invoke('config:write', { filePath: '/etc/profile', content: 'x' })).toEqual({
      success: false, error: 'EACCES',
    })
  })
})

describe('history IPC', () => {
  it('history:append records the command against its terminal', () => {
    fire('history:append', { terminalId: 'h-1', terminalName: 'build', command: 'npm run build' })
    expect(mockAppendCommand).toHaveBeenCalledWith('h-1', 'build', 'npm run build')
  })

  it('history:append falls back to the id when the terminal has no name yet', () => {
    fire('history:append', { terminalId: 'h-2', command: 'ls' })
    expect(mockAppendCommand).toHaveBeenCalledWith('h-2', 'h-2', 'ls')
  })

  it('history:append swallows a store failure — history is never worth losing a keystroke over', () => {
    mockAppendCommand.mockImplementationOnce(() => { throw new Error('history db locked') })
    expect(() => fire('history:append', { terminalId: 'h-3', command: 'ls' })).not.toThrow()
  })

  it('history:search returns the matches', async () => {
    mockSearchHistory.mockReturnValue([{ command: 'npm test' }] as any)
    expect(await invoke('history:search', { query: 'npm' })).toEqual({
      success: true, data: [{ command: 'npm test' }],
    })
    expect(mockSearchHistory).toHaveBeenCalledWith('npm')
  })

  it('history:search reports a store failure', async () => {
    mockSearchHistory.mockImplementationOnce(() => { throw new Error('history db locked') })
    expect(await invoke('history:search', { query: 'x' })).toEqual({ success: false, error: 'history db locked' })
  })
})

describe('completion IPC', () => {
  it('completion:path-entries lists the directory for tab-completion', async () => {
    mockListPathEntries.mockReturnValue(['src/', 'package.json'] as any)
    expect(await invoke('completion:path-entries', { dirPath: '/repo' })).toEqual({
      success: true, data: ['src/', 'package.json'],
    })
    expect(mockListPathEntries).toHaveBeenCalledWith('/repo')
  })

  it('completion:path-entries reports an unreadable directory', async () => {
    mockListPathEntries.mockImplementationOnce(() => { throw new Error('EACCES') })
    expect(await invoke('completion:path-entries', { dirPath: '/root' })).toEqual({ success: false, error: 'EACCES' })
  })

  it('completion:path-commands lists the PATH binaries', async () => {
    mockListPathCommands.mockReturnValue(['git', 'node'] as any)
    expect(await invoke('completion:path-commands')).toEqual({ success: true, data: ['git', 'node'] })
  })

  it('completion:path-commands reports a PATH scan failure', async () => {
    mockListPathCommands.mockImplementationOnce(() => { throw new Error('PATH unreadable') })
    expect(await invoke('completion:path-commands')).toEqual({ success: false, error: 'PATH unreadable' })
  })

  it('completion:env-vars lists the environment', async () => {
    mockListEnvVars.mockReturnValue(['HOME', 'PATH'] as any)
    expect(await invoke('completion:env-vars')).toEqual({ success: true, data: ['HOME', 'PATH'] })
  })

  it('completion:env-vars reports a failure', async () => {
    mockListEnvVars.mockImplementationOnce(() => { throw new Error('env unavailable') })
    expect(await invoke('completion:env-vars')).toEqual({ success: false, error: 'env unavailable' })
  })
})

describe('fs + app info IPC', () => {
  it('fs:homedir returns the real home directory', async () => {
    const { homedir } = await vi.importActual<typeof import('os')>('os')
    expect(await invoke('fs:homedir')).toEqual({ success: true, data: homedir() })
  })

  it('fs:mcp-config-path resolves claude-mcp-config.json under userData', async () => {
    // `claude -p` bypasses user-scope plugins, so the renderer has to pass
    // --mcp-config <path>; main owns the path because main is what wrote the file.
    const r = await invoke('fs:mcp-config-path')
    expect(r.success).toBe(true)
    expect(r.data.endsWith('claude-mcp-config.json')).toBe(true)
  })

  it('app:get-version reports the running version', async () => {
    expect(await invoke('app:get-version')).toEqual({ success: true, data: { version: '9.9.9' } })
  })

  it('app:platform-info-sync answers SYNCHRONOUSLY — xterm needs windowsPty at construction time', async () => {
    const { release } = await vi.importActual<typeof import('os')>('os')
    const e: { returnValue?: any } = {}
    // Registered with ipcMain.on and replies via e.returnValue (sendSync), because an
    // async round-trip would land after the first Terminal is already constructed.
    ipcOnHandlers.get('app:platform-info-sync')!.at(-1)!(e)

    expect(e.returnValue).toEqual({
      platform: process.platform,
      windowsPty: { backend: 'conpty', buildNumber: 22631 },
    })
    expect(mockComputeWindowsPty).toHaveBeenCalledWith(process.platform, release())
  })
})

// ===========================================================================
// DIALOG
// ===========================================================================
describe('dialog:pick-directory', () => {
  afterEach(() => { delete process.env.TERMPOLIS_TEST_PROJECT_CWD })

  it('returns the picked folder AND auto-trusts it (an explicit pick is consent)', async () => {
    mockShowOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/picked/project'] })
    expect(await invoke('dialog:pick-directory', {})).toEqual({ success: true, data: '/picked/project' })
    // Observable through the trust channel: no second prompt before the first swarm run.
    expect((await invoke('workspace:is-trusted', { cwd: '/picked/project' })).data).toBe(true)
  })

  it('opens the dialog at the supplied defaultPath', async () => {
    mockShowOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/p'] })
    await invoke('dialog:pick-directory', { defaultPath: '/start/here' })
    expect(mockShowOpenDialog.mock.calls[0][1]).toMatchObject({
      defaultPath: '/start/here',
      properties: ['openDirectory'],
    })
  })

  it('falls back to the home directory when no defaultPath is given', async () => {
    const { homedir } = await vi.importActual<typeof import('os')>('os')
    mockShowOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    await invoke('dialog:pick-directory', {})
    expect(mockShowOpenDialog.mock.calls[0][1].defaultPath).toBe(homedir())
  })

  it('returns null when the user cancels', async () => {
    mockShowOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    expect(await invoke('dialog:pick-directory', {})).toEqual({ success: true, data: null })
  })

  it('returns null when the dialog closes with no selection', async () => {
    mockShowOpenDialog.mockResolvedValue({ canceled: false, filePaths: [] })
    expect(await invoke('dialog:pick-directory', {})).toEqual({ success: true, data: null })
  })

  it('short-circuits to the E2E-fixture folder without ever opening a native dialog', async () => {
    process.env.TERMPOLIS_TEST_PROJECT_CWD = '/e2e/fixture-repo'
    const r = await invoke('dialog:pick-directory', {})
    expect(r).toEqual({ success: true, data: '/e2e/fixture-repo' })
    expect(mockShowOpenDialog).not.toHaveBeenCalled()   // a native dialog would hang Playwright
    expect((await invoke('workspace:is-trusted', { cwd: '/e2e/fixture-repo' })).data).toBe(true)
  })

  it('reports a dialog failure', async () => {
    mockShowOpenDialog.mockRejectedValueOnce(new Error('no display'))
    expect(await invoke('dialog:pick-directory', {})).toEqual({ success: false, error: 'no display' })
  })
})

// ===========================================================================
// Window lifecycle — createWindow() and the close guard that owns every terminal.
//
// `app.on('activate')` re-runs createWindow() when mainWindow is null, which is the
// hook that lets us exercise the constructor's branches (icon, titleBarStyle, dev-server
// URL) more than once, each with a fresh `forceClose` closure.
// ===========================================================================
describe('createWindow — icon resolution', () => {
  it('drops an icon that decoded EMPTY so the OS falls back to the exe icon, never a blank one', () => {
    mockCreateFromBuffer.mockReturnValue({ isEmpty: () => true })
    recreateWindow()
    expect(browserWindowOpts.at(-1)!.icon).toBeUndefined()
    expect(mockMainWindow.setIcon).not.toHaveBeenCalled()
  })

  it('applies a decoded icon to the constructor AND re-asserts it on the live window', () => {
    // Windows does not always apply the constructor `icon` to the taskbar button —
    // the explicit setIcon() is what fixes the generic-taskbar-icon bug.
    const img = { isEmpty: () => false }
    mockCreateFromBuffer.mockReturnValue(img)
    recreateWindow()
    expect(browserWindowOpts.at(-1)!.icon).toBe(img)
    expect(mockMainWindow.setIcon).toHaveBeenCalledWith(img)
  })

  it('survives a decode failure — no icon rather than a crash on launch', () => {
    mockCreateFromBuffer.mockImplementation(() => { throw new Error('bad PNG') })
    expect(() => recreateWindow()).not.toThrow()
    expect(browserWindowOpts.at(-1)!.icon).toBeUndefined()
    mockCreateFromBuffer.mockReturnValue({ isEmpty: () => true })
  })
})

describe('createWindow — renderer source + chrome', () => {
  afterEach(() => { delete process.env['ELECTRON_RENDERER_URL'] })

  it('loads the dev-server URL when one is set', () => {
    process.env['ELECTRON_RENDERER_URL'] = 'http://localhost:5173'
    recreateWindow()
    expect(mockMainWindow.loadURL).toHaveBeenCalledWith('http://localhost:5173')
    expect(mockMainWindow.loadFile).not.toHaveBeenCalled()
  })

  it('loads the bundled index.html in production', () => {
    recreateWindow()
    expect(mockMainWindow.loadURL).not.toHaveBeenCalled()
    expect(mockMainWindow.loadFile.mock.calls[0][0]).toContain('index.html')
  })

  it('uses the inset macOS traffic-light chrome on darwin, and the default frame elsewhere', () => {
    const original = process.platform
    try {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
      recreateWindow()
      expect(browserWindowOpts.at(-1)!.titleBarStyle).toBe('hiddenInset')

      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
      recreateWindow()
      expect(browserWindowOpts.at(-1)!.titleBarStyle).toBe('default')
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true })
    }
  })

  it('grants the microphone — Electron rejects getUserMedia without an explicit handler', () => {
    recreateWindow()
    const grant = mockWebContents.session.setPermissionRequestHandler.mock.calls.at(-1)![0] as Function
    const check = mockWebContents.session.setPermissionCheckHandler.mock.calls.at(-1)![0] as Function
    const callback = vi.fn()
    grant({}, 'media', callback)
    expect(callback).toHaveBeenCalledWith(true)
    expect(check()).toBe(true)
  })
})

describe('createWindow — the agents-running close guard', () => {
  const savedNodeEnv = process.env.NODE_ENV

  afterEach(() => { process.env.NODE_ENV = savedNodeEnv })

  /** Fresh window => fresh `forceClose` closure => a close listener that has not fired yet. */
  function freshCloseListener(): { close: Function; e: { preventDefault: ReturnType<typeof vi.fn> } } {
    recreateWindow()
    return { close: windowListener('close'), e: { preventDefault: vi.fn() } }
  }

  it('never interrupts the close in test mode', () => {
    process.env.NODE_ENV = 'test'
    const { close, e } = freshCloseListener()
    close(e)
    expect(e.preventDefault).not.toHaveBeenCalled()
    expect(mockWebContents.executeJavaScript).not.toHaveBeenCalled()
  })

  it('holds the close and asks the renderer to confirm when agents ARE running', async () => {
    delete process.env.NODE_ENV
    mockWebContents.executeJavaScript.mockResolvedValue(true)
    const { close, e } = freshCloseListener()
    close(e)

    expect(e.preventDefault).toHaveBeenCalled()   // the window must NOT go away yet
    await vi.waitFor(() => {
      expect(mockWebContents.send).toHaveBeenCalledWith('app:confirm-close')
    })
    expect(mockMainWindow.close).not.toHaveBeenCalled()
  })

  it('closes straight through when no agents are running', async () => {
    delete process.env.NODE_ENV
    mockWebContents.executeJavaScript.mockResolvedValue(false)
    const { close, e } = freshCloseListener()
    close(e)

    await vi.waitFor(() => { expect(mockMainWindow.close).toHaveBeenCalled() })
    expect(mockWebContents.send).not.toHaveBeenCalledWith('app:confirm-close')
  })

  it('fails OPEN — a renderer that cannot answer must not make the window unclosable', async () => {
    delete process.env.NODE_ENV
    mockWebContents.executeJavaScript.mockRejectedValue(new Error('renderer gone'))
    const { close, e } = freshCloseListener()
    close(e)

    await vi.waitFor(() => { expect(mockMainWindow.close).toHaveBeenCalled() })
  })

  it('app:force-close lets the user\'s "quit anyway" through the guard', async () => {
    delete process.env.NODE_ENV
    mockWebContents.executeJavaScript.mockResolvedValue(true)
    const { close, e } = freshCloseListener()

    fire('app:force-close')                       // renderer confirmed
    expect(mockMainWindow.close).toHaveBeenCalled()

    mockWebContents.executeJavaScript.mockClear()
    const e2 = { preventDefault: vi.fn() }
    close(e2)                                     // the close the forced close triggers
    expect(e2.preventDefault).not.toHaveBeenCalled()
    expect(mockWebContents.executeJavaScript).not.toHaveBeenCalled()
  })

  // LAST: quittingForUpdate is a one-way module-level latch — once armed, every
  // subsequent close bypasses the guard, so no close-guard test can follow this one.
  it('an update RESTART bypasses the guard — the dialog must not cancel quitAndInstall', () => {
    delete process.env.NODE_ENV
    mockWebContents.executeJavaScript.mockResolvedValue(true)
    const { close, e } = freshCloseListener()

    // autoUpdater arms the latch right before app.quit() from quitAndInstall.
    updaterOpts.onBeforeQuitAndInstall()

    close(e)
    expect(e.preventDefault).not.toHaveBeenCalled()
    expect(mockWebContents.executeJavaScript).not.toHaveBeenCalled()
  })
})
