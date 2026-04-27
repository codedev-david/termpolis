/**
 * Swarm Bridge Manager — lifecycle management for non-MCP agent bridges.
 *
 * For each non-MCP agent terminal, polls the output buffer every 5 seconds,
 * detects meaningful signals, posts them to the swarm message bus, and
 * injects incoming swarm messages into the terminal.
 */

import { detectSwarmSignals } from './swarmBridge'
import { recordSwarmError } from './sentry'

const POLL_INTERVAL_MS = 5000

const activeBridges = new Map<string, ReturnType<typeof setInterval>>()
const outputOffsets = new Map<string, number>()

// Track which message IDs we have already injected to avoid duplicates
const injectedMessageIds = new Map<string, Set<string>>()

/**
 * Start a bridge for a non-MCP agent terminal.
 * Polls terminal output for signals and injects incoming swarm messages.
 */
export function startBridgeForAgent(terminalId: string, agentName: string): void {
  if (activeBridges.has(terminalId)) return

  outputOffsets.set(terminalId, 0)
  injectedMessageIds.set(terminalId, new Set())

  const interval = setInterval(async () => {
    try {
      const offset = outputOffsets.get(terminalId) || 0

      // 1. Read new terminal output
      const bufRes = await window.termpolis.readTerminalBuffer(terminalId, offset)
      if (bufRes.success && bufRes.data) {
        const signal = detectSwarmSignals(bufRes.data.output, 0)
        outputOffsets.set(terminalId, offset + bufRes.data.length)

        // Post detected signals to the swarm bus
        if (signal.type) {
          await window.swarmAPI.sendMessage(
            agentName,
            'all',
            signal.type,
            `[${agentName}] ${signal.content}`,
          )

          // If it looks like task completion, auto-complete the agent's in-progress task
          if (signal.type === 'result') {
            const tasks = await window.swarmAPI.getTasks()
            if (tasks.success && tasks.data) {
              const myTask = tasks.data.find(
                (t) => t.assignedTo === terminalId && t.status === 'in_progress',
              )
              if (myTask) {
                await window.swarmAPI.updateTask(myTask.id, 'completed', signal.content)
              }
            }
          }
        }
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
  injectedMessageIds.delete(terminalId)
}

/**
 * Stop all active bridges (e.g. when the swarm is cleared).
 */
export function stopAllBridges(): void {
  for (const [id] of activeBridges) {
    stopBridgeForAgent(id)
  }
}
