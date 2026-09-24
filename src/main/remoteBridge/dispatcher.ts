import { basename } from 'path'

import { listHomeDirectory } from './directoryPicker'
import { assertAllowed } from './remotePolicy'
import type {
  Capabilities,
  DirectoryListing,
  LaunchedAgent,
  RemoteAgent,
  RemoteRequest,
} from './protocol'

interface McpLike {
  callTool(name: string, args: Record<string, unknown>, deviceId: string): Promise<unknown>
}

/** The command each selectable agent runs. The phone picks a key from a closed
 *  set (`RemoteAgent`); the desktop owns the mapping to a real binary, so no
 *  phone-supplied string is ever the command. `gemini` launches `agy` -- the
 *  Gemini agent's binary is not named after it. This is the same command the
 *  local "new AI terminal" flow runs, reached a different way. */
const AGENT_BINARY: Record<RemoteAgent, string> = { claude: 'claude', codex: 'codex', gemini: 'agy' }

/** Human label for each agent -- names the terminal and rides back to the phone
 *  so it can say which agent it just started. */
const AGENT_LABEL: Record<RemoteAgent, string> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' }

/** Recovers the terminal id from `create_terminal`'s result. That tool is
 *  Headroom-exempt and returns `{ terminalId, name }`, which the MCP client
 *  parses back into an object; a bare string is accepted too so a change to the
 *  tool's shape degrades to "no id" rather than a wrong one. */
function terminalIdOf(result: unknown): string | null {
  if (typeof result === 'string' && result.length > 0) return result
  if (result !== null && typeof result === 'object') {
    const id = (result as { terminalId?: unknown }).terminalId
    if (typeof id === 'string' && id.length > 0) return id
  }
  return null
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
    /** Injected only so a test can list a fixture tree instead of the real home.
     *  Nothing in production passes it. */
    private readonly listDir: (path?: string) => DirectoryListing = listHomeDirectory,
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
      case 'listDirectory':
        // Bridge-local fs, home-rooted. `path` is typed string|undefined here but
        // arrives unvalidated over the wire; listHomeDirectory ignores anything
        // that is not a real directory under home, so it is safe to hand straight
        // over.
        return this.listDir(request.path)
      case 'launchAgent':
        return this.launchAgent(request.agent, request.cwd, deviceId)
    }
  }

  /**
   * Opens a terminal in `cwd` and starts the chosen agent in it -- the remote
   * form of the desktop's own "new AI terminal".
   *
   * The command is composed HERE from a three-value enum, never from anything the
   * phone typed, which is why this rides `createTerminal` and not
   * `writeToTerminal`. The relay boundary validates only the request KIND
   * (relayClient.ts), so `agent` and `cwd` are re-checked before either reaches
   * MCP: an unknown agent or an empty cwd is refused rather than passed to
   * `create_terminal`.
   *
   * The two MCP calls are separated by the same settle the typed-message path
   * uses. `run_command` reaches the just-spawned PTY as a single burst, and an
   * agent TUI still drawing its first frame can swallow a command fused onto its
   * startup -- the exact class of "typed it and nothing happened" the split cured
   * for messages. The terminal id is recovered from `create_terminal` so the
   * phone can navigate straight to the terminal it just made.
   */
  private async launchAgent(agent: RemoteAgent, cwd: unknown, deviceId: string): Promise<LaunchedAgent> {
    if (!Object.prototype.hasOwnProperty.call(AGENT_BINARY, agent)) {
      throw new Error('remote device asked to launch an unknown agent')
    }
    if (typeof cwd !== 'string' || cwd.length === 0) {
      throw new Error('remote device asked to launch an agent with no working directory')
    }

    const name = `${AGENT_LABEL[agent]} · ${basename(cwd) || cwd}`
    const created = await this.mcp.callTool('create_terminal', { name, cwd }, deviceId)
    const terminalId = terminalIdOf(created)
    if (terminalId === null) {
      throw new Error('create_terminal did not return a terminal id')
    }

    await this.settle(SUBMIT_SETTLE_MS)
    await this.mcp.callTool('run_command', { terminalId, command: AGENT_BINARY[agent] }, deviceId)
    return { terminalId, name }
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
