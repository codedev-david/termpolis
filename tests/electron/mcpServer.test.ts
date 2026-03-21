import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import * as http from 'http'

vi.mock('electron', () => ({ app: { getPath: () => '/fake' } }))

const {
  getMcpAuthToken,
  checkRateLimit,
  resetRateLimits,
  startMcpServer,
  stopMcpServer,
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
    server = startMcpServer(handlers)
    // Wait for the server to be listening and grab the actual port
    await new Promise<void>((resolve, reject) => {
      server.on('listening', () => {
        const addr = server.address() as { port: number }
        port = addr.port
        resolve()
      })
      server.on('error', reject)
    })
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
    expect(body.tools).toBe(14)
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

  it('tools/list returns 14 tools', async () => {
    const res = await jsonRpcRequest(port, token, {
      jsonrpc: '2.0',
      method: 'tools/list',
      id: 2,
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.result.tools).toHaveLength(14)
    const names = body.result.tools.map((t: any) => t.name)
    expect(names).toContain('list_terminals')
    expect(names).toContain('run_command')
    expect(names).toContain('swarm_list_agents')
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
})
