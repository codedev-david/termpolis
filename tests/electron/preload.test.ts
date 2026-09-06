import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Track what gets exposed via contextBridge
// ---------------------------------------------------------------------------
const exposed: Record<string, any> = {}

const mockIpcRenderer = {
  invoke: vi.fn().mockResolvedValue({ success: true }),
  send: vi.fn(),
  sendSync: vi.fn(() => ({ platform: 'win32', windowsPty: { backend: 'conpty', buildNumber: 22631 } })),
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
    sendSync: (...args: any[]) => mockIpcRenderer.sendSync(...args),
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

  it('exposes platformInfo, resolved synchronously at load (xterm windowsPty source)', () => {
    // sendSync returns a payload → platformInfo carries it straight through, so
    // the renderer can hand xterm the Windows ConPTY backend at Terminal construction.
    expect(exposed.termpolis.platformInfo).toEqual({
      platform: 'win32',
      windowsPty: { backend: 'conpty', buildNumber: 22631 },
    })
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

  it('getMcpConfigPath invokes fs:mcp-config-path', async () => {
    await exposed.termpolis.getMcpConfigPath()
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('fs:mcp-config-path')
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

  it('clearTerminalBuffer invokes terminal:clear, keying the id as `terminalId`', async () => {
    // The main handler destructures `{ terminalId }` and answers err() for anything
    // else, so the KEY NAME is the contract: an `{ id }` payload (the shape
    // createTerminal/killTerminal use) would be rejected and the transcript would come
    // straight back on the next TerminalPane mount, with no error the user can see.
    await exposed.termpolis.clearTerminalBuffer('t1')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('terminal:clear', { terminalId: 't1' })
  })

  // --- App log (the app's own output, surfaced by the Ctrl+Shift+O viewer) ---

  it('readAppLog invokes app-log:read with the requested limit', async () => {
    await exposed.termpolis.readAppLog(250)
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('app-log:read', { limit: 250 })
  })

  it('readAppLog with no argument still sends a payload and invents no limit of its own', async () => {
    // `limit` is optional in the type, and main answers an absent one with its own
    // default of 500. A wrapper that threw on undefined — or quietly substituted a
    // number here — would make that default unreachable and put the size of the log
    // window in two places at once.
    await exposed.termpolis.readAppLog()
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('app-log:read', { limit: undefined })
  })

  it('clearAppLog invokes app-log:clear with no payload', async () => {
    await exposed.termpolis.clearAppLog()
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('app-log:clear')
  })

  it('appLogPath invokes app-log:path with no payload', async () => {
    await exposed.termpolis.appLogPath()
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('app-log:path')
  })

  it('writeAppLog SENDS app-log:append — fire-and-forget, never invoke', () => {
    // Every console.* in the renderer is funnelled through this one wrapper. `invoke`
    // would put an IPC round trip (and a floating promise) inside every log line in the
    // app, so a chatty render would be paying main-process latency to say something
    // nobody is waiting for. `send` is the entire reason this method is not a Promise.
    exposed.termpolis.writeAppLog('warn', 'shell probe timed out')
    expect(mockIpcRenderer.send).toHaveBeenCalledWith('app-log:append', {
      level: 'warn', message: 'shell probe timed out',
    })
    expect(mockIpcRenderer.invoke).not.toHaveBeenCalled()
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

describe('preload: termpolisTestFlags', () => {
  it('ferries the E2E switches across, since the renderer has no process of its own', () => {
    expect(exposed.termpolisTestFlags).toBeDefined()
    // Plain booleans, both off in a normal (non-E2E) run.
    expect(exposed.termpolisTestFlags).toEqual({ agents: false, timing: false })
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

describe('preload: termpolis API — additional methods', () => {
  it('openPath invokes shell:open-path', async () => {
    await exposed.termpolis.openPath('/some/path')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('shell:open-path', { path: '/some/path' })
  })

  it('gitFindRoot invokes git:find-root', async () => {
    await exposed.termpolis.gitFindRoot('/repo')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('git:find-root', { cwd: '/repo' })
  })

  it('onTerminalData cleanup removes the listener', () => {
    const cb = vi.fn()
    const cleanup = exposed.termpolis.onTerminalData(cb)
    cleanup()
    expect(mockIpcRenderer.removeListener).toHaveBeenCalledWith('terminal:data', expect.any(Function))
  })

  it('onTerminalData handler invokes callback with id and data', () => {
    const cb = vi.fn()
    exposed.termpolis.onTerminalData(cb)
    // Grab the handler that was registered
    const registeredHandler = mockIpcRenderer.on.mock.calls.find((c: any) => c[0] === 'terminal:data')?.[1]
    registeredHandler({}, 'tid-1', 'output-data')
    expect(cb).toHaveBeenCalledWith('tid-1', 'output-data')
  })
})

describe('preload: globalEvents cleanup handlers', () => {
  it('onNewTerminal cleanup removes listener', () => {
    const cleanup = exposed.globalEvents.onNewTerminal(vi.fn())
    cleanup()
    expect(mockIpcRenderer.removeListener).toHaveBeenCalledWith('global:new-terminal', expect.any(Function))
  })

  it('onNewTerminal invokes callback on event', () => {
    const cb = vi.fn()
    exposed.globalEvents.onNewTerminal(cb)
    const handler = mockIpcRenderer.on.mock.calls.find((c: any) => c[0] === 'global:new-terminal')?.[1]
    handler()
    expect(cb).toHaveBeenCalled()
  })

  it('onToggleSwarm cleanup removes listener', () => {
    const cleanup = exposed.globalEvents.onToggleSwarm(vi.fn())
    cleanup()
    expect(mockIpcRenderer.removeListener).toHaveBeenCalledWith('global:toggle-swarm', expect.any(Function))
  })

  it('onToggleSwarm invokes callback on event', () => {
    const cb = vi.fn()
    exposed.globalEvents.onToggleSwarm(cb)
    const handler = mockIpcRenderer.on.mock.calls.find((c: any) => c[0] === 'global:toggle-swarm')?.[1]
    handler()
    expect(cb).toHaveBeenCalled()
  })

  it('onConfirmClose cleanup removes listener', () => {
    const cleanup = exposed.globalEvents.onConfirmClose(vi.fn())
    cleanup()
    expect(mockIpcRenderer.removeListener).toHaveBeenCalledWith('app:confirm-close', expect.any(Function))
  })

  it('onConfirmClose invokes callback on event', () => {
    const cb = vi.fn()
    exposed.globalEvents.onConfirmClose(cb)
    const handler = mockIpcRenderer.on.mock.calls.find((c: any) => c[0] === 'app:confirm-close')?.[1]
    handler()
    expect(cb).toHaveBeenCalled()
  })
})

describe('preload: mcpEvents cleanup handlers', () => {
  it('onTerminalCreated cleanup removes listener', () => {
    const cleanup = exposed.mcpEvents.onTerminalCreated(vi.fn())
    cleanup()
    expect(mockIpcRenderer.removeListener).toHaveBeenCalledWith('mcp:terminal-created', expect.any(Function))
  })

  it('onTerminalCreated invokes callback with data', () => {
    const cb = vi.fn()
    exposed.mcpEvents.onTerminalCreated(cb)
    const handler = mockIpcRenderer.on.mock.calls.find((c: any) => c[0] === 'mcp:terminal-created')?.[1]
    handler({}, { id: 'x', name: 'n', shell: 'bash', cwd: '/home' })
    expect(cb).toHaveBeenCalledWith({ id: 'x', name: 'n', shell: 'bash', cwd: '/home' })
  })

  it('onTerminalClosed cleanup removes listener', () => {
    const cleanup = exposed.mcpEvents.onTerminalClosed(vi.fn())
    cleanup()
    expect(mockIpcRenderer.removeListener).toHaveBeenCalledWith('mcp:terminal-closed', expect.any(Function))
  })

  it('onTerminalClosed invokes callback with id', () => {
    const cb = vi.fn()
    exposed.mcpEvents.onTerminalClosed(cb)
    const handler = mockIpcRenderer.on.mock.calls.find((c: any) => c[0] === 'mcp:terminal-closed')?.[1]
    handler({}, 'term-id')
    expect(cb).toHaveBeenCalledWith('term-id')
  })
})

describe('preload: contextPins API', () => {
  it('list invokes contextPins:list', async () => {
    await exposed.contextPins.list('/cwd')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('contextPins:list', { cwd: '/cwd' })
  })

  it('add invokes contextPins:add', async () => {
    const input = { label: 'L', body: 'B' }
    await exposed.contextPins.add('/cwd', input)
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('contextPins:add', { cwd: '/cwd', input })
  })

  it('update invokes contextPins:update', async () => {
    const patch = { label: 'New' }
    await exposed.contextPins.update('/cwd', 'pin-1', patch)
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('contextPins:update', { cwd: '/cwd', id: 'pin-1', patch })
  })

  it('remove invokes contextPins:remove', async () => {
    await exposed.contextPins.remove('/cwd', 'pin-1')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('contextPins:remove', { cwd: '/cwd', id: 'pin-1' })
  })

  it('clear invokes contextPins:clear', async () => {
    await exposed.contextPins.clear('/cwd')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('contextPins:clear', { cwd: '/cwd' })
  })
})

describe('preload: telemetry API', () => {
  it('setTelemetryOptIn invokes telemetry:set-opt-in with value', async () => {
    await exposed.termpolis.setTelemetryOptIn(true)
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('telemetry:set-opt-in', { value: true })
  })

  it('setTelemetryOptIn passes false through unchanged', async () => {
    await exposed.termpolis.setTelemetryOptIn(false)
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('telemetry:set-opt-in', { value: false })
  })

  it('getTelemetryOptIn invokes telemetry:get-opt-in', async () => {
    await exposed.termpolis.getTelemetryOptIn()
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('telemetry:get-opt-in')
  })

  it('recordTelemetryEvent invokes telemetry:record-event with name + props', async () => {
    await exposed.termpolis.recordTelemetryEvent('feature.click', { area: 'sidebar' })
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('telemetry:record-event', {
      name: 'feature.click',
      props: { area: 'sidebar' },
    })
  })

  it('recordTelemetryEvent with no props sends undefined', async () => {
    await exposed.termpolis.recordTelemetryEvent('boot')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('telemetry:record-event', {
      name: 'boot',
      props: undefined,
    })
  })
})

describe('preload: agentActivity API', () => {
  it('query invokes agentActivity:query', async () => {
    await exposed.agentActivity.query({ limit: 50 })
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('agentActivity:query', { filter: { limit: 50 } })
  })

  it('query with no filter still invokes', async () => {
    await exposed.agentActivity.query()
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('agentActivity:query', { filter: undefined })
  })

  it('stats invokes agentActivity:stats', async () => {
    await exposed.agentActivity.stats()
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('agentActivity:stats')
  })

  it('attachWatcher invokes agentWatcher:attach', async () => {
    await exposed.agentActivity.attachWatcher('t1', '/cwd', 'claude')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('agentWatcher:attach', { terminalId: 't1', cwd: '/cwd', agentType: 'claude' })
  })

  it('detachWatcher invokes agentWatcher:detach', async () => {
    await exposed.agentActivity.detachWatcher('t1')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('agentWatcher:detach', { terminalId: 't1' })
  })

  it('onEvent registers and cleanup removes', () => {
    const cleanup = exposed.agentActivity.onEvent(vi.fn())
    expect(mockIpcRenderer.on).toHaveBeenCalledWith('agentActivity:event', expect.any(Function))
    cleanup()
    expect(mockIpcRenderer.removeListener).toHaveBeenCalledWith('agentActivity:event', expect.any(Function))
  })

  it('onEvent handler forwards event to callback', () => {
    const cb = vi.fn()
    exposed.agentActivity.onEvent(cb)
    const handler = mockIpcRenderer.on.mock.calls.find((c: any) => c[0] === 'agentActivity:event')?.[1]
    handler({}, { id: 'ev1' })
    expect(cb).toHaveBeenCalledWith({ id: 'ev1' })
  })
})

describe('preload: termpolis API — workspace trust + memory + swarm-review git', () => {
  it('workspaceIsTrusted', async () => {
    await exposed.termpolis.workspaceIsTrusted('/r')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('workspace:is-trusted', { cwd: '/r' })
  })

  it('workspaceTrust', async () => {
    await exposed.termpolis.workspaceTrust('/r')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('workspace:trust', { cwd: '/r' })
  })

  it('workspaceRevokeTrust', async () => {
    await exposed.termpolis.workspaceRevokeTrust('/r')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('workspace:revoke-trust', { cwd: '/r' })
  })

  it('workspaceListTrusted', async () => {
    await exposed.termpolis.workspaceListTrusted()
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('workspace:list-trusted')
  })

  it('memoryWrite', async () => {
    const input = { agentId: 'claude', kind: 'fact', body: 'b' } as any
    await exposed.termpolis.memoryWrite(input)
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('memory:write', input)
  })

  it('memorySearch', async () => {
    await exposed.termpolis.memorySearch({ q: 'x' } as any)
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('memory:search', { q: 'x' })
  })

  it('memoryList with explicit opts', async () => {
    await exposed.termpolis.memoryList({ limit: 10 } as any)
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('memory:list', { limit: 10 })
  })

  it('memoryList with no opts defaults to {}', async () => {
    await (exposed.termpolis.memoryList as any)()
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('memory:list', {})
  })

  it('memoryCount', async () => {
    await exposed.termpolis.memoryCount()
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('memory:count')
  })

  it('memoryClear', async () => {
    await exposed.termpolis.memoryClear()
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('memory:clear')
  })

  it('memoryGetPrimerLimit invokes memory:get-primer-limit', async () => {
    await exposed.termpolis.memoryGetPrimerLimit()
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('memory:get-primer-limit')
  })

  it('memorySetPrimerLimit invokes memory:set-primer-limit with the value', async () => {
    await exposed.termpolis.memorySetPrimerLimit(12)
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('memory:set-primer-limit', { value: 12 })
  })

  it('gitRevParseHead', async () => {
    await exposed.termpolis.gitRevParseHead('/r')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('git:rev-parse-head', { cwd: '/r' })
  })

  it('gitDiffRange', async () => {
    await exposed.termpolis.gitDiffRange('/r', 'a', 'b')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('git:diff-range', { cwd: '/r', from: 'a', to: 'b' })
  })

  it('gitFilesInRange', async () => {
    await exposed.termpolis.gitFilesInRange('/r', 'a', 'b')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('git:files-in-range', { cwd: '/r', from: 'a', to: 'b' })
  })

  it('gitApplyPatch', async () => {
    await exposed.termpolis.gitApplyPatch('/r', 'patch-text', false)
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('git:apply-patch', { cwd: '/r', patch: 'patch-text', reverse: false })
  })

  it('gitCheckoutFile', async () => {
    await exposed.termpolis.gitCheckoutFile('/r', 'sha', ['f.ts'])
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('git:checkout-file', { cwd: '/r', sha: 'sha', files: ['f.ts'] })
  })

  it('gitResetHard', async () => {
    await exposed.termpolis.gitResetHard('/r', 'sha')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('git:reset-hard', { cwd: '/r', sha: 'sha' })
  })

  it('gitCommitAll', async () => {
    await exposed.termpolis.gitCommitAll('/r', 'msg')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('git:commit-all', { cwd: '/r', message: 'msg' })
  })

  it('swarmRunCommand', async () => {
    await exposed.termpolis.swarmRunCommand('/r', 'npm test')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('swarm:run-command', { cwd: '/r', command: 'npm test' })
  })

  it('getAppVersion', async () => {
    await exposed.termpolis.getAppVersion()
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('app:get-version')
  })

  it('listAISessions', async () => {
    await exposed.termpolis.listAISessions()
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('aiSessions:list')
  })

  it('digestAISession', async () => {
    await exposed.termpolis.digestAISession('/path/to/session.jsonl')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('aiSessions:digest', '/path/to/session.jsonl')
  })

  it('collectDiagnostics', async () => {
    await exposed.termpolis.collectDiagnostics()
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('diagnostics:collect')
  })

  it('openExternal', async () => {
    await exposed.termpolis.openExternal('https://example.com')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('shell:open-external', { url: 'https://example.com' })
  })

  it('appendHistory', () => {
    exposed.termpolis.appendHistory('t1', 'name', 'ls')
    expect(mockIpcRenderer.send).toHaveBeenCalledWith('history:append', { terminalId: 't1', terminalName: 'name', command: 'ls' })
  })

  it('searchHistory', async () => {
    await exposed.termpolis.searchHistory('foo')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('history:search', { query: 'foo' })
  })

  it('getHomedir', async () => {
    await exposed.termpolis.getHomedir()
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('fs:homedir')
  })
})

describe('preload: aiSecurity API', () => {
  it('exposes aiSecurity', () => {
    expect(exposed.aiSecurity).toBeDefined()
  })

  it('getStatus', async () => {
    await exposed.aiSecurity.getStatus()
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('aiSecurity:get-status')
  })

  // The `setRedaction` bridge and its `aiSecurity:set-redaction` channel are GONE, along with
  // the setting behind them. The test that drove them is deleted rather than stubbed; this
  // negative assertion is what stops the API creeping back in unnoticed.
  it('no longer exposes setRedaction — the redaction toggle is gone, not merely defaulted off', () => {
    expect(exposed.aiSecurity.setRedaction).toBeUndefined()
  })

  it('setAudit', async () => {
    await exposed.aiSecurity.setAudit(false)
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('aiSecurity:set-audit', { value: false })
  })

  it('setStrictGemini', async () => {
    await exposed.aiSecurity.setStrictGemini(true)
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('aiSecurity:set-strict-gemini', { value: true })
  })

  it('scan', async () => {
    await exposed.aiSecurity.scan('hello world')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('aiSecurity:scan', { text: 'hello world' })
  })

  it('recentAudit with limit', async () => {
    await exposed.aiSecurity.recentAudit(50)
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('aiSecurity:recent-audit', { limit: 50 })
  })

  it('recentAudit without limit', async () => {
    await exposed.aiSecurity.recentAudit()
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('aiSecurity:recent-audit', { limit: undefined })
  })

  it('clearAudit', async () => {
    await exposed.aiSecurity.clearAudit()
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('aiSecurity:clear-audit')
  })

  it('append forwards a real audit event', async () => {
    // 'manual_scan' is one of the events main actually accepts from the renderer
    // (terminal_open / terminal_close / redaction_hit / manual_scan). The old test sent
    // event: 'redacted', which was never a valid event at all.
    const entry = { agent: 'claude', event: 'manual_scan', hitCount: 2 }
    await exposed.aiSecurity.append(entry)
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('aiSecurity:append', entry)
  })

  it('onSecretSent listens on the channel main actually emits', () => {
    // The dead bridge, pinned. main emits 'terminal:secret-observed'; preload used to listen on
    // 'terminal:secrets-redacted', so the leak banner could never fire — the one user-visible
    // symptom of a real leak was silently unreachable. Renaming a channel on one side of an IPC
    // pair is invisible to both TypeScript and the runtime, so the only thing that catches it is
    // an assertion that names the channel on both sides. See also: the source-drift test below.
    const cb = vi.fn()
    const cleanup = exposed.aiSecurity.onSecretSent(cb)
    expect(mockIpcRenderer.on).toHaveBeenCalledWith('terminal:secret-observed', expect.any(Function))
    const handler = mockIpcRenderer.on.mock.calls.find((c: any) => c[0] === 'terminal:secret-observed')?.[1]
    handler({}, { id: 't', hits: [{ rule: 'env_secret', label: 'env', name: 'DB_PASSWORD' }], agent: 'claude' })
    expect(cb).toHaveBeenCalledWith({
      id: 't',
      hits: [{ rule: 'env_secret', label: 'env', name: 'DB_PASSWORD' }],
      agent: 'claude',
    })
    cleanup()
    expect(mockIpcRenderer.removeListener).toHaveBeenCalledWith('terminal:secret-observed', expect.any(Function))
  })

  it('inputPending asks main whether the user has an un-submitted draft', async () => {
    // Gates the compaction re-prime: an unprompted write appends at the cursor, so it must not
    // fire while the user is mid-sentence.
    await exposed.aiSecurity.inputPending('t1')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('aiSecurity:input-pending', { id: 't1' })
  })

  it('does not expose the deleted onSecretsRedacted bridge', () => {
    // Negative pin: the redaction API is gone, not renamed-and-aliased.
    expect((exposed.aiSecurity as Record<string, unknown>).onSecretsRedacted).toBeUndefined()
    expect((exposed.aiSecurity as Record<string, unknown>).setRedaction).toBeUndefined()
  })

  it('onCodeChunkDetected registers handler and returns cleanup', () => {
    const cb = vi.fn()
    const cleanup = exposed.aiSecurity.onCodeChunkDetected(cb)
    const handler = mockIpcRenderer.on.mock.calls.find((c: any) => c[0] === 'terminal:code-chunk-detected')?.[1]
    handler({}, { id: 't', agent: null, byteSize: 100, lineCount: 10, signals: ['x'] })
    expect(cb).toHaveBeenCalledWith({ id: 't', agent: null, byteSize: 100, lineCount: 10, signals: ['x'] })
    cleanup()
    expect(mockIpcRenderer.removeListener).toHaveBeenCalledWith('terminal:code-chunk-detected', expect.any(Function))
  })

  it('onEnvDumpDetected registers handler and returns cleanup', () => {
    const cb = vi.fn()
    const cleanup = exposed.aiSecurity.onEnvDumpDetected(cb)
    const handler = mockIpcRenderer.on.mock.calls.find((c: any) => c[0] === 'terminal:env-dump-detected')?.[1]
    handler({}, { id: 't', agent: 'codex', varCount: 5, variableNames: ['HOME'] })
    expect(cb).toHaveBeenCalledWith({ id: 't', agent: 'codex', varCount: 5, variableNames: ['HOME'] })
    cleanup()
    expect(mockIpcRenderer.removeListener).toHaveBeenCalledWith('terminal:env-dump-detected', expect.any(Function))
  })

  it('egress', async () => {
    await exposed.aiSecurity.egress('term-1')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('ai-security:egress', { terminalId: 'term-1' })
  })

  it('sensitiveReads', async () => {
    await exposed.aiSecurity.sensitiveReads('term-1')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('ai-security:sensitive-reads', { terminalId: 'term-1' })
  })

  it('onSensitiveFileRead registers handler and forwards payload', () => {
    const cb = vi.fn()
    const cleanup = exposed.aiSecurity.onSensitiveFileRead(cb)
    const handler = mockIpcRenderer.on.mock.calls.find((c: any) => c[0] === 'terminal:sensitive-file-read')?.[1]
    const payload = {
      id: 't1', agent: 'claude', tool: 'Read', rule: 'dotenv',
      label: '.env file', filePath: '/p/.env', source: 'path' as const, ts: 1234,
    }
    handler({}, payload)
    expect(cb).toHaveBeenCalledWith(payload)
    cleanup()
    expect(mockIpcRenderer.removeListener).toHaveBeenCalledWith('terminal:sensitive-file-read', expect.any(Function))
  })
})

describe('preload: updater API', () => {
  it('exposes updater', () => {
    expect(exposed.updater).toBeDefined()
  })

  it('getStatus invokes updater:status', async () => {
    await exposed.updater.getStatus()
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('updater:status')
  })

  it('check invokes updater:check', async () => {
    await exposed.updater.check()
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('updater:check')
  })

  it('quitAndInstall invokes updater:quit-and-install', async () => {
    await exposed.updater.quitAndInstall()
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('updater:quit-and-install')
  })

  it('onState registers handler, forwards state, and cleans up', () => {
    const cb = vi.fn()
    const cleanup = exposed.updater.onState(cb)
    const handler = mockIpcRenderer.on.mock.calls.find((c: any) => c[0] === 'updater:state')?.[1]
    handler({}, { phase: 'downloading' })
    expect(cb).toHaveBeenCalledWith({ phase: 'downloading' })
    cleanup()
    expect(mockIpcRenderer.removeListener).toHaveBeenCalledWith('updater:state', expect.any(Function))
  })

  it('code graph bridge methods invoke the right IPC channels', async () => {
    const api = exposed.termpolis
    await api.codeGraphStats()
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('code-graph:stats')
    await api.codeGraphSearch('foo', 10)
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('code-graph:search', { query: 'foo', limit: 10 })
    await api.codeGraphExplore('foo')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('code-graph:explore', { query: 'foo' })
    await api.codeGraphImpact('foo')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('code-graph:impact', { name: 'foo' })
    await api.codeGraphCallers('foo')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('code-graph:callers', { name: 'foo' })
    await api.codeGraphBuild('/repo')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('code-graph:build', { repoRoot: '/repo' })
  })
})

// ---------------------------------------------------------------------------
// v1.25 — Safe Import bridge + the three new AI-Security gates
// ---------------------------------------------------------------------------
describe('preload: safeImport bridge', () => {
  it('exposes the safe-import surface', () => {
    expect(exposed.safeImport).toBeDefined()
  })

  it('routes scan / approveInstall / list / revoke to their IPC channels', async () => {
    await exposed.safeImport.scan()
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('safeImport:scan')

    await exposed.safeImport.approveInstall(['claude', 'codex'])
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('safeImport:approve-install', { targets: ['claude', 'codex'] })

    await exposed.safeImport.list()
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('safeImport:list')

    await exposed.safeImport.revoke('pdf-tools')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('safeImport:revoke', { id: 'pdf-tools' })
  })

  it('onProgress subscribes, forwards the payload, and returns a working unsubscribe', () => {
    const seen: { pct: number; stage: string }[] = []
    const off = exposed.safeImport.onProgress((p: { pct: number; stage: string }) => seen.push(p))
    expect(mockIpcRenderer.on).toHaveBeenCalledWith('safeImport:progress', expect.any(Function))

    // Drive the registered listener exactly as the main process would.
    const call = mockIpcRenderer.on.mock.calls.find((c: any[]) => c[0] === 'safeImport:progress')
    const handler = call![1] as (e: unknown, p: { pct: number; stage: string }) => void
    handler({}, { pct: 40, stage: 'Scanning skill.js' })
    expect(seen).toEqual([{ pct: 40, stage: 'Scanning skill.js' }])

    off()
    expect(mockIpcRenderer.removeListener).toHaveBeenCalledWith('safeImport:progress', expect.any(Function))
  })
})

describe('preload: aiSecurity v1.25 gates', () => {
  it('routes the commit shield, egress guard, and memory scrub toggles', async () => {
    await exposed.aiSecurity.setCommitShield(true)
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('aiSecurity:set-commit-shield', { value: true })

    await exposed.aiSecurity.setEgressGuard(false)
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('aiSecurity:set-egress-guard', { value: false })

    await exposed.aiSecurity.setMemoryScrub(true)
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('aiSecurity:set-memory-scrub', { value: true })
  })
})

// ---------------------------------------------------------------------------
// Commit Shield git hooks — the bridge that lets the Security panel install the
// pre-commit/pre-push hooks that make the shield cover terminal-typed git.
// ---------------------------------------------------------------------------
describe('preload: commit shield git-hook bridge', () => {
  it('routes list / install / uninstall to their IPC channels', async () => {
    await exposed.aiSecurity.gitHooksList()
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('gitHooks:list')

    await exposed.aiSecurity.gitHooksInstall('/repo')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('gitHooks:install', { cwd: '/repo' })

    await exposed.aiSecurity.gitHooksUninstall('/repo')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('gitHooks:uninstall', { cwd: '/repo' })
  })

  it('install with no argument lets MAIN own the folder picker (never the renderer)', async () => {
    await exposed.aiSecurity.gitHooksInstall()
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('gitHooks:install', { cwd: undefined })
  })
})

// ---------------------------------------------------------------------------
// Workflow Orchestrator bridge — the renderer's only door to the main-process
// workflow store + engine. Each method must invoke the exact channel with the
// exact payload shape the main handlers destructure, and onWorkflowRunEvent must
// register a listener, forward each event to the callback, and return a cleanup
// that unsubscribes.
// ---------------------------------------------------------------------------
describe('preload — workflow orchestrator bridge', () => {
  it('listWorkflows invokes workflow:list with the cwd', async () => {
    await exposed.termpolis.listWorkflows('/proj')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('workflow:list', { cwd: '/proj' })
  })

  it('readWorkflow invokes workflow:read with cwd + id', async () => {
    await exposed.termpolis.readWorkflow('/proj', 'wf1')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('workflow:read', { cwd: '/proj', id: 'wf1' })
  })

  it('saveWorkflow invokes workflow:save with cwd + workflow', async () => {
    const wf = { id: 'wf1', name: 'W', steps: [] }
    await exposed.termpolis.saveWorkflow('/proj', wf)
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('workflow:save', { cwd: '/proj', workflow: wf })
  })

  it('deleteWorkflow invokes workflow:delete with cwd + id', async () => {
    await exposed.termpolis.deleteWorkflow('/proj', 'wf1')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('workflow:delete', { cwd: '/proj', id: 'wf1' })
  })

  it('runWorkflow invokes workflow:run with cwd + id', async () => {
    await exposed.termpolis.runWorkflow('/proj', 'wf1')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('workflow:run', { cwd: '/proj', id: 'wf1' })
  })

  it('cancelWorkflow invokes workflow:cancel with the runId', async () => {
    await exposed.termpolis.cancelWorkflow('run-42')
    expect(mockIpcRenderer.invoke).toHaveBeenCalledWith('workflow:cancel', { runId: 'run-42' })
  })

  it('onWorkflowRunEvent registers a listener, forwards events, and returns a working cleanup', () => {
    const cb = vi.fn()
    const cleanup = exposed.termpolis.onWorkflowRunEvent(cb)
    // The listener is registered on the run-event channel.
    expect(mockIpcRenderer.on).toHaveBeenCalledWith('workflow:run-event', expect.any(Function))
    // The registered handler forwards the event payload (dropping the ipc event arg) to cb.
    const handler = mockIpcRenderer.on.mock.calls.find(c => c[0] === 'workflow:run-event')![1] as Function
    const evt = { runId: 'r', kind: 'run-started' }
    handler({}, evt)
    expect(cb).toHaveBeenCalledWith(evt)
    // Cleanup removes exactly that handler.
    expect(typeof cleanup).toBe('function')
    cleanup()
    expect(mockIpcRenderer.removeListener).toHaveBeenCalledWith('workflow:run-event', handler)
  })
})

describe('preload: event bridges that only ever fire from main', () => {
  // These three registrars hand main a closure and hand the renderer an unsubscribe.
  // The sweep at the bottom of this file proves they can be CALLED, but never that the
  // closure they registered actually forwards anything — so a handler that dropped its
  // payload, or forwarded the raw IpcRendererEvent instead of the data, would ship
  // green. Each case below registers, fires the handler main would fire, and checks
  // both the payload the renderer sees and that cleanup removes that exact handler.

  it('aiSecurity.onShieldScanFailed forwards the failure, dropping the ipc event arg', () => {
    // Commit Shield fails OPEN: the git op already went through unscanned. This event is
    // the only thing that stops that from also being fail-SILENT, so a handler that
    // swallowed the payload would turn a broken control into an invisible one.
    const cb = vi.fn()
    const cleanup = exposed.aiSecurity.onShieldScanFailed(cb)
    const handler = mockIpcRenderer.on.mock.calls.find(c => c[0] === 'shield:scan-failed')![1] as Function
    const data = { op: 'commit', cwd: '/repo', error: 'scanner crashed' }
    handler({}, data)
    expect(cb).toHaveBeenCalledWith(data)
    cleanup()
    expect(mockIpcRenderer.removeListener).toHaveBeenCalledWith('shield:scan-failed', handler)
  })

  it('remote.onStatus forwards the status view and unsubscribes cleanly', () => {
    const cb = vi.fn()
    const cleanup = exposed.remote.onStatus(cb)
    const handler = mockIpcRenderer.on.mock.calls.find(c => c[0] === 'remote:status-changed')![1] as Function
    const status = { running: true, devices: [] }
    handler({}, status)
    expect(cb).toHaveBeenCalledWith(status)
    cleanup()
    expect(mockIpcRenderer.removeListener).toHaveBeenCalledWith('remote:status-changed', handler)
  })

  it('remote.onEvent forwards the event and unsubscribes cleanly', () => {
    const cb = vi.fn()
    const cleanup = exposed.remote.onEvent(cb)
    const handler = mockIpcRenderer.on.mock.calls.find(c => c[0] === 'remote:event')![1] as Function
    const evt = { kind: 'paired', deviceId: 'd1' }
    handler({}, evt)
    expect(cb).toHaveBeenCalledWith(evt)
    cleanup()
    expect(mockIpcRenderer.removeListener).toHaveBeenCalledWith('remote:event', handler)
  })
})

describe('preload IPC surface — every exposed wrapper forwards without throwing', () => {
  // The preload bridge is the renderer's ONLY door to the main process, so every
  // exposed function must be safely invocable: a wrapper that throws in the
  // renderer breaks the feature it fronts (workflow save/run/trust included).
  // This sweep calls each function on every exposed bridge with benign args
  // (ipcRenderer is fully mocked) — a regression that makes any wrapper throw is
  // caught here, and it proves the whole surface is wired end-to-end.
  it('calls every function on every exposed bridge', () => {
    expect(Object.keys(exposed)).toEqual(
      expect.arrayContaining([
        'termpolis', 'windowControls', 'globalEvents', 'swarmAPI',
        'updater', 'safeImport', 'aiSecurity', 'mcpEvents',
      ]),
    )
    const threw: string[] = []
    let called = 0
    for (const [bridgeName, bridge] of Object.entries(exposed)) {
      if (!bridge || typeof bridge !== 'object') continue
      for (const [fnName, val] of Object.entries(bridge as Record<string, unknown>)) {
        if (typeof val !== 'function') continue
        called++
        try {
          const ret = (val as (...a: unknown[]) => unknown)(vi.fn(), 'x', 'y', 1, {})
          // Event registrars return an unsubscribe fn — call it to cover teardown.
          if (typeof ret === 'function') (ret as () => void)()
        } catch (e) {
          threw.push(`${bridgeName}.${fnName}: ${(e as Error).message}`)
        }
      }
    }
    expect(threw).toEqual([])
    expect(called).toBeGreaterThan(120)
  })
})
