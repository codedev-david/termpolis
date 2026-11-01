// @vitest-environment node
//
// Wiring of the consent-gated agent integration (v1.49.0) in src/main/index.ts: the four agents:*
// IPC channels, the swarm conductor's own --mcp-config file, the [agents] lines the boot prints,
// and the `--disconnect-agents` switch the Windows uninstaller runs.
//
// agentIntegrationManager owns every decision -- consent, which agent config gets what, which
// folders are safe to trust -- and has its own suites. index.ts only WIRES it, so here the manager
// is replaced wholesale by spies and every assertion is about the wiring: which paths and runtime
// index.ts hands it, how a verdict or a throw comes back over IPC (ok()/err(), never a rejected
// promise), what gets logged, and in what order. With the manager mocked, nothing in this file can
// reach a real ~/.claude, ~/.claude.json, ~/.codex or ~/.gemini.
//
// Same harness as mainIpcAppLog.test.ts: `electron` is mocked, every ipcMain.handle callback is
// captured into a Map, and `fs` is stubbed. app.getPath() points at a throwaway temp folder, so the
// few modules that still write through real fs (the app log) land there and are removed afterwards.
//
// The contracts pinned here:
//   * Every use resolves the agent paths afresh from homedir(), userData and the LIVE env, because
//     CLAUDE_CONFIG_DIR / CODEX_HOME are read the way the agents themselves read them.
//   * agents:integration-set checks `connect` before anything is touched, and passes primerHook on
//     only when it is a real boolean -- anything else goes as undefined, so the stored choice
//     stands. The conductor's config is rewritten AFTER the manager call, on connect and on
//     disconnect, and failing to write it is logged, never turned into a failed Connect.
//   * agents:folder-trust-allowed asks about the shell's LIVE folder (else the renderer's cwd),
//     answers false without a usable folder, and gives the last word to the second verdict, the one
//     that includes the git root -- null, never '', when there is none.
//   * `--disconnect-agents` runs before Sentry starts, prints one row per change (with the error when
//     there is one) and exits 0 even when the disconnect throws: an uninstaller must never be
//     blocked, or failed, by a config it could not clean.
//   * Settings ▸ Accounts (v1.54.0, accountsIpc.ts, mocked whole here too): its IPC is registered
//     once with main's own paths, runtime, consent and folder dialog; the runtime carries every
//     connected account's profile; and the launch-time writes and answers -- folder trust, the
//     poller's trust verdict, the Codex prepare, the home-trust removal -- go to the launch's own
//     account, and refuse one the user didn't connect (R9).
//
// Why this file pins `@vitest-environment node` (line 1): Vitest 4 dropped `environmentMatchGlobs`,
// so vitest.config.ts's ['tests/electron/**', 'node'] is silently ignored and every file in
// tests/electron without a pragma runs under the config's default, jsdom. The app runs index.ts in
// Node, so this file does too. It once had to: under jsdom 'os' is Vite's browser-external shim
// and a builtin's names are bound where its import is written, so while index.ts imported `os`
// below the --disconnect-agents block, the block died with "Cannot access 'homedir' before
// initialization" before it disconnected anything. index.ts now imports `os` above the block, and
// mainDisconnectAgentsExit.test.ts runs the block under jsdom ON PURPOSE to keep it there. Between
// the two files the block runs under both environments.

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, type MockInstance } from 'vitest'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { AGENT_INTEGRATION_IPC as IPC } from '../../src/shared/agentIntegration'
import { sanitizeAgentCommand } from '../../src/main/agentCommandSanitizer'

// ---------------------------------------------------------------------------
// Agent-integration spies. The manager is mocked whole, so every value it "returns" here is an
// opaque sentinel that index.ts must hand on untouched.
// ---------------------------------------------------------------------------
const H = vi.hoisted(() => {
  // Node's own require: vi.mock('fs') below does not reach it, so this is a REAL temp folder.
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  const agentPaths = {
    home: '/scratch/home',
    userData: '/scratch/ud',
    claudeDir: '/scratch/home/.claude',
    claudeJson: '/scratch/home/.claude.json',
    codexHome: '/scratch/home/.codex',
    geminiDir: '/scratch/home/.gemini',
  }
  const status = { consent: 'granted', sentinel: 'status' }
  const setResult = { status, changes: [], sentinel: 'set-result' }
  const runner = { command: '/scratch/bin/node', env: { SENTINEL: 'runner' } }
  const conductorCfg = { mcpServers: { termpolis: { type: 'stdio', command: '/scratch/bin/node', args: ['adapter.cjs'] } } }
  // What the boot reports: one clean change and one that failed, so both halves of the line show.
  const profiles = [{ agent: 'claude', dir: '/scratch/home/.claude-b', claudeJson: '/scratch/home/.claude-b/.claude.json', accountId: 'acc_bbbbbbbbbbbb' }]
  const bootChanges = [
    { agent: 'claude', file: '/scratch/home/.claude/settings.json', action: 'add', what: 'SessionStart memory hook' },
    { agent: 'codex', file: '/scratch/home/.codex/config.toml', action: 'skipped', what: 'MCP server `termpolis`', error: 'EACCES: permission denied' },
  ]
  return {
    userData: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'tp-agent-ipc-')),
    agentPaths, status, setResult, runner, conductorCfg, bootChanges,
    appExit: vi.fn((_code?: number) => undefined),
    existsSync: vi.fn((_p: string) => false),
    safeGitAsync: vi.fn(async (_args: string[], _opts?: unknown) => ''),
    resolveNodeRunner: vi.fn(() => runner),
    resolveAgentIntegrationPaths: vi.fn((_home: string, _userData: string, _env: NodeJS.ProcessEnv) => agentPaths),
    bootAgentIntegration: vi.fn((_rt: unknown) => ({ status, changes: bootChanges })),
    disconnectAgentIntegration: vi.fn((_paths: unknown): Array<Record<string, string>> => []),
    getAgentIntegrationStatus: vi.fn((_paths: unknown) => status),
    setAgentIntegration: vi.fn((_rt: unknown, _req: unknown) => setResult),
    isFolderTrustAllowed: vi.fn((_paths: unknown, _cwd: string, _root?: string | null) => true),
    trustFolderForAgents: vi.fn(() => ({ changed: false, keys: [] as string[] })),
    prepareCodexLaunch: vi.fn(() => ({ developerInstructions: null })),
    removeCodexHomeTrust: vi.fn((_paths: unknown): { changed: boolean; error?: string } => ({ changed: true })),
    conductorMcpConfig: vi.fn((_rt: unknown) => conductorCfg),
    isAgentIntegrationConnected: vi.fn((_paths: unknown) => true),
    // Settings ▸ Accounts, whole: the sentinel profiles prove the runtime hands them on untouched.
    profiles,
    registerAccountsIpc: vi.fn((_ipc: unknown, _deps: unknown) => undefined),
    connectedProfileTargets: vi.fn((_paths: unknown) => profiles),
    resolveLaunchTarget: vi.fn((_paths: unknown, _id: unknown, _agent: string): { connected: boolean; target?: unknown } => ({ connected: true })),
    isTerminalAccountConnected: vi.fn((_paths: unknown, _id: unknown) => true),
    codexHomeFor: vi.fn((_paths: unknown, _id: unknown): { home?: string } | { error: string } => ({})),
    accountSettingsEnv: vi.fn((_paths: unknown, _id: unknown): Record<string, unknown> | null | undefined => undefined),
    forgetTerminalAccount: vi.fn((_id: string) => undefined),
    noteTypedInput: vi.fn((_id: string, _typed: string): 'own' | 'by-hand' | null => null),
    noteSwarmWorker: vi.fn((_id: string) => undefined),
    noteWorkerCommand: vi.fn((_id: string, _command: string) => undefined),
    noteWorkerInput: vi.fn((_id: string, _typed: string) => undefined),
    // The chooser's marker (R6): the extra env as it came, so every other test sees today's.
    withLimitChooser: vi.fn((extra: Record<string, string> | undefined, _watch: unknown) => extra),
    relaunchLockReason: vi.fn((_id: string, _now?: number, _key?: string): string | null => null),
    getTerminalSize: vi.fn((_id: string): { cols: number; rows: number } | null => null),
    isShellInForeground: vi.fn((_id: string): boolean | null => null),
    terminalShellAlone: vi.fn(async (_id: string): Promise<boolean | null> => null),
    mcpHandlers: null as null | Record<string, (...a: any[]) => any>,
    getProxyEnv: vi.fn((_env: unknown, _settingsEnv?: unknown): Record<string, string> | null => null),
    mkdirSync: vi.fn(),
  }
})

// ---------------------------------------------------------------------------
// Harness — mirrors tests/electron/mainIpcAppLog.test.ts (plus app.exit, and app.getPath on a temp folder)
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
    getPath: vi.fn(() => H.userData),
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
    exit: H.appExit,
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
  // Primed at startup so spawnTerminal never probes for jq/yq/nano on the main thread.
  primeBundledToolsCheck: vi.fn(async () => false),
  spawnTerminal: mockSpawnTerminal,
  killTerminal: mockKillTerminal,
  writeToTerminal: mockWriteToTerminal,
  resizeTerminal: mockResizeTerminal,
  killAll: vi.fn(), whenTerminalsExit: vi.fn(() => Promise.resolve()), runningShellCount: vi.fn(() => 0),
  getTerminalCwd: mockGetTerminalCwd,
  getTerminalCwdAsync: mockGetTerminalCwdAsync,
  getTerminalPid: mockGetTerminalPid,
  computeWindowsPty: mockComputeWindowsPty,
  getTerminalSize: H.getTerminalSize,
  isShellInForeground: H.isShellInForeground,
  terminalShellAlone: H.terminalShellAlone,
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
  startMcpServer: vi.fn((handlers: Record<string, (...a: any[]) => any>) => { H.mcpHandlers = handlers }), stopMcpServer: vi.fn(),
  getMcpAuthToken: vi.fn(() => 'fake-token'), getMcpPort: vi.fn(() => 9315),
  initAuditLog: vi.fn(),
  awaitMcpPortBound: vi.fn(() => Promise.resolve(9315)),
  // The shell's prompt report, as mcpServer.ts defines it: OSC 9;9 (PowerShell, cmd) or OSC 7 (bash).
  PROMPT_REPORT: /\x1b\](?:9;9;|7;)/g,
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
    writeFileSync: mockWriteFileSync, existsSync: H.existsSync,
    readFileSync: vi.fn(() => '{}'), readdirSync: vi.fn(() => []),
    statSync: vi.fn(() => ({ isDirectory: () => false, mtimeMs: 0, size: 0 })),
    mkdirSync: H.mkdirSync, appendFileSync: vi.fn(),
    renameSync: vi.fn(), unlinkSync: vi.fn(), watch: vi.fn(),
  }
  return { ...impl, default: impl }
})

vi.mock('uuid', () => ({ v4: vi.fn(() => 'mock-uuid') }))

// The manager, whole -- index.ts only wires it (see the header). A factory mock throws on access
// to a name it does not define, so this lists every export index.ts imports from it.
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
  isAgentIntegrationConnected: H.isAgentIntegrationConnected,
}))
// Settings ▸ Accounts, whole, for the same reason as the manager.
vi.mock('../../src/main/accountsIpc', () => ({
  registerAccountsIpc: H.registerAccountsIpc,
  connectedProfileTargets: H.connectedProfileTargets,
  resolveLaunchTarget: H.resolveLaunchTarget,
  isTerminalAccountConnected: H.isTerminalAccountConnected,
  codexHomeFor: H.codexHomeFor,
  accountSettingsEnv: H.accountSettingsEnv,
  forgetTerminalAccount: H.forgetTerminalAccount,
  noteTypedInput: H.noteTypedInput,
  noteSwarmWorker: H.noteSwarmWorker,
  noteWorkerCommand: H.noteWorkerCommand,
  noteWorkerInput: H.noteWorkerInput,
  withLimitChooser: H.withLimitChooser,
  endAccountSignIns: vi.fn(),
}))
// The switch's lock, so a test can hold a terminal as a switch would.
vi.mock('../../src/main/accountSwitch', () => ({ relaunchLockReason: H.relaunchLockReason }))
// The proxy's launch env, so a test can see which profile's routing it was asked about.
vi.mock('../../src/main/headroomProxy/proxySupervisor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/headroomProxy/proxySupervisor')>()),
  getProxyEnv: H.getProxyEnv,
}))
// The git-root probe, so a test can say what `git rev-parse --show-toplevel` answered.
vi.mock('../../src/main/gitCommand', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/gitCommand')>()),
  safeGitAsync: H.safeGitAsync,
}))
// One interpreter decision for all three agents; a sentinel runner proves it is handed on untouched.
vi.mock('../../src/main/agentMcpRegistry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/agentMcpRegistry')>()),
  resolveNodeRunner: H.resolveNodeRunner,
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function invoke(channel: string, args: any = {}): any {
  const handler = ipcHandlers.get(channel)
  if (!handler) throw new Error(`No handler for ${channel}`)
  return handler({}, args)
}

/** Dev-build adapter path -- the same join index.ts performs from src/main. */
const DEV_ADAPTER = join(__dirname, '..', '..', 'src', 'mcp-adapter', 'stdio-adapter.cjs')
const CONDUCTOR_FILE = join(H.userData, 'claude-mcp-config.json')
const CONDUCTOR_JSON = JSON.stringify(H.conductorCfg, null, 2)

/** The runtime index.ts assembles for the manager in a dev build with no hook script on disk
 *  (existsSync is stubbed false here; mainIndexBranchesB covers the hook-present path on real fs). */
const RUNTIME = { paths: H.agentPaths, profiles: H.profiles, adapterPath: DEV_ADAPTER, hookScriptPath: null, node: H.runner }

/** writeFileSync calls that wrote the conductor's --mcp-config, each with its global call order. */
function conductorWrites(): Array<{ args: unknown[]; order: number }> {
  return mockWriteFileSync.mock.calls
    .map((args: unknown[], i: number) => ({ args, order: mockWriteFileSync.mock.invocationCallOrder[i] }))
    .filter(({ args }: { args: unknown[] }) => args[0] === CONDUCTOR_FILE)
}

/** `git rev-parse --show-toplevel` probes -- the only git these handlers run. */
const rootProbes = (): unknown[][] =>
  H.safeGitAsync.mock.calls.filter(([args]) => args[0] === 'rev-parse' && args[1] === '--show-toplevel')

/** Global call order of the first console call whose first argument is exactly `first`. */
function orderOf(spy: MockInstance<(...args: any[]) => void>, first: string): number {
  const i = spy.mock.calls.findIndex((c) => c[0] === first)
  if (i === -1) throw new Error(`never logged: ${first}`)
  return spy.mock.invocationCallOrder[i]
}

let logSpy: MockInstance<(...args: any[]) => void>
let warnSpy: MockInstance<(...args: any[]) => void>
let errorSpy: MockInstance<(...args: any[]) => void>

/** What the one normal boot did, captured before the first beforeEach clears every spy. */
const boot = {
  runtimes: [] as unknown[],
  conductorConfigs: [] as unknown[],
  conductorWrites: [] as Array<{ args: unknown[]; order: number }>,
  pathCalls: [] as unknown[][],
  agentLines: [] as string[],
  disconnects: -1,
  exits: -1,
  accountsRegistrations: [] as unknown[][],
}

beforeAll(async () => {
  // Installed before index.ts loads: captureConsole() wraps whatever console.* is at that moment
  // and still calls through to it, so these spies see every line with its raw arguments.
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.resetModules()
  await import('../../src/main/index')
  // The agent-integration boot runs inside app.whenReady(); wait for it, not for a fixed delay.
  await vi.waitFor(() => expect(H.bootAgentIntegration).toHaveBeenCalled(), { timeout: 15_000, interval: 20 })
  boot.runtimes = H.bootAgentIntegration.mock.calls.map((c) => c[0])
  boot.conductorConfigs = H.conductorMcpConfig.mock.calls.map((c) => c[0])
  boot.conductorWrites = conductorWrites()
  boot.pathCalls = H.resolveAgentIntegrationPaths.mock.calls.map((c) => [...c])
  boot.agentLines = logSpy.mock.calls
    .map((c) => c[0])
    .filter((l): l is string => typeof l === 'string' && l.startsWith('[agents]'))
  boot.disconnects = H.disconnectAgentIntegration.mock.calls.length
  boot.exits = H.appExit.mock.calls.length
  boot.accountsRegistrations = H.registerAccountsIpc.mock.calls.map((c) => [...c])
}, 60_000)

afterAll(() => {
  logSpy?.mockRestore()
  warnSpy?.mockRestore()
  errorSpy?.mockRestore()
  try {
    require('node:fs').rmSync(H.userData, { recursive: true, force: true, maxRetries: 3 })
  } catch { /* best effort: it is a temp folder */ }
})

beforeEach(() => {
  vi.clearAllMocks()
  // clearAllMocks keeps queued once-values; reset what a test may program back to its default.
  for (const m of [
    H.appExit, H.existsSync, H.safeGitAsync, H.resolveAgentIntegrationPaths, H.disconnectAgentIntegration,
    H.getAgentIntegrationStatus, H.setAgentIntegration, H.isFolderTrustAllowed, H.removeCodexHomeTrust,
    H.conductorMcpConfig, mockWriteFileSync, mockGetTerminalCwdAsync,
    H.isAgentIntegrationConnected, H.connectedProfileTargets, H.resolveLaunchTarget, H.isTerminalAccountConnected,
    H.codexHomeFor, H.accountSettingsEnv, H.getProxyEnv, mockShowOpenDialog, mockDetectAvailableShells,
  ] as Array<{ mockReset: () => void }>) m.mockReset()
})

// ===========================================================================
// Boot: the conductor's config and the [agents] change log.
// ===========================================================================
describe('agent-integration boot', () => {
  it('hands the manager the dev adapter, no hook script when none is on disk, and the one node runner', () => {
    expect(boot.runtimes).toEqual([RUNTIME])
  })

  it('resolves the agent paths from the real home folder, userData and the LIVE env on every use', () => {
    expect(boot.pathCalls.length).toBeGreaterThanOrEqual(2) // the conductor's runtime + the boot's
    for (const [home, userData, env] of boot.pathCalls) {
      expect(home).toBe(homedir())
      expect(userData).toBe(H.userData)
      expect(env).toBe(process.env)
    }
  })

  it('writes the swarm conductor its own --mcp-config under userData, whatever the consent', () => {
    expect(boot.conductorConfigs).toEqual([RUNTIME])
    expect(boot.conductorWrites.map((w) => w.args)).toEqual([[CONDUCTOR_FILE, CONDUCTOR_JSON, 'utf-8']])
  })

  it('prints one [agents] line per change, with the error appended only when there is one', () => {
    expect(boot.agentLines).toEqual([
      '[agents] claude: add SessionStart memory hook (/scratch/home/.claude/settings.json)',
      '[agents] codex: skipped MCP server `termpolis` (/scratch/home/.codex/config.toml) — EACCES: permission denied',
    ])
  })

  it('never runs the uninstall disconnect, or exits, on a normal launch', () => {
    expect(boot.disconnects).toBe(0)
    expect(boot.exits).toBe(0)
  })
})

// ===========================================================================
// agents:integration-status
// ===========================================================================
describe('agents:integration-status', () => {
  it('returns the manager status for freshly resolved paths as ok()', async () => {
    expect(await invoke(IPC.status)).toEqual({ success: true, data: H.status })
    expect(H.resolveAgentIntegrationPaths).toHaveBeenCalledWith(homedir(), H.userData, process.env)
    expect(H.getAgentIntegrationStatus).toHaveBeenCalledWith(H.agentPaths)
  })

  it('turns a failure into err() instead of rejecting the IPC promise', async () => {
    H.getAgentIntegrationStatus.mockImplementationOnce(() => { throw new Error('EACCES: ledger unreadable') })
    expect(await invoke(IPC.status)).toEqual({ success: false, error: 'EACCES: ledger unreadable' })
  })
})

// ===========================================================================
// agents:integration-set
// ===========================================================================
describe('agents:integration-set', () => {
  it.each([
    ['a null request', null],
    ['a request with no connect', {}],
    ['a string connect', { connect: 'yes' }],
    ['a numeric connect', { connect: 1 }],
  ])('refuses %s before touching the manager or the conductor config', async (_label, req) => {
    expect(await invoke(IPC.set, req)).toEqual({ success: false, error: 'connect must be true or false' })
    expect(H.setAgentIntegration).not.toHaveBeenCalled()
    expect(conductorWrites()).toEqual([])
  })

  it('connects with the runtime index.ts assembled and returns the manager result as ok()', async () => {
    expect(await invoke(IPC.set, { connect: true, primerHook: true })).toEqual({ success: true, data: H.setResult })
    expect(H.setAgentIntegration).toHaveBeenCalledTimes(1)
    const [rt, req] = H.setAgentIntegration.mock.calls[0]
    expect(rt).toEqual(RUNTIME)
    expect(req).toStrictEqual({ connect: true, primerHook: true })
  })

  it('passes primerHook: false on, so the memory hook can be switched off while connected', async () => {
    await invoke(IPC.set, { connect: true, primerHook: false })
    expect(H.setAgentIntegration.mock.calls[0][1]).toStrictEqual({ connect: true, primerHook: false })
  })

  it.each([
    ['absent', { connect: false }, false],
    ['not a boolean', { connect: true, primerHook: 'off' }, true],
  ])('sends primerHook as undefined when it is %s, so the stored choice stands', async (_label, req, connect) => {
    await invoke(IPC.set, req)
    expect(H.setAgentIntegration.mock.calls[0][1]).toStrictEqual({ connect, primerHook: undefined })
  })

  it.each([true, false])('rewrites the conductor config AFTER the manager call (connect: %s)', async (connect) => {
    await invoke(IPC.set, { connect })
    const writes = conductorWrites()
    expect(writes.map((w) => w.args)).toEqual([[CONDUCTOR_FILE, CONDUCTOR_JSON, 'utf-8']])
    expect(H.conductorMcpConfig).toHaveBeenCalledWith(RUNTIME)
    expect(writes[0].order).toBeGreaterThan(H.setAgentIntegration.mock.invocationCallOrder[0])
  })

  it('still reports the change as done when the conductor config cannot be written, and warns why', async () => {
    mockWriteFileSync.mockImplementationOnce(() => { throw new Error('EPERM: operation not permitted') })
    expect(await invoke(IPC.set, { connect: true })).toEqual({ success: true, data: H.setResult })
    expect(warnSpy).toHaveBeenCalledWith('Could not write the conductor MCP config (non-fatal):', 'EPERM: operation not permitted')
  })

  it('warns with the raw value when the conductor write throws a non-Error', async () => {
    mockWriteFileSync.mockImplementationOnce(() => { throw 'disk full' })
    expect(await invoke(IPC.set, { connect: false })).toEqual({ success: true, data: H.setResult })
    expect(warnSpy).toHaveBeenCalledWith('Could not write the conductor MCP config (non-fatal):', 'disk full')
  })

  it('returns a manager failure as err() and leaves the conductor config alone', async () => {
    H.setAgentIntegration.mockImplementationOnce(() => { throw new Error('ledger is locked') })
    expect(await invoke(IPC.set, { connect: true })).toEqual({ success: false, error: 'ledger is locked' })
    expect(conductorWrites()).toEqual([])
  })
})

// ===========================================================================
// agents:folder-trust-allowed -- asked by App.tsx's prompt poller before it answers a trust prompt.
// ===========================================================================
describe('agents:folder-trust-allowed', () => {
  it("asks about the shell's LIVE folder, then again with its git root, and answers with that second verdict", async () => {
    mockGetTerminalCwdAsync.mockResolvedValueOnce('/work/repo/packages/app')
    H.safeGitAsync.mockResolvedValueOnce('/work/repo\n')
    H.isFolderTrustAllowed.mockReturnValueOnce(true).mockReturnValueOnce(false)
    expect(await invoke(IPC.folderTrustAllowed, { terminalId: 't1', fallbackCwd: '/renderer/cwd' }))
      .toEqual({ success: true, data: false })
    expect(mockGetTerminalCwdAsync).toHaveBeenCalledWith('t1')
    expect(H.resolveAgentIntegrationPaths).toHaveBeenCalledWith(homedir(), H.userData, process.env)
    expect(H.isFolderTrustAllowed.mock.calls).toEqual([
      [H.agentPaths, '/work/repo/packages/app'],
      [H.agentPaths, '/work/repo/packages/app', '/work/repo'],
    ])
    expect(rootProbes()).toEqual([[['rev-parse', '--show-toplevel'], { cwd: '/work/repo/packages/app', timeout: 2000 }]])
  })

  it.each([
    ['cannot be probed', null],
    ['comes back empty', ''],
  ])("falls back to the renderer's cwd when the live folder %s", async (_label, live) => {
    mockGetTerminalCwdAsync.mockResolvedValueOnce(live as string)
    H.safeGitAsync.mockResolvedValueOnce('/renderer/repo')
    expect(await invoke(IPC.folderTrustAllowed, { terminalId: 't2', fallbackCwd: '/renderer/repo' }))
      .toEqual({ success: true, data: true })
    expect(H.isFolderTrustAllowed.mock.calls).toEqual([
      [H.agentPaths, '/renderer/repo'],
      [H.agentPaths, '/renderer/repo', '/renderer/repo'],
    ])
  })

  it('does not probe a terminal when terminalId is not a string', async () => {
    await invoke(IPC.folderTrustAllowed, { terminalId: 42, fallbackCwd: '/renderer/repo' })
    expect(mockGetTerminalCwdAsync).not.toHaveBeenCalled()
    expect(H.isFolderTrustAllowed.mock.calls[0]).toEqual([H.agentPaths, '/renderer/repo'])
  })

  it.each([
    ['a null request', null],
    ['no folder at all', {}],
    ['a non-string fallback cwd', { fallbackCwd: 42 }],
    ['an empty fallback cwd', { fallbackCwd: '' }],
  ])('answers false for %s without asking the manager or git', async (_label, req) => {
    expect(await invoke(IPC.folderTrustAllowed, req)).toEqual({ success: true, data: false })
    expect(H.isFolderTrustAllowed).not.toHaveBeenCalled()
    expect(rootProbes()).toEqual([])
  })

  it('answers false for a folder the manager refuses, without spawning git', async () => {
    H.isFolderTrustAllowed.mockReturnValueOnce(false)
    expect(await invoke(IPC.folderTrustAllowed, { fallbackCwd: '/scratch/home' })).toEqual({ success: true, data: false })
    expect(H.isFolderTrustAllowed).toHaveBeenCalledTimes(1)
    expect(rootProbes()).toEqual([])
  })

  it.each([
    ['git fails (not a repository)', () => { H.safeGitAsync.mockRejectedValueOnce(new Error('fatal: not a git repository')) }],
    ['git prints only whitespace', () => { H.safeGitAsync.mockResolvedValueOnce('  \n') }],
  ])('asks with a null root, never an empty-string one, when %s', async (_label, arrange) => {
    arrange()
    expect(await invoke(IPC.folderTrustAllowed, { fallbackCwd: '/scratch/notes' })).toEqual({ success: true, data: true })
    expect(H.isFolderTrustAllowed).toHaveBeenLastCalledWith(H.agentPaths, '/scratch/notes', null)
  })

  it('returns a probe failure as err() instead of rejecting the IPC promise', async () => {
    mockGetTerminalCwdAsync.mockRejectedValueOnce(new Error('terminal is gone'))
    expect(await invoke(IPC.folderTrustAllowed, { terminalId: 't9', fallbackCwd: '/renderer/repo' }))
      .toEqual({ success: false, error: 'terminal is gone' })
    expect(H.isFolderTrustAllowed).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// agents:remove-codex-home-trust
// ===========================================================================
describe('agents:remove-codex-home-trust', () => {
  it('removes the trust for freshly resolved paths and returns the verdict as ok()', async () => {
    H.removeCodexHomeTrust.mockReturnValueOnce({ changed: false })
    expect(await invoke(IPC.removeCodexHomeTrust)).toEqual({ success: true, data: { changed: false } })
    expect(H.resolveAgentIntegrationPaths).toHaveBeenCalledWith(homedir(), H.userData, process.env)
    // No account named: the default CODEX_HOME.
    expect(H.codexHomeFor).toHaveBeenCalledWith(H.agentPaths, undefined)
    expect(H.removeCodexHomeTrust).toHaveBeenCalledWith(H.agentPaths, undefined)
  })

  it('returns a failure as err()', async () => {
    H.resolveAgentIntegrationPaths.mockImplementationOnce(() => { throw new Error('no home folder') })
    expect(await invoke(IPC.removeCodexHomeTrust)).toEqual({ success: false, error: 'no home folder' })
    expect(H.removeCodexHomeTrust).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// Settings ▸ Accounts (v1.54.0): the IPC's registration, and the account a launch-time write or
// answer goes to.
// ===========================================================================
describe('Settings ▸ Accounts wiring', () => {
  const deps = (): any => boot.accountsRegistrations[0][1]

  it('registers the accounts IPC once, on ipcMain, with main\'s own paths, runtime and consent', () => {
    expect(boot.accountsRegistrations).toHaveLength(1)
    expect(typeof (boot.accountsRegistrations[0][0] as { handle: unknown }).handle).toBe('function')
    expect(deps().paths()).toBe(H.agentPaths)
    expect(H.resolveAgentIntegrationPaths).toHaveBeenCalledWith(homedir(), H.userData, process.env)
    expect(deps().runtime()).toEqual(RUNTIME)
    H.isAgentIntegrationConnected.mockReturnValueOnce(false)
    expect(deps().integrationConnected()).toBe(false)
    expect(H.isAgentIntegrationConnected).toHaveBeenCalledWith(H.agentPaths)
    expect(deps().integrationConnected()).toBe(true)
  })

  it('gives agent integration every connected account\'s profile, read afresh for each runtime', () => {
    expect(boot.runtimes.map((r) => (r as { profiles: unknown }).profiles)).toEqual([H.profiles])
    H.connectedProfileTargets.mockClear()
    deps().runtime()
    expect(H.connectedProfileTargets).toHaveBeenCalledWith(H.agentPaths)
  })

  it('opens main\'s own folder dialog on hidden folders, and answers null when it is cancelled', async () => {
    mockShowOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/scratch/home/.claude-x'] })
    expect(await deps().pickFolder('Choose the Claude Code profile folder')).toBe('/scratch/home/.claude-x')
    expect(mockShowOpenDialog).toHaveBeenCalledWith(mockMainWindow, {
      title: 'Choose the Claude Code profile folder', defaultPath: homedir(), properties: ['openDirectory', 'showHiddenFiles'],
    })
    mockShowOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: ['/scratch/home/.claude-x'] })
    expect(await deps().pickFolder('t')).toBeNull()
    mockShowOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [] })
    expect(await deps().pickFolder('t')).toBeNull()
  })

  it('takes the folder an e2e run names only in a test run, with no dialog', async () => {
    const saved = { home: process.env.TERMPOLIS_TEST_AGENT_HOME, folder: process.env.TERMPOLIS_TEST_ACCOUNT_FOLDER }
    try {
      process.env.TERMPOLIS_TEST_ACCOUNT_FOLDER = '/scratch/home/.claude-e2e'
      delete process.env.TERMPOLIS_TEST_AGENT_HOME
      mockShowOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
      expect(await deps().pickFolder('t')).toBeNull()
      expect(mockShowOpenDialog).toHaveBeenCalledTimes(1)
      process.env.TERMPOLIS_TEST_AGENT_HOME = '/scratch/home'
      expect(await deps().pickFolder('t')).toBe('/scratch/home/.claude-e2e')
      expect(mockShowOpenDialog).toHaveBeenCalledTimes(1)
    } finally {
      if (saved.home === undefined) delete process.env.TERMPOLIS_TEST_AGENT_HOME
      else process.env.TERMPOLIS_TEST_AGENT_HOME = saved.home
      if (saved.folder === undefined) delete process.env.TERMPOLIS_TEST_ACCOUNT_FOLDER
      else process.env.TERMPOLIS_TEST_ACCOUNT_FOLDER = saved.folder
    }
  })

  it('opens a provider\'s sign-in page through the shell, only as main\'s accounts code asks', () => {
    deps().openExternal('https://claude.com/cai/oauth/authorize?x=1')
    expect(mockOpenExternal).toHaveBeenCalledWith('https://claude.com/cai/oauth/authorize?x=1')
  })

  it('sends a sign-in\'s state to the window, and runs the status checks in a folder of its own', () => {
    deps().send('accounts:sign-in-state', { sessionId: 's1', accountId: 'acc_bbbbbbbbbbbb', agent: 'claude', phase: { kind: 'starting' } })
    expect(mockWebContents.send).toHaveBeenCalledWith('accounts:sign-in-state', { sessionId: 's1', accountId: 'acc_bbbbbbbbbbbb', agent: 'claude', phase: { kind: 'starting' } })
    const dir = join(H.userData, 'account-checks')
    expect(deps().checkCwd()).toBe(dir)
    expect(H.mkdirSync).toHaveBeenCalledWith(dir, { recursive: true })
  })

  it('tells where a terminal\'s output ends now, for where an agent a launch line starts begins', async () => {
    mockDetectAvailableShells.mockResolvedValue([{ type: 'powershell', executable: 'powershell.exe' }])
    await invoke('terminal:create', { id: 't-end', shellType: 'powershell', cwd: '/scratch/home' })
    const onData = mockSpawnTerminal.mock.calls[0][3] as (d: string) => void
    expect(deps().outputEnd('t-end')).toBe(0)
    onData('PS C:\\> ')
    expect(deps().outputEnd('t-end')).toBe('PS C:\\> '.length)
    expect(deps().outputEnd('t-none')).toBe(0)
  })

  it('shows every write from the renderer, as typed, to the account watch, after it reached the PTY', () => {
    const write = (data: string) => { for (const h of ipcOnHandlers.get('terminal:write') ?? []) h({}, { id: 't-typed', data }) }
    const order: string[] = []
    mockWriteToTerminal.mockImplementationOnce(() => { order.push('pty') })
    H.noteTypedInput.mockImplementationOnce(() => { order.push('watch'); return null })
    write('\x1b[200~unset CLAUDE_CONFIG_DIR\x1b[201~')
    // The paste's markers stay on what the account watch is shown (they say a paste's line breaks are
    // text, not Enters: accountsIpc.ts gatherLines); the launch audit reads it with them off.
    expect(H.noteTypedInput).toHaveBeenCalledWith('t-typed', '\x1b[200~unset CLAUDE_CONFIG_DIR\x1b[201~', expect.any(Number), undefined)
    expect(order).toEqual(['pty', 'watch'])
    // A watch that throws never breaks the terminal.
    H.noteTypedInput.mockImplementationOnce(() => { throw new Error('boom') })
    expect(() => write('x')).not.toThrow()
    expect(mockWriteToTerminal).toHaveBeenLastCalledWith('t-typed', 'x')
    // Only text is a typed line: a write that is not a string (a malformed message) is shown to the watch as nothing.
    H.noteTypedInput.mockClear()
    for (const h of ipcOnHandlers.get('terminal:write') ?? []) h({}, { id: 't-typed', data: 42 })
    expect(H.noteTypedInput).not.toHaveBeenCalled()
  })

  it('drops the renderer\'s keys, and refuses MCP\'s, for a terminal a switch holds (R7)', () => {
    const write = (data: string) => { for (const h of ipcOnHandlers.get('terminal:write') ?? []) h({}, { id: 't-held', data }) }
    H.relaunchLockReason.mockImplementation((id: string) => (id === 't-held' ? 'held' : null))
    mockWriteToTerminal.mockClear()
    H.noteTypedInput.mockClear()
    write('typed while switching\r')
    expect(mockWriteToTerminal).not.toHaveBeenCalled()
    expect(H.noteTypedInput).not.toHaveBeenCalled()
    for (const h of ipcOnHandlers.get('terminal:write') ?? []) h({}, { id: 't-free', data: 'x' })
    expect(mockWriteToTerminal).toHaveBeenCalledWith('t-free', 'x')
    // MCP asks main's lock for the terminal (mcpServer.ts refuses the call with its words).
    expect(H.mcpHandlers!.relaunchLock('t-held')).toBe('held')
    expect(H.mcpHandlers!.relaunchLock('t-free')).toBeNull()
    H.relaunchLockReason.mockImplementation(() => null)
  })

  it('lets the model picker\'s own writes through its hold, by the key they carry (§7.5)', () => {
    const write = (payload: Record<string, unknown>) => { for (const h of ipcOnHandlers.get('terminal:write') ?? []) h({}, { id: 't-model', ...payload }) }
    H.relaunchLockReason.mockImplementation((_id: string, _now?: number, key?: string) => (key === 'k-picker' ? null : 'held'))
    mockWriteToTerminal.mockClear()
    write({ data: 'typed meanwhile\r' })
    expect(H.relaunchLockReason).toHaveBeenLastCalledWith('t-model', expect.any(Number), undefined)
    write({ data: '/quit', key: 'k-other' })
    // A key that is no string is none.
    write({ data: 'x', key: 7 })
    expect(H.relaunchLockReason).toHaveBeenLastCalledWith('t-model', expect.any(Number), undefined)
    expect(mockWriteToTerminal).not.toHaveBeenCalled()
    write({ data: '/quit', key: 'k-picker' })
    // The key goes to the lock, never to the PTY.
    expect(H.relaunchLockReason).toHaveBeenLastCalledWith('t-model', expect.any(Number), 'k-picker')
    expect(mockWriteToTerminal.mock.calls).toEqual([['t-model', '/quit']])
    // ...and to the watch of what is typed, which counts the picker's relaunch line as the agent's start
    // (accountsIpc.ts noteTypedInput): a key that is no string is none there too.
    expect(H.noteTypedInput).toHaveBeenLastCalledWith('t-model', '/quit', expect.any(Number), 'k-picker')
    H.relaunchLockReason.mockImplementation(() => null)
    write({ data: 'x', key: 7 })
    expect(H.noteTypedInput).toHaveBeenLastCalledWith('t-model', 'x', expect.any(Number), undefined)
  })

  it('reads and types for a switch through the terminals\' buffers and PTYs', async () => {
    mockDetectAvailableShells.mockResolvedValue([{ type: 'powershell', executable: 'powershell.exe' }])
    await invoke('terminal:create', { id: 't-sw', shellType: 'powershell', cwd: '/scratch/home' })
    const onData = mockSpawnTerminal.mock.calls[0][3] as (d: string) => void
    const io = deps().switchIO
    expect(io.output('t-sw')).toBeNull()
    onData('PS C:\\> ')
    expect(io.output('t-sw')).toEqual({ raw: 'PS C:\\> ', end: 8 })
    expect(io.outputFrom('t-sw', 3)).toBe('C:\\> ')
    expect(io.end('t-sw')).toBe(8)
    H.getTerminalSize.mockReturnValueOnce({ cols: 120, rows: 30 })
    expect(io.size('t-sw')).toEqual({ cols: 120, rows: 30 })
    io.write('t-sw', '/exit')
    expect(mockWriteToTerminal).toHaveBeenLastCalledWith('t-sw', '/exit')
    expect(typeof io.now()).toBe('number')
    // macOS and Linux: whether the shell is the PTY's foreground again (terminalManager.ts).
    H.isShellInForeground.mockReturnValueOnce(true)
    expect(io.atShell!('t-sw')).toBe(true)
    expect(H.isShellInForeground).toHaveBeenLastCalledWith('t-sw')
    // The OS's full answer on whether only the shell is left (shellAlone.ts), which the switch asks at
    // its exit and the model switch and submit ask at theirs; main hands it the terminal's own.
    H.terminalShellAlone.mockResolvedValueOnce(true)
    expect(await io.shellAlone!('t-sw')).toBe(true)
    expect(H.terminalShellAlone).toHaveBeenLastCalledWith('t-sw')
    H.terminalShellAlone.mockResolvedValueOnce(null)
    expect(await io.shellAlone!('t-sw')).toBeNull()
    vi.useFakeTimers()
    const slept = io.sleep(250)
    vi.advanceTimersByTime(250)
    await expect(slept).resolves.toBeUndefined()
    vi.useRealTimers()
  })

  it('trusts a folder in the launch\'s own profile, and refuses an account the user didn\'t connect (R9)', async () => {
    const target = H.profiles[0]
    H.resolveLaunchTarget.mockReturnValueOnce({ connected: false })
    expect(await invoke('claude:trust-workspace', { cwd: '/repo', accountId: 'acc_off' }))
      .toEqual({ success: true, data: { changed: false, keys: [], skipped: 'account-not-connected' } })
    expect(H.resolveLaunchTarget).toHaveBeenCalledWith(H.agentPaths, 'acc_off', 'claude')
    expect(H.isFolderTrustAllowed).not.toHaveBeenCalled()
    expect(H.trustFolderForAgents).not.toHaveBeenCalled()
    expect(rootProbes()).toEqual([])
    H.resolveLaunchTarget.mockReturnValueOnce({ connected: true, target })
    H.safeGitAsync.mockResolvedValueOnce('/repo\n')
    await invoke('claude:trust-workspace', { cwd: '/repo/app', accountId: 'acc_bbbbbbbbbbbb' })
    expect(H.trustFolderForAgents).toHaveBeenLastCalledWith(H.agentPaths, '/repo/app', '/repo', target)
    H.resolveLaunchTarget.mockReturnValueOnce({ connected: true, target })
    H.isFolderTrustAllowed.mockReturnValueOnce(false)
    await invoke('claude:trust-workspace', { cwd: '/home/me', accountId: 'acc_bbbbbbbbbbbb' })
    expect(H.trustFolderForAgents).toHaveBeenLastCalledWith(H.agentPaths, '/home/me', undefined, target)
  })

  it('never lets the poller answer a trust prompt in a terminal on an unconnected account (R9)', async () => {
    H.isTerminalAccountConnected.mockReturnValueOnce(false)
    expect(await invoke(IPC.folderTrustAllowed, { terminalId: 't-off', fallbackCwd: '/repo' })).toEqual({ success: true, data: false })
    expect(H.isTerminalAccountConnected).toHaveBeenCalledWith(H.agentPaths, 't-off')
    // Refused before the shell is probed or the manager asked.
    expect(mockGetTerminalCwdAsync).not.toHaveBeenCalled()
    expect(H.isFolderTrustAllowed).not.toHaveBeenCalled()
  })

  it('prepares a Codex launch in the account\'s own CODEX_HOME, and adds nothing for one not connected (R9)', async () => {
    H.resolveLaunchTarget.mockReturnValueOnce({ connected: true, target: { agent: 'codex', dir: '/scratch/home/.codex-b', accountId: 'acc_c' } })
    await invoke('memory:prepare-codex-context', { cwd: '/repo', accountId: 'acc_c' })
    expect(H.resolveLaunchTarget).toHaveBeenCalledWith(H.agentPaths, 'acc_c', 'codex')
    expect(H.prepareCodexLaunch).toHaveBeenLastCalledWith(H.agentPaths, '/repo', expect.objectContaining({ accountConnected: true }), '/scratch/home/.codex-b')
    H.resolveLaunchTarget.mockReturnValueOnce({ connected: false })
    await invoke('memory:prepare-codex-context', { cwd: '/repo', accountId: 'acc_off' })
    expect(H.prepareCodexLaunch).toHaveBeenLastCalledWith(H.agentPaths, '/repo', expect.objectContaining({ accountConnected: false }), undefined)
  })

  it('takes home-folder trust out of an account\'s CODEX_HOME, and never the default one instead of a missing one', async () => {
    H.codexHomeFor.mockReturnValueOnce({ home: '/scratch/home/.codex-b' })
    await invoke(IPC.removeCodexHomeTrust, { accountId: 'acc_c' })
    expect(H.codexHomeFor).toHaveBeenCalledWith(H.agentPaths, 'acc_c')
    expect(H.removeCodexHomeTrust).toHaveBeenCalledWith(H.agentPaths, '/scratch/home/.codex-b')
    H.removeCodexHomeTrust.mockClear()
    H.codexHomeFor.mockReturnValueOnce({ error: 'lost\'s profile folder doesn\'t exist' })
    expect(await invoke(IPC.removeCodexHomeTrust, { accountId: 'acc_lost' }))
      .toEqual({ success: true, data: { changed: false, error: 'lost\'s profile folder doesn\'t exist' } })
    expect(H.removeCodexHomeTrust).not.toHaveBeenCalled()
  })

  it("hands the chooser's marker the extra env and what the launch watches, for a terminal and for a swarm worker (R6)", async () => {
    mockDetectAvailableShells.mockResolvedValue([{ type: 'powershell', executable: 'powershell.exe' }])
    const marked = { TERMPOLIS_LIMIT_CHOOSER: '1' }
    H.withLimitChooser.mockReturnValueOnce(marked)
    await invoke('terminal:create', { id: 't-watch', shellType: 'powershell', cwd: '/repo', limitWatch: 'claude' })
    expect(H.withLimitChooser).toHaveBeenLastCalledWith(undefined, 'claude')
    expect(mockSpawnTerminal.mock.calls[0][5]).toBe(marked)
    const proxied = { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' }
    H.getProxyEnv.mockReturnValueOnce(proxied)
    await invoke('terminal:create', { id: 't-plain2', shellType: 'powershell', cwd: '/repo', claudeHeadroom: true })
    expect(H.withLimitChooser).toHaveBeenLastCalledWith(proxied, undefined)
    // A swarm worker is watched (by the swarm's loop); a phone's terminal isn't.
    await H.mcpHandlers!.createTerminal('Claude (Build UI)', 'powershell', '/repo')
    expect(H.withLimitChooser).toHaveBeenLastCalledWith(undefined, true)
    await H.mcpHandlers!.createTerminal('Phone', 'powershell', '/repo', { agentCommand: 'claude' })
    expect(H.withLimitChooser).toHaveBeenLastCalledWith(undefined, false)
  })

  it('judges a Claude launch\'s proxy by its own account\'s profile, and forgets a terminal\'s account when it closes', async () => {
    mockDetectAvailableShells.mockResolvedValue([{ type: 'powershell', executable: 'powershell.exe' }])
    const accountEnv = { ANTHROPIC_BASE_URL: 'http://gateway.example' }
    H.accountSettingsEnv.mockReturnValueOnce(accountEnv)
    expect((await invoke('terminal:create', { id: 't-acc', shellType: 'powershell', cwd: '/repo', claudeHeadroom: true, accountId: 'acc_bbbbbbbbbbbb' })).success).toBe(true)
    expect(H.accountSettingsEnv).toHaveBeenCalledWith(H.agentPaths, 'acc_bbbbbbbbbbbb')
    expect(H.getProxyEnv).toHaveBeenCalledWith(process.env, accountEnv)
    // The proxy stepped aside (null), so the launch gets no proxy env.
    expect(mockSpawnTerminal.mock.calls[0][5]).toBeUndefined()
    const proxied = { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' }
    H.getProxyEnv.mockReturnValueOnce(proxied)
    await invoke('terminal:create', { id: 't-acc2', shellType: 'powershell', cwd: '/repo', claudeHeadroom: true })
    expect(H.accountSettingsEnv).toHaveBeenLastCalledWith(H.agentPaths, undefined)
    expect(mockSpawnTerminal.mock.calls[1][5]).toBe(proxied)
    // Not a Claude launch: no profile is read for it.
    H.accountSettingsEnv.mockClear()
    await invoke('terminal:create', { id: 't-plain', shellType: 'powershell', cwd: '/repo' })
    expect(H.accountSettingsEnv).not.toHaveBeenCalled()
    await invoke('terminal:kill', { id: 't-acc' })
    expect(H.forgetTerminalAccount).toHaveBeenCalledWith('t-acc')
  })

  // §9: a worker's agent, restarted on another account at its usage limit, starts again with the
  // command run_command typed, as main typed it; a phone's terminal is the user's own, no worker.
  it('notes a swarm worker and the command run_command typed into it, sanitized, before it is typed; and forgets it once closed', async () => {
    mockDetectAvailableShells.mockResolvedValue([{ type: 'powershell', executable: 'powershell.exe' }])
    const worker = await H.mcpHandlers!.createTerminal('Claude (Build UI)', 'powershell', '/repo')
    expect(H.noteSwarmWorker).toHaveBeenCalledWith(worker)
    H.noteSwarmWorker.mockClear()
    await H.mcpHandlers!.createTerminal('Phone', 'powershell', '/repo', { device: 'phone-1', agentCommand: 'claude' })
    expect(H.noteSwarmWorker).not.toHaveBeenCalled()
    const order: string[] = []
    H.noteWorkerCommand.mockImplementationOnce(() => { order.push('note') })
    mockWriteToTerminal.mockImplementationOnce(() => { order.push('pty') })
    // The sanitizer is mocked here as it is everywhere in this file: what it returns is what is noted.
    vi.mocked(sanitizeAgentCommand).mockReturnValueOnce('claude --dangerously-skip-permissions')
    H.mcpHandlers!.runCommand(worker, 'claude -p "build it"')
    expect(sanitizeAgentCommand).toHaveBeenCalledWith('claude -p "build it"')
    expect(H.noteWorkerCommand).toHaveBeenCalledWith(worker, 'claude --dangerously-skip-permissions')
    expect(order).toEqual(['note', 'pty'])
    H.mcpHandlers!.closeTerminal(worker)
    expect(H.forgetTerminalAccount).toHaveBeenCalledWith(worker)
  })

  // R4 for workers: a prompt the conductor sends a worker is the worker's turn. Watched after the
  // PTY has it, and a watch that throws never stops a write.
  it('hands what an MCP client writes into a terminal to the worker-input watch, after the PTY has it', async () => {
    const order: string[] = []
    mockWriteToTerminal.mockImplementationOnce(() => { order.push('pty') })
    H.noteWorkerInput.mockImplementationOnce(() => { order.push('watch') })
    H.mcpHandlers!.writeToTerminal('w-typed', 'Continue your task.')
    expect(order).toEqual(['pty', 'watch'])
    expect(H.noteWorkerInput).toHaveBeenCalledWith('w-typed', 'Continue your task.')
    H.noteWorkerInput.mockImplementationOnce(() => { throw new Error('boom') })
    expect(() => H.mcpHandlers!.writeToTerminal('w-typed', '\r')).not.toThrow()
    expect(mockWriteToTerminal).toHaveBeenLastCalledWith('w-typed', '\r')
  })
})

// ===========================================================================
// `Termpolis.exe --disconnect-agents` -- the Windows uninstaller's cleanup (build/installer.nsh).
// LAST on purpose: each test re-imports index.ts, which re-registers every handler above.
// ===========================================================================
describe('--disconnect-agents', () => {
  /** A FRESH index.ts with the flag on argv, the way the uninstaller launches it. The flag comes off
   *  again whatever happens, so nothing imported later can see it. */
  async function launchWithDisconnectFlag(): Promise<void> {
    process.argv.push('--disconnect-agents')
    try {
      vi.resetModules()
      await import('../../src/main/index')
    } finally {
      const at = process.argv.lastIndexOf('--disconnect-agents')
      if (at !== -1) process.argv.splice(at, 1)
    }
    // app.exit is a spy, so the rest of the file -- and its whenReady boot -- still runs here. Let
    // that boot finish inside this test so it cannot bleed into the next one.
    await vi.waitFor(() => expect(H.bootAgentIntegration).toHaveBeenCalled(), { timeout: 15_000, interval: 20 })
  }

  it('disconnects for freshly resolved paths, prints one row per change, then exits 0 -- all before Sentry starts', async () => {
    // The block is the launch's FIRST path lookup, so this once-value is its own -- the boot's
    // later lookups get the default -- and must reach the disconnect untouched.
    const freshPaths = { ...H.agentPaths, sentinel: 'resolved-for-disconnect' }
    H.resolveAgentIntegrationPaths.mockReturnValueOnce(freshPaths)
    H.disconnectAgentIntegration.mockReturnValueOnce([
      { agent: 'claude', file: '/scratch/home/.claude.json', action: 'remove', what: 'MCP server `termpolis`' },
      { agent: 'gemini', file: '/scratch/home/.gemini/settings.json', action: 'skipped', what: 'MCP server `termpolis`', error: 'EBUSY: resource busy or locked' },
    ])
    await launchWithDisconnectFlag()
    // The mocked sentry module this fresh index.ts bound to (same registry, no reset since).
    const sentry = await import('../../src/main/sentry')
    expect(process.argv).not.toContain('--disconnect-agents')

    expect(H.resolveAgentIntegrationPaths.mock.calls[0]).toEqual([homedir(), H.userData, process.env])
    expect(H.disconnectAgentIntegration).toHaveBeenCalledTimes(1)
    expect(H.disconnectAgentIntegration).toHaveBeenCalledWith(freshPaths)
    expect(H.resolveAgentIntegrationPaths.mock.invocationCallOrder[0])
      .toBeLessThan(H.disconnectAgentIntegration.mock.invocationCallOrder[0])
    expect(H.appExit).toHaveBeenCalledTimes(1)
    expect(H.appExit).toHaveBeenCalledWith(0)
    expect(errorSpy).not.toHaveBeenCalledWith('Could not disconnect agents:', expect.anything())

    // A plain hyphen before the error here, unlike the boot's em dash: this is the uninstaller's console.
    const claudeRow = 'claude: remove MCP server `termpolis` (/scratch/home/.claude.json)'
    const geminiRow = 'gemini: skipped MCP server `termpolis` (/scratch/home/.gemini/settings.json) - EBUSY: resource busy or locked'
    const exitAt = H.appExit.mock.invocationCallOrder[0]
    expect(orderOf(logSpy, claudeRow)).toBeGreaterThan(H.disconnectAgentIntegration.mock.invocationCallOrder[0])
    expect(orderOf(logSpy, geminiRow)).toBeGreaterThan(orderOf(logSpy, claudeRow))
    expect(orderOf(logSpy, geminiRow)).toBeLessThan(exitAt)
    // It sits above Sentry, so an uninstall reports nothing.
    expect(vi.mocked(sentry.initMainSentry).mock.invocationCallOrder[0]).toBeGreaterThan(exitAt)
  })

  it('still exits 0 when the disconnect throws, after saying why', async () => {
    H.disconnectAgentIntegration.mockImplementationOnce(() => { throw new Error('~/.claude.json is locked by another process') })
    await launchWithDisconnectFlag()
    expect(errorSpy).toHaveBeenCalledWith('Could not disconnect agents:', '~/.claude.json is locked by another process')
    expect(H.appExit).toHaveBeenCalledTimes(1)
    expect(H.appExit).toHaveBeenCalledWith(0)
    expect(orderOf(errorSpy, 'Could not disconnect agents:')).toBeLessThan(H.appExit.mock.invocationCallOrder[0])
  })

  it('logs a non-Error throw as-is -- here the paths themselves could not be resolved', async () => {
    H.resolveAgentIntegrationPaths.mockImplementationOnce(() => { throw 'HOME is not set' })
    await launchWithDisconnectFlag()
    expect(H.disconnectAgentIntegration).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith('Could not disconnect agents:', 'HOME is not set')
    expect(H.appExit).toHaveBeenCalledTimes(1)
    expect(H.appExit).toHaveBeenCalledWith(0)
  })
})
