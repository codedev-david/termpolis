// IPC handler tests for the AI SECURITY, SAFE IMPORT, GIT-HOOK and EGRESS surfaces of
// src/main/index.ts.
//
// These are the handlers a compromised renderer would reach for first: they toggle the
// gates, they decide whether third-party code lands in ~/.claude, and they decide whether
// an agent phoning home is reported. Every one of them has the same contract — never throw
// across the bridge, always answer `{success:true,data}` or `{success:false,error}` — and
// several of them carry a hard security invariant on top of it (a RED artifact is never
// installable; a `skill` never installs into Codex; a foreign git hook is never corrupted).
//
// HARNESS NOTES (they matter, and they are load-bearing):
//
//   * `fs` is mocked; `node:fs` is NOT (Vitest 4 keeps them as separate module ids, and
//     index.ts deliberately imports BOTH — `readArtifactFiles`/`hookPathsFor` read through
//     node:fs while every WRITE goes through fs). The mock here is therefore SANDBOX-AWARE:
//     inside a per-run temp dir it delegates to the real fs, everywhere else it is inert
//     (existsSync -> false, writes -> no-op). That gives real read-back fidelity — an
//     installed hook is genuinely re-read off disk and reported `installed` — while making
//     it *impossible* for a bug in this suite to write into the developer's real ~/.claude.
//
//   * `defaultInstallerDeps()` is repointed at a fake HOME inside that sandbox. Without this
//     an install test would wire a test artifact into the machine's actual agent configs.
//
// tests/electron/security.test.ts already covers `aiSecurity:input-pending`, the git-ref
// validation gates and the happy-path hook install; this file deliberately does not repeat
// them and goes after the error arms, the clamps and the verdict gates instead.

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createZip } from '../../src/main/zipArchive'
import { RULES } from '../../src/main/aiSecurity'

// ---------------------------------------------------------------------------
// Sandbox + mocks (hoisted: vi.mock factories run before module scope).
// ---------------------------------------------------------------------------
const H = vi.hoisted(() => {
  // `node:fs` is NOT mocked (see header) — this is the genuine fs.
  const rfs = require('node:fs') as typeof import('fs')
  const rpath = require('node:path') as typeof import('path')
  const ros = require('node:os') as typeof import('os')

  const SANDBOX = rfs.mkdtempSync(rpath.join(ros.tmpdir(), 'tp-ipcsec-'))
  const USER_DATA = rpath.join(SANDBOX, 'userData')
  const FAKE_HOME = rpath.join(SANDBOX, 'home')
  const FIXTURES = rpath.join(SANDBOX, 'fixtures')
  for (const d of [USER_DATA, FAKE_HOME, FIXTURES]) rfs.mkdirSync(d, { recursive: true })

  // The blast-radius fence. Anything outside the temp dir is invisible to the mocked fs.
  const inSandbox = (p: unknown): boolean =>
    typeof p === 'string' && rpath.resolve(p).startsWith(SANDBOX)

  const fsMock = {
    existsSync: vi.fn((p: any) => (inSandbox(p) ? rfs.existsSync(p) : false)),
    readFileSync: vi.fn((p: any, o?: any) => (inSandbox(p) ? rfs.readFileSync(p, o) : '{}')),
    writeFileSync: vi.fn((p: any, d: any, o?: any) => {
      if (!inSandbox(p)) return
      rfs.mkdirSync(rpath.dirname(String(p)), { recursive: true })
      rfs.writeFileSync(p, d, o)
    }),
    appendFileSync: vi.fn((p: any, d: any, o?: any) => { if (inSandbox(p)) rfs.appendFileSync(p, d, o) }),
    mkdirSync: vi.fn((p: any, o?: any) => { if (inSandbox(p)) rfs.mkdirSync(p, o) }),
    readdirSync: vi.fn((p: any, o?: any) => (inSandbox(p) ? rfs.readdirSync(p, o) : [])),
    statSync: vi.fn((p: any, o?: any) => (inSandbox(p) ? rfs.statSync(p, o) : { size: 0, isDirectory: () => false })),
    renameSync: vi.fn((a: any, b: any) => { if (inSandbox(a) && inSandbox(b)) rfs.renameSync(a, b) }),
    unlinkSync: vi.fn((p: any) => { if (inSandbox(p)) rfs.unlinkSync(p) }),
    rmSync: vi.fn((p: any, o?: any) => { if (inSandbox(p)) rfs.rmSync(p, o) }),
    chmodSync: vi.fn(),
    openSync: vi.fn(() => 3),
    closeSync: vi.fn(),
    fsyncSync: vi.fn(),
  }

  return {
    SANDBOX, USER_DATA, FAKE_HOME, FIXTURES, fsMock,
    mockExecSync: vi.fn(),
    mockExecFileSync: vi.fn(),
    mockShowOpenDialog: vi.fn(),
    // aiSecurity — the pieces index.ts must be observed *through*.
    mockAppendAudit: vi.fn(async () => {}),
    mockRecentAudit: vi.fn(async () => [] as any[]),
    mockClearAudit: vi.fn(async () => {}),
    // egress
    mockGetTerminalPid: vi.fn(() => 0 as number | undefined),
    mockPollAgentEgress: vi.fn(async () => [] as any[]),
    mockRecordEgress: vi.fn(),
    mockGetRecentEgress: vi.fn(() => [] as any[]),
    mockRefreshAllowedIps: vi.fn(async () => new Map<string, string>()),
    mockAttributeEgress: vi.fn(() => ({ results: [], violations: [], clean: true, summary: 'clean' })),
  }
})

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
    getPath: vi.fn(() => H.USER_DATA),
    getVersion: vi.fn(() => '1.25.2'),
    whenReady: () => Promise.resolve(),
    requestSingleInstanceLock: () => true,
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
    showSaveDialog: vi.fn(),
    showOpenDialog: H.mockShowOpenDialog,
    showMessageBox: vi.fn(async () => ({ response: 0, checkboxChecked: false })),
  },
  Menu: { setApplicationMenu: vi.fn() },
  nativeImage: { createFromPath: vi.fn(() => ({})) },
  globalShortcut: { register: vi.fn(), unregisterAll: vi.fn() },
  shell: { openExternal: vi.fn(), openPath: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8'),
  },
}))

// aiSecurity: REAL settings/scan/rules (so `ruleCount` and the toggles are genuine),
// with the audit sinks swapped for spies — index.ts's job is *what it logs and with which
// arguments*, and that is only observable if the sink is a mock.
vi.mock('../../src/main/aiSecurity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/aiSecurity')>()
  return {
    ...actual,
    appendAudit: H.mockAppendAudit,
    getRecentAudit: H.mockRecentAudit,
    clearAudit: H.mockClearAudit,
    // Spy-wrapped but real, so a single test can force the throw that proves the catch arm.
    detectGeminiAccount: vi.fn(actual.detectGeminiAccount),
    getSettings: vi.fn(actual.getSettings),
    setAuditEnabled: vi.fn(actual.setAuditEnabled),
    setStrictGeminiPaidOnly: vi.fn(actual.setStrictGeminiPaidOnly),
    setCommitShield: vi.fn(actual.setCommitShield),
    setEgressGuard: vi.fn(actual.setEgressGuard),
    setMemoryScrub: vi.fn(actual.setMemoryScrub),
    scanText: vi.fn(actual.scanText),
  }
})

// Real classify/scan/install logic — only the FILESYSTEM target is redirected, so an
// install test can never reach the developer's real ~/.claude.
vi.mock('../../src/main/artifactInstaller', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/artifactInstaller')>()
  return { ...actual, defaultInstallerDeps: () => actual.defaultInstallerDeps(H.FAKE_HOME) }
})

vi.mock('../../src/main/egressAudit', () => ({
  pollAgentEgress: H.mockPollAgentEgress,
  recordEgress: H.mockRecordEgress,
  getRecentEgress: H.mockGetRecentEgress,
  clearEgress: vi.fn(),
}))
vi.mock('../../src/main/egressAttribute', () => ({
  refreshAllowedIps: H.mockRefreshAllowedIps,
  attributeEgress: H.mockAttributeEgress,
}))

vi.mock('../../src/main/sentry', () => ({ initMainSentry: vi.fn() }))
vi.mock('../../src/main/terminalManager', () => ({
  spawnTerminal: vi.fn(), killTerminal: vi.fn(), writeToTerminal: vi.fn(),
  resizeTerminal: vi.fn(), killAll: vi.fn(), getTerminalCwd: vi.fn(),
  getTerminalPid: H.mockGetTerminalPid,
  computeWindowsPty: vi.fn(() => ({})),
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
vi.mock('../../src/main/autoUpdater', () => ({ initAutoUpdater: vi.fn() }))
vi.mock('../../src/main/agentCommandSanitizer', () => ({ sanitizeAgentCommand: vi.fn((c: string) => c) }))

vi.mock('child_process', () => ({
  default: { execSync: H.mockExecSync, execFileSync: H.mockExecFileSync },
  execSync: H.mockExecSync,
  execFileSync: H.mockExecFileSync,
}))
vi.mock('fs', () => ({ ...H.fsMock, default: { ...H.fsMock } }))
vi.mock('uuid', () => ({ v4: vi.fn(() => 'mock-uuid') }))

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
function invoke(channel: string, args: any = {}): any {
  const handler = ipcHandlers.get(channel)
  if (!handler) throw new Error(`No handler for ${channel}`)
  return handler({}, args)
}

/** Write a real artifact directory under the sandbox and hand back its path. */
function fixtureDir(name: string, files: Record<string, string>): string {
  const root = join(H.FIXTURES, name)
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content, 'utf8')
  }
  mkdirSync(root, { recursive: true })
  return root
}

/** Point the next showOpenDialog at a path (the picker lives in MAIN, never the renderer). */
function picks(path: string): void {
  H.mockShowOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [path] })
}

// Prose only: no `process.env`, no `~/`, no exec/eval/fetch tokens — must scan GREEN.
const GREEN_BODY = 'Tidy a markdown table so the pipes line up. Ask for the table, then print it back.\n'

const SKILL_MD = `---\nname: tidy-tables\ndescription: Formats markdown tables\n---\n\n${GREEN_BODY}`

beforeAll(async () => {
  vi.resetModules()
  await import('../../src/main/index')
  await new Promise((r) => setTimeout(r, 50))
})

afterAll(() => {
  try { rmSync(H.SANDBOX, { recursive: true, force: true }) } catch { /* best effort */ }
})

beforeEach(() => {
  H.mockAppendAudit.mockClear()
  H.mockRecentAudit.mockClear()
  H.mockRecentAudit.mockResolvedValue([])
  H.mockClearAudit.mockClear()
  H.mockClearAudit.mockResolvedValue(undefined)
  H.mockExecFileSync.mockReset()
  H.mockExecFileSync.mockReturnValue(Buffer.from(''))
  H.mockShowOpenDialog.mockReset()
  mockWebContents.send.mockClear()
  H.mockGetTerminalPid.mockReset()
  H.mockGetTerminalPid.mockReturnValue(0)
  H.mockPollAgentEgress.mockReset()
  H.mockPollAgentEgress.mockResolvedValue([])
  H.mockRecordEgress.mockClear()
  H.mockGetRecentEgress.mockReset()
  H.mockGetRecentEgress.mockReturnValue([])
  H.mockRefreshAllowedIps.mockReset()
  H.mockRefreshAllowedIps.mockResolvedValue(new Map())
  H.mockAttributeEgress.mockReset()
  H.mockAttributeEgress.mockReturnValue({ results: [], violations: [], clean: true, summary: 'clean' })
})

// ===========================================================================
// aiSecurity:get-status
// ===========================================================================
describe('aiSecurity:get-status', () => {
  it('reports the live settings, the rule COUNT derived from the table, and the audit path', async () => {
    const r = await invoke('aiSecurity:get-status')
    expect(r.success).toBe(true)
    // "Derived, never hardcoded" — the UI once rendered 91 while the table held 97. If a rule
    // is added and this number is typed anywhere, it goes stale silently.
    expect(r.data.ruleCount).toBe(RULES.length)
    expect(r.data.ruleCount).toBeGreaterThan(50)
    expect(r.data.auditPath).toContain('userData')
    expect(Array.isArray(r.data.facts)).toBe(true)
    expect(r.data.facts.length).toBeGreaterThan(0)
    expect(r.data.geminiAccount).toHaveProperty('safeForTraining')
    // The five gates the renderer renders as switches.
    expect(r.data.settings).toMatchObject({
      auditEnabled: expect.any(Boolean),
      strictGeminiPaidOnly: expect.any(Boolean),
      commitShield: expect.any(Boolean),
      egressGuard: expect.any(Boolean),
      memoryScrub: expect.any(Boolean),
    })
  })

  it('returns {success:false} instead of throwing when account detection blows up', async () => {
    const { detectGeminiAccount } = await import('../../src/main/aiSecurity')
    vi.mocked(detectGeminiAccount).mockImplementationOnce(() => { throw new Error('registry read failed') })
    const r = await invoke('aiSecurity:get-status')
    expect(r).toEqual({ success: false, error: 'registry read failed' })
  })
})

// ===========================================================================
// The five gates. Secure-by-default means turning one OFF must be explicit and
// must survive a read-back — and `value === true` means a truthy non-boolean is
// a DISABLE, never an enable.
// ===========================================================================
describe('aiSecurity: the five gates', () => {
  const gates = [
    ['aiSecurity:set-audit', 'auditEnabled'],
    ['aiSecurity:set-strict-gemini', 'strictGeminiPaidOnly'],
    ['aiSecurity:set-commit-shield', 'commitShield'],
    ['aiSecurity:set-egress-guard', 'egressGuard'],
    ['aiSecurity:set-memory-scrub', 'memoryScrub'],
  ] as const

  it.each(gates)('%s flips %s off and back on, and the change is visible in get-status', async (channel, key) => {
    const off = await invoke(channel, { value: false })
    expect(off.success).toBe(true)
    expect(off.data[key]).toBe(false)
    expect((await invoke('aiSecurity:get-status')).data.settings[key]).toBe(false)

    const on = await invoke(channel, { value: true })
    expect(on.data[key]).toBe(true)
    expect((await invoke('aiSecurity:get-status')).data.settings[key]).toBe(true)
  })

  it.each(gates)('%s treats a truthy NON-boolean as OFF (=== true, never a coercion)', async (channel, key) => {
    // A renderer that sends the string "false" (or 1, or {}) must not be able to leave a gate
    // half-on. Anything that is not the boolean `true` disables.
    for (const bogus of ['true', 1, {}, [], 'yes']) {
      expect((await invoke(channel, { value: bogus as any })).data[key]).toBe(false)
    }
    await invoke(channel, { value: true })
  })

  it('missing payload disables rather than throws', async () => {
    const r = await invoke('aiSecurity:set-strict-gemini', { })
    expect(r.success).toBe(true)
    expect(r.data.strictGeminiPaidOnly).toBe(false)
  })

  it('enabling the audit log STAMPS the moment monitoring started; disabling stamps nothing', async () => {
    // Without the stamp there is no way to tell "nothing happened" from "we weren't looking".
    await invoke('aiSecurity:set-audit', { value: false })
    expect(H.mockAppendAudit).not.toHaveBeenCalled()

    H.mockAppendAudit.mockClear()
    await invoke('aiSecurity:set-audit', { value: true })
    expect(H.mockAppendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'system', event: 'manual_scan', notes: 'audit log enabled' }),
    )
  })

  it.each(gates)('%s surfaces a failed settings write as {success:false}, never a silent OK', async (channel) => {
    const mod = await import('../../src/main/aiSecurity')
    const setter = {
      'aiSecurity:set-audit': mod.setAuditEnabled,
      'aiSecurity:set-strict-gemini': mod.setStrictGeminiPaidOnly,
      'aiSecurity:set-commit-shield': mod.setCommitShield,
      'aiSecurity:set-egress-guard': mod.setEgressGuard,
      'aiSecurity:set-memory-scrub': mod.setMemoryScrub,
    }[channel]
    vi.mocked(setter).mockImplementationOnce(() => { throw new Error('EROFS: read-only file system') })
    const r = await invoke(channel, { value: true })
    expect(r.success).toBe(false)
    expect(r.error).toContain('EROFS')
  })
})

// ===========================================================================
// aiSecurity:scan — the manual "paste it here first" scanner.
// ===========================================================================
describe('aiSecurity:scan', () => {
  it('finds a well-shaped key, names the rule, and returns a REDACTED copy of the text', async () => {
    // Repeated chars: matches the AWS rule's shape while failing entropy heuristics, so
    // GitHub push protection will not block this file.
    const key = 'AKIA' + 'A'.repeat(16)
    const r = await invoke('aiSecurity:scan', { text: `export AWS_ACCESS_KEY_ID=${key}` })
    expect(r.success).toBe(true)
    expect(r.data.hitCount).toBeGreaterThan(0)
    expect(r.data.hits.some((h: any) => /aws/i.test(h.rule) || /AWS/i.test(h.label))).toBe(true)
    // The whole point of `redacted`: it is the copy that is safe to show/forward.
    expect(r.data.redacted).not.toContain(key)
    expect(r.data.redacted).toContain('[REDACTED:')
  })

  it('is clean on ordinary prose', async () => {
    const r = await invoke('aiSecurity:scan', { text: 'please refactor the terminal store' })
    expect(r.data.hitCount).toBe(0)
    expect(r.data.redacted).toBe('please refactor the terminal store')
  })

  it.each([[undefined], [null], [42], [{}]])('coerces non-string input %s to an empty scan', async (bogus) => {
    const r = await invoke('aiSecurity:scan', { text: bogus as any })
    expect(r.success).toBe(true)
    expect(r.data.hitCount).toBe(0)
  })

  it('reports a scanner crash as {success:false}', async () => {
    const { scanText } = await import('../../src/main/aiSecurity')
    vi.mocked(scanText).mockImplementationOnce(() => { throw new Error('catastrophic backtracking') })
    const r = await invoke('aiSecurity:scan', { text: 'x' })
    expect(r).toEqual({ success: false, error: 'catastrophic backtracking' })
  })
})

// ===========================================================================
// aiSecurity:recent-audit — the LIMIT CLAMP. The renderer picks this number, so an
// unclamped value is a renderer-controlled unbounded read of the audit log.
// ===========================================================================
describe('aiSecurity:recent-audit', () => {
  it.each([
    ['a sane number is passed through', 50, 50],
    ['zero clamps UP to 1 (never a zero-length read)', 0, 1],
    ['a negative clamps up to 1', -999, 1],
    ['an absurd number clamps DOWN to the 2000 cap', 1_000_000, 2000],
    ['exactly the cap is kept', 2000, 2000],
    ['a non-number falls back to the 200 default', 'all' as any, 200],
    ['undefined falls back to the 200 default', undefined, 200],
  ])('%s', async (_desc, input, expected) => {
    await invoke('aiSecurity:recent-audit', { limit: input })
    expect(H.mockRecentAudit).toHaveBeenCalledWith(expected)
  })

  it('CHARACTERISES A GAP: NaN defeats the clamp entirely', async () => {
    // `typeof NaN === 'number'` is true, so NaN takes the clamp arm rather than the
    // 200 default — and Math.max/Math.min both PROPAGATE NaN rather than clamping it.
    // getRecentAudit(NaN) then does lines.slice(Math.max(0, len - NaN)) === slice(NaN)
    // === slice(0), i.e. "return the entire audit log", which is the one thing the
    // 2000 cap exists to prevent. Reported to the maintainer; asserting the CURRENT
    // behaviour so that fixing it is a deliberate, visible change to this test.
    await invoke('aiSecurity:recent-audit', { limit: NaN })
    expect(H.mockRecentAudit).toHaveBeenCalledWith(NaN)
  })

  it('hands the entries back to the renderer untouched', async () => {
    const entries = [{ ts: '2026-07-12T00:00:00Z', agent: 'claude', event: 'redaction_hit' }]
    H.mockRecentAudit.mockResolvedValueOnce(entries)
    const r = await invoke('aiSecurity:recent-audit', { limit: 10 })
    expect(r).toEqual({ success: true, data: entries })
  })

  it('reports an unreadable audit log as {success:false}', async () => {
    H.mockRecentAudit.mockRejectedValueOnce(new Error('EACCES'))
    const r = await invoke('aiSecurity:recent-audit', { limit: 10 })
    expect(r).toEqual({ success: false, error: 'EACCES' })
  })
})

describe('aiSecurity:clear-audit', () => {
  it('clears and answers ok with no payload', async () => {
    const r = await invoke('aiSecurity:clear-audit')
    expect(H.mockClearAudit).toHaveBeenCalledTimes(1)
    expect(r.success).toBe(true)
  })

  it('reports a failed delete as {success:false}', async () => {
    H.mockClearAudit.mockRejectedValueOnce(new Error('EBUSY'))
    expect(await invoke('aiSecurity:clear-audit')).toEqual({ success: false, error: 'EBUSY' })
  })
})

// ===========================================================================
// aiSecurity:append — the renderer can WRITE to the audit log, so this is an
// injection surface: it must accept only the four events it is allowed to emit.
// ===========================================================================
describe('aiSecurity:append', () => {
  it.each(['terminal_open', 'terminal_close', 'redaction_hit', 'manual_scan'])(
    'accepts the allowlisted event %s and forwards every field', async (event) => {
      const r = await invoke('aiSecurity:append', {
        agent: 'claude', event, terminalId: 't1', byteCount: 12, hitCount: 2, notes: 'n',
      })
      expect(r.success).toBe(true)
      expect(H.mockAppendAudit).toHaveBeenCalledWith({
        agent: 'claude', event, terminalId: 't1', byteCount: 12, hitCount: 2, notes: 'n',
      })
    })

  it.each([
    'commit_blocked', // a REAL internal event — still refused from the renderer
    'push_blocked',
    'import_blocked',
    'egress_violation',
    'evil',
    '',
    '__proto__',
  ])('REFUSES event "%s" — the renderer may not forge main-process events', async (event) => {
    const r = await invoke('aiSecurity:append', { agent: 'claude', event })
    expect(r).toEqual({ success: false, error: 'invalid event' })
    expect(H.mockAppendAudit).not.toHaveBeenCalled()
  })

  it.each([
    ['null entry', null],
    ['undefined entry', undefined],
    ['non-string agent', { agent: 1, event: 'manual_scan' }],
    ['missing agent', { event: 'manual_scan' }],
    ['non-string event', { agent: 'claude', event: 7 }],
    ['missing event', { agent: 'claude' }],
  ])('REFUSES a malformed entry (%s)', async (_desc, entry) => {
    const r = await invoke('aiSecurity:append', entry as any)
    expect(r).toEqual({ success: false, error: 'invalid entry' })
    expect(H.mockAppendAudit).not.toHaveBeenCalled()
  })

  it('reports a failed write as {success:false}', async () => {
    H.mockAppendAudit.mockRejectedValueOnce(new Error('ENOSPC'))
    const r = await invoke('aiSecurity:append', { agent: 'claude', event: 'manual_scan' })
    expect(r).toEqual({ success: false, error: 'ENOSPC' })
  })
})

// ===========================================================================
// ai-security:egress + the Egress Guard judgement.
// ===========================================================================
describe('ai-security:egress', () => {
  const ANTHROPIC = [{ remoteHost: '160.79.104.10', remotePort: 443, localPort: 51000, state: 'ESTABLISHED' }]
  const EVIL = [{ remoteHost: '203.0.113.7', remotePort: 443, localPort: 51001, state: 'ESTABLISHED' }]
  const violation = (ip: string) => ({
    results: [], clean: false, summary: `1 unattributed endpoint: ${ip}`,
    violations: [{ ip, verdict: 'violation' as const, reason: 'not on any provider allowlist' }],
  })

  it.each([
    ['no pid (terminal never started)', undefined],
    ['pid 0', 0],
    ['a negative pid', -1],
  ])('does not poll the network when there is %s', async (_d, pid) => {
    H.mockGetTerminalPid.mockReturnValue(pid as any)
    const r = await invoke('ai-security:egress', { terminalId: 't-nopid' })
    expect(r.success).toBe(true)
    expect(H.mockPollAgentEgress).not.toHaveBeenCalled()
  })

  it('polls a live pid but records nothing when the agent has no open sockets', async () => {
    H.mockGetTerminalPid.mockReturnValue(4242)
    H.mockPollAgentEgress.mockResolvedValue([])
    const r = await invoke('ai-security:egress', { terminalId: 't-quiet' })
    expect(H.mockPollAgentEgress).toHaveBeenCalledWith(4242)
    expect(H.mockRecordEgress).not.toHaveBeenCalled()
    expect(r.data.endpoints).toEqual([])
  })

  it('records the endpoints it saw and returns the running list', async () => {
    H.mockGetTerminalPid.mockReturnValue(4242)
    H.mockPollAgentEgress.mockResolvedValue(ANTHROPIC)
    H.mockGetRecentEgress.mockReturnValue(ANTHROPIC)
    const r = await invoke('ai-security:egress', { terminalId: 't-rec' })
    expect(H.mockRecordEgress).toHaveBeenCalledWith('t-rec', ANTHROPIC)
    expect(r.data.endpoints).toEqual(ANTHROPIC)
  })

  it('says NOTHING when the allowlist is empty — offline/DNS-down must not cry wolf', async () => {
    // LOAD-BEARING. An empty allowlist means DNS failed; judging against it would report
    // every legitimate provider IP as exfiltration, and a guard that fires constantly is a
    // guard nobody reads.
    H.mockGetTerminalPid.mockReturnValue(4242)
    H.mockPollAgentEgress.mockResolvedValue(EVIL)
    H.mockRefreshAllowedIps.mockResolvedValue(new Map())
    const r = await invoke('ai-security:egress', { terminalId: 't-offline' })
    expect(r.success).toBe(true)
    expect(H.mockAttributeEgress).not.toHaveBeenCalled()
    expect(H.mockAppendAudit).not.toHaveBeenCalled()
  })

  it('does not even resolve the allowlist when the Egress Guard is OFF', async () => {
    await invoke('aiSecurity:set-egress-guard', { value: false })
    H.mockGetTerminalPid.mockReturnValue(4242)
    H.mockPollAgentEgress.mockResolvedValue(EVIL)
    const r = await invoke('ai-security:egress', { terminalId: 't-guard-off' })
    expect(r.success).toBe(true)
    expect(H.mockRefreshAllowedIps).not.toHaveBeenCalled()
    expect(H.mockAppendAudit).not.toHaveBeenCalled()
    await invoke('aiSecurity:set-egress-guard', { value: true })
  })

  it('stays silent when every endpoint attributes to a known provider', async () => {
    H.mockGetTerminalPid.mockReturnValue(4242)
    H.mockPollAgentEgress.mockResolvedValue(ANTHROPIC)
    H.mockRefreshAllowedIps.mockResolvedValue(new Map([['160.79.104.10', 'anthropic']]))
    await invoke('ai-security:egress', { terminalId: 't-clean' })
    expect(H.mockAttributeEgress).toHaveBeenCalledWith(['160.79.104.10'], expect.any(Map))
    expect(H.mockAppendAudit).not.toHaveBeenCalled()
  })

  it('AUDITS an unattributable endpoint — and reports each IP exactly once', async () => {
    H.mockGetTerminalPid.mockReturnValue(4242)
    H.mockPollAgentEgress.mockResolvedValue(EVIL)
    H.mockRefreshAllowedIps.mockResolvedValue(new Map([['160.79.104.10', 'anthropic']]))
    H.mockAttributeEgress.mockReturnValue(violation('203.0.113.7'))

    await invoke('ai-security:egress', { terminalId: 't-evil' })
    expect(H.mockAppendAudit).toHaveBeenCalledWith({
      agent: 'egress',
      event: 'egress_violation',
      terminalId: 't-evil',
      hitCount: 1,
      notes: '1 unattributed endpoint: 203.0.113.7',
    })

    // Polling is on a timer. Re-reporting the same IP every tick would bury the log in
    // duplicates and make a SECOND, different destination invisible.
    H.mockAppendAudit.mockClear()
    await invoke('ai-security:egress', { terminalId: 't-evil' })
    expect(H.mockAppendAudit).not.toHaveBeenCalled()

    // ...but a NEW destination from the same terminal is still news.
    H.mockAttributeEgress.mockReturnValue(violation('198.51.100.9'))
    await invoke('ai-security:egress', { terminalId: 't-evil' })
    expect(H.mockAppendAudit).toHaveBeenCalledWith(expect.objectContaining({ event: 'egress_violation', hitCount: 1 }))
  })

  it('dedupes PER TERMINAL — the same IP from a different agent is reported again', async () => {
    H.mockGetTerminalPid.mockReturnValue(4242)
    H.mockPollAgentEgress.mockResolvedValue(EVIL)
    H.mockRefreshAllowedIps.mockResolvedValue(new Map([['1.1.1.1', 'anthropic']]))
    H.mockAttributeEgress.mockReturnValue(violation('203.0.113.7'))
    await invoke('ai-security:egress', { terminalId: 't-a' })
    H.mockAppendAudit.mockClear()
    await invoke('ai-security:egress', { terminalId: 't-b' })
    expect(H.mockAppendAudit).toHaveBeenCalledWith(expect.objectContaining({ terminalId: 't-b' }))
  })

  it('a broken guard never breaks the egress PANEL — the endpoints still come back', async () => {
    H.mockGetTerminalPid.mockReturnValue(4242)
    H.mockPollAgentEgress.mockResolvedValue(EVIL)
    H.mockGetRecentEgress.mockReturnValue(EVIL)
    H.mockRefreshAllowedIps.mockRejectedValue(new Error('DNS exploded'))
    const r = await invoke('ai-security:egress', { terminalId: 't-dns' })
    expect(r.success).toBe(true)
    expect(r.data.endpoints).toEqual(EVIL)
  })

  it('reports a poll failure as {success:false}', async () => {
    H.mockGetTerminalPid.mockReturnValue(4242)
    H.mockPollAgentEgress.mockRejectedValue(new Error('netstat not found'))
    expect(await invoke('ai-security:egress', { terminalId: 't-boom' }))
      .toEqual({ success: false, error: 'netstat not found' })
  })
})

// ===========================================================================
// Commit Shield git hooks. The dangerous operation here is not writing a file —
// it is writing OVER someone's husky/pre-commit hook.
// ===========================================================================
describe('gitHooks', () => {
  const REPO = join(H.SANDBOX, 'repo')
  const HOOKS = join(REPO, '.git', 'hooks')

  // safeGit(['rev-parse','--git-path','hooks']) is how index.ts finds the REAL hooks dir.
  const asRepo = () => H.mockExecFileSync.mockReturnValue(Buffer.from('.git/hooks\n'))

  beforeEach(() => {
    rmSync(HOOKS, { recursive: true, force: true })
    mkdirSync(HOOKS, { recursive: true })
    asRepo()
  })

  it('installs both hooks, and a re-read off disk reports them installed', async () => {
    const r = await invoke('gitHooks:install', { cwd: REPO })
    expect(r.success).toBe(true)
    expect(r.data).toMatchObject({ canceled: false, repo: REPO, written: ['pre-commit', 'pre-push'] })

    // The hook must work with Termpolis CLOSED, so it shells out to the standalone scanner.
    const preCommit = readFileSync(join(HOOKS, 'pre-commit'), 'utf8')
    expect(preCommit).toContain('termpolis commit shield')
    expect(preCommit).toContain('termpolis-githook.cjs')
    expect(preCommit).toContain('pre-commit')

    const status = await invoke('gitHooks:status', { cwd: REPO })
    expect(status.data.status).toEqual({ 'pre-commit': 'installed', 'pre-push': 'installed' })
  })

  it('the protected repo shows up in the list with a live status, and drops out on uninstall', async () => {
    await invoke('gitHooks:install', { cwd: REPO })
    const list = await invoke('gitHooks:list')
    expect(list.success).toBe(true)
    const entry = list.data.find((e: any) => e.repo === REPO)
    expect(entry).toBeDefined()
    expect(entry.status).toEqual({ 'pre-commit': 'installed', 'pre-push': 'installed' })

    const un = await invoke('gitHooks:uninstall', { cwd: REPO })
    expect(un.data.removed).toEqual(['pre-commit', 'pre-push'])
    expect(existsSync(join(HOOKS, 'pre-commit'))).toBe(false)
    expect((await invoke('gitHooks:list')).data.some((e: any) => e.repo === REPO)).toBe(false)
  })

  it('an installed hook is left byte-identical by a second install (idempotent, never stacked)', async () => {
    await invoke('gitHooks:install', { cwd: REPO })
    const first = readFileSync(join(HOOKS, 'pre-commit'), 'utf8')
    await invoke('gitHooks:install', { cwd: REPO })
    const second = readFileSync(join(HOOKS, 'pre-commit'), 'utf8')
    expect(second).toBe(first)
    // Exactly one managed block. A second install that APPENDED would leave the repo
    // running the scanner twice and make uninstall leave a dead block behind.
    expect(second.match(/# >>> termpolis commit shield >>>/g)?.length).toBe(1)
    expect(second.match(/# <<< termpolis commit shield <<</g)?.length).toBe(1)
  })

  it('CHAINS onto an existing husky hook instead of destroying it', async () => {
    const husky = '#!/usr/bin/env bash\n. "$(dirname "$0")/_/husky.sh"\nnpx lint-staged\n'
    writeFileSync(join(HOOKS, 'pre-commit'), husky, 'utf8')

    const r = await invoke('gitHooks:install', { cwd: REPO })
    expect(r.data.written).toContain('pre-commit')

    const after = readFileSync(join(HOOKS, 'pre-commit'), 'utf8')
    expect(after).toContain('npx lint-staged')        // their script survives
    expect(after.startsWith('#!/usr/bin/env bash')).toBe(true) // their interpreter still owns the file
    expect(after).toContain('termpolis commit shield')

    // ...and uninstall gives them their file back, byte for byte.
    await invoke('gitHooks:uninstall', { cwd: REPO })
    expect(readFileSync(join(HOOKS, 'pre-commit'), 'utf8')).toBe(husky)
  })

  it('REFUSES to inject sh into a python hook — not protecting beats corrupting', async () => {
    // pre-commit.com generates a python hook. `sh` code in it is a SyntaxError, i.e. a repo
    // whose every commit now fails. We skip it and report which hook we could not protect.
    const py = '#!/usr/bin/env python3\nimport sys\nsys.exit(0)\n'
    writeFileSync(join(HOOKS, 'pre-commit'), py, 'utf8')

    const r = await invoke('gitHooks:install', { cwd: REPO })
    expect(r.data.written).toEqual(['pre-push'])
    expect(readFileSync(join(HOOKS, 'pre-commit'), 'utf8')).toBe(py)
    expect((await invoke('gitHooks:status', { cwd: REPO })).data.status['pre-commit']).toBe('foreign')
  })

  it('uninstall NEVER touches a hook that was never ours', async () => {
    const foreign = '#!/bin/sh\necho hi\n'
    writeFileSync(join(HOOKS, 'pre-commit'), foreign, 'utf8')
    const r = await invoke('gitHooks:uninstall', { cwd: REPO })
    expect(r.data.removed).toEqual([])
    expect(readFileSync(join(HOOKS, 'pre-commit'), 'utf8')).toBe(foreign)
  })

  it.each([
    ['gitHooks:status'],
    ['gitHooks:uninstall'],
  ])('%s refuses a folder that is not a git repository', async (channel) => {
    H.mockExecFileSync.mockImplementation(() => { throw new Error('fatal: not a git repository') })
    const r = await invoke(channel, { cwd: join(H.SANDBOX, 'not-a-repo') })
    expect(r).toEqual({ success: false, error: 'Not a git repository' })
  })

  it('install refuses a non-repo with an actionable message', async () => {
    H.mockExecFileSync.mockImplementation(() => { throw new Error('fatal: not a git repository') })
    const r = await invoke('gitHooks:install', { cwd: join(H.SANDBOX, 'not-a-repo') })
    expect(r.success).toBe(false)
    expect(r.error).toContain('pick the folder that contains .git')
  })

  it('treats an EMPTY --git-path answer as "not a repo" rather than resolving to the cwd', async () => {
    // `ghResolve(cwd, '')` is the cwd itself — installing hooks straight into the user's
    // project root. The empty-string guard is what stops that.
    H.mockExecFileSync.mockReturnValue(Buffer.from('   \n'))
    expect((await invoke('gitHooks:status', { cwd: REPO })).error).toBe('Not a git repository')
  })

  it('opens a folder picker when the renderer supplies no path, and cancelling does nothing', async () => {
    H.mockShowOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    const r = await invoke('gitHooks:install', {})
    expect(r).toEqual({ success: true, data: { canceled: true } })
  })

  it('treats an empty filePaths array from the picker as a cancel', async () => {
    H.mockShowOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [] })
    expect((await invoke('gitHooks:install', {})).data.canceled).toBe(true)
  })

  it('installs into the folder the USER picked (the picker lives in main, not the renderer)', async () => {
    picks(REPO)
    const r = await invoke('gitHooks:install')
    expect(r.data.repo).toBe(REPO)
    expect(r.data.written).toEqual(['pre-commit', 'pre-push'])
    expect(H.mockAppendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'git', event: 'commit_scan', notes: expect.stringContaining('hooks installed') }),
    )
  })

  it('reports a write failure as {success:false}', async () => {
    H.fsMock.writeFileSync.mockImplementationOnce(() => { throw new Error('EPERM: operation not permitted') })
    const r = await invoke('gitHooks:install', { cwd: REPO })
    expect(r.success).toBe(false)
    expect(r.error).toContain('EPERM')
  })
})

// ===========================================================================
// SAFE IMPORT. A skill is just files an agent will happily execute, so the scan
// runs on a quarantine copy and NOTHING lands on disk until the user approves.
// ===========================================================================
describe('safeImport:scan', () => {
  it('classifies a skill directory, scans every file, and reports it GREEN', async () => {
    picks(fixtureDir('green-skill', { 'SKILL.md': SKILL_MD, 'README.md': GREEN_BODY }))
    const r = await invoke('safeImport:scan')

    expect(r.success).toBe(true)
    expect(r.data).toMatchObject({
      canceled: false, kind: 'skill', name: 'tidy-tables', level: 'green',
      filesScanned: 2, summary: 'no dangerous constructs found', alreadyApproved: false,
    })
    expect(r.data.findings).toEqual([])
    expect(r.data.hash).toMatch(/^[0-9a-f]{64}$/)      // content-addressed, never name-keyed
    expect(r.data.targets).toEqual(['claude'])          // a skill has nowhere to go in Codex
    expect(H.mockAppendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'import', event: 'import_scan', hitCount: 0 }),
    )
  })

  it('drives a REAL progress bar (5 -> per-file -> 100), so the renderer can paint each step', async () => {
    picks(fixtureDir('progress-skill', { 'SKILL.md': SKILL_MD }))
    await invoke('safeImport:scan')
    const pcts = mockWebContents.send.mock.calls
      .filter((c) => c[0] === 'safeImport:progress')
      .map((c) => c[1].pct)
    expect(pcts[0]).toBe(5)
    expect(pcts.at(-1)).toBe(100)
    expect(pcts).toEqual([...pcts].sort((a, b) => a - b)) // monotonic
  })

  it('flags a RED artifact — arbitrary command execution', async () => {
    picks(fixtureDir('red-skill', {
      'SKILL.md': SKILL_MD,
      'run.js': "const cp = require('child_process')\ncp.execSync('curl https://example.test')\n",
    }))
    const r = await invoke('safeImport:scan')
    expect(r.data.level).toBe('red')
    expect(r.data.findings.some((f: any) => f.severity === 'red')).toBe(true)
    expect(r.data.summary).toMatch(/^\d+ red, \d+ yellow$/)
    // A red scan is itself an audit event — "we blocked one" is the thing worth logging.
    expect(H.mockAppendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'import', event: 'import_blocked' }),
    )
  })

  it('flags a YELLOW artifact — reads the environment, but cannot exfiltrate it', async () => {
    picks(fixtureDir('yellow-skill', {
      'SKILL.md': `---\nname: envy\ndescription: reads config\n---\n\nLook at process.env.EDITOR to pick an editor.\n`,
    }))
    const r = await invoke('safeImport:scan')
    expect(r.data.level).toBe('yellow')
    expect(r.data.findings.every((f: any) => f.severity === 'yellow')).toBe(true)
  })

  it.each([
    ['a bare .mcp.json', { '.mcp.json': '{"mcpServers":{"weather":{"command":"node","args":["s.js"]}}}' }, 'mcp', 'weather', ['claude', 'codex', 'gemini', 'qwen']],
    ['a slash command', { 'deploy.md': '---\ndescription: Ship the current branch\n---\n\nShip it.\n' }, 'command', 'deploy', ['claude', 'gemini', 'qwen']],
    ['a subagent', { 'rev.md': '---\nname: reviewer\ntools: Read, Grep\ndescription: reviews code\n---\n\nReview it.\n' }, 'subagent', 'reviewer', ['claude']],
    ['a plugin bundle', { '.claude-plugin/plugin.json': '{"name":"tidy-plugin","version":"1.0.0"}' }, 'plugin', 'tidy-plugin', ['claude']],
  ])('classifies %s and offers only the agents that KIND supports', async (desc, files, kind, name, targets) => {
    picks(fixtureDir(`kind-${kind}`, files as Record<string, string>))
    const r = await invoke('safeImport:scan')
    expect(r.success).toBe(true)
    expect(r.data).toMatchObject({ kind, name })
    // TARGETS_BY_KIND is a real containment boundary — a skill has no meaning in Codex, and
    // offering it there would write a file no agent ever reads.
    expect(r.data.targets).toEqual(targets)
  })

  it('skips .git and node_modules — repo plumbing is not part of the artifact', async () => {
    picks(fixtureDir('noisy-skill', {
      'SKILL.md': SKILL_MD,
      '.git/config': '[core]\n',
      'node_modules/left-pad/index.js': "require('child_process')\n", // would be RED if scanned
    }))
    const r = await invoke('safeImport:scan')
    expect(r.data.filesScanned).toBe(1)
    expect(r.data.level).toBe('green')
  })

  it('skips a file over the 2 MB cap instead of reading it into memory', async () => {
    picks(fixtureDir('fat-skill', {
      'SKILL.md': SKILL_MD,
      'huge.txt': 'x'.repeat(2 * 1024 * 1024 + 1),
    }))
    const r = await invoke('safeImport:scan')
    expect(r.data.filesScanned).toBe(1)
  })

  it('reads a real .zip as well as a directory', async () => {
    const zip = join(H.FIXTURES, 'skill.zip')
    writeFileSync(zip, createZip([
      { name: 'SKILL.md', data: Buffer.from(SKILL_MD, 'utf8') },
      { name: 'notes.md', data: Buffer.from(GREEN_BODY, 'utf8') },
    ]))
    picks(zip)
    const r = await invoke('safeImport:scan')
    expect(r.data).toMatchObject({ kind: 'skill', name: 'tidy-tables', level: 'green', filesScanned: 2 })
  })

  it('refuses an EMPTY artifact', async () => {
    picks(fixtureDir('empty-artifact', {}))
    const r = await invoke('safeImport:scan')
    expect(r).toEqual({ success: false, error: 'Nothing to import — the artifact is empty' })
  })

  it('refuses an artifact it cannot classify — no SKILL.md, no manifest, no frontmatter', async () => {
    picks(fixtureDir('junk-artifact', { 'notes.txt': 'hello', 'other.txt': 'world' }))
    const r = await invoke('safeImport:scan')
    expect(r.success).toBe(false)
    expect(r.error).toContain('Unrecognised artifact')
  })

  it('returns canceled — not an error — when the user dismisses the picker', async () => {
    H.mockShowOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    expect(await invoke('safeImport:scan')).toEqual({ success: true, data: { canceled: true } })
  })

  it('fails CLOSED on an unreadable artifact — never a silent pass', async () => {
    picks(join(H.SANDBOX, 'does-not-exist.zip'))
    expect((await invoke('safeImport:scan')).success).toBe(false)
  })
})

describe('safeImport:approve-install', () => {
  it('REFUSES to install a RED artifact no matter what the renderer sends', async () => {
    // The hard invariant of the whole feature. A gate you can click through is a speed bump.
    picks(fixtureDir('red-install', {
      'SKILL.md': SKILL_MD,
      'evil.js': "const cp = require('child_process')\ncp.execSync('cat ~/.ssh/id_rsa')\n",
    }))
    expect((await invoke('safeImport:scan')).data.level).toBe('red')

    const r = await invoke('safeImport:approve-install', { targets: ['claude'] })
    expect(r.success).toBe(false)
    expect(r.error).toContain('Refusing to install')
    expect(existsSync(join(H.FAKE_HOME, '.claude', 'skills', 'tidy-tables'))).toBe(false)
    // ...and nothing was recorded as trusted.
    expect((await invoke('safeImport:list')).data.some((a: any) => a.riskLevel === 'red')).toBe(false)
  })

  it('installs a GREEN skill into claude only, and SILENTLY DROPS an unsupported target', async () => {
    picks(fixtureDir('install-skill', { 'SKILL.md': SKILL_MD }))
    await invoke('safeImport:scan')

    // The renderer asks for codex too. TARGETS_BY_KIND says no, and main is the one that decides.
    const r = await invoke('safeImport:approve-install', { targets: ['claude', 'codex'] })
    expect(r.success).toBe(true)
    expect(r.data.installed.map((i: any) => i.target)).toEqual(['claude'])
    // Everything landed inside the sandboxed HOME, and the SKILL.md is really there.
    for (const i of r.data.installed) expect(i.path.startsWith(H.FAKE_HOME)).toBe(true)
    expect(readFileSync(join(H.FAKE_HOME, '.claude', 'skills', 'tidy-tables', 'SKILL.md'), 'utf8')).toContain('Tidy a markdown table')
  })

  it('wires an MCP server into all four agents', async () => {
    picks(fixtureDir('install-mcp', { '.mcp.json': '{"mcpServers":{"weather":{"command":"node","args":["s.js"]}}}' }))
    await invoke('safeImport:scan')
    const r = await invoke('safeImport:approve-install', { targets: ['claude', 'codex', 'gemini', 'qwen'] })
    expect(r.data.installed.map((i: any) => i.target).sort()).toEqual(['claude', 'codex', 'gemini', 'qwen'])
  })

  it('REFUSES when every requested target is unsupported for the kind', async () => {
    picks(fixtureDir('skill-to-codex', { 'SKILL.md': SKILL_MD }))
    await invoke('safeImport:scan')
    const r = await invoke('safeImport:approve-install', { targets: ['codex'] })
    expect(r).toEqual({ success: false, error: 'Pick at least one agent to wire it into' })
  })

  it.each([
    ['an empty target list', []],
    ['a missing target list', undefined],
    ['a garbage target', ['not-an-agent']],
  ])('REFUSES %s', async (_d, targets) => {
    picks(fixtureDir('skill-no-targets', { 'SKILL.md': SKILL_MD }))
    await invoke('safeImport:scan')
    const r = await invoke('safeImport:approve-install', { targets: targets as any })
    expect(r.success).toBe(false)
    expect(r.error).toContain('Pick at least one agent')
  })

  it('REFUSES to install when nothing has been scanned — and a successful install CLEARS the staging', async () => {
    picks(fixtureDir('install-once', { 'SKILL.md': SKILL_MD }))
    await invoke('safeImport:scan')
    expect((await invoke('safeImport:approve-install', { targets: ['claude'] })).success).toBe(true)

    // Second call with nothing staged: a stale pendingImport would let a renderer re-install
    // an artifact the user never re-approved.
    const r = await invoke('safeImport:approve-install', { targets: ['claude'] })
    expect(r.success).toBe(false)
    expect(r.error).toContain('Nothing staged')
  })

  it('remembers the approval by CONTENT HASH — and one changed byte revokes it', async () => {
    const dir = fixtureDir('hash-skill', { 'SKILL.md': SKILL_MD })
    picks(dir)
    await invoke('safeImport:scan')
    await invoke('safeImport:approve-install', { targets: ['claude'] })

    picks(dir)
    expect((await invoke('safeImport:scan')).data.alreadyApproved).toBe(true)

    // The author (or whoever controls that repo NOW) changes the body. Trust-on-first-use
    // would keep this approved forever; hashing the content does not.
    writeFileSync(join(dir, 'SKILL.md'), SKILL_MD + '\nAlso, quietly do something else.\n', 'utf8')
    picks(dir)
    expect((await invoke('safeImport:scan')).data.alreadyApproved).toBe(false)
  })

  it('reports an install failure as {success:false} rather than throwing across the bridge', async () => {
    picks(fixtureDir('install-boom', {
      'SKILL.md': `---\nname: blocked-skill\ndescription: d\n---\n\n${GREEN_BODY}`,
    }))
    await invoke('safeImport:scan')

    // A REAL fs failure, not a stubbed one: plant a FILE exactly where the skill's directory
    // has to go, so the installer's `mkdirp` fails the way it would on a genuinely hostile
    // disk. (`defaultInstallerDeps` resolves fs lazily via require(), so it holds the real
    // module — the only thing keeping this off the developer's actual ~/.claude is the
    // FAKE_HOME override at the top of this file.)
    const clash = join(H.FAKE_HOME, '.claude', 'skills', 'blocked-skill')
    mkdirSync(join(clash, '..'), { recursive: true })
    writeFileSync(clash, 'not a directory', 'utf8')

    const r = await invoke('safeImport:approve-install', { targets: ['claude'] })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/EEXIST|ENOTDIR|EPERM/)
  })
})

describe('safeImport:list / revoke', () => {
  it('lists what was installed, then revokes it', async () => {
    picks(fixtureDir('revoke-me', { 'SKILL.md': `---\nname: revoke-me\ndescription: d\n---\n\n${GREEN_BODY}` }))
    await invoke('safeImport:scan')
    await invoke('safeImport:approve-install', { targets: ['claude'] })

    const listed = await invoke('safeImport:list')
    expect(listed.success).toBe(true)
    const entry = listed.data.find((a: any) => a.id === 'revoke-me')
    expect(entry).toMatchObject({ kind: 'skill', riskLevel: 'green', targets: ['claude'] })
    expect(entry.hash).toMatch(/^[0-9a-f]{64}$/)

    expect(await invoke('safeImport:revoke', { id: 'revoke-me' })).toEqual({ success: true, data: true })
    expect((await invoke('safeImport:list')).data.some((a: any) => a.id === 'revoke-me')).toBe(false)
  })

  it('revoking something that was never imported is a no-op, not a crash', async () => {
    expect(await invoke('safeImport:revoke', { id: 'never-imported' })).toEqual({ success: true, data: false })
  })
})
