// The linked-job window of the local MCP server.
//
// The server's key sits in a file any process of this user can read (mcp-token), and a job another
// computer started here runs as this user: with a write grant it runs commands, and even a
// read-only job can read files. The stdio adapter refuses such a job's terminal, swarm and
// linked_machines calls, but that refusal runs in the job's own process tree, so a job that reads
// the file and calls the port itself would skip it. The server enforces it too, with what is here.
//
// While any inbound job runs ("the window"), a call made with the file's key, or with a session
// key issued during that window, may use only LINKED_WINDOW_TOOLS. Session keys issued before the
// window keep every tool: the user's agents and swarms that were already connected carry on. Keys
// issued during a window are forgotten when it closes, so none of them outlives it. The remote bridge (paired phones and computers) has its own in-memory key and is never limited.
//
// Kept apart from mcpServer.ts, which re-exports it, so main can hold the window and hand the
// bridge its key without depending on the server module.
import * as crypto from 'crypto'
import { RESTRICTED_RUN_TOOLS } from '../shared/agentIntegration'

/** What a call may use while the window is open: the read-only set a restricted run gets
 *  (RESTRICTED_RUN_TOOLS, which the adapter enforces client-side as DELEGATED_JOB_TOOLS), plus the
 *  two reads the memory primer hook makes. Nothing that writes memory, reads or types into a
 *  terminal, runs a command, touches the swarm, starts an agent or reaches another computer. */
export const LINKED_WINDOW_TOOLS: ReadonlySet<string> = new Set([...RESTRICTED_RUN_TOOLS, 'memory_primer', 'code_outline'])

export const LINKED_WINDOW_REFUSAL =
  'is not available while a job another computer started is running on this computer. ' +
  'Only reading memory and code works until it ends; try again then.'

/** The key the remote bridge uses. Never written to disk, never limited by the window. */
const MCP_BRIDGE_KEY = crypto.randomBytes(32).toString('hex')

export function getMcpBridgeKey(): string {
  return MCP_BRIDGE_KEY
}

/** Inbound jobs running now. */
let linkedHolds = 0

/** Session keys handed out by POST /mcp/session, each with whether it was issued while the window
 *  was open. Kept in issue order, so the oldest goes first past the cap. */
const sessions = new Map<string, boolean>()
const MAX_SESSIONS = 1024

/** Opens the window for one inbound job. Call the returned function once the job's process has
 *  ended; calling it again does nothing. Jobs that overlap share one window. */
export function holdForLinkedJob(): () => void {
  linkedHolds++
  let released = false
  return () => {
    if (released) return
    released = true
    if (--linkedHolds === 0) dropWindowSessions()
  }
}

/** Forgets every session key issued while the window was open, once it closes. Kept, such a key
 *  would carry on into the next window; dropped, its holder gets a 401, and the stdio adapter reads
 *  the key file again and asks for a new session. */
function dropWindowSessions(): void {
  for (const [key, inWindow] of sessions) if (inWindow) sessions.delete(key)
}

/** Whether a job another computer started is running here now. */
export function linkedJobWindowOpen(): boolean {
  return linkedHolds > 0
}

/** A fresh session key, issued now. */
export function issueMcpSession(): string {
  const key = crypto.randomBytes(32).toString('hex')
  sessions.set(key, linkedHolds > 0)
  while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value as string)
  return key
}

/** Test seam: forget every session and close the window. */
export function _resetLinkedWindowForTest(): void {
  sessions.clear()
  linkedHolds = 0
}

export type McpCaller = 'file' | 'bridge' | { inWindow: boolean }

/** Who a presented key belongs to, or null for a key this server never gave out. */
export function callerOf(key: string, fileKey: string): McpCaller | null {
  if (key === fileKey) return 'file'
  if (key === MCP_BRIDGE_KEY) return 'bridge'
  const inWindow = sessions.get(key)
  return inWindow === undefined ? null : { inWindow }
}

/** Whether this caller is held to LINKED_WINDOW_TOOLS right now. */
export function limitedNow(caller: McpCaller): boolean {
  if (linkedHolds === 0 || caller === 'bridge') return false
  if (caller === 'file') return true
  // A window's sessions are dropped when it closes (dropWindowSessions), so one marked inWindow was
  // issued in the window open now.
  return caller.inWindow
}
