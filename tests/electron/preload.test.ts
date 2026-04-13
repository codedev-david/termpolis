import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Track what gets exposed via contextBridge
// ---------------------------------------------------------------------------
const exposed: Record<string, any> = {}

const mockIpcRenderer = {
  invoke: vi.fn().mockResolvedValue({ success: true }),
  send: vi.fn(),
  on: vi.fn((_channel: string, handler: Function) => handler),
  removeListener: vi.fn(),
}

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: vi.fn((key: string, api: any) => {
      exposed[key] = api
    }),
  },
  ipcRenderer: {
    invoke: (...args: any[]) => mockIpcRenderer.invoke(...args),
    send: (...args: any[]) => mockIpcRenderer.send(...args),
    on: (...args: any[]) => mockIpcRenderer.on(...args),
    removeListener: (...args: any[]) => mockIpcRenderer.removeListener(...args),
  },
}))

// Import preload — side effect registers everything
await import('../../src/preload/index')

beforeEach(() => {
  vi.clearAllMocks()
})

describe('preload: termpolis API', () => {
  it('exposes termpolis on the window', () => {
    expect(exposed.termpolis).toBeDefined()
  })

  it('createTerminal invokes terminal:create', async () => {
    await exposed.termpolis.createTerminal('id1', 'bash', '/tmp', [])
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('terminal:create', {
      id: 'id1', shellType: 'bash', cwd: '/tmp', extraPaths: [],
    })
  })

  it('killTerminal invokes terminal:kill', async () => {
    await exposed.termpolis.killTerminal('id1')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('terminal:kill', { id: 'id1' })
  })

  it('writeToTerminal sends terminal:write', () => {
    exposed.termpolis.writeToTerminal('id1', 'ls\r')
    expect(mockIpcRenderer.send).toHaveBeenCalledWith('terminal:write', { id: 'id1', data: 'ls\r' })
  })

  it('resizeTerminal sends terminal:resize', () => {
    exposed.termpolis.resizeTerminal('id1', 120, 40)
    expect(mockIpcRenderer.send).toHaveBeenCalledWith('terminal:resize', { id: 'id1', cols: 120, rows: 40 })
  })

  it('onTerminalData registers listener and returns cleanup', () => {
    const cb = vi.fn()
    const cleanup = exposed.termpolis.onTerminalData(cb)
    expect(mockIpcRenderer.on).toHaveBeenCalledWith('terminal:data', expect.any(Function))
    expect(typeof cleanup).toBe('function')
  })

  it('getAvailableShells invokes shell:available', async () => {
    await exposed.termpolis.getAvailableShells()
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('shell:available')
  })

  it('readConfigFile invokes config:read', async () => {
    await exposed.termpolis.readConfigFile('/path/file')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('config:read', { filePath: '/path/file' })
  })

  it('writeConfigFile invokes config:write', async () => {
    await exposed.termpolis.writeConfigFile('/path/file', 'content')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('config:write', { filePath: '/path/file', content: 'content' })
  })

  it('appendHistory sends history:append', () => {
    exposed.termpolis.appendHistory('t1', 'Main', 'git status')
    expect(mockIpcRenderer.send).toHaveBeenCalledWith('history:append', {
      terminalId: 't1', terminalName: 'Main', command: 'git status',
    })
  })

  it('searchHistory invokes history:search', async () => {
    await exposed.termpolis.searchHistory('git')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('history:search', { query: 'git' })
  })

  it('getHomedir invokes fs:homedir', async () => {
    await exposed.termpolis.getHomedir()
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('fs:homedir')
  })

  it('loadSession invokes session:load', async () => {
    await exposed.termpolis.loadSession()
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('session:load')
  })

  it('saveSession sends session:save', () => {
    const data = { terminals: [], workspaces: [] }
    exposed.termpolis.saveSession(data)
    expect(mockIpcRenderer.send).toHaveBeenCalledWith('session:save', data)
  })

  it('exportTerminal invokes terminal:export', async () => {
    await exposed.termpolis.exportTerminal({ content: 'x', defaultFilename: 'f.txt' })
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('terminal:export', { content: 'x', defaultFilename: 'f.txt' })
  })

  it('detectAgents invokes agents:detect', async () => {
    await exposed.termpolis.detectAgents()
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('agents:detect')
  })

  it('getOllamaPath invokes agents:ollama-path', async () => {
    await exposed.termpolis.getOllamaPath()
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('agents:ollama-path')
  })

  it('pickDirectory invokes dialog:pick-directory', async () => {
    await exposed.termpolis.pickDirectory('/home')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('dialog:pick-directory', { defaultPath: '/home' })
  })

  it('completionPathEntries invokes completion:path-entries', async () => {
    await exposed.termpolis.completionPathEntries('/src')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('completion:path-entries', { dirPath: '/src' })
  })

  it('completionPathCommands invokes completion:path-commands', async () => {
    await exposed.termpolis.completionPathCommands()
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('completion:path-commands')
  })

  it('completionEnvVars invokes completion:env-vars', async () => {
    await exposed.termpolis.completionEnvVars()
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('completion:env-vars')
  })

  it('getTerminalStatus invokes terminal:status', async () => {
    await exposed.termpolis.getTerminalStatus('t1', '/fallback')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('terminal:status', { terminalId: 't1', fallbackCwd: '/fallback' })
  })

  it('getGitInfo invokes terminal:git-info', async () => {
    await exposed.termpolis.getGitInfo('/repo')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('terminal:git-info', { cwd: '/repo' })
  })

  it('getGitDiff invokes terminal:git-diff', async () => {
    await exposed.termpolis.getGitDiff('/repo')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('terminal:git-diff', { cwd: '/repo' })
  })

  it('readTerminalBuffer invokes terminal:read-buffer', async () => {
    await exposed.termpolis.readTerminalBuffer('t1', 100)
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('terminal:read-buffer', { terminalId: 't1', fromOffset: 100 })
  })

  // --- Git methods ---

  it('gitStatusParsed invokes git:status-parsed', async () => {
    await exposed.termpolis.gitStatusParsed('/repo')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('git:status-parsed', { cwd: '/repo' })
  })

  it('gitStage invokes git:stage', async () => {
    await exposed.termpolis.gitStage('/repo', ['file.ts'])
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('git:stage', { cwd: '/repo', files: ['file.ts'] })
  })

  it('gitUnstage invokes git:unstage', async () => {
    await exposed.termpolis.gitUnstage('/repo', ['file.ts'])
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('git:unstage', { cwd: '/repo', files: ['file.ts'] })
  })

  it('gitCommit invokes git:commit', async () => {
    await exposed.termpolis.gitCommit('/repo', 'fix: bug')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('git:commit', { cwd: '/repo', message: 'fix: bug' })
  })

  it('gitPull invokes git:pull', async () => {
    await exposed.termpolis.gitPull('/repo')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('git:pull', { cwd: '/repo' })
  })

  it('gitPush invokes git:push', async () => {
    await exposed.termpolis.gitPush('/repo')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('git:push', { cwd: '/repo' })
  })

  it('gitFileDiff invokes git:file-diff', async () => {
    await exposed.termpolis.gitFileDiff('/repo', 'src/a.ts')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('git:file-diff', { cwd: '/repo', file: 'src/a.ts' })
  })
})

describe('preload: windowControls API', () => {
  it('exposes windowControls on the window', () => {
    expect(exposed.windowControls).toBeDefined()
  })

  it('minimize sends window:minimize', () => {
    exposed.windowControls.minimize()
    expect(mockIpcRenderer.send).toHaveBeenCalledWith('window:minimize')
  })

  it('maximize sends window:maximize', () => {
    exposed.windowControls.maximize()
    expect(mockIpcRenderer.send).toHaveBeenCalledWith('window:maximize')
  })

  it('close sends window:close', () => {
    exposed.windowControls.close()
    expect(mockIpcRenderer.send).toHaveBeenCalledWith('window:close')
  })
})

describe('preload: globalEvents API', () => {
  it('exposes globalEvents on the window', () => {
    expect(exposed.globalEvents).toBeDefined()
  })

  it('onNewTerminal registers listener and returns cleanup', () => {
    const cb = vi.fn()
    const cleanup = exposed.globalEvents.onNewTerminal(cb)
    expect(mockIpcRenderer.on).toHaveBeenCalledWith('global:new-terminal', expect.any(Function))
    expect(typeof cleanup).toBe('function')
  })

  it('onToggleSwarm registers listener and returns cleanup', () => {
    const cb = vi.fn()
    const cleanup = exposed.globalEvents.onToggleSwarm(cb)
    expect(mockIpcRenderer.on).toHaveBeenCalledWith('global:toggle-swarm', expect.any(Function))
    expect(typeof cleanup).toBe('function')
  })

  it('onConfirmClose registers listener and returns cleanup', () => {
    const cb = vi.fn()
    const cleanup = exposed.globalEvents.onConfirmClose(cb)
    expect(mockIpcRenderer.on).toHaveBeenCalledWith('app:confirm-close', expect.any(Function))
    expect(typeof cleanup).toBe('function')
  })

  it('forceClose sends app:force-close', () => {
    exposed.globalEvents.forceClose()
    expect(mockIpcRenderer.send).toHaveBeenCalledWith('app:force-close')
  })
})

describe('preload: swarmAPI', () => {
  it('exposes swarmAPI on the window', () => {
    expect(exposed.swarmAPI).toBeDefined()
  })

  it('getMessages invokes swarm:messages', async () => {
    await exposed.swarmAPI.getMessages()
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('swarm:messages')
  })

  it('getTasks invokes swarm:tasks', async () => {
    await exposed.swarmAPI.getTasks()
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('swarm:tasks')
  })

  it('sendMessage invokes swarm:send-message', async () => {
    await exposed.swarmAPI.sendMessage('from', 'to', 'info', 'hello')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('swarm:send-message', {
      from: 'from', to: 'to', type: 'info', content: 'hello',
    })
  })

  it('createTask invokes swarm:create-task', async () => {
    await exposed.swarmAPI.createTask('title', 'desc', 'creator', 'assignee')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('swarm:create-task', {
      title: 'title', description: 'desc', createdBy: 'creator', assignTo: 'assignee',
    })
  })

  it('updateTask invokes swarm:update-task', async () => {
    await exposed.swarmAPI.updateTask('t1', 'completed', 'result')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('swarm:update-task', {
      taskId: 't1', status: 'completed', result: 'result',
    })
  })

  it('clear invokes swarm:clear', async () => {
    await exposed.swarmAPI.clear()
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('swarm:clear')
  })
})

describe('preload: mcpEvents', () => {
  it('exposes mcpEvents on the window', () => {
    expect(exposed.mcpEvents).toBeDefined()
  })

  it('onTerminalCreated registers listener and returns cleanup', () => {
    const cb = vi.fn()
    const cleanup = exposed.mcpEvents.onTerminalCreated(cb)
    expect(mockIpcRenderer.on).toHaveBeenCalledWith('mcp:terminal-created', expect.any(Function))
    expect(typeof cleanup).toBe('function')
  })

  it('onTerminalClosed registers listener and returns cleanup', () => {
    const cb = vi.fn()
    const cleanup = exposed.mcpEvents.onTerminalClosed(cb)
    expect(mockIpcRenderer.on).toHaveBeenCalledWith('mcp:terminal-closed', expect.any(Function))
    expect(typeof cleanup).toBe('function')
  })
})
