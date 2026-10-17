/**
 * Swarm stop reports: a worker a usage limit or a menu stopped (GitHub #36 item 5).
 *
 * A swarm runs for hours, and a worker that hits its plan's limit (Claude Pro, Codex's five-hour
 * limit, agy's quota) or waits on a menu (Codex's "switch model?") does nothing more until
 * someone acts. The swarm status poller (App.tsx) reads each worker's screen and hands every
 * status here; the first time a worker is stopped, and again only after it got going and stopped
 * again, the conductor is told on the swarm bus, which the dashboard's Messages tab shows too. The
 * conductor's prompt says to close the worker and give its task to another installed agent.
 *
 * The report is addressed to the conductor. swarm_read_messages marks a broadcast read for every
 * reader at once, so a Claude worker that read the bus first would have taken it.
 */

import { isLimitOrMenu, type AgentStatusResult } from '../../../shared/agentStatusDetector'

export interface SwarmWorker {
  terminalId: string
  agentName: string
  role: string
}

/** What stopped each worker, while it is stopped. */
const stopped = new Map<string, string>()

/** A stop, without when it lifts: a reset time the CLI redraws as a countdown is the same stop. */
function stopKey(summary: string): string {
  return summary.replace(/ \(resets .*\)$/, '')
}

export async function noteWorkerStatus(worker: SwarmWorker, result: AgentStatusResult): Promise<void> {
  if (!isLimitOrMenu(result)) {
    stopped.delete(worker.terminalId)
    return
  }
  const key = stopKey(result.summary)
  if (stopped.get(worker.terminalId) === key) return
  stopped.set(worker.terminalId, key)
  // The conductor sent the task, so it knows which one this terminal has; when the task was
  // assigned to it, say which.
  let task = ''
  try {
    const res = await window.swarmAPI.getTasks()
    const open = res.success && res.data
      ? res.data.find((t) => t.assignedTo === worker.terminalId && t.status !== 'completed' && t.status !== 'failed')
      : undefined
    if (open) task = ` Its task is "${open.title}" (taskId ${open.id}).`
  } catch {}
  // Closed first: a Claude Code waiting out its limit carries on by itself once it lifts, on a
  // task that is someone else's by then.
  try {
    await window.swarmAPI.sendMessage(
      'system',
      'conductor',
      'info',
      `${worker.agentName} (${worker.role}, terminal ${worker.terminalId}) is blocked: ${result.summary}.${task} ` +
        'Close its terminal, then give its task to another installed agent.',
    )
  } catch {}
}
