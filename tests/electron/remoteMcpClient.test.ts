import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as http from 'http'
import { LocalMcpClient } from '../../src/main/remoteBridge/mcpClient'

let server: http.Server
let port: number
let lastAuth: string | undefined

beforeAll(async () => {
  server = http.createServer((req, res) => {
    lastAuth = req.headers.authorization
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (lastAuth !== 'Bearer good-token') {
        res.writeHead(401); res.end('unauthorized'); return
      }
      const parsed = JSON.parse(body)
      if (parsed.params.name === 'explodes') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, error: { message: 'tool blew up' } }))
        return
      }
      // How mcpServer.ts ACTUALLY reports a failed tool: inside result, with isError.
      if (parsed.params.name === 'fails_softly') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          jsonrpc: '2.0', id: parsed.id,
          result: { content: [{ type: 'text', text: 'Error: Tool execution failed' }], isError: true },
        }))
        return
      }
      // A non-exempt tool comes back Headroom-compressed: not JSON.
      if (parsed.params.name === 'compressed') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          jsonrpc: '2.0', id: parsed.id,
          result: { content: [{ type: 'text', text: 'summary line\n\n[headroom] Full result cached — call the retrieve_full tool with token "hr_abc".' }] },
        }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        jsonrpc: '2.0', id: parsed.id,
        result: { content: [{ type: 'text', text: JSON.stringify({ echoed: parsed.params.name }) }] },
      }))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as { port: number }).port
})

afterAll(() => new Promise<void>((r) => server.close(() => r())))

describe('LocalMcpClient', () => {
  it('calls a tool and returns the parsed result', async () => {
    const c = new LocalMcpClient(port, 'good-token')
    expect(await c.callTool('list_terminals', {})).toEqual({ echoed: 'list_terminals' })
  })

  it('sends the bearer token', async () => {
    await new LocalMcpClient(port, 'good-token').callTool('list_terminals', {})
    expect(lastAuth).toBe('Bearer good-token')
  })

  it('rejects when the server returns a JSON-RPC error', async () => {
    const c = new LocalMcpClient(port, 'good-token')
    await expect(c.callTool('explodes', {})).rejects.toThrow(/tool blew up/)
  })

  it('rejects an isError result instead of passing it off as data', async () => {
    const c = new LocalMcpClient(port, 'good-token')
    await expect(c.callTool('fails_softly', {})).rejects.toThrow(/Tool execution failed/)
  })

  it('passes Headroom-compressed text through instead of throwing on it', async () => {
    const c = new LocalMcpClient(port, 'good-token')
    const out = await c.callTool('compressed', {})
    expect(typeof out).toBe('string')
    expect(out as string).toMatch(/summary line/)
  })

  it('rejects on a bad token rather than returning undefined', async () => {
    const c = new LocalMcpClient(port, 'wrong-token')
    await expect(c.callTool('list_terminals', {})).rejects.toThrow()
  })

  it('rejects when nothing is listening', async () => {
    const c = new LocalMcpClient(1, 'good-token')
    await expect(c.callTool('list_terminals', {})).rejects.toThrow()
  })
})
