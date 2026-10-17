/**
 * Swarm stop reports: a worker a usage limit or a menu stopped (GitHub #36 item 5).
 *
 * A swarm runs for hours, and a worker that hits its plan's limit (Claude Pro, Codex's five-hour
 * limit, agy's quota) or waits on a menu (Codex's "switch model?") does nothing more until
 * someone acts. The swarm status poller (App.tsx) reads each worker's screen and hands every
 * status here; the first time a worker is stopped, and again only after it got going and stopped
 * again, the conductor is told on the swarm bus, which the dashboard's Messages tab shows too. The
 * conductor's prompt says to give the task to another installed agent.
 */

import { isLimitOrMenu, type AgentStatusResult } from '../../../shared/agentStatusDetector'

export interface SwarmWorker {
  terminalId: string
  agentName: string
  role: string
}

/** What stopped each worker, while it is stopped. */
const stopped = new Map<string, string>()

export async function noteWorkerStatus(worker: SwarmWorker, result: AgentStatusResult): Promise<void> {
  if (!isLimitOrMenu(result)) {
    stopped.delete(worker.terminalId)
    return
  }
  if (stopped.get(worker.terminalId) === result.summary) return
  stopped.set(worker.terminalId, result.summary)
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
  try {
    await window.swarmAPI.sendMessage(
      'system',
      'all',
      'info',
      `${worker.agentName} (${worker.role}, terminal ${worker.terminalId}) is blocked: ${result.summary}.${task} ` +
        'Give its task to another installed agent.',
    )
  } catch {}
}
