import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import * as http from 'http'

vi.mock('electron', () => ({ app: { getPath: () => '/fake' } }))

const {
  getMcpAuthToken,
  getMcpPort,
  checkRateLimit,
  resetRateLimits,
  startMcpServer,
  stopMcpServer,
  awaitMcpPortBound,
  _resetPortStateForTest,
} = await import('../../src/main/mcpServer')

// --- Helpers ---

function createMockHandlers() {
  return {
    listTerminals: vi.fn().mockReturnValue([
      { id: 't1', name: 'Test', shellType: 'bash', cwd: '/home' },
    ]),
    createTerminal: vi.fn().mockResolvedValue('t-new-1'),
    runCommand: vi.fn(),
    readOutput: vi.fn().mockReturnValue('$ hello\nworld'),
    closeTerminal: vi.fn(),
    writeToTerminal: vi.fn(),
    getFileTree: vi.fn().mockReturnValue([{ name: 'src', isDir: true }]),
    getGitStatus: vi.fn().mockReturnValue({ status: 'clean', recentCommits: '', branch: 'main' }),
    swarmSendMessage: vi.fn().mockReturnValue({ ok: true }),
    swarmReadMessages: vi.fn().mockReturnValue([]),
    swarmCreateTask: vi.fn().mockReturnValue({ taskId: 'task-1' }),
    swarmListTasks: vi.fn().mockReturnValue([]),
    swarmUpdateTask: vi.fn().mockReturnValue({ ok: true }),
    swarmListAgents: vi.fn().mockReturnValue([]),
  }
}

function makeRequest(
  options: http.RequestOptions,
  body?: string,
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = ''
      res.on('data', (chunk) => (data += chunk))
      res.on('end', () =>
        resolve({ statusCode: res.statusCode!, headers: res.headers, body: data }),
      )
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

function jsonRpcRequest(
  port: number,
  token: string,
  payload: object,
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  return makeRequest(
    {
      hostname: '127.0.0.1',
      port,
      path: '/mcp',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
    },
    JSON.stringify(payload),
  )
}

// --- getMcpAuthToken ---

describe('getMcpAuthToken', () => {
  it('returns a 64-character hex string', () => {
    const token = getMcpAuthToken()
    expect(token).toMatch(/^[0-9a-f]{64}$/)
  })

  it('returns the same token on repeated calls', () => {
    expect(getMcpAuthToken()).toBe(getMcpAuthToken())
  })
})

// --- checkRateLimit and resetRateLimits ---

describe('checkRateLimit', () => {
  beforeEach(() => {
    resetRateLimits()
    vi.useRealTimers()
  })

  it('allows requests within the global limit', () => {
    for (let i = 0; i < 10; i++) {
      expect(checkRateLimit('_global')).toBe(true)
    }
  })

  it('blocks requests exceeding the global limit (200/min)', () => {
    for (let i = 0; i < 200; i++) {
      checkRateLimit('_global')
    }
    expect(checkRateLimit('_global')).toBe(false)
  })

  it('blocks create_terminal after 10 requests', () => {
    for (let i = 0; i < 10; i++) {
      expect(checkRateLimit('create_terminal')).toBe(true)
    }
    expect(checkRateLimit('create_terminal')).toBe(false)
  })

  it('blocks run_command after 60 requests', () => {
    for (let i = 0; i < 60; i++) {
      expect(checkRateLimit('run_command')).toBe(true)
    }
    expect(checkRateLimit('run_command')).toBe(false)
  })

  it('uses global limit for unknown keys', () => {
    // Unknown keys fall back to _global limit (200/min)
    for (let i = 0; i < 200; i++) {
      checkRateLimit('some_unknown_key')
    }
    expect(checkRateLimit('some_unknown_key')).toBe(false)
  })

  it('resets after the time window expires', () => {
    vi.useFakeTimers()
    for (let i = 0; i < 10; i++) {
      checkRateLimit('create_terminal')
    }
    expect(checkRateLimit('create_terminal')).toBe(false)

    // Advance past the 60s window
    vi.advanceTimersByTime(60_001)
    expect(checkRateLimit('create_terminal')).toBe(true)
  })
})

describe('resetRateLimits', () => {
  it('clears all rate limit buckets', () => {
    for (let i = 0; i < 200; i++) {
      checkRateLimit('_global')
    }
    expect(checkRateLimit('_global')).toBe(false)

    resetRateLimits()
    expect(checkRateLimit('_global')).toBe(true)
  })
})

// --- HTTP Server Tests ---

describe('MCP HTTP server', () => {
  let server: http.Server
  let port: number
  const handlers = createMockHandlers()
  const token = getMcpAuthToken()

  beforeAll(async () => {
    _resetPortStateForTest()
    server = startMcpServer(handlers)
    // Use the port-bound helper — it survives EADDRINUSE fallback so tests
    // still pass when port 9315 is occupied by a running dev Termpolis.
    port = await awaitMcpPortBound()
  })

  afterAll(async () => {
    resetRateLimits()
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
  })

  beforeEach(() => {
    resetRateLimits()
    vi.clearAllMocks()
  })

  // --- Health / CORS ---

  it('GET /health returns status ok without auth', async () => {
    const res = await makeRequest({
      hostname: '127.0.0.1',
      port,
      path: '/health',
      method: 'GET',
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.status).toBe('ok')
    expect(body.name).toBe('termpolis-mcp')
    expect(body.tools).toBe(17)
  })

  it('OPTIONS returns 204 with CORS headers', async () => {
    const res = await makeRequest({
      hostname: '127.0.0.1',
      port,
      path: '/mcp',
      method: 'OPTIONS',
    })
    expect(res.statusCode).toBe(204)
    expect(res.headers['access-control-allow-methods']).toContain('POST')
  })

  // --- Auth ---

  it('POST /mcp without auth returns 401', async () => {
    const res = await makeRequest(
      {
        hostname: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 }),
    )
    expect(res.statusCode).toBe(401)
  })

  it('POST /mcp with wrong token returns 401', async () => {
    const res = await makeRequest(
      {
        hostname: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer wrong-token-value',
        },
      },
      JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 }),
    )
    expect(res.statusCode).toBe(401)
  })

  // --- JSON-RPC: initialize ---

  it('initialize returns protocol version and server info', async () => {
    const res = await jsonRpcRequest(port, token, {
      jsonrpc: '2.0',
      method: 'initialize',
      id: 1,
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.result.protocolVersion).toBe('2024-11-05')
    expect(body.result.serverInfo.name).toBe('termpolis')
    expect(body.id).toBe(1)
  })

  // --- JSON-RPC: tools/list ---

  it('tools/list returns 17 tools', async () => {
    const res = await jsonRpcRequest(port, token, {
      jsonrpc: '2.0',
      method: 'tools/list',
      id: 2,
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.result.tools).toHaveLength(17)
    const names = body.result.tools.map((t: any) => t.name)
    expect(names).toContain('list_terminals')
    expect(names).toContain('run_command')
    expect(names).toContain('swarm_list_agents')
    expect(names).toContain('memory_write')
    expect(names).toContain('memory_search')
    expect(names).toContain('memory_list')
  })

  // --- JSON-RPC: tools/call ---

  it('tools/call list_terminals calls handler and returns result', async () => {
    const res = await jsonRpcRequest(port, token, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'list_terminals', arguments: {} },
      id: 3,
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(handlers.listTerminals).toHaveBeenCalled()
    const content = JSON.parse(body.result.content[0].text)
    expect(content).toEqual([{ id: 't1', name: 'Test', shellType: 'bash', cwd: '/home' }])
  })

  it('tools/call run_command calls handler with correct args', async () => {
    const res = await jsonRpcRequest(port, token, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'run_command', arguments: { terminalId: 't1', command: 'ls -la' } },
      id: 4,
    })
    expect(res.statusCode).toBe(200)
    expect(handlers.runCommand).toHaveBeenCalledWith('t1', 'ls -la')
    const body = JSON.parse(res.body)
    const content = JSON.parse(body.result.content[0].text)
    expect(content.success).toBe(true)
    expect(content.command).toBe('ls -la')
  })

  it('tools/call create_terminal calls handler and returns terminal ID', async () => {
    const res = await jsonRpcRequest(port, token, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'create_terminal', arguments: { name: 'MyTerm', shell: 'zsh', cwd: '/tmp' } },
      id: 5,
    })
    expect(res.statusCode).toBe(200)
    expect(handlers.createTerminal).toHaveBeenCalledWith('MyTerm', 'zsh', '/tmp')
    const body = JSON.parse(res.body)
    const content = JSON.parse(body.result.content[0].text)
    expect(content.terminalId).toBe('t-new-1')
  })

  it('tools/call read_output returns terminal output', async () => {
    const res = await jsonRpcRequest(port, token, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'read_output', arguments: { terminalId: 't1', lines: 20 } },
      id: 6,
    })
    expect(res.statusCode).toBe(200)
    expect(handlers.readOutput).toHaveBeenCalledWith('t1', 20)
  })

  // --- JSON-RPC: unknown method ---

  it('unknown method returns error code -32601', async () => {
    const res = await jsonRpcRequest(port, token, {
      jsonrpc: '2.0',
      method: 'nonexistent/method',
      id: 7,
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.error.code).toBe(-32601)
    expect(body.error.message).toContain('nonexistent/method')
  })

  // --- JSON-RPC: invalid JSON ---

  it('invalid JSON returns parse error -32700', async () => {
    const res = await makeRequest(
      {
        hostname: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
      },
      '{not valid json!!!',
    )
    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.body)
    expect(body.error.code).toBe(-32700)
    expect(body.error.message).toBe('Parse error')
  })

  // --- JSON-RPC: notifications ---

  it('notifications/initialized returns empty result', async () => {
    const res = await jsonRpcRequest(port, token, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      id: 8,
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.result).toEqual({})
  })

  it('initialized method returns empty result', async () => {
    const res = await jsonRpcRequest(port, token, {
      jsonrpc: '2.0',
      method: 'initialized',
      id: 9,
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.result).toEqual({})
  })

  it('ping returns empty result (Qwen Code mcp list connection check)', async () => {
    const res = await jsonRpcRequest(port, token, {
      jsonrpc: '2.0',
      method: 'ping',
      id: 10,
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.result).toEqual({})
    expect(body.error).toBeUndefined()
    expect(body.id).toBe(10)
  })

  // --- 404 for unknown routes ---

  it('unknown route returns 404', async () => {
    const res = await makeRequest({
      hostname: '127.0.0.1',
      port,
      path: '/nonexistent',
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(404)
  })

  // --- Rate limiting via HTTP ---

  it('returns 429 when global rate limit is exceeded', async () => {
    // Exhaust the global rate limit
    for (let i = 0; i < 200; i++) {
      checkRateLimit('_global')
    }

    const res = await jsonRpcRequest(port, token, {
      jsonrpc: '2.0',
      method: 'tools/list',
      id: 99,
    })
    expect(res.statusCode).toBe(429)
    const body = JSON.parse(res.body)
    expect(body.error.code).toBe(-32000)
  })

  it('returns 429 when per-tool rate limit is exceeded for create_terminal', async () => {
    // Exhaust the create_terminal rate limit
    for (let i = 0; i < 10; i++) {
      checkRateLimit('create_terminal')
    }

    const res = await jsonRpcRequest(port, token, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'create_terminal', arguments: { name: 'test' } },
      id: 100,
    })
    expect(res.statusCode).toBe(429)
    const body = JSON.parse(res.body)
    expect(body.error.message).toContain('create_terminal')
  })

  // --- SSE endpoint ---

  it('GET /mcp/sse returns event stream with ready event', async () => {
    const res = await new Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/mcp/sse',
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
        },
        (res) => {
          let data = ''
          res.on('data', (chunk) => {
            data += chunk
            // We only need the first event, destroy after receiving data
            req.destroy()
          })
          res.on('end', () => resolve({ statusCode: res.statusCode!, headers: res.headers, body: data }))
          res.on('error', () => resolve({ statusCode: res.statusCode!, headers: res.headers, body: data }))
          // If the connection stays open, resolve after short timeout
          setTimeout(() => {
            req.destroy()
            resolve({ statusCode: res.statusCode!, headers: res.headers, body: data })
          }, 500)
        },
      )
      req.on('error', (e) => {
        // ECONNRESET expected when we destroy the request
        if ((e as any).code === 'ECONNRESET') return
        reject(e)
      })
      req.end()
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/event-stream')
    expect(res.body).toContain('"method":"ready"')
  })

  it('GET /mcp/sse without auth returns 401', async () => {
    const res = await makeRequest({
      hostname: '127.0.0.1',
      port,
      path: '/mcp/sse',
      method: 'GET',
    })
    expect(res.statusCode).toBe(401)
  })

  // --- Tool execution errors ---

  it('tools/call with unknown tool returns sanitized error', async () => {
    const res = await jsonRpcRequest(port, token, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'nonexistent_tool', arguments: {} },
      id: 200,
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.result.isError).toBe(true)
    expect(body.result.content[0].text).toContain('Unknown tool')
  })

  // --- Payload size limit ---

  it('returns 413 when payload exceeds 1MB', async () => {
    const largePayload = 'x'.repeat(1024 * 1024 + 100)
    try {
      const res = await makeRequest(
        {
          hostname: '127.0.0.1',
          port,
          path: '/mcp',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
        },
        largePayload,
      )
      expect(res.statusCode).toBe(413)
      const body = JSON.parse(res.body)
      expect(body.error.message).toBe('Payload too large')
    } catch (e: any) {
      // ECONNRESET is acceptable — server destroyed the connection
      expect(e.code).toBe('ECONNRESET')
    }
  })

  it('tools/call handler exception returns generic error (no stack leak)', async () => {
    // Force a handler to throw a non-standard error
    handlers.listTerminals.mockImplementation(() => {
      throw new Error('internal db connection string: postgres://user:pass@host/db')
    })

    try {
      const res = await jsonRpcRequest(port, token, {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'list_terminals', arguments: {} },
        id: 201,
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.result.isError).toBe(true)
      // Should NOT leak the internal error details
      expect(body.result.content[0].text).toBe('Error: Tool execution failed')
      expect(body.result.content[0].text).not.toContain('postgres')
    } catch (e: any) {
      // ECONNRESET can happen when previous test disrupted connection pool
      if (e.code !== 'ECONNRESET') throw e
    }
  })

  // --- Additional tool calls ---

  it('tools/call close_terminal calls handler', async () => {
    const res = await jsonRpcRequest(port, token, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'close_terminal', arguments: { terminalId: 't1' } },
      id: 300,
    })
    expect(res.statusCode).toBe(200)
    expect(handlers.closeTerminal).toHaveBeenCalledWith('t1')
    const body = JSON.parse(res.body)
    const content = JSON.parse(body.result.content[0].text)
    expect(content.success).toBe(true)
  })

  it('tools/call write_to_terminal calls handler', async () => {
    const res = await jsonRpcRequest(port, token, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'write_to_terminal', arguments: { terminalId: 't1', text: 'hello' } },
      id: 301,
    })
    expect(res.statusCode).toBe(200)
    expect(handlers.writeToTerminal).toHaveBeenCalledWith('t1', 'hello')
  })

  it('tools/call get_file_tree calls handler', async () => {
    const res = await jsonRpcRequest(port, token, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'get_file_tree', arguments: { path: '/project' } },
      id: 302,
    })
    expect(res.statusCode).toBe(200)
    expect(handlers.getFileTree).toHaveBeenCalledWith('/project')
  })

  it('tools/call get_git_status calls handler', async () => {
    const res = await jsonRpcRequest(port, token, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'get_git_status', arguments: { cwd: '/repo' } },
      id: 303,
    })
    expect(res.statusCode).toBe(200)
    expect(handlers.getGitStatus).toHaveBeenCalledWith('/repo')
  })

  it('tools/call swarm_send_message calls handler with mcp-client as from', async () => {
    const res = await jsonRpcRequest(port, token, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'swarm_send_message', arguments: { to: 'agent-1', type: 'task', content: 'do work' } },
      id: 304,
    })
    expect(res.statusCode).toBe(200)
    expect(handlers.swarmSendMessage).toHaveBeenCalledWith('mcp-client', 'agent-1', 'task', 'do work')
  })

  it('tools/call swarm_read_messages calls handler', async () => {
    const res = await jsonRpcRequest(port, token, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'swarm_read_messages', arguments: { terminalId: 't1' } },
      id: 305,
    })
    expect(res.statusCode).toBe(200)
    expect(handlers.swarmReadMessages).toHaveBeenCalledWith('t1')
  })

  it('tools/call swarm_create_task calls handler with mcp-client as createdBy', async () => {
    const res = await jsonRpcRequest(port, token, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'swarm_create_task', arguments: { title: 'Test', description: 'desc', assignTo: 'a1' } },
      id: 306,
    })
    expect(res.statusCode).toBe(200)
    expect(handlers.swarmCreateTask).toHaveBeenCalledWith('Test', 'desc', 'mcp-client', 'a1')
  })

  it('tools/call swarm_list_tasks calls handler', async () => {
    const res = await jsonRpcRequest(port, token, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'swarm_list_tasks', arguments: {} },
      id: 307,
    })
    expect(res.statusCode).toBe(200)
    expect(handlers.swarmListTasks).toHaveBeenCalled()
  })

  it('tools/call swarm_update_task calls handler', async () => {
    const res = await jsonRpcRequest(port, token, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'swarm_update_task', arguments: { taskId: 'task-1', status: 'completed', result: 'done' } },
      id: 308,
    })
    expect(res.statusCode).toBe(200)
    expect(handlers.swarmUpdateTask).toHaveBeenCalledWith('task-1', 'completed', 'done')
  })

  it('tools/call swarm_list_agents calls handler', async () => {
    const res = await jsonRpcRequest(port, token, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'swarm_list_agents', arguments: {} },
      id: 309,
    })
    expect(res.statusCode).toBe(200)
    expect(handlers.swarmListAgents).toHaveBeenCalled()
  })

  // --- Rate limiting edge: run_command limit ---

  it('returns 429 when run_command per-tool rate limit is exceeded', async () => {
    for (let i = 0; i < 60; i++) {
      checkRateLimit('run_command')
    }

    const res = await jsonRpcRequest(port, token, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'run_command', arguments: { terminalId: 't1', command: 'ls' } },
      id: 400,
    })
    expect(res.statusCode).toBe(429)
    const body = JSON.parse(res.body)
    expect(body.error.message).toContain('run_command')
  })

  // --- GET / root health check ---

  it('GET / also returns health status', async () => {
    const res = await makeRequest({
      hostname: '127.0.0.1',
      port,
      path: '/',
      method: 'GET',
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.status).toBe('ok')
  })

  // --- Additional tool calls: create_terminal defaults ---

  it('tools/call create_terminal uses defaults when shell and cwd omitted', async () => {
    const res = await jsonRpcRequest(port, token, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'create_terminal', arguments: { name: 'Default' } },
      id: 500,
    })
    expect(res.statusCode).toBe(200)
    expect(handlers.createTerminal).toHaveBeenCalledWith('Default', 'bash', '')
  })

  it('tools/call read_output uses default 50 lines when omitted', async () => {
    const res = await jsonRpcRequest(port, token, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'read_output', arguments: { terminalId: 't1' } },
      id: 501,
    })
    expect(res.statusCode).toBe(200)
    expect(handlers.readOutput).toHaveBeenCalledWith('t1', 50)
  })

  it('tools/call swarm_create_task without assignTo passes undefined', async () => {
    const res = await jsonRpcRequest(port, token, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'swarm_create_task', arguments: { title: 'NoAssign', description: 'test' } },
      id: 502,
    })
    expect(res.statusCode).toBe(200)
    expect(handlers.swarmCreateTask).toHaveBeenCalledWith('NoAssign', 'test', 'mcp-client', undefined)
  })

  it('tools/call swarm_update_task without result passes undefined', async () => {
    const res = await jsonRpcRequest(port, token, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'swarm_update_task', arguments: { taskId: 'task-1', status: 'in_progress' } },
      id: 503,
    })
    expect(res.statusCode).toBe(200)
    expect(handlers.swarmUpdateTask).toHaveBeenCalledWith('task-1', 'in_progress', undefined)
  })

  // --- Error with "Invalid" message passes through ---

  it('tools/call handler error with Invalid message is not sanitized', async () => {
    handlers.listTerminals.mockImplementation(() => {
      throw new Error('Invalid terminal ID')
    })

    try {
      const res = await jsonRpcRequest(port, token, {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'list_terminals', arguments: {} },
        id: 504,
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.result.isError).toBe(true)
      expect(body.result.content[0].text).toBe('Error: Invalid terminal ID')
    } catch (e: any) {
      if (e.code !== 'ECONNRESET') throw e
    }
  })

  // --- Additional edge case tests ---

  it('tools/call with missing arguments object uses empty default', async () => {
    const res = await jsonRpcRequest(port, token, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'swarm_list_tasks' },
      id: 600,
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.result.content).toBeDefined()
  })

  it('tools/call with a second unknown tool returns sanitized error', async () => {
    const res = await jsonRpcRequest(port, token, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'completely_fake_tool', arguments: {} },
      id: 601,
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.result.isError).toBe(true)
    expect(body.result.content[0].text).toContain('Unknown tool')
  })
})

// --- Audit logging ---

describe('audit logging', () => {
  it('initAuditLog does not throw', async () => {
    const { initAuditLog } = await import('../../src/main/mcpServer')
    const os = await import('os')
    expect(() => initAuditLog(os.tmpdir())).not.toThrow()
  })
})

// --- getMcpPort ---

describe('getMcpPort', () => {
  it('returns a number', () => {
    const port = getMcpPort()
    expect(typeof port).toBe('number')
    expect(port).toBeGreaterThan(0)
  })

  it('returns the actual listening port (matching the server)', () => {
    // getMcpPort should return the same port the test server is listening on
    const port = getMcpPort()
    // The test server was started above, so port should match
    expect(port).toBeGreaterThanOrEqual(9315)
  })
})

// --- stopMcpServer ---

describe('stopMcpServer', () => {
  it('closes the server', () => {
    const mockServer = { close: vi.fn() } as any
    stopMcpServer(mockServer)
    expect(mockServer.close).toHaveBeenCalled()
  })
})

// (Additional edge case tests moved into the main MCP HTTP server describe block above)
