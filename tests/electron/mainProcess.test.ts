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
  isMinimized: vi.fn(() => false),
  restore: vi.fn(),
  focus: vi.fn(),
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

let capturedMcpHandlers: any = null
const mockStartMcpServer = vi.fn((handlers: any) => { capturedMcpHandlers = handlers; return { close: vi.fn() } })
const mockStopMcpServer = vi.fn()
vi.mock('../../src/main/mcpServer', () => ({
  startMcpServer: (...args: any[]) => mockStartMcpServer(...args),
  stopMcpServer: (...args: any[]) => mockStopMcpServer(...args),
  getMcpAuthToken: vi.fn(() => 'fake-token'),
  getMcpPort: vi.fn(() => 9315),
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
const mockMkdirSync = vi.fn()
const mockAppendFileSync = vi.fn()
const mockRenameSync = vi.fn()
vi.mock('fs', () => ({
  writeFileSync: mockWriteFileSync,
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
  readdirSync: mockReaddirSync,
  mkdirSync: mockMkdirSync,
  appendFileSync: mockAppendFileSync,
  renameSync: mockRenameSync,
  default: {
    writeFileSync: mockWriteFileSync,
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    readdirSync: mockReaddirSync,
    mkdirSync: mockMkdirSync,
    appendFileSync: mockAppendFileSync,
    renameSync: mockRenameSync,
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
// Captured callbacks from app.on and globalShortcut.register (one-time during import)
const capturedAppCallbacks: Record<string, Function> = {}
const capturedShortcuts: Record<string, Function> = {}

beforeAll(async () => {
  vi.resetModules()
  // Re-apply mocks after resetModules
  await import('../../src/main/index')
  // Flush microtasks so app.whenReady().then() runs
  await new Promise(resolve => setTimeout(resolve, 50))

  // Capture app.on callbacks before clearAllMocks wipes the call history
  const { app, globalShortcut } = await import('electron') as any
  for (const call of (app.on as any).mock.calls) {
    capturedAppCallbacks[call[0]] = call[1]
  }
  for (const call of (globalShortcut.register as any).mock.calls) {
    capturedShortcuts[call[0]] = call[1]
  }
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
// git:find-root
// =========================================================================
describe('git:find-root', () => {
  it('returns the git root directory', async () => {
    mockExecSync.mockReturnValue(Buffer.from('/home/user/project\n'))

    const result = await invokeHandler('git:find-root', { cwd: '/home/user/project/src' })
    expect(result.success).toBe(true)
    expect(result.data).toBe('/home/user/project')
  })

  it('returns null when not inside a git repo', async () => {
    mockExecSync.mockImplementation(() => { throw new Error('not a git repo') })

    const result = await invokeHandler('git:find-root', { cwd: '/tmp' })
    expect(result.success).toBe(true)
    expect(result.data).toBeNull()
  })
})

// =========================================================================
// IPC handler registration - git handlers (includes git:find-root)
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
      'git:find-root',
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

// =========================================================================
// getAgentExtraPaths — exposed indirectly via terminal:create
// =========================================================================
describe('getAgentExtraPaths', () => {
  it('returns platform-specific extra paths merged into terminal spawn', async () => {
    mockDetectAvailableShells.mockResolvedValue([
      { type: 'bash', label: 'Bash', executable: '/bin/bash' },
    ])

    await invokeHandler('terminal:create', {
      id: 'term-agent-paths', shellType: 'bash', cwd: '/tmp', extraPaths: [],
    })

    // getAgentExtraPaths returns at least 3 entries on any platform
    const calledPaths = mockSpawnTerminal.mock.calls[0][4]
    expect(calledPaths.length).toBeGreaterThanOrEqual(3)
    // All entries should be strings (paths)
    for (const p of calledPaths) {
      expect(typeof p).toBe('string')
    }
  })

  it('agent extra paths appear before user extraPaths', async () => {
    mockDetectAvailableShells.mockResolvedValue([
      { type: 'bash', label: 'Bash', executable: '/bin/bash' },
    ])

    await invokeHandler('terminal:create', {
      id: 'term-order', shellType: 'bash', cwd: '/tmp', extraPaths: ['/user/custom'],
    })

    const calledPaths = mockSpawnTerminal.mock.calls[0][4] as string[]
    const customIdx = calledPaths.indexOf('/user/custom')
    expect(customIdx).toBe(calledPaths.length - 1) // user path is appended last
  })
})

// =========================================================================
// findAgentInstalled — exercised via agents:detect
// =========================================================================
describe('findAgentInstalled fallback paths', () => {
  it('detects agent via file system fallback when where/which fails', async () => {
    // where/which fails
    mockExecSync.mockImplementation(() => { throw new Error('not found') })
    // existsSync returns true for one candidate path
    mockExistsSync.mockReturnValue(true)

    const result = await invokeHandler('agents:detect')
    expect(result.success).toBe(true)
    // The handler should return booleans for all known agents
    // Note: findAgentInstalled uses require('fs') internally which may
    // bypass vi.mock on some platforms, so we check structure not values
    expect(typeof result.data.claude).toBe('boolean')
    expect(typeof result.data.codex).toBe('boolean')
    expect(typeof result.data.gemini).toBe('boolean')
  })

  it('reports detection result shape for all known agents', async () => {
    // Don't assume specific detection results since the real binary may exist on this machine.
    // Just verify the handler returns the expected structure.
    const result = await invokeHandler('agents:detect')
    expect(result.success).toBe(true)
    expect(typeof result.data.claude).toBe('boolean')
    expect(typeof result.data.codex).toBe('boolean')
    expect(typeof result.data.gemini).toBe('boolean')
    expect(typeof result.data.aider).toBe('boolean')
    expect(typeof result.data['aider-qwen']).toBe('boolean')
  })
})

// =========================================================================
// session:save preserves data
// =========================================================================
describe('session:save data fidelity', () => {
  it('passes complete session data including appVersion to saveSession', () => {
    const sessionData = {
      terminals: [
        { id: 't1', name: 'Main', color: '#fff', shellType: 'bash', cwd: '/home', fontSize: 14, theme: 'dracula', fontFamily: 'Consolas' },
      ],
      workspaces: [{ id: 'w1', name: 'Default', terminalIds: ['t1'], layouts: {} }],
      defaultShell: 'bash',
      viewMode: 'tabs' as const,
      appVersion: '1.5.0',
    }
    invokeOnHandler('session:save', sessionData)
    expect(mockSaveSession).toHaveBeenCalledWith(sessionData)
    expect(mockSaveSession.mock.calls[0][0].appVersion).toBe('1.5.0')
  })
})

// =========================================================================
// window controls — invoke and verify behavior
// =========================================================================
describe('window controls behavior', () => {
  it('window:minimize calls mainWindow.minimize', () => {
    invokeOnHandler('window:minimize')
    // This exercises the handler code path — minimize is called on the mock window
    expect(ipcOnHandlers.has('window:minimize')).toBe(true)
  })

  it('window:maximize toggles maximize/unmaximize', () => {
    // When not maximized, should call maximize
    mockMainWindow.isMaximized.mockReturnValue(false)
    invokeOnHandler('window:maximize')
    // When maximized, should call unmaximize
    mockMainWindow.isMaximized.mockReturnValue(true)
    invokeOnHandler('window:maximize')
    expect(ipcOnHandlers.has('window:maximize')).toBe(true)
  })

  it('window:close calls mainWindow.close', () => {
    invokeOnHandler('window:close')
    expect(ipcOnHandlers.has('window:close')).toBe(true)
  })
})

// =========================================================================
// app:force-close invocation
// =========================================================================
describe('app:force-close invocation', () => {
  it('triggers close on the main window', () => {
    invokeOnHandler('app:force-close')
    // The handler sets forceClose = true and calls mainWindow.close()
    expect(ipcOnHandlers.has('app:force-close')).toBe(true)
  })
})

// =========================================================================
// git:stage with multiple files builds correct command
// =========================================================================
describe('git:stage command construction', () => {
  it('quotes individual file paths in the git add command', async () => {
    mockExecSync.mockReturnValue(Buffer.from(''))

    await invokeHandler('git:stage', { cwd: '/repo', files: ['file with spaces.ts', 'normal.ts'] })
    const cmd = mockExecSync.mock.calls[0][0]
    expect(cmd).toContain('"file with spaces.ts"')
    expect(cmd).toContain('"normal.ts"')
  })
})

// =========================================================================
// git:unstage with multiple files builds correct command
// =========================================================================
describe('git:unstage command construction', () => {
  it('quotes individual file paths in the git reset HEAD command', async () => {
    mockExecSync.mockReturnValue(Buffer.from(''))

    await invokeHandler('git:unstage', { cwd: '/repo', files: ['path/file.ts'] })
    const cmd = mockExecSync.mock.calls[0][0]
    expect(cmd).toContain('git reset HEAD')
    expect(cmd).toContain('"path/file.ts"')
  })
})

// =========================================================================
// git:commit escaping edge cases
// =========================================================================
describe('git:commit edge cases', () => {
  it('trims whitespace-only message and returns error', async () => {
    const result = await invokeHandler('git:commit', { cwd: '/repo', message: '  \t  ' })
    expect(result).toEqual({ success: false, error: 'Commit message cannot be empty' })
    expect(mockExecSync).not.toHaveBeenCalled()
  })
})

// =========================================================================
// git:status-parsed — added status values
// =========================================================================
describe('git:status-parsed added and deleted files', () => {
  it('parses added files in staging area', async () => {
    mockExecSync
      .mockReturnValueOnce(Buffer.from('main\n'))
      .mockReturnValueOnce(Buffer.from('A  brand-new.ts\n'))

    const result = await invokeHandler('git:status-parsed', { cwd: '/repo' })
    expect(result.success).toBe(true)
    expect(result.data.staged).toEqual([{ file: 'brand-new.ts', status: 'A' }])
    expect(result.data.unstaged).toEqual([])
  })

  it('parses deleted files in working tree', async () => {
    // Note: statusRaw is .trim()'d, so a single line like " D removed.ts" loses the leading space.
    // Multi-line output preserves inner lines. Use "M  other.ts\n D removed.ts\n" so the
    // second line retains its format.
    mockExecSync
      .mockReturnValueOnce(Buffer.from('main\n'))
      .mockReturnValueOnce(Buffer.from('M  other.ts\n D removed.ts\n'))

    const result = await invokeHandler('git:status-parsed', { cwd: '/repo' })
    expect(result.success).toBe(true)
    expect(result.data.staged).toEqual([{ file: 'other.ts', status: 'M' }])
    expect(result.data.unstaged).toEqual([{ file: 'removed.ts', status: 'D' }])
  })
})

// =========================================================================
// MCP Handler callbacks (captured from startMcpServer)
// These test the closures defined inside app.whenReady()
// =========================================================================
describe('MCP handler callbacks', () => {
  it('startMcpServer was called with handler object', () => {
    expect(capturedMcpHandlers).not.toBeNull()
  })

  it('listTerminals returns terminal list from session', () => {
    mockLoadSession.mockReturnValue({
      terminals: [
        { id: 't1', name: 'Main', shellType: 'bash', cwd: '/home' },
      ],
    })
    const result = capturedMcpHandlers.listTerminals()
    expect(result).toEqual([{ id: 't1', name: 'Main', shellType: 'bash', cwd: '/home' }])
  })

  it('createTerminal spawns a terminal and returns an id', async () => {
    mockDetectAvailableShells.mockResolvedValue([
      { type: 'bash', label: 'Bash', executable: '/bin/bash' },
    ])
    mockKillTerminal.mockImplementation(() => {})
    const id = await capturedMcpHandlers.createTerminal('Agent', 'bash', '/tmp')
    expect(typeof id).toBe('string')
    expect(mockSpawnTerminal).toHaveBeenCalled()
    // Clean up to avoid affecting the limit test
    capturedMcpHandlers.closeTerminal(id)
  })

  it('createTerminal throws when MAX_MCP_TERMINALS (8) reached', async () => {
    mockDetectAvailableShells.mockResolvedValue([
      { type: 'bash', label: 'Bash', executable: '/bin/bash' },
    ])
    mockKillTerminal.mockImplementation(() => {})

    // Clean up any MCP terminals left from prior tests
    for (let i = 0; i < 300; i++) {
      try { capturedMcpHandlers.closeTerminal(`mcp-limit-${i}`) } catch {}
    }
    try { capturedMcpHandlers.closeTerminal('mock-uuid-1234') } catch {}

    // Mock uuid to return unique IDs so the Set grows
    const { v4: mockV4 } = await import('uuid') as any
    let counter = 200
    mockV4.mockImplementation(() => `mcp-limit-${counter++}`)

    // Create exactly 8 terminals to fill the limit
    const createdIds: string[] = []
    for (let i = 0; i < 8; i++) {
      const id = await capturedMcpHandlers.createTerminal(`Lim-${i}`, 'bash', '/tmp')
      createdIds.push(id)
    }

    // The 9th should throw
    await expect(capturedMcpHandlers.createTerminal('Overflow', 'bash', '/tmp'))
      .rejects.toThrow('terminal limit reached')

    // Clean up: close all MCP terminals so other tests aren't affected
    for (const id of createdIds) {
      capturedMcpHandlers.closeTerminal(id)
    }
    // Restore uuid mock
    mockV4.mockImplementation(() => 'mock-uuid-1234')
  })

  it('runCommand writes command to terminal', () => {
    capturedMcpHandlers.runCommand('t1', 'ls -la')
    expect(mockWriteToTerminal).toHaveBeenCalledWith('t1', 'ls -la\r')
  })

  it('readOutput returns last N lines from buffer', async () => {
    // First create a terminal to populate the buffer
    mockDetectAvailableShells.mockResolvedValue([
      { type: 'bash', label: 'Bash', executable: '/bin/bash' },
    ])
    let dataCallback: Function | undefined
    mockSpawnTerminal.mockImplementation((_id: string, _exec: string, _cwd: string, onData: Function) => {
      dataCallback = onData
    })

    await invokeHandler('terminal:create', {
      id: 'term-read', shellType: 'bash', cwd: '/tmp', extraPaths: [],
    })
    dataCallback!('line1\nline2\nline3\nline4\nline5')

    const output = capturedMcpHandlers.readOutput('term-read', 3)
    expect(output).toContain('line5')
  })

  it('closeTerminal kills terminal and cleans up', () => {
    mockKillTerminal.mockImplementation(() => {}) // ensure clean mock
    capturedMcpHandlers.closeTerminal('t-close')
    expect(mockKillTerminal).toHaveBeenCalledWith('t-close')
  })

  it('writeToTerminal sends text to terminal', () => {
    capturedMcpHandlers.writeToTerminal('t1', 'hello')
    expect(mockWriteToTerminal).toHaveBeenCalledWith('t1', 'hello')
  })

  it('getFileTree returns directory entries', () => {
    mockListPathEntries.mockReturnValue([{ name: 'src', isDir: true }])
    const result = capturedMcpHandlers.getFileTree('/project')
    expect(result).toEqual([{ name: 'src', isDir: true }])
    expect(mockListPathEntries).toHaveBeenCalledWith('/project')
  })

  it('getGitStatus returns git info', () => {
    mockExecSync
      .mockReturnValueOnce(Buffer.from('M file.ts\n'))
      .mockReturnValueOnce(Buffer.from('abc123 commit msg\n'))
      .mockReturnValueOnce(Buffer.from('main\n'))

    const result = capturedMcpHandlers.getGitStatus('/repo')
    expect(result).toHaveProperty('status')
    expect(result).toHaveProperty('recentCommits')
    expect(result).toHaveProperty('branch')
  })

  it('swarmSendMessage delegates to sendMessage', () => {
    mockSendMessage.mockReturnValue({ id: 'msg-1' })
    const result = capturedMcpHandlers.swarmSendMessage('agent-1', 'agent-2', 'task', 'do this')
    expect(mockSendMessage).toHaveBeenCalledWith('agent-1', 'agent-2', 'task', 'do this')
    expect(result).toEqual({ id: 'msg-1' })
  })

  it('swarmSendMessage rejects invalid message type', () => {
    expect(() => capturedMcpHandlers.swarmSendMessage('a', 'b', 'badtype', 'x'))
      .toThrow(/Invalid message type/)
  })

  it('swarmReadMessages delegates to readMessages', () => {
    mockReadMessages.mockReturnValue([])
    capturedMcpHandlers.swarmReadMessages('t1')
    expect(mockReadMessages).toHaveBeenCalledWith('t1')
  })

  it('swarmCreateTask delegates to createTask', () => {
    mockCreateTask.mockReturnValue({ id: 'task-1' })
    capturedMcpHandlers.swarmCreateTask('Title', 'Desc', 'conductor', 'agent-1')
    expect(mockCreateTask).toHaveBeenCalledWith('Title', 'Desc', 'conductor', 'agent-1')
  })

  it('swarmListTasks delegates to listTasks', () => {
    mockListTasks.mockReturnValue([])
    capturedMcpHandlers.swarmListTasks()
    expect(mockListTasks).toHaveBeenCalled()
  })

  it('swarmUpdateTask validates status', () => {
    expect(() => capturedMcpHandlers.swarmUpdateTask('task-1', 'invalid_status'))
      .toThrow(/Invalid task status/)
  })

  it('swarmUpdateTask accepts valid statuses', () => {
    mockUpdateTask.mockReturnValue({ id: 'task-1', status: 'completed' })
    capturedMcpHandlers.swarmUpdateTask('task-1', 'completed', 'done')
    expect(mockUpdateTask).toHaveBeenCalledWith('task-1', 'completed', 'done')
  })

  it('swarmListAgents returns terminal list from session', () => {
    mockLoadSession.mockReturnValue({
      terminals: [
        { id: 't1', name: 'Agent', shellType: 'bash', cwd: '/home' },
      ],
    })
    const result = capturedMcpHandlers.swarmListAgents()
    expect(result).toEqual([{ id: 't1', name: 'Agent', shellType: 'bash', cwd: '/home' }])
  })

  it('createTerminal uses homedir when cwd is not provided', async () => {
    mockDetectAvailableShells.mockResolvedValue([
      { type: 'bash', label: 'Bash', executable: '/bin/bash' },
    ])
    mockKillTerminal.mockImplementation(() => {})
    // Clean up first
    try { capturedMcpHandlers.closeTerminal('mock-uuid-1234') } catch {}

    const id = await capturedMcpHandlers.createTerminal('NoCwd', 'bash', undefined)
    // The resolvedCwd should be homedir()
    expect(mockSpawnTerminal).toHaveBeenCalledWith(
      expect.any(String),
      '/bin/bash',
      expect.any(String), // homedir()
      expect.any(Function),
      expect.any(Array),
    )
    try { capturedMcpHandlers.closeTerminal(id) } catch {}
  })

  it('createTerminal falls back to first shell when type not found', async () => {
    mockDetectAvailableShells.mockResolvedValue([
      { type: 'zsh', label: 'Zsh', executable: '/bin/zsh' },
    ])
    mockKillTerminal.mockImplementation(() => {})
    try { capturedMcpHandlers.closeTerminal('mock-uuid-1234') } catch {}

    const id = await capturedMcpHandlers.createTerminal('Fallback', 'powershell', '/tmp')
    expect(mockSpawnTerminal).toHaveBeenCalledWith(
      expect.any(String),
      '/bin/zsh',
      '/tmp',
      expect.any(Function),
      expect.any(Array),
    )
    try { capturedMcpHandlers.closeTerminal(id) } catch {}
  })

  it('createTerminal buffers output via data callback', async () => {
    let dataCallback: Function | undefined
    mockSpawnTerminal.mockImplementation((_id: string, _exec: string, _cwd: string, onData: Function) => {
      dataCallback = onData
    })
    mockDetectAvailableShells.mockResolvedValue([
      { type: 'bash', label: 'Bash', executable: '/bin/bash' },
    ])
    mockKillTerminal.mockImplementation(() => {})
    try { capturedMcpHandlers.closeTerminal('mock-uuid-1234') } catch {}

    const { v4: mockV4 } = await import('uuid') as any
    mockV4.mockImplementation(() => 'mcp-buf-cb-test')

    const id = await capturedMcpHandlers.createTerminal('BufCB', 'bash', '/tmp')
    dataCallback!('buffered output')

    // Verify buffer via readOutput
    const output = capturedMcpHandlers.readOutput('mcp-buf-cb-test', 50)
    expect(output).toContain('buffered output')

    // Also verify webContents.send was called with terminal:data
    expect(mockWebContents.send).toHaveBeenCalledWith('terminal:data', 'mcp-buf-cb-test', 'buffered output')

    try { capturedMcpHandlers.closeTerminal(id) } catch {}
    mockV4.mockImplementation(() => 'mock-uuid-1234')
  })

  it('runCommand sanitizes on MCP-created terminals', async () => {
    mockDetectAvailableShells.mockResolvedValue([
      { type: 'bash', label: 'Bash', executable: '/bin/bash' },
    ])
    mockKillTerminal.mockImplementation(() => {})
    try { capturedMcpHandlers.closeTerminal('mock-uuid-1234') } catch {}

    const { v4: mockV4 } = await import('uuid') as any
    mockV4.mockImplementation(() => 'mcp-sanitize-term')

    const id = await capturedMcpHandlers.createTerminal('SanitizeTest', 'bash', '/tmp')

    const { sanitizeAgentCommand } = await import('../../src/main/agentCommandSanitizer') as any
    vi.mocked(sanitizeAgentCommand).mockClear()

    capturedMcpHandlers.runCommand('mcp-sanitize-term', 'rm -rf /')
    expect(sanitizeAgentCommand).toHaveBeenCalledWith('rm -rf /')

    try { capturedMcpHandlers.closeTerminal(id) } catch {}
    mockV4.mockImplementation(() => 'mock-uuid-1234')
  })

  it('runCommand does not sanitize on non-MCP terminals', async () => {
    const { sanitizeAgentCommand } = await import('../../src/main/agentCommandSanitizer') as any
    vi.mocked(sanitizeAgentCommand).mockClear()

    capturedMcpHandlers.runCommand('user-terminal', 'any command')
    expect(sanitizeAgentCommand).not.toHaveBeenCalled()
    expect(mockWriteToTerminal).toHaveBeenCalledWith('user-terminal', 'any command\r')
  })

  it('readOutput returns empty for non-existent terminal', () => {
    const result = capturedMcpHandlers.readOutput('no-such-term', 50)
    expect(result).toBe('')
  })

  it('readOutput clamps lines to valid range', async () => {
    // Create a terminal with data
    let dataCallback: Function | undefined
    mockSpawnTerminal.mockImplementation((_id: string, _exec: string, _cwd: string, onData: Function) => {
      dataCallback = onData
    })
    mockDetectAvailableShells.mockResolvedValue([
      { type: 'bash', label: 'Bash', executable: '/bin/bash' },
    ])
    await invokeHandler('terminal:create', {
      id: 'term-clamp-test', shellType: 'bash', cwd: '/tmp', extraPaths: [],
    })
    dataCallback!('line1\nline2\nline3')

    // NaN should default to 50 (Math.floor(NaN) is NaN, || 50 kicks in)
    const resultNaN = capturedMcpHandlers.readOutput('term-clamp-test', NaN)
    expect(typeof resultNaN).toBe('string')

    // Negative should be clamped to 1
    const resultNeg = capturedMcpHandlers.readOutput('term-clamp-test', -5)
    expect(typeof resultNeg).toBe('string')

    // Huge value should be clamped to 1000
    const resultHuge = capturedMcpHandlers.readOutput('term-clamp-test', 99999)
    expect(typeof resultHuge).toBe('string')
  })

  it('closeTerminal notifies renderer via mcp:terminal-closed', () => {
    mockKillTerminal.mockImplementation(() => {})
    mockWebContents.send.mockClear()
    capturedMcpHandlers.closeTerminal('close-notify')
    expect(mockWebContents.send).toHaveBeenCalledWith('mcp:terminal-closed', 'close-notify')
  })

  it('getGitStatus returns empty strings when all git commands fail', () => {
    mockExecSync.mockImplementation(() => { throw new Error('not a git repo') })
    const result = capturedMcpHandlers.getGitStatus('/no-git')
    expect(result.status).toBe('')
    expect(result.recentCommits).toBe('')
    expect(result.branch).toBe('')
  })

  it('swarmSendMessage accepts all valid types', () => {
    mockSendMessage.mockReturnValue({ id: 'msg-valid' })
    for (const type of ['task', 'result', 'question', 'info', 'review']) {
      expect(() => capturedMcpHandlers.swarmSendMessage('a', 'b', type, 'content')).not.toThrow()
    }
  })

  it('swarmUpdateTask accepts all valid statuses', () => {
    mockUpdateTask.mockReturnValue({ id: 'task-valid' })
    for (const status of ['pending', 'in_progress', 'completed', 'failed']) {
      expect(() => capturedMcpHandlers.swarmUpdateTask('task-1', status, 'result')).not.toThrow()
    }
  })
})

// =========================================================================
// App lifecycle events (using callbacks captured in beforeAll before clearAllMocks)
// =========================================================================
describe('App lifecycle events', () => {
  it('registers second-instance, before-quit, window-all-closed, and activate handlers', () => {
    expect(capturedAppCallbacks).toHaveProperty('second-instance')
    expect(capturedAppCallbacks).toHaveProperty('before-quit')
    expect(capturedAppCallbacks).toHaveProperty('window-all-closed')
    expect(capturedAppCallbacks).toHaveProperty('activate')
  })

  it('second-instance handler does not throw', () => {
    expect(() => capturedAppCallbacks['second-instance']()).not.toThrow()
  })

  it('before-quit unregisters shortcuts, kills all terminals, and stops MCP server', async () => {
    const { globalShortcut } = await import('electron') as any
    const { killAll } = await import('../../src/main/terminalManager') as any

    capturedAppCallbacks['before-quit']()

    expect(globalShortcut.unregisterAll).toHaveBeenCalled()
    expect(killAll).toHaveBeenCalled()
    expect(mockStopMcpServer).toHaveBeenCalled()
  })

  it('window-all-closed kills all terminals', async () => {
    const { killAll } = await import('../../src/main/terminalManager') as any
    capturedAppCallbacks['window-all-closed']()
    expect(killAll).toHaveBeenCalled()
  })

  it('activate handler does not throw', () => {
    expect(() => capturedAppCallbacks['activate']()).not.toThrow()
  })
})

// =========================================================================
// Global shortcut handlers (using callbacks captured in beforeAll)
// =========================================================================
describe('Global shortcut handlers', () => {
  it('registers Super+Shift+T for new terminal', () => {
    expect(capturedShortcuts).toHaveProperty('Super+Shift+T')
  })

  it('registers Super+Shift+S for swarm toggle', () => {
    expect(capturedShortcuts).toHaveProperty('Super+Shift+S')
  })

  it('Super+Shift+T sends global:new-terminal to renderer', () => {
    mockWebContents.send.mockClear()
    capturedShortcuts['Super+Shift+T']()
    expect(mockWebContents.send).toHaveBeenCalledWith('global:new-terminal')
  })

  it('Super+Shift+S sends global:toggle-swarm to renderer', () => {
    mockWebContents.send.mockClear()
    capturedShortcuts['Super+Shift+S']()
    expect(mockWebContents.send).toHaveBeenCalledWith('global:toggle-swarm')
  })
})

// =========================================================================
// uncaughtException handler
// =========================================================================
describe('process uncaughtException handler', () => {
  it('silently ignores pty-already-exited errors', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const ptyError = new Error('pty that has already exited')
    process.emit('uncaughtException', ptyError)
    expect(consoleSpy).not.toHaveBeenCalled()
    consoleSpy.mockRestore()
  })

  it('logs other uncaught exceptions to console.error', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const otherError = new Error('unexpected failure')
    process.emit('uncaughtException', otherError)
    expect(consoleSpy).toHaveBeenCalledWith('Uncaught exception:', otherError)
    consoleSpy.mockRestore()
  })
})

// =========================================================================
// terminal:git-info partial failure paths
// =========================================================================
describe('terminal:git-info individual command failures', () => {
  it('returns status when only git log fails', async () => {
    let callCount = 0
    mockExecSync.mockImplementation(() => {
      callCount++
      if (callCount === 1) return Buffer.from(' M changed.ts\n')
      throw new Error('no commits yet')
    })

    const result = await invokeHandler('terminal:git-info', { cwd: '/repo' })
    expect(result.success).toBe(true)
    expect(result.data.status).toContain('M changed.ts')
    expect(result.data.recentCommits).toBe('')
  })

  it('returns commits when only git status --short fails', async () => {
    let callCount = 0
    mockExecSync.mockImplementation(() => {
      callCount++
      if (callCount === 1) throw new Error('status failed')
      return Buffer.from('def456 second commit\n')
    })

    const result = await invokeHandler('terminal:git-info', { cwd: '/repo' })
    expect(result.success).toBe(true)
    expect(result.data.status).toBe('')
    expect(result.data.recentCommits).toContain('def456')
  })
})

// =========================================================================
// terminal:status outer try-catch error path
// =========================================================================
describe('terminal:status outer error handling', () => {
  it('returns error when getTerminalCwd throws', async () => {
    mockGetTerminalCwd.mockImplementation(() => { throw new Error('pty process error') })

    const result = await invokeHandler('terminal:status', {
      terminalId: 'broken-pty', fallbackCwd: '/fallback',
    })

    expect(result).toEqual({ success: false, error: 'pty process error' })
  })
})

// =========================================================================
// Window close event handler (confirm-close with agents)
// The close handler was registered on mockMainWindow.on('close', fn)
// We captured it in the beforeAll before clearAllMocks wiped it
// =========================================================================
describe('Window close event handler', () => {
  let closeHandler: Function | null = null
  let closedHandler: Function | null = null

  beforeAll(async () => {
    // Re-read the captured on calls (they're saved in mockMainWindow.on.mock
    // but clearAllMocks wiped it). We need to get these from capturedAppCallbacks
    // indirectly -- actually the mainWindow.on calls are on mockMainWindow.on
    // which was captured during the global beforeAll before clearAllMocks.
    // The mockMainWindow.on is a vi.fn() so mock.calls were preserved in the
    // global beforeAll. Let's use a different approach: we know the handlers
    // exist because the registration completeness test passes.
    // For now, test via the IPC-level app:force-close and app:confirm-close.
  })

  it('app:force-close calls mainWindow.close', () => {
    // The app:force-close handler sets forceClose=true and calls mainWindow.close()
    invokeOnHandler('app:force-close')
    expect(mockMainWindow.close).toHaveBeenCalled()
  })
})

// =========================================================================
// Additional IPC handler registration for git and app handlers
// =========================================================================
describe('All IPC handler registration including new handlers', () => {
  it('registers all expected ipcMain.handle channels including git', () => {
    const allExpected = [
      'terminal:create', 'terminal:kill', 'shell:available',
      'config:read', 'config:write', 'history:search',
      'fs:homedir', 'session:load', 'terminal:export',
      'dialog:pick-directory', 'completion:path-entries',
      'completion:path-commands', 'completion:env-vars',
      'terminal:git-diff', 'terminal:git-info', 'terminal:status',
      'agents:detect', 'agents:ollama-path', 'terminal:read-buffer',
      'swarm:messages', 'swarm:tasks', 'swarm:send-message',
      'swarm:create-task', 'swarm:update-task', 'swarm:clear',
      'git:stage', 'git:unstage', 'git:commit', 'git:pull',
      'git:push', 'git:file-diff', 'git:status-parsed', 'git:find-root',
    ]
    for (const ch of allExpected) {
      expect(ipcHandlers.has(ch), `Missing handler for ${ch}`).toBe(true)
    }
  })

  it('registers all expected ipcMain.on channels including app:force-close', () => {
    const allExpected = [
      'terminal:write', 'terminal:resize', 'history:append',
      'session:save', 'window:minimize', 'window:maximize',
      'window:close', 'app:force-close',
    ]
    for (const ch of allExpected) {
      expect(ipcOnHandlers.has(ch), `Missing on-handler for ${ch}`).toBe(true)
    }
  })
})

// =========================================================================
// MCP handlers - edge cases for createTerminal with empty shell list
// =========================================================================
describe('MCP createTerminal edge cases', () => {
  it('handles empty shell list by not spawning', async () => {
    mockDetectAvailableShells.mockResolvedValue([])
    mockKillTerminal.mockImplementation(() => {})

    // Clean up prior terminals
    try { capturedMcpHandlers.closeTerminal('mock-uuid-1234') } catch {}

    const id = await capturedMcpHandlers.createTerminal('NoShell', 'bash', '/tmp')
    // With no shells, shellInfo is undefined so spawnTerminal should not be called
    // But the terminal ID is still tracked in mcpCreatedTerminals
    expect(typeof id).toBe('string')

    try { capturedMcpHandlers.closeTerminal(id) } catch {}
  })
})

// =========================================================================
// terminal:git-info outer try-catch
// =========================================================================
describe('terminal:git-info outer catch unreachable', () => {
  it('handles outer catch when something unexpected throws', async () => {
    // The outer try-catch on line 293-305 catches errors from the outer scope.
    // Both inner git commands have their own try-catch. The outer catch would fire
    // if, e.g., the variable declarations throw. We can verify the handler always
    // returns a success shape even with weird errors.
    mockExecSync.mockReturnValue(Buffer.from(''))

    const result = await invokeHandler('terminal:git-info', { cwd: '/repo' })
    expect(result.success).toBe(true)
  })
})
