// The remaining IPC surface of src/main/index.ts — the handlers the five existing main-process
// suites (mainProcess, security, mainIpcTerminal, mainIpcGit, mainIpcMemory, mainIpcSecurity)
// register but never invoke.
//
// Everything here is behavioural. The handlers in index.ts are thin, but "thin" is exactly where
// the interesting bugs live: a guard that forgets to run BEFORE the side effect, a pass-through
// that drops an argument, a cap that keeps the wrong end of a buffer. Each test below pins a
// decision the handler makes, not the fact that it was called.
//
// Harness is the one from security.test.ts: every ipcMain.handle registration is captured into a
// Map and driven through invoke(); handlers registered with ipcMain.on are pulled off the mock's
// recorded calls instead. Same for the callbacks index.ts hands to app.on / globalShortcut.register
// / initAutoUpdater / startMcpServer / setMemoryScrubber — those are the app's real lifecycle and
// they are only reachable through the mock that received them.

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import { EventEmitter } from 'events'
import { homedir } from 'os'
import { join } from 'path'

// ---------------------------------------------------------------------------
// Hoisted spies — referenced from inside vi.mock factories
// ---------------------------------------------------------------------------
const M = vi.hoisted(() => ({
  // child_process
  execSync: vi.fn(),
  execFileSync: vi.fn(),
  spawn: vi.fn(),
  // fs
  existsSync: vi.fn(() => false),
  writeFileSync: vi.fn(),
  fsUnlink: vi.fn(async () => {}),
  // electron
  showOpenDialog: vi.fn(),
  showSaveDialog: vi.fn(),
  // aiSecurity: real rules + real settings, spy on the audit sink only
  appendAudit: vi.fn(async () => {}),
  // lifecycle collaborators
  initAutoUpdater: vi.fn(),
  startMcpServer: vi.fn(() => ({ id: 'mcp-server-handle' })),
  stopMcpServer: vi.fn(),
  // terminal
  spawnTerminal: vi.fn(),
  writeToTerminal: vi.fn(),
  killTerminal: vi.fn(),
  killAll: vi.fn(),
  detectAvailableShells: vi.fn(async () => [
    { type: 'powershell', name: 'PowerShell', executable: 'pwsh.exe' },
  ]),
  // agent paths
  getAgentExtraPaths: vi.fn(() => ['/opt/agent-bin']),
  getExtendedPath: vi.fn(() => '/usr/bin:/opt/agent-bin'),
  // groq voice
  getGroqKey: vi.fn<(dir: string) => string | null>(() => null),
  setGroqKey: vi.fn(),
  clearGroqKey: vi.fn(),
  getGroqKeyStatus: vi.fn(() => ({ connected: false, hint: '' })),
  transcribeWithGroq: vi.fn(async () => ({ text: 'hello world' })),
  validateGroqKey: vi.fn(async () => ({ valid: true, models: 1 })),
  // past AI sessions
  listAISessions: vi.fn(async () => [{ id: 's1', cwd: '/repo' }]),
  digestAISession: vi.fn<(p: string) => Promise<unknown>>(async () => null),
  renderDigestAsPrompt: vi.fn(() => 'RENDERED PROMPT'),
  readActiveTranscript: vi.fn(async () => [{ role: 'user', text: 'hi' }]),
  readSessionTranscript: vi.fn(async () => ({ turns: [] })),
  // event bus
  queryEvents: vi.fn(() => [] as unknown[]),
  publishEvent: vi.fn(),
  getRingSize: vi.fn(() => 0),
  getDroppedCount: vi.fn(() => 0),
  // context pins
  listPins: vi.fn(() => [] as unknown[]),
  addPin: vi.fn(),
  updatePin: vi.fn<(...a: unknown[]) => unknown>(() => null),
  removePin: vi.fn(() => false),
  clearPins: vi.fn(),
  // transcript watchers
  attachWatcher: vi.fn<(...a: unknown[]) => unknown>(() => null),
  detachWatchers: vi.fn(),
  // memory brain seams we assert on
  setMemoryScrubber: vi.fn(),
  setSyncPassphrase: vi.fn(() => ({ encrypted: true })),
  enableLocalEncryption: vi.fn(() => ({ encrypted: true, local: true })),
  disableEncryption: vi.fn(() => ({ encrypted: false })),
  memoryWrite: vi.fn(async (input: Record<string, unknown>) => ({ id: `mem-${String(input?.content ?? '').length}` })),
  memoryLink: vi.fn(async () => ({ ok: true })),
  warmProbeEmbeddings: vi.fn(async () => true),
  compactSelfShard: vi.fn(async () => ({ compacted: false, before: 0, after: 0 })),
  // swarm
  updateTask: vi.fn<(...a: unknown[]) => unknown>(() => undefined),
  // single-instance lock (flipped by the last test)
  singleInstanceLock: vi.fn(() => true),
}))

// ---------------------------------------------------------------------------
// Electron
// ---------------------------------------------------------------------------
const ipcHandlers = new Map<string, Function>()
const mockWebContents = { send: vi.fn(), executeJavaScript: vi.fn(), session: undefined }
const mockMainWindow = {
  minimize: vi.fn(), maximize: vi.fn(), unmaximize: vi.fn(),
  isMaximized: vi.fn(() => false), isMinimized: vi.fn(() => false),
  restore: vi.fn(), focus: vi.fn(), close: vi.fn(), on: vi.fn(),
  setIcon: vi.fn(), loadURL: vi.fn(), loadFile: vi.fn(),
  webContents: mockWebContents,
}
function MockBrowserWindow() { return mockMainWindow }
MockBrowserWindow.prototype = {}

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => require('os').tmpdir()),
    getVersion: vi.fn(() => '1.25.2'),
    whenReady: () => Promise.resolve(),
    requestSingleInstanceLock: () => M.singleInstanceLock(),
    setName: vi.fn(),
    setAppUserModelId: vi.fn(),
    on: vi.fn(),
    commandLine: { appendSwitch: vi.fn() },
    disableHardwareAcceleration: vi.fn(),
    isPackaged: false,
    quit: vi.fn(),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: Function) => { ipcHandlers.set(channel, handler) }),
    on: vi.fn(),
  },
  BrowserWindow: MockBrowserWindow,
  clipboard: { writeText: vi.fn(), readText: vi.fn(() => ''), write: vi.fn() },
  dialog: {
    showSaveDialog: M.showSaveDialog,
    showOpenDialog: M.showOpenDialog,
    showMessageBox: vi.fn(async () => ({ response: 0, checkboxChecked: false })),
  },
  Menu: { setApplicationMenu: vi.fn() },
  nativeImage: { createFromPath: vi.fn(() => ({})), createFromBuffer: vi.fn(() => ({ isEmpty: () => true })) },
  globalShortcut: { register: vi.fn(), unregisterAll: vi.fn() },
  shell: { openExternal: vi.fn(async () => undefined), openPath: vi.fn(async () => '') },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8'),
  },
}))

// ---------------------------------------------------------------------------
// Service modules
// ---------------------------------------------------------------------------
vi.mock('../../src/main/sentry', () => ({ initMainSentry: vi.fn() }))

vi.mock('../../src/main/terminalManager', () => ({
  spawnTerminal: M.spawnTerminal,
  killTerminal: M.killTerminal,
  writeToTerminal: M.writeToTerminal,
  resizeTerminal: vi.fn(),
  killAll: M.killAll,
  getTerminalCwd: vi.fn(() => '/repo'),
  getTerminalCwdAsync: vi.fn(async () => '/repo'),
  getTerminalPid: vi.fn(() => 0),
  computeWindowsPty: vi.fn(() => undefined),
}))
vi.mock('../../src/main/shellDetector', () => ({ detectAvailableShells: M.detectAvailableShells }))
vi.mock('../../src/main/sessionStore', () => ({
  loadSession: vi.fn(() => ({ terminals: [] })), saveSession: vi.fn(),
}))
vi.mock('../../src/main/historyStore', () => ({ appendCommand: vi.fn(), searchHistory: vi.fn(() => []) }))
vi.mock('../../src/main/configFileManager', () => ({ readConfigFile: vi.fn(), writeConfigFile: vi.fn() }))
vi.mock('../../src/main/completionService', () => ({
  listPathEntries: vi.fn(() => []), listPathCommands: vi.fn(() => []), listEnvVars: vi.fn(() => []),
}))

// Real rule table, real settings, real scanner — only the audit SINK is a spy, because "what did
// we write to the audit log, and did the secret's VALUE appear in it" is exactly what we assert.
vi.mock('../../src/main/aiSecurity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/aiSecurity')>()
  return { ...actual, appendAudit: M.appendAudit }
})

vi.mock('../../src/main/mcpServer', () => ({
  startMcpServer: M.startMcpServer,
  stopMcpServer: M.stopMcpServer,
  getMcpAuthToken: vi.fn(() => 'fake-token'),
  getMcpPort: vi.fn(() => 9315),
  initAuditLog: vi.fn(),
  awaitMcpPortBound: vi.fn(() => Promise.resolve(9315)),
}))
vi.mock('../../src/main/swarmManager', () => ({
  sendMessage: vi.fn(), readMessages: vi.fn(() => []), getAllMessages: vi.fn(() => []),
  createTask: vi.fn(), listTasks: vi.fn(() => []), updateTask: M.updateTask, clearSwarm: vi.fn(),
}))
vi.mock('../../src/main/agentEventBus', () => ({
  initEventBus: vi.fn(),
  query: M.queryEvents,
  subscribe: vi.fn(),
  publish: M.publishEvent,
  getRingSize: M.getRingSize,
  getDroppedCount: M.getDroppedCount,
  shutdownEventBus: vi.fn(),
}))
vi.mock('../../src/main/transcriptWatchers', () => ({
  attachWatcher: M.attachWatcher, detachWatchers: M.detachWatchers, detachAll: vi.fn(),
}))
vi.mock('../../src/main/contextPinStore', () => ({
  initContextPinStore: vi.fn(),
  listPins: M.listPins, addPin: M.addPin, removePin: M.removePin,
  updatePin: M.updatePin, clearPins: M.clearPins,
}))
vi.mock('../../src/main/autoUpdater', () => ({ initAutoUpdater: M.initAutoUpdater }))
vi.mock('../../src/main/agentCommandSanitizer', () => ({ sanitizeAgentCommand: vi.fn((c: string) => c) }))
vi.mock('../../src/main/agentPaths', () => ({
  getAgentExtraPaths: M.getAgentExtraPaths,
  getExtendedPath: M.getExtendedPath,
  getInteractiveShellPath: vi.fn(() => ''),
  __resetShellPathCacheForTests: vi.fn(),
}))
vi.mock('../../src/main/groqKeyStore', () => ({
  getGroqKey: M.getGroqKey, setGroqKey: M.setGroqKey,
  getGroqKeyStatus: M.getGroqKeyStatus, clearGroqKey: M.clearGroqKey,
  groqKeyPath: vi.fn(() => '/tmp/groq'), maskKey: vi.fn(() => '••••'),
}))
vi.mock('../../src/main/groqTranscription', () => ({
  transcribeWithGroq: M.transcribeWithGroq, validateGroqKey: M.validateGroqKey,
}))
vi.mock('../../src/main/aiSessions', () => ({
  listAISessions: M.listAISessions,
  digestAISession: M.digestAISession,
  renderDigestAsPrompt: M.renderDigestAsPrompt,
}))
vi.mock('../../src/main/liveTranscript', () => ({
  readActiveTranscript: M.readActiveTranscript,
  readSessionTranscript: M.readSessionTranscript,
}))
vi.mock('../../src/main/memoryIndexer', () => ({ startIndexer: vi.fn(), stopIndexer: vi.fn() }))

const MEMC = vi.hoisted(() => ({
  initSwarmMemory: vi.fn(),
  memoryWrite: M.memoryWrite,
  memorySearch: vi.fn(() => []),
  memoryRelated: vi.fn(() => []),
  memoryLink: M.memoryLink,
  memoryGraphQuery: vi.fn(() => []),
  memoryFeedback: vi.fn(),
  memoryList: vi.fn(() => []),
  memoryCount: vi.fn(() => 0),
  memoryClear: vi.fn(),
  memoryHasHash: vi.fn(() => false),
  memoryStats: vi.fn(() => ({ total: 0 })),
  memoryDashboardStats: vi.fn(() => ({})),
  memoryGraphSample: vi.fn(() => ({ nodes: [], edges: [] })),
  memoryRecentActivity: vi.fn(() => []),
  embeddingsReady: vi.fn(() => true),
  memorySourceById: vi.fn(() => null),
  memoryDelete: vi.fn(),
  consolidationCandidates: vi.fn(() => []),
  consolidationSimOf: vi.fn(() => () => 0),
  memoryPatchProjects: vi.fn(),
  normalizeProjectSlug: vi.fn((p: string) => (p || '').split(/[\\/]/).filter(Boolean).pop() || ''),
  memoryLessons: vi.fn(() => []),
  memoryPruneCodePath: vi.fn(),
  warmProbeEmbeddings: M.warmProbeEmbeddings,
  compactSelfShard: M.compactSelfShard,
  setMemoryScrubber: M.setMemoryScrubber,
  weaveCandidates: vi.fn(() => []),
  weaveNeighbours: vi.fn(() => []),
  backfillCodeRefs: vi.fn(),
  symbolHistory: vi.fn(() => []),
  memoryArchive: vi.fn(),
  searchArchive: vi.fn(() => []),
  getSyncStatus: vi.fn(() => ({ enabled: false, dir: null })),
  setSyncDir: vi.fn((d: string | null) => ({ enabled: !!d, dir: d })),
  reloadMemoryFromSync: vi.fn(),
  setSyncPassphrase: M.setSyncPassphrase,
  disableSyncEncryption: vi.fn(() => ({ encrypted: false })),
  enableLocalEncryption: M.enableLocalEncryption,
  disableEncryption: M.disableEncryption,
  persistMemoryIndex: vi.fn(),
  entityDedupHash: vi.fn(() => 'entity-hash'),
  projectKeyOf: vi.fn((p: string) => p),
  contentHash: vi.fn((c: string) => `h:${c}`),
  canonicalEntityName: vi.fn((n: string) => n.trim()),
  vectorRamStats: vi.fn(async () => ({ bytes: 0 })),
  setVectorQuantization: vi.fn(async () => ({ bytes: 0 })),
  // memoryClient-only surface: the utilityProcess lifecycle + the batched calls that replace a
  // per-item RPC inside a sync planner/ingest loop.
  startMemoryHost: vi.fn(async () => 'host'),
  setMemoryHostSpawner: vi.fn(),
  createMemoryHostTransport: vi.fn(),
  stopMemoryHost: vi.fn(),
  memoryHostMode: vi.fn(() => 'host'),
  memoryKnownHashes: vi.fn(async () => [] as string[]),
  weaveNeighboursBatch: vi.fn(async () => ({}) as Record<string, unknown[]>),
  exportMemorySnapshot: vi.fn(async () => ''),
  importMemorySnapshot: vi.fn(async () => ({ imported: 0 })),
}))
// v1.26: index.ts + brainIpc talk to the store through memoryClient. Same object serves both, so the
// M.* spies the assertions below use keep working.
vi.mock('../../src/main/memoryClient', () => MEMC)
vi.mock('../../src/main/swarmMemory', () => MEMC)

vi.mock('child_process', () => ({
  default: { execSync: M.execSync, execFileSync: M.execFileSync, spawn: M.spawn },
  execSync: M.execSync,
  execFileSync: M.execFileSync,
  spawn: M.spawn,
}))

vi.mock('fs', () => {
  const impl = {
    writeFileSync: M.writeFileSync,
    existsSync: M.existsSync,
    readFileSync: vi.fn(() => '{}'),
    readdirSync: vi.fn(() => []),
    statSync: vi.fn(() => ({ isDirectory: () => false, isFile: () => true, mtimeMs: 0, size: 0 })),
    mkdirSync: vi.fn(),
    appendFileSync: vi.fn(),
    renameSync: vi.fn(),
    unlinkSync: vi.fn(),
    chmodSync: vi.fn(),
    watch: vi.fn(),
    promises: {
      unlink: M.fsUnlink,
      appendFile: vi.fn(async () => {}),
      readFile: vi.fn(async () => ''),
      writeFile: vi.fn(async () => {}),
      rename: vi.fn(async () => {}),
      mkdir: vi.fn(async () => {}),
    },
  }
  return { ...impl, default: impl }
})

vi.mock('uuid', () => ({ v4: vi.fn(() => 'mock-uuid') }))

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
function invoke(channel: string, args: unknown = {}): any {
  const handler = ipcHandlers.get(channel)
  if (!handler) throw new Error(`No handler for ${channel}`)
  return handler({}, args)
}

/** Callbacks index.ts hands to a collaborator are only reachable through the mock that got them. */
async function appCallback(name: string): Promise<Function> {
  const { app } = (await import('electron')) as any
  const call = app.on.mock.calls.find((c: unknown[]) => c[0] === name)
  if (!call) throw new Error(`app.on(${name}) was never registered`)
  return call[1]
}

async function hotkey(accelerator: string): Promise<Function> {
  const { globalShortcut } = (await import('electron')) as any
  const call = globalShortcut.register.mock.calls.find((c: unknown[]) => c[0] === accelerator)
  if (!call) throw new Error(`globalShortcut.register(${accelerator}) was never registered`)
  return call[1]
}

/** Run `fn` with process.platform forced, then restore. Handlers read platform at CALL time. */
async function withPlatform(platform: NodeJS.Platform, fn: () => Promise<void> | void): Promise<void> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  try { await fn() } finally { Object.defineProperty(process, 'platform', original) }
}

// A secret whose VALUE must never appear in an audit note or a renderer payload. Built from
// repeated characters so it satisfies the AWS rule's regex while failing the entropy heuristics
// GitHub push protection uses — a realistic-looking sample here would block the push.
const AWS_KEY = 'AKIA' + 'A'.repeat(16)

let exitSpy: ReturnType<typeof vi.spyOn>

beforeAll(async () => {
  // index.ts force-exits 500ms after the last window closes. That call is under test below, so it
  // must be a no-op for the whole file — a real process.exit would take the vitest worker with it.
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
  vi.resetModules()
  await import('../../src/main/index')
  await new Promise((resolve) => setTimeout(resolve, 50))
})

afterAll(() => { exitSpy.mockRestore() })

beforeEach(() => {
  M.appendAudit.mockClear()
  mockWebContents.send.mockClear()
  M.execSync.mockReset()
  M.spawn.mockReset()
  M.existsSync.mockReturnValue(false)
})

// ===========================================================================
// Voice — the Groq key lives in MAIN, encrypted in the OS keychain. The renderer
// must never be handed the key back, only a connected flag.
// ===========================================================================
describe('voice: Groq key vault IPC', () => {
  it('validate-key forwards the candidate key to the validator', async () => {
    M.validateGroqKey.mockResolvedValueOnce({ valid: true, models: 42 } as never)
    const r = await invoke('groq:validate-key', { key: 'gsk_candidate' })
    expect(r).toEqual({ success: true, data: { valid: true, models: 42 } })
    expect(M.validateGroqKey).toHaveBeenCalledWith('gsk_candidate')
  })

  it('validate-key sends an empty string (never undefined) when no key is supplied', async () => {
    // validateGroqKey does an auth round-trip; `undefined` would stringify into the header as the
    // literal "undefined" and look like a malformed key rather than a missing one.
    await invoke('groq:validate-key', {})
    expect(M.validateGroqKey).toHaveBeenCalledWith('')
  })

  it('validate-key surfaces a thrown Error as {success:false}', async () => {
    M.validateGroqKey.mockRejectedValueOnce(new Error('network down'))
    expect(await invoke('groq:validate-key', { key: 'k' })).toEqual({ success: false, error: 'network down' })
  })

  it('validate-key stringifies a non-Error rejection instead of crashing main', async () => {
    M.validateGroqKey.mockRejectedValueOnce('kaboom' as never)
    expect(await invoke('groq:validate-key', { key: 'k' })).toEqual({ success: false, error: 'kaboom' })
  })

  it('set-api-key persists under userData and returns ONLY a masked status, never the key', async () => {
    M.getGroqKeyStatus.mockReturnValueOnce({ connected: true, hint: '••••cret' } as never)
    const r = await invoke('groq:set-api-key', { key: 'gsk_supersecret' })
    expect(M.setGroqKey).toHaveBeenCalledWith(require('os').tmpdir(), 'gsk_supersecret')
    expect(r.success).toBe(true)
    expect(r.data).toEqual({ connected: true, hint: '••••cret' })
    // The whole point of keeping the key in main: it must not travel back over IPC.
    expect(JSON.stringify(r)).not.toContain('gsk_supersecret')
  })

  it('set-api-key coerces a missing key to empty string', async () => {
    await invoke('groq:set-api-key', {})
    expect(M.setGroqKey).toHaveBeenCalledWith(require('os').tmpdir(), '')
  })

  it('set-api-key reports a keychain failure rather than throwing into the renderer', async () => {
    M.setGroqKey.mockImplementationOnce(() => { throw new Error('keychain locked') })
    expect(await invoke('groq:set-api-key', { key: 'k' })).toEqual({ success: false, error: 'keychain locked' })
  })

  it('get-key-status reads status from userData, and reports read failure', async () => {
    M.getGroqKeyStatus.mockReturnValueOnce({ connected: true, hint: '••••1234' } as never)
    expect(await invoke('groq:get-key-status')).toEqual({ success: true, data: { connected: true, hint: '••••1234' } })

    M.getGroqKeyStatus.mockImplementationOnce(() => { throw new Error('unreadable') })
    expect(await invoke('groq:get-key-status')).toEqual({ success: false, error: 'unreadable' })
  })

  it('clear-api-key deletes the key and returns the now-disconnected status', async () => {
    M.getGroqKeyStatus.mockReturnValueOnce({ connected: false, hint: '' } as never)
    const r = await invoke('groq:clear-api-key')
    expect(M.clearGroqKey).toHaveBeenCalledWith(require('os').tmpdir())
    expect(r).toEqual({ success: true, data: { connected: false, hint: '' } })

    M.clearGroqKey.mockImplementationOnce(() => { throw new Error('delete failed') })
    expect(await invoke('groq:clear-api-key')).toEqual({ success: false, error: 'delete failed' })
  })
})

describe('voice: transcribe', () => {
  it('REFUSES to transcribe with no key — audio must never leave the machine unauthenticated', async () => {
    M.getGroqKey.mockReturnValueOnce(null)
    const r = await invoke('voice:transcribe', { pcm: [0.1, 0.2] })
    expect(r.success).toBe(false)
    expect(r.error).toContain('Groq is not connected')
    // The critical half: no key means no upload attempt at all.
    expect(M.transcribeWithGroq).not.toHaveBeenCalled()
  })

  it('marshals a plain number[] (what survives structured-clone over IPC) back into Float32Array', async () => {
    // The renderer captures Float32Array, but IPC may hand main a plain array. encodeWav indexes a
    // typed array; a plain array would silently produce garbage WAV rather than throw.
    M.transcribeWithGroq.mockClear()
    M.getGroqKey.mockReturnValueOnce('gsk_live')
    M.transcribeWithGroq.mockResolvedValueOnce({ text: 'from array' } as never)
    const r = await invoke('voice:transcribe', { pcm: [0.5, -0.5], model: 'whisper-large-v3' })
    expect(r).toEqual({ success: true, data: { text: 'from array' } })

    const [pcm, opts] = M.transcribeWithGroq.mock.calls[0] as [Float32Array, { apiKey: string; model?: string }]
    expect(pcm).toBeInstanceOf(Float32Array)
    expect(Array.from(pcm)).toEqual([0.5, -0.5])
    expect(opts).toEqual({ apiKey: 'gsk_live', model: 'whisper-large-v3' })
  })

  it('passes an existing Float32Array straight through (no needless copy)', async () => {
    M.transcribeWithGroq.mockClear()
    M.getGroqKey.mockReturnValueOnce('gsk_live')
    const pcm = new Float32Array([1, 2, 3])
    await invoke('voice:transcribe', { pcm })
    expect(M.transcribeWithGroq.mock.calls[0][0]).toBe(pcm)
  })

  it('reports an upload failure as {success:false}', async () => {
    M.getGroqKey.mockReturnValueOnce('gsk_live')
    M.transcribeWithGroq.mockRejectedValueOnce(new Error('429 rate limited'))
    expect(await invoke('voice:transcribe', { pcm: [] })).toEqual({ success: false, error: '429 rate limited' })
  })

  it('treats a missing pcm payload as empty audio, not undefined', async () => {
    M.transcribeWithGroq.mockClear()
    M.getGroqKey.mockReturnValueOnce('gsk_live')
    await invoke('voice:transcribe', {})
    const pcm = M.transcribeWithGroq.mock.calls[0][0] as Float32Array
    expect(pcm).toBeInstanceOf(Float32Array)
    expect(pcm.length).toBe(0)
  })
})

// A native keychain binding can `throw 'EPERM'` — a bare string, not an Error. Reading `.message`
// off that yields undefined, and the renderer would surface a blank error toast for a failure the
// user needs to act on. Every voice handler stringifies a non-Error instead.
describe('voice: a non-Error throw still produces a legible error', () => {
  it.each([
    ['groq:set-api-key', () => M.setGroqKey.mockImplementationOnce(() => { throw 'EPERM' })],
    ['groq:get-key-status', () => M.getGroqKeyStatus.mockImplementationOnce(() => { throw 'EACCES' })],
    ['groq:clear-api-key', () => M.clearGroqKey.mockImplementationOnce(() => { throw 'EBUSY' })],
  ])('%s', async (channel, arm) => {
    arm()
    const r = await invoke(channel, { key: 'k' })
    expect(r.success).toBe(false)
    expect(typeof r.error).toBe('string')
    expect(r.error).toMatch(/^E[A-Z]+$/) // the string itself, not "undefined"
  })

  it('voice:transcribe', async () => {
    M.getGroqKey.mockReturnValueOnce('gsk_live')
    M.transcribeWithGroq.mockRejectedValueOnce('ETIMEDOUT' as never)
    expect(await invoke('voice:transcribe', { pcm: [] })).toEqual({ success: false, error: 'ETIMEDOUT' })
  })
})

// ===========================================================================
// Past AI sessions + live transcript
// ===========================================================================
describe('aiSessions:list / conversation:read-active', () => {
  it('lists past sessions across all project folders', async () => {
    M.listAISessions.mockResolvedValueOnce([{ id: 'abc', cwd: '/repo' }] as never)
    expect(await invoke('aiSessions:list')).toEqual({ success: true, data: [{ id: 'abc', cwd: '/repo' }] })
  })

  it('reports a scan failure instead of throwing', async () => {
    M.listAISessions.mockRejectedValueOnce(new Error('projects dir unreadable'))
    expect(await invoke('aiSessions:list')).toEqual({ success: false, error: 'projects dir unreadable' })
  })

  it('read-active forwards cwd + agentType to the transcript reader', async () => {
    M.readActiveTranscript.mockResolvedValueOnce([{ role: 'assistant', text: 'ok' }] as never)
    const r = await invoke('conversation:read-active', { cwd: '/repo', agentType: 'claude' })
    expect(r).toEqual({ success: true, data: [{ role: 'assistant', text: 'ok' }] })
    expect(M.readActiveTranscript).toHaveBeenCalledWith('/repo', 'claude')
  })

  it('read-active defaults both args to empty strings when the renderer sends nothing', async () => {
    await invoke('conversation:read-active', {})
    expect(M.readActiveTranscript).toHaveBeenLastCalledWith('', '')
  })

  it('read-active surfaces a parse failure', async () => {
    M.readActiveTranscript.mockRejectedValueOnce(new Error('bad jsonl'))
    expect(await invoke('conversation:read-active', { cwd: '/r', agentType: 'claude' })).toEqual({
      success: false, error: 'bad jsonl',
    })
  })
})

// The digest handler reads an arbitrary renderer-supplied path off disk. The containment check is
// the only thing standing between "resume a past session" and "read any file on the machine".
describe('aiSessions:digest — path containment', () => {
  const projects = join(homedir(), '.claude', 'projects')

  it.each([
    ['', 'empty string'],
    [null, 'null'],
    [undefined, 'undefined'],
    [42, 'number'],
    [{ toString: () => join(projects, 'x.jsonl') }, 'object that stringifies to a legal path'],
  ])('rejects a non-string filePath (%s: %s)', async (filePath) => {
    M.digestAISession.mockClear()
    const r = await invoke('aiSessions:digest', filePath)
    expect(r.success).toBe(false)
    expect(r.error).toBe('filePath is required')
    expect(M.digestAISession).not.toHaveBeenCalled()
  })

  it.each([
    join(homedir(), '.ssh', 'id_rsa'),
    join(homedir(), '.claude', 'settings.json'),
    join(projects, '..', '..', '..', 'etc', 'passwd'),
    join(projects, '..', 'settings.json'),
  ])('refuses to read outside ~/.claude/projects: %s', async (evil) => {
    M.digestAISession.mockClear()
    const r = await invoke('aiSessions:digest', evil)
    expect(r.success).toBe(false)
    expect(r.error).toBe('filePath must be inside ~/.claude/projects')
    // The file is never opened — the guard runs BEFORE the read, not after.
    expect(M.digestAISession).not.toHaveBeenCalled()
  })

  it('reports an undigestible session rather than returning an empty prompt', async () => {
    M.digestAISession.mockResolvedValueOnce(null)
    const r = await invoke('aiSessions:digest', join(projects, 'proj', 'session.jsonl'))
    expect(r.success).toBe(false)
    expect(r.error).toContain('Could not digest session')
  })

  it('digests a session inside the projects root and renders it as a handoff prompt', async () => {
    const digest = { cwd: '/repo', turns: 3 }
    M.digestAISession.mockResolvedValueOnce(digest)
    M.renderDigestAsPrompt.mockReturnValueOnce('CONTINUE FROM HERE' as never)
    const target = join(projects, 'proj', 'session.jsonl')

    const r = await invoke('aiSessions:digest', target)

    expect(r).toEqual({ success: true, data: { digest, prompt: 'CONTINUE FROM HERE' } })
    expect(M.digestAISession).toHaveBeenCalledWith(target)
    expect(M.renderDigestAsPrompt).toHaveBeenCalledWith(digest)
  })

  it('surfaces a digest failure', async () => {
    M.digestAISession.mockRejectedValueOnce(new Error('corrupt transcript'))
    const r = await invoke('aiSessions:digest', join(projects, 'p', 's.jsonl'))
    expect(r).toEqual({ success: false, error: 'corrupt transcript' })
  })
})

// ===========================================================================
// Audit log lifecycle
// ===========================================================================
describe('aiSecurity:clear-audit', () => {
  it('DELETES the audit file and its rotated predecessor from disk', async () => {
    // "Clear" that only drops an in-memory view would leave the evidence trail on disk — the
    // opposite of what a user asking to clear their audit log expects.
    const status = await invoke('aiSecurity:get-status')
    const auditPath: string = status.data.auditPath
    expect(auditPath).toBeTruthy()

    M.fsUnlink.mockClear()
    M.existsSync.mockReturnValue(true)
    const r = await invoke('aiSecurity:clear-audit')
    M.existsSync.mockReturnValue(false)

    expect(r.success).toBe(true)
    const unlinked = M.fsUnlink.mock.calls.map((c) => c[0])
    expect(unlinked).toContain(auditPath)
    expect(unlinked.length).toBe(2) // current + rotated .prev
  })

  it('succeeds when there is no audit file to remove', async () => {
    M.fsUnlink.mockClear()
    expect((await invoke('aiSecurity:clear-audit')).success).toBe(true)
    expect(M.fsUnlink).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// Memory at-rest encryption + sync passphrase
// ===========================================================================
describe('memory: at-rest encryption IPC', () => {
  it('enable-local-encryption returns the store\'s new encryption state', async () => {
    M.enableLocalEncryption.mockReturnValueOnce({ encrypted: true, local: true } as never)
    const r = await invoke('memory:enable-local-encryption')
    expect(M.enableLocalEncryption).toHaveBeenCalledTimes(1)
    expect(r).toEqual({ success: true, data: { encrypted: true, local: true } })
  })

  it('enable-local-encryption reports a keychain failure instead of throwing', async () => {
    M.enableLocalEncryption.mockImplementationOnce(() => { throw new Error('no keychain') })
    expect(await invoke('memory:enable-local-encryption')).toEqual({ success: false, error: 'no keychain' })
  })

  it('disable-encryption decrypts and returns the new state', async () => {
    M.disableEncryption.mockReturnValueOnce({ encrypted: false } as never)
    const r = await invoke('memory:disable-encryption')
    expect(M.disableEncryption).toHaveBeenCalledTimes(1)
    expect(r).toEqual({ success: true, data: { encrypted: false } })
  })

  it('disable-encryption reports a decrypt failure instead of throwing', async () => {
    M.disableEncryption.mockImplementationOnce(() => { throw new Error('shard locked') })
    expect(await invoke('memory:disable-encryption')).toEqual({ success: false, error: 'shard locked' })
  })

  it('set-sync-passphrase coerces a missing passphrase to "" so the store, not a crash, rejects it', async () => {
    await invoke('memory:set-sync-passphrase', {})
    expect(M.setSyncPassphrase).toHaveBeenLastCalledWith('')

    await invoke('memory:set-sync-passphrase', { passphrase: 'correct horse' })
    expect(M.setSyncPassphrase).toHaveBeenLastCalledWith('correct horse')
  })
})

// ===========================================================================
// agents:detect — the InstallHint modal keys off this
// ===========================================================================
describe('agents:detect', () => {
  it('probes with `where` on Windows and `which` everywhere else', async () => {
    M.execSync.mockReturnValue(Buffer.from('C:\\npm\\claude.cmd'))
    await withPlatform('win32', async () => {
      await invoke('agents:detect')
    })
    expect(M.execSync.mock.calls.map((c) => c[0])).toContain('where claude')

    M.execSync.mockReset()
    M.execSync.mockReturnValue(Buffer.from('/usr/bin/claude'))
    await withPlatform('linux', async () => {
      await invoke('agents:detect')
    })
    const cmds = M.execSync.mock.calls.map((c) => c[0])
    expect(cmds).toContain('which claude')
    expect(cmds.every((c) => !String(c).startsWith('where '))).toBe(true)
  })

  it('reports every agent id the sidebar asks about, with gemini aliased to the agy CLI', async () => {
    M.execSync.mockReturnValue(Buffer.from('found'))
    const r = await invoke('agents:detect')
    expect(Object.keys(r.data).sort()).toEqual(['agy', 'claude', 'codex', 'gemini', 'qwen-code'])
    // Gemini's CLI IS agy now — the two ids must never disagree, or the sidebar offers a profile
    // whose binary Second Opinion says is missing.
    expect(r.data.gemini).toBe(r.data.agy)
  })

  it('still finds an agent whose binary exists when which/where is missing from PATH (issue #8)', async () => {
    // The macOS GUI-launch PATH gap: a GUI-launched Electron app can have a PATH with no `which`
    // at all, so the probe throws for an agent that IS installed. The belt-and-braces scan of the
    // known install dirs is the only thing that stops the sidebar claiming Claude isn't installed.
    // findAgentInstalled reads fs through `require('fs')`, which bypasses vi.mock — so this drives
    // it against a REAL directory, which is the honest way to prove the fallback.
    const realFs = await vi.importActual<typeof import('fs')>('fs')
    const os = await vi.importActual<typeof import('os')>('os')
    const binDir = realFs.mkdtempSync(join(os.tmpdir(), 'tp-agents-'))
    realFs.writeFileSync(join(binDir, 'claude'), '#!/bin/sh\n') // installed
    // …and deliberately NO `codex` binary in the same dir.

    M.execSync.mockImplementation(() => { throw new Error('which: command not found') })
    M.getAgentExtraPaths.mockReturnValue([binDir])
    try {
      await withPlatform('linux', async () => {
        const r = await invoke('agents:detect')
        expect(r.data.claude).toBe(true) // probe failed, direct scan saved it
        expect(r.data.codex).toBe(false) // and it does not just say "yes" to everything
      })
    } finally {
      M.getAgentExtraPaths.mockReturnValue(['/opt/agent-bin'])
      realFs.rmSync(binDir, { recursive: true, force: true })
    }
  })

  it('TERMPOLIS_FORCE_MISSING_AGENTS forces an installed agent to report as missing', async () => {
    // The e2e hook that lets Playwright open the InstallHint modal deterministically. It has to
    // win over a real detection, or the modal never opens on a dev box that has the agent.
    M.execSync.mockReturnValue(Buffer.from('/usr/bin/claude')) // detection would say "installed"
    process.env.TERMPOLIS_FORCE_MISSING_AGENTS = 'claude, qwen-code'
    try {
      const r = await invoke('agents:detect')
      expect(r.data.claude).toBe(false)
      expect(r.data['qwen-code']).toBe(false)
      expect(r.data.codex).toBe(true) // untouched
    } finally {
      delete process.env.TERMPOLIS_FORCE_MISSING_AGENTS
    }
  })
})

// ===========================================================================
// Agent activity event bus
// ===========================================================================
describe('agentActivity IPC', () => {
  it('query passes the renderer\'s filter through to the ring', async () => {
    const events = [{ id: 'e1', kind: 'tool_call' }]
    M.queryEvents.mockReturnValueOnce(events as never)
    const filter = { agentType: 'claude', since: 123, limit: 10 }
    const r = await invoke('agentActivity:query', { filter })
    expect(r).toEqual({ success: true, data: events })
    expect(M.queryEvents).toHaveBeenCalledWith(filter)
  })

  it('query with no filter asks for everything (never undefined)', async () => {
    await invoke('agentActivity:query', {})
    expect(M.queryEvents).toHaveBeenLastCalledWith({})
    // …and with no payload at all — the default-arg path.
    const handler = ipcHandlers.get('agentActivity:query')!
    await handler({})
    expect(M.queryEvents).toHaveBeenLastCalledWith({})
  })

  it('query reports a ring failure instead of throwing', async () => {
    M.queryEvents.mockImplementationOnce(() => { throw new Error('ring corrupt') })
    expect(await invoke('agentActivity:query', {})).toEqual({ success: false, error: 'ring corrupt' })
  })

  it('stats exposes ring occupancy AND the dropped count', async () => {
    // `dropped` is the only signal that the feed is lying by omission — a ring that silently
    // overwrites is indistinguishable from a quiet agent without it.
    M.getRingSize.mockReturnValueOnce(512 as never)
    M.getDroppedCount.mockReturnValueOnce(37 as never)
    expect(await invoke('agentActivity:stats')).toEqual({
      success: true, data: { ringSize: 512, dropped: 37 },
    })
  })

  it('stats reports a failure instead of throwing', async () => {
    M.getRingSize.mockImplementationOnce(() => { throw new Error('bus down') })
    expect(await invoke('agentActivity:stats')).toEqual({ success: false, error: 'bus down' })
  })
})

// The __test_ seams are registered ONLY under NODE_ENV=test. They exist so e2e can drive the real
// push path; production must have no way to inject a synthetic agent event.
describe('agentActivity + terminal test seams (NODE_ENV=test only)', () => {
  it('__test_publish pushes the event through the REAL bus', async () => {
    const event = { kind: 'tool_call', agentType: 'claude', terminalId: 't1', summary: 'Read(x)' }
    const r = await invoke('agentActivity:__test_publish', { event })
    expect(r).toEqual({ success: true, data: true })
    expect(M.publishEvent).toHaveBeenCalledWith(event)
  })

  it('__test_publish refuses a non-object event and publishes nothing', async () => {
    M.publishEvent.mockClear()
    for (const bad of [undefined, null, 'string', 42]) {
      const r = await invoke('agentActivity:__test_publish', { event: bad })
      expect(r).toEqual({ success: false, error: 'event required' })
    }
    // …and with no payload at all.
    const handler = ipcHandlers.get('agentActivity:__test_publish')!
    expect(await handler({})).toEqual({ success: false, error: 'event required' })
    expect(M.publishEvent).not.toHaveBeenCalled()
  })

  it('__test_publish reports a bus rejection', async () => {
    M.publishEvent.mockImplementationOnce(() => { throw new Error('bus closed') })
    expect(await invoke('agentActivity:__test_publish', { event: { kind: 'message' } })).toEqual({
      success: false, error: 'bus closed',
    })
  })

  it('terminal:__test_data feeds synthetic bytes down the same channel the PTY uses', async () => {
    const r = await invoke('terminal:__test_data', { id: 't9', data: 'Compacting conversation…' })
    expect(r).toEqual({ success: true, data: true })
    expect(mockWebContents.send).toHaveBeenCalledWith('terminal:data', 't9', 'Compacting conversation…')
  })

  it('terminal:__test_data sends empty bytes rather than undefined when data is omitted', async () => {
    await invoke('terminal:__test_data', { id: 't9' })
    expect(mockWebContents.send).toHaveBeenLastCalledWith('terminal:data', 't9', '')
  })

  it('terminal:__test_data with no id is a no-op, not a crash', async () => {
    const handler = ipcHandlers.get('terminal:__test_data')!
    expect(await handler({})).toEqual({ success: true, data: true })
    expect(mockWebContents.send).not.toHaveBeenCalledWith('terminal:data', undefined, '')
  })

  it('terminal:__test_writes reads back the raw bytes a re-prime paste actually wrote', async () => {
    const { ipcMain } = (await import('electron')) as any
    const write = ipcMain.on.mock.calls.find((c: unknown[]) => c[0] === 'terminal:write')![1]
    write({}, { id: 'reprime-1', data: '/resume abc\r' })

    const r = await invoke('terminal:__test_writes')
    expect(r.success).toBe(true)
    expect(r.data).toContainEqual({ id: 'reprime-1', data: '/resume abc\r' })
    // The recorder is a shadow copy — the bytes still reached the PTY unmodified.
    expect(M.writeToTerminal).toHaveBeenCalledWith('reprime-1', '/resume abc\r')
  })
})

// ===========================================================================
// Context pins
// ===========================================================================
describe('contextPins IPC', () => {
  it('list returns the pins for the given project cwd', async () => {
    const pins = [{ id: 'p1', label: 'API key location', body: 'src/main' }]
    M.listPins.mockReturnValueOnce(pins as never)
    const r = await invoke('contextPins:list', { cwd: '/repo' })
    expect(r).toEqual({ success: true, data: pins })
    expect(M.listPins).toHaveBeenCalledWith('/repo')
  })

  it('add forwards cwd and the pin body verbatim', async () => {
    const input = { label: 'Deploy', body: 'npm run release', tags: ['ops'] }
    M.addPin.mockReturnValueOnce({ id: 'p2', ...input } as never)
    const r = await invoke('contextPins:add', { cwd: '/repo', input })
    expect(M.addPin).toHaveBeenCalledWith('/repo', input)
    expect(r.data).toMatchObject({ id: 'p2', label: 'Deploy' })
  })

  it('add reports a store rejection (e.g. over the per-project pin cap)', async () => {
    M.addPin.mockImplementationOnce(() => { throw new Error('too many pins') })
    expect(await invoke('contextPins:add', { cwd: '/repo', input: {} })).toEqual({
      success: false, error: 'too many pins',
    })
  })

  it('update returns the patched pin', async () => {
    M.updatePin.mockReturnValueOnce({ id: 'p1', label: 'renamed' } as never)
    const r = await invoke('contextPins:update', { cwd: '/repo', id: 'p1', patch: { label: 'renamed' } })
    expect(M.updatePin).toHaveBeenCalledWith('/repo', 'p1', { label: 'renamed' })
    expect(r).toEqual({ success: true, data: { id: 'p1', label: 'renamed' } })
  })

  it('update of an unknown id is an ERROR, not a silent success', async () => {
    // A silent success here would let the UI render an edit that was never persisted.
    M.updatePin.mockReturnValueOnce(null)
    expect(await invoke('contextPins:update', { cwd: '/repo', id: 'ghost', patch: {} })).toEqual({
      success: false, error: 'pin not found',
    })
  })

  it('remove reports whether anything was actually removed', async () => {
    M.removePin.mockReturnValueOnce(true as never)
    expect(await invoke('contextPins:remove', { cwd: '/repo', id: 'p1' })).toEqual({
      success: true, data: { removed: true },
    })
    M.removePin.mockReturnValueOnce(false as never)
    expect(await invoke('contextPins:remove', { cwd: '/repo', id: 'gone' })).toEqual({
      success: true, data: { removed: false },
    })
  })

  it('clear wipes only the given project\'s pins', async () => {
    const r = await invoke('contextPins:clear', { cwd: '/repo' })
    expect(r.success).toBe(true)
    expect(M.clearPins).toHaveBeenCalledWith('/repo')
  })

  it('clear reports a store failure', async () => {
    M.clearPins.mockImplementationOnce(() => { throw new Error('store locked') })
    expect(await invoke('contextPins:clear', { cwd: '/repo' })).toEqual({ success: false, error: 'store locked' })
  })
})

// ===========================================================================
// Transcript watchers
// ===========================================================================
describe('agentWatcher IPC', () => {
  it('attach reports TRUE only when a watcher was actually created', async () => {
    M.attachWatcher.mockReturnValueOnce({ close: () => {} })
    const r = await invoke('agentWatcher:attach', { terminalId: 't1', cwd: '/repo', agentType: 'claude' })
    expect(M.attachWatcher).toHaveBeenCalledWith('t1', '/repo', 'claude')
    expect(r).toEqual({ success: true, data: { attached: true } })
  })

  it('attach reports FALSE when no transcript exists to watch', async () => {
    // The renderer uses this to decide whether to show the live-activity feed. Reporting
    // attached:true for a null handle would leave it waiting on a feed that can never arrive.
    M.attachWatcher.mockReturnValueOnce(null)
    expect(await invoke('agentWatcher:attach', { terminalId: 't2', cwd: '/x', agentType: 'codex' })).toEqual({
      success: true, data: { attached: false },
    })
  })

  it('attach surfaces a watcher failure', async () => {
    M.attachWatcher.mockImplementationOnce(() => { throw new Error('EMFILE') })
    expect(await invoke('agentWatcher:attach', { terminalId: 't3', cwd: '/x', agentType: 'claude' })).toEqual({
      success: false, error: 'EMFILE',
    })
  })

  it('detach releases the watchers for one terminal only', async () => {
    const r = await invoke('agentWatcher:detach', { terminalId: 't1' })
    expect(r.success).toBe(true)
    expect(M.detachWatchers).toHaveBeenCalledWith('t1')
  })

  it('detach surfaces a failure', async () => {
    M.detachWatchers.mockImplementationOnce(() => { throw new Error('already closed') })
    expect(await invoke('agentWatcher:detach', { terminalId: 't1' })).toEqual({
      success: false, error: 'already closed',
    })
  })
})

// ===========================================================================
// Memory-at-rest secret scrub — installing this scrubber IS the security boundary.
// ===========================================================================
describe('memory scrub: the brain never stores a secret verbatim', () => {
  /** The scrubber index.ts installed into the store at startup. */
  function scrubber(): (content: string) => { redacted: string; hitCount: number } {
    expect(M.setMemoryScrubber).toHaveBeenCalled()
    return M.setMemoryScrubber.mock.calls[0][0] as never
  }

  it('is installed at startup — with none installed the store keeps content verbatim', () => {
    expect(M.setMemoryScrubber).toHaveBeenCalledTimes(1)
    expect(typeof scrubber()).toBe('function')
  })

  it('REDACTS a secret before it is hashed, embedded or written to disk', async () => {
    expect((await invoke('aiSecurity:get-status')).data.settings.memoryScrub).toBe(true)

    const content = `deploy notes\nAWS_ACCESS_KEY_ID=${AWS_KEY}\nall good`
    const out = scrubber()(content)

    expect(out.hitCount).toBeGreaterThan(0)
    // The actual invariant: the key's value is gone from what the store will persist. If it
    // survived here it would be recallable back into an agent's context forever.
    expect(out.redacted).not.toContain(AWS_KEY)
    expect(out.redacted).toContain('deploy notes') // …without eating the surrounding text
  })

  it('audits WHAT leaked by rule name — never the value', async () => {
    M.appendAudit.mockClear()
    scrubber()(`key = "${AWS_KEY}"`)

    const entry = M.appendAudit.mock.calls.map((c) => c[0]).find((e: any) => e?.event === 'memory_scrub')
    expect(entry).toBeDefined()
    expect(entry.hitCount).toBeGreaterThan(0)
    expect(entry.agent).toBe('memory')
    // An audit log full of secret fragments is just a second place the secret leaked to.
    expect(JSON.stringify(entry)).not.toContain(AWS_KEY)
  })

  it('writes NO audit entry for clean content', () => {
    M.appendAudit.mockClear()
    const out = scrubber()('just a normal note about the parser')
    expect(out.hitCount).toBe(0)
    expect(out.redacted).toBe('just a normal note about the parser')
    expect(M.appendAudit.mock.calls.some((c: any[]) => c[0]?.event === 'memory_scrub')).toBe(false)
  })

  it('turning the memoryScrub gate OFF stores content verbatim — the gate is real, not cosmetic', async () => {
    expect((await invoke('aiSecurity:set-memory-scrub', { value: false })).data.memoryScrub).toBe(false)
    try {
      const content = `AWS_ACCESS_KEY_ID=${AWS_KEY}`
      expect(scrubber()(content)).toEqual({ redacted: content, hitCount: 0 })
    } finally {
      // Restore the secure default — later tests (and the shipped default) rely on it.
      expect((await invoke('aiSecurity:set-memory-scrub', { value: true })).data.memoryScrub).toBe(true)
    }
  })

  it('still redacts when the AUDIT write fails — logging is best-effort, redaction is not', async () => {
    // A full disk must not silently turn the scrubber into a pass-through. The audit entry is a
    // nice-to-have; the redaction is the security control.
    M.appendAudit.mockRejectedValueOnce(new Error('ENOSPC: no space left on device'))
    const out = scrubber()(`AWS_ACCESS_KEY_ID=${AWS_KEY}`)
    expect(out.hitCount).toBeGreaterThan(0)
    expect(out.redacted).not.toContain(AWS_KEY)
  })
})

describe('aiSecurity:set-audit', () => {
  it('enabling the audit log succeeds even when the "monitoring started" marker cannot be written', async () => {
    // The toggle must not be held hostage by an audit-write failure — otherwise a transient disk
    // error leaves the user unable to turn monitoring ON at all.
    M.appendAudit.mockRejectedValueOnce(new Error('ENOSPC'))
    const r = await invoke('aiSecurity:set-audit', { value: true })
    expect(r.success).toBe(true)
    expect(r.data.auditEnabled).toBe(true)
    // It did try to stamp the moment monitoring started.
    expect(M.appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'system', event: 'manual_scan', notes: 'audit log enabled' }),
    )
  })
})

// ===========================================================================
// MCP tool handlers — the surface AI agents actually drive
// ===========================================================================
describe('MCP tool handlers', () => {
  /** The handler table index.ts handed to the MCP server at startup. */
  function mcp(): any {
    expect(M.startMcpServer).toHaveBeenCalled()
    return M.startMcpServer.mock.calls[0][0]
  }

  it('read_output is capped at 32KB and keeps the MOST RECENT bytes, not the oldest', async () => {
    // An agent reading its own terminal wants what just happened. Trimming the tail instead of the
    // head would hand it 32KB of stale scrollback and hide the output it is waiting on.
    M.spawnTerminal.mockClear()
    const id = await mcp().createTerminal('agent-1', 'powershell', '/repo')
    expect(id).toBe('mock-uuid')

    const onData = M.spawnTerminal.mock.calls[0][3] as (d: string) => void
    onData('O'.repeat(20_000)) // oldest
    onData('N'.repeat(20_000)) // newest — total 40,000 > 32,768

    const r = await invoke('terminal:read-buffer', { terminalId: id, fromOffset: 0 })
    expect(r.data.length).toBe(32_768)
    expect(r.data.output.endsWith('N'.repeat(100))).toBe(true)
    // 20k N's survive in full; only the OLD bytes were dropped.
    expect((r.data.output.match(/N/g) ?? []).length).toBe(20_000)
    expect((r.data.output.match(/O/g) ?? []).length).toBe(12_768)
  })

  it('createTerminal tells the renderer to adopt the terminal it just spawned', async () => {
    mockWebContents.send.mockClear()
    await mcp().createTerminal('agent-2', 'powershell', '/repo')
    expect(mockWebContents.send).toHaveBeenCalledWith('mcp:terminal-created', {
      id: 'mock-uuid', name: 'agent-2', shell: 'powershell', cwd: '/repo',
    })
  })
})

// ===========================================================================
// Mneme reflex — a finished swarm task is an episode the brain learns from.
// This is the whole point of the learning layer: the lesson is distilled and
// stored so the next agent doesn't have to re-derive it.
// ===========================================================================
describe('Mneme reflex on task completion', () => {
  function mcp(): any { return M.startMcpServer.mock.calls[0][0] }

  const FIXED = 'I fixed it by pre-warming the embedder in `globalSetup.ts`. Root cause was the cold model load.'

  beforeEach(() => {
    M.memoryWrite.mockClear()
    M.memoryLink.mockClear()
    M.updateTask.mockReset()
  })

  it('distills the RESULT of a completed task into a stored lesson', async () => {
    M.updateTask.mockReturnValue({
      id: 'task-7',
      title: 'Fix the flaky vector test',
      description: 'memoryEmbeddings kept timing out in CI and failing the run',
      result: FIXED,
      project: '/repos/termpolis',
    })

    const task = mcp().swarmUpdateTask('task-7', 'completed', FIXED)
    expect(task).toMatchObject({ id: 'task-7' })

    // Reflection is fire-and-forget — it must never delay the task update, so we wait for it.
    await vi.waitFor(() => expect(M.memoryWrite).toHaveBeenCalled())

    const written = M.memoryWrite.mock.calls.map((c) => c[0] as Record<string, unknown>)
    // What lands in the brain is a DISTILLED lesson, not a verbatim dump of the task.
    expect(written.some((w) => /globalSetup|pre-warming|cold model/i.test(String(w.content)))).toBe(true)
    // …and it is typed as a lesson, so recall can rank it above raw chatter.
    expect(written.some((w) => ['procedural', 'semantic', 'episodic', 'entity'].includes(String(w.memoryType)))).toBe(true)
  })

  it('reflects a task with no id and no explicit result, falling back to the task\'s own fields', async () => {
    // The MCP client may update a task without echoing the result back; the stored task still has
    // it. Losing the result here would mean reflecting on an empty episode.
    M.updateTask.mockReturnValue({
      title: 'Investigate the ENOENT on startup',
      description: 'the app throws ENOENT reading the model file and refuses to boot',
      result: FIXED,
      // deliberately: no id, no project
    })

    mcp().swarmUpdateTask('whatever', 'failed') // NOTE: no `result` argument

    await vi.waitFor(() => expect(M.memoryWrite).toHaveBeenCalled())
    const written = M.memoryWrite.mock.calls.map((c) => c[0] as Record<string, unknown>)
    expect(written.some((w) => /globalSetup|cold model/i.test(String(w.content)))).toBe(true)
  })

  it('does NOT reflect on an in-flight status — only a finished task is an episode', async () => {
    // Reflecting on every progress ping would fill the brain with half-finished noise.
    M.updateTask.mockReturnValue({ id: 't', title: 'x', description: 'y', result: FIXED, project: '/repo' })
    mcp().swarmUpdateTask('t', 'in_progress')
    await new Promise((r) => setTimeout(r, 30))
    expect(M.memoryWrite).not.toHaveBeenCalled()
  })

  it('rejects an unknown status instead of inventing one', async () => {
    expect(() => mcp().swarmUpdateTask('t', 'exploded')).toThrow(/Invalid task status/)
  })
})

// ===========================================================================
// Window + app lifecycle
// ===========================================================================
describe('auto-updater wiring', () => {
  it('hands the updater a LIVE window getter, not a snapshot', async () => {
    // The updater sends download progress to whatever window exists when the download finishes —
    // capturing `mainWindow` by value at startup would send it into a stale (or null) reference.
    expect(M.initAutoUpdater).toHaveBeenCalledTimes(1)
    const [getWindow, opts] = M.initAutoUpdater.mock.calls[0] as [() => unknown, { onBeforeQuitAndInstall: () => void }]
    expect(getWindow()).toBe(mockMainWindow)
    expect(typeof opts.onBeforeQuitAndInstall).toBe('function')
    // Arming the update-restart bypass must not throw — it is called from inside quitAndInstall.
    expect(() => opts.onBeforeQuitAndInstall()).not.toThrow()
  })
})

describe('global hotkeys work even when the window is minimized', () => {
  beforeEach(() => {
    mockMainWindow.restore.mockClear()
    mockMainWindow.focus.mockClear()
    mockMainWindow.isMinimized.mockReturnValue(true)
  })
  afterAll(() => { mockMainWindow.isMinimized.mockReturnValue(false) })

  it('Super+Shift+T restores + focuses the window, then asks for a new terminal', async () => {
    ;(await hotkey('Super+Shift+T'))()
    expect(mockMainWindow.restore).toHaveBeenCalledTimes(1)
    expect(mockMainWindow.focus).toHaveBeenCalledTimes(1)
    expect(mockWebContents.send).toHaveBeenCalledWith('global:new-terminal')
  })

  it('Super+Shift+S restores + focuses the window, then toggles the swarm dashboard', async () => {
    ;(await hotkey('Super+Shift+S'))()
    expect(mockMainWindow.restore).toHaveBeenCalledTimes(1)
    expect(mockWebContents.send).toHaveBeenCalledWith('global:toggle-swarm')
  })

  it('does NOT call restore when the window is already visible', async () => {
    mockMainWindow.isMinimized.mockReturnValue(false)
    ;(await hotkey('Super+Shift+T'))()
    expect(mockMainWindow.restore).not.toHaveBeenCalled()
    expect(mockMainWindow.focus).toHaveBeenCalledTimes(1)
  })
})

describe('second-instance: relaunching Termpolis surfaces the existing window', () => {
  it('restores a minimized window instead of opening a second one', async () => {
    // Two windows would race on the same session file. The lock makes the 2nd launch a "focus me".
    mockMainWindow.restore.mockClear()
    mockMainWindow.focus.mockClear()
    mockMainWindow.isMinimized.mockReturnValue(true)
    try {
      ;(await appCallback('second-instance'))()
      expect(mockMainWindow.restore).toHaveBeenCalledTimes(1)
      expect(mockMainWindow.focus).toHaveBeenCalledTimes(1)
    } finally {
      mockMainWindow.isMinimized.mockReturnValue(false)
    }
  })
})

// Ordering matters here and is deliberate: window-all-closed nulls the MCP server handle, so the
// later before-quit exercises the already-stopped path. Both run against THIS file's module
// instance, so they cannot disturb the other suites.
describe('shutdown', () => {
  it('macOS keeps the app alive with no windows, but still stops the MCP server', async () => {
    const { app } = (await import('electron')) as any
    app.quit.mockClear()
    M.stopMcpServer.mockClear()
    M.killAll.mockClear()

    await withPlatform('darwin', async () => {
      ;(await appCallback('window-all-closed'))()
    })

    expect(M.killAll).toHaveBeenCalledTimes(1)
    // The MCP server is torn down regardless of platform — a stray listener would hold the port.
    expect(M.stopMcpServer).toHaveBeenCalledWith({ id: 'mcp-server-handle' })
    // …but the app itself stays running, which is the macOS convention.
    expect(app.quit).not.toHaveBeenCalled()
  })

  it('elsewhere it quits AND force-exits, because a live PTY/MCP handle can outlive app.quit()', async () => {
    const { app } = (await import('electron')) as any
    app.quit.mockClear()
    exitSpy.mockClear()
    vi.useFakeTimers()
    try {
      await withPlatform('win32', async () => {
        ;(await appCallback('window-all-closed'))()
      })
      expect(app.quit).toHaveBeenCalledTimes(1)
      // The escape hatch has not fired yet — app.quit() gets its chance first.
      expect(exitSpy).not.toHaveBeenCalled()
      vi.advanceTimersByTime(500)
      expect(exitSpy).toHaveBeenCalledWith(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('before-quit tears down shortcuts + terminals and tolerates an already-stopped MCP server', async () => {
    const { globalShortcut } = (await import('electron')) as any
    globalShortcut.unregisterAll.mockClear()
    M.killAll.mockClear()
    M.stopMcpServer.mockClear()

    expect(() => (ipcHandlers, 0)).not.toThrow()
    ;(await appCallback('before-quit'))()

    expect(globalShortcut.unregisterAll).toHaveBeenCalledTimes(1)
    expect(M.killAll).toHaveBeenCalledTimes(1)
    // window-all-closed already nulled the handle — a second stop would throw inside electron.
    expect(M.stopMcpServer).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// Second Opinion — an UNTRUSTED, terminal-scraped prompt is handed to another agent.
// ===========================================================================
class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
}

describe('agent:second-opinion — the scraped prompt never reaches a shell', () => {
  function armSpawn(drive: (c: FakeChild) => void): FakeChild {
    const child = new FakeChild()
    M.spawn.mockImplementation(() => {
      setImmediate(() => drive(child))
      return child as never
    })
    return child
  }

  it('on POSIX execs the agent binary directly — no shell, no temp prompt file', async () => {
    M.writeFileSync.mockClear()
    armSpawn((c) => { c.stdout.emit('data', Buffer.from('Looks good.')); c.emit('close', 0) })

    let r: any
    await withPlatform('linux', async () => {
      r = await invoke('agent:second-opinion', { agent: 'claude', content: 'diff --git a/x b/x' })
    })

    expect(r).toEqual({ success: true, data: { feedback: 'Looks good.' } })
    const [cmd, argv, opts] = M.spawn.mock.calls[0] as [string, string[], { windowsHide: boolean; stdio: string[] }]
    // The binary itself, not powershell/cmd/sh — so no argv token can ever be re-parsed.
    expect(cmd).toBe('claude')
    expect(['sh', 'bash', 'cmd', 'cmd.exe', 'powershell', 'powershell.exe']).not.toContain(cmd)
    expect(argv.some((a) => a.includes('diff --git'))).toBe(true) // prompt travels as ONE argv entry
    // stdin closed immediately: `codex exec` blocks forever reading stdin otherwise.
    expect(opts.stdio[0]).toBe('ignore')
    // The temp-file dance is Windows-only; on POSIX nothing is written to disk.
    expect(M.writeFileSync).not.toHaveBeenCalled()
  })

  it('reports a killed review (null exit code) as a failure, never as empty success', async () => {
    // spawn's `timeout` kills a runaway agent and closes with code null. Coercing that to 0 would
    // hand the user an empty "review" and claim it succeeded.
    armSpawn((c) => { c.emit('close', null) })

    let r: any
    await withPlatform('linux', async () => {
      r = await invoke('agent:second-opinion', { agent: 'codex', content: 'x' })
    })
    expect(r.success).toBe(false)
    expect(r.error).toContain('1') // exited with code 1
  })

  it('settles exactly once when the child both errors and closes', async () => {
    // spawn can emit 'error' (ENOENT) AND then 'close'. Resolving twice is a silent double-settle;
    // the guard is what keeps the handler from returning a torn result.
    armSpawn((c) => {
      c.emit('error', new Error('spawn claude ENOENT'))
      c.emit('close', 1)
    })

    let r: any
    await withPlatform('linux', async () => {
      r = await invoke('agent:second-opinion', { agent: 'gemini', content: 'y' })
    })
    expect(r.success).toBe(false)
    expect(r.error).toContain('ENOENT')
  })

  it('treats missing content as empty rather than sending "undefined" to another model', async () => {
    armSpawn((c) => { c.stdout.emit('data', Buffer.from('ok')); c.emit('close', 0) })
    let r: any
    await withPlatform('linux', async () => {
      r = await invoke('agent:second-opinion', { agent: 'qwen' })
    })
    expect(r.success).toBe(true)
    const argv = M.spawn.mock.calls[0][1] as string[]
    expect(argv.join(' ')).not.toContain('undefined')
  })
})

// ===========================================================================
// No window open. Everything below runs against a torn-down window, so it must
// stay at the END of the file — later tests would have nothing to talk to.
// ===========================================================================
describe('after the window is closed', () => {
  it('global hotkeys and a second launch become safe no-ops, and activate brings the window back', async () => {
    const closed = mockMainWindow.on.mock.calls.find((c: unknown[]) => c[0] === 'closed')![1] as () => void
    closed() // this is what index.ts does on the real 'closed' event: mainWindow = null

    mockWebContents.send.mockClear()
    mockMainWindow.focus.mockClear()
    mockMainWindow.restore.mockClear()

    // A hotkey pressed while no window exists must not throw inside the accelerator callback —
    // an exception there is swallowed by Electron and the shortcut silently dies for the session.
    ;(await hotkey('Super+Shift+T'))()
    ;(await hotkey('Super+Shift+S'))()
    ;(await appCallback('second-instance'))()
    expect(mockWebContents.send).not.toHaveBeenCalled()
    expect(mockMainWindow.focus).not.toHaveBeenCalled()
    expect(mockMainWindow.restore).not.toHaveBeenCalled()

    // macOS dock click / relaunch: activate re-creates the window…
    ;(await appCallback('activate'))()
    // …and the hotkeys work again against the new one.
    ;(await hotkey('Super+Shift+T'))()
    expect(mockWebContents.send).toHaveBeenCalledWith('global:new-terminal')
  })
})

// ===========================================================================
// Startup scheduling + the single-instance lock. Both re-import index.ts with a
// fresh module registry, so they must be the LAST describes in the file.
// ===========================================================================
describe('startup keeps slow work OFF the launch path', () => {
  it('defers the embedder warm-up 20s and compacts this device\'s shard every 30 min', async () => {
    // This IS the typing-lag fix: loading the embedding model on the startup path pins the main
    // thread that also pumps PTY echo, so the first keystrokes after launch stutter. Warm-up must
    // be scheduled, not awaited.
    vi.useFakeTimers()
    try {
      M.warmProbeEmbeddings.mockClear()
      M.compactSelfShard.mockClear()
      vi.resetModules()
      await import('../../src/main/index')
      await vi.advanceTimersByTimeAsync(0) // let app.whenReady().then(...) flush

      expect(M.warmProbeEmbeddings).not.toHaveBeenCalled() // NOT on the launch path
      await vi.advanceTimersByTimeAsync(20_000)
      expect(M.warmProbeEmbeddings).toHaveBeenCalledTimes(1)

      expect(M.compactSelfShard).not.toHaveBeenCalled() // and compaction is not a startup cost
      await vi.advanceTimersByTimeAsync(30 * 60_000)
      expect(M.compactSelfShard).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('single-instance lock', () => {
  it('a second Termpolis quits immediately instead of racing the first on the session file', async () => {
    // The electron mock survives resetModules, so scope the spies to what the SECOND instance does.
    const { app } = (await import('electron')) as any
    app.quit.mockClear()
    app.on.mockClear()
    M.startMcpServer.mockClear()
    M.singleInstanceLock.mockReturnValue(false)

    vi.resetModules()
    await import('../../src/main/index')

    expect(app.quit).toHaveBeenCalledTimes(1)
    // …and it claims none of the lifecycle: no shutdown hooks and no second MCP server fighting
    // the first instance for the port and the session file.
    expect(app.on.mock.calls.map((c: unknown[]) => c[0])).not.toContain('window-all-closed')
    expect(M.startMcpServer).not.toHaveBeenCalled()
  })
})
