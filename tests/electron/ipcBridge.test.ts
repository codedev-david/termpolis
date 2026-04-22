import { describe, it, expect, vi, beforeAll } from 'vitest'

// Capture what contextBridge.exposeInMainWorld registers
const exposed: Record<string, any> = {}
const mockInvoke = vi.fn().mockResolvedValue({ success: true })
const mockSend = vi.fn()
const mockOn = vi.fn().mockReturnValue(undefined)
const mockRemoveListener = vi.fn()

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, api: any) => {
      exposed[key] = api
    },
  },
  ipcRenderer: {
    invoke: mockInvoke,
    send: mockSend,
    on: mockOn,
    removeListener: mockRemoveListener,
  },
}))

// Import the preload as a side effect — it calls exposeInMainWorld on load
beforeAll(async () => {
  vi.resetModules()
  await import('../../src/preload/index')
})

// ---------------------------------------------------------------------------
// window.termpolis (TermpolisAPI)
// ---------------------------------------------------------------------------
describe('window.termpolis IPC channels', () => {
  it('createTerminal invokes terminal:create', async () => {
    await exposed.termpolis.createTerminal('id-1', 'bash', '/tmp', [])
    expect(mockInvoke).toHaveBeenCalledWith('terminal:create', {
      id: 'id-1', shellType: 'bash', cwd: '/tmp', extraPaths: [],
    })
  })

  it('killTerminal invokes terminal:kill', async () => {
    await exposed.termpolis.killTerminal('id-1')
    expect(mockInvoke).toHaveBeenCalledWith('terminal:kill', { id: 'id-1' })
  })

  it('writeToTerminal sends terminal:write', () => {
    exposed.termpolis.writeToTerminal('id-1', 'ls -la\r')
    expect(mockSend).toHaveBeenCalledWith('terminal:write', { id: 'id-1', data: 'ls -la\r' })
  })

  it('resizeTerminal sends terminal:resize', () => {
    exposed.termpolis.resizeTerminal('id-1', 80, 24)
    expect(mockSend).toHaveBeenCalledWith('terminal:resize', { id: 'id-1', cols: 80, rows: 24 })
  })

  it('readTerminalBuffer invokes terminal:read-buffer', async () => {
    await exposed.termpolis.readTerminalBuffer('id-1', 100)
    expect(mockInvoke).toHaveBeenCalledWith('terminal:read-buffer', {
      terminalId: 'id-1', fromOffset: 100,
    })
  })

  it('getAvailableShells invokes shell:available', async () => {
    await exposed.termpolis.getAvailableShells()
    expect(mockInvoke).toHaveBeenCalledWith('shell:available')
  })

  it('readConfigFile invokes config:read', async () => {
    await exposed.termpolis.readConfigFile('/path/to/file')
    expect(mockInvoke).toHaveBeenCalledWith('config:read', { filePath: '/path/to/file' })
  })

  it('writeConfigFile invokes config:write', async () => {
    await exposed.termpolis.writeConfigFile('/path/to/file', 'content')
    expect(mockInvoke).toHaveBeenCalledWith('config:write', {
      filePath: '/path/to/file', content: 'content',
    })
  })

  it('getHomedir invokes fs:homedir', async () => {
    await exposed.termpolis.getHomedir()
    expect(mockInvoke).toHaveBeenCalledWith('fs:homedir')
  })

  it('getMcpConfigPath invokes fs:mcp-config-path', async () => {
    await exposed.termpolis.getMcpConfigPath()
    expect(mockInvoke).toHaveBeenCalledWith('fs:mcp-config-path')
  })

  it('detectAgents invokes agents:detect', async () => {
    await exposed.termpolis.detectAgents()
    expect(mockInvoke).toHaveBeenCalledWith('agents:detect')
  })

  it('pickDirectory invokes dialog:pick-directory', async () => {
    await exposed.termpolis.pickDirectory('/default')
    expect(mockInvoke).toHaveBeenCalledWith('dialog:pick-directory', { defaultPath: '/default' })
  })

  it('appendHistory sends history:append', () => {
    exposed.termpolis.appendHistory('t1', 'Main', 'git status')
    expect(mockSend).toHaveBeenCalledWith('history:append', {
      terminalId: 't1', terminalName: 'Main', command: 'git status',
    })
  })

  it('searchHistory invokes history:search', async () => {
    await exposed.termpolis.searchHistory('git')
    expect(mockInvoke).toHaveBeenCalledWith('history:search', { query: 'git' })
  })

  it('onTerminalData registers terminal:data listener and returns unsubscribe', () => {
    const cb = vi.fn()
    const unsub = exposed.termpolis.onTerminalData(cb)
    expect(mockOn).toHaveBeenCalledWith('terminal:data', expect.any(Function))
    expect(typeof unsub).toBe('function')
    unsub()
    expect(mockRemoveListener).toHaveBeenCalledWith('terminal:data', expect.any(Function))
  })

  it('getTerminalStatus invokes terminal:status', async () => {
    await exposed.termpolis.getTerminalStatus('t1', '/cwd')
    expect(mockInvoke).toHaveBeenCalledWith('terminal:status', {
      terminalId: 't1', fallbackCwd: '/cwd',
    })
  })

  it('getGitInfo invokes terminal:git-info', async () => {
    await exposed.termpolis.getGitInfo('/repo')
    expect(mockInvoke).toHaveBeenCalledWith('terminal:git-info', { cwd: '/repo' })
  })

  it('getGitDiff invokes terminal:git-diff', async () => {
    await exposed.termpolis.getGitDiff('/repo')
    expect(mockInvoke).toHaveBeenCalledWith('terminal:git-diff', { cwd: '/repo' })
  })
})

// ---------------------------------------------------------------------------
// window.swarmAPI
// ---------------------------------------------------------------------------
describe('window.swarmAPI IPC channels', () => {
  it('getMessages invokes swarm:messages', async () => {
    await exposed.swarmAPI.getMessages()
    expect(mockInvoke).toHaveBeenCalledWith('swarm:messages')
  })

  it('getTasks invokes swarm:tasks', async () => {
    await exposed.swarmAPI.getTasks()
    expect(mockInvoke).toHaveBeenCalledWith('swarm:tasks')
  })

  it('sendMessage invokes swarm:send-message with correct params', async () => {
    await exposed.swarmAPI.sendMessage('conductor', 'all', 'info', 'hello')
    expect(mockInvoke).toHaveBeenCalledWith('swarm:send-message', {
      from: 'conductor', to: 'all', type: 'info', content: 'hello',
    })
  })

  it('createTask invokes swarm:create-task', async () => {
    await exposed.swarmAPI.createTask('Build feature', 'desc', 'conductor', 'agent-1')
    expect(mockInvoke).toHaveBeenCalledWith('swarm:create-task', {
      title: 'Build feature', description: 'desc',
      createdBy: 'conductor', assignTo: 'agent-1',
    })
  })

  it('updateTask invokes swarm:update-task', async () => {
    await exposed.swarmAPI.updateTask('task-1', 'completed', 'done')
    expect(mockInvoke).toHaveBeenCalledWith('swarm:update-task', {
      taskId: 'task-1', status: 'completed', result: 'done',
    })
  })

  it('clear invokes swarm:clear', async () => {
    await exposed.swarmAPI.clear()
    expect(mockInvoke).toHaveBeenCalledWith('swarm:clear')
  })
})

// ---------------------------------------------------------------------------
// window.globalEvents
// ---------------------------------------------------------------------------
describe('window.globalEvents IPC channels', () => {
  it('onToggleSwarm registers global:toggle-swarm listener', () => {
    const cb = vi.fn()
    const unsub = exposed.globalEvents.onToggleSwarm(cb)
    expect(mockOn).toHaveBeenCalledWith('global:toggle-swarm', expect.any(Function))
    expect(typeof unsub).toBe('function')
  })

  it('onNewTerminal registers global:new-terminal listener', () => {
    exposed.globalEvents.onNewTerminal(vi.fn())
    expect(mockOn).toHaveBeenCalledWith('global:new-terminal', expect.any(Function))
  })

  it('onConfirmClose registers app:confirm-close listener', () => {
    exposed.globalEvents.onConfirmClose(vi.fn())
    expect(mockOn).toHaveBeenCalledWith('app:confirm-close', expect.any(Function))
  })

  it('forceClose sends app:force-close', () => {
    exposed.globalEvents.forceClose()
    expect(mockSend).toHaveBeenCalledWith('app:force-close')
  })

  it('unsubscribe function removes the correct listener', () => {
    const cb = vi.fn()
    const unsub = exposed.globalEvents.onToggleSwarm(cb)
    unsub()
    expect(mockRemoveListener).toHaveBeenCalledWith('global:toggle-swarm', expect.any(Function))
  })
})

// ---------------------------------------------------------------------------
// window.windowControls
// ---------------------------------------------------------------------------
describe('window.windowControls IPC channels', () => {
  it('minimize sends window:minimize', () => {
    exposed.windowControls.minimize()
    expect(mockSend).toHaveBeenCalledWith('window:minimize')
  })

  it('maximize sends window:maximize', () => {
    exposed.windowControls.maximize()
    expect(mockSend).toHaveBeenCalledWith('window:maximize')
  })

  it('close sends window:close', () => {
    exposed.windowControls.close()
    expect(mockSend).toHaveBeenCalledWith('window:close')
  })
})

// ---------------------------------------------------------------------------
// window.mcpEvents
// ---------------------------------------------------------------------------
describe('window.mcpEvents IPC channels', () => {
  it('onTerminalCreated registers mcp:terminal-created listener', () => {
    exposed.mcpEvents.onTerminalCreated(vi.fn())
    expect(mockOn).toHaveBeenCalledWith('mcp:terminal-created', expect.any(Function))
  })

  it('onTerminalClosed registers mcp:terminal-closed listener', () => {
    exposed.mcpEvents.onTerminalClosed(vi.fn())
    expect(mockOn).toHaveBeenCalledWith('mcp:terminal-closed', expect.any(Function))
  })
})
