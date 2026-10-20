/**
 * Swarm stop reports: a worker a usage limit or a menu stopped (GitHub #36 item 5).
 *
 * A swarm runs for hours, and a worker that hits its plan's limit (Claude Pro, Codex's five-hour
 * limit, agy's quota) or waits on a menu (Codex's "switch model?") does nothing more until
 * someone acts. The swarm status poller (App.tsx) reads each worker's screen and hands every
 * status here; the first time a worker is stopped, and again only after it got going, or showed no
 * stop for two reads in a row, and stopped again, the conductor is told on the swarm bus, which the
 * dashboard's Messages tab shows too. For a limit, it is told to close the worker and give its task
 * to another installed agent; for a menu, to answer it, which a key press or two does, and the
 * worker keeps what it did so far. Either way it is told to look at the worker's screen with
 * read_output first: a report read off a screen can be wrong, and closing a worker on a wrong one
 * ends its task halfway.
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

/** What stopped each worker, while it is stopped, and how many reads in a row since showed no stop. */
const stopped = new Map<string, { key: string; clear: number }>()

/** How many reads in a row with no stop end one, the worker not read at work. A single read is no
 *  end: while ConPTY repaints a resized screen, a stopped worker reads idle for a moment, or thinking
 *  while no input box is drawn yet, and the read after it shows the same stop (MW1-3). The poller
 *  reads every 5 seconds; on real Claude Code screens such a moment lasted under a second. */
const READS_TO_CLEAR = 2

/** A stop, without when it lifts: a reset time the CLI redraws as a countdown is the same stop. */
function stopKey(summary: string): string {
  return summary.replace(/ \(resets .*\)$/, '')
}

export async function noteWorkerStatus(worker: SwarmWorker, result: AgentStatusResult): Promise<void> {
  const kind = stopKind(result)
  const last = stopped.get(worker.terminalId)
  if (kind === null) {
    // It got going, or showed no stop for long enough: a stop after this is another one.
    if (last && (result.status === 'working' || ++last.clear >= READS_TO_CLEAR)) stopped.delete(worker.terminalId)
    return
  }
  const key = stopKey(result.summary)
  if (last && last.key === key) {
    last.clear = 0
    return
  }
  stopped.set(worker.terminalId, { key, clear: 0 })
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
  const answer = menuAnswer(result.summary)
  const todo = kind === 'limit'
    ? 'Check its screen with read_output first: if the limit is there, close its terminal, then give its task to another installed agent.'
    : `Check its screen with read_output first: if the menu is there, answer it as STEP 6 says, without submit${answer ? `: ${answer}` : ', with the keys its screen shows for the option to pick'}. ` +
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
