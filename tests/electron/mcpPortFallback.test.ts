// Tests for MCP port fallback — when the base port is already taken (second
// Termpolis instance, leftover zombie process, some other dev tool), the
// server walks basePort..basePort+4 until it binds. If every candidate is
// taken it rejects the port-bound promise so `awaitMcpPortBound()` callers
// can surface an error instead of silently hanging. Uses a non-default base
// port via TERMPOLIS_MCP_BASE_PORT so a running dev Termpolis on 9315
// doesn't collide with the test range.

import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from 'vitest'
import * as http from 'http'
import * as net from 'net'

vi.mock('electron', () => ({ app: { getPath: () => '/fake' } }))

const {
  startMcpServer,
  stopMcpServer,
  awaitMcpPortBound,
  getMcpPort,
  _resetPortStateForTest,
} = await import('../../src/main/mcpServer')

function createMockHandlers(): any {
  return {
    listTerminals: vi.fn(),
    createTerminal: vi.fn(),
    runCommand: vi.fn(),
    readOutput: vi.fn(),
    closeTerminal: vi.fn(),
    writeToTerminal: vi.fn(),
    getFileTree: vi.fn(),
    getGitStatus: vi.fn(),
    swarmSendMessage: vi.fn(),
    swarmReadMessages: vi.fn(),
    swarmCreateTask: vi.fn(),
    swarmListTasks: vi.fn(),
    swarmUpdateTask: vi.fn(),
    swarmListAgents: vi.fn(),
    memoryWrite: vi.fn(),
    memorySearch: vi.fn(),
    memoryList: vi.fn(),
  }
}

// Bind a plain HTTP server on a specific port to simulate "port taken".
function occupy(port: number): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const s = http.createServer(() => {})
    s.once('error', reject)
    s.listen(port, '127.0.0.1', () => resolve(s))
  })
}

function closeAll(servers: http.Server[]): Promise<void> {
  return Promise.all(servers.map(s => new Promise<void>(r => s.close(() => r())))).then(() => {})
}

// Ask the kernel for a contiguous run of N free ports starting at some base.
// We keep probing upward until we find a window where every port in the range
// is free at probe time — avoids colliding with a user's running Termpolis.
async function findFreeBasePort(count: number, startFrom = 19315): Promise<number> {
  for (let base = startFrom; base < startFrom + 2000; base += count) {
    const ok = await Promise.all(
      Array.from({ length: count }, (_, i) => isFree(base + i)),
    )
    if (ok.every(Boolean)) return base
  }
  throw new Error('no free port window found for test')
}

function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.once('error', () => resolve(false))
    s.listen(port, '127.0.0.1', () => {
      s.close(() => resolve(true))
    })
  })
}

let BASE: number

describe('MCP port fallback', () => {
  const blockers: http.Server[] = []
  let mcpServer: http.Server | null = null

  beforeAll(async () => {
    BASE = await findFreeBasePort(5)
    process.env.TERMPOLIS_MCP_BASE_PORT = String(BASE)
  })

  afterAll(() => {
    delete process.env.TERMPOLIS_MCP_BASE_PORT
  })

  afterEach(async () => {
    if (mcpServer) {
      stopMcpServer(mcpServer)
      await new Promise<void>(r => mcpServer!.once('close', () => r()))
      mcpServer = null
    }
    await closeAll(blockers.splice(0))
    _resetPortStateForTest()
  })

  it('binds base port when free', async () => {
    mcpServer = startMcpServer(createMockHandlers())
    const bound = await awaitMcpPortBound()
    expect(bound).toBe(BASE)
    expect(getMcpPort()).toBe(BASE)
  })

  it('falls back to base+1 when base is taken', async () => {
    blockers.push(await occupy(BASE))
    mcpServer = startMcpServer(createMockHandlers())
    const bound = await awaitMcpPortBound()
    expect(bound).toBe(BASE + 1)
    expect(getMcpPort()).toBe(BASE + 1)
  })

  it('walks up to base+4 when base..base+3 are all taken', async () => {
    for (let i = 0; i < 4; i++) blockers.push(await occupy(BASE + i))
    mcpServer = startMcpServer(createMockHandlers())
    const bound = await awaitMcpPortBound()
    expect(bound).toBe(BASE + 4)
  })

  it('rejects awaitMcpPortBound when all 5 candidate ports are taken', async () => {
    for (let i = 0; i < 5; i++) blockers.push(await occupy(BASE + i))
    mcpServer = startMcpServer(createMockHandlers())
    await expect(awaitMcpPortBound()).rejects.toThrow(/could not bind any port/i)
    // The server never bound — null out so afterEach skips stopMcpServer
    mcpServer = null
  })

  it('getMcpPort falls back to base port before bind completes', () => {
    expect(getMcpPort()).toBe(BASE)
  })

  it('awaitMcpPortBound resolves immediately when already bound (idempotent)', async () => {
    mcpServer = startMcpServer(createMockHandlers())
    const first = await awaitMcpPortBound()
    const second = await awaitMcpPortBound()
    expect(first).toBe(second)
  })

  it('multiple concurrent awaiters all resolve to the same port', async () => {
    mcpServer = startMcpServer(createMockHandlers())
    const [a, b, c] = await Promise.all([
      awaitMcpPortBound(),
      awaitMcpPortBound(),
      awaitMcpPortBound(),
    ])
    expect(a).toBe(b)
    expect(b).toBe(c)
    expect(a).toBe(BASE)
  })
})
