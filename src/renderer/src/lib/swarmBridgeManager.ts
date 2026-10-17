/**
 * Swarm Bridge Manager — lifecycle management for non-MCP agent bridges.
 *
 * For each non-MCP agent terminal, reads what it printed every 5 seconds and posts what its
 * screen settled on to the swarm message bus (swarmBridge.ts says what that is).
 */

import { WorkerFeed } from './swarmBridge'
import { recordSwarmError } from './sentry'

const POLL_INTERVAL_MS = 5000

const activeBridges = new Map<string, ReturnType<typeof setInterval>>()
const outputOffsets = new Map<string, number>()
const feeds = new Map<string, WorkerFeed>()

/**
 * Start a bridge for a non-MCP agent terminal.
 * Polls terminal output and posts what the agent's screen shows.
 */
export function startBridgeForAgent(terminalId: string, agentName: string): void {
  if (activeBridges.has(terminalId)) return

  outputOffsets.set(terminalId, 0)
  feeds.set(terminalId, new WorkerFeed(agentName))

  const interval = setInterval(async () => {
    try {
      const offset = outputOffsets.get(terminalId) || 0

      // 1. Read new terminal output
      const bufRes = await window.termpolis.readTerminalBuffer(terminalId, offset)
      const feed = feeds.get(terminalId)
      if (bufRes.success && bufRes.data && feed) {
        let read = bufRes.data
        // Resized larger (shown in a pane): read all main holds, which comes with the size it is
        // drawn for, and start the screen over at that size.
        if (read.cols === undefined && feed.outgrows(read.output)) {
          const whole = await window.termpolis.readTerminalBuffer(terminalId)
          if (whole.success && whole.data) read = whole.data
        }
        // Echo back the offset the main process reports. Offsets index the whole output
        // stream while the buffer only retains the last 32 KB, so `offset + length` drifts
        // as soon as eviction starts — and once it ran past the window the bridge read the
        // empty string forever, going permanently blind to this agent's signals.
        outputOffsets.set(terminalId, read.nextOffset)

        // Typed info whatever it says: a worker's screen is a hint for the conductor, never a
        // result, and only swarm_update_task completes a task (GitHub #36 items 3 and 7).
        const message = feed.update(read)
        if (message) await window.swarmAPI.sendMessage(agentName, 'all', 'info', message)
      }

      // 2. Incoming messages for non-MCP agents are visible in the Swarm Dashboard.
      // We do NOT inject messages into the terminal via writeToTerminal because
      // that sends keystrokes to the shell — bash would interpret them as commands.
      // MCP-capable agents (Claude Code) read messages via swarm_read_messages directly.
    } catch (err) {
      // The most common cause is "terminal closed mid-poll" which we expect.
      // But anything else (IPC bridge broken, swarm API throws) means agent
      // comms are silently dead — surface it so we can fix it.
      const msg = err instanceof Error ? err.message : String(err)
      const isExpectedClose = /closed|destroyed|not found|killed/i.test(msg)
      if (!isExpectedClose) {
        recordSwarmError('swarmBridge.poll.failed', err, { terminalId, agentName })
      }
    }
  }, POLL_INTERVAL_MS)

  activeBridges.set(terminalId, interval)
}

/**
 * Stop the bridge for a single agent terminal.
 */
export function stopBridgeForAgent(terminalId: string): void {
  const interval = activeBridges.get(terminalId)
  if (interval) {
    clearInterval(interval)
    activeBridges.delete(terminalId)
  }
  outputOffsets.delete(terminalId)
  feeds.delete(terminalId)
}

/**
 * Stop all active bridges (e.g. when the swarm is cleared).
 */
export function stopAllBridges(): void {
  for (const [id] of activeBridges) {
    stopBridgeForAgent(id)
  }
}
