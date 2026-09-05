import * as http from 'http'

/**
 * Talks to Termpolis's own MCP server over loopback.
 *
 * Deliberately HTTP rather than an in-process call: this way remote traffic goes
 * through the same auth, rate limiting, and audit logging every other MCP client
 * does, and the bridge gains no privileged path of its own.
 */
/** How long one MCP call may wait before the bridge gives up on it.
 *
 *  Without a bound, a request the server never answers -- wedged tool, socket
 *  black-holed by a firewall rule that appeared mid-call -- leaves a promise that
 *  never settles and a socket that is never released. The phone gets neither an
 *  answer nor an error: its spinner runs until the user force-quits, and every
 *  retry adds another dead socket to the bridge.
 *
 *  Ten seconds. Longer than any tool this client calls actually takes, and short
 *  enough that a user who tapped a button has not yet concluded the app is
 *  broken. It is NOT a bound on how long a command may run: `run_command` answers
 *  once the command is dispatched, and output arrives later on the fan-out. */
export const MCP_CALL_TIMEOUT_MS = 10_000

export class LocalMcpClient {
  private nextId = 1

  constructor(
    private readonly port: number,
    private readonly token: string,
    /** Injected only so a test can reach the timeout without waiting for it. */
    private readonly timeoutMs: number = MCP_CALL_TIMEOUT_MS,
  ) {}

  /** Call a tool on behalf of one paired device.
   *
   *  `deviceId` is not optional on purpose. Spec section 4.4 promises the user
   *  that "audit entries are tagged with the originating device", and an audit
   *  trail that cannot say WHICH phone typed into a terminal answers none of the
   *  questions it exists to answer. A default would let a new call site drop the
   *  tag by saying nothing; a required argument cannot be forgotten. */
  callTool(name: string, args: Record<string, unknown>, deviceId: string): Promise<unknown> {
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
            // Read back by the MCP server's audit logger, which validates the
            // shape before it writes it. Sent as a header rather than folded
            // into the JSON-RPC params so no tool ever sees it as an argument:
            // it describes who asked, not what to do.
            'X-Termpolis-Device': deviceId,
          },
          // Applied to the socket, so it covers a server that accepts the
          // connection and then says nothing as well as one that never accepts.
          timeout: this.timeoutMs,
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
      // `timeout` only REPORTS that the socket went quiet -- Node does not abort
      // on it. Destroying the request is what frees the socket, and it surfaces
      // here as an 'error' so there is one settle path rather than two.
      req.on('timeout', () => {
        req.destroy(new Error(`MCP ${name}: no response after ${this.timeoutMs}ms`))
      })
      req.on('error', reject)
      req.write(payload)
      req.end()
    })
  }
}
