import * as http from 'http'

/**
 * Talks to Termpolis's own MCP server over loopback.
 *
 * Deliberately HTTP rather than an in-process call: this way remote traffic goes
 * through the same auth, rate limiting, and audit logging every other MCP client
 * does, and the bridge gains no privileged path of its own.
 */
export class LocalMcpClient {
  private nextId = 1

  constructor(
    private readonly port: number,
    private readonly token: string,
  ) {}

  callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++
    const payload = JSON.stringify({
      jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args },
    })

    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: this.port,
          path: '/mcp',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            Authorization: `Bearer ${this.token}`,
          },
        },
        (res) => {
          let body = ''
          res.on('data', (d) => (body += d))
          res.on('end', () => {
            if (res.statusCode !== 200) {
              reject(new Error(`MCP ${name}: HTTP ${res.statusCode}`))
              return
            }
            let parsed: {
              error?: { message?: string }
              result?: { isError?: boolean; content?: Array<{ text?: string }> }
            }
            try {
              parsed = JSON.parse(body)
            } catch (err) {
              reject(new Error(`MCP ${name}: bad response — ${(err as Error).message}`))
              return
            }

            // Transport-level JSON-RPC error.
            if (parsed.error) {
              reject(new Error(`MCP ${name}: ${parsed.error.message || 'unknown error'}`))
              return
            }

            const text = parsed.result?.content?.[0]?.text

            // Tool-level failure. This server reports it INSIDE result with isError,
            // not as a JSON-RPC error — miss it and "Error: Tool execution failed"
            // sails through to the phone dressed as data.
            if (parsed.result?.isError) {
              reject(new Error(`MCP ${name}: ${text ?? 'tool reported an error'}`))
              return
            }

            if (text === undefined) {
              resolve(parsed.result)
              return
            }

            // Exempt tools yield JSON; a non-exempt one yields Headroom-compressed
            // prose. Pass that through as text rather than throwing — the caller
            // gets something useful either way.
            try {
              resolve(JSON.parse(text))
            } catch {
              resolve(text)
            }
          })
        },
      )
      req.on('error', reject)
      req.write(payload)
      req.end()
    })
  }
}
