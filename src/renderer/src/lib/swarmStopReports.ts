/**
 * Swarm stop reports: a worker a usage limit or a menu stopped (GitHub #36 item 5).
 *
 * A swarm runs for hours, and a worker that hits its plan's limit (Claude Pro, Codex's five-hour
 * limit, agy's quota) or waits on a menu (Codex's "switch model?") does nothing more until
 * someone acts. The swarm status poller (App.tsx) reads each worker's screen and hands every
 * status here; the first time a worker is stopped, and again only after it got going and stopped
 * again, the conductor is told on the swarm bus, which the dashboard's Messages tab shows too. For a
 * limit, it is told to close the worker and give its task to another installed agent; for a menu, to
 * answer it, which one key press does, and the worker keeps what it did so far.
 *
 * The report is addressed to the conductor. swarm_read_messages marks a broadcast read for every
 * reader at once, so a Claude worker that read the bus first would have taken it.
 */

import { menuAnswer, stopKind, type AgentStatusResult } from '../../../shared/agentStatusDetector'

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
  const kind = stopKind(result)
  if (kind === null) {
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
  // A limit: closed first, since a Claude Code waiting out its limit carries on by itself once it
  // lifts, on a task that is someone else's by then. A menu: answered. Closed, the worker lost what
  // it had done, and a Codex started in its place opened on the same update offer.
  const todo = kind === 'limit'
    ? 'Close its terminal, then give its task to another installed agent.'
    : `Answer it as STEP 6 says, without submit: ${menuAnswer(result.summary) ?? 'read it with read_output first'}. ` +
      'Then send its task again with submit=true if it never got it. Give its task to another installed agent only if the menu stays.'
  try {
    await window.swarmAPI.sendMessage(
      'system',
      'conductor',
      'info',
      `${worker.agentName} (${worker.role}, terminal ${worker.terminalId}) is blocked: ${result.summary}.${task} ${todo}`,
    )
  } catch {}
}
