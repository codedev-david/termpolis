// While a job another linked computer started runs here, the file's key (any process of this user
// can read mcp-token, the job included) and every session key issued meanwhile reach only the
// read-only tools. Session keys issued before, and the remote bridge's key, keep every tool.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import * as http from 'http'

vi.mock('electron', () => ({ app: { getPath: () => '/fake' } }))

const mcp = await import('../../src/main/mcpServer')
const { RESTRICTED_RUN_TOOLS } = await import('../../src/shared/agentIntegration')

function request(port: number, path: string, key: string, payload?: object): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = payload ? JSON.stringify(payload) : ''
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => {
          let parsed: any = body
          try { parsed = JSON.parse(body) } catch { /* not JSON */ }
          resolve({ status: res.statusCode!, body: parsed })
        })
      },
    )
    req.on('error', reject)
    req.end(data)
  })
}

const REFUSAL = /is not available while a job another computer started is running on this computer\. Only reading memory and code works until it ends; try again then\.$/

describe('the linked-job window', () => {
  let server: http.Server
  let port: number
  const handlers = {
    listTerminals: vi.fn().mockReturnValue([{ id: 't1', name: 'shell', shellType: 'bash', cwd: '/home' }]),
    getGitStatus: vi.fn().mockReturnValue({ status: 'clean', recentCommits: '', branch: 'main' }),
  } as unknown as Parameters<typeof mcp.startMcpServer>[0]
  const fileKey = mcp.getMcpAuthToken()

  const call = (key: string, name: unknown, id: number | null = 1) =>
    request(port, '/mcp', key, { jsonrpc: '2.0', ...(id === null ? {} : { id }), method: 'tools/call', params: { name, arguments: {} } })
  const session = async (key = fileKey) => (await request(port, '/mcp/session', key)).body.session as string

  beforeAll(async () => {
    mcp._resetPortStateForTest()
    server = mcp.startMcpServer(handlers)
    port = await mcp.awaitMcpPortBound()
  })
  afterAll(async () => {
    mcp._resetLinkedWindowForTest()
    await new Promise<void>((r) => server.close(() => r()))
  })
  beforeEach(() => {
    mcp._resetLinkedWindowForTest()
    mcp.resetRateLimits()
    vi.clearAllMocks()
  })

  it('allows the read-only set and the two primer reads, and nothing that acts', () => {
    expect([...mcp.LINKED_WINDOW_TOOLS].sort()).toEqual([...RESTRICTED_RUN_TOOLS, 'memory_primer', 'code_outline'].sort())
    for (const t of ['run_command', 'write_to_terminal', 'read_output', 'list_terminals', 'create_terminal', 'memory_write', 'linked_machines', 'agent_exec', 'swarm_send_message', 'gateway_call']) {
      expect(mcp.LINKED_WINDOW_TOOLS.has(t)).toBe(false)
    }
  })

  it('issues a session key for the file key only', async () => {
    const key = await session()
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(key).not.toBe(fileKey)
    // A session can't mint another, and the bridge needs none.
    expect((await request(port, '/mcp/session', key)).status).toBe(403)
    expect((await request(port, '/mcp/session', mcp.getMcpBridgeKey())).status).toBe(403)
    expect((await request(port, '/mcp/session', 'nope')).status).toBe(401)
    // And the session key works on /mcp.
    expect((await call(key, 'list_terminals')).body.result.content[0].text).toContain('"t1"')
  })

  it('counts session requests against the global limit', async () => {
    for (let i = 0; i < 200; i++) mcp.checkRateLimit('_global')
    expect((await request(port, '/mcp/session', fileKey)).status).toBe(429)
  })

  it('limits nobody while no job runs', async () => {
    expect(mcp.linkedJobWindowOpen()).toBe(false)
    expect((await call(fileKey, 'list_terminals')).body.result.isError).toBeUndefined()
  })

  it('limits the file key while a job runs, with a tool result the agent can read, and audits it', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const release = mcp.holdForLinkedJob()
    expect(mcp.linkedJobWindowOpen()).toBe(true)
    try {
      const res = await call(fileKey, 'list_terminals', 9)
      expect(res.status).toBe(200)
      expect(res.body).toEqual({
        jsonrpc: '2.0',
        id: 9,
        result: { content: [{ type: 'text', text: expect.stringMatching(new RegExp(`^Error: list_terminals ${REFUSAL.source}`)) }], isError: true },
      })
      expect(handlers.listTerminals).not.toHaveBeenCalled()
      expect(log.mock.calls.map((c) => String(c[0])).some((l) => /"tool":"list_terminals","status":"denied","detail":"linked job running"/.test(l))).toBe(true)
      // The read-only set still answers.
      expect((await call(fileKey, 'get_git_status')).body.result.isError).toBeUndefined()
      // tools/list stays whole, so the agent gets its tools back once the job ends.
      const list = await request(port, '/mcp', fileKey, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
      expect(list.body.result.tools.some((t: { name: string }) => t.name === 'run_command')).toBe(true)
    } finally {
      release()
      log.mockRestore()
    }
    expect(mcp.linkedJobWindowOpen()).toBe(false)
    expect((await call(fileKey, 'list_terminals')).body.result.content[0].text).toContain('"t1"')
  })

  it('refuses a call with no tool name, or one that is not a string, and answers a notification-shaped call with id null', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const release = mcp.holdForLinkedJob()
    try {
      expect((await call(fileKey, undefined)).body.result.content[0].text).toMatch(/^Error: undefined /)
      expect((await call(fileKey, 42)).body.result.isError).toBe(true)
      expect((await call(fileKey, 'run_command', null)).body.id).toBeNull()
    } finally {
      release()
      log.mockRestore()
    }
  })

  it('keeps every tool for a session key issued before the job, and limits one issued during it', async () => {
    const before = await session()
    const release = mcp.holdForLinkedJob()
    try {
      const during = await session()
      expect((await call(before, 'list_terminals')).body.result.content[0].text).toContain('"t1"')
      expect((await call(during, 'list_terminals')).body.result.isError).toBe(true)
    } finally {
      release()
    }
  })

  it('never limits the bridge key', async () => {
    const release = mcp.holdForLinkedJob()
    try {
      expect((await call(mcp.getMcpBridgeKey(), 'list_terminals')).body.result.content[0].text).toContain('"t1"')
    } finally {
      release()
    }
  })

  it('shares one window across overlapping jobs, and a release twice counts once', async () => {
    const first = mcp.holdForLinkedJob()
    const during = await session()
    const second = mcp.holdForLinkedJob()
    first()
    first()
    // The second job still runs: the window and the key issued in it stay limited.
    expect(mcp.linkedJobWindowOpen()).toBe(true)
    expect((await call(during, 'list_terminals')).body.result.isError).toBe(true)
    second()
    expect(mcp.linkedJobWindowOpen()).toBe(false)
    expect((await call(during, 'list_terminals')).status).toBe(401)
  })

  it('drops the keys issued during a job when it ends, so none of them passes as issued before a later one', async () => {
    const first = mcp.holdForLinkedJob()
    const during = await session()
    first()
    // Gone: its holder gets a 401, reads the file again and asks for a new session (stdio adapter).
    expect((await call(during, 'list_terminals')).status).toBe(401)
    const between = await session()
    const second = mcp.holdForLinkedJob()
    try {
      expect((await call(during, 'list_terminals')).status).toBe(401)
      // Issued while no job ran: every tool, as before the first job.
      expect((await call(between, 'list_terminals')).body.result.content[0].text).toContain('"t1"')
      const inSecond = await session()
      expect((await call(inSecond, 'list_terminals')).body.result.isError).toBe(true)
    } finally {
      second()
    }
  })

  it('drops the oldest session past 1,024', async () => {
    const oldest = mcp.issueMcpSession()
    for (let i = 0; i < 1024; i++) mcp.issueMcpSession()
    expect((await call(oldest, 'list_terminals')).status).toBe(401)
  })
})
