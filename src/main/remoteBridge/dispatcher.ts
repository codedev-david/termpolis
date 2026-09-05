import { assertAllowed } from './remotePolicy'
import type { Capabilities, RemoteRequest } from './protocol'

interface McpLike {
  callTool(name: string, args: Record<string, unknown>, deviceId: string): Promise<unknown>
}

/** Translates remote requests into MCP tool calls, after checking capability. */
export class RequestDispatcher {
  constructor(private readonly mcp: McpLike) {}

  /** `deviceId` is carried through to MCP purely so the audit line names the
   *  phone. It is NOT part of authorisation -- `caps` is, and it was resolved
   *  from the registry before this was called. */
  async dispatch(request: RemoteRequest, caps: Capabilities, deviceId: string): Promise<unknown> {
    // Capability first, always — never let an unauthorized request reach MCP.
    assertAllowed(request, caps)

    switch (request.kind) {
      case 'listTerminals':
        return this.mcp.callTool('list_terminals', {}, deviceId)
      case 'createTerminal':
        return this.mcp.callTool('create_terminal', {
          name: request.name,
          ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        }, deviceId)
      case 'runCommand':
        return this.mcp.callTool('run_command', {
          terminalId: request.terminalId, command: request.command,
        }, deviceId)
      case 'writeToTerminal':
        return this.mcp.callTool('write_to_terminal', {
          terminalId: request.terminalId, text: request.text,
        }, deviceId)
      case 'closeTerminal':
        return this.mcp.callTool('close_terminal', { terminalId: request.terminalId }, deviceId)
      case 'subscribe':
      case 'unsubscribe':
        // Subscription state lives in OutputFanout; nothing to ask MCP for.
        return { ok: true }
    }
  }
}
