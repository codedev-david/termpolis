// @vitest-environment node
//
// How src/main/index.ts wires the stopping of one-shot agent runs: Second Opinion (the
// agent:second-opinion IPC channel) and `termpolis exec` (the MCP agentExec handler).
//
// secondOpinionDeliver.ts and processTree.ts do the work and have their own suites, one of them
// with real processes. What only index.ts can get wrong is covered here: that both entry points
// spawn through that deliver, and that will-quit stops every run still going. Without that
// wiring every suite that boots index.ts still passes, so this one exists to fail.
//
// The contracts pinned here:
//   * On POSIX the agent is spawned detached, so it leads its own process group, and without a
//     spawn `timeout`, which would end only the direct child. On Windows it is not detached,
//     because that would give it a console of its own, and its prompt goes in a temp file.
//   * At the deadline the whole tree is stopped: on POSIX a SIGTERM to the group, then SIGKILL
//     after the grace; on Windows an asynchronous `taskkill /T /F`, so the main thread never
//     waits. The caller gets the reason, not a bare timeout.
//   * will-quit stops every run before it returns: SIGKILL to each group on POSIX, and on
//     Windows a synchronous `taskkill /T /F`, which must reach the PowerShell wrapper while it is
//     still alive. Each caller is told "<agent> was stopped because Termpolis is quitting".
//   * A stop that throws never keeps will-quit from arming its force-exit.
//
// Why a harness of its own: the stop path runs the REAL secondOpinionDeliver and processTree.
// The child_process mock must therefore carry spawnSync, because a factory mock without it
// throws inside killProcessTree's try, and a Windows quit would then quietly kill nothing. And
// process.kill must be spied. Of the suites that already boot index.ts, cov-main-index and
// mainIndexBranchesB mock ./secondOpinion, and mainIpcRemaining's child_process mock has no
// spawnSync. Otherwise this mirrors mainAgentIntegrationIpc.test.ts, including why line 1 pins
// the node environment.
//
// Nothing here starts or signals a real process. spawn and spawnSync are mocks, and process.kill
// is spied with a no-op before index.ts loads. The fake agents' pids could not be real ones
// anyway: each is 1 more than a multiple of 4 (every Windows pid is a multiple of 4), and each
// is above Linux's highest pid_max (2^22) and macOS's (99,999).

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll, type MockInstance } from 'vitest'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import type { McpToolHandlers } from '../../src/main/mcpServer'
import { SYNC_TASKKILL_TIMEOUT_MS, TREE_KILL_GRACE_MS, taskkillPath } from '../../src/main/processTree'
import { STOP_SETTLE_MS } from '../../src/main/secondOpinionDeliver'
import { SECOND_OPINION_TIMEOUT_MS, powershellPath } from '../../src/main/secondOpinion'

const H = vi.hoisted(() => {
  // Node's own require: vi.mock('fs') below does not reach it, so this is a REAL temp folder.
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  const userData = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'tp-so-stop-'))
  const temp = nodePath.join(userData, 'temp')
  nodeFs.mkdirSync(temp)
  const agentPaths = {
    home: '/scratch/home',
    userData: '/scratch/ud',
    claudeDir: '/scratch/home/.claude',
    claudeJson: '/scratch/home/.claude.json',
    codexHome: '/scratch/home/.codex',
    geminiDir: '/scratch/home/.gemini',
  }
  const status = { consent: 'declined', sentinel: 'status' }
  return {
    userData,
    temp,
    extendedPath: '/scratch/extended-path',
    appExit: vi.fn((_code?: number) => undefined),
    // Every agent spawn and every taskkill goes through these two.
    spawn: vi.fn<(cmd: string, args: string[], opts: Record<string, unknown>) => unknown>(),
    spawnSync: vi.fn((_cmd: string, _args: string[], _opts: Record<string, unknown>) => ({ status: 0 })),
    execSync: vi.fn(),
    execFileSync: vi.fn(),
    execFile: vi.fn((_bin: string, _args: string[], _opts: unknown, cb: (e: Error | null, out: string) => void) => cb(null, '')),
    exec: vi.fn((_cmd: string, _opts: unknown, cb: (e: Error | null, out: string, err: string) => void) => cb(null, '', '')),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    existsSync: vi.fn((_p: string) => false),
    // Its first argument is the MCP handler table, which is where agentExec is reached from.
    startMcpServer: vi.fn((_handlers: unknown) => ({ id: 'mcp-server-handle' })),
    // The agent integration, mocked whole as in mainAgentIntegrationIpc.test.ts, so nothing
    // here can reach a real agent config.
    agentPaths,
    resolveAgentIntegrationPaths: vi.fn(() => agentPaths),
    bootAgentIntegration: vi.fn(() => ({ status, changes: [] })),
    disconnectAgentIntegration: vi.fn((): Array<Record<string, string>> => []),
    getAgentIntegrationStatus: vi.fn(() => status),
    setAgentIntegration: vi.fn(() => ({ status, changes: [] })),
    isFolderTrustAllowed: vi.fn(() => false),
    trustFolderForAgents: vi.fn(() => ({ changed: false, keys: [] as string[] })),
    prepareCodexLaunch: vi.fn(() => ({ developerInstructions: null })),
    removeCodexHomeTrust: vi.fn(() => ({ changed: false })),
    conductorMcpConfig: vi.fn(() => ({ mcpServers: {} })),
  }
})

// ---------------------------------------------------------------------------
// Harness, as in mainAgentIntegrationIpc.test.ts
// ---------------------------------------------------------------------------
const ipcHandlers = new Map<string, Function>()
const ipcOnHandlers = new Map<string, Function[]>()
// Every app.on registration. It survives vi.clearAllMocks(), and will-quit is emitted from here.
const appOn = new Map<string, Function[]>()

const mockWebContents = {
  send: vi.fn(),
  executeJavaScript: vi.fn(),
  session: {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
  },
}
const mockMainWindow = {
  minimize: vi.fn(), maximize: vi.fn(), unmaximize: vi.fn(),
  isMaximized: vi.fn(() => false), isMinimized: vi.fn(() => false),
  restore: vi.fn(), focus: vi.fn(), close: vi.fn(), on: vi.fn(),
  setIcon: vi.fn(), loadURL: vi.fn(), loadFile: vi.fn(), webContents: mockWebContents,
}
function MockBrowserWindow() { return mockMainWindow }
MockBrowserWindow.prototype = {}

vi.mock('electron', () => ({
  app: {
    // 'temp' gets a folder of its own, so the Windows prompt file's path can be checked.
    getPath: vi.fn((name: string) => (name === 'temp' ? H.temp : H.userData)),
    getVersion: vi.fn(() => '9.9.9'),
    whenReady: () => Promise.resolve(),
    requestSingleInstanceLock: () => true,
    setName: vi.fn(),
    setAppUserModelId: vi.fn(),
    disableHardwareAcceleration: vi.fn(),
    on: vi.fn((ev: string, h: Function) => {
      const list = appOn.get(ev) ?? []
      list.push(h)
      appOn.set(ev, list)
    }),
    commandLine: { appendSwitch: vi.fn() },
    isPackaged: false,
    quit: vi.fn(),
    exit: H.appExit,
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: Function) => { ipcHandlers.set(channel, handler) }),
    on: vi.fn((channel: string, handler: Function) => {
      const list = ipcOnHandlers.get(channel) ?? []
      list.push(handler)
      ipcOnHandlers.set(channel, list)
    }),
  },
  BrowserWindow: MockBrowserWindow,
  clipboard: { writeText: vi.fn(), readText: vi.fn(() => ''), write: vi.fn() },
  dialog: {
    showSaveDialog: vi.fn(),
    showOpenDialog: vi.fn(),
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

vi.mock('../../src/main/sentry', () => ({ initMainSentry: vi.fn() }))
vi.mock('../../src/main/terminalManager', () => ({
  primeBundledToolsCheck: vi.fn(async () => false),
  spawnTerminal: vi.fn(),
  killTerminal: vi.fn(),
  writeToTerminal: vi.fn(),
  resizeTerminal: vi.fn(),
  killAll: vi.fn(),
  getTerminalCwd: vi.fn(() => ''),
  getTerminalCwdAsync: vi.fn(async () => ''),
  getTerminalPid: vi.fn(() => 0),
  computeWindowsPty: vi.fn(() => ({ backend: 'conpty', buildNumber: 22631 })),
}))
vi.mock('../../src/main/shellDetector', () => ({ detectAvailableShells: vi.fn(async () => []) }))
vi.mock('../../src/main/sessionStore', () => ({
  loadSession: vi.fn(() => ({ terminals: [] })),
  loadRestoreSession: vi.fn(() => ({ terminals: [] })),
  saveSession: vi.fn(),
}))
vi.mock('../../src/main/historyStore', () => ({ appendCommand: vi.fn(), searchHistory: vi.fn(() => []) }))
vi.mock('../../src/main/configFileManager', () => ({ readConfigFile: vi.fn(() => ''), writeConfigFile: vi.fn() }))
vi.mock('../../src/main/completionService', () => ({
  listPathEntries: vi.fn(() => []),
  listPathCommands: vi.fn(() => []),
  listEnvVars: vi.fn(() => []),
}))
vi.mock('../../src/main/aiSecurity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/aiSecurity')>()),
  appendAudit: vi.fn(async () => undefined),
}))
vi.mock('../../src/main/mcpServer', () => ({
  startMcpServer: H.startMcpServer, stopMcpServer: vi.fn(),
  getMcpAuthToken: vi.fn(() => 'fake-token'), getMcpPort: vi.fn(() => 9315),
  initAuditLog: vi.fn(), executeTool: vi.fn(),
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
// index.ts reaches the store through memoryClient. Vitest's factory mock THROWS on access to a
// name it does not define, so this covers every export index.ts touches, as the model does.
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
  // pure helpers: SYNC, exactly as memoryClient re-exports them from swarmMemory
  normalizeProjectSlug: vi.fn((p: string) => (p || '').split(/[\\/]/).filter(Boolean).pop()?.toLowerCase() || ''),
  projectKeyOf: vi.fn((p: string) => `pk:${p}`),
  entityDedupHash: vi.fn((n: string, k?: string) => `edh:${n}:${k ?? ''}`),
  contentHash: vi.fn((c: string) => `h:${c}`),
  canonicalEntityName: vi.fn((n: string) => n.trim()),
}))
vi.mock('../../src/main/autoUpdater', () => ({ initAutoUpdater: vi.fn() }))
vi.mock('../../src/main/agentCommandSanitizer', () => ({
  sanitizeAgentCommand: vi.fn((cmd: string) => cmd),
}))
// The PATH the agents get, so the spawn env can be checked for it.
vi.mock('../../src/main/agentPaths', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/agentPaths')>()),
  getExtendedPath: vi.fn(() => H.extendedPath),
}))

vi.mock('child_process', () => {
  const impl = {
    execSync: H.execSync, execFileSync: H.execFileSync, execFile: H.execFile, exec: H.exec,
    spawn: H.spawn, spawnSync: H.spawnSync,
  }
  return { ...impl, default: impl }
})

vi.mock('fs', () => {
  const impl = {
    writeFileSync: H.writeFileSync, existsSync: H.existsSync, unlinkSync: H.unlinkSync,
    readFileSync: vi.fn(() => '{}'), readdirSync: vi.fn(() => []),
    statSync: vi.fn(() => ({ isDirectory: () => false, isFile: () => true, mtimeMs: 0, size: 0 })),
    mkdirSync: vi.fn(), appendFileSync: vi.fn(), renameSync: vi.fn(), rmSync: vi.fn(),
    chmodSync: vi.fn(), watch: vi.fn(),
    promises: {
      unlink: vi.fn(async () => {}),
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

vi.mock('../../src/main/agentIntegrationManager', () => ({
  resolveAgentIntegrationPaths: H.resolveAgentIntegrationPaths,
  bootAgentIntegration: H.bootAgentIntegration,
  disconnectAgentIntegration: H.disconnectAgentIntegration,
  getAgentIntegrationStatus: H.getAgentIntegrationStatus,
  setAgentIntegration: H.setAgentIntegration,
  isFolderTrustAllowed: H.isFolderTrustAllowed,
  trustFolderForAgents: H.trustFolderForAgents,
  prepareCodexLaunch: H.prepareCodexLaunch,
  removeCodexHomeTrust: H.removeCodexHomeTrust,
  conductorMcpConfig: H.conductorMcpConfig,
}))

// ---------------------------------------------------------------------------
// Fake processes
// ---------------------------------------------------------------------------

/** An agent that keeps running until the test says otherwise: it never exits or closes on its own. */
class FakeAgent extends EventEmitter {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly pid: number
  constructor(pid: number) {
    super()
    this.pid = pid
  }
}

/** What an asynchronous taskkill spawn returns: processTree listens for 'error' and unrefs it. */
class FakeTaskkill extends EventEmitter {
  readonly unref = vi.fn()
}

const PID_A = 5_000_001
const PID_B = 5_000_005
const TASKKILL = taskkillPath()
const DIFF = 'diff --git a/src/app.ts b/src/app.ts\n+export const answer = 42'
const QUITTING = 'claude was stopped because Termpolis is quitting'
const TIMED_OUT = `claude did not finish within ${SECOND_OPINION_TIMEOUT_MS / 1000}s and was stopped`

/** Every agent a test armed, so afterEach can settle what a failed test left running. */
let armed: FakeAgent[] = []

/** The next agent spawns return these, in order. A taskkill gets a FakeTaskkill. Any other spawn
 *  throws, which fails its run with the message rather than handing it a fake meant for another. */
function armAgents(...agents: FakeAgent[]): void {
  const queue = [...agents]
  armed.push(...agents)
  H.spawn.mockImplementation((cmd: string) => {
    if (cmd === TASKKILL) return new FakeTaskkill()
    const next = queue.shift()
    if (!next) throw new Error(`unexpected spawn: ${cmd}`)
    return next
  })
}

type SpawnCall = [cmd: string, args: string[], opts: Record<string, unknown>]
const agentSpawns = (): SpawnCall[] => H.spawn.mock.calls.filter(([cmd]) => cmd !== TASKKILL)
const taskkillSpawns = (): SpawnCall[] => H.spawn.mock.calls.filter(([cmd]) => cmd === TASKKILL)

/** The one agent spawn so far. */
function theAgentSpawn(): SpawnCall {
  const calls = agentSpawns()
  expect(calls).toHaveLength(1)
  return calls[0]
}

/** process.kill calls aimed at this pid's process group, or at the pid alone, which would be wrong. */
const groupKills = (pid: number): unknown[][] => killSpy.mock.calls.filter(([p]) => Math.abs(p) === pid)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function invoke(channel: string, args: unknown = {}): Promise<unknown> {
  const handler = ipcHandlers.get(channel)
  if (!handler) throw new Error(`No handler for ${channel}`)
  return handler({}, args)
}

async function withPlatform(platform: NodeJS.Platform, fn: () => Promise<void> | void): Promise<void> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  try { await fn() } finally { Object.defineProperty(process, 'platform', original) }
}

/** Start a review on `platform`. The review spawns before invoke returns, and the run keeps the
 *  platform it started on, so the override can end straight after. */
async function startReview(platform: NodeJS.Platform): Promise<{ result: Promise<unknown> }> {
  let result!: Promise<unknown>
  await withPlatform(platform, () => { result = invoke('agent:second-opinion', { agent: 'claude', content: DIFF }) })
  return { result }
}

/** Start `termpolis exec` on POSIX. It checks its cwd and awaits its memory primer before it
 *  spawns, so the platform override lasts until the agent is up. The cwd must really exist, and
 *  H.userData does: it was made with node's own fs, which vi.mock('fs') doesn't reach. */
async function startExec(spawnsBefore: number): Promise<{ result: Promise<unknown> }> {
  let result!: Promise<unknown>
  await withPlatform('linux', async () => {
    result = boot.agentExec({ prompt: 'summarize the last commit', agent: 'claude', cwd: H.userData })
    await vi.waitFor(() => expect(agentSpawns()).toHaveLength(spawnsBefore + 1), { timeout: 5_000, interval: 5 })
  })
  return { result }
}

const willQuitHandlers = (): Function[] => {
  const handlers = appOn.get('will-quit') ?? []
  if (handlers.length === 0) throw new Error('index.ts registered no will-quit handler')
  return handlers
}

/** Emit will-quit as Electron does: every handler, synchronously, with nothing awaited after,
 *  because the app exits once they return. Under fake timers, so the force-exit watchdog they
 *  arm is dropped with them instead of firing later. */
function quit(): void {
  const handlers = willQuitHandlers()
  vi.useFakeTimers()
  try { for (const h of handlers) h() } finally { vi.useRealTimers() }
}

const PENDING = Symbol('pending')
/** What `p` has settled to by the next macrotask, or PENDING. Real timers only. */
const settledNow = <T>(p: Promise<T>): Promise<T | typeof PENDING> =>
  Promise.race([p, new Promise<typeof PENDING>((resolve) => setTimeout(() => resolve(PENDING), 0))])

let logSpy: MockInstance<(...args: any[]) => void>
let warnSpy: MockInstance<(...args: any[]) => void>
let errorSpy: MockInstance<(...args: any[]) => void>
let exitSpy: MockInstance<typeof process.exit>
let killSpy: MockInstance<typeof process.kill>

/** The MCP handler table index.ts built at boot. It is captured before the first beforeEach clears the spy. */
const boot = {} as Pick<McpToolHandlers, 'agentExec'>

beforeAll(async () => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  // The will-quit watchdog ends in process.exit(0), which must reach a spy and not the worker.
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
  // Spied before index.ts loads, so no signal sent from this file, boot included, reaches a real process.
  killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
  vi.resetModules()
  await import('../../src/main/index')
  // Both are set up inside app.whenReady(). Wait for them, not for a fixed delay.
  await vi.waitFor(() => {
    expect(H.startMcpServer).toHaveBeenCalled()
    expect(appOn.get('will-quit')?.length).toBeGreaterThan(0)
  }, { timeout: 15_000, interval: 20 })
  boot.agentExec = (H.startMcpServer.mock.calls[0][0] as McpToolHandlers).agentExec
}, 60_000)

afterAll(() => {
  logSpy?.mockRestore()
  warnSpy?.mockRestore()
  errorSpy?.mockRestore()
  exitSpy?.mockRestore()
  killSpy?.mockRestore()
  try {
    require('node:fs').rmSync(H.userData, { recursive: true, force: true, maxRetries: 3 })
  } catch { /* best effort: it is a temp folder */ }
})

beforeEach(() => {
  vi.clearAllMocks()
  // clearAllMocks keeps a programmed implementation. Each test arms its own agents.
  H.spawn.mockReset()
  armed = []
})

afterEach(() => {
  vi.useRealTimers()
  // A test that failed part way can leave a run going. Quitting stops it. Closing every agent
  // settles any run that quitting did not stop.
  try { quit() } finally { for (const agent of armed) agent.emit('close', null) }
})

// ===========================================================================
// How the agent is spawned
// ===========================================================================
describe('agent:second-opinion spawns through the deliver that stops the whole tree', () => {
  it('on POSIX: detached, so the agent leads its own process group, and with no spawn timeout', async () => {
    const agent = new FakeAgent(PID_A)
    armAgents(agent)
    const review = await startReview('linux')

    const [cmd, , opts] = theAgentSpawn()
    expect(cmd).toBe('claude')
    expect(opts).toMatchObject({ detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    // A spawn `timeout` ends only the direct child. The deliver's own deadline stops the tree.
    expect(opts).not.toHaveProperty('timeout')
    const env = opts.env as NodeJS.ProcessEnv
    expect(env.PATH).toBe(H.extendedPath)
    expect(env).not.toHaveProperty('TP_SO_FILE')

    agent.stdout.emit('data', Buffer.from('Looks fine.'))
    agent.emit('exit', 0)
    agent.emit('close', 0)
    expect(await review.result).toEqual({ success: true, data: { feedback: 'Looks fine.' } })
    // A run that finished on its own is never signalled.
    expect(groupKills(PID_A)).toEqual([])
  })

  it('on Windows: not detached (that would give the agent a console of its own), with the prompt in a temp file', async () => {
    armAgents(new FakeAgent(PID_A))
    await startReview('win32')

    const [cmd, , opts] = theAgentSpawn()
    // By absolute path: a run's cwd may be a repo, and Windows looks there before PATH.
    expect(cmd).toBe(powershellPath())
    expect(opts).toMatchObject({ detached: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    expect(opts).not.toHaveProperty('timeout')
    const tmp = (opts.env as NodeJS.ProcessEnv).TP_SO_FILE
    expect(tmp?.startsWith(join(H.temp, 'termpolis-so-'))).toBe(true)
    expect(H.writeFileSync).toHaveBeenCalledWith(tmp, expect.stringContaining(DIFF), 'utf8')
  })
})

describe('agentExec (`termpolis exec`) spawns through the same deliver', () => {
  it('on POSIX: detached and with no spawn timeout, like a review', async () => {
    armAgents(new FakeAgent(PID_A))
    await startExec(0)

    const [cmd, , opts] = theAgentSpawn()
    expect(cmd).toBe('claude')
    expect(opts).toMatchObject({ detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    expect(opts).not.toHaveProperty('timeout')
    expect((opts.env as NodeJS.ProcessEnv).PATH).toBe(H.extendedPath)
    // `termpolis exec --cwd X` runs the agent in X, not in the app's own cwd.
    expect(opts.cwd).toBe(H.userData)
  })
})

// ===========================================================================
// will-quit
// ===========================================================================
describe('will-quit stops every run before it returns', () => {
  it('on POSIX: SIGKILL to the review\'s process group at once, with no SIGTERM grace', async () => {
    armAgents(new FakeAgent(PID_A))
    const review = await startReview('linux')
    expect(await settledNow(review.result)).toBe(PENDING)
    expect(groupKills(PID_A)).toEqual([])

    quit()

    // Checked before anything is awaited: the app exits as soon as will-quit returns.
    expect(groupKills(PID_A)).toEqual([[-PID_A, 'SIGKILL']])
    expect(await settledNow(review.result)).toEqual({ success: false, error: QUITTING })
  })

  it('on Windows: taskkill /T /F, synchronously, so it reaches the wrapper while that is still alive', async () => {
    armAgents(new FakeAgent(PID_A))
    const review = await startReview('win32')
    const tmp = (theAgentSpawn()[2].env as NodeJS.ProcessEnv).TP_SO_FILE

    quit()

    // taskkill /T finds the tree only through a live root, and the app's exit ends the wrapper,
    // so an asynchronous taskkill would come too late.
    expect(H.spawnSync.mock.calls).toEqual([
      [TASKKILL, ['/pid', String(PID_A), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: SYNC_TASKKILL_TIMEOUT_MS }],
    ])
    expect(taskkillSpawns()).toEqual([])
    expect(groupKills(PID_A)).toEqual([])
    expect(await settledNow(review.result)).toEqual({ success: false, error: QUITTING })
    expect(H.unlinkSync).toHaveBeenCalledWith(tmp)
  })

  it('stops a `termpolis exec` run the same way', async () => {
    armAgents(new FakeAgent(PID_A))
    const run = await startExec(0)
    expect(await settledNow(run.result)).toBe(PENDING)

    quit()

    expect(groupKills(PID_A)).toEqual([[-PID_A, 'SIGKILL']])
    expect(await settledNow(run.result)).toMatchObject({ ok: false, agent: 'claude', output: '', code: 1, error: QUITTING })
  })

  it('stops a review and an exec run together, each exactly once', async () => {
    armAgents(new FakeAgent(PID_A), new FakeAgent(PID_B))
    const review = await startReview('linux')
    const run = await startExec(1)

    quit()

    expect(groupKills(PID_A)).toEqual([[-PID_A, 'SIGKILL']])
    expect(groupKills(PID_B)).toEqual([[-PID_B, 'SIGKILL']])
    expect(await settledNow(review.result)).toEqual({ success: false, error: QUITTING })
    expect(await settledNow(run.result)).toMatchObject({ ok: false, error: QUITTING })
  })

  it('still arms the force-exit when stopping the runs throws', async () => {
    const agent = new FakeAgent(PID_A)
    armAgents(agent)
    const review = await startReview('linux')
    const handlers = willQuitHandlers()

    vi.useFakeTimers()
    // The first call inside a stop that is not already guarded. Making it throw stands in for
    // anything stopAll could throw.
    const boom = new Error('clearTimeout failed')
    const clear = vi.spyOn(globalThis, 'clearTimeout').mockImplementationOnce(() => { throw boom })
    try {
      expect(() => { for (const h of handlers) h() }).not.toThrow()
      expect(clear.mock.results[0]).toEqual({ type: 'throw', value: boom })
      expect(exitSpy).not.toHaveBeenCalled()
      vi.advanceTimersByTime(5000)
      expect(exitSpy).toHaveBeenCalledWith(0)
    } finally {
      // Restored before the real timers come back, or the fake clearTimeout would be put back
      // over the real one.
      clear.mockRestore()
      vi.useRealTimers()
    }

    // The run still ends as a stop, with the reason, once the agent goes.
    agent.emit('close', null)
    expect(await settledNow(review.result)).toEqual({ success: false, error: QUITTING })
  })
})

// ===========================================================================
// The deadline
// ===========================================================================
describe('the deadline stops the whole tree, not only the process Termpolis spawned', () => {
  it('on POSIX: SIGTERM to the group at the deadline, SIGKILL after the grace, then the reason', async () => {
    armAgents(new FakeAgent(PID_A))
    vi.useFakeTimers()
    try {
      const review = await startReview('linux')

      vi.advanceTimersByTime(SECOND_OPINION_TIMEOUT_MS - 1)
      expect(groupKills(PID_A)).toEqual([])
      vi.advanceTimersByTime(1)
      expect(groupKills(PID_A)).toEqual([[-PID_A, 'SIGTERM']])
      vi.advanceTimersByTime(TREE_KILL_GRACE_MS)
      expect(groupKills(PID_A)).toEqual([[-PID_A, 'SIGTERM'], [-PID_A, 'SIGKILL']])
      // The agent never closes its pipes, and the run settles anyway.
      vi.advanceTimersByTime(STOP_SETTLE_MS - TREE_KILL_GRACE_MS)
      expect(await review.result).toEqual({ success: false, error: TIMED_OUT })
    } finally {
      vi.useRealTimers()
    }
  })

  it('on Windows: taskkill /T /F run asynchronously, so the main thread never waits on it', async () => {
    armAgents(new FakeAgent(PID_A))
    vi.useFakeTimers()
    try {
      const review = await startReview('win32')
      const tmp = (theAgentSpawn()[2].env as NodeJS.ProcessEnv).TP_SO_FILE

      vi.advanceTimersByTime(SECOND_OPINION_TIMEOUT_MS)
      expect(taskkillSpawns()).toEqual([[TASKKILL, ['/pid', String(PID_A), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }]])
      expect(H.spawnSync).not.toHaveBeenCalled()
      vi.advanceTimersByTime(STOP_SETTLE_MS)
      expect(await review.result).toEqual({ success: false, error: TIMED_OUT })
      expect(H.unlinkSync).toHaveBeenCalledWith(tmp)
    } finally {
      vi.useRealTimers()
    }
  })
})
