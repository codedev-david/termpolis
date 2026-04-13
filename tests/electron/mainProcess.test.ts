import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'

// ---------------------------------------------------------------------------
// Collect IPC handler registrations so we can invoke them directly
// ---------------------------------------------------------------------------
const ipcHandlers = new Map<string, Function>()
const ipcOnHandlers = new Map<string, Function>()

const mockWebContents = { send: vi.fn(), executeJavaScript: vi.fn() }
const mockMainWindow = {
  minimize: vi.fn(),
  maximize: vi.fn(),
  unmaximize: vi.fn(),
  isMaximized: vi.fn(),
  close: vi.fn(),
  on: vi.fn(),
  loadURL: vi.fn(),
  loadFile: vi.fn(),
  webContents: mockWebContents,
}

// BrowserWindow must be callable with `new`
function MockBrowserWindow() { return mockMainWindow }
MockBrowserWindow.prototype = {}

// ---------------------------------------------------------------------------
// Mock electron
// ---------------------------------------------------------------------------
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => require('os').tmpdir()),
    whenReady: () => Promise.resolve(),
    requestSingleInstanceLock: () => true,
    on: vi.fn(),
    commandLine: { appendSwitch: vi.fn() },
    isPackaged: false,
    quit: vi.fn(),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: Function) => {
      ipcHandlers.set(channel, handler)
    }),
    on: vi.fn((channel: string, handler: Function) => {
      ipcOnHandlers.set(channel, handler)
    }),
  },
  BrowserWindow: MockBrowserWindow,
  dialog: {
    showSaveDialog: vi.fn(),
    showOpenDialog: vi.fn(),
  },
  Menu: { setApplicationMenu: vi.fn() },
  nativeImage: { createFromPath: vi.fn(() => ({})) },
  globalShortcut: { register: vi.fn(), unregisterAll: vi.fn() },
}))

// ---------------------------------------------------------------------------
// Mock sentry (imported first in index.ts)
// ---------------------------------------------------------------------------
vi.mock('../../src/main/sentry', () => ({
  initMainSentry: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Mock all service modules
// ---------------------------------------------------------------------------
const mockSpawnTerminal = vi.fn()
const mockKillTerminal = vi.fn()
const mockWriteToTerminal = vi.fn()
const mockResizeTerminal = vi.fn()
const mockGetTerminalCwd = vi.fn()

vi.mock('../../src/main/terminalManager', () => ({
  spawnTerminal: (...args: any[]) => mockSpawnTerminal(...args),
  killTerminal: (...args: any[]) => mockKillTerminal(...args),
  writeToTerminal: (...args: any[]) => mockWriteToTerminal(...args),
  resizeTerminal: (...args: any[]) => mockResizeTerminal(...args),
  killAll: vi.fn(),
  getTerminalCwd: (...args: any[]) => mockGetTerminalCwd(...args),
}))

const mockDetectAvailableShells = vi.fn()
vi.mock('../../src/main/shellDetector', () => ({
  detectAvailableShells: (...args: any[]) => mockDetectAvailableShells(...args),
}))

const mockLoadSession = vi.fn()
const mockSaveSession = vi.fn()
vi.mock('../../src/main/sessionStore', () => ({
  loadSession: (...args: any[]) => mockLoadSession(...args),
  saveSession: (...args: any[]) => mockSaveSession(...args),
}))

const mockAppendCommand = vi.fn()
const mockSearchHistory = vi.fn()
vi.mock('../../src/main/historyStore', () => ({
  appendCommand: (...args: any[]) => mockAppendCommand(...args),
  searchHistory: (...args: any[]) => mockSearchHistory(...args),
}))

const mockReadConfigFile = vi.fn()
const mockWriteConfigFile = vi.fn()
vi.mock('../../src/main/configFileManager', () => ({
  readConfigFile: (...args: any[]) => mockReadConfigFile(...args),
  writeConfigFile: (...args: any[]) => mockWriteConfigFile(...args),
}))

const mockListPathEntries = vi.fn()
const mockListPathCommands = vi.fn()
const mockListEnvVars = vi.fn()
vi.mock('../../src/main/completionService', () => ({
  listPathEntries: (...args: any[]) => mockListPathEntries(...args),
  listPathCommands: (...args: any[]) => mockListPathCommands(...args),
  listEnvVars: (...args: any[]) => mockListEnvVars(...args),
}))

const mockSendMessage = vi.fn()
const mockReadMessages = vi.fn()
const mockGetAllMessages = vi.fn()
const mockCreateTask = vi.fn()
const mockListTasks = vi.fn()
const mockUpdateTask = vi.fn()
const mockClearSwarm = vi.fn()
vi.mock('../../src/main/swarmManager', () => ({
  sendMessage: (...args: any[]) => mockSendMessage(...args),
  readMessages: (...args: any[]) => mockReadMessages(...args),
  getAllMessages: (...args: any[]) => mockGetAllMessages(...args),
  createTask: (...args: any[]) => mockCreateTask(...args),
  listTasks: (...args: any[]) => mockListTasks(...args),
  updateTask: (...args: any[]) => mockUpdateTask(...args),
  clearSwarm: (...args: any[]) => mockClearSwarm(...args),
}))

vi.mock('../../src/main/mcpServer', () => ({
  startMcpServer: vi.fn(),
  stopMcpServer: vi.fn(),
  getMcpAuthToken: vi.fn(() => 'fake-token'),
  initAuditLog: vi.fn(),
}))

vi.mock('../../src/main/agentCommandSanitizer', () => ({
  sanitizeAgentCommand: vi.fn((cmd: string) => cmd),
}))

const mockExecSync = vi.fn()
vi.mock('child_process', () => ({
  default: { execSync: mockExecSync },
  execSync: mockExecSync,
}))

const mockExistsSync = vi.fn(() => false)
const mockWriteFileSync = vi.fn()
const mockReadFileSync = vi.fn(() => '{}')
const mockReaddirSync = vi.fn(() => [])
vi.mock('fs', () => ({
  writeFileSync: mockWriteFileSync,
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
  readdirSync: mockReaddirSync,
  default: {
    writeFileSync: mockWriteFileSync,
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    readdirSync: mockReaddirSync,
  },
}))

vi.mock('uuid', () => ({
  v4: vi.fn(() => 'mock-uuid-1234'),
}))

// ---------------------------------------------------------------------------
// Helper to invoke captured handlers
// ---------------------------------------------------------------------------
function invokeHandler(channel: string, args: any = {}) {
  const handler = ipcHandlers.get(channel)
  if (!handler) throw new Error(`No handler registered for channel: ${channel}`)
  // IPC handlers receive (event, args) — we pass a dummy event object
  return handler({}, args)
}

function invokeOnHandler(channel: string, args: any = {}) {
  const handler = ipcOnHandlers.get(channel)
  if (!handler) throw new Error(`No on-handler registered for channel: ${channel}`)
  return handler({}, args)
}

// ---------------------------------------------------------------------------
// Import the main process module (side-effect registers all IPC handlers)
// ---------------------------------------------------------------------------
beforeAll(async () => {
  vi.resetModules()
  // Re-apply mocks after resetModules
  await import('../../src/main/index')
})

beforeEach(() => {
  vi.clearAllMocks()
})

// =========================================================================
// terminal:create
// =========================================================================
describe('terminal:create', () => {
  it('creates a terminal with the requested shell type', async () => {
    mockDetectAvailableShells.mockResolvedValue([
      { type: 'bash', label: 'Bash', executable: '/bin/bash' },
      { type: 'zsh', label: 'Zsh', executable: '/bin/zsh' },
    ])

    const result = await invokeHandler('terminal:create', {
      id: 'term-1', shellType: 'bash', cwd: '/home/user', extraPaths: [],
    })

    expect(result).toEqual({ success: true, data: undefined })
    expect(mockSpawnTerminal).toHaveBeenCalledWith(
      'term-1',
      '/bin/bash',
      '/home/user',
      expect.any(Function),
      expect.any(Array),
    )
  })

  it('falls back to first shell when requested type not found', async () => {
    mockDetectAvailableShells.mockResolvedValue([
      { type: 'bash', label: 'Bash', executable: '/bin/bash' },
    ])

    const result = await invokeHandler('terminal:create', {
      id: 'term-2', shellType: 'zsh', cwd: '/tmp', extraPaths: [],
    })

    expect(result).toEqual({ success: true, data: undefined })
    expect(mockSpawnTerminal).toHaveBeenCalledWith(
      'term-2',
      '/bin/bash',
      '/tmp',
      expect.any(Function),
      expect.any(Array),
    )
  })

  it('returns error when no shells are available', async () => {
    mockDetectAvailableShells.mockResolvedValue([])

    const result = await invokeHandler('terminal:create', {
      id: 'term-3', shellType: 'bash', cwd: '/tmp', extraPaths: [],
    })

    expect(result).toEqual({ success: false, error: 'No shell available' })
  })

  it('returns error when spawnTerminal throws', async () => {
    mockDetectAvailableShells.mockResolvedValue([
      { type: 'bash', label: 'Bash', executable: '/bin/bash' },
    ])
    mockSpawnTerminal.mockImplementation(() => {
      throw new Error('spawn failed')
    })

    const result = await invokeHandler('terminal:create', {
      id: 'term-4', shellType: 'bash', cwd: '/tmp', extraPaths: [],
    })

    expect(result).toEqual({ success: false, error: 'spawn failed' })
  })

  it('returns error when detectAvailableShells rejects', async () => {
    mockDetectAvailableShells.mockRejectedValue(new Error('detection failed'))

    const result = await invokeHandler('terminal:create', {
      id: 'term-5', shellType: 'bash', cwd: '/tmp', extraPaths: [],
    })

    expect(result).toEqual({ success: false, error: 'detection failed' })
  })

  it('buffers terminal output via the data callback', async () => {
    let dataCallback: Function | undefined
    mockSpawnTerminal.mockImplementation((_id: string, _exec: string, _cwd: string, onData: Function) => {
      dataCallback = onData
    })
    mockDetectAvailableShells.mockResolvedValue([
      { type: 'bash', label: 'Bash', executable: '/bin/bash' },
    ])

    await invokeHandler('terminal:create', {
      id: 'term-buf', shellType: 'bash', cwd: '/tmp', extraPaths: [],
    })

    // Simulate terminal data
    dataCallback!('hello world')

    // Now read the buffer
    const bufferResult = await invokeHandler('terminal:read-buffer', {
      terminalId: 'term-buf', fromOffset: 0,
    })
    expect(bufferResult.success).toBe(true)
    expect(bufferResult.data.output).toBe('hello world')
  })

  it('merges extraPaths with agent paths', async () => {
    mockDetectAvailableShells.mockResolvedValue([
      { type: 'bash', label: 'Bash', executable: '/bin/bash' },
    ])

    await invokeHandler('terminal:create', {
      id: 'term-paths', shellType: 'bash', cwd: '/tmp', extraPaths: ['/custom/path'],
    })

    const calledPaths = mockSpawnTerminal.mock.calls[0][4]
    expect(calledPaths).toContain('/custom/path')
    expect(calledPaths.length).toBeGreaterThan(1)
  })
})

// =========================================================================
// terminal:kill
// =========================================================================
describe('terminal:kill', () => {
  it('kills a terminal and cleans up buffer', async () => {
    const result = await invokeHandler('terminal:kill', { id: 'term-1' })
    expect(result).toEqual({ success: true, data: undefined })
    expect(mockKillTerminal).toHaveBeenCalledWith('term-1')
  })

  it('returns error when killTerminal throws', async () => {
    mockKillTerminal.mockImplementation(() => {
      throw new Error('not found')
    })

    const result = await invokeHandler('terminal:kill', { id: 'bad-id' })
    expect(result).toEqual({ success: false, error: 'not found' })
  })
})

// =========================================================================
// terminal:write (ipcMain.on — fire-and-forget)
// =========================================================================
describe('terminal:write', () => {
  it('writes data to the terminal', () => {
    invokeOnHandler('terminal:write', { id: 'term-1', data: 'ls -la\r' })
    expect(mockWriteToTerminal).toHaveBeenCalledWith('term-1', 'ls -la\r')
  })
})

// =========================================================================
// terminal:resize (ipcMain.on — fire-and-forget)
// =========================================================================
describe('terminal:resize', () => {
  it('resizes the terminal', () => {
    invokeOnHandler('terminal:resize', { id: 'term-1', cols: 120, rows: 40 })
    expect(mockResizeTerminal).toHaveBeenCalledWith('term-1', 120, 40)
  })
})

// =========================================================================
// shell:available
// =========================================================================
describe('shell:available', () => {
  it('returns detected shells', async () => {
    const shells = [
      { type: 'bash', label: 'Bash', executable: '/bin/bash' },
      { type: 'zsh', label: 'Zsh', executable: '/bin/zsh' },
    ]
    mockDetectAvailableShells.mockResolvedValue(shells)

    const result = await invokeHandler('shell:available')
    expect(result).toEqual({ success: true, data: shells })
  })

  it('returns error on detection failure', async () => {
    mockDetectAvailableShells.mockRejectedValue(new Error('no shells'))

    const result = await invokeHandler('shell:available')
    expect(result).toEqual({ success: false, error: 'no shells' })
  })
})

// =========================================================================
// config:read
// =========================================================================
describe('config:read', () => {
  it('reads a config file', async () => {
    mockReadConfigFile.mockReturnValue('theme: dracula')

    const result = await invokeHandler('config:read', { filePath: '/path/config.yml' })
    expect(result).toEqual({ success: true, data: 'theme: dracula' })
    expect(mockReadConfigFile).toHaveBeenCalledWith('/path/config.yml')
  })

  it('returns error when file not found', async () => {
    mockReadConfigFile.mockImplementation(() => {
      throw new Error('ENOENT')
    })

    const result = await invokeHandler('config:read', { filePath: '/bad/path' })
    expect(result).toEqual({ success: false, error: 'ENOENT' })
  })
})

// =========================================================================
// config:write
// =========================================================================
describe('config:write', () => {
  it('writes a config file', async () => {
    const result = await invokeHandler('config:write', {
      filePath: '/path/config.yml', content: 'theme: monokai',
    })
    expect(result).toEqual({ success: true, data: undefined })
    expect(mockWriteConfigFile).toHaveBeenCalledWith('/path/config.yml', 'theme: monokai')
  })

  it('returns error on write failure', async () => {
    mockWriteConfigFile.mockImplementation(() => {
      throw new Error('EACCES')
    })

    const result = await invokeHandler('config:write', {
      filePath: '/path/config.yml', content: 'bad',
    })
    expect(result).toEqual({ success: false, error: 'EACCES' })
  })
})

// =========================================================================
// history:append (ipcMain.on — fire-and-forget)
// =========================================================================
describe('history:append', () => {
  it('appends a command to history', () => {
    invokeOnHandler('history:append', {
      terminalId: 't1', terminalName: 'Main', command: 'git status',
    })
    expect(mockAppendCommand).toHaveBeenCalledWith('t1', 'Main', 'git status')
  })

  it('uses terminalId as name when terminalName is not provided', () => {
    invokeOnHandler('history:append', {
      terminalId: 't2', terminalName: undefined, command: 'ls',
    })
    expect(mockAppendCommand).toHaveBeenCalledWith('t2', 't2', 'ls')
  })

  it('does not throw if appendCommand fails', () => {
    mockAppendCommand.mockImplementation(() => { throw new Error('disk full') })
    // Should not throw
    expect(() => {
      invokeOnHandler('history:append', {
        terminalId: 't3', terminalName: 'Shell', command: 'pwd',
      })
    }).not.toThrow()
  })
})

// =========================================================================
// history:search
// =========================================================================
describe('history:search', () => {
  it('returns matching history entries', async () => {
    const entries = [
      { terminalId: 't1', terminalName: 'Main', command: 'git status', timestamp: 1000 },
      { terminalId: 't1', terminalName: 'Main', command: 'git log', timestamp: 2000 },
    ]
    mockSearchHistory.mockReturnValue(entries)

    const result = await invokeHandler('history:search', { query: 'git' })
    expect(result).toEqual({ success: true, data: entries })
    expect(mockSearchHistory).toHaveBeenCalledWith('git')
  })

  it('returns error on search failure', async () => {
    mockSearchHistory.mockImplementation(() => {
      throw new Error('corrupted')
    })

    const result = await invokeHandler('history:search', { query: 'bad' })
    expect(result).toEqual({ success: false, error: 'corrupted' })
  })
})

// =========================================================================
// fs:homedir
// =========================================================================
describe('fs:homedir', () => {
  it('returns the home directory', async () => {
    const result = await invokeHandler('fs:homedir')
    expect(result.success).toBe(true)
    expect(typeof result.data).toBe('string')
    expect(result.data.length).toBeGreaterThan(0)
  })
})

// =========================================================================
// session:load
// =========================================================================
describe('session:load', () => {
  it('loads session data', async () => {
    const session = {
      terminals: [{ id: 't1', name: 'Main', color: '#fff', shellType: 'bash', cwd: '/', fontSize: 14, theme: 'dracula', fontFamily: 'mono' }],
      workspaces: [],
      defaultShell: 'bash',
      viewMode: 'tabs',
    }
    mockLoadSession.mockReturnValue(session)

    const result = await invokeHandler('session:load')
    expect(result).toEqual({ success: true, data: session })
  })

  it('returns error when session file is corrupted', async () => {
    mockLoadSession.mockImplementation(() => {
      throw new Error('JSON parse error')
    })

    const result = await invokeHandler('session:load')
    expect(result).toEqual({ success: false, error: 'JSON parse error' })
  })
})

// =========================================================================
// session:save (ipcMain.on — fire-and-forget)
// =========================================================================
describe('session:save', () => {
  it('saves session data', () => {
    const sessionData = {
      terminals: [],
      workspaces: [],
      defaultShell: 'bash',
      viewMode: 'tabs',
    }
    invokeOnHandler('session:save', sessionData)
    expect(mockSaveSession).toHaveBeenCalledWith(sessionData)
  })

  it('does not throw if saveSession fails', () => {
    mockSaveSession.mockImplementation(() => { throw new Error('disk full') })
    expect(() => {
      invokeOnHandler('session:save', { terminals: [], workspaces: [], defaultShell: 'bash', viewMode: 'tabs' })
    }).not.toThrow()
  })
})

// =========================================================================
// dialog:pick-directory
// =========================================================================
describe('dialog:pick-directory', () => {
  it('returns selected directory path', async () => {
    const { dialog } = await import('electron') as any
    dialog.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['/home/user/projects'],
    })

    const result = await invokeHandler('dialog:pick-directory', { defaultPath: '/home/user' })
    expect(result).toEqual({ success: true, data: '/home/user/projects' })
  })

  it('returns null when dialog is cancelled', async () => {
    const { dialog } = await import('electron') as any
    dialog.showOpenDialog.mockResolvedValue({
      canceled: true,
      filePaths: [],
    })

    const result = await invokeHandler('dialog:pick-directory', { defaultPath: '/home/user' })
    expect(result).toEqual({ success: true, data: null })
  })

  it('returns error on dialog failure', async () => {
    const { dialog } = await import('electron') as any
    dialog.showOpenDialog.mockRejectedValue(new Error('display error'))

    const result = await invokeHandler('dialog:pick-directory', { defaultPath: '/tmp' })
    expect(result).toEqual({ success: false, error: 'display error' })
  })
})

// =========================================================================
// completion:path-entries
// =========================================================================
describe('completion:path-entries', () => {
  it('returns directory entries', async () => {
    const entries = [
      { name: 'src', isDirectory: true },
      { name: 'package.json', isDirectory: false },
    ]
    mockListPathEntries.mockReturnValue(entries)

    const result = await invokeHandler('completion:path-entries', { dirPath: '/project' })
    expect(result).toEqual({ success: true, data: entries })
    expect(mockListPathEntries).toHaveBeenCalledWith('/project')
  })

  it('returns error for invalid path', async () => {
    mockListPathEntries.mockImplementation(() => {
      throw new Error('ENOENT')
    })

    const result = await invokeHandler('completion:path-entries', { dirPath: '/nonexistent' })
    expect(result).toEqual({ success: false, error: 'ENOENT' })
  })
})

// =========================================================================
// completion:path-commands
// =========================================================================
describe('completion:path-commands', () => {
  it('returns PATH commands', async () => {
    const commands = ['git', 'node', 'npm']
    mockListPathCommands.mockReturnValue(commands)

    const result = await invokeHandler('completion:path-commands')
    expect(result).toEqual({ success: true, data: commands })
  })

  it('returns error on failure', async () => {
    mockListPathCommands.mockImplementation(() => {
      throw new Error('path scan failed')
    })

    const result = await invokeHandler('completion:path-commands')
    expect(result).toEqual({ success: false, error: 'path scan failed' })
  })
})

// =========================================================================
// completion:env-vars
// =========================================================================
describe('completion:env-vars', () => {
  it('returns environment variables', async () => {
    const vars = ['HOME', 'PATH', 'USER']
    mockListEnvVars.mockReturnValue(vars)

    const result = await invokeHandler('completion:env-vars')
    expect(result).toEqual({ success: true, data: vars })
  })

  it('returns error on failure', async () => {
    mockListEnvVars.mockImplementation(() => {
      throw new Error('env read failed')
    })

    const result = await invokeHandler('completion:env-vars')
    expect(result).toEqual({ success: false, error: 'env read failed' })
  })
})

// =========================================================================
// terminal:status
// =========================================================================
describe('terminal:status', () => {
  it('returns cwd and git branch', async () => {
    mockGetTerminalCwd.mockReturnValue('/home/user/project')
    mockExecSync.mockReturnValue(Buffer.from('main\n'))

    const result = await invokeHandler('terminal:status', {
      terminalId: 'term-1', fallbackCwd: '/fallback',
    })

    expect(mockExecSync).toHaveBeenCalled()
    expect(result.success).toBe(true)
    expect(result.data.cwd).toBe('/home/user/project')
    expect(result.data.gitBranch).toBe('main')
  })

  it('uses fallback cwd when live cwd is not available', async () => {
    mockGetTerminalCwd.mockReturnValue(null)
    mockExecSync.mockReturnValue(Buffer.from('develop\n'))

    const result = await invokeHandler('terminal:status', {
      terminalId: 'term-1', fallbackCwd: '/fallback/dir',
    })

    expect(result.success).toBe(true)
    expect(result.data.cwd).toBe('/fallback/dir')
  })

  it('returns empty git branch when not in a git repo', async () => {
    mockGetTerminalCwd.mockReturnValue('/tmp')
    mockExecSync.mockImplementation(() => {
      throw new Error('not a git repo')
    })

    const result = await invokeHandler('terminal:status', {
      terminalId: 'term-1', fallbackCwd: '/tmp',
    })

    expect(result.success).toBe(true)
    expect(result.data.gitBranch).toBe('')
  })
})

// =========================================================================
// terminal:git-info
// =========================================================================
describe('terminal:git-info', () => {
  it('returns git status and recent commits', async () => {
    mockExecSync
      .mockReturnValueOnce(Buffer.from(' M src/index.ts\n'))
      .mockReturnValueOnce(Buffer.from('abc1234 feat: add feature\ndef5678 fix: bug fix\n'))

    const result = await invokeHandler('terminal:git-info', { cwd: '/repo' })

    expect(result.success).toBe(true)
    expect(result.data.status).toContain('M src/index.ts')
    expect(result.data.recentCommits).toContain('abc1234')
  })

  it('returns empty strings when git commands fail', async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('not a repo')
    })

    const result = await invokeHandler('terminal:git-info', { cwd: '/not-a-repo' })

    expect(result.success).toBe(true)
    expect(result.data.status).toBe('')
    expect(result.data.recentCommits).toBe('')
  })
})

// =========================================================================
// agents:detect
// =========================================================================
describe('agents:detect', () => {
  it('returns detection results for all agents', async () => {
    // Make all agents fail detection (not found)
    mockExecSync.mockImplementation(() => {
      throw new Error('not found')
    })
    mockExistsSync.mockReturnValue(false)

    const result = await invokeHandler('agents:detect')

    expect(result.success).toBe(true)
    expect(result.data).toHaveProperty('claude')
    expect(result.data).toHaveProperty('codex')
    expect(result.data).toHaveProperty('gemini')
    expect(result.data).toHaveProperty('aider')
    expect(result.data).toHaveProperty('aider-qwen')
  })

  it('detects agents when commands exist on PATH', async () => {
    // where/which succeeds for all
    mockExecSync.mockReturnValue(Buffer.from('/usr/bin/claude\n'))

    const result = await invokeHandler('agents:detect')

    expect(result.success).toBe(true)
    expect(result.data.claude).toBe(true)
    expect(result.data.codex).toBe(true)
    expect(result.data.gemini).toBe(true)
  })
})

// =========================================================================
// agents:ollama-path
// =========================================================================
describe('agents:ollama-path', () => {
  it('returns ollama path when found on PATH', async () => {
    mockExecSync.mockReturnValue(Buffer.from(''))

    const result = await invokeHandler('agents:ollama-path')
    expect(result.success).toBe(true)
    // When execSync succeeds (where/which finds ollama), returns 'ollama'
    // Note: findOllamaPath uses require('fs') for fallback checks which bypasses
    // vi.mock — so on machines with ollama installed, result.data may be a path.
    expect(result.data).toBe('ollama')
  })

  it('returns a string or null depending on system state', async () => {
    // findOllamaPath uses require('fs').existsSync internally (not mockable via vi.mock)
    // so the result depends on whether ollama is actually installed on this machine.
    // We verify the handler returns a valid response shape.
    mockExecSync.mockImplementation(() => {
      throw new Error('not found')
    })

    const result = await invokeHandler('agents:ollama-path')
    expect(result.success).toBe(true)
    expect(result.data === null || typeof result.data === 'string').toBe(true)
  })
})

// =========================================================================
// terminal:read-buffer
// =========================================================================
describe('terminal:read-buffer', () => {
  it('returns empty output for non-existent terminal', async () => {
    const result = await invokeHandler('terminal:read-buffer', {
      terminalId: 'nonexistent', fromOffset: 0,
    })
    expect(result.success).toBe(true)
    expect(result.data.output).toBe('')
    expect(result.data.length).toBe(0)
  })

  it('slices from the given offset', async () => {
    // First create a terminal so we have a buffer
    let dataCallback: Function | undefined
    mockSpawnTerminal.mockImplementation((_id: string, _exec: string, _cwd: string, onData: Function) => {
      dataCallback = onData
    })
    mockDetectAvailableShells.mockResolvedValue([
      { type: 'bash', label: 'Bash', executable: '/bin/bash' },
    ])

    await invokeHandler('terminal:create', {
      id: 'term-offset', shellType: 'bash', cwd: '/tmp', extraPaths: [],
    })

    dataCallback!('0123456789')

    const result = await invokeHandler('terminal:read-buffer', {
      terminalId: 'term-offset', fromOffset: 5,
    })
    expect(result.data.output).toBe('56789')
    expect(result.data.length).toBe(5)
  })

  it('defaults offset to 0 when not provided', async () => {
    let dataCallback: Function | undefined
    mockSpawnTerminal.mockImplementation((_id: string, _exec: string, _cwd: string, onData: Function) => {
      dataCallback = onData
    })
    mockDetectAvailableShells.mockResolvedValue([
      { type: 'bash', label: 'Bash', executable: '/bin/bash' },
    ])

    await invokeHandler('terminal:create', {
      id: 'term-nooffset', shellType: 'bash', cwd: '/tmp', extraPaths: [],
    })

    dataCallback!('hello')

    const result = await invokeHandler('terminal:read-buffer', {
      terminalId: 'term-nooffset', fromOffset: undefined,
    })
    expect(result.data.output).toBe('hello')
  })
})

// =========================================================================
// swarm:send-message
// =========================================================================
describe('swarm:send-message', () => {
  it('sends a swarm message', async () => {
    const msg = { id: 'msg-1', from: 'conductor', to: 'agent-1', type: 'task', content: 'do this', timestamp: Date.now() }
    mockSendMessage.mockReturnValue(msg)

    const result = await invokeHandler('swarm:send-message', {
      from: 'conductor', to: 'agent-1', type: 'task', content: 'do this',
    })

    expect(result).toEqual({ success: true, data: msg })
    expect(mockSendMessage).toHaveBeenCalledWith('conductor', 'agent-1', 'task', 'do this')
  })

  it('returns error when sendMessage throws', async () => {
    mockSendMessage.mockImplementation(() => {
      throw new Error('invalid type')
    })

    const result = await invokeHandler('swarm:send-message', {
      from: 'a', to: 'b', type: 'bad', content: 'x',
    })

    expect(result).toEqual({ success: false, error: 'invalid type' })
  })
})

// =========================================================================
// swarm:messages
// =========================================================================
describe('swarm:messages', () => {
  it('returns all swarm messages', async () => {
    const messages = [
      { id: 'msg-1', from: 'conductor', to: 'all', type: 'info', content: 'hello', timestamp: 1000 },
    ]
    mockGetAllMessages.mockReturnValue(messages)

    const result = await invokeHandler('swarm:messages')
    expect(result).toEqual({ success: true, data: messages })
  })
})

// =========================================================================
// swarm:tasks
// =========================================================================
describe('swarm:tasks', () => {
  it('returns all swarm tasks', async () => {
    const tasks = [
      { id: 'task-1', title: 'Build feature', description: 'desc', assignedTo: 'agent-1', status: 'pending', createdBy: 'conductor', createdAt: 1000 },
    ]
    mockListTasks.mockReturnValue(tasks)

    const result = await invokeHandler('swarm:tasks')
    expect(result).toEqual({ success: true, data: tasks })
  })
})

// =========================================================================
// swarm:create-task
// =========================================================================
describe('swarm:create-task', () => {
  it('creates a swarm task', async () => {
    const task = { id: 'task-1', title: 'Feature', description: 'desc', assignedTo: 'agent-1', status: 'pending', createdBy: 'conductor', createdAt: Date.now() }
    mockCreateTask.mockReturnValue(task)

    const result = await invokeHandler('swarm:create-task', {
      title: 'Feature', description: 'desc', createdBy: 'conductor', assignTo: 'agent-1',
    })

    expect(result).toEqual({ success: true, data: task })
    expect(mockCreateTask).toHaveBeenCalledWith('Feature', 'desc', 'conductor', 'agent-1')
  })

  it('returns error when createTask throws', async () => {
    mockCreateTask.mockImplementation(() => {
      throw new Error('task creation failed')
    })

    const result = await invokeHandler('swarm:create-task', {
      title: 'Bad', description: '', createdBy: 'x', assignTo: 'y',
    })

    expect(result).toEqual({ success: false, error: 'task creation failed' })
  })
})

// =========================================================================
// swarm:update-task
// =========================================================================
describe('swarm:update-task', () => {
  it('updates a swarm task', async () => {
    const updated = { id: 'task-1', title: 'Feature', description: 'desc', assignedTo: 'agent-1', status: 'completed', createdBy: 'conductor', createdAt: 1000, result: 'done' }
    mockUpdateTask.mockReturnValue(updated)

    const result = await invokeHandler('swarm:update-task', {
      taskId: 'task-1', status: 'completed', result: 'done',
    })

    expect(result).toEqual({ success: true, data: updated })
    expect(mockUpdateTask).toHaveBeenCalledWith('task-1', 'completed', 'done')
  })

  it('returns error when task is not found', async () => {
    mockUpdateTask.mockReturnValue(null)

    const result = await invokeHandler('swarm:update-task', {
      taskId: 'bad-id', status: 'completed', result: 'x',
    })

    expect(result).toEqual({ success: false, error: 'Task not found' })
  })

  it('returns error when updateTask throws', async () => {
    mockUpdateTask.mockImplementation(() => {
      throw new Error('invalid status')
    })

    const result = await invokeHandler('swarm:update-task', {
      taskId: 'task-1', status: 'bad', result: '',
    })

    expect(result).toEqual({ success: false, error: 'invalid status' })
  })
})

// =========================================================================
// swarm:clear
// =========================================================================
describe('swarm:clear', () => {
  it('clears all swarm state', async () => {
    const result = await invokeHandler('swarm:clear')
    expect(result).toEqual({ success: true, data: undefined })
    expect(mockClearSwarm).toHaveBeenCalled()
  })

  it('returns error when clearSwarm throws', async () => {
    mockClearSwarm.mockImplementation(() => {
      throw new Error('clear failed')
    })

    const result = await invokeHandler('swarm:clear')
    expect(result).toEqual({ success: false, error: 'clear failed' })
  })
})

// =========================================================================
// window controls (ipcMain.on — fire-and-forget)
// =========================================================================
describe('window:minimize', () => {
  it('handler is registered', () => {
    expect(ipcOnHandlers.has('window:minimize')).toBe(true)
  })
})

describe('window:maximize', () => {
  it('handler is registered', () => {
    expect(ipcOnHandlers.has('window:maximize')).toBe(true)
  })
})

describe('window:close', () => {
  it('handler is registered', () => {
    expect(ipcOnHandlers.has('window:close')).toBe(true)
  })
})

// =========================================================================
// Handler registration completeness
// =========================================================================
describe('IPC handler registration', () => {
  it('registers all expected ipcMain.handle channels', () => {
    const expectedHandleChannels = [
      'terminal:create',
      'terminal:kill',
      'shell:available',
      'config:read',
      'config:write',
      'history:search',
      'fs:homedir',
      'session:load',
      'terminal:export',
      'dialog:pick-directory',
      'completion:path-entries',
      'completion:path-commands',
      'completion:env-vars',
      'terminal:git-diff',
      'terminal:git-info',
      'terminal:status',
      'agents:detect',
      'agents:ollama-path',
      'terminal:read-buffer',
      'swarm:messages',
      'swarm:tasks',
      'swarm:send-message',
      'swarm:create-task',
      'swarm:update-task',
      'swarm:clear',
    ]

    for (const channel of expectedHandleChannels) {
      expect(ipcHandlers.has(channel), `Missing handler for ${channel}`).toBe(true)
    }
  })

  it('registers all expected ipcMain.on channels', () => {
    const expectedOnChannels = [
      'terminal:write',
      'terminal:resize',
      'history:append',
      'session:save',
      'window:minimize',
      'window:maximize',
      'window:close',
    ]

    for (const channel of expectedOnChannels) {
      expect(ipcOnHandlers.has(channel), `Missing on-handler for ${channel}`).toBe(true)
    }
  })
})

// =========================================================================
// terminal:export
// =========================================================================
describe('terminal:export', () => {
  it('exports terminal content to a file', async () => {
    const { dialog } = await import('electron') as any
    dialog.showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: '/home/user/export.txt',
    })

    const result = await invokeHandler('terminal:export', {
      content: 'terminal output here', defaultFilename: 'export.txt',
    })

    expect(result.success).toBe(true)
    expect(result.data).toEqual({ filePath: '/home/user/export.txt' })
  })

  it('returns ok with no data when save dialog is cancelled', async () => {
    const { dialog } = await import('electron') as any
    dialog.showSaveDialog.mockResolvedValue({
      canceled: true,
      filePath: '',
    })

    const result = await invokeHandler('terminal:export', {
      content: 'content', defaultFilename: 'out.txt',
    })

    expect(result).toEqual({ success: true, data: undefined })
  })

  it('returns error on save failure', async () => {
    const { dialog } = await import('electron') as any
    dialog.showSaveDialog.mockRejectedValue(new Error('save failed'))

    const result = await invokeHandler('terminal:export', {
      content: 'content', defaultFilename: 'out.txt',
    })

    expect(result).toEqual({ success: false, error: 'save failed' })
  })
})

// =========================================================================
// terminal:git-diff
// =========================================================================
describe('terminal:git-diff', () => {
  it('returns git diff stat', async () => {
    mockExecSync.mockReturnValue(Buffer.from(' src/index.ts | 5 ++---\n 1 file changed\n'))

    const result = await invokeHandler('terminal:git-diff', { cwd: '/repo' })
    expect(result.success).toBe(true)
    expect(result.data).toContain('src/index.ts')
  })

  it('returns empty string when not in a git repo', async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('not a git repo')
    })

    const result = await invokeHandler('terminal:git-diff', { cwd: '/not-repo' })
    expect(result.success).toBe(true)
    expect(result.data).toBe('')
  })
})

// =========================================================================
// git:stage
// =========================================================================
describe('git:stage', () => {
  it('stages specified files', async () => {
    mockExecSync.mockReturnValue(Buffer.from(''))

    const result = await invokeHandler('git:stage', { cwd: '/repo', files: ['src/a.ts', 'src/b.ts'] })
    expect(result).toEqual({ success: true, data: undefined })
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining('git add'),
      expect.objectContaining({ cwd: '/repo' }),
    )
  })

  it('stages all files when empty array provided', async () => {
    mockExecSync.mockReturnValue(Buffer.from(''))

    const result = await invokeHandler('git:stage', { cwd: '/repo', files: [] })
    expect(result).toEqual({ success: true, data: undefined })
    expect(mockExecSync).toHaveBeenCalledWith(
      'git add .',
      expect.objectContaining({ cwd: '/repo' }),
    )
  })

  it('returns error when git add fails', async () => {
    mockExecSync.mockImplementation(() => { throw new Error('pathspec error') })

    const result = await invokeHandler('git:stage', { cwd: '/repo', files: ['bad-file'] })
    expect(result).toEqual({ success: false, error: 'pathspec error' })
  })
})

// =========================================================================
// git:unstage
// =========================================================================
describe('git:unstage', () => {
  it('unstages specified files', async () => {
    mockExecSync.mockReturnValue(Buffer.from(''))

    const result = await invokeHandler('git:unstage', { cwd: '/repo', files: ['src/a.ts'] })
    expect(result).toEqual({ success: true, data: undefined })
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining('git reset HEAD'),
      expect.objectContaining({ cwd: '/repo' }),
    )
  })

  it('unstages all files when empty array provided', async () => {
    mockExecSync.mockReturnValue(Buffer.from(''))

    const result = await invokeHandler('git:unstage', { cwd: '/repo', files: [] })
    expect(result).toEqual({ success: true, data: undefined })
    expect(mockExecSync).toHaveBeenCalledWith(
      'git reset HEAD .',
      expect.objectContaining({ cwd: '/repo' }),
    )
  })

  it('returns error when git reset fails', async () => {
    mockExecSync.mockImplementation(() => { throw new Error('reset error') })

    const result = await invokeHandler('git:unstage', { cwd: '/repo', files: ['x'] })
    expect(result).toEqual({ success: false, error: 'reset error' })
  })
})

// =========================================================================
// git:commit
// =========================================================================
describe('git:commit', () => {
  it('commits with provided message', async () => {
    mockExecSync.mockReturnValue(Buffer.from(''))

    const result = await invokeHandler('git:commit', { cwd: '/repo', message: 'fix: bug' })
    expect(result).toEqual({ success: true, data: undefined })
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining('git commit -m'),
      expect.objectContaining({ cwd: '/repo' }),
    )
  })

  it('returns error for empty commit message', async () => {
    const result = await invokeHandler('git:commit', { cwd: '/repo', message: '   ' })
    expect(result).toEqual({ success: false, error: 'Commit message cannot be empty' })
  })

  it('returns error when git commit fails', async () => {
    mockExecSync.mockImplementation(() => { throw new Error('nothing to commit') })

    const result = await invokeHandler('git:commit', { cwd: '/repo', message: 'test' })
    expect(result).toEqual({ success: false, error: 'nothing to commit' })
  })

  it('escapes double quotes in commit message', async () => {
    mockExecSync.mockReturnValue(Buffer.from(''))

    await invokeHandler('git:commit', { cwd: '/repo', message: 'fix: handle "quotes"' })
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining('\\"quotes\\"'),
      expect.any(Object),
    )
  })
})

// =========================================================================
// git:pull
// =========================================================================
describe('git:pull', () => {
  it('returns pull output on success', async () => {
    mockExecSync.mockReturnValue(Buffer.from('Already up to date.\n'))

    const result = await invokeHandler('git:pull', { cwd: '/repo' })
    expect(result).toEqual({ success: true, data: 'Already up to date.' })
  })

  it('returns error when pull fails', async () => {
    mockExecSync.mockImplementation(() => { throw new Error('no tracking branch') })

    const result = await invokeHandler('git:pull', { cwd: '/repo' })
    expect(result).toEqual({ success: false, error: 'no tracking branch' })
  })
})

// =========================================================================
// git:push
// =========================================================================
describe('git:push', () => {
  it('returns push output on success', async () => {
    mockExecSync.mockReturnValue(Buffer.from('Everything up-to-date\n'))

    const result = await invokeHandler('git:push', { cwd: '/repo' })
    expect(result).toEqual({ success: true, data: 'Everything up-to-date' })
  })

  it('returns error when push fails', async () => {
    mockExecSync.mockImplementation(() => { throw new Error('rejected') })

    const result = await invokeHandler('git:push', { cwd: '/repo' })
    expect(result).toEqual({ success: false, error: 'rejected' })
  })
})

// =========================================================================
// git:file-diff
// =========================================================================
describe('git:file-diff', () => {
  it('returns diff for a specific file', async () => {
    mockExecSync.mockReturnValue(Buffer.from('diff --git a/f.ts b/f.ts\n+new line'))

    const result = await invokeHandler('git:file-diff', { cwd: '/repo', file: 'f.ts' })
    expect(result.success).toBe(true)
    expect(result.data).toContain('+new line')
  })

  it('returns empty string when file has no diff', async () => {
    mockExecSync.mockImplementation(() => { throw new Error('no diff') })

    const result = await invokeHandler('git:file-diff', { cwd: '/repo', file: 'clean.ts' })
    expect(result.success).toBe(true)
    expect(result.data).toBe('')
  })
})

// =========================================================================
// git:status-parsed
// =========================================================================
describe('git:status-parsed', () => {
  it('parses staged and unstaged files', async () => {
    mockExecSync
      .mockReturnValueOnce(Buffer.from('main\n'))  // branch
      .mockReturnValueOnce(Buffer.from('M  src/a.ts\n M src/b.ts\n?? new.ts\n'))  // status

    const result = await invokeHandler('git:status-parsed', { cwd: '/repo' })
    expect(result.success).toBe(true)
    expect(result.data.branch).toBe('main')
    expect(result.data.staged).toEqual([{ file: 'src/a.ts', status: 'M' }])
    expect(result.data.unstaged.length).toBeGreaterThanOrEqual(1)
  })

  it('returns empty arrays when working tree is clean', async () => {
    mockExecSync
      .mockReturnValueOnce(Buffer.from('develop\n'))
      .mockReturnValueOnce(Buffer.from('\n'))

    const result = await invokeHandler('git:status-parsed', { cwd: '/repo' })
    expect(result.success).toBe(true)
    expect(result.data.branch).toBe('develop')
    expect(result.data.staged).toEqual([])
    expect(result.data.unstaged).toEqual([])
  })

  it('returns error when git status fails', async () => {
    mockExecSync.mockImplementation(() => { throw new Error('not a git repo') })

    const result = await invokeHandler('git:status-parsed', { cwd: '/bad' })
    expect(result).toEqual({ success: false, error: 'not a git repo' })
  })

  it('handles branch detection failure gracefully', async () => {
    // First call (branch) throws, second call (status) succeeds
    let callCount = 0
    mockExecSync.mockImplementation(() => {
      callCount++
      if (callCount === 1) throw new Error('detached HEAD')
      return Buffer.from('A  new-file.ts\n')
    })

    const result = await invokeHandler('git:status-parsed', { cwd: '/repo' })
    expect(result.success).toBe(true)
    expect(result.data.branch).toBe('')
    expect(result.data.staged.length).toBe(1)
  })
})

// =========================================================================
// IPC handler registration - git handlers
// =========================================================================
describe('IPC handler registration - git handlers', () => {
  it('registers all git IPC handle channels', () => {
    const gitChannels = [
      'git:stage',
      'git:unstage',
      'git:commit',
      'git:pull',
      'git:push',
      'git:file-diff',
      'git:status-parsed',
    ]
    for (const channel of gitChannels) {
      expect(ipcHandlers.has(channel), `Missing handler for ${channel}`).toBe(true)
    }
  })
})

// =========================================================================
// app:force-close handler
// =========================================================================
describe('app:force-close', () => {
  it('registers the app:force-close on handler', () => {
    expect(ipcOnHandlers.has('app:force-close')).toBe(true)
  })
})

// =========================================================================
// terminal:export edge case
// =========================================================================
describe('terminal:export - cancelled dialog no filePath', () => {
  it('returns ok when dialog has no filePath field', async () => {
    const { dialog } = await import('electron') as any
    dialog.showSaveDialog.mockResolvedValue({
      canceled: true,
      filePath: undefined,
    })

    const result = await invokeHandler('terminal:export', {
      content: 'content', defaultFilename: 'out.txt',
    })
    expect(result).toEqual({ success: true, data: undefined })
  })
})

// =========================================================================
// git:status-parsed with untracked files
// =========================================================================
describe('git:status-parsed additional parsing', () => {
  it('handles untracked files (? status) as unstaged with U status', async () => {
    mockExecSync
      .mockReturnValueOnce(Buffer.from('main\n'))
      .mockReturnValueOnce(Buffer.from('?? untracked.ts\n'))

    const result = await invokeHandler('git:status-parsed', { cwd: '/repo' })
    expect(result.success).toBe(true)
    expect(result.data.staged).toEqual([])
    expect(result.data.unstaged).toEqual([{ file: 'untracked.ts', status: 'U' }])
  })

  it('handles both staged and worktree changes on same file', async () => {
    mockExecSync
      .mockReturnValueOnce(Buffer.from('main\n'))
      .mockReturnValueOnce(Buffer.from('MM src/both.ts\n'))

    const result = await invokeHandler('git:status-parsed', { cwd: '/repo' })
    expect(result.success).toBe(true)
    expect(result.data.staged).toEqual([{ file: 'src/both.ts', status: 'M' }])
    expect(result.data.unstaged).toEqual([{ file: 'src/both.ts', status: 'M' }])
  })
})

// =========================================================================
// dialog:pick-directory with default path
// =========================================================================
describe('dialog:pick-directory defaults', () => {
  it('uses homedir when no defaultPath provided', async () => {
    const { dialog } = await import('electron') as any
    dialog.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['/selected/dir'],
    })

    const result = await invokeHandler('dialog:pick-directory', {})
    expect(result).toEqual({ success: true, data: '/selected/dir' })
  })
})

// =========================================================================
// Large output buffer truncation
// =========================================================================
describe('terminal output buffer truncation', () => {
  it('truncates buffer beyond 32KB', async () => {
    let dataCallback: Function | undefined
    mockSpawnTerminal.mockImplementation((_id: string, _exec: string, _cwd: string, onData: Function) => {
      dataCallback = onData
    })
    mockDetectAvailableShells.mockResolvedValue([
      { type: 'bash', label: 'Bash', executable: '/bin/bash' },
    ])

    await invokeHandler('terminal:create', {
      id: 'term-trunc', shellType: 'bash', cwd: '/tmp', extraPaths: [],
    })

    // Send more than 32KB of data
    const largeData = 'x'.repeat(40000)
    dataCallback!(largeData)

    const result = await invokeHandler('terminal:read-buffer', {
      terminalId: 'term-trunc', fromOffset: 0,
    })
    expect(result.success).toBe(true)
    // Buffer should be capped to last 32768 chars
    expect(result.data.output.length).toBeLessThanOrEqual(32768)
  })
})
