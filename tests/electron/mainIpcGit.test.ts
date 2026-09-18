// GIT + SWARM IPC handlers in src/main/index.ts — the paths the existing suites leave open.
//
// mainProcess.test.ts already covers the happy paths of every git handler (it mocks safeGit and
// asserts on a reconstructed command string), and security.test.ts covers the argv-safety contract
// and the two headline Commit-Shield blocks. This file deliberately does NOT re-test those. It goes
// after what neither of them reaches:
//
//   * gitShieldGate's OTHER arms — shield switched OFF, an empty staged diff, and above all the
//     FAIL-OPEN contract: a git or audit error must NEVER wedge a commit. A shield that fails
//     closed is a shield that bricks someone's repo the day Termpolis has a bad afternoon.
//   * the leak contract — a block message is derived from the matched RULE, never from the matched
//     VALUE. `hit.sample` carries the secret; if it ever reached the IPC reply or the audit log,
//     the shield itself would become the leak.
//   * git:commit-all's gate, which is armed AFTER `add -A` (order matters: gate first and the
//     shield scans an incomplete index).
//   * the Commit-Shield hook installer's error/edge paths: a non-repo, the packaged scriptPath, a
//     FOREIGN husky hook (must be chained, never clobbered), and the protected-repo list.
//   * swarm:run-command's trust gate and the workspace:* error envelopes.
//
// Harness is security.test.ts's: `electron` and child_process are mocked, and the REAL
// gitCommand / commitScan / aiSecurity rule engine runs — so a rejection here is a real rejection
// and a match here is a real 97-rule match. Both `fs` and `node:fs` are backed by one in-memory
// file map (index.ts READS hooks through node:fs and WRITES them through fs), which keeps this
// suite hermetic: no temp dirs, nothing shared with a parallel test process.

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { join as pJoin, resolve as pResolve } from 'node:path'
import { tmpdir } from 'node:os'

// ---------------------------------------------------------------------------
// Hoisted mock state
// ---------------------------------------------------------------------------
const H = vi.hoisted(() => {
  const norm = (p: unknown): string => String(p).split('\\').join('/')
  // Virtual filesystem. Only what a test seeds exists; everything else reads back as '{}' — the
  // same permissive default the other main-process suites use, so module init can't explode on an
  // unseeded path.
  const files = new Map<string, string>()

  const fs = {
    existsSync: vi.fn((p: unknown) => files.has(norm(p))),
    readFileSync: vi.fn((p: unknown) => (files.has(norm(p)) ? files.get(norm(p))! : '{}')),
    readdirSync: vi.fn(() => [] as unknown[]),
    statSync: vi.fn(() => ({ size: 0, mtimeMs: 0, isDirectory: () => false, isFile: () => true })),
    realpathSync: vi.fn((p: unknown) => String(p)),
    accessSync: vi.fn(),
    constants: { R_OK: 4, W_OK: 2, X_OK: 1, F_OK: 0 },
    writeFileSync: vi.fn((p: unknown, d: unknown) => { files.set(norm(p), String(d)) }),
    appendFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    chmodSync: vi.fn(),
    unlinkSync: vi.fn((p: unknown) => { files.delete(norm(p)) }),
    renameSync: vi.fn(),
    rmSync: vi.fn(),
    openSync: vi.fn(() => 3),
    closeSync: vi.fn(),
    fsyncSync: vi.fn(),
    watch: vi.fn(() => ({ close: vi.fn() })),
    promises: {
      appendFile: vi.fn(async () => {}),
      readFile: vi.fn(async () => '{}'),
      writeFile: vi.fn(async () => {}),
      readdir: vi.fn(async () => []),
      stat: vi.fn(async () => ({ size: 0, mtimeMs: 0 })),
      mkdir: vi.fn(async () => {}),
      unlink: vi.fn(async () => {}),
      rename: vi.fn(async () => {}),
    },
  }

  return {
    norm,
    files,
    fs,
    execSync: vi.fn(),
    execFileSync: vi.fn(),
    // execFile (CALLBACK style) — the polled git handlers use it so they don't block the main
    // thread on a spawn. Defaults to "no output, no error"; tests override per command.
    execFile: vi.fn((_bin: string, _args: string[], _opts: unknown, cb: (e: Error | null, out: string) => void) => { cb(null, '') }),
    // exec (CALLBACK style, THROUGH A SHELL) — runSafeCommandAsync takes this path on win32, where
    // npm/npx are .cmd shims a shell-less spawn cannot resolve at all.
    exec: vi.fn((_cmd: string, _opts: unknown, cb: (e: Error | null, out: string, err: string) => void) => { cb(null, '', '') }),
    spawn: vi.fn(),
    showOpenDialog: vi.fn(),
    // The audit sink. gitShieldGate fire-and-forgets into this; we assert on WHAT it records — and
    // force it to reject, to prove a broken audit log cannot break a commit.
    appendAudit: vi.fn(async () => {}),
    isWorkspaceTrusted: vi.fn(() => true),
    trustWorkspace: vi.fn(),
    revokeWorkspaceTrust: vi.fn(),
    listTrustedWorkspaces: vi.fn((): string[] => []),
    ensureWorkspaceTrust: vi.fn(async () => true),
  }
})

// A REAL, suite-private userData dir. It has to be real: index.ts (and aiSecurity) reach for
// `require('fs')` in a couple of startup paths, and a `require` inside a transformed source file
// is NOT intercepted by vi.mock('fs') — it gets the genuine module. Pointing userData at a
// directory of our own keeps those stray writes out of the shared temp dir (and out of the way of
// the suites running beside us). Everything the tests actually assert on still goes through the
// mocked fs / node:fs above.
const USER_DATA_NAME = 'termpolis-test-mainIpcGit'
const USER_DATA = pJoin(tmpdir(), USER_DATA_NAME)

// ---------------------------------------------------------------------------
// electron
// ---------------------------------------------------------------------------
const ipcHandlers = new Map<string, Function>()
const mockWebContents = { send: vi.fn(), executeJavaScript: vi.fn() }
const mockMainWindow = {
  minimize: vi.fn(), maximize: vi.fn(), unmaximize: vi.fn(),
  isMaximized: vi.fn(), isMinimized: vi.fn(() => false),
  restore: vi.fn(), focus: vi.fn(), close: vi.fn(), on: vi.fn(),
  loadURL: vi.fn(), loadFile: vi.fn(), webContents: mockWebContents,
}
function MockBrowserWindow() { return mockMainWindow }
MockBrowserWindow.prototype = {}

vi.mock('electron', () => ({
  app: {
    // Must match USER_DATA below; the factory is hoisted, so it cannot close over it.
    getPath: vi.fn(() => require('path').join(require('os').tmpdir(), 'termpolis-test-mainIpcGit')),
    getVersion: vi.fn(() => '1.25.2'),
    whenReady: () => Promise.resolve(),
    requestSingleInstanceLock: () => true,
    setName: vi.fn(),
    setAppUserModelId: vi.fn(),
    on: vi.fn(),
    commandLine: { appendSwitch: vi.fn() },
    // Deliberately a plain, writable property: hookPathsFor reads it at CALL time to choose
    // between the packaged resources path and the dev source path, and the packaged arm is only
    // reachable by flipping it.
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
    showSaveDialog: vi.fn(),
    showOpenDialog: H.showOpenDialog,
    showMessageBox: vi.fn(async () => ({ response: 0, checkboxChecked: false })),
  },
  Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn(() => ({})) },
  nativeImage: { createFromPath: vi.fn(() => ({})), createFromBuffer: vi.fn(() => ({})) },
  globalShortcut: { register: vi.fn(), unregisterAll: vi.fn() },
  shell: { openExternal: vi.fn(), openPath: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8'),
  },
}))

// ---------------------------------------------------------------------------
// child_process + fs (BOTH specifiers — index.ts reads hooks via node:fs, writes via fs)
// ---------------------------------------------------------------------------
vi.mock('child_process', () => ({
  default: { execSync: H.execSync, execFileSync: H.execFileSync, execFile: H.execFile, exec: H.exec, spawn: H.spawn },
  execSync: H.execSync,
  execFileSync: H.execFileSync,
  execFile: H.execFile,
  exec: H.exec,
  spawn: H.spawn,
}))
vi.mock('fs', () => ({ ...H.fs, default: H.fs }))
vi.mock('node:fs', () => ({ ...H.fs, default: H.fs }))

// ---------------------------------------------------------------------------
// aiSecurity — REAL rule engine and REAL settings (so the shield toggle behaves exactly as it does
// in production), with only the audit sink swapped for one we can inspect and make fail.
// ---------------------------------------------------------------------------
vi.mock('../../src/main/aiSecurity', async () => {
  const actual = await vi.importActual<typeof import('../../src/main/aiSecurity')>('../../src/main/aiSecurity')
  return { ...actual, appendAudit: H.appendAudit }
})

// workspaceTrust — the swarm run-command gate. Mocked so the gate's verdict is a dial, and so the
// workspace:* handlers' error envelopes are reachable at all.
vi.mock('../../src/main/workspaceTrust', () => ({
  initWorkspaceTrust: vi.fn(),
  isWorkspaceTrusted: H.isWorkspaceTrusted,
  trustWorkspace: H.trustWorkspace,
  revokeWorkspaceTrust: H.revokeWorkspaceTrust,
  listTrustedWorkspaces: H.listTrustedWorkspaces,
  ensureWorkspaceTrust: H.ensureWorkspaceTrust,
}))

// ---------------------------------------------------------------------------
// Everything index.ts touches that this suite is not exercising
// ---------------------------------------------------------------------------
vi.mock('../../src/main/sentry', () => ({ initMainSentry: vi.fn() }))
vi.mock('../../src/main/terminalManager', () => ({
  // Primed at startup so spawnTerminal never probes for jq/yq/nano on the main thread.
  primeBundledToolsCheck: vi.fn(async () => false),
  spawnTerminal: vi.fn(), killTerminal: vi.fn(), writeToTerminal: vi.fn(),
  resizeTerminal: vi.fn(), killAll: vi.fn(), getTerminalCwd: vi.fn(), getTerminalCwdAsync: vi.fn(async () => ''),
  getTerminalPid: vi.fn(), computeWindowsPty: vi.fn(),
}))
vi.mock('../../src/main/sessionStore', () => ({ loadSession: vi.fn(() => null), loadRestoreSession: vi.fn(() => null), saveSession: vi.fn() }))
vi.mock('../../src/main/historyStore', () => ({ appendCommand: vi.fn(), searchHistory: vi.fn(() => []) }))
vi.mock('../../src/main/configFileManager', () => ({ readConfigFile: vi.fn(), writeConfigFile: vi.fn() }))
vi.mock('../../src/main/completionService', () => ({
  listPathEntries: vi.fn(() => []), listPathCommands: vi.fn(() => []), listEnvVars: vi.fn(() => []),
}))
vi.mock('../../src/main/shellDetector', () => ({ detectAvailableShells: vi.fn(async () => []) }))
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
  initEventBus: vi.fn(), query: vi.fn(() => []), subscribe: vi.fn(),
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
vi.mock('../../src/main/autoUpdater', () => ({ initAutoUpdater: vi.fn() }))
vi.mock('../../src/main/agentCommandSanitizer', () => ({ sanitizeAgentCommand: vi.fn((cmd: string) => cmd) }))
vi.mock('uuid', () => ({ v4: vi.fn(() => 'mock-uuid') }))

// ---------------------------------------------------------------------------
// Harness helpers
// ---------------------------------------------------------------------------
function invoke(channel: string, args: unknown = {}): any {
  const handler = ipcHandlers.get(channel)
  if (!handler) throw new Error(`No handler for ${channel}`)
  return handler({}, args)
}

/** Route git by argv (and cwd). Return a string for stdout, or an Error to make that call fail.
 *
 *  v1.47.1: there is no longer a sync git path to route. Every handler — read AND write — goes
 *  through safeGitAsync, because a synchronous spawn blocks the thread that pumps every PTY (that
 *  was the 10-second typing lag). Both mocks are still armed: execFileSync so any residual sync
 *  caller answers the same way, execFile because that is the one production actually reaches. */
/** git under every spelling the resolver can produce: `git`, `git.exe`, or a full install path. */
const isGitBin = (bin: unknown): boolean => /(^|[\\/])git(\.exe)?$/i.test(String(bin ?? ''))
/** The two live routes. The spawn mocks read them rather than closing over one, so `git()` and
 *  `shell()` compose in either order — several tests arm one and leave the other to `beforeEach`. */
let gitRoute: (argv: string[], opts: { cwd: string }) => string | Error = () => ''
let commandAnswer: string | Error = ''
function git(route: (argv: string[], opts: { cwd: string }) => string | Error): void {
  gitRoute = route
  H.execFileSync.mockImplementation((_bin: string, argv: string[], opts: { cwd: string }) => {
    const out = gitRoute(argv, opts)
    if (out instanceof Error) throw out
    return Buffer.from(out)
  })
  // The argv spawn carries BOTH git and — off win32 — safe commands, so the bin picks the route.
  H.execFile.mockImplementation(
    (bin: string, argv: string[], opts: { cwd: string }, cb: (e: Error | null, out: string, err?: string) => void) => {
      const out = isGitBin(bin) ? gitRoute(argv, opts) : commandAnswer
      if (out instanceof Error) cb(out, '', String(out.message))
      else cb(null, out, '')
    },
  )
}
/** Route the ASYNC (callback) git. Kept as its own name where a test is specifically about the
 *  off-thread path; identical to `git` since every path became async. */
const gitAsync = git
/**
 * Answer a non-git safe command (`npm test`, …).
 *
 * runSafeCommandAsync picks its spawn by PLATFORM: a shell on win32, where npm/npx are `.cmd` shims
 * a shell-less spawn cannot resolve at all, and plain argv everywhere else. Arming only the shell is
 * how two tests here passed on Windows and failed on macOS/Linux CI — off win32 the command landed
 * on execFile, was handed git's argv router, and came back empty with a false exit code 0. One
 * answer now feeds both spawns, so these tests say the same thing on every platform.
 */
function shell(out: string | Error): void {
  commandAnswer = out
  H.exec.mockImplementation(
    (_cmd: string, _opts: unknown, cb: (e: Error | null, stdout: string, stderr: string) => void) => {
      if (commandAnswer instanceof Error) cb(commandAnswer, '', String(commandAnswer.message))
      else cb(null, commandAnswer, '')
    },
  )
}
/** Every git argv that ran, whichever spawn flavour carried it, space-joined. A safe command is not
 *  a git call even when it rides the same mock, so the BIN decides membership, not the mock. */
const allGitCalls = (): string[][] =>
  [...H.execFileSync.mock.calls, ...H.execFile.mock.calls]
    .filter((c) => isGitBin(c[0]))
    .map((c) => c[1] as string[])
/** Every git argv the ASYNC path ran, space-joined. */
const gitAsyncCalls = (): string[] => H.execFile.mock.calls.map((c) => (c[1] as string[]).join(' '))
/** Every git argv the handlers ran, in order, space-joined. */
const gitCalls = (): string[] => allGitCalls().map((argv) => argv.join(' '))
/** Did git run this subcommand (`commit`, `push`, `add`, …)? */
const ranGit = (sub: string): boolean => allGitCalls().some((argv) => argv[0] === sub)
/** The staged-diff scan the Commit Shield runs before a commit. */
const scannedStagedDiff = (): boolean => allGitCalls().some((argv) => argv.includes('--cached'))
/** The unpushed-patch scan the Commit Shield runs before a push. */
const scannedPushRange = (): boolean => allGitCalls().some((argv) => argv.includes('--remotes'))
const auditCalls = (): any[] => H.appendAudit.mock.calls.map((c) => c[0])

// Realistic-shaped but entropy-poor, so GitHub push protection will not block this test file while
// the real rule engine still matches the regex.
const AWS_KEY = 'AKIA' + 'A'.repeat(16)
const OPENAI_KEY = 'sk-' + 'a'.repeat(24)
const STAGED_DIFF_WITH_SECRET = `diff --git a/.env b/.env\n+AWS_ACCESS_KEY_ID=${AWS_KEY}\n`

const HOOKS_REL = '.git/hooks'
const REPO = '/repo'
const HOOKS_DIR = pResolve(REPO, HOOKS_REL)
const PRE_COMMIT = pJoin(HOOKS_DIR, 'pre-commit')
const PRE_PUSH = pJoin(HOOKS_DIR, 'pre-push')
const SHIELD_REPOS = pJoin(USER_DATA, 'commit-shield-repos.json')

const SENTINEL = '# >>> termpolis commit shield >>>'
const HUSKY_HOOK = '#!/usr/bin/env sh\n. "$(dirname -- "$0")/_/husky.sh"\nnpx lint-staged\n'

/** Seed a file into the virtual fs. */
const seed = (p: string, content: string): void => { H.files.set(H.norm(p), content) }
/** Read back what a handler wrote (the mocked fs.writeFileSync stores into the same map). */
const wrote = (p: string): string | undefined => H.files.get(H.norm(p))

/** Toggle the Commit Shield through the real IPC handler — the same path the Settings panel uses. */
const setShield = (value: boolean): Promise<unknown> => invoke('aiSecurity:set-commit-shield', { value })

let ledger: typeof import('../../src/main/recallLedger')
let memClient: typeof import('../../src/main/memoryClient')
let gitCache: typeof import('../../src/main/gitCache')

beforeAll(async () => {
  // Real dir for the real (require-based) startup writes — see the USER_DATA note above.
  const realFs = await vi.importActual<typeof import('fs')>('fs')
  realFs.mkdirSync(USER_DATA, { recursive: true })

  vi.resetModules()
  await import('../../src/main/index')
  // These must come from the SAME post-reset registry index.ts loaded from; a static import
  // resolved before vi.resetModules() is a different module object, and a spy taken from it
  // would sit there uncalled forever.
  ledger = await import('../../src/main/recallLedger')
  memClient = await import('../../src/main/memoryClient')
  gitCache = await import('../../src/main/gitCache')
  await new Promise((resolve) => setTimeout(resolve, 50))
})

beforeEach(async () => {
  H.execFileSync.mockReset()
  H.execSync.mockReset()
  // execFile/exec carry the git calls now, so their HISTORY is what ranGit() reads. Leaving it to
  // accumulate would make every test inherit the spawns of the one before it.
  H.execFile.mockReset()
  H.exec.mockReset()
  H.appendAudit.mockReset()
  H.appendAudit.mockImplementation(async () => {})
  H.showOpenDialog.mockReset()
  H.ensureWorkspaceTrust.mockReset()
  H.ensureWorkspaceTrust.mockImplementation(async () => true)
  H.isWorkspaceTrusted.mockReset()
  H.isWorkspaceTrusted.mockImplementation(() => true)
  H.trustWorkspace.mockReset()
  H.revokeWorkspaceTrust.mockReset()
  H.listTrustedWorkspaces.mockReset()
  H.listTrustedWorkspaces.mockImplementation(() => [])
  // Re-arm the virtual-fs implementations (a test may have replaced one with a thrower).
  H.fs.writeFileSync.mockImplementation((p: unknown, d: unknown) => { H.files.set(H.norm(p), String(d)) })
  H.fs.mkdirSync.mockImplementation(() => undefined)
  H.fs.existsSync.mockImplementation((p: unknown) => H.files.has(H.norm(p)))
  H.fs.readFileSync.mockImplementation((p: unknown) => (H.files.has(H.norm(p)) ? H.files.get(H.norm(p))! : '{}'))
  H.files.clear()
  git(() => '')
  shell('')
  // The read handlers share answers for 1.5 s (src/main/gitCache.ts) so a rail repaint does not
  // respawn git per panel. That window outlives a test, so the next one would be handed the
  // PREVIOUS test's stdout and never spawn at all.
  gitCache.invalidateGitCache()

  // Every suite below assumes the shipped default: shield ARMED. Persisting that setting itself
  // writes a file, so the fs/exec spies are cleared AFTER it — each test sees only its own I/O.
  await setShield(true)
  H.execFileSync.mockClear()
  H.execFile.mockClear()
  H.exec.mockClear()
  H.appendAudit.mockClear()
  for (const fn of [H.fs.writeFileSync, H.fs.unlinkSync, H.fs.mkdirSync, H.fs.chmodSync]) fn.mockClear()
})

// =========================================================================
// gitShieldGate — the gate itself
// =========================================================================
describe('Commit Shield — gitShieldGate', () => {
  it('scans the staged diff, lets a clean commit through, and records the scan', async () => {
    git((argv) => (argv.includes('--cached') ? 'diff --git a/README.md\n+hello\n' : ''))

    const r = await invoke('git:commit', { cwd: REPO, message: 'docs: readme' })

    expect(r.success).toBe(true)
    expect(scannedStagedDiff()).toBe(true)
    expect(ranGit('commit')).toBe(true)
    expect(auditCalls()).toContainEqual(
      expect.objectContaining({ agent: 'git', event: 'commit_scan', hitCount: 0, notes: 'commit scan clean' }),
    )
  })

  it('treats an empty staged diff as clean and records that it scanned zero bytes', async () => {
    // Nothing staged: the scan has nothing to look at. That is CLEAN, not an error — and the audit
    // line must say so honestly rather than claiming it inspected something.
    git(() => '')

    const r = await invoke('git:commit', { cwd: REPO, message: 'chore: empty' })

    expect(r.success).toBe(true)
    expect(auditCalls()).toContainEqual(
      expect.objectContaining({ event: 'commit_scan', hitCount: 0, byteCount: 0 }),
    )
  })

  it('blocks a commit carrying a secret and NEVER puts the secret in the reply or the audit log', async () => {
    // `hit.sample` carries the matched value. The design rests on the block message being built
    // from the RULE LABEL — if a refactor ever templated the sample in, the shield itself would
    // become the leak: straight into the renderer, and into an on-disk audit file.
    git((argv) => (argv.includes('--cached') ? STAGED_DIFF_WITH_SECRET : ''))

    const r = await invoke('git:commit', { cwd: REPO, message: 'feat: add config' })

    expect(r.success).toBe(false)
    expect(r.error).toContain('Blocked commit')
    expect(r.error).toContain('AWS Access Key ID')
    expect(r.error).not.toContain(AWS_KEY)
    expect(ranGit('commit')).toBe(false)

    const blocked = auditCalls().find((e) => e.event === 'commit_blocked')
    expect(blocked).toMatchObject({ agent: 'git', hitCount: 1 })
    expect(blocked.byteCount).toBe(STAGED_DIFF_WITH_SECRET.length)
    expect(JSON.stringify(auditCalls())).not.toContain(AWS_KEY)
  })

  it('blocks a push whose unpushed commits carry a secret, and audits it as push_blocked', async () => {
    git((argv) => (argv[0] === 'log' ? `commit abc123\n+key = "${OPENAI_KEY}"\n` : ''))

    const r = await invoke('git:push', { cwd: REPO })

    expect(r.success).toBe(false)
    expect(r.error).toContain('Blocked push')
    expect(r.error).not.toContain(OPENAI_KEY)
    expect(ranGit('push')).toBe(false)
    expect(auditCalls()).toContainEqual(expect.objectContaining({ agent: 'git', event: 'push_blocked' }))
    expect(JSON.stringify(auditCalls())).not.toContain(OPENAI_KEY)
  })

  it('does not scan at all when the shield is switched off — the commit just runs', async () => {
    await setShield(false)
    git((argv) => (argv.includes('--cached') ? STAGED_DIFF_WITH_SECRET : ''))

    const r = await invoke('git:commit', { cwd: REPO, message: 'feat: add config' })

    expect(r.success).toBe(true)
    // Opting out means opting out of the SCAN, not just of the block — no scan, no audit line.
    expect(scannedStagedDiff()).toBe(false)
    expect(ranGit('commit')).toBe(true)
    expect(H.appendAudit).not.toHaveBeenCalled()
  })

  it('does not scan the push range when the shield is switched off', async () => {
    await setShield(false)
    git(() => 'Everything up-to-date')

    const r = await invoke('git:push', { cwd: REPO })

    expect(r.success).toBe(true)
    expect(scannedPushRange()).toBe(false)
    expect(ranGit('push')).toBe(true)
  })

  // FAIL OPEN, yes -- but as of v1.25.7, never fail SILENT.
  //
  // The gate blocks only on a POSITIVE match. A locked index, a corrupt object, a detached HEAD --
  // none of those are secrets, and none of them get to stop the user committing. That much is
  // unchanged, and it is right.
  //
  // What changed: the failure used to be swallowed whole. `catch { return null }` -- no audit
  // entry, no warning, nothing. So "the shield did not run" was indistinguishable from "the shield
  // found nothing", and the user went on believing they were protected. That is the same failure
  // mode that made the gpg-private watcher rule useless for months: its silence read as "clean".
  //
  // A security control whose failure looks exactly like success is worse than no control at all.
  it('FAILS OPEN on a git error -- but RECORDS that the scan did not run', async () => {
    git((argv) => {
      if (argv.includes('--cached')) throw new Error('fatal: unable to read index file')
      return ''
    })

    const r = await invoke('git:commit', { cwd: REPO, message: 'fix: thing' })

    // Fail-open: the commit still goes through. Git is never wedged for a non-secret reason.
    expect(r.success).toBe(true)
    expect(ranGit('commit')).toBe(true)

    // …but it is ON THE RECORD that nothing was scanned.
    expect(H.appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'git',
        event: 'shield_scan_failed',
        notes: expect.stringContaining('DID NOT RUN'),
      }),
    )
    // It must NEVER be logged as a clean scan -- that is the lie this whole change exists to kill.
    expect(H.appendAudit).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'commit_scan' }),
    )
  })

  it('the PUSH scan failing is also recorded, and the push still goes out', async () => {
    // This is the one that actually bites. `git log -p --not --remotes` on a repo with no
    // remote-tracking refs excludes nothing, so it diffs the ENTIRE history -- correct (you are
    // about to push all of it) but unbounded. Overflow the buffer and the throw used to be
    // swallowed: the push went out UNSCANNED and silent, at exactly the moment the shield matters
    // most. The first push of a whole history to a fresh remote is precisely when an old secret
    // actually gets published.
    git((argv) => {
      if (argv.includes('log')) throw new Error('stdout maxBuffer length exceeded')
      return ''
    })

    const r = await invoke('git:push', { cwd: REPO })

    expect(r.success).toBe(true) // fail open: the push is not wedged
    expect(H.appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'shield_scan_failed',
        notes: expect.stringContaining('push scan DID NOT RUN'),
      }),
    )
    expect(H.appendAudit).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'commit_scan' }))
  })

  it('TELLS THE USER: the renderer is notified so an unscanned push cannot pass unnoticed', async () => {
    // An audit line nobody reads is not much better than silence. The banner is the point.
    git((argv) => {
      if (argv.includes('log')) throw new Error('stdout maxBuffer length exceeded')
      return ''
    })

    mockWebContents.send.mockClear()
    await invoke('git:push', { cwd: REPO })

    const sent = mockWebContents.send.mock.calls.filter((c: any[]) => c[0] === 'shield:scan-failed')
    expect(sent.length).toBe(1)
    expect(sent[0][1]).toMatchObject({ op: 'push', cwd: REPO })
    expect(String(sent[0][1].error)).toContain('maxBuffer')
  })

  it('a DISABLED shield is not a scan FAILURE -- it must not cry wolf', async () => {
    // Turning the shield off is a choice, not a malfunction. If "off" raised the same alarm as
    // "broke", the alarm would be worthless within a day.
    await setShield(false)
    try {
      mockWebContents.send.mockClear()
      git((argv) => {
        // Only a SCAN explodes. The commit itself must still work, or this test would be asserting
        // "git is broken" rather than "a disabled shield stays quiet".
        if (argv.includes('--cached') || argv.includes('log')) throw new Error('scan would have failed')
        return ''
      })
      const r = await invoke('git:commit', { cwd: REPO, message: 'x' })
      expect(r.success).toBe(true)
      expect(H.appendAudit).not.toHaveBeenCalledWith(
        expect.objectContaining({ event: 'shield_scan_failed' }),
      )
      expect(mockWebContents.send.mock.calls.filter((c: any[]) => c[0] === 'shield:scan-failed')).toEqual([])
    } finally {
      await setShield(true)
    }
  })

  it('a CLEAN scan is still recorded as clean -- the new path did not swallow the happy case', async () => {
    git(() => '') // no diff, nothing to find
    const r = await invoke('git:commit', { cwd: REPO, message: 'x' })
    expect(r.success).toBe(true)
    expect(H.appendAudit).toHaveBeenCalledWith(expect.objectContaining({ event: 'commit_scan' }))
    expect(H.appendAudit).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'shield_scan_failed' }),
    )
  })

  it('FAILS OPEN: a git failure during the push scan must not block the push', async () => {
    git((argv) => {
      if (argv[0] === 'log') throw new Error('fatal: bad revision')
      return 'To github.com:foo/bar.git'
    })

    const r = await invoke('git:push', { cwd: REPO })

    expect(r.success).toBe(true)
    expect(ranGit('push')).toBe(true)
  })

  it('FAILS OPEN: a broken audit log must not block the commit', async () => {
    // The audit write is fire-and-forget with a .catch — a full disk or a locked audit file is not
    // a reason to reject a commit, and an unhandled rejection here would be worse still.
    H.appendAudit.mockRejectedValue(new Error('EACCES: audit log is read-only'))
    git((argv) => (argv.includes('--cached') ? 'diff --git a/a.ts\n+const x = 1\n' : ''))

    const r = await invoke('git:commit', { cwd: REPO, message: 'chore: x' })

    expect(r.success).toBe(true)
    expect(ranGit('commit')).toBe(true)
    expect(H.appendAudit).toHaveBeenCalled()
  })

  it('surfaces a real push failure (no remote configured) instead of dressing it up as a block', async () => {
    git((argv) => {
      if (argv[0] === 'push') throw new Error('fatal: No configured push destination.')
      return '' // the scan itself is clean
    })

    const r = await invoke('git:push', { cwd: REPO })

    expect(r.success).toBe(false)
    expect(r.error).toContain('No configured push destination')
    expect(r.error).not.toContain('Blocked')
    expect(scannedPushRange()).toBe(true) // …and the scan still ran first
  })

  it('rejects an empty commit message before git is touched at all', async () => {
    const r = await invoke('git:commit', { cwd: REPO, message: '   ' })

    expect(r).toEqual({ success: false, error: 'Commit message cannot be empty' })
    expect(H.execFileSync).not.toHaveBeenCalled() // not even the scan
  })
})

// =========================================================================
// git:commit-all — stage-then-commit, gated AFTER the staging
// =========================================================================
describe('Commit Shield — git:commit-all', () => {
  it('stages everything BEFORE scanning, then blocks when the newly-staged diff carries a secret', async () => {
    // The gate has to run after `add -A`, or it scans an incomplete index and waves through the
    // very file that was just staged. Assert the ORDER, not only the outcome.
    git((argv) => (argv.includes('--cached') ? STAGED_DIFF_WITH_SECRET : ''))

    const r = await invoke('git:commit-all', { cwd: REPO, message: 'feat: everything' })

    expect(r.success).toBe(false)
    expect(r.error).toContain('Blocked commit')
    expect(r.error).toContain('AWS Access Key ID')
    expect(ranGit('commit')).toBe(false)

    const calls = gitCalls()
    const addIdx = calls.findIndex((c) => c.startsWith('add -A'))
    const scanIdx = calls.findIndex((c) => c.includes('--cached'))
    expect(addIdx).toBeGreaterThanOrEqual(0)
    expect(scanIdx).toBeGreaterThan(addIdx)
  })

  it('stages and commits when the staged diff is clean', async () => {
    git(() => '')

    const r = await invoke('git:commit-all', { cwd: REPO, message: 'chore: tidy' })

    expect(r.success).toBe(true)
    expect(gitCalls()).toContain('add -A')
    expect(gitCalls()).toContain('commit -m chore: tidy')
  })
})

// =========================================================================
// Commit Shield hooks — repo resolution
// =========================================================================
describe('Commit Shield hooks — repo resolution', () => {
  it('treats an EMPTY --git-path answer as "not a git repository"', async () => {
    // `git rev-parse --git-path hooks` printing nothing means we do not know where the hooks live.
    // Guessing `.git/hooks` would install a hook git never runs — protection that silently does
    // nothing, which is worse than telling the user it could not be done.
    git(() => '   \n')

    const r = await invoke('gitHooks:status', { cwd: REPO })

    expect(r).toEqual({ success: false, error: 'Not a git repository' })
  })

  it('refuses to install into a folder that is not a git repository, and names the fix', async () => {
    git(() => new Error('fatal: not a git repository (or any of the parent directories)'))

    const r = await invoke('gitHooks:install', { cwd: '/not-a-repo' })

    expect(r.success).toBe(false)
    expect(r.error).toContain('pick the folder that contains .git')
    expect(H.fs.writeFileSync).not.toHaveBeenCalled()
  })

  it('refuses to uninstall from a folder that is not a git repository', async () => {
    git(() => new Error('fatal: not a git repository'))

    const r = await invoke('gitHooks:uninstall', { cwd: '/not-a-repo' })

    expect(r).toEqual({ success: false, error: 'Not a git repository' })
    expect(H.fs.unlinkSync).not.toHaveBeenCalled()
  })

  it('points the installed hook at the SHIPPED scanner in a packaged build', async () => {
    // The hook shells out to a standalone scanner so it keeps protecting you with Termpolis closed.
    // In a packaged app that script lives under resources/ — bake the dev source path into a
    // shipped hook and the shield fails open forever, on every install, silently.
    const { app } = (await import('electron')) as unknown as { app: { isPackaged: boolean } }
    const proc = process as unknown as { resourcesPath?: string }
    const prevPacked = app.isPackaged
    const prevRes = proc.resourcesPath
    app.isPackaged = true
    proc.resourcesPath = '/opt/Termpolis/resources'
    try {
      git(() => HOOKS_REL)
      const r = await invoke('gitHooks:install', { cwd: REPO })

      expect(r.success).toBe(true)
      expect(r.data.written).toEqual(['pre-commit', 'pre-push'])
      const hook = wrote(PRE_COMMIT)!
      expect(hook).toContain('/opt/Termpolis/resources/mcp-adapter/termpolis-githook.cjs')
      expect(hook).not.toContain('src/mcp-adapter')
    } finally {
      app.isPackaged = prevPacked
      proc.resourcesPath = prevRes
    }
  })

  it('points the installed hook at the source scanner in a dev build', async () => {
    git(() => HOOKS_REL)

    const r = await invoke('gitHooks:install', { cwd: REPO })

    expect(r.success).toBe(true)
    expect(wrote(PRE_COMMIT)).toContain('src/mcp-adapter/termpolis-githook.cjs')
    expect(wrote(PRE_PUSH)).toContain('termpolis-githook.cjs')
    expect(H.fs.mkdirSync).toHaveBeenCalledWith(HOOKS_DIR, { recursive: true })
  })
})

// =========================================================================
// Commit Shield hooks — a foreign hook is chained, never clobbered
// =========================================================================
describe('Commit Shield hooks — foreign hooks', () => {
  beforeEach(() => { git(() => HOOKS_REL) })

  it('reports an existing husky hook as foreign, not as ours', async () => {
    seed(PRE_COMMIT, HUSKY_HOOK)

    const r = await invoke('gitHooks:status', { cwd: REPO })

    expect(r.success).toBe(true)
    expect(r.data.status['pre-commit']).toBe('foreign')
    expect(r.data.status['pre-push']).toBe('absent')
  })

  it('chains below a husky hook instead of overwriting it', async () => {
    seed(PRE_COMMIT, HUSKY_HOOK)

    const r = await invoke('gitHooks:install', { cwd: REPO })

    expect(r.success).toBe(true)
    const hook = wrote(PRE_COMMIT)!
    expect(hook).toContain(SENTINEL)
    expect(hook).toContain('npx lint-staged') // their script survives
    expect(hook.startsWith('#!/usr/bin/env sh\n')).toBe(true) // and still owns the shebang
    // …and the repo now reports as protected.
    const status = await invoke('gitHooks:status', { cwd: REPO })
    expect(status.data.status['pre-commit']).toBe('installed')
  })

  it('uninstall strips ONLY our block and leaves the foreign hook byte-identical', async () => {
    seed(PRE_COMMIT, HUSKY_HOOK)
    await invoke('gitHooks:install', { cwd: REPO })
    expect(wrote(PRE_COMMIT)).toContain(SENTINEL)
    H.fs.unlinkSync.mockClear()

    const r = await invoke('gitHooks:uninstall', { cwd: REPO })

    expect(r.success).toBe(true)
    expect(wrote(PRE_COMMIT)).toBe(HUSKY_HOOK) // exact round trip
    expect(H.fs.unlinkSync).not.toHaveBeenCalledWith(PRE_COMMIT) // their file is never deleted
  })

  it('uninstall DELETES a hook that is ours alone', async () => {
    await invoke('gitHooks:install', { cwd: REPO }) // no foreign hook: both files are 100% ours
    H.fs.unlinkSync.mockClear()

    const r = await invoke('gitHooks:uninstall', { cwd: REPO })

    expect(r.success).toBe(true)
    expect(r.data.removed).toEqual(['pre-commit', 'pre-push'])
    expect(H.fs.unlinkSync).toHaveBeenCalledWith(PRE_COMMIT)
    expect(H.fs.unlinkSync).toHaveBeenCalledWith(PRE_PUSH)
    expect(wrote(PRE_COMMIT)).toBeUndefined()
  })

  it('SKIPS a hook it cannot read rather than guessing — an unreadable file is never overwritten', async () => {
    // EPERM, a binary blob, a race: whatever it is, we do not get to guess about a file we could
    // not read. Overwriting it is the exact clobber this whole module exists to prevent, so the
    // hook is left alone and only the other one is installed.
    seed(PRE_COMMIT, HUSKY_HOOK) // exists…
    H.fs.readFileSync.mockImplementation((p: unknown) => {
      if (H.norm(p) === H.norm(PRE_COMMIT)) throw new Error('EACCES: permission denied')
      return H.files.has(H.norm(p)) ? H.files.get(H.norm(p))! : '{}'
    })

    const r = await invoke('gitHooks:install', { cwd: REPO })

    expect(r.success).toBe(true)
    expect(r.data.written).toEqual(['pre-push']) // pre-commit skipped, not clobbered
    const written = H.fs.writeFileSync.mock.calls.map((c) => H.norm(c[0]))
    expect(written).not.toContain(H.norm(PRE_COMMIT))
    expect(written).toContain(H.norm(PRE_PUSH))
  })

  it('surfaces a hook-write failure as an error envelope instead of throwing at the IPC layer', async () => {
    seed(PRE_COMMIT, HUSKY_HOOK)
    await invoke('gitHooks:install', { cwd: REPO })
    H.fs.writeFileSync.mockImplementation(() => { throw new Error('EPERM: operation not permitted') })

    const r = await invoke('gitHooks:uninstall', { cwd: REPO })

    expect(r).toEqual({ success: false, error: 'EPERM: operation not permitted' })
  })

  it('surfaces a hooks-dir creation failure as an error envelope', async () => {
    H.fs.mkdirSync.mockImplementation(() => { throw new Error('EROFS: read-only file system') })

    const r = await invoke('gitHooks:install', { cwd: REPO })

    expect(r).toEqual({ success: false, error: 'EROFS: read-only file system' })
    expect(H.fs.writeFileSync).not.toHaveBeenCalled()
  })

  it('installs the hooks even when the audit write fails', async () => {
    H.appendAudit.mockRejectedValue(new Error('audit log unavailable'))

    const r = await invoke('gitHooks:install', { cwd: REPO })

    expect(r.success).toBe(true)
    expect(r.data.written).toEqual(['pre-commit', 'pre-push'])
  })
})

// =========================================================================
// Commit Shield hooks — the protected-repo list
// =========================================================================
describe('Commit Shield hooks — protected-repo list', () => {
  it('persists the repo on install, de-duplicated', async () => {
    seed(SHIELD_REPOS, JSON.stringify([REPO]))
    git(() => HOOKS_REL)

    const r = await invoke('gitHooks:install', { cwd: REPO })

    expect(r.success).toBe(true)
    expect(JSON.parse(wrote(SHIELD_REPOS)!)).toEqual([REPO]) // installing twice does not double it
  })

  it('lists each protected repo with its live hook status, and null for one that is no longer a repo', async () => {
    seed(SHIELD_REPOS, JSON.stringify(['/repo-live', '/repo-gone', 42]))
    seed(pJoin(pResolve('/repo-live', HOOKS_REL), 'pre-commit'), `#!/bin/sh\n${SENTINEL}\n`)
    git((_argv, opts) => {
      if (opts.cwd === '/repo-gone') return new Error('fatal: not a git repository')
      return HOOKS_REL
    })

    const r = await invoke('gitHooks:list', {})

    expect(r.success).toBe(true)
    // The bogus numeric entry is dropped by the type guard, never handed to git.
    expect(r.data.map((e: { repo: string }) => e.repo)).toEqual(['/repo-live', '/repo-gone'])
    expect(r.data[0].status['pre-commit']).toBe('installed')
    expect(r.data[0].status['pre-push']).toBe('absent')
    expect(r.data[1].status).toBeNull()
  })

  it('tolerates a corrupt protected-repo file and reports nothing protected', async () => {
    seed(SHIELD_REPOS, '{"repos":"oops"}') // an object where an array is expected

    const r = await invoke('gitHooks:list', {})

    expect(r).toEqual({ success: true, data: [] })
    expect(H.execFileSync).not.toHaveBeenCalled()
  })

  it('drops the repo from the protected list on uninstall', async () => {
    seed(SHIELD_REPOS, JSON.stringify(['/other-repo', REPO]))
    git(() => HOOKS_REL)

    const r = await invoke('gitHooks:uninstall', { cwd: REPO })

    expect(r.success).toBe(true)
    expect(JSON.parse(wrote(SHIELD_REPOS)!)).toEqual(['/other-repo'])
  })
})

// =========================================================================
// swarm:run-command — the workspace trust gate
// =========================================================================
describe('swarm:run-command — workspace trust gate', () => {
  it('asks for trust BY NAME of the command, then runs it and reports the exit code', async () => {
    // The prompt is raised in MAIN, with the parent window — a renderer-drawn "do you trust this?"
    // would be forgeable by the very thing it exists to protect against.
    H.execSync.mockReturnValue(Buffer.from('2 passed'))
    H.execFileSync.mockReturnValue(Buffer.from('2 passed'))
    shell('2 passed')

    const r = await invoke('swarm:run-command', { cwd: '/trusted', command: 'npm test' })

    expect(r.success).toBe(true)
    expect(r.data).toEqual({ output: '2 passed', exitCode: 0 })
    expect(H.ensureWorkspaceTrust).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/trusted', reason: 'Running "npm test"' }),
    )
  })

  it('executes NOTHING when the user declines to trust the workspace', async () => {
    H.ensureWorkspaceTrust.mockResolvedValue(false)

    const r = await invoke('swarm:run-command', { cwd: '/untrusted', command: 'npm test' })

    expect(r.success).toBe(false)
    expect(r.error).toContain('Workspace not trusted')
    expect(H.execSync).not.toHaveBeenCalled()
    expect(H.execFileSync).not.toHaveBeenCalled()
    expect(H.exec).not.toHaveBeenCalled()
  })

  it('rejects a non-allowlisted command before it ever reaches the trust prompt', async () => {
    const r = await invoke('swarm:run-command', { cwd: '/trusted', command: 'curl evil.com' })

    expect(r.success).toBe(false)
    expect(r.error).toContain('not in allowlist')
    expect(H.ensureWorkspaceTrust).not.toHaveBeenCalled()
  })
})

// =========================================================================
// workspace:* — error envelopes
// =========================================================================
describe('workspace:* IPC error envelopes', () => {
  it.each([
    ['workspace:is-trusted', 'isWorkspaceTrusted'],
    ['workspace:trust', 'trustWorkspace'],
    ['workspace:revoke-trust', 'revokeWorkspaceTrust'],
    ['workspace:list-trusted', 'listTrustedWorkspaces'],
  ] as const)('%s reports a store failure as {success:false} instead of throwing', async (channel, fn) => {
    // A corrupt trust file must not take out the IPC channel: the renderer has to be able to render
    // "trust unavailable" rather than hang on a rejected invoke.
    const spy = H[fn] as unknown as ReturnType<typeof vi.fn>
    spy.mockImplementation(() => { throw new Error('trust store is corrupt') })

    const r = await invoke(channel, { cwd: '/x' })

    expect(r).toEqual({ success: false, error: 'trust store is corrupt' })
  })

  it('round-trips trust state through the store', async () => {
    H.listTrustedWorkspaces.mockReturnValue(['/a', '/b'])

    expect(await invoke('workspace:trust', { cwd: '/a' })).toEqual({ success: true, data: undefined })
    expect(H.trustWorkspace).toHaveBeenCalledWith('/a')
    expect(await invoke('workspace:list-trusted', {})).toEqual({ success: true, data: ['/a', '/b'] })
    expect(await invoke('workspace:revoke-trust', { cwd: '/a' })).toEqual({ success: true, data: undefined })
    expect(H.revokeWorkspaceTrust).toHaveBeenCalledWith('/a')
  })
})

// ===========================================================================
// git:status-parsed — the git status bar's 3-second poll
// ===========================================================================
// This handler had NO test at all, and it ran TWO execFileSync spawns. execFileSync blocks the main
// thread for the whole spawn, and on Windows a cold git spawn is ~106 ms of pure process-creation
// tax before git reads an object: 227-300 ms of dead main thread PER POLL (measured), every 3 s,
// per repo terminal, on the thread that pumps every PTY. `async` on the handler bought nothing.
// It is off-thread and concurrent now, and these pin both the parse and the non-blocking property.
describe('git:status-parsed', () => {
  beforeEach(() => {
    H.execFile.mockReset()
    H.execFileSync.mockReset()
  })

  it('parses the branch, staged and unstaged entries', async () => {
    gitAsync((argv) => {
      if (argv[0] === 'rev-parse') return 'main\n'
      if (argv[0] === 'status') return 'M  staged.ts\n M unstaged.ts\n?? new.ts\n'
      return ''
    })
    const r = await invoke('git:status-parsed', { cwd: '/repo' })
    expect(r.success).toBe(true)
    expect(r.data.branch).toBe('main')
    expect(r.data.staged).toEqual([{ file: 'staged.ts', status: 'M' }])
    // `??` is untracked — it surfaces as unstaged, mapped to 'U'.
    expect(r.data.unstaged).toEqual([
      { file: 'unstaged.ts', status: 'M' },
      { file: 'new.ts', status: 'U' },
    ])
  })

  // The regression that matters. Going back to safeGit here would restore a 7-10% duty cycle of
  // dead main thread for as long as the panel is open — and every test above would still pass.
  it('NEVER blocks the main thread — it spawns git asynchronously, not with execFileSync', async () => {
    gitAsync((argv) => (argv[0] === 'rev-parse' ? 'main\n' : ''))
    await invoke('git:status-parsed', { cwd: '/repo' })
    expect(gitAsyncCalls()).toContain('status --porcelain')
    expect(gitAsyncCalls()).toContain('rev-parse --abbrev-ref HEAD')
    expect(H.execFileSync).not.toHaveBeenCalled()
  })

  it('still reports status when the branch cannot be read (a repo with no commits yet)', async () => {
    gitAsync((argv) => (argv[0] === 'rev-parse' ? new Error('fatal: ambiguous argument HEAD') : 'A  first.ts\n'))
    const r = await invoke('git:status-parsed', { cwd: '/repo' })
    expect(r.success).toBe(true)
    expect(r.data.branch).toBe('')                                    // the .catch, not a thrown handler
    expect(r.data.staged).toEqual([{ file: 'first.ts', status: 'A' }])
  })

  it('degrades to an error envelope when git status itself fails', async () => {
    gitAsync(() => new Error('fatal: not a git repository'))
    const r = await invoke('git:status-parsed', { cwd: '/not-a-repo' })
    expect(r.success).toBe(false)
    expect(r.error).toContain('not a git repository')
  })
})

// ---------------------------------------------------------------------------
// The Changes rail: git:changes / git:change-counts / git:change-diff
// ---------------------------------------------------------------------------
// These are ADDITIVE channels, deliberately not extensions of git:status-parsed. That handler
// splits on newlines and does `.slice(3).trim()`, which structurally cannot carry a rename's old
// path or a filename with a trailing space — and four suites pin its shape. So the rail gets -z
// porcelain of its own. The parsing itself is unit-tested in gitChanges.test.ts; what is tested
// here is the wiring: which argv runs, how many spawns, and what each failure mode returns.

/** Build NUL-terminated porcelain, the way git actually writes it. */
const zrec = (...recs: string[]): string => recs.map((r) => `${r}\0`).join('')

describe('git:changes', () => {
  // The shared beforeEach resets execFileSync but not execFile — the async path is the
  // newer one — so anything asserting on spawn COUNT has to clear it itself.
  beforeEach(() => { H.execFile.mockClear() })

  it('reads status and both numstats in one round trip', async () => {
    gitAsync((argv) => {
      if (argv[0] === 'status') return zrec('## main...origin/main', 'M  a.ts', ' M b.ts', '?? c.ts')
      if (argv.includes('--cached')) return '3\t1\ta.ts\0'
      return '7\t2\tb.ts\0'
    })
    const r = await invoke('git:changes', { cwd: '/repo' })
    expect(r.success).toBe(true)
    expect(r.data.branch).toBe('main')
    expect(r.data.staged).toEqual([
      { file: 'a.ts', status: 'M', added: 3, removed: 1, binary: false },
    ])
    expect(r.data.unstaged).toEqual([
      { file: 'b.ts', status: 'M', added: 7, removed: 2, binary: false },
    ])
    expect(r.data.untracked).toEqual([
      { file: 'c.ts', status: '??', added: 0, removed: 0, binary: false },
    ])
  })

  it('asks git for -z porcelain with the branch header, never newline-delimited output', async () => {
    gitAsync(() => zrec('## main'))
    await invoke('git:changes', { cwd: '/repo' })
    expect(gitAsyncCalls()).toContain('status --porcelain -b -z')
    expect(gitAsyncCalls()).toContain('diff --numstat -z')
    expect(gitAsyncCalls()).toContain('diff --cached --numstat -z')
  })

  it('runs entirely off the async path, so a slow spawn cannot stall the PTY pump', async () => {
    gitAsync(() => zrec('## main'))
    await invoke('git:changes', { cwd: '/repo' })
    expect(H.execFileSync).not.toHaveBeenCalled()
  })

  it('carries ahead/behind through, so the UI can flag unpushed work', async () => {
    gitAsync(() => zrec('## main...origin/main [ahead 2, behind 5]'))
    const r = await invoke('git:changes', { cwd: '/repo' })
    expect(r.data).toMatchObject({ ahead: 2, behind: 5 })
  })

  it('still lists files when the numstats fail (a fresh repo has no diffable HEAD)', async () => {
    // The .catch(() => '') on each numstat is the point: line counts are a nicety,
    // the file list is not.
    gitAsync((argv) => (argv[0] === 'diff' ? new Error('fatal: bad revision') : zrec('## main', 'A  new.ts')))
    const r = await invoke('git:changes', { cwd: '/repo' })
    expect(r.success).toBe(true)
    expect(r.data.staged).toEqual([{ file: 'new.ts', status: 'A', added: 0, removed: 0, binary: false }])
  })

  it('returns an error envelope when status itself fails', async () => {
    gitAsync(() => new Error('fatal: not a git repository'))
    const r = await invoke('git:changes', { cwd: '/tmp' })
    expect(r.success).toBe(false)
    expect(r.error).toContain('not a git repository')
  })
})

describe('git:change-counts', () => {
  beforeEach(() => { H.execFile.mockClear() })

  it('counts every outstanding category from a single spawn', async () => {
    gitAsync(() => zrec(
      '## main...origin/main [ahead 1]',
      'M  staged.ts', ' M dirty.ts', '?? new.ts', 'UU conflict.ts',
    ))
    const r = await invoke('git:change-counts', { cwd: '/repo' })
    expect(r.data).toEqual({
      branch: 'main', ahead: 1, behind: 0,
      staged: 1, unstaged: 1, untracked: 1, conflicted: 1,
    })
    // One spawn is the whole reason for `-b`: this handler runs per terminal row on a
    // 5s poll, and Windows charges ~100ms of pure process-creation tax per git call.
    expect(gitAsyncCalls()).toEqual(['status --porcelain -b -z'])
  })

  it('counts a staged-and-then-modified file on both sides', async () => {
    gitAsync(() => zrec('## main', 'MM both.ts'))
    const r = await invoke('git:change-counts', { cwd: '/repo' })
    expect(r.data).toMatchObject({ staged: 1, unstaged: 1 })
  })

  it('reports a clean, pushed repo as all zeroes rather than as nothing', async () => {
    gitAsync(() => zrec('## main...origin/main'))
    const r = await invoke('git:change-counts', { cwd: '/repo' })
    expect(r.data).toMatchObject({ staged: 0, unstaged: 0, untracked: 0, conflicted: 0, ahead: 0 })
  })

  it('succeeds with null outside a repo, so the sidebar dot simply stays hidden', async () => {
    // Deliberately NOT an error envelope: most terminals are not in a repo, and an
    // error per terminal per poll would be noise, not information.
    gitAsync(() => new Error('fatal: not a git repository'))
    const r = await invoke('git:change-counts', { cwd: '/tmp' })
    expect(r.success).toBe(true)
    expect(r.data).toBeNull()
  })
})

describe('git:change-diff', () => {
  // readFileSync is not cleared globally either, and module startup alone has already
  // called it ~37 times, so the untracked-mode assertions clear it first.
  beforeEach(() => { H.execFile.mockClear(); H.fs.readFileSync.mockClear() })

  it('diffs the index for a staged file', async () => {
    gitAsync(() => 'diff --git a/a.ts b/a.ts\n')
    const r = await invoke('git:change-diff', { cwd: '/repo', file: 'a.ts', mode: 'staged' })
    expect(r.success).toBe(true)
    expect(gitAsyncCalls()).toEqual(['diff --cached -- a.ts'])
  })

  it('diffs the working tree for an unstaged file', async () => {
    gitAsync(() => 'diff --git a/a.ts b/a.ts\n')
    await invoke('git:change-diff', { cwd: '/repo', file: 'a.ts', mode: 'unstaged' })
    expect(gitAsyncCalls()).toEqual(['diff -- a.ts'])
  })

  it('passes a filename with spaces as one argv element, never as shell text', async () => {
    gitAsync(() => '')
    await invoke('git:change-diff', { cwd: '/repo', file: 'my notes.ts', mode: 'unstaged' })
    expect(H.execFile.mock.calls[0][1]).toEqual(['diff', '--', 'my notes.ts'])
  })

  it('stops a leading-dash filename being read as a flag', async () => {
    gitAsync(() => '')
    await invoke('git:change-diff', { cwd: '/repo', file: '--upload-pack=evil', mode: 'unstaged' })
    // The `--` separator is what makes this safe; assert it is still there.
    expect(H.execFile.mock.calls[0][1]).toEqual(['diff', '--', '--upload-pack=evil'])
  })

  it('synthesizes a diff for an untracked file, which git itself will not diff', async () => {
    H.fs.readFileSync.mockReturnValueOnce(Buffer.from('alpha\nbeta\n'))
    const r = await invoke('git:change-diff', { cwd: '/repo', file: 'new.ts', mode: 'untracked' })
    expect(r.success).toBe(true)
    expect(r.data).toContain('new file mode 100644')
    expect(r.data).toContain('@@ -0,0 +1,2 @@')
    expect(r.data).toContain('+alpha')
    expect(H.execFile).not.toHaveBeenCalled()   // no spawn at all for this mode
  })

  it('refuses to read a path that escapes the repository', async () => {
    const r = await invoke('git:change-diff', {
      cwd: '/repo', file: '../../../Windows/System32/drivers/etc/hosts', mode: 'untracked',
    })
    expect(r.success).toBe(false)
    expect(r.error).toContain('outside the repository')
    expect(H.fs.readFileSync).not.toHaveBeenCalled()
  })

  it('returns an error envelope when the untracked file has vanished mid-poll', async () => {
    H.fs.readFileSync.mockImplementationOnce(() => { throw new Error('ENOENT: no such file') })
    const r = await invoke('git:change-diff', { cwd: '/repo', file: 'gone.ts', mode: 'untracked' })
    expect(r.success).toBe(false)
    expect(r.error).toContain('ENOENT')
  })

  it('returns an error envelope when git diff fails', async () => {
    gitAsync(() => new Error('fatal: ambiguous argument'))
    const r = await invoke('git:change-diff', { cwd: '/repo', file: 'a.ts', mode: 'unstaged' })
    expect(r.success).toBe(false)
    expect(r.error).toContain('ambiguous argument')
  })
})

// ---------------------------------------------------------------------------
// coverage:for-file — the handler's own wiring
//
// The substance it delegates to is covered elsewhere and directly: the per-format
// parsers, findCoverageArtifact and readFileCoverage in coverageReader.test.ts,
// resolveInsideRepo in gitChanges.test.ts. What had no test was this handler — the three
// things it decides on its own: that an escaping path is refused BEFORE anything is read,
// that a repo which never produced an artifact is a success carrying null rather than an
// error, and that a throw becomes an envelope instead of a rejection the renderer never
// hears.
// ---------------------------------------------------------------------------
describe('coverage:for-file', () => {
  const LCOV = '/repo/coverage/lcov.info'

  /**
   * beforeEach resets mocks, not the virtual fs — so each test clears its own artifact.
   *
   * Matches on the whole candidate vocabulary rather than just 'lcov.info'. The virtual fs
   * is shared by every test in this file, and now that coverage.xml and coverage.out are
   * discoverable, a file seeded by some unrelated test could otherwise be picked up as this
   * repo's coverage and quietly break the "carries null" case below.
   */
  const clearCoverage = (): void => {
    for (const key of Array.from(H.files.keys())) {
      if (/lcov|coverage|clover|jacoco|\.out$|\.cov$/i.test(key)) H.files.delete(key)
    }
  }

  it('refuses a path that escapes the repository, and reads nothing to decide it', async () => {
    clearCoverage()
    seed(LCOV, 'SF:src/a.ts\nDA:1,1\nend_of_record\n')
    H.fs.readFileSync.mockClear()

    const r = await invoke('coverage:for-file', { cwd: REPO, file: '../../secrets.ts' })

    expect(r.success).toBe(false)
    expect(r.error).toBe('Path escapes the repository')
    // Order matters as much as the verdict: refusing only after reading would still
    // have read the file it was refusing to serve.
    expect(H.fs.readFileSync).not.toHaveBeenCalled()
  })

  it('answers with the coverage the artifact records for that one file', async () => {
    clearCoverage()
    seed(
      LCOV,
      ['SF:src/a.ts', 'DA:1,4', 'DA:2,0', 'end_of_record', 'SF:src/b.ts', 'DA:9,7', 'end_of_record', ''].join('\n'),
    )

    const r = await invoke('coverage:for-file', { cwd: REPO, file: 'src/a.ts' })

    expect(r.success).toBe(true)
    expect(r.data.lines).toEqual({ 1: 4, 2: 0 })
    // A second record in the same artifact must not bleed into this file's answer.
    expect(r.data.lines[9]).toBeUndefined()
    expect(r.data.stale).toBe(false)
  })

  it('serves a .NET repo whose only artifact is Cobertura, not lcov', async () => {
    clearCoverage()
    // coverlet's DEFAULT output, at coverlet's default name. This is the end-to-end proof
    // that the handler is no longer JS-only: nothing named lcov exists anywhere here.
    seed(
      '/repo/coverage.cobertura.xml',
      [
        '<?xml version="1.0"?>',
        '<coverage line-rate="0.5" version="1.9">',
        '<packages><package name="App"><classes>',
        '<class name="App.A" filename="src/a.ts">',
        '<lines><line number="1" hits="4"/><line number="2" hits="0"/></lines>',
        '</class></classes></package></packages>',
        '</coverage>',
      ].join('\n'),
    )

    const r = await invoke('coverage:for-file', { cwd: REPO, file: 'src/a.ts' })

    expect(r.success).toBe(true)
    expect(r.data.format).toBe('cobertura')
    expect(r.data.lines).toEqual({ 1: 4, 2: 0 })
  })

  it('treats a repo that never produced any coverage artifact as success carrying null, not an error', async () => {
    clearCoverage()

    const r = await invoke('coverage:for-file', { cwd: REPO, file: 'src/a.ts' })

    // The distinction the diff view is built on: null renders no percentage at all,
    // where an error envelope would surface to the user as a failure.
    expect(r.success).toBe(true)
    expect(r.data).toBeNull()
  })

  it('turns a throw into an error envelope rather than a rejected promise', async () => {
    clearCoverage()
    // A non-string cwd makes path.resolve throw inside the guard — the one route into
    // the catch, and the one the renderer would otherwise never be told about.
    const r = await invoke('coverage:for-file', { cwd: undefined, file: 'src/a.ts' })

    expect(r.success).toBe(false)
    expect(typeof r.error).toBe('string')
    expect(r.error.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// git:unpushed / git:commit-diff — the rail's Unpushed section
//
// The sidebar dot counts `ahead` as outstanding work, so a clean-but-ahead repo pulsed
// amber while the rail reported "Nothing changed — the working tree is clean." These two
// channels are what give that pulse a row to open. The parsing is unit-tested in
// gitChanges.test.ts; what is pinned here is the wiring: which argv runs, and what each
// failure mode hands back.
// ---------------------------------------------------------------------------

/** One commit exactly as `--format=%H%x1f%h%x1f%s%x1f%ar%x00` writes it. */
const logRec = (sha: string, short: string, subject: string, when: string) =>
  `${sha}\x1f${short}\x1f${subject}\x1f${when}\0`

describe('git:unpushed', () => {
  beforeEach(() => { H.execFile.mockClear() })

  it('lists the commits the upstream does not have', async () => {
    gitAsync(() => logRec('a'.repeat(40), 'aaaaaaa', 'fix: the dot lied', '2 hours ago'))
    const r = await invoke('git:unpushed', { cwd: '/repo' })
    expect(r.success).toBe(true)
    expect(r.data).toEqual([{
      sha: 'a'.repeat(40),
      shortSha: 'aaaaaaa',
      subject: 'fix: the dot lied',
      relativeDate: '2 hours ago',
    }])
  })

  it('asks for exactly the range the dot counts, and caps how much it will list', async () => {
    gitAsync(() => '')
    await invoke('git:unpushed', { cwd: '/repo' })
    const argv = H.execFile.mock.calls[0][1] as string[]
    expect(argv[0]).toBe('log')
    // The same range `git status` derives `ahead` from — anything else and the rail
    // would list a different set of commits than the one that made the dot pulse.
    expect(argv).toContain('@{upstream}..HEAD')
    expect(argv).toContain('--max-count=50')
  })

  it('runs off the async path, so a slow spawn cannot stall the PTY pump', async () => {
    gitAsync(() => '')
    await invoke('git:unpushed', { cwd: '/repo' })
    expect(H.execFileSync).not.toHaveBeenCalled()
  })

  it('reports no upstream as an empty list, not an error the rail would paint red', async () => {
    // `@{upstream}` fails outright on a branch that tracks nothing — the ordinary state
    // of a local-only branch, and not something to shout about on a 3-second poll.
    gitAsync(() => new Error("fatal: no upstream configured for branch 'main'"))
    const r = await invoke('git:unpushed', { cwd: '/repo' })
    expect(r.success).toBe(true)
    expect(r.data).toEqual([])
  })
})

describe('git:commit-diff', () => {
  beforeEach(() => { H.execFile.mockClear() })

  const SHA = 'a'.repeat(40)

  it('shows the patch for the one commit that was clicked', async () => {
    gitAsync(() => 'diff --git a/a.ts b/a.ts\n')
    const r = await invoke('git:commit-diff', { cwd: '/repo', sha: SHA })
    expect(r.success).toBe(true)
    expect(r.data).toContain('diff --git')
    // `--format=` drops the commit header, leaving a pure patch for parseUnifiedDiff.
    expect(gitAsyncCalls()).toEqual([`show --format= --patch --no-color ${SHA}`])
  })

  it('refuses a sha that is not one, and spawns nothing to decide it', async () => {
    // The sha arrives from the renderer. Every legitimate value came from git one poll
    // earlier, which is exactly why the illegitimate one has to be refused here.
    const r = await invoke('git:commit-diff', { cwd: '/repo', sha: '--upload-pack=evil' })
    expect(r.success).toBe(false)
    expect(r.error).toContain('Invalid SHA')
    expect(H.execFile).not.toHaveBeenCalled()
  })

  it('refuses a range, which would show far more than the row that was clicked', async () => {
    const r = await invoke('git:commit-diff', { cwd: '/repo', sha: 'HEAD~5..HEAD' })
    expect(r.success).toBe(false)
    expect(H.execFile).not.toHaveBeenCalled()
  })

  it('returns an error envelope when git itself fails', async () => {
    gitAsync(() => new Error('fatal: bad object'))
    const r = await invoke('git:commit-diff', { cwd: '/repo', sha: SHA })
    expect(r.success).toBe(false)
    expect(r.error).toContain('bad object')
  })
})

// =========================================================================
// outcome grounding — the brain learns from being WRONG, not only from being told
// =========================================================================
// Both halves of this have shipped for several releases and were never connected: a red test run
// reached recordWorkOutcome (competence only), and memoryFeedback could demote a memory (manual
// call only). Nothing remembered WHICH memories were recalled into the work that failed, so the
// brain could only ever learn from an agent explicitly reporting a bad memory — which in practice
// never happens.
describe('outcome grounding — a work outcome reaches the memories that informed it', () => {
  beforeEach(() => {
    ledger.resetRecallLedger()
    vi.mocked(memClient.memoryFeedback).mockClear()
    vi.mocked(memClient.memoryFeedback).mockResolvedValue({ id: 'm', used: 1 })
  })

  it('demotes the memories recalled into the project when its tests go red', async () => {
    ledger.noteRecall('trusted', ['m1', 'm2'], Date.now())
    H.execSync.mockImplementation(() => { const e: NodeJS.ErrnoException & { status?: number } = new Error('boom'); e.status = 1; throw e })
    H.execFileSync.mockImplementation(() => { const e: NodeJS.ErrnoException & { status?: number } = new Error('boom'); e.status = 1; throw e })
    const failed: NodeJS.ErrnoException = Object.assign(new Error('boom'), { code: 1 })
    shell(failed)

    await invoke('swarm:run-command', { cwd: '/trusted', command: 'npm test' })

    expect(vi.mocked(memClient.memoryFeedback)).toHaveBeenCalledWith({ id: 'm1', helpful: false })
    expect(vi.mocked(memClient.memoryFeedback)).toHaveBeenCalledWith({ id: 'm2', helpful: false })
  })

  it('reinforces them when the same work goes green', async () => {
    ledger.noteRecall('trusted', ['m1'], Date.now())
    H.execSync.mockReturnValue(Buffer.from('2 passed'))
    H.execFileSync.mockReturnValue(Buffer.from('2 passed'))
    shell('2 passed')

    await invoke('swarm:run-command', { cwd: '/trusted', command: 'npm test' })

    expect(vi.mocked(memClient.memoryFeedback)).toHaveBeenCalledWith({ id: 'm1', helpful: true })
  })

  it('never charges a memory recalled into a DIFFERENT project', async () => {
    ledger.noteRecall('elsewhere', ['other'], Date.now())
    H.execSync.mockReturnValue(Buffer.from('ok'))
    H.execFileSync.mockReturnValue(Buffer.from('ok'))
    shell('ok')

    await invoke('swarm:run-command', { cwd: '/trusted', command: 'npm test' })

    expect(vi.mocked(memClient.memoryFeedback)).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'other' }))
  })

  it('charges a recall once, so a rerun does not bank a second vote', async () => {
    ledger.noteRecall('trusted', ['m1'], Date.now())
    H.execSync.mockReturnValue(Buffer.from('ok'))
    H.execFileSync.mockReturnValue(Buffer.from('ok'))
    shell('ok')

    await invoke('swarm:run-command', { cwd: '/trusted', command: 'npm test' })
    vi.mocked(memClient.memoryFeedback).mockClear()
    await invoke('swarm:run-command', { cwd: '/trusted', command: 'npm test' })

    expect(vi.mocked(memClient.memoryFeedback)).not.toHaveBeenCalled()
  })

  it('does not block the command on the feedback write', async () => {
    ledger.noteRecall('trusted', ['m1'], Date.now())
    vi.mocked(memClient.memoryFeedback).mockRejectedValueOnce(new Error('host down'))
    H.execSync.mockReturnValue(Buffer.from('ok'))
    H.execFileSync.mockReturnValue(Buffer.from('ok'))
    shell('ok')

    const r = await invoke('swarm:run-command', { cwd: '/trusted', command: 'npm test' })
    expect(r.success).toBe(true)
  })
})

