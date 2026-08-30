import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import {
  frameRequest,
  drainMessages,
  parseToolList,
  parseToolResult,
  httpTransport,
  stdioTransport,
  transportFor,
  nextRequestId,
  resetRequestIds,
  UPSTREAM_TIMEOUT_MS,
} from '../../src/main/mcpGateway/client'

describe('mcpGateway/client framing', () => {
  beforeEach(() => resetRequestIds())

  it('frames a newline-delimited JSON-RPC request', () => {
    const line = frameRequest('tools/list', { a: 1 }, 7)
    expect(line.endsWith('\n')).toBe(true)
    expect(JSON.parse(line)).toEqual({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: { a: 1 } })
  })

  it('hands out monotonically increasing request ids', () => {
    expect(nextRequestId()).toBe(1)
    expect(nextRequestId()).toBe(2)
    resetRequestIds()
    expect(nextRequestId()).toBe(1)
  })

  it('drains only complete lines and keeps the partial tail', () => {
    const { messages, rest } = drainMessages('{"id":1}\n{"id":2}\n{"id":3')
    expect(messages).toEqual([{ id: 1 }, { id: 2 }])
    expect(rest).toBe('{"id":3')
  })

  it('returns nothing when no newline has arrived yet', () => {
    expect(drainMessages('{"id":1}')).toEqual({ messages: [], rest: '{"id":1}' })
  })

  it('skips a server logging plain text to stdout instead of stranding the chunk', () => {
    // The bug this guards: one un-parseable line failing the whole drain would strand
    // every real response that arrived in the same chunk.
    const { messages } = drainMessages('starting up...\n{"id":1}\n\n{"id":2}\n')
    expect(messages).toEqual([{ id: 1 }, { id: 2 }])
  })

  it('normalises a tools/list result and drops entries without a name', () => {
    const tools = parseToolList({ tools: [{ name: 'a', description: 'A', inputSchema: { type: 'object' } }, { description: 'no name' }, { name: 'b' }] })
    expect(tools).toEqual([
      { name: 'a', description: 'A', inputSchema: { type: 'object' } },
      { name: 'b', inputSchema: undefined },
    ])
  })

  it('returns an empty list for any non-array tools field', () => {
    expect(parseToolList({})).toEqual([])
    expect(parseToolList(null)).toEqual([])
    expect(parseToolList({ tools: 'nope' })).toEqual([])
  })

  it('flattens a content array to text and stringifies non-text parts', () => {
    expect(parseToolResult({ content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] })).toBe('one\ntwo')
    expect(parseToolResult({ content: [{ type: 'image', data: 'xyz' }] })).toBe('{"type":"image","data":"xyz"}')
  })

  it('stringifies an unrecognised result rather than dropping it', () => {
    expect(parseToolResult('plain')).toBe('plain')
    expect(parseToolResult({ odd: 1 })).toBe('{"odd":1}')
    expect(parseToolResult(null)).toBe('null')
    expect(parseToolResult(undefined)).toBe('null')
  })
})

describe('mcpGateway/client httpTransport', () => {
  beforeEach(() => resetRequestIds())

  const okFetch = (result: unknown) =>
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ result }) })) as unknown as typeof fetch

  it('lists tools over POSTed JSON-RPC', async () => {
    const fetchImpl = okFetch({ tools: [{ name: 'search' }] })
    const t = httpTransport({ id: 'web', url: 'http://x/mcp' }, fetchImpl)
    expect(await t.listTools()).toEqual([{ name: 'search', inputSchema: undefined }])
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe('http://x/mcp')
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({ method: 'tools/list' })
  })

  it('calls a tool and flattens the result', async () => {
    const t = httpTransport({ id: 'web', url: 'http://x/mcp' }, okFetch({ content: [{ type: 'text', text: 'hi' }] }))
    expect(await t.callTool('search', { q: 1 })).toBe('hi')
  })

  it('throws on a non-2xx response', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 502, json: async () => ({}) })) as unknown as typeof fetch
    const t = httpTransport({ id: 'web', url: 'http://x/mcp' }, fetchImpl)
    await expect(t.listTools()).rejects.toThrow('upstream HTTP 502')
  })

  it('surfaces a JSON-RPC error body as a throw', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ error: { message: 'no such tool' } }) })) as unknown as typeof fetch
    await expect(httpTransport({ id: 'web', url: 'http://x/mcp' }, fetchImpl).callTool('nope', {})).rejects.toThrow('no such tool')
  })

  it('falls back to a generic message for an error body with no message', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ error: {} }) })) as unknown as typeof fetch
    await expect(httpTransport({ id: 'web', url: 'http://x/mcp' }, fetchImpl).callTool('nope', {})).rejects.toThrow('upstream error')
  })

  it('bounds an upstream request so a hung server cannot hang the agent', () => {
    expect(UPSTREAM_TIMEOUT_MS).toBe(30_000)
  })
})

describe('mcpGateway/client stdioTransport', () => {
  class FakeChild extends EventEmitter {
    stdout = new EventEmitter() as EventEmitter & { setEncoding: (e: string) => void }
    stderr = new EventEmitter() as EventEmitter & { resume: () => void }
    stdin = { write: vi.fn() }
    killed = false
    exitCode: number | null = null
    kill = vi.fn(() => { this.killed = true; return true })
    constructor() {
      super()
      this.stdout.setEncoding = vi.fn()
      this.stderr.resume = vi.fn()
    }
    reply(id: number, body: Record<string, unknown>): void {
      this.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id, ...body })}\n`)
    }
  }

  let child: FakeChild
  const spawnImpl = (): FakeChild => child

  beforeEach(() => {
    resetRequestIds()
    child = new FakeChild()
    vi.useFakeTimers()
  })
  afterEach(() => vi.useRealTimers())

  const make = () => stdioTransport({ id: 'local', command: 'server', args: ['--stdio'] }, spawnImpl as never)

  it('spawns lazily, lists tools, and reuses the same child across calls', async () => {
    const t = make()
    const first = t.listTools()
    child.reply(1, { result: { tools: [{ name: 'ping' }] } })
    expect(await first).toEqual([{ name: 'ping', inputSchema: undefined }])

    const second = t.callTool('ping', {})
    child.reply(2, { result: { content: [{ type: 'text', text: 'pong' }] } })
    expect(await second).toBe('pong')
    // Reused, not re-spawned: MCP servers expect `initialize` once.
    expect(child.stdin.write).toHaveBeenCalledTimes(2)
    expect(child.stderr.resume).toHaveBeenCalledTimes(1)
  })

  it('rejects with the upstream error message', async () => {
    const t = make()
    const p = t.callTool('ping', {})
    child.reply(1, { error: { message: 'bad args' } })
    await expect(p).rejects.toThrow('bad args')
  })

  it('rejects with a generic message when the error carries none', async () => {
    const t = make()
    const p = t.callTool('ping', {})
    child.reply(1, { error: {} })
    await expect(p).rejects.toThrow('upstream error')
  })

  it('ignores a message with no numeric id and an id nothing is waiting on', async () => {
    const t = make()
    const p = t.callTool('ping', {})
    child.stdout.emit('data', '{"jsonrpc":"2.0","method":"notifications/message"}\n')
    child.reply(99, { result: 'stray' })
    child.reply(1, { result: 'real' })
    expect(await p).toBe('real')
  })

  it('times out rather than waiting forever on a silent server', async () => {
    const t = make()
    const p = t.callTool('ping', {})
    const assertion = expect(p).rejects.toThrow(/timed out after 30000ms/)
    await vi.advanceTimersByTimeAsync(UPSTREAM_TIMEOUT_MS + 1)
    await assertion
  })

  it('settles everything in flight when the child exits', async () => {
    const t = make()
    const p = t.callTool('ping', {})
    child.emit('exit', 1)
    await expect(p).rejects.toThrow('MCP server "local" exited')
  })

  it('settles everything in flight when the child errors', async () => {
    const t = make()
    const p = t.callTool('ping', {})
    child.emit('error', new Error('ENOENT'))
    await expect(p).rejects.toThrow('ENOENT')
  })

  it('wraps a non-Error spawn failure', async () => {
    const t = make()
    const p = t.callTool('ping', {})
    child.emit('error', 'exploded')
    await expect(p).rejects.toThrow('exploded')
  })

  it('rejects rather than leaking a pending entry when the write fails', async () => {
    const t = make()
    child.stdin.write.mockImplementationOnce(() => { throw new Error('EPIPE') })
    await expect(t.callTool('ping', {})).rejects.toThrow('EPIPE')
  })

  it('respawns after the child is gone instead of writing into a closed pipe', async () => {
    const t = make()
    const first = t.listTools()
    child.reply(1, { result: { tools: [] } })
    await first

    const dead = child
    dead.exitCode = 0
    child = new FakeChild()
    const second = t.listTools()
    child.reply(2, { result: { tools: [{ name: 'again' }] } })
    expect((await second)[0].name).toBe('again')
    expect(dead.stdin.write).toHaveBeenCalledTimes(1)
  })

  it('disposes: settles pending calls, kills the child, and survives a kill that throws', async () => {
    const t = make()
    const p = t.callTool('ping', {})
    child.kill.mockImplementationOnce(() => { throw new Error('already dead') })
    expect(() => t.dispose()).not.toThrow()
    await expect(p).rejects.toThrow('disposed')
  })

  it('picks the transport from the spec shape', () => {
    expect(transportFor({ id: 'a', url: 'http://x' })).toHaveProperty('id', 'a')
    expect(transportFor({ id: 'b', command: 'x' })).toHaveProperty('id', 'b')
  })
})
