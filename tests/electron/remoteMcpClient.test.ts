import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as http from 'http'
import { LocalMcpClient, MCP_CALL_TIMEOUT_MS } from '../../src/main/remoteBridge/mcpClient'

let server: http.Server
let port: number
let lastAuth: string | undefined
let lastDevice: string | string[] | undefined
/** Resolves when the server end of the deliberately-unanswered request closes.
 *  Set by the `never_answers` branch below; the only way to prove from outside
 *  the client that giving up actually released the socket. */
let hungSocketClosed: Promise<void> | null = null

beforeAll(async () => {
  server = http.createServer((req, res) => {
    lastAuth = req.headers.authorization
    lastDevice = req.headers['x-termpolis-device']
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
      // A JSON-RPC error with no message, and a soft failure with no content. Both
      // are legal on the wire and both must still produce a readable error: a phone
      // showing 'MCP x: undefined' tells the user nothing about what went wrong.
      if (parsed.params.name === 'terse_error') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, error: { code: -32000 } }))
        return
      }
      if (parsed.params.name === 'terse_soft_failure') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { isError: true } }))
        return
      }
      // A body that is not JSON at all. This is what a crashed or half-written
      // response looks like on the wire, and it must surface as a clean error
      // rather than an unhandled JSON.parse throw inside the response handler.
      if (parsed.params.name === 'garbage') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('<html>proxy error</html>')
        return
      }
      // A well-formed result carrying no content array — some tools answer with a
      // bare object. There is no text to unwrap, so the raw result is what the
      // caller gets.
      if (parsed.params.name === 'no_content') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { closed: true } }))
        return
      }
      // Accepts the request and then says nothing, for ever. A wedged tool and a
      // black-holed socket look exactly like this from the client's side.
      if (parsed.params.name === 'never_answers') {
        hungSocketClosed = new Promise<void>((r) => req.socket.on('close', () => r()))
        return
      }
      // Answers, but not instantly. Proves the bound is a deadline for the call
      // and not a ban on taking any time at all.
      if (parsed.params.name === 'slow') {
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            jsonrpc: '2.0', id: parsed.id,
            result: { content: [{ type: 'text', text: JSON.stringify({ late: true }) }] },
          }))
        }, 40)
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

/** Sixteen lowercase hex, the shape `pairing.ts` mints and the shape the MCP
 *  server's audit logger insists on. */
const DEVICE = 'a1b2c3d4e5f60718'

describe('LocalMcpClient', () => {
  it('calls a tool and returns the parsed result', async () => {
    const c = new LocalMcpClient(port, 'good-token')
    expect(await c.callTool('list_terminals', {}, DEVICE)).toEqual({ echoed: 'list_terminals' })
  })

  it('names the originating device in a header', async () => {
    // Spec section 4.4. The MCP server writes this into `mcp-audit.log`, which is
    // the only record that can answer "which paired phone typed that". A header
    // rather than a JSON-RPC param so no tool can ever see it as an argument.
    await new LocalMcpClient(port, 'good-token').callTool('list_terminals', {}, DEVICE)
    expect(lastDevice).toBe(DEVICE)
  })

  it('sends the bearer token', async () => {
    await new LocalMcpClient(port, 'good-token').callTool('list_terminals', {}, DEVICE)
    expect(lastAuth).toBe('Bearer good-token')
  })

  it('rejects when the server returns a JSON-RPC error', async () => {
    const c = new LocalMcpClient(port, 'good-token')
    await expect(c.callTool('explodes', {}, DEVICE)).rejects.toThrow(/tool blew up/)
  })

  it('rejects an isError result instead of passing it off as data', async () => {
    const c = new LocalMcpClient(port, 'good-token')
    await expect(c.callTool('fails_softly', {}, DEVICE)).rejects.toThrow(/Tool execution failed/)
  })

  it('passes Headroom-compressed text through instead of throwing on it', async () => {
    const c = new LocalMcpClient(port, 'good-token')
    const out = await c.callTool('compressed', {}, DEVICE)
    expect(typeof out).toBe('string')
    expect(out as string).toMatch(/summary line/)
  })

  it('rejects on a bad token rather than returning undefined', async () => {
    const c = new LocalMcpClient(port, 'wrong-token')
    await expect(c.callTool('list_terminals', {}, DEVICE)).rejects.toThrow()
  })

  it('rejects when nothing is listening', async () => {
    const c = new LocalMcpClient(1, 'good-token')
    await expect(c.callTool('list_terminals', {}, DEVICE)).rejects.toThrow()
  })

  it('reports a non-JSON body as an error instead of throwing', async () => {
    const c = new LocalMcpClient(port, 'good-token')
    await expect(c.callTool('garbage', {}, DEVICE)).rejects.toThrow(/MCP garbage: bad response/)
  })

  it('returns the raw result when the tool answered without a content array', async () => {
    const c = new LocalMcpClient(port, 'good-token')
    await expect(c.callTool('no_content', {}, DEVICE)).resolves.toEqual({ closed: true })
  })

  it('names the tool even when the JSON-RPC error carries no message', async () => {
    const c = new LocalMcpClient(port, 'good-token')
    await expect(c.callTool('terse_error', {}, DEVICE)).rejects.toThrow('MCP terse_error: unknown error')
  })

  it('names the tool even when a soft failure carries no text', async () => {
    const c = new LocalMcpClient(port, 'good-token')
    await expect(c.callTool('terse_soft_failure', {}, DEVICE)).rejects.toThrow(
      'MCP terse_soft_failure: tool reported an error',
    )
  })

  describe('a call that never comes back', () => {
    it('gives up rather than hanging for ever', async () => {
      // Without a bound this promise never settles. The phone shows neither an
      // answer nor an error -- its spinner runs until the user force-quits, which
      // is the one failure mode a remote control must not have.
      const c = new LocalMcpClient(port, 'good-token', 60)
      await expect(c.callTool('never_answers', {}, DEVICE)).rejects.toThrow(
        'MCP never_answers: no response after 60ms',
      )
    })

    it('releases the socket it gave up on', async () => {
      // Rejecting is not enough on its own. A settled promise over a socket still
      // held open leaks one file descriptor per attempt, and a phone that retries
      // is a phone that attempts often.
      const c = new LocalMcpClient(port, 'good-token', 60)
      await expect(c.callTool('never_answers', {}, DEVICE)).rejects.toThrow()
      expect(hungSocketClosed).not.toBeNull()
      await hungSocketClosed
    })

    it('waits for an answer that is merely slow', async () => {
      // The bound is a deadline for the whole call, not an objection to latency.
      const c = new LocalMcpClient(port, 'good-token', 400)
      await expect(c.callTool('slow', {}, DEVICE)).resolves.toEqual({ late: true })
    })

    it('defaults to a bound longer than any tool here takes', () => {
      // `run_command` answers once the command is DISPATCHED and output arrives
      // later on the fan-out, so no legitimate call approaches this.
      expect(MCP_CALL_TIMEOUT_MS).toBe(10_000)
      expect(new LocalMcpClient(port, 'good-token')).toBeInstanceOf(LocalMcpClient)
    })
  })
})
