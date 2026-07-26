// Branch backfill for the BACK HALF of src/main/index.ts (line ~1400 and below) — the defensive
// arms nothing else exercises: the "already registered / registration failed" logs, the packaged
// vs. dev adapter paths, the Claude-plugin marketplace bookkeeping, and the OS-owns-that-hotkey
// fallback.
//
// Harness note — this file deliberately does NOT mock `fs`, unlike the other main-process suites.
// Almost every branch down here is a *decision about what is already on disk* ("is plugin.json
// there?", "does .mcp.json already say the right thing?", "did the marketplace manifest already
// list us?"), and a boolean-returning existsSync stub cannot tell those apart. Instead `os.homedir`
// and `app.getPath` are pointed at a throwaway temp tree, so the real code does real reads and
// writes and the assertions are about REAL FILES. That also means every write index.ts performs at
// boot is contained: nothing here can touch the developer's own ~/.claude.
//
// Each test re-imports index.ts with a fresh module registry, because everything in
// `app.whenReady()` runs exactly once per module instance. `boot()` seeds the temp home first, so
// the same code path can be observed on a pristine machine and on a machine that already has
// Termpolis registered.

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, statSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createZip } from '../../src/main/zipArchive'

// Prose only: no `process.env`, no `~/`, no exec/eval/fetch tokens — scans GREEN, so the size-cap
// assertion below is about the cap and nothing else.
const GREEN_BODY = 'Tidy a markdown table so the pipes line up. Ask for the table, then print it back.\n'
const SKILL_MD = `---\nname: tidy-tables\ndescription: Formats markdown tables\n---\n\n${GREEN_BODY}`

// ---------------------------------------------------------------------------
// Hoisted spies — referenced from inside vi.mock factories
// ---------------------------------------------------------------------------
const M = vi.hoisted(() => ({
  // redirected roots (set by boot(), read lazily by the electron/os mocks)
  home: '',
  userData: '',
  // when set, the secureFile passthrough reports the ACL as refused with this reason
  aclError: '',
  // child_process
  execSync: vi.fn(),
  execFileSync: vi.fn(),
  spawn: vi.fn(),
  // electron
  showOpenDialog: vi.fn(),
  showSaveDialog: vi.fn(),
  registerHotkey: vi.fn<(accel: string, cb: () => void) => boolean>(() => true),
  isPackaged: false,
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
  // MCP client registries (index.ts only reacts to their VERDICT, so it is the verdict we drive)
  registerInClaudeSettings: vi.fn<(...a: unknown[]) => { changed: boolean; skipped?: string; error?: string }>(
    () => ({ changed: true }),
  ),
  registerInGlobalMcp: vi.fn<(...a: unknown[]) => { changed: boolean; skipped?: string; error?: string }>(
    () => ({ changed: true }),
  ),
  registerInCodex: vi.fn<(...a: unknown[]) => { changed: boolean; skipped?: string; error?: string }>(
    () => ({ changed: true }),
  ),
  registerInGemini: vi.fn<(...a: unknown[]) => { changed: boolean; skipped?: string; error?: string }>(
    () => ({ changed: true }),
  ),
  // sensitive-read watcher: index.ts hands it a callback we can only reach through the mock
  sensitiveReadCb: null as ((ev: unknown) => void) | null,
  // second opinion
  runSecondOpinion: vi.fn<(...a: unknown[]) => Promise<Record<string, unknown>>>(
    async () => ({ ok: true, feedback: 'looks fine' }),
  ),
  // mneme reflection seams (only used by the distiller-gate test)
  reflectSoloSession: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ fired: false, lessons: 0 })),
  onSessionEpisode: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({ fired: false, lessons: 0 })),
  distillEpisode: vi.fn<(ep: unknown, opts: Record<string, unknown>) => unknown>(() => ({ lessons: [] })),
  isHighValueEpisode: vi.fn(() => false),
  // workflow adapter seam (only used by the default-shell fallback test)
  terminalRunnerDeps: null as Record<string, unknown> | null,
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
    getPath: vi.fn(() => M.userData),
    getVersion: vi.fn(() => '1.32.2'),
    whenReady: () => Promise.resolve(),
    requestSingleInstanceLock: () => true,
    setName: vi.fn(),
    setAppUserModelId: vi.fn(),
    on: vi.fn(),
    commandLine: { appendSwitch: vi.fn() },
    disableHardwareAcceleration: vi.fn(),
    get isPackaged() { return M.isPackaged },
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
  globalShortcut: { register: M.registerHotkey, unregisterAll: vi.fn() },
  shell: { openExternal: vi.fn(async () => undefined), openPath: vi.fn(async () => '') },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8'),
  },
}))

// The ONE reason this suite can run against real fs: every `~/...` path index.ts builds goes
// through homedir(), so redirecting it sandboxes the whole registration block.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  const patched = { ...actual, homedir: () => M.home }
  return { ...patched, default: patched }
})

// ---------------------------------------------------------------------------
// Service modules (same set the other main-process suites stub out)
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
vi.mock('../../src/main/shellDetector', () => ({
  detectAvailableShells: vi.fn(async () => [{ type: 'powershell', name: 'PowerShell', executable: 'pwsh.exe' }]),
  resolveShellExecutable: vi.fn((exe: string) => exe),
}))
vi.mock('../../src/main/sessionStore', () => ({
  loadSession: vi.fn(() => ({ terminals: [] })), saveSession: vi.fn(),
}))
vi.mock('../../src/main/historyStore', () => ({ appendCommand: vi.fn(), searchHistory: vi.fn(() => []) }))
vi.mock('../../src/main/configFileManager', () => ({ readConfigFile: vi.fn(), writeConfigFile: vi.fn() }))
vi.mock('../../src/main/completionService', () => ({
  listPathEntries: vi.fn(() => []), listPathCommands: vi.fn(() => []), listEnvVars: vi.fn(() => []),
}))

// Real rules, real scanner — only the audit SINK is a spy, because "what did the audit entry say"
// is exactly what the sensitive-read test asserts.
vi.mock('../../src/main/aiSecurity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/aiSecurity')>()
  return { ...actual, appendAudit: M.appendAudit }
})

// The ACL is a WINDOWS-only concern: writeSecureFile returns `aclApplied: true` unconditionally on
// every other platform (secureFile.ts:51), so TERMPOLIS_SKIP_ACL — or any other way of making the
// real code refuse the ACL — is unreachable on the Linux and macOS runners. index.ts's reaction to
// that verdict is NOT platform-specific though, so the verdict is what we drive: a passthrough that
// still writes the real file (the sibling test reads the token back off disk) and only rewrites the
// aclApplied/aclError fields when a test asks for it.
vi.mock('../../src/main/secureFile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/secureFile')>()
  return {
    ...actual,
    writeSecureFile: (...args: Parameters<typeof actual.writeSecureFile>) => {
      const result = actual.writeSecureFile(...args)
      return M.aclError ? { ...result, aclApplied: false, aclError: M.aclError } : result
    },
  }
})

// The watcher itself is covered elsewhere; here we only need the callback index.ts registers.
vi.mock('../../src/main/sensitiveFileWatcher', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/sensitiveFileWatcher')>()
  return {
    ...actual,
    subscribeSensitiveReads: vi.fn((cb: (ev: unknown) => void) => { M.sensitiveReadCb = cb }),
  }
})

vi.mock('../../src/main/secondOpinion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/secondOpinion')>()
  return { ...actual, runSecondOpinion: M.runSecondOpinion }
})

vi.mock('../../src/main/agentMcpRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/agentMcpRegistry')>()
  return {
    ...actual,
    registerInClaudeSettings: M.registerInClaudeSettings,
    registerInGlobalMcp: M.registerInGlobalMcp,
    registerInCodex: M.registerInCodex,
    registerInGemini: M.registerInGemini,
  }
})

// mneme: the distiller gate is a pure wiring decision inside a callback three deps deep, so the
// three collaborators that pass it along are stubbed to call straight through.
vi.mock('../../src/main/mnemeSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/mnemeSession')>()
  return { ...actual, reflectSoloSession: M.reflectSoloSession }
})
vi.mock('../../src/main/mnemeReflex', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/mnemeReflex')>()
  return { ...actual, onSessionEpisode: M.onSessionEpisode }
})
vi.mock('../../src/main/mnemeReflect', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/mnemeReflect')>()
  return { ...actual, distillEpisode: M.distillEpisode, isHighValueEpisode: M.isHighValueEpisode }
})

vi.mock('../../src/main/workflow/adapters', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/workflow/adapters')>()
  return {
    ...actual,
    makeTerminalRunner: vi.fn((deps: Record<string, unknown>) => {
      M.terminalRunnerDeps = deps
      return actual.makeTerminalRunner(deps as never)
    }),
  }
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
  createTask: vi.fn(), listTasks: vi.fn(() => []), updateTask: vi.fn(), clearSwarm: vi.fn(),
}))
vi.mock('../../src/main/agentEventBus', () => ({
  initEventBus: vi.fn(),
  query: vi.fn(() => [] as unknown[]),
  subscribe: vi.fn(),
  publish: vi.fn(),
  getRingSize: vi.fn(() => 0),
  getDroppedCount: vi.fn(() => 0),
  shutdownEventBus: vi.fn(),
}))
vi.mock('../../src/main/transcriptWatchers', () => ({
  attachWatcher: vi.fn(() => null), detachWatchers: vi.fn(), detachAll: vi.fn(),
}))
vi.mock('../../src/main/contextPinStore', () => ({
  initContextPinStore: vi.fn(),
  listPins: vi.fn(() => []), addPin: vi.fn(), removePin: vi.fn(() => false),
  updatePin: vi.fn(() => null), clearPins: vi.fn(),
}))
vi.mock('../../src/main/autoUpdater', () => ({ initAutoUpdater: M.initAutoUpdater }))
vi.mock('../../src/main/agentCommandSanitizer', () => ({
  sanitizeAgentCommand: vi.fn((c: string) => c),
  isClaudeAgentName: (name: string) => /(^|[^a-z])claude/i.test(name || ''),
}))
vi.mock('../../src/main/agentPaths', () => ({
  getAgentExtraPaths: vi.fn(() => ['/opt/agent-bin']),
  getExtendedPath: vi.fn(() => '/usr/bin:/opt/agent-bin'),
  getInteractiveShellPath: vi.fn(() => ''),
  __resetShellPathCacheForTests: vi.fn(),
}))
vi.mock('../../src/main/groqKeyStore', () => ({
  getGroqKey: vi.fn(() => null), setGroqKey: vi.fn(),
  getGroqKeyStatus: vi.fn(() => ({ connected: false, hint: '' })), clearGroqKey: vi.fn(),
  groqKeyPath: vi.fn(() => '/tmp/groq'), maskKey: vi.fn(() => '••••'),
}))
vi.mock('../../src/main/groqTranscription', () => ({
  transcribeWithGroq: vi.fn(async () => ({ text: 'hello world' })),
  validateGroqKey: vi.fn(async () => ({ valid: true, models: 1 })),
}))
vi.mock('../../src/main/aiSessions', () => ({
  listAISessions: vi.fn(async () => []),
  digestAISession: vi.fn(async () => null),
  renderDigestAsPrompt: vi.fn(() => 'RENDERED PROMPT'),
}))
vi.mock('../../src/main/liveTranscript', () => ({
  readActiveTranscript: vi.fn(async () => []),
  readSessionTranscript: vi.fn(async () => ({ turns: [] })),
}))
vi.mock('../../src/main/memoryIndexer', () => ({ startIndexer: vi.fn(), stopIndexer: vi.fn() }))

const MEMC = vi.hoisted(() => ({
  initSwarmMemory: vi.fn(),
  memoryWrite: vi.fn(async () => ({ id: 'mem-1' })),
  memorySearch: vi.fn(() => []),
  memoryRelated: vi.fn(() => []),
  memoryLink: vi.fn(async () => ({ ok: true })),
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
  warmProbeEmbeddings: vi.fn(async () => true),
  compactSelfShard: vi.fn(async () => ({ compacted: false, before: 0, after: 0 })),
  setMemoryScrubber: vi.fn(),
  weaveCandidates: vi.fn(() => []),
  weaveNeighbours: vi.fn(() => []),
  backfillCodeRefs: vi.fn(),
  symbolHistory: vi.fn(() => []),
  memoryArchive: vi.fn(),
  searchArchive: vi.fn(() => []),
  getSyncStatus: vi.fn(() => ({ enabled: false, dir: null })),
  setSyncDir: vi.fn((d: string | null) => ({ enabled: !!d, dir: d })),
  reloadMemoryFromSync: vi.fn(),
  setSyncPassphrase: vi.fn(() => ({ encrypted: true })),
  disableSyncEncryption: vi.fn(() => ({ encrypted: false })),
  enableLocalEncryption: vi.fn(() => ({ encrypted: true, local: true })),
  disableEncryption: vi.fn(() => ({ encrypted: false })),
  persistMemoryIndex: vi.fn(),
  entityDedupHash: vi.fn(() => 'entity-hash'),
  projectKeyOf: vi.fn((p: string) => p),
  contentHash: vi.fn((c: string) => `h:${c}`),
  canonicalEntityName: vi.fn((n: string) => n.trim()),
  vectorRamStats: vi.fn(async () => ({ bytes: 0 })),
  setVectorQuantization: vi.fn(async () => ({ bytes: 0 })),
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
vi.mock('../../src/main/memoryClient', () => MEMC)
vi.mock('../../src/main/swarmMemory', () => MEMC)

vi.mock('child_process', () => ({
  default: { execSync: M.execSync, execFileSync: M.execFileSync, spawn: M.spawn },
  execSync: M.execSync,
  execFileSync: M.execFileSync,
  spawn: M.spawn,
}))

vi.mock('uuid', () => ({ v4: vi.fn(() => 'mock-uuid') }))

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
const SANDBOX = mkdtempSync(join(tmpdir(), 'tp-main-branches-b-'))
let bootSeq = 0
/** mtime of every file seeded for the current boot, captured BEFORE index.ts ran. */
let seededMtimes: Record<string, number> = {}

interface BootOptions {
  /** Files to lay down under the fake home BEFORE index.ts boots, relative to it. */
  seed?: Record<string, string>
  packaged?: boolean
  /** Value globalShortcut.register reports; `false` = the OS already owns the combo. */
  hotkeysAvailable?: boolean
  /** Extra files under app.getPath('userData'). */
  seedUserData?: Record<string, string>
}

/**
 * Fresh temp home + userData, seeded, then a fresh import of index.ts. Everything in
 * `app.whenReady()` runs once per module instance, so each observation needs its own boot.
 */
async function boot(opts: BootOptions = {}): Promise<void> {
  const root = join(SANDBOX, `boot-${++bootSeq}`)
  M.home = join(root, 'home')
  M.userData = join(root, 'userData')
  mkdirSync(M.home, { recursive: true })
  mkdirSync(M.userData, { recursive: true })
  seededMtimes = {}
  for (const [rel, content] of Object.entries(opts.seed ?? {})) {
    const abs = join(M.home, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content, 'utf8')
    // Backdate before the boot so "did index.ts rewrite this?" is a deterministic mtime
    // comparison instead of a same-millisecond coin flip.
    seededMtimes[rel] = backdate(abs)
  }
  for (const [rel, content] of Object.entries(opts.seedUserData ?? {})) {
    const abs = join(M.userData, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content, 'utf8')
  }
  M.isPackaged = opts.packaged ?? false
  M.registerHotkey.mockReturnValue(opts.hotkeysAvailable ?? true)

  vi.resetModules()
  await import('../../src/main/index')
  await new Promise((r) => setTimeout(r, 60))
}

function invoke(channel: string, args: unknown = {}): any {
  const handler = ipcHandlers.get(channel)
  if (!handler) throw new Error(`No handler for ${channel}`)
  return handler({}, args)
}

/** Backdate a file so "was it rewritten during boot?" is a deterministic mtime comparison. */
function backdate(abs: string): number {
  const past = new Date(Date.now() - 60_000)
  utimesSync(abs, past, past)
  return statSync(abs).mtimeMs
}

const PLUGIN_DIR = join('.claude', 'local-marketplace', 'plugins', 'termpolis')
const PLUGIN_MANIFEST = join(PLUGIN_DIR, '.claude-plugin', 'plugin.json')
const PLUGIN_MCP = join(PLUGIN_DIR, '.mcp.json')
const MARKETPLACE_JSON = join('.claude', 'local-marketplace', '.claude-plugin', 'marketplace.json')

/** The exact bytes index.ts writes into the plugin's .mcp.json for a given adapter path. */
function expectedPluginMcp(adapterPath: string): string {
  return JSON.stringify({ mcpServers: { termpolis: { command: 'node', args: [adapterPath] } } }, null, 2)
}

/** Dev-mode adapter path — the same join index.ts performs from src/main. */
const DEV_ADAPTER = join(__dirname, '..', '..', 'src', 'mcp-adapter', 'stdio-adapter.cjs')

let logs: string[] = []
let warns: string[] = []
let errors: string[] = []
let logSpy: ReturnType<typeof vi.spyOn>
let warnSpy: ReturnType<typeof vi.spyOn>
let errorSpy: ReturnType<typeof vi.spyOn>
let exitSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  logs = []; warns = []; errors = []
  logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')) })
  warnSpy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(a.map(String).join(' ')) })
  errorSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(' ')) })
  // index.ts force-exits 500ms after the last window closes; a real exit takes the worker with it.
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
  M.sensitiveReadCb = null
  M.terminalRunnerDeps = null
  // Every boot re-runs the whole registration block, so the call log has to start empty or an
  // assertion about "the FIRST call" would read the previous test's boot.
  M.registerInClaudeSettings.mockClear().mockReturnValue({ changed: true })
  M.registerInGlobalMcp.mockClear().mockReturnValue({ changed: true })
  M.registerInCodex.mockClear().mockReturnValue({ changed: true })
  M.registerInGemini.mockClear().mockReturnValue({ changed: true })
  M.registerHotkey.mockClear()
  M.startMcpServer.mockClear()
  M.appendAudit.mockClear()
  mockWebContents.send.mockClear()
  M.execFileSync.mockReset()
  M.aclError = ''
  delete process.env.TERMPOLIS_SKIP_ACL
})

afterEach(() => {
  logSpy.mockRestore(); warnSpy.mockRestore(); errorSpy.mockRestore(); exitSpy.mockRestore()
  delete process.env.TERMPOLIS_SKIP_ACL
  delete process.env.TERMPOLIS_MNEME_DISTILLER
})

afterAll(() => {
  try { rmSync(SANDBOX, { recursive: true, force: true }) } catch { /* best effort */ }
})

// ===========================================================================
// Packaged vs. dev: where the MCP adapter and the memory hook are looked for.
// ===========================================================================
describe('MCP adapter + memory-primer hook preflight', () => {
  it('resolves both files under resourcesPath when packaged, and screams when they are missing', async () => {
    // A packaging bug here is silent in production: every Claude session would register an MCP
    // server whose entry point does not exist, so the conductor comes up with zero tools. The
    // preflight exists to turn that into a visible, Sentry-reported boot error.
    const fakeResources = join(SANDBOX, 'resources-empty')
    mkdirSync(fakeResources, { recursive: true })
    const original = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
    Object.defineProperty(process, 'resourcesPath', { value: fakeResources, configurable: true })
    try {
      await boot({ packaged: true })

      const fatal = errors.find((e) => e.includes('[FATAL] MCP stdio adapter not found'))
      expect(fatal).toBeDefined()
      expect(fatal).toContain(join(fakeResources, 'mcp-adapter', 'stdio-adapter.cjs'))
      expect(warns.some((w) => w.includes('[memory-primer] SessionStart hook not found')
        && w.includes(join(fakeResources, 'mcp-adapter', 'memory-primer-hook.cjs')))).toBe(true)
    } finally {
      if (original) Object.defineProperty(process, 'resourcesPath', original)
      else delete (process as unknown as Record<string, unknown>).resourcesPath
    }
  })

  it('finds both files next to the sources in dev, so neither alarm fires', async () => {
    // The dev path is the one every contributor runs; if this ever regressed, every local session
    // would log a FATAL that means nothing.
    await boot()

    expect(errors.some((e) => e.includes('[FATAL] MCP stdio adapter not found'))).toBe(false)
    expect(warns.some((w) => w.includes('[memory-primer] SessionStart hook not found'))).toBe(false)
    // …and the path it decided on is the one it hands to the client registries.
    expect(M.registerInClaudeSettings).toHaveBeenCalledWith(
      join(M.home, '.claude', 'settings.json'),
      DEV_ADAPTER,
      expect.any(String),
      expect.any(String),
    )
  })

  it('normalises the hook path to forward slashes before embedding it in a settings command', async () => {
    // The hook path is spliced into a shell command string inside Claude's settings.json. On
    // Windows a raw backslash path would be re-escaped by whatever reads it, so index.ts
    // normalises first — node accepts forward slashes on every OS.
    await boot()

    const hookArg = M.registerInClaudeSettings.mock.calls[0][2] as string
    expect(hookArg).not.toContain('\\')
    expect(hookArg.endsWith('/src/mcp-adapter/memory-primer-hook.cjs')).toBe(true)
  })
})

// ===========================================================================
// MCP token file: the ACL warning.
// ===========================================================================
describe('MCP token file', () => {
  it('warns with the underlying reason when the restrictive ACL could not be applied', async () => {
    // The token grants full MCP access. If the NTFS ACL does not stick, any other local user can
    // read it — that is a downgrade the user deserves to see in the log, with the reason attached.
    M.aclError = 'skipped (TERMPOLIS_SKIP_ACL)'
    await boot()

    const warn = warns.find((w) => w.includes('[mcp-token] ACL not applied'))
    expect(warn).toBeDefined()
    expect(warn).toContain(join(M.userData, 'mcp-token'))
    expect(warn).toContain('skipped (TERMPOLIS_SKIP_ACL)')
    // The reason is passed through verbatim, not summarised — a different refusal reads differently.
    expect(warns.some((w) => w.includes('[mcp-token] ACL not applied') && w.includes('No USERNAME env var'))).toBe(false)
  })

  it('stays quiet when the ACL was applied', async () => {
    await boot()

    expect(warns.some((w) => w.includes('[mcp-token] ACL not applied'))).toBe(false)
    expect(logs.some((l) => l.includes('MCP token written to'))).toBe(true)
    expect(readFileSync(join(M.userData, 'mcp-token'), 'utf8')).toBe('fake-token')
  })
})

// ===========================================================================
// The four client registries. index.ts owns none of the file formats — it only
// reports the verdict — so the three verdicts are what get pinned here.
// ===========================================================================
describe('agent client registration verdicts', () => {
  it('announces each client it actually changed', async () => {
    await boot()

    expect(logs).toContain('Auto-registered Termpolis MCP server, tool permissions, and memory hook in Claude Code settings')
    expect(logs).toContain('Auto-registered Termpolis in global ~/.mcp.json')
    expect(logs).toContain('Auto-registered Termpolis MCP server in Codex CLI config')
    expect(logs).toContain('Auto-registered Termpolis MCP server in Gemini CLI settings')
  })

  it('reports a registration failure as non-fatal, with the skip reason, and keeps booting', async () => {
    // Every one of these files belongs to another product. A malformed or read-only settings.json
    // must never stop Termpolis from starting — it degrades to "no auto-registration" plus a log.
    M.registerInClaudeSettings.mockReturnValue({ changed: false, skipped: 'claude', error: 'EACCES' })
    M.registerInGlobalMcp.mockReturnValue({ changed: false, skipped: 'mcp', error: 'EPERM' })
    M.registerInCodex.mockReturnValue({ changed: false, skipped: 'codex', error: 'ENOSPC' })
    M.registerInGemini.mockReturnValue({ changed: false, skipped: 'gemini', error: 'EROFS' })
    await boot()

    expect(logs.some((l) => l.startsWith('Could not auto-register in Claude Code settings (non-fatal): claude EACCES'))).toBe(true)
    expect(logs.some((l) => l.startsWith('Could not write ~/.mcp.json (non-fatal): mcp EPERM'))).toBe(true)
    expect(logs.some((l) => l.startsWith('Could not register in Codex config (non-fatal): codex ENOSPC'))).toBe(true)
    expect(logs.some((l) => l.startsWith('Could not register in Gemini settings (non-fatal): gemini EROFS'))).toBe(true)
    // Boot continued past all four.
    expect(M.startMcpServer).toHaveBeenCalled()
  })

  it('says nothing at all when a client was already registered correctly', async () => {
    // The common case: second launch onwards. Neither "registered" nor "could not register" is
    // true, so the log must stay silent rather than claim work it did not do.
    M.registerInClaudeSettings.mockReturnValue({ changed: false })
    M.registerInGlobalMcp.mockReturnValue({ changed: false })
    M.registerInCodex.mockReturnValue({ changed: false })
    M.registerInGemini.mockReturnValue({ changed: false })
    await boot()

    expect(logs.some((l) => l.includes('Auto-registered Termpolis'))).toBe(false)
    expect(logs.some((l) => l.includes('non-fatal'))).toBe(false)
    // All four were still consulted — the silence is a verdict, not a skipped block.
    for (const reg of [M.registerInClaudeSettings, M.registerInGlobalMcp, M.registerInCodex, M.registerInGemini]) {
      expect(reg).toHaveBeenCalledTimes(1)
    }
  })
})

// ===========================================================================
// Claude Code local-plugin registration — all of it is "what is already on disk".
// ===========================================================================
describe('Claude Code local plugin registration', () => {
  it('creates the manifest, the plugin .mcp.json and the cache on a machine that has none', async () => {
    await boot()

    const manifest = JSON.parse(readFileSync(join(M.home, PLUGIN_MANIFEST), 'utf8'))
    expect(manifest.name).toBe('termpolis')
    expect(JSON.parse(readFileSync(join(M.home, PLUGIN_MCP), 'utf8'))
      .mcpServers.termpolis.args).toEqual([DEV_ADAPTER])
    // With no settings.json to read a marketplace name out of, the cache lands under the default.
    expect(existsSync(join(M.home, '.claude', 'plugins', 'cache', 'local-plugins', 'termpolis', '1.0.0', '.mcp.json'))).toBe(true)
    expect(logs.some((l) => l.startsWith('Termpolis plugin cached at:'))).toBe(true)
    // Nothing else on disk to react to, so neither the settings nor the manifest branch ran.
    expect(existsSync(join(M.home, '.claude', 'settings.json'))).toBe(false)
    expect(existsSync(join(M.home, MARKETPLACE_JSON))).toBe(false)
  })

  it('leaves an existing manifest and an already-correct .mcp.json untouched', async () => {
    // Rewriting identical bytes every launch would churn the file's mtime, and Claude Code watches
    // this directory. "Already correct" must mean "no write".
    const customManifest = JSON.stringify({ name: 'termpolis', description: 'hand-edited' })
    await boot({ seed: {
      [PLUGIN_MANIFEST]: customManifest,
      [PLUGIN_MCP]: expectedPluginMcp(DEV_ADAPTER),
    } })

    expect(readFileSync(join(M.home, PLUGIN_MANIFEST), 'utf8')).toBe(customManifest)
    expect(statSync(join(M.home, PLUGIN_MCP)).mtimeMs).toBe(seededMtimes[PLUGIN_MCP])
    // …and it skipped those two writes by DECIDING to, not by falling into the outer catch: the
    // cache write that comes after them still happened.
    expect(logs.some((l) => l.startsWith('Termpolis plugin cached at:'))).toBe(true)
  })

  it('rewrites the plugin .mcp.json when it points at a stale adapter path', async () => {
    await boot({ seed: { [PLUGIN_MCP]: expectedPluginMcp('/old/install/stdio-adapter.cjs') } })

    expect(JSON.parse(readFileSync(join(M.home, PLUGIN_MCP), 'utf8'))
      .mcpServers.termpolis.args).toEqual([DEV_ADAPTER])
    expect(statSync(join(M.home, PLUGIN_MCP)).mtimeMs).toBeGreaterThan(seededMtimes[PLUGIN_MCP])
  })

  it('enables the plugin in an existing settings.json that has no enabledPlugins map yet', async () => {
    await boot({ seed: { [join('.claude', 'settings.json')]: JSON.stringify({ model: 'opus' }) } })

    const settings = JSON.parse(readFileSync(join(M.home, '.claude', 'settings.json'), 'utf8'))
    expect(settings.enabledPlugins).toEqual({ 'termpolis@local-plugins': true })
    expect(settings.model).toBe('opus')   // the rest of the user's settings survive
    expect(logs).toContain('Enabled Termpolis plugin as termpolis@local-plugins')
  })

  it('adopts the user\'s own local-marketplace name and skips the write when already enabled', async () => {
    // Claude Code lets the user name their local marketplace. The plugin key and the cache
    // directory must both follow that name, or Claude looks for the plugin under a name that
    // does not exist. The non-local marketplace listed first must be ignored.
    await boot({ seed: {
      [join('.claude', 'settings.json')]: JSON.stringify({
        extraKnownMarketplaces: {
          'community': { source: { path: '/somewhere/else/community' } },
          'my-local': { source: { path: '/home/dev/.claude/local-marketplace' } },
        },
        enabledPlugins: { 'termpolis@my-local': true },
      }),
    } })

    expect(statSync(join(M.home, '.claude', 'settings.json')).mtimeMs)
      .toBe(seededMtimes[join('.claude', 'settings.json')])
    expect(logs.some((l) => l.startsWith('Enabled Termpolis plugin as'))).toBe(false)
    expect(existsSync(join(M.home, '.claude', 'plugins', 'cache', 'my-local', 'termpolis', '1.0.0', '.mcp.json'))).toBe(true)
  })

  it('adds itself to an existing marketplace manifest exactly once', async () => {
    await boot({ seed: { [MARKETPLACE_JSON]: JSON.stringify({ name: 'local-plugins', plugins: [] }) } })

    const manifest = JSON.parse(readFileSync(join(M.home, MARKETPLACE_JSON), 'utf8'))
    expect(manifest.plugins.map((p: { name: string }) => p.name)).toEqual(['termpolis'])
    expect(manifest.plugins[0].source).toBe('./plugins/termpolis')
    expect(logs).toContain('Registered Termpolis in marketplace.json manifest')
  })

  it('does not touch a marketplace manifest that already lists it', async () => {
    await boot({ seed: {
      [MARKETPLACE_JSON]: JSON.stringify({ plugins: [{ name: 'termpolis', version: '0.9.0' }] }),
    } })

    // Still the ORIGINAL entry — a second push would have duplicated the plugin and bumped it.
    const manifest = JSON.parse(readFileSync(join(M.home, MARKETPLACE_JSON), 'utf8'))
    expect(manifest.plugins).toEqual([{ name: 'termpolis', version: '0.9.0' }])
    expect(statSync(join(M.home, MARKETPLACE_JSON)).mtimeMs).toBe(seededMtimes[MARKETPLACE_JSON])
    expect(logs.some((l) => l.includes('Registered Termpolis in marketplace.json'))).toBe(false)
  })

  it('survives a marketplace manifest with no plugins array', async () => {
    // Hand-edited or half-written manifests exist in the wild; index.ts must skip the push rather
    // than throw into the outer catch and abandon the rest of registration.
    await boot({ seed: { [MARKETPLACE_JSON]: JSON.stringify({ name: 'local-plugins' }) } })

    expect(JSON.parse(readFileSync(join(M.home, MARKETPLACE_JSON), 'utf8')).plugins).toBeUndefined()
    expect(logs.some((l) => l.includes('Could not register Claude Code plugin (non-fatal)'))).toBe(false)
    expect(existsSync(join(M.home, PLUGIN_MANIFEST))).toBe(true)   // the rest of the block still ran
  })

  it('logs a corrupt settings.json as non-fatal instead of failing the boot', async () => {
    await boot({ seed: { [join('.claude', 'settings.json')]: '{ this is not json' } })

    expect(logs.some((l) => l.startsWith('Could not register Claude Code plugin (non-fatal):'))).toBe(true)
    // Boot carried on to the hotkeys, which are registered after this block.
    expect(M.registerHotkey).toHaveBeenCalled()
  })
})

// ===========================================================================
// Safe Import: the per-file size cap on the quarantine copy.
// ===========================================================================
describe('safeImport:scan file size cap', () => {
  it('drops a zip entry over the 2 MiB cap and scans the rest', async () => {
    // The quarantine copy is held in memory and scanned byte-by-byte, so one enormous entry
    // (a bundled model, a vendored binary — or a deliberate memory bomb) would stall the scan for
    // a file nobody can meaningfully review anyway. Over the cap the entry is dropped, and the
    // artifact is still classified and scanned from what remains.
    await boot()
    const zipPath = join(SANDBOX, 'oversized.zip')
    writeFileSync(zipPath, createZip([
      { name: 'SKILL.md', data: Buffer.from(SKILL_MD, 'utf8') },
      { name: 'README.md', data: Buffer.from(GREEN_BODY, 'utf8') },
      { name: 'vendor/model.bin', data: Buffer.alloc(2 * 1024 * 1024 + 1, 0x61) },
    ]))
    M.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [zipPath] })

    const r = await invoke('safeImport:scan')

    expect(r.success).toBe(true)
    expect(r.data.name).toBe('tidy-tables')      // still classified from the files that fit
    expect(r.data.filesScanned).toBe(2)          // SKILL.md + README.md; the 2 MiB entry is gone
    const stages = mockWebContents.send.mock.calls
      .filter((c) => c[0] === 'safeImport:progress')
      .map((c) => (c[1] as { stage: string }).stage)
    expect(stages.some((s) => s.includes('vendor/model.bin'))).toBe(false)
  })
})

// ===========================================================================
// Global hotkeys.
// ===========================================================================
describe('global hotkeys', () => {
  it('logs each combo the OS refuses to hand over', async () => {
    // Super+Shift is commonly owned by GNOME/KDE. Electron returns false rather than throwing, so
    // without this log the hotkeys would just silently not work.
    await boot({ hotkeysAvailable: false })

    const unavailable = logs.filter((l) => l.includes('unavailable (already registered by the OS)'))
    expect(unavailable).toHaveLength(2)
    const accels = M.registerHotkey.mock.calls.map((c) => c[0])
    expect(unavailable.some((l) => l.includes(accels[0]))).toBe(true)
    expect(unavailable.some((l) => l.includes(accels[1]))).toBe(true)
  })

  it('says nothing when both combos were granted', async () => {
    await boot({ hotkeysAvailable: true })

    expect(logs.some((l) => l.includes('unavailable (already registered by the OS)'))).toBe(false)
    expect(M.registerHotkey).toHaveBeenCalledTimes(2)
  })
})

// ===========================================================================
// Headroom proxy lifetime meter.
// ===========================================================================
describe('proxy lifetime meter reset sentinel', () => {
  it('consumes a .reset-proxy-totals sentinel exactly once', async () => {
    // The sentinel exists so a compression-methodology change can zero the blended lifetime
    // average. It must be deleted on the launch that honours it, or every subsequent launch would
    // wipe the meter again.
    await boot({ seedUserData: {
      [join('headroom', '.reset-proxy-totals')]: '',
      // Decoy: proves the sentinel's disappearance is a targeted unlink, not the headroom dir
      // being recreated from scratch.
      [join('headroom', 'settings.json')]: '{"mode":"aggressive"}',
    } })

    expect(existsSync(join(M.userData, 'headroom', '.reset-proxy-totals'))).toBe(false)
    expect(existsSync(join(M.userData, 'headroom', 'settings.json'))).toBe(true)
  })
})

// ===========================================================================
// Sensitive-file-read alert.
// ===========================================================================
describe('sensitive file read alert', () => {
  it('attributes a read with no agent name to "unknown" rather than dropping it', async () => {
    // The event comes off a transcript watcher; a transcript that never named its agent still
    // describes a real read of a real secret, so the audit entry must exist and be attributable.
    await boot()
    expect(M.sensitiveReadCb).toBeTypeOf('function')
    M.appendAudit.mockClear()

    M.sensitiveReadCb!({
      agent: '', terminalId: 't1', rule: 'dotenv', tool: 'Read',
      source: 'transcript', filePath: '/repo/.env', ts: 1,
    })

    expect(M.appendAudit).toHaveBeenCalledWith(expect.objectContaining({
      agent: 'unknown',
      event: 'sensitive_file_read',
      terminalId: 't1',
      notes: 'dotenv:Read:transcript:/repo/.env',
    }))
    expect(mockWebContents.send).toHaveBeenCalledWith(
      'terminal:sensitive-file-read',
      expect.objectContaining({ id: 't1', filePath: '/repo/.env' }),
    )
  })

  it('keeps the real agent name when the event carries one', async () => {
    await boot()
    M.appendAudit.mockClear()

    M.sensitiveReadCb!({
      agent: 'claude', terminalId: 't2', rule: 'aws', tool: 'Bash',
      source: 'command', filePath: '/home/dev/.aws/credentials', ts: 2,
    })

    expect(M.appendAudit).toHaveBeenCalledWith(expect.objectContaining({ agent: 'claude' }))
  })
})

// ===========================================================================
// Second opinion.
// ===========================================================================
describe('agent:second-opinion', () => {
  it('surfaces the reason the other model failed', async () => {
    await boot()
    M.runSecondOpinion.mockResolvedValueOnce({ ok: false, error: 'codex exited 127' })

    expect(await invoke('agent:second-opinion', { agent: 'codex', content: 'review this' }))
      .toEqual({ success: false, error: 'codex exited 127' })
  })

  it('falls back to a generic message when the failure carries no reason', async () => {
    // A rejected run with an empty error would otherwise surface as `undefined` in the UI.
    await boot()
    M.runSecondOpinion.mockResolvedValueOnce({ ok: false })

    expect(await invoke('agent:second-opinion', { agent: 'gemini', content: 'review this' }))
      .toEqual({ success: false, error: 'second opinion failed' })
  })

  it('returns the feedback on success', async () => {
    await boot()
    M.runSecondOpinion.mockResolvedValueOnce({ ok: true, feedback: 'ship it' })

    expect(await invoke('agent:second-opinion', { agent: 'claude', content: 'review this' }))
      .toEqual({ success: true, data: { feedback: 'ship it' } })
  })
})

// ===========================================================================
// Test-only event-injection seam.
// ===========================================================================
describe('agentActivity:__test_publish', () => {
  it('is registered under NODE_ENV=test', async () => {
    await boot()
    expect(ipcHandlers.has('agentActivity:__test_publish')).toBe(true)
  })

  it('is NOT registered outside the test environment', async () => {
    // This channel injects synthetic agent events straight onto the real bus. In a shipped build
    // it would be a way for anything with IPC access to forge activity, so the registration itself
    // is gated, not just its behaviour.
    ipcHandlers.delete('agentActivity:__test_publish')
    const original = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      await boot()
      expect(ipcHandlers.has('agentActivity:__test_publish')).toBe(false)
      expect(ipcHandlers.has('agentActivity:query')).toBe(true)   // …the real channels still are
    } finally {
      process.env.NODE_ENV = original
    }
  })
})

// ===========================================================================
// Workflow command steps: resolving a logical shell TYPE for this OS.
// ===========================================================================
describe('workflow default shell type', () => {
  it('falls back to bash on an OS the table does not know', async () => {
    // The table only names the three platforms Termpolis ships for. A Command step on anything
    // else still has to spawn SOMETHING, and bash is the safest guess — an undefined default
    // would reach node-pty as "File not found".
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'freebsd', configurable: true })
    try {
      await boot()
      expect(M.terminalRunnerDeps?.defaultShell).toBe('bash')
    } finally {
      Object.defineProperty(process, 'platform', original)
    }
  })

  it('uses the platform\'s own shell type when the table knows it', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    try {
      await boot()
      expect(M.terminalRunnerDeps?.defaultShell).toBe('zsh')
    } finally {
      Object.defineProperty(process, 'platform', original)
    }
  })
})

// ===========================================================================
// Session reflection: the LLM distiller gate.
// ===========================================================================
describe('memory:reflect-session distiller gate', () => {
  /** Wire reflectSoloSession/onSessionEpisode to call straight through to `distill`. */
  function passThrough(episode: unknown): void {
    M.reflectSoloSession.mockImplementation(async (_ctx: unknown, deps: unknown) =>
      (deps as { reflect: (e: unknown) => Promise<unknown> }).reflect(episode))
    M.onSessionEpisode.mockImplementation(async (ep: unknown, deps: unknown) => {
      ;(deps as { distill: (e: unknown) => unknown }).distill(ep)
      return { fired: true, lessons: 1 }
    })
  }

  it('hands the headless LLM distiller only to a high-value episode', async () => {
    // Distilling with an LLM costs a real model call. The gate is two-part: the feature flag AND
    // the episode being worth it — so a low-value episode must fall back to the deterministic
    // distiller even with the flag on.
    process.env.TERMPOLIS_MNEME_DISTILLER = '1'
    await boot()

    passThrough({ id: 'ep-high' })
    M.isHighValueEpisode.mockReturnValue(true)
    M.distillEpisode.mockClear()
    await invoke('memory:reflect-session', { terminalId: 't1', cwd: '/repo', agent: 'claude' })
    expect(M.distillEpisode.mock.calls[0][1]).toEqual({ llm: expect.anything() })

    passThrough({ id: 'ep-low' })
    M.isHighValueEpisode.mockReturnValue(false)
    M.distillEpisode.mockClear()
    await invoke('memory:reflect-session', { terminalId: 't1', cwd: '/repo', agent: 'claude' })
    expect(M.distillEpisode.mock.calls[0][1]).toEqual({})
  })

  it('never consults the episode when the distiller flag is off', async () => {
    // The flag short-circuits, so a build without it opted in never even asks whether the episode
    // was worth an LLM call.
    await boot()

    passThrough({ id: 'ep-high' })
    M.isHighValueEpisode.mockClear()
    M.isHighValueEpisode.mockReturnValue(true)
    M.distillEpisode.mockClear()
    await invoke('memory:reflect-session', { terminalId: 't1', cwd: '/repo', agent: 'claude' })

    expect(M.distillEpisode.mock.calls[0][1]).toEqual({})
    expect(M.isHighValueEpisode).not.toHaveBeenCalled()
  })
})

