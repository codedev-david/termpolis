// Branch backfill for src/main/index.ts, part A (source lines < 1400).
//
// Everything here is a DEFENSIVE arm that the happy path never takes: the Linux launch switches
// that only run on a Linux runner, the `?? []` a SYNC planner dep falls back to, the `catch` that
// fires when the Commit Shield scanner throws a non-Error, the POSIX half of a Windows-only path
// fold. Each test asserts what the app DOES when the odd input arrives -- not merely that the
// line executed.
//
// The mock harness immediately below (electron + ~30 service modules) is the one from
// mainIpcRemaining.test.ts, reproduced so index.ts loads identically. The extra seams this file
// needs -- gpuPolicy, crashWatch, commitScan, outcomeSignals, the mneme planners, codeLocate and
// the Headroom proxy -- are declared AFTER it; `vi.mock`/`vi.hoisted` are hoisted, so position in
// the file does not matter.
//
// The final describes re-import index.ts under a forced platform / env, so they must stay LAST.
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import { EventEmitter } from 'events'
import { homedir } from 'os'
import { globalHotkeys } from '../../src/main/appMenu'

// Platform-specific accelerators (Super+Shift+* on Windows/Linux, Control+Alt+* on macOS). Derived
// from the same source index.ts registers with, so these pass on every CI runner.
const HK = globalHotkeys(process.platform)
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
  Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn(() => ({})) },
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
  loadSession: vi.fn(() => ({ terminals: [] })), loadRestoreSession: vi.fn(() => ({ terminals: [] })), saveSession: vi.fn(),
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
vi.mock('../../src/main/agentCommandSanitizer', () => ({ sanitizeAgentCommand: vi.fn((c: string) => c), isClaudeAgentName: (name: string) => /(^|[^a-z])claude/i.test(name || '') }))
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
// Extra seams. Every one of these exists to make a defensive arm reachable.
// ===========================================================================
type GpuFlags = { disableVaapi: boolean; disableHardwareAcceleration: boolean; disableGpuSwitch: boolean }
type ScanResult = { clean: boolean; scannedBytes: number; hitCount: number; hits?: unknown[] }
type ReflexDeps = Record<string, (...a: any[]) => any>

const X = vi.hoisted(() => ({
  gpuPolicy: vi.fn<(p: string, env: NodeJS.ProcessEnv) => GpuFlags>(
    () => ({ disableVaapi: false, disableHardwareAcceleration: false, disableGpuSwitch: false }),
  ),
  installCleanExitGuards: vi.fn(),
  scanStagedDiff: vi.fn<(deps: unknown) => ScanResult>(() => ({ clean: true, scannedBytes: 0, hitCount: 0, hits: [] })),
  scanPushRange: vi.fn<(deps: unknown) => ScanResult>(() => ({ clean: true, scannedBytes: 0, hitCount: 0, hits: [] })),
  deriveOutcome: vi.fn<(e: unknown) => { domain: string; success: boolean } | null>(() => ({ domain: 'git', success: true })),
  recordOutcome: vi.fn(),
  onTaskComplete: vi.fn<(ep: unknown, deps: any) => Promise<{ fired: boolean; lessons: number }>>(
    async () => ({ fired: false, lessons: 0 }),
  ),
  onSessionEpisode: vi.fn<(ep: unknown, deps: any) => Promise<{ fired: boolean; lessons: number }>>(
    async () => ({ fired: false, lessons: 0 }),
  ),
  distillEpisode: vi.fn<(ep: unknown, opts: Record<string, unknown>) => Promise<unknown>>(async () => null),
  isHighValueEpisode: vi.fn<(ep: unknown) => boolean>(() => true),
  proactiveSignals: vi.fn<(s: string) => string[]>(() => []),
  codeLocate: vi.fn<(issue: string, deps: any, opts: any) => unknown[]>(() => []),
  getProxyEnv: vi.fn<() => Record<string, string> | null>(() => null),
}))

// gpuPolicy is the whole Linux blank-window policy in one pure function. Stubbing it is how the
// three switch arms in index.ts become reachable from a Windows runner.
vi.mock('../../src/main/gpuPolicy', () => ({ gpuPolicy: X.gpuPolicy }))

// crashWatch is stubbed WHOLE so installCleanExitGuards never hands index.ts a session-end
// handler. That is the only way to observe createWindow() while `onSessionEnd` is still null.
vi.mock('../../src/main/crashWatch', () => ({
  initCrashWatch: vi.fn(),
  heartbeat: vi.fn(),
  markCleanExit: vi.fn(),
  installCleanExitGuards: X.installCleanExitGuards,
}))

// Real blockMessage (its user-facing text is asserted elsewhere); only the two scanners are
// steerable, because "the scanner threw" is the state the shield's failure path is built for.
vi.mock('../../src/main/commitScan', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/commitScan')>()
  return { ...actual, scanStagedDiff: X.scanStagedDiff, scanPushRange: X.scanPushRange }
})

vi.mock('../../src/main/outcomeSignals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/outcomeSignals')>()
  return { ...actual, deriveOutcome: X.deriveOutcome }
})

vi.mock('../../src/main/mnemeCompetence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/mnemeCompetence')>()
  return { ...actual, recordOutcome: X.recordOutcome }
})

// The planners are stubbed so the CALLBACKS index.ts injects into them can be driven directly --
// those closures are the code under test here, and nothing else calls them.
vi.mock('../../src/main/mnemeReflex', () => ({
  onTaskComplete: X.onTaskComplete,
  onSessionEpisode: X.onSessionEpisode,
}))
vi.mock('../../src/main/mnemeReflect', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/mnemeReflect')>()
  return { ...actual, distillEpisode: X.distillEpisode, isHighValueEpisode: X.isHighValueEpisode }
})
vi.mock('../../src/main/mnemeRetrieval', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/mnemeRetrieval')>()
  return { ...actual, proactiveSignals: X.proactiveSignals }
})
vi.mock('../../src/main/codeLocate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/codeLocate')>()
  return { ...actual, codeLocate: X.codeLocate }
})
vi.mock('../../src/main/headroomProxy/proxySupervisor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/headroomProxy/proxySupervisor')>()
  return { ...actual, getProxyEnv: X.getProxyEnv }
})

// ---------------------------------------------------------------------------
// Harness additions
// ---------------------------------------------------------------------------

/** ipcMain.on channels never reach the handle() map -- pull the listener off the mock's calls. */
async function ipcListener(channel: string): Promise<(...a: any[]) => void> {
  const { ipcMain } = (await import('electron')) as any
  const call = [...ipcMain.on.mock.calls].reverse().find((c: unknown[]) => c[0] === channel)
  if (!call) throw new Error(`ipcMain.on(${channel}) was never registered`)
  return call[1]
}

/** The MCP tool table index.ts hands to startMcpServer. swarmUpdateTask is the only caller of
 *  reflectOnTask, so it is the only way in to the reflex deps. */
function mcp(): Record<string, (...a: any[]) => any> {
  const calls = M.startMcpServer.mock.calls as unknown as unknown[][]
  if (calls.length === 0) throw new Error('startMcpServer was never called - the whenReady chain did not run')
  return calls[calls.length - 1][0] as Record<string, (...a: any[]) => any>
}

/** Every payload index.ts persisted to commit-shield-repos.json, oldest first. */
function shieldRegistryWrites(): string[][] {
  return (M.writeFileSync.mock.calls as unknown as [string, string][])
    .filter((c) => String(c[0]).includes('commit-shield-repos.json'))
    .map((c) => JSON.parse(String(c[1])) as string[])
}

// ===========================================================================
// createWindow(): the session-end guard is only wired once crash-watch has one
// ===========================================================================
describe('createWindow — session-end is wired only when crash-watch produced a handler', () => {
  it('registers nothing for session-end while onSessionEnd is still null', () => {
    // installCleanExitGuards is a no-op in this suite, so index.ts never receives the handler.
    // Electron throws on `on('session-end', null)`, so the guard around it is the whole point:
    // the window must come up with its other listeners intact and simply skip this one.
    const channels = mockMainWindow.on.mock.calls.map((c: unknown[]) => c[0])
    expect(X.installCleanExitGuards).toHaveBeenCalled()
    expect(channels).toContain('closed')           // createWindow() genuinely ran...
    expect(channels).not.toContain('session-end')  // ...and skipped the handler it did not have
  })
})

// ===========================================================================
// terminal:create — the Headroom proxy is opt-in per terminal AND health-gated
// ===========================================================================
describe('terminal:create — the Headroom proxy env reaches the PTY only when earned', () => {
  const PROXY_ENV = { ANTHROPIC_BASE_URL: 'http://127.0.0.1:41999' }
  afterAll(() => { X.getProxyEnv.mockReturnValue(null) })

  it('passes the proxy env only to a terminal that asked for headroom', async () => {
    X.getProxyEnv.mockReturnValue(PROXY_ENV)
    M.spawnTerminal.mockClear()
    expect((await invoke('terminal:create', { id: 'hr-on', shellType: 'powershell', cwd: '/repo', claudeHeadroom: true })).success).toBe(true)
    expect(M.spawnTerminal.mock.calls[0][5]).toEqual(PROXY_ENV)

    // Same healthy proxy, headroom off: the terminal launches DIRECT and the proxy is not even
    // consulted. Routing a non-consenting terminal through it would put its traffic on the wire.
    M.spawnTerminal.mockClear()
    X.getProxyEnv.mockClear()
    await invoke('terminal:create', { id: 'hr-off', shellType: 'powershell', cwd: '/repo', claudeHeadroom: false })
    expect(M.spawnTerminal.mock.calls[0][5]).toBeUndefined()
    expect(X.getProxyEnv).not.toHaveBeenCalled()
  })

  it('launches direct when headroom is on but the proxy is not healthy', async () => {
    // getProxyEnv() returns null whenever the proxy failed its health check. The `?? undefined`
    // is what stops a literal null env reaching node-pty, which would wipe the inherited env.
    X.getProxyEnv.mockReturnValue(null)
    M.spawnTerminal.mockClear()
    expect((await invoke('terminal:create', { id: 'hr-down', shellType: 'powershell', cwd: '/repo', claudeHeadroom: true })).success).toBe(true)
    expect(X.getProxyEnv).toHaveBeenCalled()
    expect(M.spawnTerminal.mock.calls[0][5]).toBeUndefined()
  })
})

// ===========================================================================
// terminal:write — the e2e write recorder must not exist outside tests
// ===========================================================================
describe('terminal:write — the raw-write recorder is test-only', () => {
  it('forwards to the PTY but records nothing when NODE_ENV is not test', async () => {
    const write = await ipcListener('terminal:write')
    const before = ((await invoke('terminal:__test_writes')).data as unknown[]).length
    M.writeToTerminal.mockClear()

    const original = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try { write({}, { id: 'prod-term', data: 'echo hi\r' }) } finally { process.env.NODE_ENV = original }

    // The "don't touch" half of the contract still holds -- the keystroke reaches the shell.
    expect(M.writeToTerminal).toHaveBeenCalledWith('prod-term', 'echo hi\r')
    // ...but a shipped build must not accumulate every keystroke in an unbounded array.
    expect(((await invoke('terminal:__test_writes')).data as unknown[]).length).toBe(before)

    write({}, { id: 'test-term', data: 'echo hi\r' })
    expect((await invoke('terminal:__test_writes')).data).toContainEqual({ id: 'test-term', data: 'echo hi\r' })
  })
})

// ===========================================================================
// Commit Shield: "the scan did not run" is never reported as "the scan was clean"
// ===========================================================================
describe('Commit Shield — a scanner that throws is announced, not swallowed', () => {
  beforeEach(async () => {
    await invoke('aiSecurity:set-commit-shield', { value: true })
    M.execFileSync.mockReturnValue(Buffer.from(''))
  })
  afterAll(async () => { await invoke('aiSecurity:set-commit-shield', { value: false }) })

  it('allows the commit through, but audits and broadcasts the failure, when the throw is a bare string', async () => {
    // child_process surfaces a blown maxBuffer as a string on some paths, so `e.message` is
    // undefined there. Without the `?? e` fallback the note would read "undefined" -- exactly the
    // moment (first push of a whole history) when the operator most needs to know what happened.
    X.scanStagedDiff.mockImplementationOnce(() => { throw 'stdout maxBuffer length exceeded' })
    const res = await invoke('git:commit', { cwd: '/repo', message: 'wip' })

    expect(res.success).toBe(true) // the operation is ALLOWED -- the shield fails open, loudly
    expect(M.appendAudit).toHaveBeenCalledWith(expect.objectContaining({
      event: 'shield_scan_failed',
      notes: expect.stringContaining('stdout maxBuffer length exceeded'),
    }))
    expect(mockWebContents.send).toHaveBeenCalledWith(
      'shield:scan-failed',
      expect.objectContaining({ op: 'commit', error: 'stdout maxBuffer length exceeded' }),
    )
  })

  it('still names the failure when the thrown value has no message at all', async () => {
    // `throw null` defeats `e.message` outright; `e?.message ?? e` is what keeps this from
    // becoming a TypeError inside the catch, which would re-throw and block the commit.
    X.scanStagedDiff.mockImplementationOnce(() => { throw null })
    const res = await invoke('git:commit', { cwd: '/repo', message: 'wip' })

    expect(res.success).toBe(true)
    expect(mockWebContents.send).toHaveBeenCalledWith('shield:scan-failed', expect.objectContaining({ error: 'null' }))
  })
})

// ===========================================================================
// Competence: only classifiable work reaches the competence layer
// ===========================================================================
describe('recordWorkOutcome — an unclassifiable event writes nothing', () => {
  beforeEach(() => { M.execFileSync.mockReturnValue(Buffer.from('')) })

  it('skips the competence write when deriveOutcome cannot classify the event', async () => {
    // deriveOutcome returns null for events it has no domain for. Recording those as a domainless
    // success is how "self-competence by domain" got polluted before -- so the guard must hold.
    X.deriveOutcome.mockReturnValueOnce(null)
    X.recordOutcome.mockClear()
    expect((await invoke('git:commit', { cwd: '/repo/termpolis', message: 'ok' })).success).toBe(true)
    expect(X.recordOutcome).not.toHaveBeenCalled()
  })

  it('records domain + success when it can', async () => {
    X.deriveOutcome.mockReturnValueOnce({ domain: 'git', success: true })
    X.recordOutcome.mockClear()
    expect((await invoke('git:commit', { cwd: '/repo/termpolis', message: 'ok' })).success).toBe(true)
    expect(X.recordOutcome).toHaveBeenCalledWith('git', true, expect.any(Number))
  })
})

// ===========================================================================
// shieldKey: separator/case folding is a Windows-only correctness rule
// ===========================================================================
describe('Commit Shield registry — path folding is Windows-only', () => {
  // index.ts READS the registry through node:fs and WRITES it through fs, so seed both: a real
  // file under the mocked userData dir (os.tmpdir()) and the fs mock's readFileSync.
  let realFs: typeof import('node:fs')
  let registryPath = ''

  beforeAll(async () => {
    realFs = await vi.importActual<typeof import('node:fs')>('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    registryPath = path.join(os.tmpdir(), 'commit-shield-repos.json')
  })

  beforeEach(async () => {
    // One repo already protected, spelled with backslashes and a capital R.
    realFs.writeFileSync(registryPath, JSON.stringify(['C:\\Repo']), 'utf8')
    const fs = (await import('fs')) as any
    fs.readFileSync.mockReturnValue(JSON.stringify(['C:\\Repo']))
    M.execFileSync.mockReturnValue(Buffer.from('hooks\n')) // git rev-parse --git-path hooks
  })

  afterAll(async () => {
    try { realFs.unlinkSync(registryPath) } catch { /* never created */ }
    const fs = (await import('fs')) as any
    fs.readFileSync.mockReturnValue('{}')
  })

  it('folds two spellings of the same repo into one entry on win32', async () => {
    M.writeFileSync.mockClear()
    await withPlatform('win32', async () => {
      expect((await invoke('gitHooks:install', { cwd: 'C:/repo' })).success).toBe(true)
    })
    // NTFS is case-insensitive and treats the separators as interchangeable, so these ARE one
    // repository -- storing both is what let uninstall-by-cwd leave a stale "PROTECTED" entry.
    expect(shieldRegistryWrites().pop()).toEqual(['C:\\Repo'])
  })

  it('keeps them apart on POSIX, where they are genuinely different paths', async () => {
    M.writeFileSync.mockClear()
    await withPlatform('linux', async () => {
      expect((await invoke('gitHooks:install', { cwd: 'C:/repo' })).success).toBe(true)
    })
    // A backslash is a legal filename character on POSIX and the filesystem is case-sensitive.
    // Folding here would silently drop a real, separately protected repo from the list.
    expect(shieldRegistryWrites().pop()).toEqual(['C:\\Repo', 'C:/repo'])
  })
})

// ===========================================================================
// code-graph:locate — the sync planner must never be handed `undefined` as data
// ===========================================================================
describe('code-graph:locate — the deps handed to the planner are total', () => {
  it('tolerates a signal extractor that yields nothing and answers un-prefetched history with []', async () => {
    // proactiveSignals can return nothing at all for issue text with no usable tokens. `|| []`
    // keeps the prefetch loop from iterating undefined; the `history` closure is a SYNC dep, so a
    // miss has to come back as an empty ARRAY -- `undefined` would reach codeLocate as data.
    X.proactiveSignals.mockReturnValueOnce(undefined as unknown as string[])
    let historyAnswer: unknown = '<never asked>'
    X.codeLocate.mockImplementationOnce((_issue: string, deps: any) => {
      historyAnswer = deps.history('a-query-nobody-prefetched')
      return [{ file: 'src/a.ts', score: 1 }]
    })

    const res = await invoke('code-graph:locate', { issue: '   ', limit: 3 })

    expect(res.success).toBe(true)
    expect(res.data).toEqual([{ file: 'src/a.ts', score: 1 }])
    expect(historyAnswer).toEqual([])
  })
})

// ===========================================================================
// The mneme reflex deps: edge collection and projectless code resolution
// ===========================================================================
describe('reflectOnTask — the edges a reflection asks for', () => {
  it('drops a nameless edge and mints only the complete one', async () => {
    // The planner decides edges from distilled text, so an endpoint can come back empty. Minting
    // `from: ''` would attach a lesson to a node nothing can ever look up again.
    M.memoryLink.mockClear()
    X.onTaskComplete.mockImplementationOnce(async (_ep: unknown, deps: ReflexDeps) => {
      deps.link('', 'lesson-1', 'derived-from')
      deps.link('task-1', '', 'derived-from')
      deps.link('task-1', 'lesson-1', 'derived-from', 2)
      return { fired: true, lessons: 1 }
    })

    mcp().swarmUpdateTask('task-1', 'completed', 'done')

    await vi.waitFor(() => expect(M.memoryLink).toHaveBeenCalledTimes(1))
    expect(M.memoryLink).toHaveBeenCalledWith(expect.objectContaining({
      from: 'task-1', to: 'lesson-1', relation: 'derived-from', weight: 2, createdBy: 'reflect',
    }))
  })

  it('resolves code references for an episode that carries no project', async () => {
    // `project ?? ''` -- graphKeyForRoot takes a string, and a swarm task is not required to
    // carry a project. The dep must still answer with a CodeRef array, not blow up the reflex.
    let resolved: unknown = '<never called>'
    X.onTaskComplete.mockImplementationOnce(async (_ep: unknown, deps: ReflexDeps) => {
      resolved = await deps.resolveCode(['SomeSymbol'], undefined)
      return { fired: false, lessons: 0 }
    })

    mcp().swarmUpdateTask('task-2', 'failed', undefined)

    await vi.waitFor(() => expect(resolved).not.toBe('<never called>'))
    expect(Array.isArray(resolved)).toBe(true)
  })
})

// ===========================================================================
// Everything below re-imports index.ts with a fresh module registry (forced
// platform / forced env), so these must remain the LAST describes in the file.
// ===========================================================================

/** Re-evaluate index.ts under a forced platform + env, and hand back the electron app mock. */
async function reimportUnder(platform: NodeJS.Platform, env: Record<string, string | undefined>): Promise<any> {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const originalEnv: Record<string, string | undefined> = {}
  for (const k of Object.keys(env)) originalEnv[k] = process.env[k]
  try {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true })
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    const before = (await import('electron')) as any
    before.app.commandLine.appendSwitch.mockClear()
    before.app.disableHardwareAcceleration.mockClear()
    vi.resetModules()
    await import('../../src/main/index')
    await new Promise((r) => setTimeout(r, 50))
    return ((await import('electron')) as any).app
  } finally {
    Object.defineProperty(process, 'platform', originalPlatform)
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

describe('Linux launch policy (fresh module under a forced platform)', () => {
  it('disables the SUID sandbox and applies every GPU switch the policy asks for', async () => {
    // The chrome-sandbox bundled in an AppImage has no SUID root, so Chromium's namespace sandbox
    // is the only one that can start. And gpuPolicy is the single source of truth for the
    // blank-window workarounds -- index.ts must apply all three arms it can return, not just VAAPI.
    X.gpuPolicy.mockReturnValue({ disableVaapi: true, disableHardwareAcceleration: true, disableGpuSwitch: true })
    const app = await reimportUnder('linux', { APPIMAGE: '/tmp/Termpolis.AppImage', CHROME_DEVEL_SANDBOX: undefined })

    const switches = app.commandLine.appendSwitch.mock.calls.map((c: unknown[]) => c[0])
    expect(switches).toContain('no-sandbox')
    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith('disable-features', 'VaapiVideoDecoder,VaapiVideoEncoder')
    expect(app.disableHardwareAcceleration).toHaveBeenCalled()
    expect(switches).toContain('disable-gpu')
    // The policy is asked about the platform actually running, never a hard-coded one.
    expect(X.gpuPolicy.mock.calls[X.gpuPolicy.mock.calls.length - 1][0]).toBe('linux')
  })

  it('still drops the sandbox on a plain Linux run with no CHROME_DEVEL_SANDBOX', async () => {
    // Not an AppImage, but no dev sandbox binary either -- same crash on launch, same fix.
    X.gpuPolicy.mockReturnValue({ disableVaapi: false, disableHardwareAcceleration: false, disableGpuSwitch: false })
    const app = await reimportUnder('linux', { APPIMAGE: undefined, CHROME_DEVEL_SANDBOX: undefined })
    expect(app.commandLine.appendSwitch.mock.calls.map((c: unknown[]) => c[0])).toContain('no-sandbox')
    // ...and a policy that asks for nothing gets nothing: no blanket GPU disable behind the user's back.
    expect(app.disableHardwareAcceleration).not.toHaveBeenCalled()
  })

  it('leaves the sandbox alone when the distro provides CHROME_DEVEL_SANDBOX', async () => {
    // A properly provisioned setuid sandbox is strictly stronger than --no-sandbox, so an
    // unconditional appendSwitch here would silently downgrade every packaged Linux install.
    X.gpuPolicy.mockReturnValue({ disableVaapi: false, disableHardwareAcceleration: false, disableGpuSwitch: false })
    const app = await reimportUnder('linux', { APPIMAGE: undefined, CHROME_DEVEL_SANDBOX: '/usr/lib/chrome-devel-sandbox' })
    expect(app.commandLine.appendSwitch.mock.calls.map((c: unknown[]) => c[0])).not.toContain('no-sandbox')
  })
})

describe('mneme distiller gate (fresh module with TERMPOLIS_MNEME_DISTILLER=1)', () => {
  it('attaches the headless LLM distiller to high-value episodes only', async () => {
    // The LLM distiller costs a model call per episode, so it is env-gated AND value-gated. With
    // the env gate off the `&&` short-circuits and isHighValueEpisode is never even consulted.
    X.gpuPolicy.mockReturnValue({ disableVaapi: false, disableHardwareAcceleration: false, disableGpuSwitch: false })
    await reimportUnder(process.platform, { TERMPOLIS_MNEME_DISTILLER: '1' })

    X.distillEpisode.mockClear()
    X.isHighValueEpisode.mockReturnValueOnce(true).mockReturnValueOnce(false)
    X.onTaskComplete.mockImplementationOnce(async (_ep: unknown, deps: ReflexDeps) => {
      await deps.distill({ id: 'valuable' })
      await deps.distill({ id: 'ordinary' })
      return { fired: false, lessons: 0 }
    })

    mcp().swarmUpdateTask('task-3', 'completed', 'ok')

    await vi.waitFor(() => expect(X.distillEpisode).toHaveBeenCalledTimes(2))
    expect(X.distillEpisode.mock.calls[0][1]).toHaveProperty('llm')  // high value -> LLM pass
    expect(X.distillEpisode.mock.calls[1][1]).toEqual({})            // ordinary -> deterministic only
  })
})
