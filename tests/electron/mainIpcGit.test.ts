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
  Menu: { setApplicationMenu: vi.fn() },
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
  default: { execSync: H.execSync, execFileSync: H.execFileSync, execFile: H.execFile, spawn: H.spawn },
  execSync: H.execSync,
  execFileSync: H.execFileSync,
  execFile: H.execFile,
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
  spawnTerminal: vi.fn(), killTerminal: vi.fn(), writeToTerminal: vi.fn(),
  resizeTerminal: vi.fn(), killAll: vi.fn(), getTerminalCwd: vi.fn(), getTerminalCwdAsync: vi.fn(async () => ''),
  getTerminalPid: vi.fn(), computeWindowsPty: vi.fn(),
}))
vi.mock('../../src/main/sessionStore', () => ({ loadSession: vi.fn(() => null), saveSession: vi.fn() }))
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

/** Route git by argv (and cwd). Return a string for stdout, or an Error to make that call fail. */
function git(route: (argv: string[], opts: { cwd: string }) => string | Error): void {
  H.execFileSync.mockImplementation((_bin: string, argv: string[], opts: { cwd: string }) => {
    const out = route(argv, opts)
    if (out instanceof Error) throw out
    return Buffer.from(out)
  })
}
/** Route the ASYNC (callback) git — what the POLLED handlers use so a spawn can't block main. */
function gitAsync(route: (argv: string[], opts: { cwd: string }) => string | Error): void {
  H.execFile.mockImplementation(
    (_bin: string, argv: string[], opts: { cwd: string }, cb: (e: Error | null, out: string) => void) => {
      const out = route(argv, opts)
      if (out instanceof Error) cb(out, '')
      else cb(null, out)
    },
  )
}
/** Every git argv the ASYNC path ran, space-joined. */
const gitAsyncCalls = (): string[] => H.execFile.mock.calls.map((c) => (c[1] as string[]).join(' '))
/** Every git argv the handlers ran, in order, space-joined. */
const gitCalls = (): string[] => H.execFileSync.mock.calls.map((c) => (c[1] as string[]).join(' '))
/** Did git run this subcommand (`commit`, `push`, `add`, …)? */
const ranGit = (sub: string): boolean =>
  H.execFileSync.mock.calls.some((c) => (c[1] as string[])[0] === sub)
/** The staged-diff scan the Commit Shield runs before a commit. */
const scannedStagedDiff = (): boolean =>
  H.execFileSync.mock.calls.some((c) => (c[1] as string[]).includes('--cached'))
/** The unpushed-patch scan the Commit Shield runs before a push. */
const scannedPushRange = (): boolean =>
  H.execFileSync.mock.calls.some((c) => (c[1] as string[]).includes('--remotes'))
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

beforeAll(async () => {
  // Real dir for the real (require-based) startup writes — see the USER_DATA note above.
  const realFs = await vi.importActual<typeof import('fs')>('fs')
  realFs.mkdirSync(USER_DATA, { recursive: true })

  vi.resetModules()
  await import('../../src/main/index')
  await new Promise((resolve) => setTimeout(resolve, 50))
})

beforeEach(async () => {
  H.execFileSync.mockReset()
  H.execSync.mockReset()
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

  // Every suite below assumes the shipped default: shield ARMED. Persisting that setting itself
  // writes a file, so the fs/exec spies are cleared AFTER it — each test sees only its own I/O.
  await setShield(true)
  H.execFileSync.mockClear()
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
