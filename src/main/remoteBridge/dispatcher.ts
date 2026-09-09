import { assertAllowed } from './remotePolicy'
import type { Capabilities, RemoteRequest } from './protocol'

interface McpLike {
  callTool(name: string, args: Record<string, unknown>, deviceId: string): Promise<unknown>
}

/** The bytes that make a terminal act on what was typed rather than type more of
 *  it. Only a run at the very END of the text is a submit -- newlines in the
 *  middle are content the phone wrapped in a bracketed paste, and splitting
 *  those would submit a half-written message. */
const TRAILING_SUBMIT = /[\r\n]+$/

/** How long the body is left alone before the carriage return follows it.
 *
 *  This is not padding for a slow machine. Agent TUIs decide whether bytes are
 *  TYPED or PASTED by how they arrive, and one pty write is one stdin read at
 *  the far end (measured). Send `text\r` fused and Codex reads a single burst,
 *  classifies the whole thing as a paste, and files the carriage return as
 *  content: the message lands in the `›` composer and just sits there -- exactly
 *  the bug reported from the phone. Send the same bytes as two reads a beat
 *  apart and it submits.
 *
 *  Measured against real agents on Windows/ConPTY:
 *
 *    agent          fused `text\r`        split (this path)
 *    Claude Code    submits               submits
 *    Codex          NOT submitted         submits
 *    Gemini         unverified            unverified
 *
 *  Gemini is unverified rather than assumed: every probe run landed on its
 *  sign-in screen, never a composer, so there is no result to record. The split
 *  is still the safer default for it, because split is what a HUMAN looks like
 *  at the pty -- text, a pause, then Enter -- and an agent that refused that
 *  would refuse a person typing.
 *
 *  150ms is comfortably past the burst windows those TUIs use (tens of ms) and
 *  far under what anyone notices on a message they just sent from a phone. */
export const SUBMIT_SETTLE_MS = 150

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Translates remote requests into MCP tool calls, after checking capability. */
export class RequestDispatcher {
  /** `settle` is injected only so tests do not spend real time asleep. Nothing
   *  in production passes it. */
  constructor(
    private readonly mcp: McpLike,
    private readonly settle: (ms: number) => Promise<void> = wait,
  ) {}

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
        return this.writeThenSubmit(request.terminalId, request.text, deviceId)
      case 'closeTerminal':
        return this.mcp.callTool('close_terminal', { terminalId: request.terminalId }, deviceId)
      case 'subscribe':
      case 'unsubscribe':
        // Subscription state lives in OutputFanout; nothing to ask MCP for.
        return { ok: true }
    }
  }

  /**
   * Types the message, then presses Enter -- as two writes, not one.
   *
   * The split lives HERE, on the remote path, and not inside the
   * `write_to_terminal` MCP tool. That tool is raw by contract ("without
   * pressing Enter") and local agents depend on it staying that way; a delay
   * baked in there would slow every scripted write to buy something only a
   * human-typed message needs. It does not live on the phone either: two relay
   * messages would put network jitter in charge of the gap, and the fix would
   * need a new TestFlight build to reach anyone.
   *
   * Text with no trailing newline is forwarded untouched, in one call, so a
   * client sending raw keystrokes still gets raw keystrokes. A bare newline is
   * likewise one call -- there is no body for it to settle behind.
   *
   * Both writes are awaited and a failure in either is propagated. Reporting
   * success when the Enter never landed would tell the phone to clear a
   * composer whose message is still sitting unsent on the desktop.
   */
  private async writeThenSubmit(
    terminalId: string,
    text: string,
    deviceId: string,
  ): Promise<unknown> {
    const submit = TRAILING_SUBMIT.exec(text)
    if (submit === null || submit.index === 0) {
      return this.mcp.callTool('write_to_terminal', { terminalId, text }, deviceId)
    }

    await this.mcp.callTool(
      'write_to_terminal',
      { terminalId, text: text.slice(0, submit.index) },
      deviceId,
    )
    await this.settle(SUBMIT_SETTLE_MS)
    return this.mcp.callTool(
      'write_to_terminal',
      { terminalId, text: text.slice(submit.index) },
      deviceId,
    )
  }
}
